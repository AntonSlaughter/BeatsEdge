// Canonical fingerprint of the frozen NCAAF BETA specification: sha256 of the key-sorted JSON of { version, featureSet, config: NCAAF_GRADE_CONFIG, meta: ncaafModelMeta(), unsupportedStats, thresholds }.
// Same method as the NBA / WNBA / NFL / MLB freezes. Any change to a spec value changes the hash => it must be a NEW model version (docs/NCAAF_MODEL_FREEZE_BETA_2026-10-07.md).
// `thresholds` pins the built-in grade cut-offs and the A >= 6 season-game guard as they are written in the engine source (they are defaults, not config values), so a silent edit of either is detected too.
const crypto = require('crypto'), fs = require('fs');
const canon = (v) => Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
function ncaafSpecFingerprint(m, htmlPath) {
  const meta = m.ncaafModelMeta(); const html = fs.readFileSync(htmlPath || require('./loadNcaafModel').HTML_PATH, 'utf8').replace(/\r/g, '');
  const grab = (re) => { const x = html.match(re); return x ? x[0] : null; };
  const thresholds = { A: grab(/else if \(gradeScore >= 0\.86 && confidence >= 80\) grade = 'A';/), B: grab(/else if \(gradeScore >= 0\.68 && confidence >= 50\) grade = 'B';/), C: grab(/else if \(gradeScore >= 0\.46\) grade = 'C';/),
    aGuard: grab(/if \(sport === 'ncaaf' && grade === 'A' && \(s\.season && s\.season\.games \|\| 0\) < 6\) grade = 'B';/), gapRuleLine: grab(/sport === 'ncaaf' \? NCAAF_GRADE_CONFIG\.wildGapRule : _gapRuleEff;/), gapCallSite: grab(/wildGapExceeds\(_gapRuleFinal, /), nflOnlyClause: grab(/\|\| \(sport === 'nfl' && sampleGames < 6 && edgeRatio > 0\.30\)/), priorGuard: grab(/else if \(sport !== 'ncaaf' && typeof prop\.hitRate === 'number'/) };
  const spec = canon({ version: meta.modelVersion, featureSet: meta.featureSet, config: m.NCAAF_GRADE_CONFIG, meta, unsupportedStats: m.NCAAF_UNSUPPORTED_STATS, thresholds });
  return { sha256: crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex'), spec };
}
module.exports = { ncaafSpecFingerprint };
if (require.main === module) { const { loadNcaafModel } = require('./loadNcaafModel'); const r = ncaafSpecFingerprint(loadNcaafModel()); console.log(r.sha256); console.log(JSON.stringify(r.spec, null, 1)); }
