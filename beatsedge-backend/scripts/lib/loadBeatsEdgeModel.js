// Test helper: evaluates the PURE top-level region of BeatsEdge.html (grade engine, Top Picks / Prime / +EV selection, backtest
// windows, NHL main-line helpers, the NBA DvP block) inside a Node `vm`, so tests exercise the REAL shipped functions rather
// than copies. Nothing here writes to or modifies BeatsEdge.html.
//
// The region is `const API_CONFIG = {` ... up to (not including) `function PlayerAvatar` -- everything before the first React
// component. Region-level code touches only `localStorage` / `console` / `window`, which are stubbed (in-memory, try/catch tolerant).
//
// Variants (used by the NBA defense harness, NEVER for production):
//   loadModel({ transform: (src) => src })   -- the hook receives the region source (e.g. to disable the generic NBA nudge for variant B)
//
//   const m = loadModel();  m.calculateEdgeScore(player, prop)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML_PATH = path.join(__dirname, '..', '..', 'BeatsEdge.html');
const START_MARK = 'const API_CONFIG = {';
const END_MARK = 'function PlayerAvatar(';

const EXPORTS = [
  'calculateEdgeScore', '_calculateEdgeScoreImpl', 'playerBestGrade', 'findTopPicks', 'findPrimePicks', 'findPlusEVPicks', 'findResearchPicks',
  'sortPropsByEdge', 'applyHistoryGate', 'hasRealModelHistory', 'insufficientDataEdge', 'smartParlayHitRate', 'smartParlayEligibility',
  'MODEL_STATE_INSUFFICIENT', 'SMART_PARLAY_MIN_HIT_RATE', 'isModelSupportedProp', 'btWindowsAsOf', 'GRADE_RANK', 'gradeRankOf',
  'nhlEntryEventKey', 'nhlAmericanProb', 'nhlPickPlayerEvent', 'nhlSelectMainLine', 'nhlResolveBookLine', 'DFS_PLATFORMS', 'ALL_BOOKS',
  'STAT_TO_ALLOWED_KEY_BY_SPORT', 'bumpEdgeCache', 'nbaDvpFor',
  'resolveFinalGrade', 'wildGapExceeds', 'NBA_GRADE_CONFIG', 'nbaPositionWord', 'GRADE_CUTOFFS_PEEK',
  'btFileProb', 'deriveProbCalib', 'emptyBacktestAcc', 'applyProbCalib', 'btProbBucket', 'BT_PROB_BUCKETS',
];

// Brace-matched slice of `const name = (...) => { ... };` starting at `marker` (skips strings, template literals and comments).
function sliceArrowFn(src, marker) {
  const i = src.indexOf(marker); if (i < 0) throw new Error('marker not found: ' + marker);
  const b = src.indexOf('{', src.indexOf('=>', i)); let d = 0, q = null, esc = false;
  for (let k = b; k < src.length; k++) {
    const c = src[k];
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '{') d++; else if (c === '}') { d--; if (!d) { let e = k + 1; if (src[e] === ';') e++; return src.slice(i, e); } }
  }
  throw new Error('unterminated: ' + marker);
}
// The LIVE NBA input builders live inside the React App closure. They are extracted verbatim (never re-implemented) so historical
// validation builds model inputs with the exact same code the live path runs.
function liveNbaSnippet(html) {
  const a = html.indexOf("const NBA_3PM = '"), bMark = 'const nbaAllKeys = Object.keys(NBA_PROP_DEFS);', b = html.indexOf(bMark, a);
  if (a < 0 || b < 0) throw new Error('NBA_PROP_DEFS block not found');
  return ['const round1 = (n) => Math.round(n * 10) / 10;', html.slice(a, b + bMark.length),
    sliceArrowFn(html, 'const nbaMinutesTrend = (glRows) => {'), sliceArrowFn(html, 'const nbaProjMinutes = (glRows) => {'),
    sliceArrowFn(html, 'const nbaComputeWindows = (glRows, lineFor, oppAbbr, oppRankByAbbr, seasonYear) => {')].join('\n');
}

function readRegion(htmlPath) {
  const html = fs.readFileSync(htmlPath || HTML_PATH, 'utf8');
  const a = html.indexOf(START_MARK), b = html.indexOf(END_MARK);
  if (a < 0 || b < 0 || b < a) throw new Error('BeatsEdge.html region markers not found');
  return html.slice(a, b);
}

function makeStorage(seed) {
  const m = new Map(Object.entries(seed || {}).map(([k, v]) => [k, String(v)]));   // a "browser" that already holds these values
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear() };
}

function loadModel(opts) {
  opts = opts || {};
  let src = readRegion(opts.htmlPath);
  if (typeof opts.transform === 'function') src = opts.transform(src);
  let extra = [];
  if (opts.liveNba) {
    src += '\n' + liveNbaSnippet(fs.readFileSync(opts.htmlPath || HTML_PATH, 'utf8'));
    extra = ['nbaComputeWindows', 'nbaMinutesTrend', 'nbaProjMinutes', 'nbaAllKeys', 'NBA_PROP_DEFS', 'NBA_3PM'];
  }
  const exportsList = (opts.extraExports || []).concat(extra, EXPORTS, ['FAMILY_CALIB', 'NBA_MODEL_VERSION', 'NBA_FEATURE_SET', 'NBA_CALIBRATION_ID', 'nbaModelMeta']);
  // Export only names that actually exist in the region (typeof is safe for undeclared identifiers).
  const body = `${src}\n;return { ${exportsList.map(n => `${n}: (typeof ${n} === 'undefined' ? undefined : ${n})`).join(', ')}, __setGradeCutoffs: (v) => { GRADE_CUTOFFS = v; }, __setProbCalib: (v) => { PROB_CALIB = v; } };`;
  const warnings = [];
  const sandbox = {
    console: { log() {}, info() {}, debug() {}, error() {}, warn: (...a) => warnings.push(a.join(' ')) },
    localStorage: makeStorage(opts.localStorageSeed), window: {}, document: {}, navigator: { userAgent: 'node' },
    Date, Math, JSON, Number, String, Array, Object, Map, Set, WeakMap, Promise, RegExp, Error, parseFloat, parseInt, isFinite, isNaN, Infinity, NaN,
    setTimeout, clearTimeout,
  };
  sandbox.window.localStorage = sandbox.localStorage;
  const ctx = vm.createContext(sandbox);
  const fn = vm.runInContext(`(function(){\n${body}\n})`, ctx, { filename: 'BeatsEdge.html#region' });
  const model = fn();
  model.__warnings = warnings;
  model.__sandbox = sandbox;
  return model;
}

module.exports = { loadModel, readRegion, liveNbaSnippet, sliceArrowFn, HTML_PATH };
