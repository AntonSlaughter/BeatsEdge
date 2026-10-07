// Canonical fingerprint of the frozen NFL BETA specification: sha256 of the key-sorted JSON of { version, featureSet, config: NFL_GRADE_CONFIG, meta: nflModelMeta() }.
// Same method as the NBA / WNBA freezes. Any change to a spec value changes the hash => it must be a NEW model version (docs/NFL_MODEL_FREEZE_BETA_2026-10-06.md).
const crypto = require('crypto');
const canon = (v) => Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
function nflSpecFingerprint(m) { const meta = m.nflModelMeta(); const spec = canon({ version: meta.modelVersion, featureSet: meta.featureSet, config: m.NFL_GRADE_CONFIG, meta }); return { sha256: crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex'), spec }; }
module.exports = { nflSpecFingerprint };
if (require.main === module) { const { loadNflModel } = require('./loadNflModel'); const r = nflSpecFingerprint(loadNflModel()); console.log(r.sha256); console.log(JSON.stringify(r.spec, null, 1)); }
