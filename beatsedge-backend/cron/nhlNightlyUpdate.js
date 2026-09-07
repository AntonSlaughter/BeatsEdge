// Same pattern as MLB: no bulk historical dataset found for NHL in this
// pass, so this starts empty and grows one night at a time via
// api-web.nhle.com's real, free, keyless schedule + boxscore endpoints.

const { fetchSchedule, fetchBoxscore } = require('../lib/nhlProxy');
const { insertBoxscore, recomputeDefenseByPosition, recomputeTeamShootingRollup } = require('../lib/nhlEngine');
const db = require('../lib/nhlDb');

async function runNhlNightlyUpdate() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10);

  console.log(`[nhl-nightly] Starting update for ${dateStr}...`);
  let totalSkaterRows = 0, totalGoalieRows = 0, gamesProcessed = 0;

  try {
    const schedule = await fetchSchedule(dateStr);
    const games = (schedule.gameWeek && schedule.gameWeek[0] && schedule.gameWeek[0].games) || [];
    console.log(`[nhl-nightly] Found ${games.length} games for ${dateStr}`);

    for (const game of games) {
      if (game.gameState && game.gameState !== 'OFF' && game.gameState !== 'FINAL') continue; // skip not-yet-final
      try {
        const boxscore = await fetchBoxscore(game.id);
        const { skaterRows, goalieRows } = insertBoxscore(boxscore, dateStr, game.id);
        totalSkaterRows += skaterRows;
        totalGoalieRows += goalieRows;
        gamesProcessed++;
      } catch (err) {
        console.warn(`[nhl-nightly] Failed game ${game.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[nhl-nightly] Schedule fetch failed (will retry next run):', err.message);
  }

  console.log(`[nhl-nightly] Processed ${gamesProcessed} games: ${totalSkaterRows} skater rows, ${totalGoalieRows} goalie rows`);

  console.log('[nhl-nightly] Recomputing defense-by-position and team shooting rollups...');
  const posSummary = recomputeDefenseByPosition();
  const teamsUpdated = recomputeTeamShootingRollup();
  console.log('[nhl-nightly] Position rollup summary:', posSummary, '| Teams updated:', teamsUpdated);

  db.prepare(`INSERT INTO ingest_log (run_type, rows_added, notes) VALUES ('nightly', ?, ?)`)
    .run(totalSkaterRows + totalGoalieRows, `NHL: ${gamesProcessed} games, date=${dateStr}`);

  console.log('[nhl-nightly] Done.');
}

module.exports = { runNhlNightlyUpdate };
