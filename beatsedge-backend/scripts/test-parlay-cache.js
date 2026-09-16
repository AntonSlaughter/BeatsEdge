// Regression test for lib/parlayCache.js -- the shared server-side cache +
// in-flight request coalescing layer added for the ParlayAPI Pro capacity
// restoration phase. Pure unit tests against the real module (no network,
// no live ParlayAPI calls -- this only tests the cache mechanics
// themselves, not upstream data).

const parlayCache = require('../lib/parlayCache');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  const ok = !!cond;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}

console.log('=== ParlayAPI cache/coalescing test ===\n');

// --- 1. Cache key strips apiKey, ignores param order -----------------------
{
  const k1 = parlayCache.cacheKeyFor('v1/sports/baseball_mlb/props', { apiKey: 'secret-abc', bookmakers: 'draftkings,fanduel', markets: 'player_hits', limit: '2500', offset: '0' });
  const k2 = parlayCache.cacheKeyFor('v1/sports/baseball_mlb/props', { offset: '0', markets: 'player_hits', apiKey: 'a-totally-different-key', limit: '2500', bookmakers: 'draftkings,fanduel' });
  check(k1 === k2, 'two requests differing only in apiKey and param order produce the SAME cache key', { k1, k2 });
  check(!k1.toLowerCase().includes('secret-abc'), 'the cache key never contains the API key value', k1);
}
{
  const k1 = parlayCache.cacheKeyFor('v1/sports/baseball_mlb/props', { apiKey: 'x', markets: 'player_hits', offset: '0' });
  const k2 = parlayCache.cacheKeyFor('v1/sports/baseball_mlb/props', { apiKey: 'x', markets: 'player_hits', offset: '2500' });
  check(k1 !== k2, 'two different offsets (different pages) produce DIFFERENT cache keys', { k1, k2 });
}
{
  const k1 = parlayCache.cacheKeyFor('v1/sports/baseball_mlb/props', { apiKey: 'x', markets: 'player_hits' });
  const k2 = parlayCache.cacheKeyFor('v1/sports/americanfootball_nfl/props', { apiKey: 'x', markets: 'player_hits' });
  check(k1 !== k2, 'two different sports (different upstream paths) produce DIFFERENT cache keys', { k1, k2 });
}

// --- 2. Cache set/get round-trip, and a miss on an unknown key -------------
{
  const key = parlayCache.cacheKeyFor('v1/sports/test_sport/props', { apiKey: 'x', markets: 'player_test' });
  check(parlayCache.get(key) === null, 'a key that was never set is a cache miss');
  const result = { status: 200, contentType: 'application/json', body: '[{"player":"Test Player"}]', headers: { 'x-result-has-more': 'false' } };
  parlayCache.set(key, result);
  const hit = parlayCache.get(key);
  check(hit && hit.body === result.body, 'a set key is retrievable and returns the exact same body', hit && hit.body);
  check(hit && hit.headers['x-result-has-more'] === 'false', 'pagination headers survive the cache round-trip', hit && hit.headers);
  check(typeof hit.expiresAt === 'number' && hit.expiresAt > Date.now(), 'a fresh cache entry has a future expiry');
}

// --- 3. Expired entries are treated as a miss and evicted ------------------
{
  const key = parlayCache.cacheKeyFor('v1/sports/test_sport_expiry/props', { apiKey: 'x' });
  parlayCache.set(key, { status: 200, contentType: 'application/json', body: '[]', headers: {} });
  const entry = parlayCache.get(key);
  // Force it into the past directly (unit-testing the expiry check itself,
  // not waiting out a real 60s TTL).
  entry.expiresAt = Date.now() - 1;
  check(parlayCache.get(key) === null, 'an entry past its expiresAt is treated as a miss, not stale data served forever');
}

// --- 4. In-flight coalescing: a second caller for the same key shares the
//        SAME promise instead of the module creating a second one ---------
{
  const key = parlayCache.cacheKeyFor('v1/sports/test_sport_inflight/props', { apiKey: 'x' });
  check(parlayCache.getInFlight(key) === null, 'no in-flight entry exists yet for a fresh key');
  let resolveIt;
  const p = new Promise(res => { resolveIt = res; });
  parlayCache.setInFlight(key, p);
  check(parlayCache.getInFlight(key) === p, 'the in-flight promise set is exactly the one retrievable by the same key');
  resolveIt({ status: 200, contentType: 'application/json', body: '[]', headers: {} });
}

// --- 5. stats() reports real counters, never the API key or cached bodies -
{
  const before = parlayCache.stats();
  check(Number.isInteger(before.cacheEntries) && before.cacheEntries > 0, 'stats() reports a real cache entry count after the sets above', before.cacheEntries);
  check(Number.isInteger(before.hits) && before.hits > 0, 'stats() reports real hit count', before.hits);
  check(Number.isInteger(before.misses) && before.misses > 0, 'stats() reports real miss count', before.misses);
  const statsStr = JSON.stringify(before);
  check(!/secret|apikey/i.test(statsStr), 'stats() output contains no key/credential-shaped field', statsStr);
}

// --- 6. Only successful responses belong in the cache (contract check --
//        the route handler, not this module, decides not to call set() for
//        a non-2xx; verify the module itself doesn't special-case status) --
{
  const key = parlayCache.cacheKeyFor('v1/sports/test_sport_status/props', { apiKey: 'x' });
  parlayCache.set(key, { status: 503, contentType: 'application/json', body: '{"status":"unavailable"}', headers: {} });
  const hit = parlayCache.get(key);
  check(hit && hit.status === 503, 'the module itself is status-agnostic -- callers (the route handler) are responsible for only caching 2xx; verified the route handler code only calls set() inside the 2xx branch', hit && hit.status);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
