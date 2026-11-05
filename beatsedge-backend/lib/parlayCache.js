// Shared, per-process, in-memory cache + in-flight request coalescing for
// the /api/parlayapi/* passthrough only (routes/api.js). PropLine's
// passthrough is untouched by this module -- it keeps using the original,
// uncached makePassthrough exactly as before.
//
// Why this exists: before this module, every browser tab independently
// re-fetched the full ParlayAPI board on its own ~90s poll cycle, with NO
// sharing across users -- N concurrent browser tabs asking for the
// identical upstream request cost N upstream calls. This module makes
// identical requests within a short TTL window share ONE real upstream
// call (a cache hit) and makes concurrent identical requests that arrive
// while a fetch is already in flight share that SAME in-progress request
// (coalescing) instead of each firing their own.
//
// Cache identity is the upstream path + every query param EXCEPT apiKey --
// the key is a credential, not a semantic dimension of the request. Two
// requests differing only in which caller's key was attached are the SAME
// request and should coalesce onto one upstream call (using whichever
// caller's key arrived first).
//
// State is per-process (like dataSourceHealth.js, which this module does
// not modify or depend on) -- resets on a Render restart/redeploy, which
// is fine: this is a short-TTL freshness cache, not a durable store, and
// ParlayAPI's own /props feed is itself a rolling window, not something
// that needs cross-restart continuity.

// Baseline TTL. NOT the frontend's own ~90s poll interval -- the real
// driver here is credit budget, not just freshness. Restoring full
// per-market depth (see fetchParlayPropsByMarket in BeatsEdge.html) means
// one real refresh now costs ~33-43 upstream requests per sport (one per
// market-key alias) instead of the old single combined call. Worked
// backwards from the monthly credit budget (Part 18's 80-90% target,
// ~2,700-3,000 credits/day at 100k/month): a 60s TTL sustained 24/7 across
// all 5 sports would cost roughly 250k+ requests/day, far over budget --
// see the ParlayAPI Pro capacity-restoration report for the full math. A
// 2-minute baseline (still fresher than most bettors need, and every
// concurrent viewer of the same sport still shares the same cached board)
// keeps worst-case cost bounded while real usage is unknown; the
// /api/data-sources/health parlayApiCache stats this module feeds exist so
// the user can watch real hit/miss/coalesced counts and tune this value
// with actual traffic data instead of a guess. Off-peak TTL is longer
// (2am-9am ET) since very few US sports games are live then -- a safe,
// clock-only heuristic that needs no extra API calls or live-game
// awareness to implement.
//
// RESOURCE OPTIMIZATION (2026-11-05, docs/RESOURCE_OPTIMIZATION_2026-11-05.md): the baseline is now 10 minutes (was 2) and the off-peak TTL 30 minutes (was 10). The measured
// credit burn came from a browser refresh loop that missed this cache on roughly every other tick; one refresh is ~36 upstream requests. A 10-minute TTL cuts the
// upstream calls (and with them the archive passes, Turso reads/writes and outbound bytes, all of which hang off one upstream call) by about 5x. PARLAY_CACHE_TTL_MS
// overrides the baseline (1 s .. 60 min; the low end exists for tests) and PARLAY_OFF_PEAK_TTL_MS the off-peak value. Line-movement history in the archives therefore has
// ~10-minute resolution while a board is being viewed.
const _ttlEnv = Number(process.env.PARLAY_CACHE_TTL_MS);
const DEFAULT_TTL_MS = Number.isFinite(_ttlEnv) && process.env.PARLAY_CACHE_TTL_MS !== undefined && process.env.PARLAY_CACHE_TTL_MS !== '' && _ttlEnv >= 1000 ? Math.min(_ttlEnv, 60 * 60_000) : 10 * 60_000;
const _offEnv = Number(process.env.PARLAY_OFF_PEAK_TTL_MS);
const OFF_PEAK_TTL_MS = Number.isFinite(_offEnv) && process.env.PARLAY_OFF_PEAK_TTL_MS !== undefined && process.env.PARLAY_OFF_PEAK_TTL_MS !== '' && _offEnv >= 1000 ? Math.min(_offEnv, 6 * 60 * 60_000) : Math.max(DEFAULT_TTL_MS, 30 * 60_000);
// Stale-on-error window: an expired 2xx body is kept (in a separate pool, never returned by get()) for this long so that, when the provider is down, cooling down or the
// credit budget is spent, the page can be given the LAST GOOD board -- labelled x-cache: STALE with x-data-age-seconds -- instead of nothing. Capped at 2 hours.
// OFF BY DEFAULT (0): the page does not read x-cache / x-data-age-seconds yet, and its "Checked N min ago" stamp is the page's own clock, so a stale board would look
// current to a user. Turn it on (PARLAY_STALE_MAX_MS, e.g. 600000) only together with a page change that shows the data age. Everything below is tested with it on.
const _staleEnv = Number(process.env.PARLAY_STALE_MAX_MS);
const STALE_MAX_AGE_MS = process.env.PARLAY_STALE_MAX_MS !== undefined && process.env.PARLAY_STALE_MAX_MS !== '' && Number.isFinite(_staleEnv) && _staleEnv >= 0 ? Math.min(_staleEnv, 2 * 3600_000) : 0;
const OFF_PEAK_START_HOUR_ET = 2;
const OFF_PEAK_END_HOUR_ET = 9;

// Safety bound on the cache map's size (distinct cache keys). Kept as a
// secondary guard (a runaway number of distinct keys is still worth
// capping), but MAX_ENTRIES alone was never a real memory bound -- it
// caps key COUNT, not the BYTES each entry holds. Each entry's `body` is
// the full raw upstream response text (a real production NHL pull was
// confirmed at ~10,000 rows; per-page ParlayAPI responses at that depth
// run several MB each), and a busy board can paginate up to 20 pages
// (see BeatsEdge.html's fetchParlayPropsBulk maxPages), each page its
// OWN cache key. 800 entries x a few MB each is a multi-hundred-MB
// theoretical exposure on a 512MB Render instance -- the real, measured
// cause investigated for the "Web Service exceeded its memory limit"
// incident. MAX_CACHE_BYTES below is the actual memory bound; MAX_ENTRIES
// stays as a secondary, coarser safety net underneath it.
const MAX_ENTRIES = 800;

// Byte budget for the sum of every cached response body. Sized against
// this service's own measured idle baseline (~101.6MB right after
// startup, Turso+historicalStore connected, before any board traffic)
// against Render's 512MB limit:
//   512MB total
//   - ~102MB idle baseline (Node/V8 + Express + both Turso clients)
//   - ~120MB reserved for transient archive/parse spikes (JSON.parse of
//     a large page plus the normalized-observation array the archive
//     batch path builds are BOTH separate, real allocations on top of
//     the cached string itself, each roughly 2-4x the raw JSON's byte
//     size in V8 due to per-object/per-property overhead; budgeted for
//     several sports' archive passes landing concurrently in a burst)
//   = ~290MB theoretically free
// 96MB claims roughly a third of that remainder for the cache itself,
// leaving ~190MB of further headroom for request concurrency, GC not
// being instantaneous, and everything else the process does -- a
// deliberately conservative fraction, not the maximum defensible number.
// At a realistic few-MB-per-page response size this still comfortably
// covers every sport's board simultaneously cached, including a couple
// of paginated pages each; it only refuses to let a pathological run of
// many large pages pile up unbounded.
//
// CORRECTION (2026-10-21, docs/HEAP_EXHAUSTION_2026-10-21.md): the arithmetic above budgets against the instance's 512 MB of RAM, but what bounds a Node process is
// its V8 heap limit, which on that instance is only ~254 MB (every logged "JavaScript heap out of memory" is at ~253 MB), and the cached bodies are counted at what they
// occupy in the heap (byteSizeOf above), not as UTF-8. The budget is therefore a quarter of the actual heap limit, capped at the old 96 MB: ~63 MB on the 512 MiB
// instance, 96 MB wherever the heap limit is larger. PARLAY_CACHE_MAX_MB overrides it (a smaller cache only costs extra upstream calls after the TTL).
const HEAP_LIMIT = require('v8').getHeapStatistics().heap_size_limit;
const MAX_CACHE_BYTES = (() => {
  const fromEnv = Number(process.env.PARLAY_CACHE_MAX_MB);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv * 1024 * 1024);
  return Math.min(96 * 1024 * 1024, Math.floor(HEAP_LIMIT * 0.25));
})();

// How often the reaper below sweeps for entries that expired but were
// never naturally re-requested (and so never hit get()'s own lazy
// expiry check). Matches the shorter of the two TTLs -- frequent enough
// that a quiet sport's stale board doesn't sit resident for long, cheap
// enough (O(cache.size), cache.size <= MAX_ENTRIES) to cost nothing
// meaningful on a periodic timer.
const SWEEP_INTERVAL_MS = Math.min(DEFAULT_TTL_MS, 5 * 60_000);

const cache = new Map();   // key -> { status, contentType, body, headers, expiresAt, cachedAt, byteSize }
const stale = new Map();   // key -> an EXPIRED entry kept for stale-on-error only (same shape; never returned by get())
const inFlight = new Map(); // key -> Promise<{status,contentType,body,headers}>

let totalBytes = 0;   // fresh entries only -- what stats().cacheBytes and the existing tests measure
let staleBytes = 0;   // the stale pool; fresh + stale together stay inside MAX_CACHE_BYTES

const counters = { hits: 0, misses: 0, coalesced: 0, evictions: 0, byteEvictions: 0, expiredSwept: 0, sets: 0, staleServed: 0, staleDropped: 0 };

// What the response body actually occupies in the V8 heap -- the quantity MAX_CACHE_BYTES has to bound. This used to be the body's UTF-8 byte length, which is NOT what V8
// holds: a string is stored at one byte per character only while every character is <= U+00FF; a single character above that (the "ć" in Dončić / Jokić, which is in nearly every
// NBA / NHL / MLB board) makes the WHOLE string two bytes per character. A "96 MB" budget could therefore pin up to ~190 MB of a ~254 MB heap (docs/HEAP_EXHAUSTION_2026-10-21.md).
const NON_LATIN1 = /[^\x00-\xff]/;   // any character above U+00FF
function byteSizeOf(entry) {
  if (!entry || typeof entry.body !== 'string') return 0;
  return NON_LATIN1.test(entry.body) ? entry.body.length * 2 : entry.body.length;
}

function removeEntry(key) {
  const entry = cache.get(key);
  if (!entry) return;
  totalBytes -= entry.byteSize || 0;
  cache.delete(key);
}

function dropStale(key) {
  const entry = stale.get(key);
  if (!entry) return false;
  staleBytes -= entry.byteSize || 0;
  stale.delete(key);
  return true;
}

// An entry that reached its expiry: leaves the fresh pool (and its bytes leave cacheBytes) and, if it is a 2xx body younger than the stale window, moves to the stale pool.
function expireEntry(key) {
  const entry = cache.get(key);
  if (!entry) return;
  removeEntry(key);
  if (STALE_MAX_AGE_MS > 0 && entry.status >= 200 && entry.status < 300 && Date.now() < entry.cachedAt + STALE_MAX_AGE_MS) {
    dropStale(key);
    stale.set(key, entry); staleBytes += entry.byteSize || 0;
  }
}

// Proactive reclamation: without this, an entry that expires during a
// quiet period (nobody re-requests that exact sport/query combination)
// would sit fully resident -- string body, headers, everything -- until
// SOME later set() call happened to need the room. Runs unconditionally
// on a timer so it reclaims memory even with zero incoming traffic.
// .unref() -- this timer firing must never be, by itself, the reason the
// process stays alive (the real server already stays alive via its own
// HTTP listener regardless; a one-off script or test that merely
// requires this module should still be able to exit naturally).
let _lastLoggedSets = 0;
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now >= entry.expiresAt) { expireEntry(key); counters.expiredSwept++; }
  }
  for (const [key, entry] of stale) {
    if (now >= entry.cachedAt + STALE_MAX_AGE_MS) { dropStale(key); counters.staleDropped++; }
  }
  // One line per sweep while the cache has held anything since the last one (silent when idle): what the V8 heap holds against its limit, so that the memory problem in
  // docs/HEAP_EXHAUSTION_2026-10-21.md (or a regression of it) shows in the logs and not only in the instance's RSS graph, which cannot tell heap from native memory.
  if (cache.size > 0 || counters.sets !== _lastLoggedSets) {
    _lastLoggedSets = counters.sets; const m = process.memoryUsage(); const mb = (n) => Math.round(n / 1048576);
    console.log(`[mem] heapUsed=${mb(m.heapUsed)}MB of limit ${mb(HEAP_LIMIT)}MB rss=${mb(m.rss)}MB; parlayCache ${cache.size} entries ${mb(totalBytes)}MB of ${mb(MAX_CACHE_BYTES)}MB`);
  }
}, SWEEP_INTERVAL_MS);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

function currentEtHour() {
  // Intl with a fixed IANA zone avoids depending on the server process's
  // own TZ setting (Render's containers are typically UTC).
  const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/New_York' }).formatToParts(new Date());
  const h = parts.find(p => p.type === 'hour');
  return h ? parseInt(h.value, 10) : new Date().getUTCHours();
}

function currentTtlMs() {
  const h = currentEtHour();
  const offPeak = OFF_PEAK_START_HOUR_ET <= OFF_PEAK_END_HOUR_ET
    ? (h >= OFF_PEAK_START_HOUR_ET && h < OFF_PEAK_END_HOUR_ET)
    : (h >= OFF_PEAK_START_HOUR_ET || h < OFF_PEAK_END_HOUR_ET);
  return offPeak ? OFF_PEAK_TTL_MS : DEFAULT_TTL_MS;
}

// Builds the cache key from the upstream path + query params, with apiKey
// stripped and the remaining params sorted so key order in the incoming
// request never produces two different cache entries for the same real
// request.
function cacheKeyFor(upstreamPath, query) {
  const qs = new URLSearchParams();
  Object.keys(query || {})
    .filter(k => k.toLowerCase() !== 'apikey')
    .sort()
    .forEach(k => qs.set(k, String(query[k])));
  return `${upstreamPath}?${qs.toString()}`;
}

function get(key) {
  const entry = cache.get(key);
  if (!entry) { counters.misses++; return null; }
  if (Date.now() >= entry.expiresAt) { expireEntry(key); counters.misses++; return null; }
  counters.hits++;
  return entry;
}

// The fresh entry for a key without touching the hit/miss counters (for building a response around an entry that was just stored), or null.
function peek(key) {
  const entry = cache.get(key);
  return entry && Date.now() < entry.expiresAt ? entry : null;
}

// The last good body for a key whose fresh entry has expired, or null. ONLY for answering when the provider cannot be asked (down, cooling down, budget spent):
// the caller must label the response as stale and say how old it is (ageSeconds). Never used when a fresh entry or a live upstream call is possible.
function getStale(key) {
  if (STALE_MAX_AGE_MS <= 0) return null;
  let entry = stale.get(key);
  if (!entry) {
    // An entry that expired but was never touched by get()/the sweep is still in the fresh pool; it is just as stale.
    const e = cache.get(key);
    if (e && Date.now() >= e.expiresAt) { expireEntry(key); entry = stale.get(key); }
  }
  if (!entry) return null;
  if (Date.now() >= entry.cachedAt + STALE_MAX_AGE_MS) { dropStale(key); counters.staleDropped++; return null; }
  counters.staleServed++;
  return { entry, ageSeconds: Math.round((Date.now() - entry.cachedAt) / 1000) };
}

// Strong validator for a cached body (computed once per entry): lets the route answer If-None-Match with 304 without hashing a multi-MB string per request.
function etagFor(entry) {
  if (!entry) return null;
  if (!entry._etag) entry._etag = require('crypto').createHash('sha1').update(String(entry.body)).digest('base64url').slice(0, 22);
  return entry._etag;
}

// The body compressed with `encoding` ('br' | 'gzip'), computed once per entry and shared by every later request (a 0.1 vCPU instance cannot afford to re-compress a
// multi-MB board per request). The compressed bytes are counted against the same budget as the body.
function encodedBody(key, entry, encoding) {
  entry._enc = entry._enc || {};
  if (!entry._enc[encoding]) {
    const p = require('./httpEncoding').encode(entry.body, encoding).then((buf) => {
      const n = buf.length;
      if (cache.get(key) === entry) { entry.byteSize = (entry.byteSize || 0) + n; totalBytes += n; }
      else if (stale.get(key) === entry) { entry.byteSize = (entry.byteSize || 0) + n; staleBytes += n; }
      return buf;
    });
    entry._enc[encoding] = p;
    p.catch(() => { if (entry._enc && entry._enc[encoding] === p) delete entry._enc[encoding]; });
  }
  return entry._enc[encoding];
}

function set(key, result) {
  counters.sets++;
  dropStale(key);   // a fresh body replaces any stale copy of the same key
  const isNewKey = !cache.has(key);
  if (isNewKey) {
    // Existing coarse guard: cap on distinct key COUNT.
    while (cache.size >= MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      removeEntry(oldestKey);
      counters.evictions++;
    }
  } else {
    // Replacing an existing key's value (a re-fetched, still-live cache
    // key) -- back its old byte count out before adding the new size,
    // never touching cache.size/MAX_ENTRIES for a key already counted.
    removeEntry(key);
  }
  const entry = { ...result, cachedAt: Date.now(), expiresAt: Date.now() + currentTtlMs() };
  entry.byteSize = byteSizeOf(entry);
  // Real memory bound: evict oldest entries (excluding the one we're
  // about to write) until this new body actually fits the byte budget.
  // A single response larger than the whole budget is still cached (a
  // real board must never silently go uncached / cause a cache miss
  // storm because of its own size) -- it just can't coexist with much
  // else, and the very next set() call will start evicting again.
  // The stale pool is the cheapest thing to give up: free it first (oldest first) so fresh + stale together stay inside the budget.
  while (totalBytes + staleBytes + entry.byteSize > MAX_CACHE_BYTES && stale.size > 0) {
    const oldestStale = stale.keys().next().value;
    if (oldestStale === undefined) break;
    dropStale(oldestStale); counters.staleDropped++;
  }
  while (totalBytes + entry.byteSize > MAX_CACHE_BYTES && cache.size > 0) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined || oldestKey === key) break;
    removeEntry(oldestKey);
    counters.byteEvictions++;
  }
  cache.set(key, entry);
  totalBytes += entry.byteSize;
}

function getInFlight(key) {
  return inFlight.get(key) || null;
}

function setInFlight(key, promise) {
  inFlight.set(key, promise);
  promise.finally(() => { if (inFlight.get(key) === promise) inFlight.delete(key); }).catch(() => {});
}

function recordCoalesced() { counters.coalesced++; }

function stats() {
  return {
    cacheEntries: cache.size,
    maxEntries: MAX_ENTRIES,
    cacheBytes: totalBytes,
    maxCacheBytes: MAX_CACHE_BYTES,
    ttlMs: DEFAULT_TTL_MS,
    offPeakTtlMs: OFF_PEAK_TTL_MS,
    staleMaxAgeMs: STALE_MAX_AGE_MS,
    staleEntries: stale.size,
    staleBytes,
    staleServed: counters.staleServed,
    staleDropped: counters.staleDropped,
    inFlightRequests: inFlight.size,
    currentTtlMs: currentTtlMs(),
    hits: counters.hits,
    misses: counters.misses,
    coalesced: counters.coalesced,
    evictions: counters.evictions,
    byteEvictions: counters.byteEvictions,
    expiredSwept: counters.expiredSwept,
    hitRate: (counters.hits + counters.misses) ? Math.round((counters.hits / (counters.hits + counters.misses)) * 1000) / 10 : null
  };
}

module.exports = { cacheKeyFor, get, peek, getStale, etagFor, encodedBody, set, getInFlight, setInFlight, recordCoalesced, stats, DEFAULT_TTL_MS, OFF_PEAK_TTL_MS };
