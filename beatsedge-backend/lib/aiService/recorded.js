'use strict';
// Recorded settled results for plays of the same sport / stat / grade, from BeatsEdge's own prop_snapshots table (the page pushes graded snapshots; cron/settleSnapshots.js settles them).
//
// MODEL-VERSION ATTRIBUTION (hard rule): the table has NO version column. `model_variant` is an experiment tag (always 'A' today), not a model version. The only version evidence is the
// client-captured trace the page stores inside the `data_quality` JSON (`modelMeta.modelVersion`), which exists only on snapshots written after versioning was added. Snapshots from other
// or untagged versions can NOT be attributed to the current frozen model, so they are COUNTED but never enter a rate. A rate is stated only when: the selection reports its model version,
// at least MIN_N settled snapshots carry EXACTLY that version tag, and the figure is labeled as recorded, client-tagged, not a validation and not live results.
// `query` is injected (async (sql, params) -> rows) so this module stays pure; any failure returns { available:false } and nothing is guessed.
const MIN_N = 30;
const SQL = `SELECT CASE WHEN json_valid(data_quality) AND json_extract(data_quality, '$.modelMeta.modelVersion') = ? THEN 'same'
                  WHEN json_valid(data_quality) AND json_extract(data_quality, '$.modelMeta.modelVersion') IS NOT NULL THEN 'other' ELSE 'untagged' END AS ver,
             dir, result, COUNT(*) AS n
       FROM prop_snapshots WHERE sport = ? AND stat = ? AND grade = ? AND model_variant = 'A' AND result IN ('over','under') GROUP BY ver, dir, result`;
async function recordedPerformance(query, sel) {
  if (typeof query !== 'function') return { available: false, reason: 'No recorded-results store is connected.' };
  if (!sel || !sel.sport || !sel.statKey || !sel.grade) return { available: false, reason: 'Only graded plays have recorded results (no grade on this play).' };
  const version = typeof sel.modelVersion === 'string' && sel.modelVersion.trim() ? sel.modelVersion.trim().slice(0, 80) : null;
  let rows; try { rows = await query(SQL, [version || '', sel.sport, sel.statKey, sel.grade]); } catch (e) { return { available: false, reason: 'The recorded-results store could not be read.' }; }
  const t = { same: { n: 0, hits: 0 }, other: { n: 0, hits: 0 }, untagged: { n: 0, hits: 0 } };
  (rows || []).forEach(r => { const b = t[r.ver]; if (!b) return; const c = Number(r.n) || 0; b.n += c; if (r.dir === r.result) b.hits += c; });
  const excluded = t.other.n + t.untagged.n;
  const out = { available: true, modelVersion: version, attributedToCurrentVersion: !!version, sameVersion: { n: t.same.n, hits: t.same.hits }, excluded: { otherVersionOrUntagged: excluded, otherVersion: t.other.n, untagged: t.untagged.n }, minN: MIN_N, rate: null, enough: false,
    note: 'Recorded snapshot results are client-captured and tagged with a client-reported model version. They are not a validation of the model, not live customer results and not a promise.' };
  if (!version) { out.suppressed = 'NO_MODEL_VERSION'; out.reason = 'The selection reports no model version, so settled snapshots cannot be attributed to the current model. No rate is stated.'; return out; }
  if (t.same.n < MIN_N) { out.suppressed = 'TOO_FEW_SAME_VERSION'; out.reason = t.same.n ? `Only ${t.same.n} settled snapshot(s) carry this model version tag (minimum ${MIN_N}); no rate is stated.` : 'No settled snapshot carries this model version tag; older snapshots span other or untagged versions and are excluded. No rate is stated.'; return out; }
  out.enough = true; out.rate = Math.round((t.same.hits / t.same.n) * 1000) / 10; return out;
}
module.exports = { recordedPerformance, MIN_N, SQL };
