// Test/diagnostic helper: evaluates the PURE top-level region of BeatsEdge.html (grade engine, pick finders, NCAAF config/gates) PLUS the LIVE football input builders that NCAAF shares with NFL
// (NFL_PROP_DEFS, nflParseGamelog, nflComputeWindows, nflSeedWindows, nflBuildProps + provider-only / period helpers) AND the authoritative NCAAF scorer block (cfbParseGamelog, cfbWindowsFor,
// cfbBuildProps, cfbRefreshProps, ncaafBacktestInputs, ncaafBacktestSeries) -- all extracted VERBATIM from BeatsEdge.html and run in a Node `vm`. Nothing here modifies BeatsEdge.html.
const fs = require('fs'), path = require('path'), vm = require('vm'); const { readRegion, sliceArrowFn, HTML_PATH } = require('./loadBeatsEdgeModel'); const { nflSnippet } = require('./loadNflModel');
const EXPORT_NAMES = ['calculateEdgeScore', '_calculateEdgeScoreImpl', 'playerBestGrade', 'findTopPicks', 'findPrimePicks', 'findPlusEVPicks', 'findResearchPicks', 'sortPropsByEdge', 'applyHistoryGate', 'hasRealModelHistory', 'insufficientDataEdge', 'notYetModeledEdge',
  'smartParlayHitRate', 'smartParlayEligibility', 'MODEL_STATE_INSUFFICIENT', 'MODEL_STATE_NOT_YET_MODELED', 'btWindowsAsOf', 'backtestSeries', 'emptyBacktestAcc', 'resolveFinalGrade', 'wildGapExceeds', 'projStdDev', 'applyProbCalib', 'deriveProbCalib', 'btFileProb', 'bumpEdgeCache',
  'NFL_LOWLINE_RARE', 'NFL_STAT_FAMILY', 'STAT_TO_ALLOWED_KEY_BY_SPORT', 'NFL_PROP_DEFS', 'nflPosKeys', 'NFL_WINDOW_OPTS', 'nflHasFor', 'nflComputeWindows', 'nflParseGamelog', 'normalCdf', 'MODEL_MIN_REAL_GAMES', 'nflSubOneLineUnsupported', 'isModelSupportedProp', 'isModelEligibleProp',
  'isModelEligibleEdge', 'DFS_PLATFORMS', 'ALL_BOOKS', 'PARLAY_FB_MKT', 'nflSeedWindows', 'nflBuildProps', 'buildProviderOnlyProps', 'estHitRate', 'GRADE_RANK', 'SMART_PARLAY_MIN_HIT_RATE',
  'NCAAF_MODEL_VERSION', 'NCAAF_FEATURE_SET', 'NCAAF_GRADE_CONFIG', 'ncaafModelMeta', 'NCAAF_UNSUPPORTED_STATS', 'ncaafUnsupportedStat', 'ncaafSubOneLineUnsupported', 'applyNcaafModelGates', 'ncaafRefreshModelFlags',
  'MODEL_STATE_PROBABILITY_ONLY', 'ncaafCountEventWithheldStat', 'ncaafProbabilityOnlyStat', 'isRankingEligibleEdge', 'wildGapExceeds',
  'cfbParseGamelog', 'cfbWindowsFor', 'cfbBuildProps', 'cfbRefreshProps', 'cfbDedupeRows', 'ncaafBacktestInputs', 'ncaafBacktestSeries', 'CFB_HISTORY_SEASONS'];
const idx = (html, a) => { const i = html.indexOf(a); if (i < 0) throw new Error('anchor not found: ' + a); return i; }; const lineAt = (html, a) => { const i = idx(html, a); return html.slice(i, html.indexOf('\n', i)); };
function ncaafSnippet(html) {
  const parts = [lineAt(html, 'const roundHalf = '), lineAt(html, 'const estHitRate = '), sliceArrowFn(html, 'const nflSeedWindows = (perGame, line) => {'), html.slice(idx(html, 'const CONSENSUS_ORDER = ['), idx(html, '// Build the prop list for ONE book.')),
    sliceArrowFn(html, 'const humanizeMarketKey = (key) => {'), sliceArrowFn(html, 'const buildProviderOnlyProps = (allLines, knownKeys, book) => {'), sliceArrowFn(html, 'const nflBuildProps = (posKeys, statsByKey, allLines, book, perGameFor) => {')];
  const a = idx(html, '// <<NCAAF-SHARED-BEGIN>>'), b = idx(html, '// <<NCAAF-SHARED-END>>'); return nflSnippet(html) + '\nconst NFL_SEASON = 2026;\n' + parts.join('\n') + '\n' + html.slice(a, b);
}
function makeStorage(seed) { const m = new Map(Object.entries(seed || {}).map(([k, v]) => [k, String(v)])); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear() }; }
// opts: { htmlPath, localStorageSeed, transform(regionSrc), sandboxExtras }
function loadNcaafModel(opts) {
  opts = opts || {}; const htmlPath = opts.htmlPath || HTML_PATH; const html = fs.readFileSync(htmlPath, 'utf8'); let src = readRegion(htmlPath); if (typeof opts.transform === 'function') src = opts.transform(src); src += '\n' + ncaafSnippet(html);
  const body = `${src}\n;return { ${EXPORT_NAMES.map(n => `${n}: (typeof ${n} === 'undefined' ? undefined : ${n})`).join(', ')}, __setGradeCutoffs: (v) => { GRADE_CUTOFFS = v; }, __setProbCalib: (v) => { PROB_CALIB = v; } };`;
  const warnings = []; const sandbox = { console: { log() {}, info() {}, debug() {}, error() {}, warn: (...a) => warnings.push(a.join(' ')) }, localStorage: makeStorage(opts.localStorageSeed), window: {}, document: {}, navigator: { userAgent: 'node' },
    Date, Math, JSON, Number, String, Array, Object, Map, Set, WeakMap, Promise, RegExp, Error, parseFloat, parseInt, isFinite, isNaN, Infinity, NaN, setTimeout, clearTimeout }; if (opts.sandboxExtras) Object.assign(sandbox, opts.sandboxExtras); sandbox.window.localStorage = sandbox.localStorage;
  const ctx = vm.createContext(sandbox); const m = vm.runInContext(`(function(){\n${body}\n})`, ctx, { filename: 'BeatsEdge.html#ncaaf-region' })(); m.__sandbox = sandbox; m.__warnings = warnings; return m;
}
module.exports = { loadNcaafModel, ncaafSnippet, HTML_PATH };
