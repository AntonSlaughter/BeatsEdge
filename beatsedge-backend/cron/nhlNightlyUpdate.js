// Same pattern as MLB: no bulk historical dataset found for NHL in this
// pass, so this starts empty and grows one night at a time via
// api-web.nhle.com's real, free, keyless schedule + boxscore endpoints.

const { fetchSchedule, fetchBoxscore } = require('../lib/nhlProxy');
const { insertBoxscoreAsync, recomputeDefenseByPositionBulk, recomputeTeamShootingRollupBulk } = require('../lib/nhlEngine');
// NHL unlock project -- keeps lib/nhlProjectionEngine.js's validated
// model history (nhl_player_box) current automatically. Purely additive:
// reuses this same already-fetched real boxscore, writes to a DIFFERENT
// table (nhl_player_box, not nhl_skater_game_stats/nhl_goalie_game_stats
// above), wrapped in its own try/catch below so a failure here can never
// affect the existing DvP/shooting-rollup update this file already does.
const { syncBoxscoreToPlayerBox } = require('../lib/nhlPlayerBoxSync');
// NHL unlock project -- refreshes the materialized projection table
// (fixes /api/nhl/player-projections' real production timeout, see
// lib/nhlProjectionMaterializer.js's header) after historical sync. Its
// own try/catch below: a refresh failure must never corrupt the
// previously materialized snapshot (UPSERT has no DELETE step, so a
// thrown error simply leaves whatever rows it already reached updated
// and the rest untouched) and must never affect the ingestion above.
const { materializeNhlProjections } = require('../lib/nhlProjectionMaterializer');
const store = require('../lib/historicalStore');

async function runNhlNightlyUpdate() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10);

  console.log(`[nhl-nightly] Starting update for ${dateStr}...`);
  let totalSkaterRows = 0, totalGoalieRows = 0, gamesProcessed = 0;
  let modelSkaterRows = 0, modelGoalieRows = 0, modelSyncFailures = 0;

  try {
    const schedule = await fetchSchedule(dateStr);
    const games = (schedule.gameWeek && schedule.gameWeek[0] && schedule.gameWeek[0].games) || [];
    console.log(`[nhl-nightly] Found ${games.length} games for ${dateStr}`);

    for (const game of games) {
      if (game.gameState && game.gameState !== 'OFF' && game.gameState !== 'FINAL') continue; // skip not-yet-final
      try {
        const boxscore = await fetchBoxscore(game.id);
        const { skaterRows, goalieRows } = await insertBoxscoreAsync(boxscore, dateStr, game.id);
        totalSkaterRows += skaterRows;
        totalGoalieRows += goalieRows;
        gamesProcessed++;
        // Own try/catch: a failure syncing the model's history table must
        // never affect the DvP/shooting-rollup update above, which is
        // already real and live.
        try {
          const modelSync = await syncBoxscoreToPlayerBox(boxscore, dateStr, game.id);
          modelSkaterRows += modelSync.skaterRows;
          modelGoalieRows += modelSync.goalieRows;
        } catch (syncErr) {
          modelSyncFailures++;
          console.warn(`[nhl-nightly] Model-history sync failed for game ${game.id} (existing history untouched):`, syncErr.message);
        }
      } catch (err) {
        console.warn(`[nhl-nightly] Failed game ${game.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[nhl-nightly] Schedule fetch failed (will retry next run):', err.message);
  }

  console.log(`[nhl-nightly] Model history (nhl_player_box) sync: ${modelSkaterRows} skater rows, ${modelGoalieRows} goalie rows, ${modelSyncFailures} game(s) failed to sync.`);

  try {
    const materialized = await materializeNhlProjections();
    console.log(`[nhl-nightly] Projection materialization (model ${materialized.modelVersion}): ${materialized.rowsWritten} rows across families: ${materialized.families.join(', ')}; ${materialized.teamContextRows} team opponent-context rows.`);
  } catch (matErr) {
    console.error('[nhl-nightly] Projection materialization FAILED (previous materialized snapshot left untouched):', matErr.message);
  }

  console.log(`[nhl-nightly] Processed ${gamesProcessed} games: ${totalSkaterRows} skater rows, ${totalGoalieRows} goalie rows`);

  console.log('[nhl-nightly] Recomputing defense-by-position and team shooting rollups (bulk, historicalStore-backed)...');
  const posSummary = await recomputeDefenseByPositionBulk();
  const teamsUpdated = await recomputeTeamShootingRollupBulk();
  console.log('[nhl-nightly] Position rollup summary:', posSummary, '| Teams updated:', teamsUpdated);

  await store.run(`INSERT INTO ingest_log (run_type, rows_added, notes) VALUES ('nightly', ?, ?)`, [totalSkaterRows + totalGoalieRows, `NHL: ${gamesProcessed} games, date=${dateStr}`]);

  console.log('[nhl-nightly] Done.');
}

module.exports = { runNhlNightlyUpdate };
