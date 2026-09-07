// MLB schema. Architecturally different from NBA/NFL on purpose — baseball
// doesn't have a "defense vs position" concept. A BATTER's relevant matchup
// context is the specific opposing PITCHER (their ERA/WHIP/BAA/K-rate), not
// a team defensive unit. A PITCHER's relevant context is the opposing
// TEAM's whole-lineup batting profile. Both tables below reflect that.

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'beatsedge.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS mlb_batter_game_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_date TEXT NOT NULL,
    game_pk TEXT NOT NULL,
    player_id TEXT,
    player_name TEXT NOT NULL,
    team TEXT NOT NULL,
    opponent TEXT NOT NULL,
    opposing_pitcher_id TEXT,
    opposing_pitcher_name TEXT,
    at_bats REAL DEFAULT 0,
    hits REAL DEFAULT 0,
    total_bases REAL DEFAULT 0,
    runs REAL DEFAULT 0,
    rbi REAL DEFAULT 0,
    home_runs REAL DEFAULT 0,
    walks REAL DEFAULT 0,
    strikeouts REAL DEFAULT 0,
    source TEXT DEFAULT 'statsapi-live'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mlb_batter_unique ON mlb_batter_game_stats(game_pk, player_id);
  CREATE INDEX IF NOT EXISTS idx_mlb_batter_pitcher ON mlb_batter_game_stats(opposing_pitcher_id, game_date);

  CREATE TABLE IF NOT EXISTS mlb_pitcher_game_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_date TEXT NOT NULL,
    game_pk TEXT NOT NULL,
    player_id TEXT,
    player_name TEXT NOT NULL,
    team TEXT NOT NULL,
    opponent TEXT NOT NULL,
    innings_pitched REAL DEFAULT 0,
    strikeouts REAL DEFAULT 0,
    walks_allowed REAL DEFAULT 0,
    hits_allowed REAL DEFAULT 0,
    earned_runs REAL DEFAULT 0,
    home_runs_allowed REAL DEFAULT 0,
    source TEXT DEFAULT 'statsapi-live'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mlb_pitcher_unique ON mlb_pitcher_game_stats(game_pk, player_id);
  CREATE INDEX IF NOT EXISTS idx_mlb_pitcher_team ON mlb_pitcher_game_stats(team, game_date);

  -- What a SPECIFIC PITCHER allows to batters, rolled up — this is the real
  -- matchup context for a batter prop (facing this pitcher tonight).
  CREATE TABLE IF NOT EXISTS mlb_pitcher_rollup (
    player_id TEXT NOT NULL,
    player_name TEXT NOT NULL,
    window_type TEXT NOT NULL,      -- 'season' | 'last5starts'
    era REAL,
    whip REAL,
    batting_avg_against REAL,
    k_per_9 REAL,
    hr_per_9 REAL,
    games_sampled INTEGER,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (player_id, window_type)
  );

  -- What a TEAM's lineup does against pitching in general — the real
  -- matchup context for a PITCHER prop (facing this lineup tonight).
  CREATE TABLE IF NOT EXISTS mlb_team_batting_rollup (
    team TEXT NOT NULL,
    window_type TEXT NOT NULL,      -- 'season' | 'last15games'
    team_avg REAL,
    team_ops REAL,
    k_rate REAL,                    -- strikeouts per plate appearance, roughly
    runs_per_game REAL,
    rank INTEGER,                   -- 1 = toughest lineup to strike out (fewest Ks)
    games_sampled INTEGER,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (team, window_type)
  );

  CREATE TABLE IF NOT EXISTS ingest_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_type TEXT NOT NULL, rows_added INTEGER,
    ran_at TEXT DEFAULT (datetime('now')), notes TEXT
  );
`);

module.exports = db;
