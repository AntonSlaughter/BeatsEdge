'use strict';
// TEST DOUBLE (not production code): preloaded into a spawned server.js (node --require) to replace global fetch. parlay-api.com is answered locally from a control file; every other
// host is REFUSED, so a test using this can never reach the network. No real key, provider or data is involved.
//   STUB_CONTROL  path of a JSON file the test rewrites at any time:  { status?: 200, rows?: 400, cost?: 3, remaining?: 50000, noCostHeader?: false, delayMs?: 0 }
//   STUB_LOG      path of a file each provider call is appended to (one JSON line: path with the apiKey value masked)
const fs = require('fs');
const CTRL = process.env.STUB_CONTROL, LOG = process.env.STUB_LOG;
const realFetch = global.fetch;
global.fetch = async function stubFetch(url, opts) {
  const u = new URL(typeof Request !== 'undefined' && url instanceof Request ? url.url : String(url));   // the libSQL client passes a Request object
  // Loopback only: the local Turso test double. Anything else that is not the stubbed provider is refused.
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(url, opts);
  if (u.host !== 'parlay-api.com') throw new Error('stubParlayFetch: outbound request to ' + u.host + ' refused (test double)');
  let ctl = {}; try { ctl = JSON.parse(fs.readFileSync(CTRL, 'utf8')); } catch (e) { /* defaults */ }
  fs.appendFileSync(LOG, JSON.stringify({ path: u.pathname + u.search.replace(/apiKey=[^&]*/i, 'apiKey=MASKED') }) + '\n');
  if (ctl.delayMs) await new Promise(r => setTimeout(r, ctl.delayMs));
  const status = ctl.status || 200;
  if (status !== 200) return new Response(JSON.stringify({ error: 'stub failure ' + status }), { status, headers: { 'content-type': 'application/json' } });
  const n = ctl.rows || 400; const rows = [];
  for (let i = 0; i < n; i++) rows.push({ event_id: 'evt1', player: 'Player ' + i, player_id: String(1000 + i), market_key: 'player_points', market: 'Points', period: 'game', bookmaker: i % 2 ? 'prizepicks' : 'fanduel', projection_type: null, odds_type: 'standard', side: i % 3 ? 'over' : 'under', line: 10.5 + (i % 7), over_price: -110, under_price: -110, last_update: '2026-11-05T12:00:00Z', home_team: 'DEN', away_team: 'LAL', commence_time: '2026-11-05T23:00:00Z', game_status: 'scheduled' });
  const headers = { 'content-type': 'application/json', 'x-result-has-more': 'false', 'x-next-offset': '0', 'x-credits-remaining': String(ctl.remaining == null ? 50000 : ctl.remaining) };
  if (!ctl.noCostHeader) headers['x-credits-cost'] = String(ctl.cost == null ? 3 : ctl.cost);
  return new Response(JSON.stringify(rows), { status: 200, headers });
};
