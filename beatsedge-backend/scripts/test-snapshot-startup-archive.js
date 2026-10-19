// Focused test: snapshot-storage STARTUP while provider-line ARCHIVE traffic is writing, against an isolated Turso-compatible server (scripts/lib/hranaDouble.js; real @libsql/client,
// real SQLite file, a modelled single writer and a per-request round-trip delay). No network, no credentials, no production data.     node scripts/test-snapshot-startup-archive.js
//
// "baseline" = the pre-fix files exactly as deployed in 15f1b55 (scripts/fixtures/snapshot-baseline-15f1b55); "fixed" = this tree.
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), cp = require('child_process'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite'); const root = path.join(__dirname, '..'); const { startHranaDouble } = require('./lib/hranaDouble');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-startup-')); process.env.BEATSEDGE_DATA_DIR = path.join(tmp, 'data'); fs.mkdirSync(process.env.BEATSEDGE_DATA_DIR, { recursive: true });
let pass = 0, fail = 0; const ok = async (name, f) => { try { await f(); pass++; console.log('PASS ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + String(e && e.message || e).split('\n')[0]); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms)); const RTT = 4;

// ---- trees -------------------------------------------------------------------------------------------------------------------------------------------------
const baseTree = path.join(tmp, 'baseline'); fs.mkdirSync(path.join(baseTree, 'lib', 'marketArchive'), { recursive: true });
const fx = path.join(root, 'scripts', 'fixtures', 'snapshot-baseline-15f1b55');
fs.copyFileSync(path.join(fx, 'snapshotStore.js.txt'), path.join(baseTree, 'lib', 'snapshotStore.js')); fs.copyFileSync(path.join(fx, 'dataPaths.js.txt'), path.join(baseTree, 'lib', 'dataPaths.js')); fs.copyFileSync(path.join(fx, 'providerLineArchiveFactory.js.txt'), path.join(baseTree, 'lib', 'marketArchive', 'providerLineArchiveFactory.js'));
const fixedTree = root;
const worker = path.join(tmp, 'worker.js'); fs.writeFileSync(worker, `
const path = require('path'), fs = require('fs'), crypto = require('crypto'); const [mode, tree, arg] = process.argv.slice(2); const out = (o) => console.log('@@' + JSON.stringify(o));
(async () => {
  if (mode === 'boot') { const s = require(path.join(tree, 'lib', 'snapshotStore')); const t = Date.now(); try { await s.verifyReady(); out({ ok: true, ms: Date.now() - t }); } catch (e) { out({ ok: false, ms: Date.now() - t, error: String(e && e.message), code: e && e.code }); } }
  else if (mode === 'archive') { const { createProviderLineArchive } = require(path.join(tree, 'lib', 'marketArchive', 'providerLineArchiveFactory')); const a = createProviderLineArchive({ sport: 'nfl', propsPathRegex: /./ });
    const payloads = JSON.parse(fs.readFileSync(arg, 'utf8')); const res = []; const t0 = Date.now(); for (const p of payloads) { const t = Date.now(); try { const r = await a.archiveFromRawParlayResponse('/x', JSON.stringify(p)); res.push({ ms: Date.now() - t, archived: r.archived, unchanged: r.unchanged }); } catch (e) { res.push({ ms: Date.now() - t, error: String(e && e.message), rowsCommitted: e && e.rowsCommitted }); } }
    const s = require(path.join(tree, 'lib', 'snapshotStore')); const rows = await s.query('SELECT * FROM nfl_provider_line_archive ORDER BY id'); const VOL = new Set(['captured_at', 'age_seconds']);
    const h = crypto.createHash('sha256'); rows.forEach(r => h.update(JSON.stringify(Object.keys(r).filter(k => !VOL.has(k)).map(k => r[k])) + '\\n')); out({ ms: Date.now() - t0, passes: res, rows: rows.length, hash: h.digest('hex') }); }
  process.exit(0);
})().catch(e => { out({ fatal: String(e && e.stack || e) }); process.exit(1); });
`);
function spawnWorker(mode, tree, arg, env) {
  return new Promise((resolve) => { const t0 = Date.now(); const c = cp.spawn(process.execPath, [worker, mode, tree, arg || ''], { env: { ...process.env, NODE_PATH: path.join(root, 'node_modules'), ...env }, cwd: tmp }); let o = '', e = ''; c.stdout.on('data', d => o += d); c.stderr.on('data', d => e += d);
    c.on('close', (code) => { const lines = o.split(/\r?\n/); const j = lines.filter(l => l.startsWith('@@')).map(l => JSON.parse(l.slice(2))).pop() || null; resolve({ code, json: j, logs: lines.filter(l => l && !l.startsWith('@@')), stderr: e, wall: Date.now() - t0 }); }); });
}
// ---- fixtures ---------------------------------------------------------------------------------------------------------------------------------------------
const S = require(path.join(root, 'lib', 'snapshotStore.js')); // NOTE: required below AFTER the env for the in-process double is set; this first require only reads SCHEMA_STATEMENTS under the sqlite backend
const STATEMENTS = S.SCHEMA_STATEMENTS;
function freshDb(name, { skip = [] } = {}) { const f = path.join(tmp, name + '.db'); const db = new DatabaseSync(f); db.exec('PRAGMA journal_mode = WAL'); for (const s of STATEMENTS) db.exec(s); for (const q of skip) db.exec(q); db.close(); return f; }
function rowsFor(n, { tag = 'a', price = -110, offset = 0 } = {}) { const out = []; for (let i = 0; i < n; i++) out.push({ event_id: 'ev' + ((i + offset) % 40), player: 'Player ' + tag + (i + offset), player_id: String(1000 + i + offset), market_key: 'player_rush_yds', market: 'Rushing Yards', bookmaker: i % 3 ? 'prizepicks' : 'fanduel', line: 40.5 + (i % 7), over_price: price, under_price: -110, last_update: '2026-10-19T12:00:00Z', home_team: 'H', away_team: 'A', commence_time: '2026-10-20T00:00:00Z', game_status: 'scheduled', period: 'game', projection_type: null, odds_type: 'standard', side: i % 2 ? 'over' : 'under' }); return out; }
const writeJson = (name, v) => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(v)); return f; };
const envFor = (d) => ({ TURSO_DATABASE_URL: d.url, TURSO_AUTH_TOKEN: 'test-token-not-secret' });
const after = async (cond, ms = 20000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out waiting for condition'); await sleep(5); } };

(async () => {
  const catalog = require(path.join(root, 'lib', 'schemaCatalog'));

  // ================= 1. schema verification unit tests (real SQLite as the "remote") =================
  await ok('schemaCatalog: a database built from the statements verifies clean (every table, column and index), with zero drift', async () => {
    const f = freshDb('cat1'); const db = new DatabaseSync(f); const r = await catalog.verify(async (sql) => db.prepare(sql).all().map(x => ({ ...x })), STATEMENTS); db.close();
    assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.strictEqual(r.drift.length, 0); assert.ok(r.counts.tables >= 7 && r.counts.indexes >= 30, JSON.stringify(r.counts)); });
  await ok('schemaCatalog: table EXISTENCE alone is not readiness -- a missing column, a missing table and a missing index each make the database "not ready"', async () => {
    const f = freshDb('cat2', { skip: ['ALTER TABLE nfl_provider_line_archive DROP COLUMN semantics_status', 'DROP TABLE nhl_provider_line_archive', 'DROP INDEX idx_fpla_event'] }); const db = new DatabaseSync(f); const r = await catalog.verify(async (sql) => db.prepare(sql).all().map(x => ({ ...x })), STATEMENTS); db.close();
    assert.strictEqual(r.ok, false); assert.deepStrictEqual(r.missingColumns, ['nfl_provider_line_archive.semantics_status']); assert.deepStrictEqual(r.missingTables, ['nhl_provider_line_archive']); assert.ok(r.missingIndexes.includes('idx_fpla_event'), JSON.stringify(r.missingIndexes)); });
  await ok('schemaCatalog: differences the DDL could never repair (a column type, an index definition) are reported as drift but do not block; a retired index and a pending ADD COLUMN migration DO block', async () => {
    const f = freshDb('cat3', { skip: ['DROP INDEX idx_fpla_player', 'CREATE INDEX idx_fpla_player ON nfl_provider_line_archive(player_raw)'] }); const db = new DatabaseSync(f); const q = async (sql) => db.prepare(sql).all().map(x => ({ ...x }));
    let r = await catalog.verify(q, STATEMENTS); assert.strictEqual(r.ok, true); assert.ok(r.drift.some(d => /idx_fpla_player/.test(d)), JSON.stringify(r.drift));
    r = await catalog.verify(q, STATEMENTS, { mustNotExist: ['idx_fpla_player'] }); assert.strictEqual(r.ok, false); assert.deepStrictEqual(r.unexpectedIndexes, ['idx_fpla_player']);
    r = await catalog.verify(q, STATEMENTS, { migrationStatements: ['ALTER TABLE nfl_provider_line_archive ADD COLUMN extra_col TEXT'] }); assert.strictEqual(r.ok, false); assert.deepStrictEqual(r.missingColumns, ['nfl_provider_line_archive.extra_col']); db.close(); });

  // ================= 2. startup while archive traffic is writing =================
  // baseline: ONE interactive write transaction per pass, one INSERT round trip per row. fixed: chunked batches. Same payload shape, same server, same delay.
  const NB = Number(process.env.SNAP_TEST_BASE_ROWS) || 2400, NF = 24000; let baseline = {}, fixed = {};
  await ok('BASELINE (deployed 15f1b55): a boot that starts while an archive pass is writing is STALLED for most of the pass (the stall is reproduced)', async () => {
    const f = freshDb('base'); const d = await startHranaDouble({ file: f, rttMs: RTT }); try {
      const live = spawnWorker('archive', baseTree, writeJson('pb.json', [rowsFor(NB)]), envFor(d)); await after(() => d.isWriteLocked()); await sleep(400);
      const boot = await spawnWorker('boot', baseTree, '', envFor(d)); const lv = await live;
      baseline = { bootMs: boot.json.ms, passMs: lv.json.passes[0].ms, holdMs: Math.max(...d.stats.writeTxHeldMs), ddl: d.stats.ddlStatements, perRow: lv.json.passes[0].ms / NB, rows: lv.json.rows, waits: d.stats.lockWaits.map(w => w.label + ':' + w.waited) };
      console.log('     baseline: pass ' + baseline.passMs + ' ms for ' + NB + ' rows (' + baseline.perRow.toFixed(2) + ' ms/row), longest write transaction ' + baseline.holdMs + ' ms, boot took ' + baseline.bootMs + ' ms, DDL statements issued by boot: ' + baseline.ddl);
      assert.ok(boot.json.ok, JSON.stringify(boot.json)); assert.strictEqual(baseline.rows, NB); assert.ok(baseline.bootMs > baseline.passMs * 0.5, 'boot should have waited behind the pass: boot ' + baseline.bootMs + ' ms vs pass ' + baseline.passMs + ' ms');
      assert.ok(baseline.holdMs > baseline.passMs * 0.8, 'the write transaction should span the pass'); assert.ok(d.stats.lockWaits.some(w => w.label === 'ddl'), 'boot DDL queued on the write lock'); } finally { await d.close(); } });
  await ok('FIXED: the same boot, started while a pass 10x larger is writing, does NOT wait for it (no DDL issued, two read queries, finishes in a fraction of the pass)', async () => {
    const f = freshDb('fixed'); const d = await startHranaDouble({ file: f, rttMs: RTT }); try {
      const live = spawnWorker('archive', fixedTree, writeJson('pf.json', [rowsFor(NF)]), envFor(d)); await after(() => d.stats.batchRequests >= 2); await sleep(100);
      const boot = await spawnWorker('boot', fixedTree, '', envFor(d)); const lv = await live;
      fixed = { bootMs: boot.json.ms, passMs: lv.json.passes[0].ms, holdMs: Math.max(...d.stats.writeTxHeldMs), ddl: d.stats.ddlStatements, perRow: lv.json.passes[0].ms / NF, rows: lv.json.rows, maxInflightBatch: d.stats.maxInflightBatch };
      console.log('     fixed:    pass ' + fixed.passMs + ' ms for ' + NF + ' rows (' + fixed.perRow.toFixed(3) + ' ms/row), longest write transaction ' + fixed.holdMs + ' ms, boot took ' + fixed.bootMs + ' ms, DDL statements issued by boot: ' + fixed.ddl);
      assert.ok(boot.json.ok, JSON.stringify(boot.json)); assert.strictEqual(fixed.rows, NF); assert.strictEqual(fixed.ddl, 0, 'a verified schema issues no DDL'); assert.ok(boot.logs.some(l => /schema verified read-only/.test(l)), boot.logs.join(' | '));
      assert.ok(fixed.bootMs < 1500 && fixed.bootMs < fixed.passMs * 0.5, 'boot ' + fixed.bootMs + ' ms vs pass ' + fixed.passMs + ' ms'); } finally { await d.close(); } });
  await ok('FIXED archive writes: per-row cost is >= 20x lower and the longest write transaction is >= 20x shorter than the baseline pass (same server, same delay)', () => {
    assert.ok(baseline.perRow / fixed.perRow >= 20, 'per-row speedup ' + (baseline.perRow / fixed.perRow).toFixed(1)); assert.ok(baseline.holdMs / fixed.holdMs >= 20, 'lock hold ' + baseline.holdMs + ' -> ' + fixed.holdMs); });

  // ================= 3. the fallbacks keep readiness at least as strong as before =================
  await ok('FIXED boot on a database with MISSING objects: runs the full statement list (creates them) even while an archive pass is writing, and only waits for one short chunk, not the pass', async () => {
    const f = freshDb('drift'); const d = await startHranaDouble({ file: f, rttMs: RTT }); try {
      const live = spawnWorker('archive', fixedTree, writeJson('pd.json', [rowsFor(NF)]), envFor(d)); await after(() => d.stats.batchRequests >= 2);
      { const x = new DatabaseSync(f); x.exec('PRAGMA busy_timeout = 20000'); x.exec('DROP INDEX idx_fpla_event'); x.exec('DROP TABLE nhl_provider_line_archive'); x.close(); }   /* damaged while the pass is writing: the live worker already did its own boot check */
      await sleep(50);
      const boot = await spawnWorker('boot', fixedTree, '', envFor(d)); const lv = await live; assert.ok(boot.json.ok, JSON.stringify(boot.json));
      assert.ok(boot.logs.some(l => /found work to do/.test(l) && /nhl_provider_line_archive/.test(l) && /idx_fpla_event/.test(l)), boot.logs.join(' | ')); assert.ok(boot.logs.some(l => /applied \d+ schema statements/.test(l)));
      assert.ok(boot.json.ms < 5000, 'boot ' + boot.json.ms + ' ms (the baseline boot under a 10x smaller pass waited ' + baseline.bootMs + ' ms)');
      const db = new DatabaseSync(f); const names = new Set(db.prepare("SELECT name FROM sqlite_master").all().map(r => r.name)); db.close(); assert.ok(names.has('nhl_provider_line_archive') && names.has('idx_fpla_event'), 'objects recreated'); } finally { await d.close(); } });
  await ok('FIXED boot with a missing COLUMN: reported, the statement list runs, and boot still becomes ready exactly as the deployed code does (neither can add the column)', async () => {
    const f = freshDb('col', { skip: ['ALTER TABLE nfl_provider_line_archive DROP COLUMN semantics_status'] }); const d = await startHranaDouble({ file: f, rttMs: 1 }); try {
      const boot = await spawnWorker('boot', fixedTree, '', envFor(d)); const base = await spawnWorker('boot', baseTree, '', envFor(d)); assert.ok(boot.json.ok && base.json.ok, JSON.stringify([boot.json, base.json]));
      assert.ok(boot.logs.some(l => /found work to do/.test(l) && /nfl_provider_line_archive\.semantics_status/.test(l)), boot.logs.join(' | ')); } finally { await d.close(); } });
  await ok('FIXED boot on an EMPTY database (first deploy): applies every statement, then a second boot verifies read-only', async () => {
    const f = path.join(tmp, 'empty.db'); new DatabaseSync(f).close(); const d = await startHranaDouble({ file: f, rttMs: 1 }); try {
      const b1 = await spawnWorker('boot', fixedTree, '', envFor(d)); assert.ok(b1.json.ok, JSON.stringify(b1.json)); assert.ok(b1.logs.some(l => /applied \d+ schema statements/.test(l)), b1.logs.join(' | '));
      const ddl1 = d.stats.ddlStatements; const b2 = await spawnWorker('boot', fixedTree, '', envFor(d)); assert.ok(b2.logs.some(l => /schema verified read-only/.test(l)), b2.logs.join(' | ')); assert.strictEqual(d.stats.ddlStatements, ddl1, 'second boot issues no DDL'); } finally { await d.close(); } });
  await ok('FIXED boot when the server cannot introspect (pragma functions unavailable): falls back to the full statement list and still becomes ready', async () => {
    const f = freshDb('nopragma'); const d = await startHranaDouble({ file: f, rttMs: 1, rejectPragmaFunctions: true }); try {
      const boot = await spawnWorker('boot', fixedTree, '', envFor(d)); assert.ok(boot.json.ok, JSON.stringify(boot.json)); assert.ok(boot.logs.some(l => /read-only schema check unavailable/.test(l)) && boot.logs.some(l => /applied \d+ schema statements/.test(l)), boot.logs.join(' | ')); } finally { await d.close(); } });
  await ok('FIXED boot with an UNREACHABLE database fails closed with the network error, once (no second pass of DDL attempts), exactly like the deployed code', async () => {
    const dead = { TURSO_DATABASE_URL: 'http://127.0.0.1:9', TURSO_AUTH_TOKEN: 'x' }; const nb = await spawnWorker('boot', fixedTree, '', dead); const bb = await spawnWorker('boot', baseTree, '', dead);
    assert.strictEqual(nb.json.ok, false); assert.strictEqual(bb.json.ok, false); assert.ok(nb.json.ms < 5000, 'fixed failed in ' + nb.json.ms + ' ms'); assert.ok(!nb.logs.some(l => /applying the schema statements/.test(l)), 'a network failure must not fall back to DDL'); });

  // ================= 4. bounded concurrency, atomicity, resume, equivalence =================
  const f1 = freshDb('inproc'); const dMain = await startHranaDouble({ file: f1, rttMs: RTT }); Object.assign(process.env, envFor(dMain));
  // a fresh module instance bound to the isolated server (the first require above used the sqlite backend only to read the statement list)
  Object.keys(require.cache).filter(k => k.startsWith(path.join(root, 'lib'))).forEach(k => delete require.cache[k]);
  const store = require(path.join(root, 'lib', 'snapshotStore.js')); const { createProviderLineArchive } = require(path.join(root, 'lib', 'marketArchive', 'providerLineArchiveFactory.js'));
  await ok('the in-process store is bound to the isolated Turso-compatible server (not SQLite, not production)', async () => { assert.strictEqual(store.backend, 'turso'); await store.verifyReady(); });
  await ok('BOUNDED CONCURRENCY: four sports archiving at once never have more than the cap of write batches in flight (client side and server side), and never more than one open write transaction', async () => {
    const sports = ['mlb', 'nfl', 'ncaaf', 'nhl']; const arch = sports.map(s => createProviderLineArchive({ sport: s, propsPathRegex: /./ })); const t0 = Date.now();
    const rs = await Promise.all(arch.map((a, i) => a.archiveFromRawParlayResponse('/x', JSON.stringify(rowsFor(3000, { tag: sports[i] })))));
    rs.forEach((r, i) => assert.strictEqual(r.archived, 3000, sports[i])); const st = store._writeStats(); console.log('     4 sports x 3000 rows in ' + (Date.now() - t0) + ' ms; cap ' + st.limit + ', max chunks in flight (client) ' + st.maxActive + ', max batch requests in flight (server) ' + dMain.stats.maxInflightBatch + ', chunks ' + st.chunks);
    assert.ok(st.maxActive <= st.limit && st.maxActive >= 1); assert.ok(dMain.stats.maxInflightBatch <= st.limit, 'server saw ' + dMain.stats.maxInflightBatch); assert.ok(Math.max(...dMain.stats.writeTxHeldMs) < 1000); });
  await ok('PARTIAL FAILURE then RESUME: when chunk 2 fails, chunk 1 stays committed (reported as rowsCommitted), no later chunk is started, and the next pass inserts only the rest -- nothing lost, nothing duplicated', async () => {
    const a = createProviderLineArchive({ sport: 'nfl', propsPathRegex: /./ }); const payload = rowsFor(1000, { tag: 'resume', offset: 5000 }); const countBefore = (await store.query("SELECT COUNT(*) c FROM nfl_provider_line_archive WHERE player_raw LIKE 'Player resume%'"))[0].c;
    dMain.failNextBatchAfter(1); let err = null; try { await a.archiveFromRawParlayResponse('/x', JSON.stringify(payload)); } catch (e) { err = e; }
    assert.ok(err, 'the pass must reject so the caller logs "failed to archive this refresh"'); assert.strictEqual(err.rowsCommitted, 200);
    const mid = (await store.query("SELECT COUNT(*) c FROM nfl_provider_line_archive WHERE player_raw LIKE 'Player resume%'"))[0].c - countBefore; assert.strictEqual(mid, 200, 'chunk 1 committed, chunk 2 rolled back, chunks 3-5 never started');
    const r2 = await a.archiveFromRawParlayResponse('/x', JSON.stringify(payload)); assert.strictEqual(r2.archived, 800); assert.strictEqual(r2.unchanged, 200);
    const total = (await store.query("SELECT COUNT(*) c, COUNT(DISTINCT player_raw || '|' || event_id || '|' || source || '|' || side || '|' || line) d FROM nfl_provider_line_archive WHERE player_raw LIKE 'Player resume%'"))[0]; assert.strictEqual(total.c - countBefore, 1000); assert.strictEqual(total.c, total.d, 'no duplicate rows');
    const r3 = await a.archiveFromRawParlayResponse('/x', JSON.stringify(payload)); assert.strictEqual(r3.archived, 0, 'a third pass finds everything already archived'); });
  await dMain.close();

  // equivalence: the same three passes (first load, identical repeat, then changed + new + same-identity-twice + null fields) through baseline and fixed code -> identical rows, ids and counts
  const mk = () => { const p1 = rowsFor(1500); p1.push({ ...p1[3], line: p1[3].line + 1 }); p1.push({ ...p1[5], over_price: -120 }); p1.push({ event_id: 'evN', player: 'Nulls', market_key: 'm', bookmaker: 'underdog', line: 1.5 });
    const p3 = rowsFor(1500, { price: -125 }).slice(0, 1300).concat(rowsFor(200, { tag: 'b', offset: 9000 })); p3.push({ ...p3[1], over_price: -101 }); p3.push({ ...p3[1], over_price: -102 }); return [p1, rowsFor(1500).concat(p1.slice(1500)), p3]; };
  for (const backend of ['turso', 'sqlite']) {
    await ok('EQUIVALENCE (' + backend + '): three passes of the same payloads through the deployed code and through the fixed code leave byte-identical archive rows (ids, order, values) and identical written / unchanged counts', async () => {
      const payloads = writeJson('eq-' + backend + '.json', mk()); const run = async (tree, label) => { let d = null, env;
        if (backend === 'turso') { d = await startHranaDouble({ file: freshDb('eq-' + label + '-' + backend), rttMs: 1 }); env = envFor(d); } else { const dir = path.join(tmp, 'eq-' + label); fs.mkdirSync(dir, { recursive: true }); env = { TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '', BEATSEDGE_DATA_DIR: dir }; }
        try { const r = await spawnWorker('archive', tree, payloads, env); assert.ok(r.json && !r.json.fatal, JSON.stringify(r.json) + r.stderr.slice(0, 300)); return { r: r.json, logs: r.logs.filter(l => /-archive\]/.test(l)) }; } finally { if (d) await d.close(); } };
      const b = await run(baseTree, 'base'), n = await run(fixedTree, 'fixed'); assert.deepStrictEqual(n.r.passes.map(p => [p.archived, p.unchanged]), b.r.passes.map(p => [p.archived, p.unchanged])); assert.strictEqual(n.r.rows, b.r.rows); assert.strictEqual(n.r.hash, b.r.hash, 'archive contents differ');
      assert.deepStrictEqual(n.logs, b.logs); assert.ok(b.r.passes[0].archived >= 1500, 'first pass wrote the load'); }); }
  await ok('CALLERS: nothing else changed shape -- the factory still exports the same API and the store still exports transaction/run/query for the page-capture and settlement code', () => {
    assert.deepStrictEqual(Object.keys(createProviderLineArchive({ sport: 'nfl', propsPathRegex: /./ })).sort(), ['CHANGE_FIELDS', 'IDENTITY_COLS', 'TABLE', 'archiveFromRawParlayResponse', 'isPropsPath', 'lineHistory', 'recordBatch', 'recordObservation', 'summary']);
    ['query', 'queryOne', 'run', 'transaction', 'verifyReady', 'batchWrite'].forEach(k => assert.strictEqual(typeof store[k], 'function', k)); });

  console.log('\n' + pass + ' passed, ' + fail + ' failed'); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { } process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
