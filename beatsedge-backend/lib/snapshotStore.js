// Snapshot storage backend selector + a small generic async query
// interface, so cron/settleSnapshots.js and lib/snapshotDb.js don't need to
// know which database they're actually talking to.
//
// LOCAL DEV (no TURSO_* env vars set): local SQLite file, exactly the file
// this app has always used (data/snapshots.db via lib/dataPaths.js).
// Wrapped in trivially-resolved Promises so call sites are uniformly async
// against either backend -- the local path is still literally
// better-sqlite3 underneath, so local behavior/performance is unchanged.
//
// PRODUCTION (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN both set): a real
// Turso/libSQL connection via @libsql/client (the officially recommended,
// fully-async Node driver -- better-sqlite3 cannot reach a remote libSQL
// server at all, there is no synchronous option here).
//
// Both env vars must be set TOGETHER, or neither. One without the other is
// a misconfiguration this module refuses to guess about -- it throws at
// require time rather than silently picking a backend that might not be
// what was intended. This is also the enforcement point for "never
// silently fall back to an empty local database": if Turso was intended
// but misconfigured, the process fails to start at all.

const { SNAPSHOTS_DB_PATH } = require('./dataPaths');

const TURSO_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

if ((TURSO_URL && !TURSO_TOKEN) || (!TURSO_URL && TURSO_TOKEN)) {
  throw new Error(
    '[snapshotStore] Only one of TURSO_DATABASE_URL / TURSO_AUTH_TOKEN is set. ' +
    'Both are required to use Turso -- refusing to guess whether Turso or local ' +
    'SQLite was intended. Set both, or unset both to use local SQLite.'
  );
}
const USE_TURSO = !!(TURSO_URL && TURSO_TOKEN);
const backend = USE_TURSO ? 'turso' : 'sqlite';

// Defined once, used to initialize whichever backend is active, so the two
// schemas can never drift apart. Same table/columns/indexes snapshotDb.js
// has always created -- no schema change, just centralized.
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS prop_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snap_date TEXT NOT NULL,
    sport TEXT NOT NULL,
    player TEXT NOT NULL,
    team TEXT, opp TEXT, pos TEXT,
    stat TEXT NOT NULL,
    type TEXT,
    line REAL,
    dir TEXT DEFAULT 'over',
    book TEXT,
    line_source TEXT,
    model_variant TEXT NOT NULL DEFAULT 'A',
    model_projection REAL,
    proj_min REAL,
    pa_per_game REAL,
    ab_per_game REAL,
    batting_order INTEGER,
    probability REAL,
    raw_probability REAL,
    edge REAL,
    edge_pct REAL,
    edge_signal_pct REAL,
    grade TEXT,
    grade_score REAL,
    confidence REAL,
    factors_aligned INTEGER,
    factors_total INTEGER,
    prime INTEGER DEFAULT 0,
    market_line REAL,
    mkt_gap REAL,
    hit_rates TEXT,
    factors TEXT,
    data_quality TEXT,
    actual REAL,
    result TEXT,
    settlement_status TEXT,
    settlement_reason TEXT,
    settlement_source TEXT,
    graded_at TEXT,
    captured_at INTEGER,
    received_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_prop_snap_unique
     ON prop_snapshots(snap_date, sport, player, stat, line, dir, model_variant)`,
  `CREATE INDEX IF NOT EXISTS idx_prop_snap_slate ON prop_snapshots(snap_date, sport)`,
  `CREATE INDEX IF NOT EXISTS idx_prop_snap_ungraded ON prop_snapshots(result, snap_date)`,

  // Phase 2I-H -- raw historical provider-line archive (research only, not
  // read by cron/settleSnapshots.js or any grading/settlement path). APPEND
  // ONLY: unlike prop_snapshots (one row per day, upserted in place -- see
  // lib/snapshotDb.js's ON CONFLICT ... DO UPDATE), this table has no
  // update-in-place path anywhere in this codebase. A new provider
  // observation always gets a new row; line movement (19.5 -> 20.5 -> 19.5)
  // is three separate rows, never a single row overwritten twice. See
  // lib/wnbaProviderLineArchive.js for the insert helper, which decides
  // whether an observation is genuinely new by comparing against the most
  // recent row for the same identity tuple, not via a DB uniqueness
  // constraint (a real line returning to a prior value must still be a new
  // row, so no UNIQUE index on the identity+line combination is used here).
  `CREATE TABLE IF NOT EXISTS wnba_provider_line_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at INTEGER NOT NULL,
    provider_last_update TEXT,
    age_seconds REAL,
    sport TEXT NOT NULL DEFAULT 'wnba',
    event_id TEXT NOT NULL,
    home_team TEXT, away_team TEXT, commence_time TEXT, game_status TEXT,
    player_raw TEXT NOT NULL,
    player_id TEXT,
    market_key_raw TEXT NOT NULL,
    market_label TEXT,
    period TEXT,
    source TEXT NOT NULL,
    source_type TEXT,
    projection_type TEXT,
    odds_type TEXT,
    side TEXT,
    line REAL,
    over_price REAL,
    under_price REAL,
    projection_metadata TEXT,
    raw_json TEXT,
    semantics_status TEXT DEFAULT 'CONFIRMED'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wpla_identity ON wnba_provider_line_archive(sport, event_id, player_raw, market_key_raw, source, projection_type, period)`,
  `CREATE INDEX IF NOT EXISTS idx_wpla_event ON wnba_provider_line_archive(event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_wpla_captured ON wnba_provider_line_archive(captured_at)`,
  `CREATE INDEX IF NOT EXISTS idx_wpla_source ON wnba_provider_line_archive(source)`,
  `CREATE INDEX IF NOT EXISTS idx_wpla_market ON wnba_provider_line_archive(market_key_raw)`,
  `CREATE INDEX IF NOT EXISTS idx_wpla_player ON wnba_provider_line_archive(player_raw, market_key_raw)`,

  // Phase 2I-Q -- NBA sibling of wnba_provider_line_archive, identical
  // schema/discipline (append-only, no update-in-place, see
  // lib/nbaProviderLineArchive.js). Entirely separate table; never merged
  // with the WNBA archive.
  `CREATE TABLE IF NOT EXISTS nba_provider_line_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at INTEGER NOT NULL,
    provider_last_update TEXT,
    age_seconds REAL,
    sport TEXT NOT NULL DEFAULT 'nba',
    event_id TEXT NOT NULL,
    home_team TEXT, away_team TEXT, commence_time TEXT, game_status TEXT,
    player_raw TEXT NOT NULL,
    player_id TEXT,
    market_key_raw TEXT NOT NULL,
    market_label TEXT,
    period TEXT,
    source TEXT NOT NULL,
    source_type TEXT,
    projection_type TEXT,
    odds_type TEXT,
    side TEXT,
    line REAL,
    over_price REAL,
    under_price REAL,
    projection_metadata TEXT,
    raw_json TEXT,
    semantics_status TEXT DEFAULT 'CONFIRMED'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_npla_identity ON nba_provider_line_archive(sport, event_id, player_raw, market_key_raw, source, projection_type, period)`,
  `CREATE INDEX IF NOT EXISTS idx_npla_event ON nba_provider_line_archive(event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_npla_captured ON nba_provider_line_archive(captured_at)`,
  `CREATE INDEX IF NOT EXISTS idx_npla_source ON nba_provider_line_archive(source)`,
  `CREATE INDEX IF NOT EXISTS idx_npla_market ON nba_provider_line_archive(market_key_raw)`,
  `CREATE INDEX IF NOT EXISTS idx_npla_player ON nba_provider_line_archive(player_raw, market_key_raw)`
];

// ── SQLite implementation (local dev / default) ─────────────────────────
function createSqliteImpl() {
  const Database = require('better-sqlite3');
  const db = new Database(SNAPSHOTS_DB_PATH);
  db.pragma('journal_mode = WAL');

  // Same table this file has always had, created fresh here for a brand-new
  // DB. For a pre-existing DB (the normal case -- this file has existed
  // since before this module did), the CREATE TABLE is a no-op and the
  // lazy-migration block below adds any columns that predate them, exactly
  // as lib/snapshotDb.js always did.
  db.exec(`CREATE TABLE IF NOT EXISTS prop_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snap_date TEXT NOT NULL, sport TEXT NOT NULL, player TEXT NOT NULL,
    team TEXT, opp TEXT, pos TEXT, stat TEXT NOT NULL, type TEXT, line REAL,
    dir TEXT DEFAULT 'over', book TEXT, line_source TEXT, model_projection REAL,
    probability REAL, raw_probability REAL, edge REAL, edge_pct REAL, edge_signal_pct REAL,
    grade TEXT, grade_score REAL, confidence REAL, factors_aligned INTEGER, factors_total INTEGER,
    prime INTEGER DEFAULT 0, market_line REAL, mkt_gap REAL, hit_rates TEXT, factors TEXT,
    data_quality TEXT, actual REAL, result TEXT, graded_at TEXT, captured_at INTEGER,
    received_at TEXT DEFAULT (datetime('now'))
  )`);
  for (const col of [
    'proj_min REAL', 'pa_per_game REAL', 'ab_per_game REAL', 'batting_order INTEGER',
    "model_variant TEXT NOT NULL DEFAULT 'A'",
    'settlement_status TEXT', 'settlement_reason TEXT', 'settlement_source TEXT'
  ]) {
    try { db.exec(`ALTER TABLE prop_snapshots ADD COLUMN ${col}`); } catch (e) { /* already there */ }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prop_snap_slate ON prop_snapshots(snap_date, sport)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prop_snap_ungraded ON prop_snapshots(result, snap_date)`);

  // Any SCHEMA_STATEMENTS entry that isn't about prop_snapshots (which has
  // its own migration-sensitive handling above/below) is executed generically
  // here -- this is how new additive tables (e.g. wnba_provider_line_archive,
  // Phase 2I-H) reach the local SQLite backend, mirroring what the Turso
  // implementation's ensureSchema() loop already does for every statement.
  for (const stmt of SCHEMA_STATEMENTS) {
    if (/prop_snapshots/i.test(stmt)) continue;
    db.exec(stmt);
  }

  // Unique index must include model_variant. Rebuilding an INDEX (unlike a
  // table) never touches row data -- safe on every boot, verified via a
  // row-count guard, same as before this module existed.
  const idxCols = db.prepare(`PRAGMA index_info(idx_prop_snap_unique)`).all().map(r => r.name);
  const wantCols = ['snap_date', 'sport', 'player', 'stat', 'line', 'dir', 'model_variant'];
  if (idxCols.join(',') !== wantCols.join(',')) {
    const before = db.prepare(`SELECT COUNT(*) c FROM prop_snapshots`).get().c;
    db.exec('BEGIN');
    try {
      db.exec(`DROP INDEX IF EXISTS idx_prop_snap_unique`);
      db.exec(`CREATE UNIQUE INDEX idx_prop_snap_unique ON prop_snapshots(${wantCols.join(', ')})`);
      const after = db.prepare(`SELECT COUNT(*) c FROM prop_snapshots`).get().c;
      if (after !== before) throw new Error(`row count changed during index migration: ${before} -> ${after}`);
      db.exec('COMMIT');
      console.log(`[snapshotStore] migrated idx_prop_snap_unique to include model_variant (${before} rows preserved)`);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  return {
    db, // exposed for local-only callers that still want the raw handle (e.g. tests)
    async query(sql, params = []) { return db.prepare(sql).all(...params); },
    async run(sql, params = []) {
      const info = db.prepare(sql).run(...params);
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    },
    async transaction(asyncFn) {
      db.exec('BEGIN');
      const exec = async (sql, params = []) => {
        const info = db.prepare(sql).run(...(params || []));
        return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
      };
      try {
        const result = await asyncFn(exec);
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async verifyReady() {
      db.prepare(`SELECT 1 FROM prop_snapshots LIMIT 1`).get();
    }
  };
}

// ── Turso / libSQL implementation (production) ──────────────────────────
function createTursoImpl() {
  const { createClient } = require('@libsql/client');
  const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

  // Schema init is fire-and-forget-safe here (CREATE TABLE/INDEX IF NOT
  // EXISTS) but must complete before any query runs -- every method below
  // awaits this promise first.
  let schemaReady = null;
  async function ensureSchema() {
    if (!schemaReady) {
      schemaReady = (async () => {
        for (const stmt of SCHEMA_STATEMENTS) {
          await client.execute(stmt);
        }
      })();
    }
    return schemaReady;
  }

  return {
    async query(sql, params = []) {
      await ensureSchema();
      const rs = await client.execute({ sql, args: params });
      return rs.rows.map(r => ({ ...r })); // libSQL rows are proxy objects; plain-object them
    },
    async run(sql, params = []) {
      await ensureSchema();
      const rs = await client.execute({ sql, args: params });
      return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid };
    },
    async transaction(asyncFn) {
      await ensureSchema();
      const tx = await client.transaction('write');
      const exec = async (sql, params = []) => {
        const rs = await tx.execute({ sql, args: params });
        return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid };
      };
      try {
        const result = await asyncFn(exec);
        await tx.commit();
        return result;
      } catch (e) {
        await tx.rollback();
        throw e;
      }
    },
    async verifyReady() {
      await ensureSchema();
      await client.execute(`SELECT 1`);
    }
  };
}

// Lazy, memoized: constructing the real implementation has side effects
// (opens/creates the local file, or opens a network connection to Turso) --
// those must only happen on first actual USE, not merely from requiring
// this module to read `backend`. Code that only wants to know which
// backend is configured (e.g. lib/ensureDataInitialized.js) must be able to
// do that without side effects.
let _impl = null;
function getImpl() {
  if (!_impl) _impl = USE_TURSO ? createTursoImpl() : createSqliteImpl();
  return _impl;
}

async function query(sql, params = []) { return getImpl().query(sql, params); }
async function queryOne(sql, params = []) { const rows = await getImpl().query(sql, params); return rows[0]; }
async function run(sql, params = []) { return getImpl().run(sql, params); }
async function transaction(asyncFn) { return getImpl().transaction(asyncFn); }
// Throws (does not resolve to false / an error object) if the configured
// backend is unreachable or missing its schema -- callers (server.js at
// startup) are expected to let this crash the process rather than catch it
// and continue. See the module header: this is the whole point.
async function verifyReady() { return getImpl().verifyReady(); }

module.exports = {
  backend, query, queryOne, run, transaction, verifyReady, SCHEMA_STATEMENTS,
  // Local-only raw handle, for the handful of existing callers (tests) that
  // want it directly. Only valid to call on the sqlite backend -- callers
  // must check `backend === 'sqlite'` first, exactly like every other
  // backend-specific behavior in this module. Triggers lazy init on first
  // access, same as every other export here.
  get _sqliteDb() { return USE_TURSO ? undefined : getImpl().db; }
};
