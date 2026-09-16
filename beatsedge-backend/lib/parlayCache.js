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

// Safety bound on the cache map's size (distinct cache keys), not on any
// single response's row count -- each sport's request set (per-market x
// per-sport) stays comfortably under this even at full depth across all 5
// supported sports.
const MAX_ENTRIES = 800;

const cache = new Map();   // key -> { status, contentType, body, headers, expiresAt, cachedAt }
const inFlight = new Map(); // key -> Promise<{status,contentType,body,headers}>

const counters = { hits: 0, misses: 0, coalesced: 0, evictions: 0, sets: 0 };

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
  if (Date.now() >= entry.expiresAt) { cache.delete(key); counters.misses++; return null; }
  counters.hits++;
  return entry;
}

function set(key, result) {
  counters.sets++;
  if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) { cache.delete(oldestKey); counters.evictions++; }
  }
  cache.set(key, { ...result, cachedAt: Date.now(), expiresAt: Date.now() + currentTtlMs() });
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
    inFlightRequests: inFlight.size,
    currentTtlMs: currentTtlMs(),
    hits: counters.hits,
    misses: counters.misses,
    coalesced: counters.coalesced,
    evictions: counters.evictions,
    hitRate: (counters.hits + counters.misses) ? Math.round((counters.hits / (counters.hits + counters.misses)) * 1000) / 10 : null
  };
}

module.exports = { cacheKeyFor, get, set, getInFlight, setInFlight, recordCoalesced, stats, DEFAULT_TTL_MS, OFF_PEAK_TTL_MS };
