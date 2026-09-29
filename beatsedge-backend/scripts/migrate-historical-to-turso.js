// Idempotent historical-data migration/backfill tool: local SQLite
// (data/beatsedge.db, read via better-sqlite3 directly -- the richest
// available local copy) -> lib/historicalStore.js's configured destination
// (Turso when TURSO_HISTORICAL_DATABASE_URL/TOKEN are set, otherwise the
// SAME local beatsedge.db file, which makes a --dry-run/--apply safe and
// meaningful to run locally even before Turso credentials exist -- see
// --dest-override below for testing against a scratch file instead).
//
// Tables migrated (see the migration report for the full "why" per table):
//   nba_player_box, wnba_player_box, nfl_player_game_stats,
//   nfl_defense_by_position, nfl_team_defense_game, nfl_defense_interceptions,
//   mlb_batter_game_stats, mlb_pitcher_game_stats, mlb_pitcher_rollup,
//   mlb_team_batting_rollup, nhl_skater_game_stats, nhl_goalie_game_stats,
//   nhl_defense_by_position, nhl_team_shooting_rollup, defense_by_position,
//   team_game_advanced, team_advanced_rollup, team_schedule, box_scores
//   (box_scores added Phase 5 -- reclassified active in Phase 4, see below)
// NOT migrated: nba_pbp, wnba_pbp,
// nba_player_period_stats, wnba_player_period_stats (huge, read-only,
// period-market/research use -- see report), news_articles (unrelated domain).
//
// Conflict rule (same discipline as scripts/repair-nfl-2022-2024-attempts.js):
// a destination row that already exists and differs from source is a
// CONFLICT, reported and SKIPPED, never silently overwritten. This tool
// never resets/truncates the destination.
//
//   node scripts/migrate-historical-to-turso.js --dry-run [--table nba_player_box] [--limit 1000]
//   node scripts/migrate-historical-to-turso.js --apply   [--table nba_player_box]
//   node scripts/migrate-historical-to-turso.js --dry-run --dest-override tmp/scratch-dest.db   (local self-test, no Turso needed)

const fs = require('fs');
const path = require('path');
// node:sqlite's DatabaseSync, NOT better-sqlite3 -- same reason
// lib/historicalStore.js's SQLite backend was switched (2026-09-28,
// confirmed live): write-heavy / multi-connection better-sqlite3 usage on
// this machine reproducibly crashes ("Assertion failed: (env) != nullptr").
// This script opens a SEPARATE connection from historicalStore's own
// (source read-only vs. destination read/write), which is exactly the
// multi-connection shape that was found to trigger it.
const { DatabaseSync } = require('node:sqlite');
const { BEATSEDGE_DB_PATH } = require('../lib/dataPaths');

const APPLY = process.argv.includes('--apply');
const argVal = (name) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : null; };
const ONLY_TABLE = argVal('table');
const LIMIT = argVal('limit') ? parseInt(argVal('limit'), 10) : null;
const DEST_OVERRIDE = argVal('dest-override');
const RETENTION_PLAN = process.argv.includes('--retention-plan');
const BATCH_SIZE = 500;

// Production retention windows determined by the Section 2 live-reader
// audit (2026-09-28) -- NOT "migrate everything available." Each entry is
// "how many seasons back from the max season present, inclusive" and the
// season column to filter on. Only applied when --retention-plan is passed;
// omitting it (the default) migrates full available history, e.g. for a
// deliberate one-off full local backup or research use.
//   NBA/WNBA: current + 1 prior season. Covers the live 13-month DvP
//     freshness window (BeatsEdge.html ~11046-11050) and any L5/L10/season-
//     to-date rolling window carryover at the very start of a season.
//   NFL: current + 3 prior COMPLETE seasons -- this IS nflDvpEngine.js's
//     own existing `multiseason` design (currentAndCompleteSeasons():
//     complete = [current-3, current-2, current-1]), not a new number.
//   MLB: current + 1 prior season -- MLB resets fully each season (no
//     cross-season rolling window in the live formula), 1 extra season is
//     a safety buffer for the first few weeks of a new season.
const RETENTION_SEASONS_BACK = {
  nba_player_box: 1, wnba_player_box: 1,
  nfl_player_game_stats: 3, // + current = 4 total, matches multiseason exactly
  mlb_batter_game_stats: 1, mlb_pitcher_game_stats: 1,
};
const RETENTION_SEASON_COL = {
  nba_player_box: 'season', wnba_player_box: 'season',
  nfl_player_game_stats: 'season',
  mlb_batter_game_stats: "CAST(substr(game_date,1,4) AS INTEGER)",
  mlb_pitcher_game_stats: "CAST(substr(game_date,1,4) AS INTEGER)",
};

// Table definitions: primary key columns (for conflict/dedup detection) and
// the full column list (in insert order). Copied verbatim from the existing
// schemas -- no column invented, none silently dropped.
const TABLES = {
  nba_player_box: {
    pk: ['game_id', 'athlete_id'],
    cols: ['game_id', 'athlete_id', 'athlete_name', 'season', 'season_type', 'game_date', 'team', 'opponent', 'home_away', 'pos', 'pos_group', 'minutes', 'points', 'off_reb', 'def_reb', 'rebounds', 'assists', 'threes', 'threes_att', 'steals', 'blocks', 'turnovers', 'fgm', 'fga', 'ftm', 'fta', 'plus_minus', 'starter', 'played', 'fantasy_points', 'source'],
  },
  wnba_player_box: {
    pk: ['game_id', 'athlete_id'],
    cols: ['game_id', 'athlete_id', 'athlete_name', 'season', 'season_type', 'game_date', 'game_date_time', 'team_id', 'team_name', 'team_abbreviation', 'opponent_team_id', 'opponent_team_name', 'opponent_team_abbreviation', 'home_away', 'pos', 'pos_group', 'minutes', 'points', 'off_reb', 'def_reb', 'rebounds', 'assists', 'threes', 'threes_att', 'steals', 'blocks', 'turnovers', 'fgm', 'fga', 'ftm', 'fta', 'plus_minus', 'team_score', 'opponent_team_score', 'starter', 'did_not_play_raw', 'active_raw', 'played', 'fantasy_points', 'source'],
  },
  nfl_player_game_stats: {
    pk: ['season', 'week', 'season_type', 'player_id'],
    cols: ['season', 'week', 'season_type', 'game_date', 'player_id', 'player_name', 'position', 'team', 'opponent', 'passing_yards', 'passing_tds', 'interceptions', 'rushing_yards', 'rushing_tds', 'receptions', 'targets', 'receiving_yards', 'receiving_tds', 'fantasy_points_ppr', 'source', 'pass_attempts', 'completions', 'rush_attempts'],
  },
  nfl_defense_by_position: { pk: ['team', 'position', 'window_type'], cols: ['team', 'position', 'window_type', 'season_year', 'pass_attempts_allowed', 'completions_allowed', 'passing_yards_allowed', 'passing_tds_allowed', 'rush_attempts_allowed', 'rushing_yards_allowed', 'rushing_tds_allowed', 'targets_allowed', 'receptions_allowed', 'receiving_yards_allowed', 'receiving_tds_allowed', 'fantasy_points_allowed', 'rank', 'games_sampled', 'player_games_sampled'] },
  nfl_team_defense_game: { pk: ['season', 'week', 'season_type', 'team'], cols: ['season', 'week', 'season_type', 'team', 'opponent', 'interceptions_generated', 'pass_attempts_faced'] },
  nfl_defense_interceptions: { pk: ['team', 'window_type'], cols: ['team', 'window_type', 'season_year', 'interceptions_generated', 'interceptions_per_game', 'interception_rate', 'pass_attempts_faced', 'games_sampled'] },
  mlb_batter_game_stats: { pk: ['game_pk', 'player_id'], cols: ['game_date', 'game_pk', 'player_id', 'player_name', 'team', 'opponent', 'opposing_pitcher_id', 'opposing_pitcher_name', 'at_bats', 'hits', 'total_bases', 'runs', 'rbi', 'home_runs', 'walks', 'strikeouts', 'source'] },
  mlb_pitcher_game_stats: { pk: ['game_pk', 'player_id'], cols: ['game_date', 'game_pk', 'player_id', 'player_name', 'team', 'opponent', 'innings_pitched', 'strikeouts', 'walks_allowed', 'hits_allowed', 'earned_runs', 'home_runs_allowed', 'source'] },
  mlb_pitcher_rollup: { pk: ['player_id', 'window_type'], cols: ['player_id', 'player_name', 'window_type', 'era', 'whip', 'batting_avg_against', 'k_per_9', 'hr_per_9', 'games_sampled'] },
  mlb_team_batting_rollup: { pk: ['team', 'window_type'], cols: ['team', 'window_type', 'team_avg', 'team_ops', 'k_rate', 'runs_per_game', 'rank', 'games_sampled'] },
  nhl_skater_game_stats: { pk: ['game_id', 'player_id'], cols: ['game_date', 'game_id', 'player_id', 'player_name', 'position', 'team', 'opponent', 'goals', 'assists', 'points', 'shots_on_goal', 'hits', 'blocked_shots', 'source'] },
  nhl_goalie_game_stats: { pk: ['game_id', 'player_id'], cols: ['game_date', 'game_id', 'player_id', 'player_name', 'team', 'opponent', 'shots_against', 'saves', 'goals_against', 'save_pct', 'is_starter', 'source'] },
  nhl_defense_by_position: { pk: ['team', 'position', 'window_type'], cols: ['team', 'position', 'window_type', 'goals_allowed', 'assists_allowed', 'points_allowed', 'shots_allowed', 'rank', 'games_sampled'] },
  nhl_team_shooting_rollup: { pk: ['team', 'window_type'], cols: ['team', 'window_type', 'shots_per_game', 'goals_per_game', 'shooting_pct', 'rank', 'games_sampled'] },
  defense_by_position: { pk: ['sport', 'team', 'position', 'window_type'], cols: ['sport', 'team', 'position', 'window_type', 'points_allowed', 'rebounds_allowed', 'assists_allowed', 'rank_points', 'games_sampled'] },
  team_game_advanced: { pk: ['sport', 'game_id', 'team'], cols: ['sport', 'game_date', 'game_id', 'team', 'opponent', 'defensive_rating', 'offensive_rating', 'pace', 'source'] },
  team_advanced_rollup: { pk: ['sport', 'team', 'window_type'], cols: ['sport', 'team', 'window_type', 'defensive_rating', 'offensive_rating', 'pace', 'def_rating_rank', 'games_sampled'] },
  // is_home/rest_days/is_back_to_back added Phase 5 -- the real local
  // team_schedule table (per Phase 3's schema-fix audit) has these as
  // NOT NULL/real columns; this definition previously omitted them
  // (predated that fix), which made every real row fail Turso's NOT NULL
  // constraint on is_home. Found and fixed while running the real
  // migration -- no row data was lost (a batch failure here rolls back
  // only that libsql batch, and this tool never overwrites/loses source
  // data; it is safe to simply re-run).
  team_schedule: { pk: ['sport', 'game_id', 'team'], cols: ['sport', 'game_date', 'game_id', 'team', 'opponent', 'is_home', 'rest_days', 'is_back_to_back', 'source'] },
  // Added Phase 5 (production Turso migration): box_scores is the RAW
  // source lib/dvpEngine.js's Phase-4-converted computeDefenseByPositionBulk/
  // getDefenseByPositionAsync (an ACTIVE converted production reader, see
  // routes/api.js's /defense/* routes) actually reads -- this table was
  // reclassified from "legacy, do not migrate" to "active, migrate" in
  // Phase 4 once its real live callers were confirmed. No prior-phase
  // retention decision exists for it specifically (it has no `season`
  // column to filter on, only game_date); migrated in FULL here, same as
  // team_schedule/team_game_advanced/defense_by_position (its own sibling
  // tables, all comparably small and already unrestricted under
  // --retention-plan) rather than inventing a new date-based rule --
  // 76,045 local rows, not remotely in the same class as the excluded
  // giant PBP tables.
  box_scores: { pk: ['sport', 'game_id', 'player_name'], cols: ['sport', 'game_date', 'game_id', 'player_name', 'position', 'team', 'opponent', 'points', 'rebounds', 'assists', 'minutes', 'source'] },
};

function openSourceDb() {
  return new DatabaseSync(BEATSEDGE_DB_PATH);
}

// Destination: either the real historicalStore adapter (Turso if
// configured, else the same local beatsedge.db), or --dest-override for a
// scratch local file (used to self-test this tool's logic with a genuinely
// EMPTY destination, without needing live Turso credentials).
function getDest() {
  if (DEST_OVERRIDE) {
    const destPath = path.isAbsolute(DEST_OVERRIDE) ? DEST_OVERRIDE : path.join(__dirname, '..', DEST_OVERRIDE);
    const destDb = new DatabaseSync(destPath);
    destDb.exec('PRAGMA journal_mode = WAL');
    const { SCHEMA_STATEMENTS } = require('../lib/historicalStore');
    for (const stmt of SCHEMA_STATEMENTS) destDb.exec(stmt);
    return {
      label: `local scratch file (${destPath})`,
      async query(sql, params = []) { return destDb.prepare(sql).all(...params); },
      async run(sql, params = []) { const info = destDb.prepare(sql).run(...params); return { changes: info.changes, lastInsertRowid: info.lastInsertRowid }; },
      async batchInsert(sql, paramsList) {
        const stmt = destDb.prepare(sql);
        destDb.exec('BEGIN');
        try { for (const params of paramsList) stmt.run(...params); destDb.exec('COMMIT'); }
        catch (e) { destDb.exec('ROLLBACK'); throw e; }
        return { count: paramsList.length };
      },
    };
  }
  const store = require('../lib/historicalStore');
  return { label: `historicalStore (${store.backend})`, query: store.query, run: store.run, batchInsert: store.batchInsert };
}

function rowKey(row, pk) { return pk.map(k => String(row[k])).join('|'); }

async function migrateTable(tableName, def, sourceDb, dest) {
  let whereClause = '';
  let retentionNote = null;
  if (RETENTION_PLAN && RETENTION_SEASONS_BACK[tableName] != null) {
    const seasonCol = RETENTION_SEASON_COL[tableName];
    const maxRow = sourceDb.prepare(`SELECT MAX(${seasonCol}) mx FROM "${tableName}"`).get();
    const maxSeason = maxRow && maxRow.mx;
    if (maxSeason != null) {
      const minSeason = maxSeason - RETENTION_SEASONS_BACK[tableName];
      whereClause = ` WHERE ${seasonCol} >= ${minSeason}`;
      retentionNote = { maxSeason, minSeason, seasonsIncluded: RETENTION_SEASONS_BACK[tableName] + 1 };
    }
  }
  const sourceRows = LIMIT
    ? sourceDb.prepare(`SELECT * FROM "${tableName}"${whereClause} LIMIT ?`).all(LIMIT)
    : sourceDb.prepare(`SELECT * FROM "${tableName}"${whereClause}`).all();

  // Pull ALL existing destination PKs for this table in one query (not
  // per-row) -- cheap for these table sizes, avoids N round-trips to Turso.
  const destPkRows = await dest.query(`SELECT ${def.pk.join(', ')} FROM "${tableName}"`);
  const destPkSet = new Map(); // key -> full row, for conflict comparison
  for (const r of destPkRows) destPkSet.set(rowKey(r, def.pk), r);

  const report = { table: tableName, retentionPlan: retentionNote, sourceRows: sourceRows.length, destRowsBefore: destPkRows.length, wouldInsert: 0, wouldUpdate: 0, duplicates: 0, conflicts: 0, invalidRows: 0, conflictSamples: [], invalidSamples: [] };

  const toInsert = [];
  const seenThisRun = new Set(); // duplicate PKs WITHIN the source itself
  for (const row of sourceRows) {
    if (def.pk.some(k => row[k] == null)) { report.invalidRows++; if (report.invalidSamples.length < 5) report.invalidSamples.push(row); continue; }
    const key = rowKey(row, def.pk);
    if (seenThisRun.has(key)) { report.duplicates++; continue; }
    seenThisRun.add(key);

    if (destPkSet.has(key)) {
      // Row already exists at destination -- only a genuine VALUE conflict
      // if a non-null destination field disagrees with source. A row that's
      // simply already present with matching values needs no update.
      const destRow = destPkSet.get(key);
      const differs = def.cols.some(c => destRow[c] != null && row[c] != null && String(destRow[c]) !== String(row[c]));
      if (differs) {
        report.conflicts++;
        if (report.conflictSamples.length < 5) report.conflictSamples.push({ key, source: row, dest: destRow });
      }
      continue; // never overwrite an existing destination row in this tool
    }
    toInsert.push(row);
  }
  report.wouldInsert = toInsert.length;

  if (APPLY && toInsert.length) {
    const placeholders = def.cols.map(() => '?').join(', ');
    const sql = `INSERT INTO "${tableName}" (${def.cols.join(', ')}) VALUES (${placeholders})`;
    // batchInsert (ONE network round trip per BATCH_SIZE chunk, via libsql's
    // client.batch() on Turso) instead of one await per row -- measured
    // ~80x faster for this project's real row counts (a multi-hour
    // migration otherwise). Checkpointed: progress is written to the
    // report/console after every chunk, and the whole tool is safe to
    // re-run (INSERT-only, PK-conflict-checked against the destination
    // first) if interrupted partway through.
    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE);
      const paramsList = batch.map(row => def.cols.map(c => row[c] === undefined ? null : row[c]));
      await dest.batchInsert(sql, paramsList);
      process.stdout.write(`  [${tableName}] inserted ${Math.min(i + BATCH_SIZE, toInsert.length)}/${toInsert.length}\r`);
    }
    console.log('');
  }

  return report;
}

(async () => {
  const sourceDb = openSourceDb();
  const dest = getDest();
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — source: ${BEATSEDGE_DB_PATH}`);
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — destination: ${dest.label}\n`);

  const tableNames = ONLY_TABLE ? [ONLY_TABLE] : Object.keys(TABLES);
  const allReports = {};
  for (const t of tableNames) {
    if (!TABLES[t]) { console.error(`Unknown table: ${t}`); process.exit(1); }
    const r = await migrateTable(t, TABLES[t], sourceDb, dest);
    allReports[t] = r;
    console.log(`${t}: source=${r.sourceRows} destBefore=${r.destRowsBefore} wouldInsert=${r.wouldInsert} duplicates=${r.duplicates} conflicts=${r.conflicts} invalid=${r.invalidRows}${r.retentionPlan ? ` [retention: seasons ${r.retentionPlan.minSeason}-${r.retentionPlan.maxSeason}, ${r.retentionPlan.seasonsIncluded} seasons]` : ''}`);
  }

  const outPath = path.join(__dirname, '..', 'tmp', `migration-${APPLY ? 'apply' : 'dryrun'}-report.json`);
  fs.writeFileSync(outPath, JSON.stringify(allReports, null, 2));
  console.log(`\nWritten to ${outPath}`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
