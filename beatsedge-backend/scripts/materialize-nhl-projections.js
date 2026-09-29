// NHL unlock project -- one-time (and repeatable) materialization of
// lib/nhlProjectionEngine.js's validated projections into
// nhl_player_projections. Safe to rerun (UPSERT, idempotent). Run this
// once against production immediately after deploying the materialized-
// projection fix, so /api/nhl/player-projections is usable right away
// rather than waiting for the next nightly cron cycle.
//
//   node --env-file=.env scripts/materialize-nhl-projections.js

const { materializeNhlProjections } = require('../lib/nhlProjectionMaterializer');
const store = require('../lib/historicalStore');

(async () => {
  console.log('backend:', store.backend);
  const start = Date.now();
  const result = await materializeNhlProjections();
  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Materialized ${result.rowsWritten} rows across families [${result.families.join(', ')}] in ${seconds}s.`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
