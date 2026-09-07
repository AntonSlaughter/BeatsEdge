// NHL schema. Skaters get a position grid (Forward vs Defenseman) like
// NBA — real boxscores already split forwards/defense/goalies, so this
// isn't forced the way it would've been for baseball. Goalies get a
// team-shooting-profile like MLB's pitcher-vs-lineup idea: a goalie's
// real matchup context is the volume/quality of shots the opposing team
// generates, not a position they're facing.

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'beatsedge.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS nhl_skater_game_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    player_id TEXT,
    player_name TEXT NOT NULL,
    position TEXT NOT NULL,     -- 'F' (C/L/R collapsed) | 'D'
    team TEXT NOT NULL,
    opponent TEXT NOT NULL,
    goals REAL DEFAULT 0,
    assists REAL DEFAULT 0,
    points REAL DEFAULT 0,
    shots_on_goal REAL DEFAULT 0,
    hits REAL DEFAULT 0,
    blocked_shots REAL DEFAULT 0,
    source TEXT DEFAULT 'nhle-live'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_nhl_skater_unique ON nhl_skater_game_stats(game_id, player_id);
  CREATE INDEX IF NOT EXISTS idx_nhl_skater_opponent ON nhl_skater_game_stats(opponent, position, game_date);

  CREATE TABLE IF NOT EXISTS nhl_goalie_game_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    player_id TEXT,
    player_name TEXT NOT NULL,
    team TEXT NOT NULL,
    opponent TEXT NOT NULL,
    shots_against REAL DEFAULT 0,
    saves REAL DEFAULT 0,
    goals_against REAL DEFAULT 0,
    save_pct REAL,
    is_starter INTEGER DEFAULT 0,
    source TEXT DEFAULT 'nhle-live'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_nhl_goalie_unique ON nhl_goalie_game_stats(game_id, player_id);
  CREATE INDEX IF NOT EXISTS idx_nhl_goalie_team ON nhl_goalie_game_stats(team, game_date);

  -- Real "defense vs position" for skaters — goals/assists/points/shots
  -- allowed to Forwards vs Defensemen. Same pattern as NBA, legitimately
  -- (not forced) since NHL boxscores already split this way.
  CREATE TABLE IF NOT EXISTS nhl_defense_by_position (
    team TEXT NOT NULL,
    position TEXT NOT NULL,      -- 'F' | 'D'
    window_type TEXT NOT NULL,   -- 'season' | 'last10' | 'last5'
    goals_allowed REAL,
    assists_allowed REAL,
    points_allowed REAL,
    shots_allowed REAL,
    rank INTEGER,                -- 1 = fewest points allowed (toughest)
    games_sampled INTEGER,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (team, position, window_type)
  );

  -- Real team shooting profile — the actual matchup context for a GOALIE
  -- prop (saves, goals against): how many shots does this team generate,
  -- and how good are they.
  CREATE TABLE IF NOT EXISTS nhl_team_shooting_rollup (
    team TEXT NOT NULL,
    window_type TEXT NOT NULL,   -- 'season' | 'last10'
    shots_per_game REAL,
    goals_per_game REAL,
    shooting_pct REAL,
    rank INTEGER,                -- 1 = most shots/game (toughest for a goalie's saves prop)
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
