// Test/diagnostic helper for the provider-line completeness code in BeatsEdge.html (2026-10-08).
//  loadProviderLines()  -> the PURE shared region (`<<PROVIDER-LINES-BEGIN/END>>`), run verbatim in a Node `vm`.
//  loadProviderFetch(o) -> that region PLUS the REAL `fetchParlayProps` / `fetchParlayPropsBulk` / `nflConsolidate` sliced from the page, with an injected `fetch`
//                          (o.fetch), key/backend and the page's own `nflNormName` / `PARLAY_*_MKT` maps. Nothing here modifies BeatsEdge.html.
const fs = require('fs'), vm = require('vm'); const { sliceArrowFn, HTML_PATH } = require('./loadBeatsEdgeModel');
const idx = (html, a) => { const i = html.indexOf(a); if (i < 0) throw new Error('anchor not found: ' + a); return i; };
const REGION_EXPORTS = ['providerSanitizeBook', 'providerPlayerBase', 'providerDfsLineType', 'providerIsAltDfsType', 'providerMarketClass', 'providerIsLadderKey', 'providerSelectSportsbookMain', 'providerSelectDfsMain', 'providerConsolidateStat', 'providerNewAcc', 'providerAccSrc',
  'providerBuildTelemetry', 'providerUnifyEvents', 'providerAltDfsSides', 'providerLineTypeLabel', 'providerCleanLabel', 'providerSlug', 'providerMedian', 'providerAmericanProb'];
function providerRegion(html) { const a = idx(html, '// <<PROVIDER-LINES-BEGIN>>'), b = idx(html, '// <<PROVIDER-LINES-END>>'); return html.slice(a, b); }
function makeSandbox(extra) { const warnings = []; const sb = { console: { log() {}, info() {}, debug() {}, error() {}, warn: (...a) => warnings.push(a.join(' ')) }, window: {}, Date, Math, JSON, Number, String, Array, Object, Map, Set, Promise, RegExp, Error, parseFloat, parseInt, isFinite, isNaN, Infinity, NaN, setTimeout, clearTimeout, encodeURIComponent }; if (extra) Object.assign(sb, extra); sb.__warnings = warnings; return sb; }
const exportLiteral = (names) => names.map(n => `${n}: ${n}`).join(', ');
function loadProviderLines(opts) {
  opts = opts || {}; const html = fs.readFileSync(opts.htmlPath || HTML_PATH, 'utf8'); const body = `${providerRegion(html)}\n;return { ${exportLiteral(REGION_EXPORTS)} };`;
  return vm.runInContext(`(function(){\n${body}\n})`, vm.createContext(makeSandbox()), { filename: 'BeatsEdge.html#provider-lines' })();
}
// o: { fetch, key, backendUrl, maps: ['PARLAY_BB_MKT', ...], nhl: true, htmlPath }
function loadProviderFetch(o) {
  const html = fs.readFileSync(o.htmlPath || HTML_PATH, 'utf8');
  const regStart = idx(html, 'const BOOK_REGISTRY = ['); const labelStart = idx(html, 'const BOOK_LABEL = {'); const blStart = idx(html, 'const bookLabel = ', labelStart); const blEnd = html.indexOf('\n        };', blStart) + '\n        };'.length;
  const nn0 = idx(html, 'const nflNormName = '); const nnEnd = "replace(/[^a-z]/g, '');"; const nnSrc = html.slice(nn0, html.indexOf(nnEnd, nn0) + nnEnd.length);
  const lineOf = (m) => { const i = idx(html, m); return html.slice(i, html.indexOf('\n', i)); };
  // Brace-matched object literal that skips strings and comments (map comments contain braces / apostrophes).
  const mapSrc = (name) => { const i = idx(html, `const ${name} = {`); let d = 0, q = null, esc = false, k = html.indexOf('{', i); const s = k;
    for (; k < html.length; k++) { const c = html[k];
      if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') { q = c; continue; }
      if (c === '/' && html[k + 1] === '/') { k = html.indexOf('\n', k); continue; }
      if (c === '/' && html[k + 1] === '*') { k = html.indexOf('*/', k) + 1; continue; }
      if (c === '{') d++; else if (c === '}') { d--; if (!d) break; } }
    return `const ${name} = ${html.slice(s, k + 1)};`; };
  const regLines = html.slice(regStart, labelStart);   // BOOK_REGISTRY + DFS_PLATFORMS + PLATFORM_BOOK ...
  const parts = [regLines, html.slice(labelStart, blEnd), lineOf('const PARLAY_DFS_BOOKS = '), lineOf('const PARLAY_FETCH_BOOKS = '), providerRegion(html), nnSrc, 'const _parlayUnmappedWarned = new Set();',
    sliceArrowFn(html, 'const fetchParlayProps = async (parlaySportKey, mktMap, marketsFilter, opts) => {'), sliceArrowFn(html, 'const fetchParlayPropsBulk = async (parlaySportKey, mktMap, opts, isStale) => {'), sliceArrowFn(html, 'const nflConsolidate = (linesByName) => {')];
  const extra = []; const maps = o.maps || ['PARLAY_BB_MKT', 'PARLAY_MLB_MKT', 'PARLAY_FB_MKT'];
  if (o.nhl) { extra.push(html.slice(idx(html, 'const NHL_FULL_GAME'), idx(html, 'const PARLAY_NHL_MKT = {'))); if (!maps.includes('PARLAY_NHL_MKT')) maps.push('PARLAY_NHL_MKT'); }
  maps.forEach(n => extra.push(mapSrc(n)));
  const names = ['fetchParlayProps', 'fetchParlayPropsBulk', 'nflConsolidate', 'DFS_PLATFORMS', 'BOOK_REGISTRY', 'PARLAY_FETCH_BOOKS', 'nflNormName', 'bookLabel'].concat(maps).concat(REGION_EXPORTS).concat(o.nhl ? ['nhlSelectMainLine', 'nhlEntryEventKey', 'nhlPickPlayerEvent', 'nhlResolveBookLine', 'nhlListPlayerEvents'] : []);
  const body = `${parts.join('\n')}\n${extra.join('\n')}\n;return { ${exportLiteral(names)} };`;
  const sb = makeSandbox({ fetch: o.fetch, parlayApiKey: o.key || 'test-key', backendUrl: o.backendUrl || 'http://backend.test', setParlaySource() {} });
  const mod = vm.runInContext(`(function(){\n${body}\n})`, vm.createContext(sb), { filename: 'BeatsEdge.html#provider-fetch' })(); mod.__sandbox = sb; return mod;
}
module.exports = { loadProviderLines, loadProviderFetch, providerRegion, HTML_PATH };
