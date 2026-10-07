// Test/diagnostic helper: evaluates the PURE top-level region of BeatsEdge.html (grade engine, selection, backtest helpers) PLUS the LIVE NFL input
// builders (NFL_PROP_DEFS, nflPosKeys, NFL_WINDOW_OPTS, nflComputeWindows, nflParseGamelog, nflBacktestSeries -- extracted verbatim from inside the App
// closure) in a Node `vm`. Nothing here modifies BeatsEdge.html.
//
// Phase-1 (pre-cleanup) pages had a generic team-defense rank that altered the NFL projection and confluence factors; two sandbox-only switches
// (__NFLDEF.proj / .factor) could isolate those channels. On the cleaned page (2026-10-06) the defense is context-only and those anchors no longer exist:
// the switches are applied ONLY when their anchors are present (so this loader also still runs the pre-cleanup page from `git show <old>:BeatsEdge.html`).
const fs = require('fs'), path = require('path'), vm = require('vm');
const { readRegion, sliceArrowFn, HTML_PATH } = require('./loadBeatsEdgeModel');

const EXPORT_NAMES = ['calculateEdgeScore', 'playerBestGrade', 'findTopPicks', 'findPrimePicks', 'findPlusEVPicks', 'findResearchPicks', 'sortPropsByEdge', 'applyHistoryGate', 'hasRealModelHistory',
  'insufficientDataEdge', 'notYetModeledEdge', 'smartParlayHitRate', 'smartParlayEligibility', 'MODEL_STATE_INSUFFICIENT', 'MODEL_STATE_NOT_YET_MODELED', 'btWindowsAsOf', 'nflBacktestSeries', 'emptyBacktestAcc',
  'resolveFinalGrade', 'wildGapExceeds', 'projStdDev', 'applyProbCalib', 'deriveProbCalib', 'btFileProb', 'bumpEdgeCache', 'NFL_LOWLINE_RARE', 'NFL_STAT_FAMILY', 'NFL_RARE_STATS', 'NFL_FAMILY_ORDER',
  'STAT_TO_ALLOWED_KEY_BY_SPORT', 'statFamilyOf', 'FAMILY_CALIB', 'NFL_PROP_DEFS', 'nflPosKeys', 'NFL_WINDOW_OPTS', 'nflHasFor', 'nflComputeWindows', 'nflParseGamelog', 'normalCdf', 'MODEL_MIN_REAL_GAMES',
  'NFL_GRADE_CONFIG', 'nflModelMeta', 'nflSubOneLineUnsupported', 'applyNflLowLineGate', 'NFL_MODEL_VERSION', 'NFL_FEATURE_SET', 'isModelSupportedProp'];

function nflSnippet(html) {
  const a = html.indexOf('const NFL_PROP_DEFS = {'), bMark = "const nflPosKeys = (pos) => Object.keys(NFL_PROP_DEFS).filter(k => NFL_PROP_DEFS[k].pos.split(',').includes(pos));", b = html.indexOf(bMark, a);
  if (a < 0 || b < 0) throw new Error('NFL_PROP_DEFS block not found');
  const o = html.indexOf('const NFL_WINDOW_OPTS ='), c = html.indexOf('const nflComputeWindows = ');
  const parts = ['const round1 = (n) => Math.round(n * 10) / 10;', html.slice(a, b + bMark.length)];
  if (o > -1) parts.push(html.slice(o, c));                                                  // NFL_WINDOW_OPTS + nflHasFor (cleaned page only)
  parts.push(sliceArrowFn(html, 'const nflComputeWindows = '), sliceArrowFn(html, 'const nflParseGamelog = (gl, opts) => {'));
  if (html.indexOf('const nflBacktestSeries = ') > -1) parts.push(sliceArrowFn(html, 'const nflBacktestSeries = '));   // moved into the App closure on the cleaned page
  return parts.join('\n');
}
// replace `from` by `to` only when the anchor is present exactly once (legacy-page hooks)
const maybe = (src, from, to) => (src.split(from).length === 2) ? src.replace(from, to) : src;
const hook = (src) => {
  src = maybe(src, 'projection *= 1 + ((player.oppDef.rank - _mid) / _span) * 0.06;', "if (typeof __NFLDEF === 'undefined' || __NFLDEF.proj) projection *= 1 + ((player.oppDef.rank - _mid) / _span) * 0.06;");
  src = maybe(src, 'if (leaky || stingy) {', "if ((leaky || stingy) && (typeof __NFLDEF === 'undefined' || __NFLDEF.factor)) {");
  return src;
};
const once = (src, from, to) => { if (src.split(from).length !== 2) throw new Error('hook anchor not found exactly once: ' + from.slice(0, 80)); return src.replace(from, to); };
function makeStorage(seed) { const m = new Map(Object.entries(seed || {}).map(([k, v]) => [k, String(v)])); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear() }; }

// opts: { htmlPath, def: {proj, factor} (legacy pages only), noHook, capture, sandboxExtras, localStorageSeed, transform(regionSrc) }
function loadNflModel(opts) {
  opts = opts || {}; const htmlPath = opts.htmlPath || HTML_PATH; const html = fs.readFileSync(htmlPath, 'utf8');
  let src = readRegion(htmlPath); if (!opts.noHook) src = hook(src);
  if (typeof opts.transform === 'function') src = opts.transform(src);
  // opts.capture: record every (player, prop) the engine is asked to score into sandbox `__capture` (when `__capture.on`)
  if (opts.capture) src = once(src, 'function calculateEdgeScore(player, prop) {', 'function calculateEdgeScore(player, prop) { if (typeof __capture !== "undefined" && __capture.on) __capture.push({ player, prop });');
  src += '\n' + nflSnippet(html);
  const body = `${src}\n;return { ${EXPORT_NAMES.map(n => `${n}: (typeof ${n} === 'undefined' ? undefined : ${n})`).join(', ')}, __setGradeCutoffs: (v) => { GRADE_CUTOFFS = v; }, __setProbCalib: (v) => { PROB_CALIB = v; } };`;
  const def = Object.assign({ proj: true, factor: true }, opts.def || {});
  const sandbox = { console: { log() {}, info() {}, debug() {}, error() {}, warn() {} }, localStorage: makeStorage(opts.localStorageSeed), window: {}, document: {}, navigator: { userAgent: 'node' },
    Date, Math, JSON, Number, String, Array, Object, Map, Set, WeakMap, Promise, RegExp, Error, parseFloat, parseInt, isFinite, isNaN, Infinity, NaN, setTimeout, clearTimeout, __NFLDEF: def };
  if (opts.sandboxExtras) Object.assign(sandbox, opts.sandboxExtras);
  sandbox.window.localStorage = sandbox.localStorage;
  const ctx = vm.createContext(sandbox); const m = vm.runInContext(`(function(){\n${body}\n})`, ctx, { filename: 'BeatsEdge.html#nfl-region' })();
  m.__sandbox = sandbox; m.__def = def; return m;
}
module.exports = { loadNflModel, nflSnippet, HTML_PATH };
