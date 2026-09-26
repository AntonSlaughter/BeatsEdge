// BeatsEdge Market Archive Hardening -- pregame/live/final classifier
// (Gap 4/9). Pure, read-only. Never deletes or hides any row -- callers
// must always classify explicitly rather than filtering rows out
// silently, so live/final rows remain available for future Live State
// research per the explicit instruction not to discard them.

const LIVE_STATUS_VALUES = new Set(['live', 'in_progress', 'inprogress', 'started']);
const FINAL_STATUS_VALUES = new Set(['final', 'completed', 'complete', 'closed', 'ended']);

/**
 * @param {object} row an archive row with at least captured_at, commence_time, game_status
 * @returns {{ classification: 'PREGAME'|'LIVE'|'FINAL'|'UNKNOWN', method: string }}
 */
function classifyTiming(row) {
  const status = (row.game_status || '').toLowerCase().trim();
  if (status) {
    if (FINAL_STATUS_VALUES.has(status)) return { classification: 'FINAL', method: 'provider-game-status' };
    if (LIVE_STATUS_VALUES.has(status)) return { classification: 'LIVE', method: 'provider-game-status' };
    // An unrecognized-but-present status is preserved as-is for future
    // review rather than silently forced into PREGAME/LIVE/FINAL.
  }
  const commenceMs = row.commence_time ? Date.parse(row.commence_time) : NaN;
  const capturedMs = Number(row.captured_at);
  if (Number.isFinite(commenceMs) && Number.isFinite(capturedMs)) {
    return capturedMs < commenceMs
      ? { classification: 'PREGAME', method: 'captured_at-lt-commence_time' }
      : { classification: 'LIVE', method: 'captured_at-gte-commence_time (status unconfirmed, time-based only)' };
  }
  return { classification: 'UNKNOWN', method: status ? `unrecognized game_status "${status}", no usable commence_time` : 'no game_status and no usable commence_time' };
}

module.exports = { classifyTiming, LIVE_STATUS_VALUES, FINAL_STATUS_VALUES };
