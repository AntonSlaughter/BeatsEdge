// NFL schema — separate from NBA's box_scores/defense_by_position because
// the stat categories genuinely differ (passing/rushing/receiving yards,
// not points/rebounds/assists). Positions here are real from day one
// (QB/RB/WR/TE) — nflverse publishes them cleanly, no G/F/C-style
// ambiguity, no compiled-positions.js needed for NFL.

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'beatsedge.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_player_game_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    season_type TEXT NOT NULL,          -- 'REG' | 'POST'
    game_date TEXT,                     -- derived, approximate (see ingest notes)
    player_id TEXT,
    player_name TEXT NOT NULL,
    position TEXT NOT NULL,             -- QB | RB | WR | TE (only prop-relevant positions ingested)
    team TEXT NOT NULL,
    opponent TEXT NOT NULL,
    passing_yards REAL DEFAULT 0,
    passing_tds REAL DEFAULT 0,
    interceptions REAL DEFAULT 0,
    rushing_yards REAL DEFAULT 0,
    rushing_tds REAL DEFAULT 0,
    receptions REAL DEFAULT 0,
    targets REAL DEFAULT 0,
    receiving_yards REAL DEFAULT 0,
    receiving_tds REAL DEFAULT 0,
    fantasy_points_ppr REAL DEFAULT 0,
    source TEXT DEFAULT 'nflverse-seed'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_nfl_stats_unique ON nfl_player_game_stats(season, week, season_type, player_id);
  CREATE INDEX IF NOT EXISTS idx_nfl_stats_opponent ON nfl_player_game_stats(opponent, position, season, week);

  -- Precomputed rollups, same pattern as NBA's defense_by_position.
  CREATE TABLE IF NOT EXISTS nfl_defense_by_position (
    team TEXT NOT NULL,
    position TEXT NOT NULL,             -- QB | RB | WR | TE
    window_type TEXT NOT NULL,          -- 'season' | 'last8' | 'last4'
    passing_yards_allowed REAL,
    rushing_yards_allowed REAL,
    receiving_yards_allowed REAL,
    receptions_allowed REAL,
    tds_allowed REAL,                   -- passing+rushing+receiving TDs combined, whichever apply to the position
    fantasy_points_allowed REAL,
    rank INTEGER,                       -- ranked by fantasy_points_allowed: 1 = fewest allowed (toughest defense)
    games_sampled INTEGER,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (team, position, window_type)
  );
`);

module.exports = db;
