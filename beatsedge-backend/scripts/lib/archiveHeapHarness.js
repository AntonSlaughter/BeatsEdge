// TEST HARNESS (not production code): reproduces the production heap exhaustion with synthetic traffic -- no network, no provider call, no production data.
//   node scripts/lib/archiveHeapHarness.js [--tree <backend dir>] [--rtt 60] [--cycle-sec 120] [--pages 3] [--rows 3000] [--minutes 15] [--changed 0.2] [--heap 256] [--sports nba,nhl,mlb,nfl,ncaaf,wnba]
//   [--page-gap-ms N] pause between consecutive page requests of one sport (the page asks one page after the other; the real gap is the upstream latency, ~1-3 s).
//   (--tree defaults to this checkout; point it at a pristine checkout of the deployed commit to measure "before". --sports are refreshed IN PARALLEL each cycle, each with --pages x --rows.)
//
// What it runs: the REAL routes/api.js (cached ParlayAPI passthrough + provider-line archives) and the REAL lib/snapshotStore + @libsql/client, in a child process started with the
// production-sized V8 heap (--max-old-space-size, default 256: Render Free is 512 MiB and the logged fatal errors are at ~253 MB). The Turso side is scripts/lib/hranaDouble.js (a real
// SQLite file behind the Hrana protocol, one writer, a per-request round-trip delay -- 60 ms here + 1/4 on the way back ~ the 77 ms/insert measured on Render). Only the ParlayAPI
// HOST is stubbed (global fetch inside the child); everything between that and the database is the shipped code.
//
// Load it applies (what the page does): every --cycle-sec seconds (the 2-minute cache TTL) one board REFRESH = --pages sequential GET /api/parlayapi/v1/sports/<sport>/props pages of
// --rows rows each (the page asks limit=10000, up to 5-20 pages). Each refresh uses a new `cycle` query value, so every page is a cache MISS and reaches the archive hook, exactly like
// a TTL expiry. A fraction (--changed) of the rows get a new price each cycle (so they are written); the rest are unchanged (read only).
//
// Output: one line per sample (heap used / rss of the child, archive passes in flight / started / finished) and a verdict. Exit 0 = the child survived the whole run with a bounded heap,
// 1 = it died (out of memory) or its heap kept growing.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };

// ---------------------------------------------------------------------------------------------- child: the server under test
if (process.argv[2] === '--child') {
  const tree = process.env.HARNESS_TREE; const TOTAL = Number(process.env.HARNESS_TOTAL_ROWS);
  const SPORT_KEY = { nba: 'basketball_nba', wnba: 'basketball_wnba', mlb: 'baseball_mlb', nfl: 'americanfootball_nfl', ncaaf: 'americanfootball_ncaaf', nhl: 'icehockey_nhl' };
  const SPORTS = (process.env.HARNESS_SPORTS || 'nba').split(',').filter(Boolean);
  require(path.join(tree, 'scripts', 'lib', 'nodeSqliteShim.js'));
  const MARKETS = ['player_points', 'player_rebounds', 'player_assists', 'player_threes', 'player_blocks', 'player_steals', 'player_turnovers', 'player_points_rebounds_assists', 'player_points_rebounds', 'player_points_assists', 'player_rebounds_assists', 'player_double_double', 'player_first_basket', 'player_points_q1', 'player_rebounds_q1', 'player_assists_q1', 'player_points_h1', 'player_rebounds_h1', 'player_assists_h1', 'player_fantasy_score', 'player_steals_blocks', 'player_field_goals', 'player_free_throws', 'player_triple_double', 'player_minutes'];
  const BOOKS = ['draftkings', 'fanduel', 'betmgm', 'betrivers', 'caesars', 'pinnacle', 'bovada', 'prizepicks', 'underdog', 'sleeper'];
  const changedFrac = Number(process.env.HARNESS_CHANGED || 0.2);
  // Row size calibrated to the one real measurement on record: a 10,000-row ParlayAPI /props response was 6,459,268 bytes (docs / tmp/parlayapi-bulk-test.json) = ~646 bytes per row.
  // The filler is a per-row field the archive stores verbatim inside raw_json, like the many extra provider fields a real row carries.
  let PAD = ''; const TARGET_ROW_BYTES = Number(process.env.HARNESS_ROW_BYTES || 646);
  // deterministic row i of a refresh: mixed-radix identity (side 2, book 10, market 25) x (event, player); a fraction of rows get a new price/last_update each cycle
  function rowAt(i, cycle, tag) {
    const side = i % 2, b = Math.floor(i / 2) % BOOKS.length, m = Math.floor(i / 20) % MARKETS.length, pair = Math.floor(i / 500), ev = pair % 10, pl = Math.floor(pair / 10);
    const changed = ((i * 2654435761) >>> 0) / 4294967296 < changedFrac; const ver = changed ? cycle : 0;
    return { pad: PAD, event_id: tag + 'ev' + String(ev).padStart(4, '0') + 'a9becf289d1551db5868323a', player: 'Player Name ' + ev + '-' + pl + ' Dć', player_id: String(500000 + ev * 100 + pl), market_key: MARKETS[m], market: MARKETS[m].replace(/_/g, ' '), period: 'game', bookmaker: BOOKS[b], projection_type: null, odds_type: 'standard', side: side ? 'under' : 'over', line: 10.5 + (m % 9) + (i % 3) * 0.5, over_price: -110 + (ver % 7), under_price: -110 - (ver % 5), last_update: new Date(Date.UTC(2026, 9, 21, 12, 0, 0) + ver * 1000).toISOString().replace('.000', ''), home_team: 'Home Team ' + ev, away_team: 'Away Team ' + ev, commence_time: '2026-10-21T23:30:00Z', game_status: 'scheduled' };
  }
  PAD = 'x'.repeat(Math.max(0, TARGET_ROW_BYTES - 1 - Buffer.byteLength(JSON.stringify(rowAt(0, 0, 'basketball_nba')))));   // 1 byte for the comma between rows
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const raw = typeof url === 'string' ? url : (url && (url.url || url.href)) || ''; let u = null; try { u = new URL(raw); } catch (e) { /* not a plain URL: not ours */ }
    if (!u || u.hostname !== 'parlay-api.com') return realFetch(url, init);
    const off = Number(u.searchParams.get('offset') || 0), lim = Math.min(Number(u.searchParams.get('limit') || 10000), 10000), cycle = Number(u.searchParams.get('cycle') || 0); const n = Math.max(0, Math.min(lim, TOTAL - off));
    const tag = (/sports\/([a-z_]+)\/props/.exec(u.pathname) || [])[1] || 'x';
    // The body is produced as OFF-HEAP Buffer chunks (like bytes arriving from the network), so the stub itself costs the server process no V8 heap: only the decoded string that
    // `await upstream.text()` creates in routes/api.js is charged, exactly as with the real provider.
    const chunks = []; let sb = ''; for (let k = 0; k < n; k++) { sb += (k ? ',' : '[') + JSON.stringify(rowAt(off + k, cycle, tag)); if (k % 250 === 249) { chunks.push(Buffer.from(sb)); sb = ''; } } chunks.push(Buffer.from(sb + (n ? ']' : '[]')));
    const more = off + n < TOTAL; return new Response(Buffer.concat(chunks), { status: 200, headers: { 'content-type': 'application/json', 'x-result-has-more': String(more), 'x-next-offset': String(off + n) } });
  };
  // archive pass accounting (wraps the shipped functions; behaviour unchanged)
  const acct = { started: 0, finished: 0, inFlight: 0, maxInFlight: 0, bytesInFlightMax: 0 };
  { const store = require(path.join(tree, 'lib', 'snapshotStore')); let shown = 0; for (const fn of ['query', 'run', 'batchWrite']) { const o = store[fn]; store[fn] = async function () { try { return await o.apply(this, arguments); } catch (e) { if (shown++ < 3) console.log('[harness] store.' + fn + ' error: ' + String(e && e.message).slice(0, 300)); throw e; } }; } }
  for (const s of Object.keys(SPORT_KEY)) { try { const mod = require(path.join(tree, 'lib', s + 'ProviderLineArchive')); const orig = mod.archiveFromRawParlayResponse; const re = new RegExp('(^|/)v1/sports/' + SPORT_KEY[s] + '/props');
    mod.archiveFromRawParlayResponse = async function (p, body) { const applicable = re.test(String(p)); if (applicable) { acct.started++; acct.inFlight++; if (acct.inFlight > acct.maxInFlight) acct.maxInFlight = acct.inFlight; } try { return await orig.apply(this, arguments); } finally { if (applicable) { acct.finished++; acct.inFlight--; } } }; } catch (e) { /* module absent in this tree */ } }
  const express = require('express'), cors = require('cors'); const app = express(); app.use(cors({ exposedHeaders: ['x-result-has-more', 'x-cache', 'x-next-offset'] })); app.use('/api', require(path.join(tree, 'routes', 'api')));
  const parlayCache = require(path.join(tree, 'lib', 'parlayCache'));
  app.get('/__acct', (q, r) => { const m = process.memoryUsage(); const c = parlayCache.stats(); r.json({ ...acct, heapUsed: m.heapUsed, rss: m.rss, external: m.external, arrayBuffers: m.arrayBuffers, cacheEntries: c.cacheEntries, cacheBytes: c.cacheBytes, maxCacheBytes: c.maxCacheBytes, byteEvictions: c.byteEvictions }); });
  const srv = app.listen(0, '127.0.0.1', () => { console.log('@@port ' + srv.address().port); });
  return;
}

// ---------------------------------------------------------------------------------------------- parent: load driver
(async () => {
  const tree = path.resolve(arg('tree', path.join(__dirname, '..', '..'))); const rtt = Number(arg('rtt', 60)), cycleSec = Number(arg('cycle-sec', 120)), pages = Number(arg('pages', 3)), rows = Number(arg('rows', 3000));
  const pageGapMs = Number(arg('page-gap-ms', 0)), minutes = Number(arg('minutes', 15)), changed = Number(arg('changed', 0.2)), heap = Number(arg('heap', 256)), sports = String(arg('sports', arg('sport', 'nba'))).split(',').filter(Boolean); const TOTAL = pages * rows;
  const SPORT_KEY = { nba: 'basketball_nba', wnba: 'basketball_wnba', mlb: 'baseball_mlb', nfl: 'americanfootball_nfl', ncaaf: 'americanfootball_ncaaf', nhl: 'icehockey_nhl' };
  const { startHranaDouble } = require('./hranaDouble'); const { DatabaseSync } = require('node:sqlite');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-harness-')); const dbFile = path.join(tmp, 'turso.db'); const data = path.join(tmp, 'data'); fs.mkdirSync(data);
  { const S = require(path.join(tree, 'lib', 'snapshotStore.js')); const db = new DatabaseSync(dbFile); db.exec('PRAGMA journal_mode = WAL'); for (const s of S.SCHEMA_STATEMENTS) db.exec(s); db.close(); }
  const dbl = await startHranaDouble({ file: dbFile, rttMs: rtt });
  const env = { ...process.env, HARNESS_TREE: tree, HARNESS_SPORTS: sports.join(','), HARNESS_TOTAL_ROWS: String(TOTAL), HARNESS_CHANGED: String(changed), BEATSEDGE_DATA_DIR: data, TURSO_DATABASE_URL: dbl.url, TURSO_AUTH_TOKEN: 'test-token-not-secret', NODE_ENV: 'test' };
  for (const k of ['TURSO_HISTORICAL_DATABASE_URL', 'TURSO_HISTORICAL_AUTH_TOKEN']) delete env[k];
  const child = cp.spawn(process.execPath, ['--max-old-space-size=' + heap, __filename, '--child'], { env, cwd: tmp }); let port = null, out = '', err = '', exit = null;
  child.stdout.on('data', d => { out += d; const m = /@@port (\d+)/.exec(out); if (m && !port) port = Number(m[1]); }); child.stderr.on('data', d => { err += d; }); child.on('exit', (code, sig) => { exit = { code, sig, at: Date.now() }; });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms)); const t0 = Date.now(); while (!port && !exit && Date.now() - t0 < 60000) await sleep(100); if (!port) { console.log('child did not start', exit, err.slice(0, 600)); process.exit(2); }
  const get = (p, hdr) => new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, headers: hdr || {} }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers })); }); r.on('error', reject); r.setTimeout(120000, () => r.destroy(new Error('timeout'))); });
  console.log(`tree=${tree}\nheap limit ${heap} MB, rtt ${rtt} ms (+25% return), sports ${sports.join('+')} (in parallel), each ${pages} pages x ${rows} rows per refresh, refresh every ${cycleSec}s, ${Math.round(changed * 100)}% of rows change per cycle, run ${minutes} min`);
  const samples = []; let cycle = 0, stop = false, requests = 0, reqErrors = 0;
  // Event-loop health: a trivial request (/api/health) once a second; its latency is what every other feature of the server would see while the load runs.
  let maxLatMs = 0, latSamples = 0, slowLat = 0; const prober = (async () => { while (!stop && !exit) { const s = Date.now(); try { await get('/api/health'); const ms = Date.now() - s; latSamples++; if (ms > maxLatMs) maxLatMs = ms; if (ms > 1000) slowLat++; } catch (e) { /* busy or gone */ } await sleep(1000); } })();
  const sampler = (async () => { while (!stop && !exit) { try { const r = await get('/__acct'); const a = JSON.parse(r.body); samples.push({ t: (Date.now() - t0) / 1000, ...a }); console.log(`t=${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s heap=${String(Math.round(a.heapUsed / 1048576)).padStart(4)}MB rss=${String(Math.round(a.rss / 1048576)).padStart(4)}MB archive passes: in flight ${a.inFlight} (max ${a.maxInFlight}) started ${a.started} finished ${a.finished}; cache ${a.cacheEntries} entries ${Math.round(a.cacheBytes / 1048576)}MB counted (${a.byteEvictions} byte-evictions)`); } catch (e) { /* child busy or gone */ } await sleep(15000); } })();
  const driver = (async () => { while (!stop && !exit) { cycle++; const cStart = Date.now();
    await Promise.all(sports.map(async (sport) => { for (let p = 0; p < pages && !exit; p++) { if (p && pageGapMs) await sleep(pageGapMs); try { requests++; const r = await get(`/api/parlayapi/v1/sports/${SPORT_KEY[sport]}/props?apiKey=k&limit=${rows}&offset=${p * rows}&cycle=${cycle}`, { 'cache-control': 'no-cache' }); if (r.status !== 200) reqErrors++; } catch (e) { reqErrors++; } } }));
    const wait = cycleSec * 1000 - (Date.now() - cStart); if (wait > 0) await sleep(wait); } })();
  const end = Date.now() + minutes * 60000; while (Date.now() < end && !exit) await sleep(500); stop = true;
  let final = null; if (!exit) { try { final = JSON.parse((await get('/__acct')).body); } catch (e) { /* ignore */ } }
  const died = !!exit; const oom = /heap out of memory|Ineffective mark-compacts/i.test(err); const peak = Math.max(0, ...samples.map(s => s.heapUsed)) / 1048576;
  console.log('\n' + (died ? `RESULT: child DIED after ${Math.round((exit.at - t0) / 1000)}s (exit code ${exit.code}${oom ? ', V8 "JavaScript heap out of memory"' : ''})` : `RESULT: child survived ${minutes} min`) + `; peak sampled heap ${peak.toFixed(0)} MB of ${heap}; /api/health during the load: ${latSamples} probes, slowest ${maxLatMs} ms, ${slowLat} over 1 s; archive passes started ${final ? final.started : (samples.length ? samples[samples.length - 1].started : '?')}, finished ${final ? final.finished : (samples.length ? samples[samples.length - 1].finished : '?')}, max concurrent ${final ? final.maxInFlight : (samples.length ? samples[samples.length - 1].maxInFlight : '?')}; requests ${requests} (${reqErrors} errors); rows in archive ${sports.map(s => { try { return s + '=' + dbl.db.prepare(`SELECT COUNT(*) c FROM ${s}_provider_line_archive`).get().c; } catch (e) { return s + '=?'; } }).join(' ')}`);
  if (died && err) console.log(err.split(/\r?\n/).filter(l => /Mark-Compact|FATAL|out of memory/i.test(l)).slice(0, 4).join('\n'));
  { const L = (out + '\n' + err).split(/\r?\n/); const done = L.filter(l => /-archive\] captured=/.test(l)).length, skips = L.filter(l => /pass skipped/.test(l)).length; console.log(`archive passes that completed and logged: ${done}; passes skipped under load (logged "pass skipped"): ${skips}`); }
  const childLog = out.split(/\r?\n/).filter(l => /archive\]|error|Error/i.test(l)); if (childLog.length) console.log('child log (last 6 of ' + childLog.length + '):\n' + childLog.slice(-6).join('\n'));
  try { child.kill(); } catch (e) { /* gone */ } await dbl.close(); fs.rmSync(tmp, { recursive: true, force: true }); void sampler; void driver; void prober;
  process.exit(died || oom ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
