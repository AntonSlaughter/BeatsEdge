// BeatsEdge Market Archive Hardening -- DERIVED primary/anchor-line
// resolver. Pure, read-only function over already-archived rows; never
// mutates, deletes, or collapses any raw row. Solves Gap 1 from the
// Market Intelligence audit: some sportsbooks publish an entire alt-line
// ladder simultaneously under the SAME raw identity (sport, event_id,
// player_raw, market_key_raw, source, projection_type, period, side) --
// naively reading that identity's rows in captured_at order and treating
// consecutive lines as "movement" is wrong; they are simultaneous
// alternates, not a time series.
//
// METHOD (validated against real archived WNBA rows before being
// written, not assumed):
//   - DFS (source_type='dfs'): projection_type is already the
//     authoritative, source-supplied signal. STANDARD is the primary
//     projection; DEMON/GOBLIN are always alternates, never collapsed
//     into or confused with STANDARD. If more than one row shares the
//     SAME (timestamp-cluster, projection_type) -- e.g. multiple
//     simultaneous DEMON lines observed for one player/market -- there is
//     no further source-supplied signal to pick one, so the result is
//     AMBIGUOUS rather than guessed (never inferred from line magnitude).
//   - Sportsbook (source_type='sportsbook'): among rows in the same
//     timestamp cluster, the row with BOTH over_price AND under_price
//     populated is the two-sided "main line" a book actually takes
//     balanced action on; alt-ladder rows are consistently one-sided
//     (over_price only) in every real example inspected during the
//     audit (verified against bovada/draftkings WNBA rows, not assumed).
//     Exactly one two-sided row -> confident primary. Zero or multiple
//     two-sided rows -> AMBIGUOUS, with the reason stated.
//   - Any other source_type, or missing data -> AMBIGUOUS.

function isTwoSided(row) { return row.over_price != null && row.under_price != null; }

/**
 * @param {object[]} rows Archive rows that share the SAME raw identity
 *   (sport, event_id, player_raw, market_key_raw, source, projection_type,
 *   period, side) and the SAME captured_at (a single timestamp cluster --
 *   caller is responsible for grouping by captured_at first; this
 *   function does not do time-bucketing itself).
 * @returns {{ primary: object|null, alternates: object[], method: string, confidence: 'high'|'ambiguous', reason: string|null }}
 */
function resolvePrimaryLine(rows) {
  if (!rows || !rows.length) return { primary: null, alternates: [], method: 'none', confidence: 'ambiguous', reason: 'no rows supplied' };
  if (rows.length === 1) {
    return { primary: rows[0], alternates: [], method: 'sole-row', confidence: 'high', reason: null };
  }

  const sourceType = rows[0].source_type;

  if (sourceType === 'dfs') {
    const standardRows = rows.filter(r => (r.projection_type || '').toUpperCase() === 'STANDARD');
    if (standardRows.length === 1) {
      return { primary: standardRows[0], alternates: rows.filter(r => r !== standardRows[0]), method: 'dfs-standard-projection-type', confidence: 'high', reason: null };
    }
    // No STANDARD row, or multiple simultaneous rows share one non-STANDARD
    // projection_type (e.g. several DEMON lines at once) -- no reliable
    // source-supplied signal exists to pick one; never guess from line size.
    return { primary: null, alternates: rows, method: 'dfs-no-standard-or-ambiguous', confidence: 'ambiguous', reason: standardRows.length > 1 ? `${standardRows.length} simultaneous STANDARD rows (unexpected)` : 'no STANDARD row in this cluster, and no other source-supplied primary signal exists' };
  }

  if (sourceType === 'sportsbook') {
    const twoSided = rows.filter(isTwoSided);
    if (twoSided.length === 1) {
      return { primary: twoSided[0], alternates: rows.filter(r => r !== twoSided[0]), method: 'sportsbook-two-sided-line', confidence: 'high', reason: null };
    }
    return { primary: null, alternates: rows, method: 'sportsbook-two-sided-ambiguous', confidence: 'ambiguous', reason: twoSided.length === 0 ? 'no two-sided (over+under) row found in this cluster' : `${twoSided.length} two-sided rows found -- cannot pick one without guessing` };
  }

  return { primary: null, alternates: rows, method: 'unknown-source-type', confidence: 'ambiguous', reason: `unrecognized source_type "${sourceType}"` };
}

/**
 * Groups archive rows for ONE raw identity into timestamp clusters (rows
 * sharing the identical captured_at value -- BeatsEdge's own archiving
 * writes one captured_at per refresh batch, so exact equality is the
 * correct grouping key, not a time-window heuristic), then resolves the
 * primary line within each cluster and reports whether the primary moved
 * from one cluster to the next.
 *
 * @param {object[]} rowsForIdentity all rows for one raw identity, any order
 * @returns {{ clusters: Array<{ capturedAt:number, resolution: object }>, movements: Array<{ from, to, kind: 'UNCHANGED_PRIMARY'|'PRIMARY_MOVED'|'LADDER_CHANGED_PRIMARY_SAME'|'PRICE_MOVED_SAME_LINE'|'AMBIGUOUS' }> }}
 */
function reconstructPrimaryTimeline(rowsForIdentity) {
  const byTs = new Map();
  for (const r of rowsForIdentity) { const k = String(r.captured_at); if (!byTs.has(k)) byTs.set(k, []); byTs.get(k).push(r); }
  const clusters = [...byTs.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([capturedAt, rows]) => ({ capturedAt: Number(capturedAt), rows, resolution: resolvePrimaryLine(rows) }));

  const movements = [];
  for (let i = 1; i < clusters.length; i++) {
    const prev = clusters[i - 1], cur = clusters[i];
    const prevP = prev.resolution.primary, curP = cur.resolution.primary;
    let kind;
    if (!prevP || !curP) {
      kind = 'AMBIGUOUS';
    } else if (prevP.line !== curP.line) {
      kind = 'PRIMARY_MOVED';
    } else if (prevP.over_price !== curP.over_price || prevP.under_price !== curP.under_price) {
      kind = 'PRICE_MOVED_SAME_LINE';
    } else {
      const prevLadderSize = prev.rows.length, curLadderSize = cur.rows.length;
      kind = prevLadderSize !== curLadderSize ? 'LADDER_CHANGED_PRIMARY_SAME' : 'UNCHANGED_PRIMARY';
    }
    movements.push({ fromCapturedAt: prev.capturedAt, toCapturedAt: cur.capturedAt, kind, fromPrimaryLine: prevP ? prevP.line : null, toPrimaryLine: curP ? curP.line : null });
  }
  return { clusters, movements };
}

module.exports = { resolvePrimaryLine, reconstructPrimaryTimeline };
