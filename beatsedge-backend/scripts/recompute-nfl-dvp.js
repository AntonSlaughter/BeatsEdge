// Recomputes nfl_defense_by_position + nfl_defense_interceptions from the
// raw nfl_player_game_stats / nfl_team_defense_game tables.
//
//   node scripts/recompute-nfl-dvp.js
//
// Run this after scripts/ingest-nflverse-stats.js (nightly cron runs both,
// in this order).
//
// 2026-09-28 historical-persistence cutover: repointed from the old sync
// recomputeNflDefenseByPosition (lib/nflDvpEngine.js, ~640 individual
// queries per run against a raw db handle) to the proven bulk replacement
// (lib/historicalQueries.js's computeNflDefenseByPositionBulk, 3 reads + 1
// write transaction via lib/historicalStore.js -- Turso-capable). Verified
// byte-identical output against the old implementation on real data
// (scripts/test-bulk-nfl-dvp-parity.js, 640/640 rows match exactly) before
// this cutover. historicalStore's own SQLite backend already uses
// node:sqlite internally for exactly the write-crash reason this script's
// old header explained, so that safety property is preserved.
const { computeNflDefenseByPositionBulk } = require('../lib/historicalQueries');

(async () => {
  const summary = await computeNflDefenseByPositionBulk();
  console.log('NFL DvP recompute:', JSON.stringify(summary));
  process.exit(0);
})().catch(e => { console.error('NFL DvP recompute FAILED:', e); process.exit(1); });
