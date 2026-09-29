// NHL unlock project -- materializes lib/nhlProjectionEngine.js's exact
// validated projections into nhl_player_projections (see
// lib/historicalStore.js's schema comment for the full rationale). Fixes
// /api/nhl/player-projections having to recompute all 5 stat families
// from the full nhl_player_box history on every request (~69s on
// Render's free tier -- confirmed live in production, the real trigger
// for this module).
//
// This module NEVER reimplements the projection formulas -- it only
// calls computeAllProjections() (unmodified) and persists/reads its
// output. Production outputs before and after materialization are
// therefore identical by construction, verified by
// scripts/test-nhl-projection-materializer.js's parity check.

const { computeAllProjections } = require('./nhlProjectionEngine');
const store = require('./historicalStore');

const MODEL_VERSION = 'nhl-v1-shrinkage5-poisson';

const UPSERT_SQL = `
  INSERT INTO nhl_player_projections
    (player_id, stat_family, player_name, team, projection, probability, games_sampled, rest_adjusted, model_version, latest_game_date, calculated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(player_id, stat_family) DO UPDATE SET
    player_name = excluded.player_name, team = excluded.team,
    projection = excluded.projection, probability = excluded.probability,
    games_sampled = excluded.games_sampled, rest_adjusted = excluded.rest_adjusted,
    model_version = excluded.model_version, latest_game_date = excluded.latest_game_date,
    calculated_at = excluded.calculated_at
`;

function rowsFromProjections(projections) {
  const rows = [];
  for (const [statFamily, familyRows] of Object.entries(projections)) {
    for (const r of familyRows) {
      rows.push([
        r.playerId, statFamily, r.playerName || null, r.team || null,
        r.projection ?? null, r.probability ?? null, r.gamesSampled ?? null,
        r.restAdjusted ? 1 : 0, MODEL_VERSION, r.latestGameDate ?? null,
      ]);
    }
  }
  return rows;
}

// Idempotent, safe to rerun: same (player_id, stat_family) PRIMARY KEY
// UPSERTs in place -- never duplicates, never appends. A failure here
// (thrown before any batch completes, or mid-batch) never deletes or
// blanks the previously materialized rows -- UPSERT only ever replaces a
// row with a freshly computed one, it has no DELETE step, so the prior
// valid snapshot for any row this run didn't reach stays exactly as it
// was. Callers (cron, the one-time backfill script) are responsible for
// logging/isolating failures from whatever ELSE they're doing.
async function materializeNhlProjections() {
  const projections = await computeAllProjections();
  const rows = rowsFromProjections(projections);
  if (rows.length) await store.batchInsert(UPSERT_SQL, rows);
  return { rowsWritten: rows.length, families: Object.keys(projections) };
}

async function getMaterializedProjections() {
  const rows = await store.query(`
    SELECT player_id, stat_family, player_name, team, projection, probability, games_sampled, rest_adjusted, model_version, latest_game_date, calculated_at
    FROM nhl_player_projections
  `);
  const out = {};
  for (const r of rows) {
    if (!out[r.stat_family]) out[r.stat_family] = [];
    out[r.stat_family].push({
      playerId: r.player_id, playerName: r.player_name, team: r.team,
      projection: r.projection, probability: r.probability,
      gamesSampled: r.games_sampled, restAdjusted: !!r.rest_adjusted,
    });
  }
  return out;
}

module.exports = { materializeNhlProjections, getMaterializedProjections, rowsFromProjections, MODEL_VERSION };
