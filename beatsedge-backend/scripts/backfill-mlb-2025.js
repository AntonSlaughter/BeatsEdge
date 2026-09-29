// Idempotent, resumable, rate-conscious 2025 MLB regular-season backfill,
// using the SAME official per-game boxscore path production already uses
// (lib/mlbProxy.js's fetchSchedule/fetchBoxscore -- statsapi.mlb.com, free,
// keyless), looped over 2025's real dates instead of "yesterday" the way
// cron/mlbNightlyUpdate.js does. This is more complete than the 2022-2024
// PA-level transform: the official boxscore carries real, official-scorer
// runs/earned_runs fields the PA-level reconstruction could not derive.
//
// The row-parsing logic below (parseBoxscore) is copied VERBATIM from
// lib/mlbEngine.js's own parseBoxscore (same field mappings, same
// opposing-starter-credit rule, same innings_pitched-stored-as-the-API's-
// own-value convention) -- NOT reinvented. It is duplicated rather than
// required from lib/mlbEngine.js specifically because that module's
// require('./mlbDb') opens a better-sqlite3 connection as a module-level
// side effect, and this backfill needs ~2,700+ real writes across a long-
// running job -- exactly the write volume already found (2026-09-28,
// lib/historicalStore.js's header) to reproducibly crash better-sqlite3's
// native binding on this machine. This script writes via node:sqlite's
// DatabaseSync instead, the same proven pattern scripts/ingest-nflverse-
// stats.js already uses for the identical reason.
//
// Checkpointed: writes progress to tmp/mlb-2025-backfill-checkpoint.json
// after every date. Re-running skips already-completed dates. INSERT OR
// IGNORE makes a re-ingested game a safe no-op on top of that. Date-
// bounded to 2025-01-01..2025-12-31 (off days return an empty schedule,
// recorded as such, not a failure). Rate-conscious: a real delay between
// requests.
//
//   node scripts/backfill-mlb-2025.js

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { fetchSchedule, fetchBoxscore } = require('../lib/mlbProxy');
const { BEATSEDGE_DB_PATH } = require('../lib/dataPaths');

const CHECKPOINT_PATH = path.join(__dirname, '..', 'tmp', 'mlb-2025-backfill-checkpoint.json');
const START_DATE = '2025-01-01';
const END_DATE = '2025-12-31';
const DELAY_MS = 150;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function dateRange(start, end) {
  const out = [];
  let d = new Date(start + 'T00:00:00Z');
  const endD = new Date(end + 'T00:00:00Z');
  while (d <= endD) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

// ---- verbatim copy of lib/mlbEngine.js's parseBoxscore (see header) ----
function parseBoxscore(boxscore, gameDate, gamePk) {
  const batterRows = [];
  const pitcherRows = [];
  const sides = ['home', 'away'];
  const teamAbbrev = {};
  const startingPitcherId = {};
  const startingPitcherName = {};

  sides.forEach(side => {
    teamAbbrev[side] = boxscore.teams[side].team.abbreviation;
    const pitcherIds = boxscore.teams[side].pitchers || [];
    if (pitcherIds.length > 0) {
      const firstId = pitcherIds[0];
      const playerObj = boxscore.teams[side].players[`ID${firstId}`];
      startingPitcherId[side] = String(firstId);
      startingPitcherName[side] = playerObj ? playerObj.person.fullName : null;
    }
  });

  sides.forEach(side => {
    const opponentSide = side === 'home' ? 'away' : 'home';
    const team = teamAbbrev[side];
    const opponent = teamAbbrev[opponentSide];
    const oppStarterId = startingPitcherId[opponentSide] || null;
    const oppStarterName = startingPitcherName[opponentSide] || null;

    const players = (boxscore.teams[side] && boxscore.teams[side].players) || {};
    Object.values(players).forEach(p => {
      if (!p.person) return;
      const batting = p.stats && p.stats.batting;
      const pitching = p.stats && p.stats.pitching;

      if (batting && batting.atBats !== undefined && batting.atBats !== null) {
        batterRows.push({
          game_date: gameDate, game_pk: String(gamePk),
          player_id: String(p.person.id), player_name: p.person.fullName,
          team, opponent,
          opposing_pitcher_id: oppStarterId, opposing_pitcher_name: oppStarterName,
          at_bats: batting.atBats || 0, hits: batting.hits || 0, total_bases: batting.totalBases || 0,
          runs: batting.runs || 0, rbi: batting.rbi || 0, home_runs: batting.homeRuns || 0,
          walks: batting.baseOnBalls || 0, strikeouts: batting.strikeOuts || 0
        });
      }

      if (pitching && pitching.inningsPitched !== undefined && parseFloat(pitching.inningsPitched) > 0) {
        pitcherRows.push({
          game_date: gameDate, game_pk: String(gamePk),
          player_id: String(p.person.id), player_name: p.person.fullName,
          team, opponent,
          innings_pitched: parseFloat(pitching.inningsPitched) || 0,
          strikeouts: pitching.strikeOuts || 0, walks_allowed: pitching.baseOnBalls || 0,
          hits_allowed: pitching.hits || 0, earned_runs: pitching.earnedRuns || 0,
          home_runs_allowed: pitching.homeRuns || 0
        });
      }
    });
  });

  return { batterRows, pitcherRows };
}

const db = new DatabaseSync(BEATSEDGE_DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
const insertBatter = db.prepare(`
  INSERT OR IGNORE INTO mlb_batter_game_stats
    (game_date, game_pk, player_id, player_name, team, opponent, opposing_pitcher_id, opposing_pitcher_name,
     at_bats, hits, total_bases, runs, rbi, home_runs, walks, strikeouts, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'statsapi-backfill-2025')
`);
const insertPitcher = db.prepare(`
  INSERT OR IGNORE INTO mlb_pitcher_game_stats
    (game_date, game_pk, player_id, player_name, team, opponent,
     innings_pitched, strikeouts, walks_allowed, hits_allowed, earned_runs, home_runs_allowed, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'statsapi-backfill-2025')
`);

function insertBoxscore(boxscore, gameDate, gamePk) {
  const { batterRows, pitcherRows } = parseBoxscore(boxscore, gameDate, gamePk);
  db.exec('BEGIN');
  try {
    for (const r of batterRows) insertBatter.run(r.game_date, r.game_pk, r.player_id, r.player_name, r.team, r.opponent, r.opposing_pitcher_id, r.opposing_pitcher_name, r.at_bats, r.hits, r.total_bases, r.runs, r.rbi, r.home_runs, r.walks, r.strikeouts);
    for (const r of pitcherRows) insertPitcher.run(r.game_date, r.game_pk, r.player_id, r.player_name, r.team, r.opponent, r.innings_pitched, r.strikeouts, r.walks_allowed, r.hits_allowed, r.earned_runs, r.home_runs_allowed);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { batterRows: batterRows.length, pitcherRows: pitcherRows.length };
}

function loadCheckpoint() {
  if (fs.existsSync(CHECKPOINT_PATH)) {
    try { return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8')); } catch (e) { /* start fresh */ }
  }
  return { completedDates: {}, totals: { gamesDiscovered: 0, gamesIngested: 0, gamesFailed: 0, batterRows: 0, pitcherRows: 0 }, failedGames: [] };
}
function saveCheckpoint(cp) { fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2)); }

(async () => {
  const cp = loadCheckpoint();
  const dates = dateRange(START_DATE, END_DATE);
  console.log(`2025 MLB backfill: ${dates.length} calendar dates to check, ${Object.keys(cp.completedDates).length} already done`);

  for (let i = 0; i < dates.length; i++) {
    const dateStr = dates[i];
    if (cp.completedDates[dateStr]) continue;
    try {
      const schedule = await fetchSchedule(dateStr);
      const games = (schedule.dates && schedule.dates[0] && schedule.dates[0].games) || [];
      const finalGames = games.filter(g => g.status && g.status.abstractGameState === 'Final');
      cp.totals.gamesDiscovered += finalGames.length;

      for (const game of finalGames) {
        await sleep(DELAY_MS);
        try {
          const boxscore = await fetchBoxscore(game.gamePk);
          const result = insertBoxscore(boxscore, dateStr, game.gamePk);
          cp.totals.gamesIngested++;
          cp.totals.batterRows += result.batterRows;
          cp.totals.pitcherRows += result.pitcherRows;
        } catch (e) {
          cp.totals.gamesFailed++;
          cp.failedGames.push({ date: dateStr, gamePk: game.gamePk, error: e.message });
        }
      }
      cp.completedDates[dateStr] = { games: finalGames.length, processedAt: new Date().toISOString() };
      await sleep(DELAY_MS);
    } catch (e) {
      cp.completedDates[dateStr] = { games: 0, error: e.message, processedAt: new Date().toISOString() };
    }
    saveCheckpoint(cp);
    if (i % 30 === 0) console.log(`  progress: ${dateStr} (${i + 1}/${dates.length}) -- discovered=${cp.totals.gamesDiscovered} ingested=${cp.totals.gamesIngested} failed=${cp.totals.gamesFailed}`);
  }

  console.log('\nBackfill complete:', JSON.stringify(cp.totals, null, 2));
  console.log(`Failed games: ${cp.failedGames.length}`);
  if (cp.failedGames.length) console.log(JSON.stringify(cp.failedGames.slice(0, 10), null, 2));
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
