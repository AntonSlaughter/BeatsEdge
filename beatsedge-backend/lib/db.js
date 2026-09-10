// Database layer — SQLite, single file, zero setup, zero cost.
//
// On Render's free tier, the disk is NOT guaranteed to persist across
// redeploys (only across requests while the instance is alive). That's
// fine here because everything in this DB is REBUILDABLE:
//   - box_scores: re-seeded from a CSV you download once (see scripts/seed-from-csv.js)
//   - defense_by_position: recomputed nightly from box_scores (see cron/nightlyUpdate.js)
// If you redeploy and lose the file, just re-run `npm run seed` and let
// the cron job run once — you're back to full data within a day.
// (If you want true persistence across redeploys without re-seeding,
// attach a Render persistent disk — a few dollars/month — but it is
// NOT required for this to work.)

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'beatsedge.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS box_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sport TEXT NOT NULL,               -- 'nba' | 'wnba'
    game_date TEXT NOT NULL,           -- YYYY-MM-DD
    game_id TEXT,
    player_name TEXT NOT NULL,
    position TEXT NOT NULL,            -- PG | SG | SF | PF | C
    team TEXT NOT NULL,                -- the player's own team
    opponent TEXT NOT NULL,            -- the team they played against (whose defense we're crediting/debiting)
    points REAL DEFAULT 0,
    rebounds REAL DEFAULT 0,
    assists REAL DEFAULT 0,
    minutes REAL DEFAULT 0,
    source TEXT DEFAULT 'unknown',     -- 'kaggle-seed' | 'nba-stats-nightly'
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_box_scores_opponent ON box_scores(sport, opponent, position, game_date);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_box_scores_unique ON box_scores(sport, game_id, player_name);

  -- Precomputed rollups so API responses are instant (no aggregation at request time)
  CREATE TABLE IF NOT EXISTS defense_by_position (
    sport TEXT NOT NULL,
    team TEXT NOT NULL,
    position TEXT NOT NULL,
    window_type TEXT NOT NULL,          -- 'season' | 'last10' | 'last20'
    points_allowed REAL,
    rebounds_allowed REAL,
    assists_allowed REAL,
    rank_points INTEGER,                -- 1 = fewest allowed (toughest D), 30 = most allowed (weakest D)
    games_sampled INTEGER,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (sport, team, position, window_type)
  );

  CREATE TABLE IF NOT EXISTS ingest_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_type TEXT NOT NULL,             -- 'seed' | 'nightly'
    rows_added INTEGER,
    ran_at TEXT DEFAULT (datetime('now')),
    notes TEXT
  );

  -- Real defensive rating / offensive rating / pace, per team per game.
  -- Sourced from TeamStatisticsExtended.csv (see scripts/seed-from-csv.js) —
  -- this is what backs the "Overall Defense" number when the live
  -- stats.nba.com call is blocked (it returned HTTP 403 in our own testing).
  CREATE TABLE IF NOT EXISTS team_game_advanced (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sport TEXT NOT NULL,
    game_date TEXT NOT NULL,
    game_id TEXT,
    team TEXT NOT NULL,
    opponent TEXT NOT NULL,
    defensive_rating REAL,
    offensive_rating REAL,
    pace REAL,
    source TEXT DEFAULT 'kaggle-seed'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_team_game_unique ON team_game_advanced(sport, game_id, team);
  CREATE INDEX IF NOT EXISTS idx_team_game_team ON team_game_advanced(sport, team, game_date);

  CREATE TABLE IF NOT EXISTS team_advanced_rollup (
    sport TEXT NOT NULL,
    team TEXT NOT NULL,
    window_type TEXT NOT NULL,          -- 'season' | 'last10'
    defensive_rating REAL,
    offensive_rating REAL,
    pace REAL,
    def_rating_rank INTEGER,            -- 1 = best (lowest) defensive rating
    games_sampled INTEGER,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (sport, team, window_type)
  );

  -- Full historical NBA player box scores, one row per player per game.
  -- Ingested from the free sportsdataverse / hoopR bulk release repo
  -- (scripts/fetch-hoopr-nba.js + scripts/ingest-hoopr-nba.js). ESPN-sourced,
  -- so athlete_id = ESPN athlete id and game_id = ESPN event id — same id
  -- space the live BeatsEdge NBA pipeline uses. Powers the walk-forward
  -- backtest in the offseason (no live slate to iterate) and a fresh,
  -- nightly-updatable defense-vs-position grid.
  CREATE TABLE IF NOT EXISTS nba_player_box (
    game_id TEXT NOT NULL,
    athlete_id TEXT NOT NULL,
    athlete_name TEXT,
    season INTEGER,                     -- season END year: 2026 = 2025-26
    season_type INTEGER,                -- 2 = regular, 3 = postseason
    game_date TEXT NOT NULL,            -- YYYY-MM-DD
    team TEXT,                          -- player's own team abbr (ESPN)
    opponent TEXT,                      -- opponent team abbr (ESPN)
    home_away TEXT,                     -- 'home' | 'away'
    pos TEXT,                           -- ESPN position abbr (PG/SG/SF/PF/C/G/F)
    pos_group TEXT,                     -- G | F | C
    minutes REAL DEFAULT 0,
    points REAL DEFAULT 0,
    off_reb REAL DEFAULT 0,
    def_reb REAL DEFAULT 0,
    rebounds REAL DEFAULT 0,
    assists REAL DEFAULT 0,
    threes REAL DEFAULT 0,              -- three_point_field_goals_made
    threes_att REAL DEFAULT 0,
    steals REAL DEFAULT 0,
    blocks REAL DEFAULT 0,
    turnovers REAL DEFAULT 0,
    fgm REAL DEFAULT 0, fga REAL DEFAULT 0,
    ftm REAL DEFAULT 0, fta REAL DEFAULT 0,
    plus_minus REAL,
    starter INTEGER DEFAULT 0,          -- 1 if started
    played INTEGER DEFAULT 1,           -- 0 if DNP / inactive
    source TEXT DEFAULT 'hoopr',
    PRIMARY KEY (game_id, athlete_id)
  );
  CREATE INDEX IF NOT EXISTS idx_npb_athlete ON nba_player_box(athlete_id, game_date);
  CREATE INDEX IF NOT EXISTS idx_npb_opp ON nba_player_box(opponent, pos_group, game_date);
  CREATE INDEX IF NOT EXISTS idx_npb_season ON nba_player_box(season, season_type);
`);

module.exports = db;
