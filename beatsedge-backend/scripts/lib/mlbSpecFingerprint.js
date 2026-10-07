// Canonical fingerprint of the frozen MLB BETA specification: sha256 of the key-sorted JSON of { version, featureSet, config: MLB_GRADE_CONFIG, meta: mlbModelMeta(), rareRecipe, rankingPolicy }.
// Same method as the NBA / WNBA / NFL freezes, with the MLB rare-event recipe constants and the rare-event grade policy added to the canonical spec. Any change to a spec value changes the hash
// => it must be a NEW model version (docs/MLB_MODEL_FREEZE_BETA_2026-10-07.md).
const crypto = require('crypto');
const canon = (v) => Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
function mlbSpecFingerprint(m) {
  const meta = m.mlbModelMeta();
  const spec = canon({ version: meta.modelVersion, featureSet: meta.featureSet, config: m.MLB_GRADE_CONFIG, meta,
    rareRecipe: { priors: m.MLB_LOWLINE_RARE, distModel: 'poisson', bypassCurve: true, rawFloor: 0.03, rawCeil: 0.97, shrink: 'min(0.80, 0.45 + min(games, 40) / 40 * 0.35)', anchor: 'frozen league rate (Over) / 1 - rate (Under)', scope: "sport === 'mlb' && line < 1.0 && stat in priors" } });
  return { sha256: crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex'), spec };
}
module.exports = { mlbSpecFingerprint };
if (require.main === module) { const { loadMlbModel } = require('./loadMlbModel'); const r = mlbSpecFingerprint(loadMlbModel()); console.log(r.sha256); console.log(JSON.stringify(r.spec, null, 1)); }
