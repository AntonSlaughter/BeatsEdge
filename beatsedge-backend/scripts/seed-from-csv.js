// One-time historical seed.
//
// Kaggle can't be reached from this build environment (it's not on the
// allowed egress list), so I can't download and bake the dataset in for
// you automatically. But the dataset is genuinely free and takes about
// 2 minutes to get — here's exactly how:
//
//   1. Go to: https://www.kaggle.com/datasets/eoinamoore/historical-nba-data-and-player-box-scores
//      (free Kaggle account required, no payment)
//   2. Download it, find the player box scores CSV (filename varies by
//      dataset version — look for one with per-player-per-game rows)
//   3. Place it at: backend/data/kaggle-boxscores.csv
//   4. Run: npm run seed
//
// This script is defensive about column names because Kaggle dataset
// authors update schemas over time — it looks for common variants and
// tells you clearly what it found / didn't find, rather than silently
// importing garbage.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const db = require('../lib/db');

const CSV_PATH = path.join(__dirname, '..', 'data', 'kaggle-boxscores.csv');

// Maps a variety of common Kaggle column name conventions to our schema.
// Add more aliases here if your downloaded CSV uses different headers —
// run with LOG_HEADERS=1 to print the actual columns found.
const COLUMN_ALIASES = {
  date: ['game_date', 'GAME_DATE', 'date', 'Date'],
  player: ['player_name', 'PLAYER_NAME', 'player', 'Player'],
  position: ['position', 'POSITION', 'pos', 'Pos'],
  team: ['team_abbreviation', 'TEAM_ABBREVIATION', 'team', 'Team', 'TEAM'],
  opponent: ['opponent', 'OPPONENT', 'opp', 'matchup_opponent', 'OPP'],
  points: ['pts', 'PTS', 'points', 'Points'],
  rebounds: ['reb', 'REB', 'rebounds', 'Rebounds', 'trb', 'TRB'],
  assists: ['ast', 'AST', 'assists', 'Assists'],
  minutes: ['min', 'MIN', 'minutes', 'Minutes']
};

function resolveColumn(row, key) {
  for (const alias of COLUMN_ALIASES[key]) {
    if (row[alias] !== undefined) return alias;
  }
  return null;
}

function normalizePosition(raw) {
  if (!raw) return null;
  const p = raw.toUpperCase().trim();
  // Handle combo positions like "G", "F", "G-F" by taking a reasonable primary guess.
  // For real accuracy, prefer a CSV/dataset that already has PG/SG/SF/PF/C granularity
  // (most box-score-level Kaggle NBA datasets do, since it comes from play-by-play rosters).
  if (['PG', 'SG', 'SF', 'PF', 'C'].includes(p)) return p;
  if (p === 'G') return 'PG';       // coarse fallback — see note above
  if (p === 'F') return 'SF';       // coarse fallback
  return null; // unknown position — row will be skipped rather than guessed wrong
}

function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`\n✗ No file found at ${CSV_PATH}`);
    console.error('  Download the free Kaggle dataset and place it there first — see the comment at the top of this file.\n');
    process.exit(1);
  }

  console.log(`Reading ${CSV_PATH} ...`);
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const records = parse(raw, { columns: true, skip_empty_lines: true });
  console.log(`Parsed ${records.length} rows.`);

  if (records.length === 0) {
    console.error('✗ CSV parsed to zero rows — check the file isn\'t empty/corrupted.');
    process.exit(1);
  }

  if (process.env.LOG_HEADERS) {
    console.log('Columns found in your CSV:', Object.keys(records[0]));
  }

  const sample = records[0];
  const cols = {};
  for (const key of Object.keys(COLUMN_ALIASES)) {
    cols[key] = resolveColumn(sample, key);
  }
  const missing = Object.entries(cols).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    console.error(`\n✗ Could not find columns for: ${missing.join(', ')}`);
    console.error('  Run with LOG_HEADERS=1 to see your actual CSV columns, then add');
    console.error('  the right names to COLUMN_ALIASES in this script.\n');
    process.exit(1);
  }
  console.log('Resolved columns:', cols);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO box_scores
      (sport, game_date, game_id, player_name, position, team, opponent, points, rebounds, assists, minutes, source)
    VALUES ('nba', @game_date, @game_id, @player_name, @position, @team, @opponent, @points, @rebounds, @assists, @minutes, 'kaggle-seed')
  `);

  const insertMany = db.transaction((rows) => {
    let inserted = 0, skipped = 0;
    for (const row of rows) {
      const position = normalizePosition(row[cols.position]);
      const team = row[cols.team];
      const opponent = row[cols.opponent];
      if (!position || !team || !opponent || team === opponent) { skipped++; continue; }

      insert.run({
        game_date: row[cols.date],
        game_id: row.game_id || row.GAME_ID || `${row[cols.date]}-${team}-${opponent}`,
        player_name: row[cols.player],
        position,
        team,
        opponent,
        points: parseFloat(row[cols.points]) || 0,
        rebounds: parseFloat(row[cols.rebounds]) || 0,
        assists: parseFloat(row[cols.assists]) || 0,
        minutes: parseFloat(row[cols.minutes]) || 0
      });
      inserted++;
    }
    return { inserted, skipped };
  });

  console.log('Inserting into SQLite (this may take a minute for large files)...');
  const { inserted, skipped } = insertMany(records);
  console.log(`\n✓ Inserted ${inserted} rows. Skipped ${skipped} (missing position/team/opponent).`);

  db.prepare(`INSERT INTO ingest_log (run_type, rows_added, notes) VALUES ('seed', ?, ?)`)
    .run(inserted, `From ${path.basename(CSV_PATH)}`);

  console.log('\nNow run the aggregation to compute defense-vs-position:');
  console.log('  node -e "require(\'./lib/dvpEngine\').recomputeDefenseByPosition(\'nba\')"');
  console.log('(the nightly cron does this automatically once the server is running)\n');
}

main();
