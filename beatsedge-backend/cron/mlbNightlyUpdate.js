// Pulls yesterday's completed MLB games and ingests real box scores. No
// historical bulk seed exists for MLB in this pass (unlike NBA's Kaggle
// files or NFL's nflverse) — this pipeline starts empty and grows for real,
// one night at a time, via statsapi.mlb.com (free, keyless, open CORS).
// See beatsedge-backend/README.md for what a faster historical backfill
// would need (Retrosheet or a similar bulk source, not yet wired up here).

const { fetchSchedule, fetchBoxscore } = require('../lib/mlbProxy');
const { insertBoxscoreAsync, recomputePitcherRollupsBulk, recomputeTeamBattingRollupsBulk } = require('../lib/mlbEngine');
const store = require('../lib/historicalStore');

async function runMlbNightlyUpdate() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10);

  console.log(`[mlb-nightly] Starting update for ${dateStr}...`);

  let totalBatterRows = 0, totalPitcherRows = 0, gamesProcessed = 0;

  try {
    const schedule = await fetchSchedule(dateStr);
    const games = (schedule.dates && schedule.dates[0] && schedule.dates[0].games) || [];
    console.log(`[mlb-nightly] Found ${games.length} games for ${dateStr}`);

    for (const game of games) {
      if (game.status && game.status.abstractGameState !== 'Final') continue; // skip postponed/in-progress
      try {
        const boxscore = await fetchBoxscore(game.gamePk);
        const { batterRows, pitcherRows } = await insertBoxscoreAsync(boxscore, dateStr, game.gamePk);
        totalBatterRows += batterRows;
        totalPitcherRows += pitcherRows;
        gamesProcessed++;
      } catch (err) {
        console.warn(`[mlb-nightly] Failed game ${game.gamePk}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[mlb-nightly] Schedule fetch failed (will retry next run):', err.message);
  }

  console.log(`[mlb-nightly] Processed ${gamesProcessed} games: ${totalBatterRows} batter rows, ${totalPitcherRows} pitcher rows`);

  console.log('[mlb-nightly] Recomputing pitcher and team batting rollups (bulk, historicalStore-backed)...');
  const pitchersUpdated = await recomputePitcherRollupsBulk();
  const teamsUpdated = await recomputeTeamBattingRollupsBulk();
  console.log(`[mlb-nightly] Rollups: ${pitchersUpdated} pitcher entries, ${teamsUpdated} teams`);

  await store.run(`INSERT INTO ingest_log (run_type, rows_added, notes) VALUES ('nightly', ?, ?)`, [totalBatterRows + totalPitcherRows, `MLB: ${gamesProcessed} games, date=${dateStr}`]);

  console.log('[mlb-nightly] Done.');
}

module.exports = { runMlbNightlyUpdate };
