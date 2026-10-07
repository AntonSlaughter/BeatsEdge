// Diagnostic helper (MLB Phase 1 audit): evaluates the PURE top-level region of BeatsEdge.html (grade engine, rare-event recipe, calibration,
// in-app backtest scorers) PLUS the LIVE MLB input builders -- MLB_PROP_DEFS, mlbSeedWindows, mlbBuildProps, fetchMlbPlayerDetail (the on-expand
// game-log window builder) and warmMlbSlateForm (the board's L5/L10 warm-up) -- extracted VERBATIM from inside the App closure and run in a Node `vm`
// against fixtures. Nothing here modifies BeatsEdge.html. The only code not taken from the page is the tiny prelude stubbing React state / network
// (`setPlayersData`, `mlbFetch`, `MLB_SEASON`, `mlbCache`).
const fs = require('fs'), path = require('path'), vm = require('vm');
const { readRegion, sliceArrowFn, HTML_PATH } = require('./loadBeatsEdgeModel');

const EXPORT_NAMES = ['calculateEdgeScore', '_calculateEdgeScoreImpl', 'sortPropsByEdge', 'applyHistoryGate', 'hasRealModelHistory', 'insufficientDataEdge', 'notYetModeledEdge',
  'MODEL_STATE_INSUFFICIENT', 'MODEL_STATE_NOT_YET_MODELED', 'btWindowsAsOf', 'backtestSeries', 'mlbBacktestSeries', 'emptyBacktestAcc', 'resolveFinalGrade', 'wildGapExceeds', 'projStdDev',
  'applyProbCalib', 'deriveProbCalib', 'deriveGradeCutoffs', 'btFileProb', 'bumpEdgeCache', 'MLB_LOWLINE_RARE', 'NFL_LOWLINE_RARE', 'MLB_STAT_FAMILY', 'MLB_FAMILY_ORDER', 'QUANTILE_MODEL_ENABLED',
  'QUANTILE_MODELS', 'quantileModelPredict', 'quantileProbOver', 'statFamilyOf', 'familyCalibAdj', 'FAMILY_CALIB', 'normalCdf', 'MODEL_MIN_REAL_GAMES', 'mlbOffRate', 'mlbSplitN', 'seriesStats',
  'projectionStabilitySummary', 'smartParlayHitRate', 'smartParlayEligibility', 'findTopPicks', 'findPrimePicks', 'findPlusEVPicks', 'findResearchPicks', 'isModelSupportedProp', 'DFS_PLATFORMS', 'ALL_BOOKS',
  'llBin', 'LL_TARGET', 'btProbBucket', 'BT_PROB_BUCKETS', 'GRADE_CUTOFFS_PEEK', '_recentStatSeries', '_stddevSample', 'BOOK_REGISTRY',
  'MLB_GRADE_CONFIG', 'MLB_MODEL_VERSION', 'MLB_FEATURE_SET', 'mlbModelMeta', 'mlbSubOneLineUnsupported', 'applyMlbLowLineGate', 'MLB_LOWLINE_CALIBRATED_NO_RECIPE', 'MLB_SUB1_REASON', 'isModelEligibleEdge', 'isModelEligibleProp', 'isRankingEligibleEdge', 'playerBestGrade', 'sortPropsByEdge', 'wildGapExceeds', 'PARLAY_MLB_MKT'];

const slice = (html, a, b) => { const i = html.indexOf(a); if (i < 0) throw new Error('mlb snippet anchor not found: ' + a); const j = b ? html.indexOf(b, i) : i; if (b && j < 0) throw new Error('mlb snippet end anchor not found: ' + b); return html.slice(i, b ? j : html.indexOf('\n', i)); };
const lineAt = (html, a) => { const i = html.indexOf(a); if (i < 0) throw new Error('mlb snippet anchor not found: ' + a); return html.slice(i, html.indexOf('\n', i)); };

function mlbSnippet(html) {
  const parts = [];
  parts.push(lineAt(html, 'const roundHalf = '), lineAt(html, 'const round1 = (n) => Math.round(n * 10) / 10;'), lineAt(html, 'const num = (v) =>'), lineAt(html, 'const estHitRate = '));
  const cleaned = html.indexOf('const MLB_NUM_RE') > -1;                                                                 // clean-candidate page (parser + shared window builder) vs the pre-cleanup page
  parts.push(slice(html, cleaned ? 'const MLB_NUM_RE' : 'const mlbFantasyHit = ', 'const MLB_MARKET_TO_KEY') + lineAt(html, 'const MLB_MARKET_TO_KEY'));   // parser + fantasy fns + MLB_PROP_DEFS + MLB_MARKET_TO_KEY
  parts.push(slice(html, 'const MLB_DEFAULT_KEYS', 'const MLB_SEASON'));                                                  // MLB_DEFAULT_KEYS, mlbGamesField, mlbSampleLine
  parts.push(sliceArrowFn(html, 'const mlbSeedWindows = (seasonStatObj, isPitcher, statKey, line) => {'));
  parts.push(lineAt(html, 'const PROPLINE_BOOK_PRIORITY = '));
  parts.push(slice(html, 'const PERIOD_MARKET_MAP = {', '// Build the prop list for ONE book.'));                                  // period maps, CONSENSUS_ORDER, booksPresentIn
  parts.push(sliceArrowFn(html, 'const humanizeMarketKey = (key) => {'), sliceArrowFn(html, 'const buildProviderOnlyProps = (allLines, knownKeys, book) => {'));
  if (cleaned) parts.push(sliceArrowFn(html, 'const applyMlbModelGates = (props, statsByKey) => {'));
  parts.push(sliceArrowFn(html, 'const mlbBuildProps = (seasonStat, isPitcher, statsByKey, allLines, book, seedMode) => {'));
  parts.push(lineAt(html, 'const chunk = (arr, n) =>'));
  if (cleaned) parts.push(slice(html, 'const MLB_TEAM_ABBR_BY_NAME = {', 'const warmMlbSlateForm = async (players) => {'));   // shared window builder, helpers, mlbBacktestInputs
  parts.push(sliceArrowFn(html, 'const fetchMlbPlayerDetail = async (player) => {'), sliceArrowFn(html, 'const warmMlbSlateForm = async (players) => {'));
  // harness stubs (React state + network + clock-free season); everything above is page code
  parts.push(`let MLB_SEASON = 2026; const mlbCache = { current: { rosters: {}, abbrById: {}, abbrByFullName: {} } };
let __lastUpdater = null; const setPlayersData = (fn) => { __lastUpdater = fn; };
let __fetchImpl = async () => null; const mlbFetch = (p) => __fetchImpl(p);
async function __runDetail(player, fetchImpl, season) { __fetchImpl = fetchImpl; MLB_SEASON = season; __lastUpdater = null; await fetchMlbPlayerDetail(player); return __lastUpdater ? __lastUpdater([player])[0] : null; }
async function __runWarm(players, fetchImpl, season) { __fetchImpl = fetchImpl; MLB_SEASON = season; __lastUpdater = null; await warmMlbSlateForm(players); return __lastUpdater ? __lastUpdater(players) : null; }`);
  return parts.join('\n');
}
const once = (src, from, to) => { if (src.split(from).length !== 2) throw new Error('hook anchor not found exactly once: ' + from.slice(0, 80)); return src.replace(from, to); };
function makeStorage(seed) { const m = new Map(Object.entries(seed || {}).map(([k, v]) => [k, String(v)])); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear() }; }

// opts: { htmlPath, capture, sandboxExtras, localStorageSeed, transform(regionSrc) }
function loadMlbModel(opts) {
  opts = opts || {}; const htmlPath = opts.htmlPath || HTML_PATH; const html = fs.readFileSync(htmlPath, 'utf8');
  let src = readRegion(htmlPath);
  if (typeof opts.transform === 'function') src = opts.transform(src);
  if (opts.capture) src = once(src, 'function calculateEdgeScore(player, prop) {', 'function calculateEdgeScore(player, prop) { if (typeof __capture !== "undefined" && __capture.on) __capture.push({ player, prop });');
  const abbrLit = (html.match(/const MLB_TEAM_ABBR_BY_NAME = (\{[\s\S]*?\});/) || [])[1];                      // verbatim literal from fetchMlbPlayerDetail
  src += '\n' + mlbSnippet(html);
  const extra = ['MLB_PROP_DEFS', 'MLB_MARKET_TO_KEY', 'MLB_DEFAULT_KEYS', 'mlbGamesField', 'mlbSampleLine', 'mlbSeedWindows', 'mlbBuildProps', 'estHitRate', 'round1', 'roundHalf', 'num', 'mlbFantasyHit', 'mlbFantasyPitch',
    'fetchMlbPlayerDetail', 'warmMlbSlateForm', 'mlbCache', '__runDetail', '__runWarm', 'PERIOD_MARKET_MAP', 'PROPLINE_BOOK_PRIORITY', 'buildProviderOnlyProps',
    'mlbNum', 'mlbOutsFromIp', 'mlbOuts', 'mlbBuildGameList', 'mlbComputeWindows', 'mlbRefreshProps', 'mlbMergeWindows', 'mlbLineFor', 'mlbBacktestInputs', 'mlbOppAbbr', 'applyMlbModelGates'];
  const body = `${src}\n;return { ${EXPORT_NAMES.concat(extra).map(n => `${n}: (typeof ${n} === 'undefined' ? undefined : ${n})`).join(', ')}, MLB_TEAM_ABBR_BY_NAME: ${abbrLit || 'null'},
    __getCutoffs: () => GRADE_CUTOFFS, __getProbCalib: () => PROB_CALIB, __setGradeCutoffs: (v) => { GRADE_CUTOFFS = v; }, __setProbCalib: (v) => { PROB_CALIB = v; }, __setLowLineExpt: (v) => { _MLB_LOWLINE_EXPT = v; } };`;
  const warnings = [];
  const sandbox = { console: { log() {}, info() {}, debug() {}, error() {}, warn: (...a) => warnings.push(a.join(' ')) }, localStorage: makeStorage(opts.localStorageSeed), window: {}, document: {}, navigator: { userAgent: 'node' },
    Date, Math, JSON, Number, String, Array, Object, Map, Set, WeakMap, Promise, RegExp, Error, parseFloat, parseInt, isFinite, isNaN, Infinity, NaN, setTimeout, clearTimeout };
  if (opts.sandboxExtras) Object.assign(sandbox, opts.sandboxExtras);
  sandbox.window.localStorage = sandbox.localStorage;
  const ctx = vm.createContext(sandbox); const m = vm.runInContext(`(function(){\n${body}\n})`, ctx, { filename: 'BeatsEdge.html#mlb-region' })();
  m.__sandbox = sandbox; m.__warnings = warnings; return m;
}
module.exports = { loadMlbModel, mlbSnippet, HTML_PATH };
