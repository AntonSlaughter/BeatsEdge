// Real test of the persistent-storage migration: path resolution, idempotent
// seed-copy, and the "never silently mask a corrupt/missing production DB"
// safety rule. Runs entirely against OS temp directories -- never touches
// the real local data/beatsedge.db or data/snapshots.db, and never requires
// a real Render disk to verify the mechanism is correct.
//
// Each DB-touching section runs in its OWN child process (spawned via
// `node this-file.js --section X`), same pattern already used elsewhere in
// this repo (scripts/ingest-nflverse-stats.js, scripts/recompute-nfl-dvp.js)
// to work around a native better-sqlite3 cleanup crash on this box that
// gets far more likely the more sequential Database open/close cycles
// happen inside one process. Path-only sections (A/B, no DB opens) run
// inline since they carry none of that risk.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? ' -- ' + detail : ''}`);
  if (cond) pass++; else fail++;
}

function freshDataPaths(envValue) {
  if (envValue == null) delete process.env.BEATSEDGE_DATA_DIR;
  else process.env.BEATSEDGE_DATA_DIR = envValue;
  delete require.cache[require.resolve('../lib/dataPaths')];
  return require('../lib/dataPaths');
}
function freshEnsure() {
  delete require.cache[require.resolve('../lib/ensureDataInitialized')];
  return require('../lib/ensureDataInitialized');
}

function sectionA() {
  console.log('=== A: local path resolution (no BEATSEDGE_DATA_DIR) ===');
  const p = freshDataPaths(null);
  const expected = path.join(__dirname, '..', 'data');
  ok(p.DATA_DIR === expected, 'DATA_DIR resolves to repo ./data by default', p.DATA_DIR);
  ok(p.BEATSEDGE_DB_PATH === path.join(expected, 'beatsedge.db'), 'beatsedge.db path is under ./data');
  ok(p.SNAPSHOTS_DB_PATH === path.join(expected, 'snapshots.db'), 'snapshots.db path is under ./data');
  ok(p.usingCustomDataDir === false, 'usingCustomDataDir is false locally');
}

function sectionB() {
  console.log('\n=== B: production path resolution (BEATSEDGE_DATA_DIR set) ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatsedge-test-datadir-'));
  const p = freshDataPaths(tmp);
  ok(p.DATA_DIR === path.resolve(tmp), 'DATA_DIR resolves to the custom dir', p.DATA_DIR);
  ok(p.BEATSEDGE_DB_PATH === path.join(tmp, 'beatsedge.db'), 'beatsedge.db resolves under the custom dir');
  ok(p.SNAPSHOTS_DB_PATH === path.join(tmp, 'snapshots.db'), 'snapshots.db resolves under the custom dir');
  ok(p.usingCustomDataDir === true, 'usingCustomDataDir is true when BEATSEDGE_DATA_DIR is set');
  fs.rmSync(tmp, { recursive: true, force: true });

  // path.resolve('/var/data') is only a POSIX absolute path on POSIX (production
  // runs on Linux). On Windows dev boxes it resolves relative to the current
  // drive instead (e.g. C:\var\data) -- that's correct Windows behavior, not a
  // bug in lib/dataPaths.js, so only assert the POSIX-exact string on POSIX.
  const pLinux = freshDataPaths('/var/data');
  if (process.platform === 'win32') {
    ok(pLinux.BEATSEDGE_DB_PATH.endsWith(path.join('var', 'data', 'beatsedge.db')), '"/var/data" resolves under a var/data path on Windows (platform-relative — will be exact on Linux prod)', pLinux.BEATSEDGE_DB_PATH);
  } else {
    ok(pLinux.BEATSEDGE_DB_PATH === '/var/data/beatsedge.db', '"/var/data" env value round-trips to /var/data/beatsedge.db exactly on POSIX', pLinux.BEATSEDGE_DB_PATH);
  }
}

function makeFakeDb(filePath, rows) {
  const Database = require('better-sqlite3');
  const db = new Database(filePath);
  db.exec(`CREATE TABLE IF NOT EXISTS box_scores (id INTEGER PRIMARY KEY, sport TEXT)`);
  const ins = db.prepare(`INSERT INTO box_scores (sport) VALUES (?)`);
  const tx = db.transaction((n) => { for (let i = 0; i < n; i++) ins.run('test'); });
  tx(rows);
  db.close();
}
function countRows(filePath, table) {
  const Database = require('better-sqlite3');
  const db = new Database(filePath, { readonly: true });
  const c = db.prepare(`SELECT COUNT(*) c FROM "${table}"`).get().c;
  db.close();
  return c;
}

function sectionC() {
  console.log('=== C: idempotency -- existing destination is never overwritten ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatsedge-test-idem-'));
  freshDataPaths(tmp);
  const { BEATSEDGE_DB_PATH, SNAPSHOTS_DB_PATH } = require('../lib/dataPaths');
  makeFakeDb(BEATSEDGE_DB_PATH, 7); // a "real production" DB already sitting there with 7 rows
  const mtimeBefore = fs.statSync(BEATSEDGE_DB_PATH).mtimeMs;
  const { ensureDataInitialized } = freshEnsure();
  ensureDataInitialized();
  const countAfter = countRows(BEATSEDGE_DB_PATH, 'box_scores');
  ok(countAfter === 7, 'existing beatsedge.db row count unchanged after ensureDataInitialized()', `count=${countAfter}`);
  ok(fs.statSync(BEATSEDGE_DB_PATH).mtimeMs === mtimeBefore, 'existing beatsedge.db file was not rewritten (mtime unchanged)');
  ok(!fs.existsSync(SNAPSHOTS_DB_PATH), 'snapshots.db still does not exist -- nothing fabricated it');
  fs.rmSync(tmp, { recursive: true, force: true });
}

function sectionD() {
  console.log('=== D: copy-on-first-boot -- destination missing, real repo seed exists ===');
  const Database = require('better-sqlite3');
  const { REPO_SEED_BEATSEDGE_DB } = require('../lib/dataPaths');
  if (!fs.existsSync(REPO_SEED_BEATSEDGE_DB)) {
    console.log('  (skipped -- no local data/beatsedge.db to seed from in this environment)');
    return;
  }
  const sourceDb = new Database(REPO_SEED_BEATSEDGE_DB, { readonly: true });
  const sourceCounts = {};
  ['box_scores', 'nba_player_box', 'team_schedule', 'team_game_advanced', 'team_advanced_rollup'].forEach(t => {
    try { sourceCounts[t] = sourceDb.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch (e) { /* absent */ }
  });
  sourceDb.close();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatsedge-test-copy-'));
  freshDataPaths(tmp);
  const { BEATSEDGE_DB_PATH } = require('../lib/dataPaths');
  ok(!fs.existsSync(BEATSEDGE_DB_PATH), 'destination genuinely does not exist before init');
  const { ensureDataInitialized } = freshEnsure();
  ensureDataInitialized();
  ok(fs.existsSync(BEATSEDGE_DB_PATH), 'destination exists after ensureDataInitialized() (seed-copy ran)');

  const destDb = new Database(BEATSEDGE_DB_PATH, { readonly: true });
  let allMatch = true;
  for (const [t, n] of Object.entries(sourceCounts)) {
    const destN = destDb.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
    if (destN !== n) allMatch = false;
    ok(destN === n, `table "${t}" row count matches source after copy`, `source=${n} dest=${destN}`);
  }
  destDb.close();
  ok(allMatch, 'ALL sampled tables matched source exactly (F: beatsedge.db integrity)');

  ['team_schedule', 'team_game_advanced', 'team_advanced_rollup'].forEach(t => {
    ok(sourceCounts[t] !== undefined, `non-rebuildable table "${t}" exists in the source at all`);
  });

  const mtimeAfterFirstCopy = fs.statSync(BEATSEDGE_DB_PATH).mtimeMs;
  const { ensureDataInitialized: ensureAgain } = freshEnsure();
  ensureAgain();
  ok(fs.statSync(BEATSEDGE_DB_PATH).mtimeMs === mtimeAfterFirstCopy, 'running init a second time does not re-copy (seed/copy occurs exactly once)');

  fs.rmSync(tmp, { recursive: true, force: true });
}

function sectionE() {
  console.log('=== E: copy-validation mismatch detection ===');
  const { validateSqliteFile } = require('../lib/ensureDataInitialized');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatsedge-test-mismatch-'));
  const srcPath = path.join(tmp, 'source.db');
  const dstPath = path.join(tmp, 'dest.db');
  makeFakeDb(srcPath, 5);
  makeFakeDb(dstPath, 3);
  const before = validateSqliteFile(srcPath, ['box_scores']);
  const after = validateSqliteFile(dstPath, ['box_scores']);
  ok(JSON.stringify(before.counts) !== JSON.stringify(after.counts), 'validateSqliteFile correctly detects a source/destination count mismatch', `${JSON.stringify(before.counts)} vs ${JSON.stringify(after.counts)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

function sectionH() {
  console.log('=== H: corrupt existing destination FAILS LOUDLY, never silently replaced ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatsedge-test-corrupt-'));
  freshDataPaths(tmp);
  const { BEATSEDGE_DB_PATH } = require('../lib/dataPaths');
  fs.writeFileSync(BEATSEDGE_DB_PATH, 'this is not a sqlite file, just garbage text');
  const { ensureDataInitialized } = freshEnsure();
  let threw = false;
  try { ensureDataInitialized(); } catch (e) { threw = true; }
  ok(threw, 'ensureDataInitialized() throws on a corrupt existing beatsedge.db rather than silently replacing it');
  const stillGarbage = fs.readFileSync(BEATSEDGE_DB_PATH, 'utf8');
  ok(stillGarbage === 'this is not a sqlite file, just garbage text', 'corrupt file was left untouched, not silently overwritten with an empty DB');
  fs.rmSync(tmp, { recursive: true, force: true });
}

const SECTIONS = { A: sectionA, B: sectionB, C: sectionC, D: sectionD, E: sectionE, H: sectionH };

const argSection = process.argv[2] === '--section' ? process.argv[3] : null;
if (argSection) {
  // Child-process mode: run exactly one section, report via exit code.
  SECTIONS[argSection]();
  console.log(`--- section ${argSection}: ${pass} passed, ${fail} failed ---`);
  process.exit(fail > 0 ? 1 : 0);
}

// Parent mode: path-only sections run inline (no DB opens, no crash risk).
sectionA();
sectionB();

// DB-touching sections each run in a fresh child process.
let sectionsFailed = 0;
for (const name of ['C', 'D', 'E', 'H']) {
  console.log('');
  try {
    execFileSync(process.execPath, [__filename, '--section', name], { stdio: 'inherit' });
  } catch (e) {
    sectionsFailed++;
    console.log(`✗ section ${name} failed or crashed (exit code ${e.status})`);
  }
}

delete process.env.BEATSEDGE_DATA_DIR;

console.log(`\n=== RESULT: sections A/B inline (${pass} passed, ${fail} failed), ${4 - sectionsFailed}/4 child sections passed ===`);
if (fail > 0 || sectionsFailed > 0) process.exit(1);
