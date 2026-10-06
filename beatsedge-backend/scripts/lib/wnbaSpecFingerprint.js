// Canonical fingerprint of the frozen WNBA BETA specification: sha256 of the key-sorted JSON of
// { version, featureSet, config: WNBA_GRADE_CONFIG, meta: wnbaModelMeta() }.  Same method as the NBA freeze document.
// Any change to a spec value changes the hash => it must be a NEW model version (docs/WNBA_MODEL_FREEZE_BETA_2026-10-06.md).
const crypto = require('crypto');
const canon = (v) => Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
function wnbaSpecFingerprint(m) {
  const meta = m.wnbaModelMeta();
  const spec = canon({ version: meta.modelVersion, featureSet: meta.featureSet, config: m.WNBA_GRADE_CONFIG, meta });
  return { sha256: crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex'), spec };
}
module.exports = { wnbaSpecFingerprint };
if (require.main === module) { const { loadModel } = require('./loadBeatsEdgeModel'); const r = wnbaSpecFingerprint(loadModel()); console.log(r.sha256); console.log(JSON.stringify(r.spec, null, 1)); }
