// Idempotent, one-time production data-directory initialization. Called
// ONCE, at the very top of server.js, before any lib/*Db.js module (which
// opens its SQLite connection at require-time) is ever required.
//
// Behavior:
//   - Always ensures DATA_DIR exists (mkdir -p) -- SQLite can't create a
//     file in a directory that doesn't exist yet.
//   - Only acts on a database file when it does NOT already exist at the
//     resolved path. An existing file -- healthy or not -- is NEVER
//     touched, copied over, or silently replaced. That is the whole point:
//     a persistent disk that already has real data must survive every
//     restart/redeploy exactly as-is.
//   - beatsedge.db: if missing, and this repo's own git-shipped copy
//     exists at the traditional ./data path, copy that in as a same-once
//     fallback seed (NOT a new commit -- reuses what's already tracked).
//     This is a safety net, not the recommended path: the richer local
//     database (573k+ NBA rows) should be uploaded directly to the
//     persistent disk BEFORE the app's first boot against it (see the
//     migration checklist) -- once a file exists at the destination, this
//     function will never overwrite it with the git-shipped baseline.
//   - snapshots.db: gitignored, never shipped via git, so there is no
//     automatic seed source for it at all. If missing, this function does
//     nothing -- lib/snapshotDb.js's own `CREATE TABLE IF NOT EXISTS`
//     creates it empty on first use, exactly like local dev today. The
//     5,530-row production history only ever arrives via a manual copy.
//   - FAILS LOUDLY (throws, does not catch) if a file exists but fails a
//     basic integrity check -- an unreadable/corrupt file must never be
//     quietly treated as "fine" or silently replaced with an empty one.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
  DATA_DIR, BEATSEDGE_DB_PATH, SNAPSHOTS_DB_PATH, REPO_SEED_BEATSEDGE_DB, usingCustomDataDir
} = require('./dataPaths');

function fmtBytes(n) { return n == null ? 'n/a' : `${(n / (1024 * 1024)).toFixed(1)}MB`; }

// Opens read-only, runs `PRAGMA quick_check`, and returns a few headline
// row counts for whichever of these well-known tables exist. Throws if the
// file can't be opened or fails the integrity check -- callers must NOT
// catch this away.
function validateSqliteFile(filePath, sampleTables) {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const check = db.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new Error(`quick_check failed for ${filePath}: ${check}`);
    const existingTables = new Set(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name)
    );
    const counts = {};
    for (const t of sampleTables) {
      if (existingTables.has(t)) counts[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
    }
    return { ok: true, tables: existingTables.size, counts };
  } finally {
    db.close();
  }
}

const BEATSEDGE_SAMPLE_TABLES = [
  'box_scores', 'nba_player_box', 'team_schedule', 'team_game_advanced',
  'team_advanced_rollup', 'nfl_player_game_stats', 'nfl_defense_by_position',
  'mlb_batter_game_stats', 'ingest_log'
];
const SNAPSHOTS_SAMPLE_TABLES = ['prop_snapshots'];

function ensureDataInitialized() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`[data-init] DATA_DIR=${DATA_DIR} (custom=${usingCustomDataDir})`);

  // beatsedge.db
  if (fs.existsSync(BEATSEDGE_DB_PATH)) {
    // Exists -- validate it opens and is not corrupt. Throws (fails loudly)
    // rather than falling back to anything if this doesn't pass.
    const result = validateSqliteFile(BEATSEDGE_DB_PATH, BEATSEDGE_SAMPLE_TABLES);
    console.log(`[data-init] beatsedge.db exists at ${BEATSEDGE_DB_PATH} (${fmtBytes(fs.statSync(BEATSEDGE_DB_PATH).size)}, ${result.tables} tables) -- using as-is, not touched. Sample counts: ${JSON.stringify(result.counts)}`);
  } else if (usingCustomDataDir && fs.existsSync(REPO_SEED_BEATSEDGE_DB)) {
    console.log(`[data-init] beatsedge.db missing at ${BEATSEDGE_DB_PATH} -- seeding once from git-shipped ${REPO_SEED_BEATSEDGE_DB}`);
    // WAL-mode databases can have recent writes sitting only in a `-wal`
    // sidecar, not yet merged into the main .db file -- a plain single-file
    // copy would silently produce an incomplete, stale seed. Checkpoint the
    // source first so the .db file is fully self-contained before copying
    // just that one file (same PRAGMA wal_checkpoint pattern already used
    // elsewhere in this repo, e.g. scripts/ingest-hoopr-nba.js).
    const checkpointDb = new Database(REPO_SEED_BEATSEDGE_DB);
    checkpointDb.pragma('wal_checkpoint(TRUNCATE)');
    checkpointDb.close();
    const before = validateSqliteFile(REPO_SEED_BEATSEDGE_DB, BEATSEDGE_SAMPLE_TABLES);
    console.log(`[data-init] source validated: ${before.tables} tables, counts ${JSON.stringify(before.counts)}`);
    fs.copyFileSync(REPO_SEED_BEATSEDGE_DB, BEATSEDGE_DB_PATH);
    const after = validateSqliteFile(BEATSEDGE_DB_PATH, BEATSEDGE_SAMPLE_TABLES);
    const countsMatch = JSON.stringify(before.counts) === JSON.stringify(after.counts);
    console.log(`[data-init] destination validated: ${after.tables} tables, counts ${JSON.stringify(after.counts)} -- counts match source: ${countsMatch}`);
    if (!countsMatch) throw new Error('[data-init] beatsedge.db seed copy row counts do not match source -- refusing to continue with a possibly-corrupt copy');
  } else {
    console.warn(`[data-init] beatsedge.db does not exist at ${BEATSEDGE_DB_PATH} and no seed source was found -- it will be created EMPTY on first use by lib/db.js. This is almost certainly not what you want in production; see the migration checklist for the manual upload step.`);
  }

  // snapshots.db -- no git-shipped seed exists (gitignored), so there is
  // nothing to auto-copy. Only validate-if-present.
  if (fs.existsSync(SNAPSHOTS_DB_PATH)) {
    const result = validateSqliteFile(SNAPSHOTS_DB_PATH, SNAPSHOTS_SAMPLE_TABLES);
    console.log(`[data-init] snapshots.db exists at ${SNAPSHOTS_DB_PATH} (${fmtBytes(fs.statSync(SNAPSHOTS_DB_PATH).size)}, ${result.tables} tables) -- using as-is. Sample counts: ${JSON.stringify(result.counts)}`);
  } else {
    console.warn(`[data-init] snapshots.db does not exist at ${SNAPSHOTS_DB_PATH} -- it will be created EMPTY on first use (no automatic seed exists for this file; it is gitignored by design). See the migration checklist for the manual upload step if production history should be preserved.`);
  }
}

module.exports = { ensureDataInitialized, validateSqliteFile, BEATSEDGE_SAMPLE_TABLES, SNAPSHOTS_SAMPLE_TABLES };
