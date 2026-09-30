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
const DEFAULT_TTL_MS = 2 * 60_000;
const OFF_PEAK_TTL_MS = 10 * 60_000;
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
const MAX_CACHE_BYTES = 96 * 1024 * 1024;

// How often the reaper below sweeps for entries that expired but were
// never naturally re-requested (and so never hit get()'s own lazy
// expiry check). Matches the shorter of the two TTLs -- frequent enough
// that a quiet sport's stale board doesn't sit resident for long, cheap
// enough (O(cache.size), cache.size <= MAX_ENTRIES) to cost nothing
// meaningful on a periodic timer.
const SWEEP_INTERVAL_MS = DEFAULT_TTL_MS;

const cache = new Map();   // key -> { status, contentType, body, headers, expiresAt, cachedAt, byteSize }
const inFlight = new Map(); // key -> Promise<{status,contentType,body,headers}>

let totalBytes = 0;

const counters = { hits: 0, misses: 0, coalesced: 0, evictions: 0, byteEvictions: 0, expiredSwept: 0, sets: 0 };

// Real UTF-8 byte length of the response body -- what actually gets
// retained in the V8 heap, not the UTF-16 code-unit count .length would
// give (which undercounts anything with multi-byte characters).
function byteSizeOf(entry) {
  return entry && typeof entry.body === 'string' ? Buffer.byteLength(entry.body, 'utf8') : 0;
}

function removeEntry(key) {
  const entry = cache.get(key);
  if (!entry) return;
  totalBytes -= entry.byteSize || 0;
  cache.delete(key);
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
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now >= entry.expiresAt) { removeEntry(key); counters.expiredSwept++; }
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
  if (Date.now() >= entry.expiresAt) { removeEntry(key); counters.misses++; return null; }
  counters.hits++;
  return entry;
}

function set(key, result) {
  counters.sets++;
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

module.exports = { cacheKeyFor, get, set, getInFlight, setInFlight, recordCoalesced, stats, DEFAULT_TTL_MS, OFF_PEAK_TTL_MS };
