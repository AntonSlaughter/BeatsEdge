// Historical-data storage backend selector, for the tables that were
// confirmed (2026-09-28) to be silently ephemeral in production: local
// SQLite (data/beatsedge.db) has no persistent disk mounted on Render, so
// it resets to empty on every deploy/restart. This module is the async,
// Turso-capable counterpart to lib/db.js / lib/mlbDb.js / lib/nhlDb.js /
// lib/nflDb.js for exactly that reason -- same selection contract as
// lib/snapshotStore.js (which already solved this problem for
// prop_snapshots), reused deliberately rather than inventing a new pattern.
//
// WHY A SEPARATE TURSO DATABASE FROM SNAPSHOTS (not the same URL/token):
// snapshots.db is live-grading, transactional, append-heavy, and load-
// bearing for real user-facing settlement (35k+ rows already, growing
// daily). This historical store is bulk reference data (box scores,
// rollups) with a completely different access/growth pattern. Putting a
// large historical bulk migration on the SAME Turso database as live prop
// grading would mean a slow/heavy historical write or an outage there can
// degrade settlement -- a strictly worse blast radius than two small,
// independent databases. Turso supports multiple databases per account at
// negligible extra cost/complexity; this module uses its OWN pair of env
// vars (TURSO_HISTORICAL_DATABASE_URL / TURSO_HISTORICAL_AUTH_TOKEN) so a
// historical-store incident can never touch snapshot grading and vice
// versa.
//
// LOCAL DEV (no TURSO_HISTORICAL_* env vars): local SQLite, and — this
// matters — the SAME physical file lib/db.js / lib/mlbDb.js / lib/nhlDb.js
// / lib/nflDb.js already use (BEATSEDGE_DB_PATH). This is intentional:
// tables NOT yet migrated to this adapter (box_scores, nba_pbp, wnba_pbp,
// period-stats, news_articles, team_schedule -- see the migration report
// for why) keep working exactly as before, reading/writing the same file,
// with zero duplication or drift between the old sync modules and this
// new async adapter in local dev.
//
// PRODUCTION: when TURSO_HISTORICAL_DATABASE_URL/TOKEN are both set, this
// module talks to Turso exclusively for the tables in SCHEMA_STATEMENTS
// below. If Turso is misconfigured (one var set, not both) this throws at
// require time, same fail-loud contract as snapshotStore.js. If Turso IS
// configured but a query fails at runtime, verifyReady()/healthStatus()
// surface that as an explicit unhealthy state -- callers must not catch
// that away and silently look healthy.

const path = require('path');
const { BEATSEDGE_DB_PATH } = require('./dataPaths');

const TURSO_URL = process.env.TURSO_HISTORICAL_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_HISTORICAL_AUTH_TOKEN || '';

if ((TURSO_URL && !TURSO_TOKEN) || (!TURSO_URL && TURSO_TOKEN)) {
  throw new Error(
    '[historicalStore] Only one of TURSO_HISTORICAL_DATABASE_URL / TURSO_HISTORICAL_AUTH_TOKEN is set. ' +
    'Both are required to use Turso for historical data -- refusing to guess whether Turso or local ' +
    'SQLite was intended. Set both, or unset both to use local SQLite.'
  );
}
const USE_TURSO = !!(TURSO_URL && TURSO_TOKEN);
const backend = USE_TURSO ? 'turso' : 'sqlite';

// A signal, not an enforcement: production environments set RENDER=true
// (Render's own auto-injected var) or NODE_ENV=production. If either is
// set and Turso is NOT configured, historical data on THIS boot is
// ephemeral -- exactly the bug this module exists to fix. Exposed via
// healthStatus() for /api/data-health and startup logging to surface
// loudly rather than silently continue looking healthy. Deliberately NOT
// a thrown error here: flipping this to a hard crash is a real behavior
// change for an already-running service and should be a deliberate,
// separately-reviewed decision once the team is ready to require Turso in
// production, not something this migration pass silently forces through.
const looksLikeProduction = !!(process.env.RENDER || process.env.NODE_ENV === 'production');
const ephemeralWarning = (!USE_TURSO && looksLikeProduction)
  ? 'Historical data is running on local SQLite in what looks like a production environment (RENDER/NODE_ENV=production set) with no persistent disk guaranteed -- this data WILL be lost on the next deploy/restart unless TURSO_HISTORICAL_DATABASE_URL/TURSO_HISTORICAL_AUTH_TOKEN are set.'
  : null;
if (ephemeralWarning) {
  // eslint-disable-next-line no-console
  console.warn(`[historicalStore] ${ephemeralWarning}`);
}

// Tables migrated to this adapter. Deliberately NOT every table in
// beatsedge.db -- see the migration report's "which tables should NOT
// migrate and why" section. Schema is IDENTICAL to the existing
// lib/db.js / lib/mlbDb.js / lib/nhlDb.js / lib/nflSchema.js definitions
// (copied, not redesigned) so a migrated row is byte-for-byte the same
// shape production already reads.
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS nba_player_box (
    game_id TEXT NOT NULL, athlete_id TEXT NOT NULL, athlete_name TEXT,
    season INTEGER, season_type INTEGER, game_date TEXT NOT NULL,
    team TEXT, opponent TEXT, home_away TEXT, pos TEXT, pos_group TEXT,
    minutes REAL DEFAULT 0, points REAL DEFAULT 0, off_reb REAL DEFAULT 0, def_reb REAL DEFAULT 0,
    rebounds REAL DEFAULT 0, assists REAL DEFAULT 0, threes REAL DEFAULT 0, threes_att REAL DEFAULT 0,
    steals REAL DEFAULT 0, blocks REAL DEFAULT 0, turnovers REAL DEFAULT 0,
    fgm REAL DEFAULT 0, fga REAL DEFAULT 0, ftm REAL DEFAULT 0, fta REAL DEFAULT 0,
    plus_minus REAL, starter INTEGER DEFAULT 0, played INTEGER DEFAULT 1,
    fantasy_points REAL, source TEXT DEFAULT 'hoopr',
    PRIMARY KEY (game_id, athlete_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_npb_athlete ON nba_player_box(athlete_id, game_date)`,
  `CREATE INDEX IF NOT EXISTS idx_npb_opp ON nba_player_box(opponent, pos_group, game_date)`,
  `CREATE INDEX IF NOT EXISTS idx_npb_season ON nba_player_box(season, season_type)`,

  // box_scores: the generic-sport (in practice NBA-only, 76k+ real local
  // rows) fine-position (PG/SG/SF/PF/C) box-score table lib/dvpEngine.js's
  // recomputeDefenseByPosition/getDefenseByPosition read/write -- see
  // cron/nightlyUpdate.js for the real nightly writer. Schema copied
  // EXACTLY from the real local table's own PRAGMA table_info/
  // sqlite_master output (this table's true origin predates the currently-
  // tracked schema files, same situation team_schedule was in per Phase 3).
  `CREATE TABLE IF NOT EXISTS box_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sport TEXT NOT NULL, game_date TEXT NOT NULL, game_id TEXT,
    player_name TEXT NOT NULL, position TEXT NOT NULL, team TEXT NOT NULL, opponent TEXT NOT NULL,
    points REAL DEFAULT 0, rebounds REAL DEFAULT 0, assists REAL DEFAULT 0, minutes REAL DEFAULT 0,
    source TEXT DEFAULT 'unknown', created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_box_scores_unique ON box_scores(sport, game_id, player_name)`,
  `CREATE INDEX IF NOT EXISTS idx_box_scores_opponent ON box_scores(sport, opponent, position, game_date)`,

  `CREATE TABLE IF NOT EXISTS wnba_player_box (
    game_id TEXT NOT NULL, athlete_id TEXT NOT NULL, athlete_name TEXT,
    season INTEGER, season_type INTEGER, game_date TEXT NOT NULL, game_date_time TEXT,
    team_id TEXT, team_name TEXT, team_abbreviation TEXT,
    opponent_team_id TEXT, opponent_team_name TEXT, opponent_team_abbreviation TEXT,
    home_away TEXT, pos TEXT, pos_group TEXT,
    minutes REAL DEFAULT 0, points REAL DEFAULT 0, off_reb REAL DEFAULT 0, def_reb REAL DEFAULT 0,
    rebounds REAL DEFAULT 0, assists REAL DEFAULT 0, threes REAL DEFAULT 0, threes_att REAL DEFAULT 0,
    steals REAL DEFAULT 0, blocks REAL DEFAULT 0, turnovers REAL DEFAULT 0,
    fgm REAL DEFAULT 0, fga REAL DEFAULT 0, ftm REAL DEFAULT 0, fta REAL DEFAULT 0,
    plus_minus REAL, team_score REAL, opponent_team_score REAL,
    starter INTEGER DEFAULT 0, did_not_play_raw INTEGER, active_raw INTEGER, played INTEGER DEFAULT 1,
    fantasy_points REAL, source TEXT DEFAULT 'hoopr',
    PRIMARY KEY (game_id, athlete_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wpb_athlete ON wnba_player_box(athlete_id, game_date)`,
  `CREATE INDEX IF NOT EXISTS idx_wpb_opp ON wnba_player_box(opponent_team_abbreviation, pos_group, game_date)`,
  `CREATE INDEX IF NOT EXISTS idx_wpb_season ON wnba_player_box(season, season_type)`,

  `CREATE TABLE IF NOT EXISTS nfl_player_game_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL, week INTEGER NOT NULL, season_type TEXT NOT NULL, game_date TEXT,
    player_id TEXT, player_name TEXT NOT NULL, position TEXT NOT NULL, team TEXT NOT NULL, opponent TEXT NOT NULL,
    passing_yards REAL DEFAULT 0, passing_tds REAL DEFAULT 0, interceptions REAL DEFAULT 0,
    rushing_yards REAL DEFAULT 0, rushing_tds REAL DEFAULT 0,
    receptions REAL DEFAULT 0, targets REAL DEFAULT 0, receiving_yards REAL DEFAULT 0, receiving_tds REAL DEFAULT 0,
    fantasy_points_ppr REAL DEFAULT 0, source TEXT DEFAULT 'nflverse-seed',
    pass_attempts REAL DEFAULT 0, completions REAL DEFAULT 0, rush_attempts REAL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_nfl_stats_unique ON nfl_player_game_stats(season, week, season_type, player_id)`,
  `CREATE INDEX IF NOT EXISTS idx_nfl_stats_opponent ON nfl_player_game_stats(opponent, position, season, week)`,

  `CREATE TABLE IF NOT EXISTS nfl_defense_by_position (
    team TEXT NOT NULL, position TEXT NOT NULL, window_type TEXT NOT NULL, season_year INTEGER,
    pass_attempts_allowed REAL, completions_allowed REAL, passing_yards_allowed REAL, passing_tds_allowed REAL,
    rush_attempts_allowed REAL, rushing_yards_allowed REAL, rushing_tds_allowed REAL,
    targets_allowed REAL, receptions_allowed REAL, receiving_yards_allowed REAL, receiving_tds_allowed REAL,
    fantasy_points_allowed REAL, rank INTEGER, games_sampled INTEGER, player_games_sampled INTEGER,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (team, position, window_type)
  )`,
  `CREATE TABLE IF NOT EXISTS nfl_team_defense_game (
    season INTEGER NOT NULL, week INTEGER NOT NULL, season_type TEXT NOT NULL,
    team TEXT NOT NULL, opponent TEXT NOT NULL,
    interceptions_generated REAL DEFAULT 0, pass_attempts_faced REAL DEFAULT 0,
    PRIMARY KEY (season, week, season_type, team)
  )`,
  `CREATE TABLE IF NOT EXISTS nfl_defense_interceptions (
    team TEXT NOT NULL, window_type TEXT NOT NULL, season_year INTEGER,
    interceptions_generated REAL, interceptions_per_game REAL, interception_rate REAL,
    pass_attempts_faced REAL, games_sampled INTEGER, updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (team, window_type)
  )`,

  `CREATE TABLE IF NOT EXISTS mlb_batter_game_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, game_date TEXT NOT NULL, game_pk TEXT NOT NULL,
    player_id TEXT, player_name TEXT NOT NULL, team TEXT NOT NULL, opponent TEXT NOT NULL,
    opposing_pitcher_id TEXT, opposing_pitcher_name TEXT,
    at_bats REAL DEFAULT 0, hits REAL DEFAULT 0, total_bases REAL DEFAULT 0, runs REAL DEFAULT 0,
    rbi REAL DEFAULT 0, home_runs REAL DEFAULT 0, walks REAL DEFAULT 0, strikeouts REAL DEFAULT 0,
    source TEXT DEFAULT 'statsapi-live'
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_mlb_batter_unique ON mlb_batter_game_stats(game_pk, player_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mlb_batter_pitcher ON mlb_batter_game_stats(opposing_pitcher_id, game_date)`,

  `CREATE TABLE IF NOT EXISTS mlb_pitcher_game_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, game_date TEXT NOT NULL, game_pk TEXT NOT NULL,
    player_id TEXT, player_name TEXT NOT NULL, team TEXT NOT NULL, opponent TEXT NOT NULL,
    innings_pitched REAL DEFAULT 0, strikeouts REAL DEFAULT 0, walks_allowed REAL DEFAULT 0,
    hits_allowed REAL DEFAULT 0, earned_runs REAL DEFAULT 0, home_runs_allowed REAL DEFAULT 0,
    source TEXT DEFAULT 'statsapi-live'
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_mlb_pitcher_unique ON mlb_pitcher_game_stats(game_pk, player_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mlb_pitcher_team ON mlb_pitcher_game_stats(team, game_date)`,

  `CREATE TABLE IF NOT EXISTS mlb_pitcher_rollup (
    player_id TEXT NOT NULL, player_name TEXT NOT NULL, window_type TEXT NOT NULL,
    era REAL, whip REAL, batting_avg_against REAL, k_per_9 REAL, hr_per_9 REAL,
    games_sampled INTEGER, updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (player_id, window_type)
  )`,
  `CREATE TABLE IF NOT EXISTS mlb_team_batting_rollup (
    team TEXT NOT NULL, window_type TEXT NOT NULL, team_avg REAL, team_ops REAL, k_rate REAL,
    runs_per_game REAL, rank INTEGER, games_sampled INTEGER, updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (team, window_type)
  )`,

  `CREATE TABLE IF NOT EXISTS nhl_skater_game_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, game_date TEXT NOT NULL, game_id TEXT NOT NULL,
    player_id TEXT, player_name TEXT NOT NULL, position TEXT NOT NULL, team TEXT NOT NULL, opponent TEXT NOT NULL,
    goals REAL DEFAULT 0, assists REAL DEFAULT 0, points REAL DEFAULT 0,
    shots_on_goal REAL DEFAULT 0, hits REAL DEFAULT 0, blocked_shots REAL DEFAULT 0,
    source TEXT DEFAULT 'nhle-live'
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_nhl_skater_unique ON nhl_skater_game_stats(game_id, player_id)`,
  `CREATE INDEX IF NOT EXISTS idx_nhl_skater_opponent ON nhl_skater_game_stats(opponent, position, game_date)`,
  `CREATE TABLE IF NOT EXISTS nhl_goalie_game_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, game_date TEXT NOT NULL, game_id TEXT NOT NULL,
    player_id TEXT, player_name TEXT NOT NULL, team TEXT NOT NULL, opponent TEXT NOT NULL,
    shots_against REAL DEFAULT 0, saves REAL DEFAULT 0, goals_against REAL DEFAULT 0,
    save_pct REAL, is_starter INTEGER DEFAULT 0, source TEXT DEFAULT 'nhle-live'
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_nhl_goalie_unique ON nhl_goalie_game_stats(game_id, player_id)`,
  `CREATE INDEX IF NOT EXISTS idx_nhl_goalie_team ON nhl_goalie_game_stats(team, game_date)`,
  `CREATE TABLE IF NOT EXISTS nhl_defense_by_position (
    team TEXT NOT NULL, position TEXT NOT NULL, window_type TEXT NOT NULL,
    goals_allowed REAL, assists_allowed REAL, points_allowed REAL, shots_allowed REAL,
    rank INTEGER, games_sampled INTEGER, updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (team, position, window_type)
  )`,
  `CREATE TABLE IF NOT EXISTS nhl_team_shooting_rollup (
    team TEXT NOT NULL, window_type TEXT NOT NULL, shots_per_game REAL, goals_per_game REAL,
    shooting_pct REAL, rank INTEGER, games_sampled INTEGER, updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (team, window_type)
  )`,

  `CREATE TABLE IF NOT EXISTS defense_by_position (
    sport TEXT NOT NULL, team TEXT NOT NULL, position TEXT NOT NULL, window_type TEXT NOT NULL,
    points_allowed REAL, rebounds_allowed REAL, assists_allowed REAL,
    rank_points INTEGER, games_sampled INTEGER, updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (sport, team, position, window_type)
  )`,
  `CREATE TABLE IF NOT EXISTS team_game_advanced (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sport TEXT NOT NULL, game_date TEXT NOT NULL, game_id TEXT,
    team TEXT NOT NULL, opponent TEXT NOT NULL, defensive_rating REAL, offensive_rating REAL, pace REAL,
    source TEXT DEFAULT 'kaggle-seed'
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_tga_unique ON team_game_advanced(sport, game_id, team)`,
  `CREATE INDEX IF NOT EXISTS idx_tga_team ON team_game_advanced(sport, team, game_date)`,
  `CREATE TABLE IF NOT EXISTS team_advanced_rollup (
    sport TEXT NOT NULL, team TEXT NOT NULL, window_type TEXT NOT NULL,
    defensive_rating REAL, offensive_rating REAL, pace REAL, def_rating_rank INTEGER,
    games_sampled INTEGER, updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (sport, team, window_type)
  )`,
  // Schema corrected 2026-09-28 to match the REAL local table exactly (via
  // PRAGMA table_info introspection) -- the original version of this
  // statement (no is_home/rest_days/is_back_to_back columns) was written
  // without checking against the real schema and would have silently
  // broken lib/situationalEngine.js's getTeamScheduleContext on a fresh
  // Turso database (those columns don't exist anywhere else in the
  // tracked codebase; this table predates the files currently in the repo).
  `CREATE TABLE IF NOT EXISTS team_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sport TEXT NOT NULL, game_id TEXT NOT NULL,
    team TEXT NOT NULL, opponent TEXT NOT NULL, game_date TEXT NOT NULL,
    is_home INTEGER NOT NULL, rest_days INTEGER, is_back_to_back INTEGER NOT NULL DEFAULT 0,
    source TEXT DEFAULT 'kaggle-seed'
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_team_schedule_unique ON team_schedule(sport, game_id, team)`,
  `CREATE INDEX IF NOT EXISTS idx_team_schedule_lookup ON team_schedule(sport, team, game_date)`,

  `CREATE TABLE IF NOT EXISTS ingest_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_type TEXT NOT NULL, rows_added INTEGER,
    ran_at TEXT DEFAULT (datetime('now')), notes TEXT
  )`,
];

// ── SQLite implementation (local dev / default) ─────────────────────────
// Deliberately node:sqlite's DatabaseSync, NOT better-sqlite3, for the
// SAME reason scripts/ingest-nflverse-stats.js and scripts/recompute-nfl-
// dvp.js already do: this machine's better-sqlite3 native binding
// reproducibly crashes ("Assertion failed: (env) != nullptr" /
// RemoveEnvironmentCleanupHook) under write-heavy transaction volume
// (confirmed directly, 2026-09-28: a 640-row batched DvP upsert via
// better-sqlite3's .transaction() crashed 3/3 attempts; the identical
// upsert via node:sqlite's raw BEGIN/COMMIT never crashed). Read-only
// query volume was NOT the trigger (a 23,543-row bulk SELECT via
// better-sqlite3 succeeded reliably) -- this is specifically a write-path
// issue, matching the two existing NFL scripts' own documented reasoning.
// node:sqlite's DatabaseSync API is close enough to better-sqlite3's for
// this module's needs (.exec, .prepare().run()/.all()/.get(),
// changes/lastInsertRowid on run()) that no caller-visible behavior
// differs -- only the underlying driver.
function createSqliteImpl() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(BEATSEDGE_DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);

  return {
    db,
    async query(sql, params = []) { return db.prepare(sql).all(...params); },
    async run(sql, params = []) {
      const info = db.prepare(sql).run(...params);
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    },
    // Same SQL, many param sets, one prepared statement, one BEGIN/COMMIT --
    // local sqlite is already fast per-statement, so this exists mainly so
    // callers (scripts/migrate-historical-to-turso.js) have ONE interface
    // regardless of backend. See the Turso impl's version for why this
    // matters much more there.
    async batchInsert(sql, paramsList) {
      const stmt = db.prepare(sql);
      db.exec('BEGIN');
      try {
        for (const params of paramsList) stmt.run(...params);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return { count: paramsList.length };
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
      db.prepare(`SELECT 1`).get();
      return { ok: true, backend: 'sqlite', path: BEATSEDGE_DB_PATH };
    },
  };
}

// ── Turso / libSQL implementation (production) ──────────────────────────
function createTursoImpl() {
  const { createClient } = require('@libsql/client');
  const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

  let schemaReady = null;
  async function ensureSchema() {
    if (!schemaReady) {
      schemaReady = (async () => {
        for (const stmt of SCHEMA_STATEMENTS) await client.execute(stmt);
      })();
    }
    return schemaReady;
  }

  return {
    async query(sql, params = []) {
      await ensureSchema();
      const rs = await client.execute({ sql, args: params });
      return rs.rows.map(r => ({ ...r }));
    },
    async run(sql, params = []) {
      await ensureSchema();
      const rs = await client.execute({ sql, args: params });
      return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid };
    },
    // ONE network round trip for many rows of the SAME sql shape, via
    // libsql's own client.batch() -- dramatically faster than either a
    // per-row client.execute() or even a transaction() that still issues
    // one execute() per statement over the same connection (measured while
    // building the Phase 5 production migration: ~68ms/row per-row,
    // ~24ms/row via transaction(), ~0.84ms/row via batch() -- the
    // difference between a multi-hour migration and a multi-minute one for
    // this project's real historical row counts). Used by
    // scripts/migrate-historical-to-turso.js instead of looping run().
    async batchInsert(sql, paramsList) {
      await ensureSchema();
      if (!paramsList.length) return { count: 0 };
      await client.batch(paramsList.map(args => ({ sql, args })), 'write');
      return { count: paramsList.length };
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
      return { ok: true, backend: 'turso' };
    },
  };
}

let _impl = null;
function getImpl() {
  if (!_impl) _impl = USE_TURSO ? createTursoImpl() : createSqliteImpl();
  return _impl;
}

async function query(sql, params = []) { return getImpl().query(sql, params); }
async function queryOne(sql, params = []) { const rows = await getImpl().query(sql, params); return rows[0]; }
async function run(sql, params = []) { return getImpl().run(sql, params); }
async function batchInsert(sql, paramsList) { return getImpl().batchInsert(sql, paramsList); }
async function transaction(asyncFn) { return getImpl().transaction(asyncFn); }
// Unlike snapshotStore's verifyReady (which is allowed to throw and crash
// startup), this NEVER throws -- callers (the data-health endpoint,
// startup logging) need a status object even when the backend is broken,
// so the failure is reported loudly instead of crashing the whole process
// over a diagnostics call. Anything that DOES want fail-loud behavior
// (e.g. a future startup gate) should check `.ok` and act on it itself.
async function healthStatus() {
  try {
    const impl = getImpl();
    const r = await impl.verifyReady();
    return { ...r, ephemeralWarning };
  } catch (e) {
    return { ok: false, backend, error: e.message, ephemeralWarning };
  }
}

module.exports = {
  backend, query, queryOne, run, batchInsert, transaction, healthStatus, SCHEMA_STATEMENTS, ephemeralWarning,
  get _sqliteDb() { return USE_TURSO ? undefined : getImpl().db; },
};
