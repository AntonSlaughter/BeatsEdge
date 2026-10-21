// Focused test for the heap-exhaustion fix (docs/HEAP_EXHAUSTION_2026-10-21.md).      node scripts/test-archive-heap-bound.js
//
// Production died every 8-25 minutes with "JavaScript heap out of memory" (~253 MB live). The NBA / WNBA provider-line archives ran a per-row SELECT + INSERT loop (two Turso round trips
// per row) with NO limit on concurrent passes, and every running pass kept its whole parsed response alive; the response cache also under-counted what two-byte strings hold.
// This test proves, against an isolated Turso-compatible server (scripts/lib/hranaDouble.js; real @libsql/client, a real SQLite file, one writer, a round-trip delay -- no network,
// no credentials, no production data):
//   A. the stored rows are IDENTICAL to what the deployed (per-row) modules wrote, for NBA and WNBA, over payloads that exercise every dedupe rule (scripts/fixtures/archive-baseline-6ddfdea);
//   B. at most ONE archive pass runs at a time, at most `maxPending` wait, the rest are skipped and logged, and the queue drains and accepts work again;
//   C. a failing pass rejects to its caller (so routes/api.js logs it), does not wedge the queue, and leaves earlier committed chunks in place;
//   D. the lookup selects only the columns the comparison reads (no raw_json) and the parsed payload is released before the database work;
//   E. the response cache counts what V8 really holds (two bytes per character once any character is above U+00FF).
// The memory behaviour under repeated load is measured separately by scripts/lib/archiveHeapHarness.js (see the doc).
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite'); const root = path.join(__dirname, '..'); const { startHranaDouble } = require('./lib/hranaDouble');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-bound-')); const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
let pass = 0, fail = 0; const ok = async (name, f) => { try { await f(); pass++; console.log('PASS ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + String(e && e.message || e).split('\n')[0]); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || 'values differ') + ': ' + JSON.stringify(a).slice(0, 200) + ' vs ' + JSON.stringify(b).slice(0, 200)); };
const truthy = (v, m) => { if (!v) throw new Error(m || 'expected truthy'); };

// ---- trees: the fixed tree is this checkout; the baseline tree is a copy of lib/ with the four deployed files (6ddfdea) laid over it ----------------------------------------------
const fx = path.join(root, 'scripts', 'fixtures', 'archive-baseline-6ddfdea'); const baseTree = path.join(tmp, 'baseline'); fs.cpSync(path.join(root, 'lib'), path.join(baseTree, 'lib'), { recursive: true });
fs.copyFileSync(path.join(fx, 'nbaProviderLineArchive.js.txt'), path.join(baseTree, 'lib', 'nbaProviderLineArchive.js')); fs.copyFileSync(path.join(fx, 'wnbaProviderLineArchive.js.txt'), path.join(baseTree, 'lib', 'wnbaProviderLineArchive.js'));
fs.copyFileSync(path.join(fx, 'providerLineArchiveFactory.js.txt'), path.join(baseTree, 'lib', 'marketArchive', 'providerLineArchiveFactory.js')); fs.copyFileSync(path.join(fx, 'parlayCache.js.txt'), path.join(baseTree, 'lib', 'parlayCache.js'));
const worker = path.join(tmp, 'worker.js'); fs.writeFileSync(worker, `
const path = require('path'), fs = require('fs'), crypto = require('crypto'); const [mode, tree, mod, arg] = process.argv.slice(2); const out = (o) => console.log('@@' + JSON.stringify(o, (k, v) => typeof v === 'bigint' ? String(v) : v));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const store = require(path.join(tree, 'lib', 'snapshotStore')); const archive = mode === 'cross' ? null : require(path.join(tree, 'lib', mod + 'ProviderLineArchive')); const P = '/v1/sports/basketball_' + mod + '/props?x=1';
  if (mode === 'archive') {
    const bodies = JSON.parse(fs.readFileSync(arg, 'utf8')); const res = [];
    for (const b of bodies) { try { const r = await archive.archiveFromRawParlayResponse(P, b); res.push({ archived: r.archived, unchanged: r.unchanged, skipped: r.skipped, totalRows: r.totalRows, error: r.error || null }); } catch (e) { res.push({ thrown: String(e && e.message) }); } }
    const rows = await store.query('SELECT * FROM ' + mod + '_provider_line_archive ORDER BY id'); const VOL = new Set(['captured_at', 'age_seconds']); const h = crypto.createHash('sha256'); const sem = {};
    rows.forEach(r => { h.update(JSON.stringify(Object.keys(r).filter(k => !VOL.has(k)).map(k => r[k])) + '\\n'); sem[r.semantics_status] = (sem[r.semantics_status] || 0) + 1; });
    out({ passes: res, rows: rows.length, hash: h.digest('hex'), sem });
  } else if (mode === 'concurrency') {
    // wrap the store so we can see how many lookup queries / chunk writes overlap; N concurrent archive calls
    const N = Number(arg); let active = 0, maxActive = 0, lookups = 0; const q = store.query; store.query = async function (sql) { if (/ROW_NUMBER|provider_line_archive WHERE/i.test(sql)) { lookups++; active++; if (active > maxActive) maxActive = active; try { return await q.apply(this, arguments); } finally { active--; } } return q.apply(this, arguments); };
    const lastSql = []; const q2 = store.query; store.query = async function (sql) { lastSql.push(sql); return q2.apply(this, arguments); };
    const mk = (i) => JSON.stringify(Array.from({ length: 200 }, (_, k) => ({ event_id: 'ev' + (k % 4), player: 'P' + i + '-' + k, market_key: 'player_points', bookmaker: 'fanduel', line: 10.5, over_price: -110, under_price: -110, last_update: '2026-10-21T12:00:00Z', side: k % 2 ? 'under' : 'over', market: 'Points', period: 'game' })));
    const bodies = Array.from({ length: N }, (_, i) => mk(i)); const t0 = Date.now(); const results = await Promise.all(bodies.map(b => archive.archiveFromRawParlayResponse(P, b).then(r => r, e => ({ thrown: String(e && e.message) }))));
    const again = await archive.archiveFromRawParlayResponse(P, mk(99)); const rowsN = (await store.query('SELECT COUNT(*) c FROM ' + mod + '_provider_line_archive'))[0].c;
    out({ maxActive, lookups, results: results.map(r => ({ archived: r.archived, skippedBusy: !!r.skippedBusy, thrown: r.thrown || null })), again: { archived: again.archived, skippedBusy: !!again.skippedBusy }, rows: rowsN, lookupSql: lastSql.find(s => /ROW_NUMBER/i.test(s)) || null, ms: Date.now() - t0 });
  } else if (mode === 'cross') {
    // several SPORTS archive at once (the five modules that run through the shared factory): count overlapping passes via the lookup query each pass starts with
    const KEYS = { nba: 'basketball_nba', wnba: 'basketball_wnba', mlb: 'baseball_mlb', nfl: 'americanfootball_nfl', ncaaf: 'americanfootball_ncaaf', nhl: 'icehockey_nhl' }; const sports = arg.split(',');
    let active = 0, maxActive = 0; const q = store.query; store.query = async function (sql) { if (/ROW_NUMBER/i.test(sql)) { active++; if (active > maxActive) maxActive = active; try { return await q.apply(this, arguments); } finally { active--; } } return q.apply(this, arguments); };
    const mk = (s) => JSON.stringify(Array.from({ length: 200 }, (_, k) => ({ event_id: s + 'ev' + (k % 4), player: 'P' + k, market_key: 'player_points', bookmaker: 'fanduel', line: 10.5, over_price: -110, under_price: -110, last_update: '2026-10-21T12:00:00Z', side: k % 2 ? 'under' : 'over', market: 'Points', period: 'game' })));
    const mods = sports.map(s => ({ s, m: require(path.join(tree, 'lib', s + 'ProviderLineArchive')) })); const results = await Promise.all(mods.map(({ s, m }) => m.archiveFromRawParlayResponse('v1/sports/' + KEYS[s] + '/props', mk(s)).then(r => ({ s, archived: r.archived, skippedBusy: !!r.skippedBusy }), e => ({ s, thrown: String(e && e.message) }))));
    let passStats = null; try { passStats = require(path.join(tree, 'lib', 'marketArchive', 'providerLineArchiveFactory')).passStats(); } catch (e) { /* baseline factory has none */ }
    out({ maxActive, results, passStats });
  } else if (mode === 'fail') {
    // the Nth chunk write fails: the pass must reject, earlier chunks stay, and the queue must keep working
    const bw = store.batchWrite; let calls = 0; store.batchWrite = async function (st, o) { calls++; if (calls === 1) { const e = new Error('injected write failure'); e.rowsCommitted = 0; throw e; } return bw.call(this, st, o); };
    const body = JSON.stringify(Array.from({ length: 50 }, (_, k) => ({ event_id: 'ev1', player: 'F' + k, market_key: 'player_points', bookmaker: 'fanduel', line: 10.5, over_price: -110, under_price: -110, last_update: '2026-10-21T12:00:00Z', side: 'over', market: 'Points', period: 'game' })));
    let first = null; try { await archive.archiveFromRawParlayResponse(P, body); first = 'resolved'; } catch (e) { first = 'rejected: ' + e.message; }
    const second = await archive.archiveFromRawParlayResponse(P, body); const n = (await store.query('SELECT COUNT(*) c FROM ' + mod + '_provider_line_archive'))[0].c; out({ first, secondArchived: second.archived, rows: n });
  }
  process.exit(0);
})().catch(e => { out({ fatal: String(e && e.stack || e) }); process.exit(1); });
`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function spawnWorker(mode, tree, mod, arg, env) { return new Promise((resolve) => { const c = cp.spawn(process.execPath, [worker, mode, tree, mod, arg || ''], { env: { ...process.env, NODE_PATH: path.join(root, 'node_modules'), ...env }, cwd: tmp }); let o = '', e = ''; c.stdout.on('data', d => o += d); c.stderr.on('data', d => e += d);
  c.on('close', (code) => { const lines = o.split(/\r?\n/); const j = lines.filter(l => l.startsWith('@@')).map(l => JSON.parse(l.slice(2))).pop() || null; resolve({ code, json: j, logs: lines.filter(l => l && !l.startsWith('@@')), stderr: e }); }); }); }
const S = require(path.join(root, 'lib', 'snapshotStore.js')); const STATEMENTS = S.SCHEMA_STATEMENTS;
function freshDb(name) { const f = path.join(tmp, name + '.db'); const db = new DatabaseSync(f); db.exec('PRAGMA journal_mode = WAL'); for (const s of STATEMENTS) db.exec(s); db.close(); return f; }
const envFor = (d) => ({ BEATSEDGE_DATA_DIR: dataDir, TURSO_DATABASE_URL: d.url, TURSO_AUTH_TOKEN: 'test-token-not-secret' });
const writeJson = (name, v) => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(v)); return f; };

// ---- payloads that exercise every dedupe rule ------------------------------------------------------------------------------------------------------------------------------
const base = (o) => Object.assign({ event_id: 'evA', player: 'Nikola Jokić', player_id: '1001', market_key: 'player_points', market: 'Points', period: 'game', bookmaker: 'fanduel', projection_type: null, odds_type: 'standard', side: 'over', line: 25.5, over_price: -110, under_price: -110, last_update: '2026-10-21T12:00:00Z', home_team: 'DEN', away_team: 'LAL', commence_time: '2026-10-21T23:00:00Z', game_status: 'scheduled' }, o);
function payloads(wnba) {
  const mk = wnba ? 'player_three_pointers' : 'player_threes';
  const p1 = [base(), base({ side: 'under' }), base({ player: 'Jamal Murray', player_id: '1002' }), base({ market_key: 'player_rebounds', market: 'Rebounds', line: 11.5 }), base({ bookmaker: 'prizepicks', projection_type: 'demon', line: 30.5 }),
    base({ event_id: 'evB', player: 'Dončić', side: null, period: null }), base({ line: null }), base({ player: null }), base({ market_key: mk, market: 'Threes', line: 2.5 }), base(), base({ line: 26.5 })];   // duplicate identity inside one batch, a changed duplicate, a null-side/period identity, ineligible rows, the WNBA unresolved market
  const p2 = [base(), base({ side: 'under', under_price: -105 }), base({ player: 'Jamal Murray', player_id: '1002' }), base({ market_key: 'player_rebounds', market: 'Rebounds', line: 11.5, last_update: '2026-10-21T12:05:00Z' }), base({ event_id: 'evB', player: 'Dončić', side: null, period: null }), base({ player: 'New Player', player_id: '1003' })];   // unchanged / changed price / changed last_update / new identity
  const p3 = [base({ line: 26.5 }), base({ line: 26.5, game_status: 'live' }), base({ bookmaker: 'prizepicks', projection_type: 'goblin', line: 20.5 }), base({ bookmaker: 'prizepicks', projection_type: 'demon', line: 30.5 })];
  return [JSON.stringify(p1), JSON.stringify(p2), JSON.stringify(p3), JSON.stringify(p2), 'not json', JSON.stringify({ not: 'an array' })];
}

(async () => {
  for (const mod of ['nba', 'wnba']) {
    await ok(`A (${mod}): stored rows are identical to the deployed per-row module over six payloads (dedupe, changes, null identity, ineligible rows, bad bodies)`, async () => {
      const f = writeJson(mod + '-payloads.json', payloads(mod === 'wnba'));
      const dB = await startHranaDouble({ file: freshDb(mod + '-base'), rttMs: 0 }); const dF = await startHranaDouble({ file: freshDb(mod + '-fixed'), rttMs: 0 });
      try {
        const b = await spawnWorker('archive', baseTree, mod, f, envFor(dB)); const x = await spawnWorker('archive', root, mod, f, envFor(dF));
        truthy(b.json && !b.json.fatal, 'baseline worker: ' + JSON.stringify(b.json || b.stderr).slice(0, 300)); truthy(x.json && !x.json.fatal, 'fixed worker: ' + JSON.stringify(x.json || x.stderr).slice(0, 300));
        truthy(b.json.rows >= 8, 'baseline wrote too few rows to be a meaningful comparison (' + b.json.rows + ')');
        eq(x.json.rows, b.json.rows, 'row count'); eq(x.json.hash, b.json.hash, 'row content hash (every column but captured_at / age_seconds, in insertion order)'); eq(x.json.sem, b.json.sem, 'semantics_status distribution');
        eq(x.json.passes.map(p => [p.archived, p.unchanged, p.skipped, p.totalRows]), b.json.passes.map(p => [p.archived, p.unchanged, p.skipped, p.totalRows]), 'per-pass counts');
        if (mod === 'wnba') truthy(x.json.sem.SEMANTICS_UNRESOLVED >= 1, 'the WNBA unresolved-semantics market was not tagged');
      } finally { await dB.close(); await dF.close(); }
    });
  }
  await ok('B: 10 simultaneous NBA responses -> at most ONE pass at a time, 1 running + 3 waiting archived, the other 6 skipped (logged), then the queue accepts work again', async () => {
    const d = await startHranaDouble({ file: freshDb('conc'), rttMs: 15 });
    try {
      const x = await spawnWorker('concurrency', root, 'nba', '10', envFor(d)); truthy(x.json && !x.json.fatal, JSON.stringify(x.json || x.stderr).slice(0, 300));
      eq(x.json.maxActive, 1, 'lookup queries overlapping (== passes in flight)'); eq(x.json.results.filter(r => r.skippedBusy).length, 6, 'skipped'); eq(x.json.results.filter(r => !r.skippedBusy && !r.thrown).length, 4, 'archived passes');
      eq(x.json.again, { archived: 200, skippedBusy: false }, 'a later response is archived normally'); eq(x.json.rows, 5 * 200 - 0, 'rows stored: 4 passes + the later one, 200 each'); truthy(/pass skipped/.test(x.stderr), 'a skip is logged (console.warn)');
    } finally { await d.close(); }
    const d2 = await startHranaDouble({ file: freshDb('conc-base'), rttMs: 15 });   // control: the deployed module under the same 10 responses
    try { const b = await spawnWorker('concurrency', baseTree, 'nba', '10', envFor(d2)); truthy(b.json && !b.json.fatal, JSON.stringify(b.json || b.stderr).slice(0, 300)); truthy(b.json.maxActive >= 8, 'control: the deployed module runs the passes concurrently (overlapping lookups ' + b.json.maxActive + ')'); eq(b.json.results.filter(r => r.skippedBusy).length, 0, 'control: nothing is bounded or skipped'); } finally { await d2.close(); }
  });
  await ok('B2: the WNBA archive has the same bound', async () => {
    const d = await startHranaDouble({ file: freshDb('conc-w'), rttMs: 15 });
    try { const x = await spawnWorker('concurrency', root, 'wnba', '8', envFor(d)); truthy(x.json && !x.json.fatal, JSON.stringify(x.json || x.stderr).slice(0, 300)); eq(x.json.maxActive, 1, 'overlapping lookups'); eq(x.json.results.filter(r => r.skippedBusy).length, 4, 'skipped'); } finally { await d.close(); }
  });
  await ok('F: five sports archiving at the same moment never run passes concurrently (one process-wide slot), every sport still gets its rows; the deployed code ran them all at once', async () => {
    const sports = 'nba,mlb,nfl,nhl,ncaaf'; const d = await startHranaDouble({ file: freshDb('cross'), rttMs: 15 });
    try {
      const x = await spawnWorker('cross', root, '', sports, envFor(d)); truthy(x.json && !x.json.fatal, JSON.stringify(x.json || x.stderr).slice(0, 300));
      eq(x.json.maxActive, 1, 'passes overlapping'); eq(x.json.results.map(r => r.archived), [200, 200, 200, 200, 200], 'each sport archived its 200 rows'); eq(x.json.passStats.skipped, 0, 'nothing skipped while at most maxWaiting (4) passes wait'); eq(x.json.passStats.limit, 1, 'default slot count'); truthy(x.json.passStats.passesRun >= 4, 'the factory sports went through the slot (' + JSON.stringify(x.json.passStats) + ')');
      for (const s of sports.split(',')) eq(d.db.prepare(`SELECT COUNT(*) c FROM ${s}_provider_line_archive`).get().c, 200, s + ' rows in its own table');
    } finally { await d.close(); }
    const d2 = await startHranaDouble({ file: freshDb('cross-base'), rttMs: 15 });
    try { const b = await spawnWorker('cross', baseTree, '', sports, envFor(d2)); truthy(b.json && !b.json.fatal, JSON.stringify(b.json || b.stderr).slice(0, 300)); truthy(b.json.maxActive >= 3, 'control: the deployed code overlaps sports\' passes (' + b.json.maxActive + ' at once)'); } finally { await d2.close(); }
  });
  await ok('F2: ARCHIVE_PASS_CONCURRENCY=2 allows exactly two passes at once', async () => {
    const d = await startHranaDouble({ file: freshDb('cross2'), rttMs: 15 });
    try { const x = await spawnWorker('cross', root, '', 'nba,mlb,nfl,nhl,ncaaf', { ...envFor(d), ARCHIVE_PASS_CONCURRENCY: '2' }); truthy(x.json && !x.json.fatal, JSON.stringify(x.json || x.stderr).slice(0, 300)); eq(x.json.maxActive, 2, 'passes overlapping'); eq(x.json.passStats.limit, 2, 'limit'); } finally { await d.close(); }
  });
  await ok('F3: passes WAITING for the slot are bounded too (they hold their response text): with ARCHIVE_PASS_MAX_WAITING=1, 1 of 5 sports runs, 1 waits, the other 3 are skipped (logged) and nothing is written for them', async () => {
    const d = await startHranaDouble({ file: freshDb('cross3'), rttMs: 15 });
    try {
      const x = await spawnWorker('cross', root, '', 'nba,mlb,nfl,nhl,ncaaf', { ...envFor(d), ARCHIVE_PASS_MAX_WAITING: '1' }); truthy(x.json && !x.json.fatal, JSON.stringify(x.json || x.stderr).slice(0, 300));
      eq(x.json.maxActive, 1, 'passes overlapping'); eq(x.json.results.filter(r => r.skippedBusy).length, 3, 'skipped'); eq(x.json.results.filter(r => !r.skippedBusy && r.archived === 200).length, 2, 'archived'); eq(x.json.passStats.skipped, 3, 'passStats.skipped'); truthy(/\[archive\] pass skipped/.test(x.stderr), 'a skip is logged');
      const total = ['nba', 'mlb', 'nfl', 'nhl', 'ncaaf'].reduce((n, s) => n + d.db.prepare(`SELECT COUNT(*) c FROM ${s}_provider_line_archive`).get().c, 0); eq(total, 400, 'only the two passes that ran wrote rows');
    } finally { await d.close(); }
  });
  await ok('C: a failing pass rejects to its caller, earlier state is kept, and the next pass runs (the queue is not wedged)', async () => {
    const d = await startHranaDouble({ file: freshDb('fail'), rttMs: 0 });
    try { const x = await spawnWorker('fail', root, 'nba', '', envFor(d)); truthy(x.json && !x.json.fatal, JSON.stringify(x.json || x.stderr).slice(0, 300)); truthy(/^rejected: injected write failure/.test(x.json.first), 'first pass: ' + x.json.first); eq(x.json.secondArchived, 50, 'the next pass writes normally'); eq(x.json.rows, 50, 'no duplicates, nothing lost'); } finally { await d.close(); }
  });
  await ok('D: the lookup selects only identity + compared columns (no raw_json / projection_metadata) and the parsed payload is released before the database work', async () => {
    const d = await startHranaDouble({ file: freshDb('sql'), rttMs: 0 });
    try { const x = await spawnWorker('concurrency', root, 'nba', '1', envFor(d)); truthy(x.json && x.json.lookupSql, 'no lookup SQL captured'); const sql = x.json.lookupSql; truthy(!/raw_json|projection_metadata|SELECT \*/i.test(sql), 'the lookup still reads wide columns: ' + sql.replace(/\s+/g, ' ').slice(0, 220)); truthy(/line, over_price, under_price, provider_last_update, game_status, market_label/.test(sql), 'a compared column is missing from the lookup'); truthy(/sport, event_id, player_raw, market_key_raw, source, projection_type, period, side/.test(sql), 'an identity column is missing from the lookup'); } finally { await d.close(); }
    const src = fs.readFileSync(path.join(root, 'lib', 'marketArchive', 'providerLineArchiveFactory.js'), 'utf8'); truthy(/const totalRows = rows\.length; rows = null;/.test(src), 'the parsed payload is not released before recordNormalizedBatch');
  });
  await ok('E: the response cache counts what V8 holds -- 1 byte/char for Latin-1 text (incl. accented), 2 bytes/char once any character is above U+00FF', async () => {
    delete require.cache[require.resolve(path.join(root, 'lib', 'parlayCache'))]; const pc = require(path.join(root, 'lib', 'parlayCache')); const one = (body, key) => { const before = pc.stats().cacheBytes; pc.set(key, { status: 200, contentType: 'application/json', body, headers: {} }); return pc.stats().cacheBytes - before; };
    const ascii = 'a'.repeat(1000), latin = 'José Ñ '.repeat(100), wide = ('Dončić ' + 'a'.repeat(100)).repeat(10);
    eq(one(ascii, 'k1'), 1000, 'ASCII'); eq(one(latin, 'k2'), latin.length, 'Latin-1 accented text is still one byte per character in V8'); eq(one(wide, 'k3'), wide.length * 2, 'a string with any character above U+00FF is two bytes per character');
    truthy(Buffer.byteLength(wide, 'utf8') < wide.length * 2, 'control: the old UTF-8 count really did under-count this body');
  });
  await ok('E2: the cache budget follows the real V8 heap limit (a quarter of it, at most 96 MB), PARLAY_CACHE_MAX_MB overrides it', async () => {
    const probe = `const v8=require('v8');const s=require(${JSON.stringify(path.join(root, 'lib', 'parlayCache'))}).stats();console.log(JSON.stringify({limit:v8.getHeapStatistics().heap_size_limit,max:s.maxCacheBytes}))`;
    const run = (flags, env) => JSON.parse(cp.spawnSync(process.execPath, [...flags, '-e', probe], { encoding: 'utf8', env: { ...process.env, ...env } }).stdout.trim());
    const small = run(['--max-old-space-size=256'], {}); eq(small.max, Math.floor(small.limit * 0.25), 'a 256 MB heap -> a quarter of the limit'); truthy(small.max < 96 * 1048576 && small.max > 40 * 1048576, 'about 63-72 MB on a ~254-288 MB heap (' + Math.round(small.max / 1048576) + ' MB)');
    const big = run(['--max-old-space-size=4096'], {}); eq(big.max, 96 * 1048576, 'a large heap keeps the old 96 MB cap'); eq(run(['--max-old-space-size=256'], { PARLAY_CACHE_MAX_MB: '40' }).max, 40 * 1048576, 'override');
  });
  await ok('E3: the cache sweep logs one [mem] line (heap used / limit / rss / cache) while the cache holds data, and stays silent when idle', async () => {
    const probe = `const real=global.setInterval; let tick=null; global.setInterval=(fn)=>{ tick=fn; return {unref(){}}; };
      const pc=require(${JSON.stringify(path.join(root, 'lib', 'parlayCache'))}); global.setInterval=real; const out=[]; const log=console.log; console.log=(...a)=>out.push(a.join(' '));
      tick(); const idle=out.length; pc.set('k',{status:200,contentType:'application/json',body:'x'.repeat(1000),headers:{}}); tick(); const busy=out.slice(idle); tick(); const stillBusy=out.length-idle-busy.length; pc.stats(); console.log=log;
      console.log(JSON.stringify({idle,busy,stillBusy}));`;
    const r = JSON.parse(cp.spawnSync(process.execPath, ['--max-old-space-size=256', '-e', probe], { encoding: 'utf8' }).stdout.trim()); eq(r.idle, 0, 'silent when nothing was ever cached'); eq(r.busy.length, 1, 'one line when the cache holds an entry');
    truthy(/^\[mem\] heapUsed=\d+MB of limit \d+MB rss=\d+MB; parlayCache 1 entries \d+MB of \d+MB$/.test(r.busy[0]), 'format: ' + r.busy[0]); eq(r.stillBusy, 1, 'and again on the next sweep while the entry is still cached');
  });
  console.log(`\n${pass} passed, ${fail} failed`); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
