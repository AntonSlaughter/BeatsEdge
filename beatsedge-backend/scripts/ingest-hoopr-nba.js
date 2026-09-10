// Load the hoopR / sportsdataverse NBA player box-score CSVs (fetched by
// scripts/fetch-hoopr-nba.js) into data/beatsedge.db -> nba_player_box.
//
//   node scripts/fetch-hoopr-nba.js --from 2016      # get the CSVs first
//   node scripts/ingest-hoopr-nba.js                 # then load them
//   node scripts/ingest-hoopr-nba.js --since 2020    # only seasons >= 2020
//
// Idempotent — PRIMARY KEY (game_id, athlete_id) + INSERT OR REPLACE.
// Rebuildable on Render's ephemeral disk the same way box_scores is.
//
// Uses the built-in `node:sqlite` (Node >= 22.5) rather than better-sqlite3:
// the prebuilt better-sqlite3 binary aborts on large transactions under
// Node 24 on this box. Same .db file, same SQLite format — the server's
// better-sqlite3 handle reads it fine.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '..', 'data', 'beatsedge.db');
const DIR = path.join(__dirname, '..', 'data', 'hoopr', 'player_box');
const SINCE = (() => { const i = process.argv.indexOf('--since'); return i > -1 ? parseInt(process.argv[i + 1], 10) : 0; })();

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const posGroup = raw => /^(PG|SG|G)$/i.test(raw || '') ? 'G' : /^(SF|PF|F)$/i.test(raw || '') ? 'F' : 'C';

if (!fs.existsSync(DIR)) {
  console.error(`No CSVs at ${DIR}\nRun:  node scripts/fetch-hoopr-nba.js --from 2016 --sets player_box`);
  process.exit(1);
}
const files = fs.readdirSync(DIR).filter(f => /^player_box_\d{4}\.csv$/.test(f)).sort();
if (!files.length) { console.error(`No player_box_*.csv in ${DIR}`); process.exit(1); }

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS nba_player_box (
    game_id TEXT NOT NULL, athlete_id TEXT NOT NULL, athlete_name TEXT,
    season INTEGER, season_type INTEGER, game_date TEXT NOT NULL,
    team TEXT, opponent TEXT, home_away TEXT, pos TEXT, pos_group TEXT,
    minutes REAL DEFAULT 0, points REAL DEFAULT 0, off_reb REAL DEFAULT 0, def_reb REAL DEFAULT 0,
    rebounds REAL DEFAULT 0, assists REAL DEFAULT 0, threes REAL DEFAULT 0, threes_att REAL DEFAULT 0,
    steals REAL DEFAULT 0, blocks REAL DEFAULT 0, turnovers REAL DEFAULT 0,
    fgm REAL DEFAULT 0, fga REAL DEFAULT 0, ftm REAL DEFAULT 0, fta REAL DEFAULT 0,
    plus_minus REAL, starter INTEGER DEFAULT 0, played INTEGER DEFAULT 1, source TEXT DEFAULT 'hoopr',
    PRIMARY KEY (game_id, athlete_id)
  );
  CREATE INDEX IF NOT EXISTS idx_npb_athlete ON nba_player_box(athlete_id, game_date);
  CREATE INDEX IF NOT EXISTS idx_npb_opp ON nba_player_box(opponent, pos_group, game_date);
  CREATE INDEX IF NOT EXISTS idx_npb_season ON nba_player_box(season, season_type);
`);

const upsert = db.prepare(`
  INSERT OR REPLACE INTO nba_player_box
    (game_id, athlete_id, athlete_name, season, season_type, game_date, team, opponent,
     home_away, pos, pos_group, minutes, points, off_reb, def_reb, rebounds, assists,
     threes, threes_att, steals, blocks, turnovers, fgm, fga, ftm, fta, plus_minus,
     starter, played, source)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'hoopr')
`);

let totalRows = 0, totalFiles = 0;
for (const file of files) {
  const yr = parseInt(file.match(/(\d{4})/)[1], 10);
  if (SINCE && yr < SINCE) continue;
  process.stdout.write(`  ${file} ... `);
  const rows = parse(fs.readFileSync(path.join(DIR, file)), { columns: true, skip_empty_lines: true, relax_column_count: true });
  db.exec('BEGIN');
  for (const r of rows) {
    if (!r.game_id || !r.athlete_id) continue;
    upsert.run(
      String(r.game_id), String(r.athlete_id), r.athlete_display_name || null,
      parseInt(r.season, 10) || yr, parseInt(r.season_type, 10) || null, (r.game_date || '').slice(0, 10),
      r.team_abbreviation || null, r.opponent_team_abbreviation || null, r.home_away || null,
      r.athlete_position_abbreviation || null, posGroup(r.athlete_position_abbreviation),
      num(r.minutes), num(r.points), num(r.offensive_rebounds), num(r.defensive_rebounds),
      num(r.rebounds), num(r.assists), num(r.three_point_field_goals_made), num(r.three_point_field_goals_attempted),
      num(r.steals), num(r.blocks), num(r.turnovers), num(r.field_goals_made), num(r.field_goals_attempted),
      num(r.free_throws_made), num(r.free_throws_attempted),
      (r.plus_minus === '' || r.plus_minus == null) ? null : num(r.plus_minus),
      String(r.starter).toLowerCase() === 'true' ? 1 : 0,
      String(r.did_not_play).toLowerCase() === 'true' ? 0 : 1
    );
  }
  db.exec('COMMIT');
  totalRows += rows.length;
  totalFiles++;
  console.log(`${rows.length} rows`);
}

const n = db.prepare(`SELECT COUNT(*) c FROM nba_player_box`).get().c;
const span = db.prepare(`SELECT MIN(game_date) a, MAX(game_date) b, COUNT(DISTINCT athlete_id) ath FROM nba_player_box`).get();
try {
  db.prepare(`INSERT INTO ingest_log (run_type, rows_added, notes) VALUES ('seed', ?, ?)`)
    .run(totalRows, `nba_player_box from hoopR: ${totalFiles} files, ${n} rows (${span.a}..${span.b})`);
} catch (e) { /* ingest_log may not exist if lib/db.js never ran — non-fatal */ }
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
console.log(`\ndone — ${totalFiles} files, ${totalRows} rows; nba_player_box now ${n} rows, ${span.ath} players (${span.a} .. ${span.b})`);
