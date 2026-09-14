// Recomputes nfl_defense_by_position + nfl_defense_interceptions from the
// raw nfl_player_game_stats / nfl_team_defense_game tables.
//
//   node scripts/recompute-nfl-dvp.js
//
// Run this after scripts/ingest-nflverse-stats.js (nightly cron runs both,
// in this order). Uses node:sqlite's DatabaseSync, NOT better-sqlite3 —
// this recompute does hundreds of sequential writes across 4 positions x
// 5 windows x ~32 teams, and doing that same work through better-sqlite3
// reproducibly crashes this process (native "Assertion failed: (env) !=
// nullptr" / Statement cleanup abort) on this Node/Windows build. See the
// header comment in ingest-nflverse-stats.js for the original discovery of
// this issue — confirmed again here, so this script stays node:sqlite-only.
const { DatabaseSync } = require('node:sqlite');
const { runNflMigrations } = require('../lib/nflSchema');
const { recomputeNflDefenseByPosition } = require('../lib/nflDvpEngine');
const { BEATSEDGE_DB_PATH } = require('../lib/dataPaths');

const DB_PATH = BEATSEDGE_DB_PATH;
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
runNflMigrations(db);

const summary = recomputeNflDefenseByPosition(db);
console.log('NFL DvP recompute:', JSON.stringify(summary));
