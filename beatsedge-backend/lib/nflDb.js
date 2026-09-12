// NFL schema — separate from NBA's box_scores/defense_by_position because
// the stat categories genuinely differ (passing/rushing/receiving yards,
// not points/rebounds/assists). Positions here are real from day one
// (QB/RB/WR/TE) — nflverse publishes them cleanly, no G/F/C-style
// ambiguity, no compiled-positions.js needed for NFL.
//
// Table/column definitions live in lib/nflSchema.js (kept free of any
// better-sqlite3 import) so scripts/ingest-nflverse-stats.js can apply the
// identical schema through node:sqlite instead — see that script's header
// for why.

const Database = require('better-sqlite3');
const path = require('path');
const { runNflMigrations } = require('./nflSchema');

const DB_PATH = path.join(__dirname, '..', 'data', 'beatsedge.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
runNflMigrations(db);

module.exports = db;
