// Load the sportsdataverse NHL player/team box-score CSVs (fetched by
// scripts/fetch-hoopr-nhl.js) into lib/historicalStore.js's nhl_player_box
// / nhl_team_box tables (Turso when configured, local SQLite otherwise --
// same adapter every other Phase 4/5 table uses).
//
//   node scripts/fetch-hoopr-nhl.js --seasons 2022,2023,2024,2025,2026   # get the CSVs first
//   node --env-file=.env scripts/ingest-hoopr-nhl.js                     # then load them (Turso)
//   node scripts/ingest-hoopr-nhl.js                                     # or local SQLite
//
// Idempotent -- PRIMARY KEY (game_id, player_id) / (game_id, team) +
// INSERT OR IGNORE via historicalStore.batchInsert (safe to re-run).
//
// Uses csv-parse's streaming Transform (columns:true) -- same real quoted-
// CSV parser scripts/ingest-hoopr-nba.js/ingest-hoopr-wnba.js already use,
// not line.split(',').
//
// OPPONENT DERIVATION: the source files carry team_abbrev + game_id but no
// explicit opponent column. Derived here in memory by grouping rows by
// game_id first (two teams per game_id) -- same technique
// cron/nightlyUpdate.js already uses for NBA's box_scores table.
//
// TOI: source gives "MM:SS" (a string, e.g. "16:00"). Stored verbatim in
// `toi`, PLUS a derived `toi_seconds` (real number, for actual research
// use) -- never silently only one or the other.
//
// Source: https://github.com/sportsdataverse/fastRhockey-nhl-data
// (MIT license), release assets via sportsdataverse-data. Same
// organization/license class as the NBA/WNBA hoopR data this project
// already ingests.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const store = require('../lib/historicalStore');

const PLAYER_DIR = path.join(__dirname, '..', 'data', 'hoopr-nhl', 'player_box');
const TEAM_DIR = path.join(__dirname, '..', 'data', 'hoopr-nhl', 'team_box');
const SINCE = (() => { const i = process.argv.indexOf('--since'); return i > -1 ? parseInt(process.argv[i + 1], 10) : 0; })();
const BATCH_SIZE = 500;

const numOrNull = v => (v === '' || v == null) ? null : (Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);
const strOrNull = v => (v === '' || v == null) ? null : String(v);
const toiSeconds = v => {
  if (!v) return null;
  const m = /^(\d+):(\d+)$/.exec(String(v).trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
};

function readCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(parse({ columns: true, skip_empty_lines: true }))
      .on('data', r => rows.push(r))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

async function ingestPlayerBox(season, rows) {
  // Derive opponent: group by game_id, find the other team_abbrev.
  const teamsByGame = new Map();
  for (const r of rows) {
    if (!teamsByGame.has(r.game_id)) teamsByGame.set(r.game_id, new Set());
    teamsByGame.get(r.game_id).add(r.team_abbrev);
  }
  const opponentOf = (gameId, team) => {
    const teams = teamsByGame.get(gameId);
    if (!teams) return null;
    for (const t of teams) if (t !== team) return t;
    return null;
  };

  const cols = [
    'game_id', 'player_id', 'player_name', 'season', 'game_date', 'team', 'opponent', 'home_away', 'position', 'sweater_number',
    'goals', 'assists', 'points', 'plus_minus', 'pim', 'hits',
    'power_play_goals', 'shots_on_goal', 'faceoff_winning_pctg',
    'toi', 'toi_seconds', 'blocked_shots', 'shifts', 'giveaways', 'takeaways',
    'even_strength_shots_against', 'power_play_shots_against', 'shorthanded_shots_against',
    'save_shots_against', 'save_pctg',
    'even_strength_goals_against', 'power_play_goals_against', 'shorthanded_goals_against',
    'goals_against', 'starter', 'decision', 'shots_against', 'saves',
  ];
  const sql = `INSERT OR IGNORE INTO nhl_player_box (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;

  const paramsList = [];
  const seen = new Set();
  for (const r of rows) {
    const key = `${r.game_id}|${r.player_id}`;
    if (seen.has(key)) continue; // duplicate row within the source itself
    seen.add(key);
    if (!r.game_id || !r.player_id || !r.game_date) continue; // invalid, no PK -- skipped, not fabricated
    paramsList.push([
      r.game_id, r.player_id, strOrNull(r.player_name), season, r.game_date, r.team_abbrev, opponentOf(r.game_id, r.team_abbrev), r.home_away || null,
      strOrNull(r.position), numOrNull(r.sweater_number),
      numOrNull(r.goals), numOrNull(r.assists), numOrNull(r.points), numOrNull(r.plus_minus), numOrNull(r.pim), numOrNull(r.hits),
      numOrNull(r.power_play_goals), numOrNull(r.shots_on_goal), numOrNull(r.faceoff_winning_pctg),
      strOrNull(r.toi), toiSeconds(r.toi), numOrNull(r.blocked_shots), numOrNull(r.shifts), numOrNull(r.giveaways), numOrNull(r.takeaways),
      numOrNull(r.even_strength_shots_against), numOrNull(r.power_play_shots_against), numOrNull(r.shorthanded_shots_against),
      numOrNull(r.save_shots_against), numOrNull(r.save_pctg),
      numOrNull(r.even_strength_goals_against), numOrNull(r.power_play_goals_against), numOrNull(r.shorthanded_goals_against),
      numOrNull(r.goals_against), r.starter === 'TRUE' || r.starter === 'true' || r.starter === '1' ? 1 : (r.starter ? 0 : null),
      strOrNull(r.decision), numOrNull(r.shots_against), numOrNull(r.saves),
    ]);
  }
  for (let i = 0; i < paramsList.length; i += BATCH_SIZE) {
    await store.batchInsert(sql, paramsList.slice(i, i + BATCH_SIZE));
  }
  return paramsList.length;
}

async function ingestTeamBox(season, rows) {
  const teamsByGame = new Map();
  for (const r of rows) {
    if (!teamsByGame.has(r.game_id)) teamsByGame.set(r.game_id, new Set());
    teamsByGame.get(r.game_id).add(r.team_abbrev);
  }
  const opponentOf = (gameId, team) => {
    const teams = teamsByGame.get(gameId);
    if (!teams) return null;
    for (const t of teams) if (t !== team) return t;
    return null;
  };

  const cols = [
    'game_id', 'team', 'season', 'game_date', 'opponent', 'home_away',
    'goals', 'shots_on_goal', 'power_play_goals', 'faceoff_win_pctg',
    'hits', 'blocked_shots', 'giveaways', 'takeaways', 'pim', 'saves', 'save_pctg', 'goals_against',
  ];
  const sql = `INSERT OR IGNORE INTO nhl_team_box (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  const paramsList = [];
  const seen = new Set();
  for (const r of rows) {
    const key = `${r.game_id}|${r.team_abbrev}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!r.game_id || !r.team_abbrev || !r.game_date) continue;
    paramsList.push([
      r.game_id, r.team_abbrev, season, r.game_date, opponentOf(r.game_id, r.team_abbrev), r.home_away || null,
      numOrNull(r.goals), numOrNull(r.shots_on_goal), numOrNull(r.power_play_goals), numOrNull(r.faceoff_win_pctg),
      numOrNull(r.hits), numOrNull(r.blocked_shots), numOrNull(r.giveaways), numOrNull(r.takeaways), numOrNull(r.pim),
      numOrNull(r.saves), numOrNull(r.save_pctg), numOrNull(r.goals_against),
    ]);
  }
  for (let i = 0; i < paramsList.length; i += BATCH_SIZE) {
    await store.batchInsert(sql, paramsList.slice(i, i + BATCH_SIZE));
  }
  return paramsList.length;
}

(async () => {
  console.log('backend:', store.backend);

  if (fs.existsSync(PLAYER_DIR)) {
    const files = fs.readdirSync(PLAYER_DIR).filter(f => /^player_box_\d{4}\.csv$/.test(f)).sort();
    for (const f of files) {
      const season = parseInt(f.match(/\d{4}/)[0], 10);
      if (season < SINCE) continue;
      const rows = await readCsv(path.join(PLAYER_DIR, f));
      const inserted = await ingestPlayerBox(season, rows);
      console.log(`player_box ${season}: ${rows.length} source rows -> ${inserted} inserted/kept`);
    }
  } else {
    console.log(`No player_box CSVs at ${PLAYER_DIR} -- run scripts/fetch-hoopr-nhl.js first.`);
  }

  if (fs.existsSync(TEAM_DIR)) {
    const files = fs.readdirSync(TEAM_DIR).filter(f => /^team_box_\d{4}\.csv$/.test(f)).sort();
    for (const f of files) {
      const season = parseInt(f.match(/\d{4}/)[0], 10);
      if (season < SINCE) continue;
      const rows = await readCsv(path.join(TEAM_DIR, f));
      const inserted = await ingestTeamBox(season, rows);
      console.log(`team_box ${season}: ${rows.length} source rows -> ${inserted} inserted/kept`);
    }
  } else {
    console.log(`No team_box CSVs at ${TEAM_DIR} -- run scripts/fetch-hoopr-nhl.js first.`);
  }

  console.log('\nDone. Source: https://github.com/sportsdataverse/fastRhockey-nhl-data (MIT license).');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
