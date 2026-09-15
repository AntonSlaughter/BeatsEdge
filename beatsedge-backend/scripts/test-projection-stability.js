// Tests the Projection Stability / Uncertainty research helpers
// (seriesStats, projectionStabilitySummary) that live inline in
// BeatsEdge.html near emptyBacktestAcc(). BeatsEdge.html has no module
// system (single-file in-browser Babel app, confirmed by prior audits in
// this project), so there is no require() path to these functions --
// instead this script extracts their exact source text out of the real
// file (balanced-brace scan, not a regex guess at the body) and evals it
// into this process. Both functions are pure (no DOM/React/other in-file
// globals), which is what makes this safe: what's evaluated here is
// byte-for-byte what ships in the file, not a hand-copied duplicate that
// could quietly drift out of sync.
//
// These same assertions were also run directly in a real browser against
// the live file (via the Browser pane) before this script was written,
// confirming the in-browser Babel-transpiled behavior matches this Node
// eval exactly.

const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'BeatsEdge.html');
const src = fs.readFileSync(HTML_PATH, 'utf8');

function extractFunction(source, name) {
  const startMarker = `function ${name}(`;
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`${name} not found in BeatsEdge.html`);
  const braceStart = source.indexOf('{', start);
  if (braceStart === -1) throw new Error(`${name}: no opening brace found`);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error(`${name}: unbalanced braces`);
  return source.slice(start, i + 1);
}

const seriesStatsSrc = extractFunction(src, 'seriesStats');
const summarySrc = extractFunction(src, 'projectionStabilitySummary');

// eslint-disable-next-line no-eval
eval(seriesStatsSrc);
// eslint-disable-next-line no-eval
eval(summarySrc);

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}

console.log('=== Projection Stability helpers test (extracted live from BeatsEdge.html) ===\n');

// 1. Empty array -> all null, never fabricated
const empty = seriesStats([]);
ok(empty.floor === null && empty.median === null && empty.mean === null && empty.ceiling === null
  && empty.stdDev === null && empty.coefficientOfVariation === null && empty.sampleSize === 0,
  'empty series -> all null/0, never fabricated', empty);

// 2. Single value -> stdDev/CV null (n<2), but floor/median/mean/ceiling real
const one = seriesStats([10]);
ok(one.floor === 10 && one.median === 10 && one.mean === 10 && one.ceiling === 10 && one.stdDev === null && one.sampleSize === 1,
  'single value -> real floor/median/mean/ceiling, stdDev null (n<2)', one);

// 3. Known distribution
const known = seriesStats([10, 12, 14, 16, 18]);
ok(known.mean === 14 && known.median === 14 && known.floor === 10 && known.ceiling === 18 && known.sampleSize === 5,
  'known 5-value series -> correct floor/median/mean/ceiling', known);
ok(Math.abs(known.stdDev - 3.16) < 0.02, 'known series -> correct sample stdDev (n-1)', known.stdDev);

// 4. null/NaN never silently treated as 0
const withNulls = seriesStats([5, null, 7, undefined, NaN, 9]);
ok(withNulls.sampleSize === 3 && withNulls.mean === 7, 'null/undefined/NaN entries filtered out, not treated as 0', withNulls);

// 5. Constant series -> stdDev/CV exactly 0, no NaN
const constSeries = seriesStats([5, 5, 5, 5, 5]);
ok(constSeries.stdDev === 0 && constSeries.coefficientOfVariation === 0, 'constant series -> stdDev/CV exactly 0, no NaN', constSeries);

// 6. Zero-mean series -> CV null (never divide by zero)
const zeroMean = seriesStats([-2, 0, 2]);
ok(zeroMean.mean === 0 && zeroMean.coefficientOfVariation === null && zeroMean.stdDev != null,
  'zero-mean series -> CV null (no div/0), stdDev still computed', zeroMean);

// 7/8. Trend direction
const risingSeason = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 20];
ok(projectionStabilitySummary(risingSeason, risingSeason.slice(-5)).trend > 0, 'rising recent-vs-season -> positive trend');
const fallingSeason = [20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 10, 10, 10, 10, 10];
ok(projectionStabilitySummary(fallingSeason, fallingSeason.slice(-5)).trend < 0, 'falling recent-vs-season -> negative trend');

// 9. consistency/projectionStability bounded, alias matches
const stableSeries = [10, 10, 10, 10, 10, 10, 10, 10];
const stableSummary = projectionStabilitySummary(stableSeries, stableSeries.slice(-5));
ok(stableSummary.consistency === 1 && stableSummary.projectionStability === stableSummary.consistency,
  'perfectly constant series -> consistency 1.0, projectionStability aliases it', stableSummary);

// 10. Volatile series -> lower consistency, positive volatilityScore
const volatileSeries = [2, 20, 4, 18, 3, 22, 5, 19];
const volatileSummary = projectionStabilitySummary(volatileSeries, volatileSeries.slice(-5));
ok(volatileSummary.consistency < stableSummary.consistency && volatileSummary.volatilityScore > 0,
  'volatile series -> lower consistency and a positive volatilityScore than a stable series', volatileSummary);

// 11. Empty season -> everything null, never fabricated
const emptySummary = projectionStabilitySummary([], []);
ok(emptySummary.trend === null && emptySummary.consistency === null && emptySummary.projectionStability === null && emptySummary.volatilityScore === null,
  'empty season series -> all summary fields null, never fabricated', emptySummary);

// 12. Never silently substitutes windows -- this is a CALLER-side contract
// (nbaComputeWindows/nflComputeWindows/fetchMlbPlayerDetail's windowOf()
// already reports requestedGames/availableGames/complete alongside
// `stability`), but confirm seriesStats itself is honest about whatever
// array it's actually given -- a 7-length array reports sampleSize 7, not 10.
const shortSeries = seriesStats([1, 2, 3, 4, 5, 6, 7]);
ok(shortSeries.sampleSize === 7, 'a 7-game array reports sampleSize 7 (never padded/mislabeled as 10)', shortSeries.sampleSize);

// 13-16. Exact L5/L10/L15/L20 window lengths -- each reports the real
// sampleSize matching the array actually given (mirrors how nbaComputeWindows'
// windowOf(n) calls seriesStats(vals.slice(-n)) for n=5/10/15/20).
const mkSeq = (n) => Array.from({ length: n }, (_, i) => 10 + i);
[5, 10, 15, 20].forEach(n => {
  const s = seriesStats(mkSeq(n));
  ok(s.sampleSize === n && s.floor === 10 && s.ceiling === 10 + n - 1,
    `exact L${n} window (${n} games) -> correct sampleSize/floor/ceiling`, s);
});

// 17. Deterministic output -- calling seriesStats twice on the same input
// (including a fresh array with identical values) must produce identical
// results. No hidden state, no randomness, no ordering-dependent side effects.
const detInput = [7, 3, 9, 3, 5, 8, 2, 6];
const detA = seriesStats([...detInput]);
const detB = seriesStats([...detInput]);
ok(JSON.stringify(detA) === JSON.stringify(detB), 'seriesStats is deterministic -- identical input produces identical output', { detA, detB });
const summA = projectionStabilitySummary([...detInput], detInput.slice(-5));
const summB = projectionStabilitySummary([...detInput], detInput.slice(-5));
ok(JSON.stringify(summA) === JSON.stringify(summB), 'projectionStabilitySummary is deterministic', { summA, summB });

// 18. No mutation of source game rows -- seriesStats must not sort, reverse,
// or otherwise alter the caller's array in place (nbaComputeWindows/
// nflComputeWindows pass `vals`/`arr` slices that other code in those
// functions reads afterward -- an in-place sort would corrupt chronological
// ordering for every window computed after this one).
const original = [9, 2, 7, 4, 1, 8, 3];
const originalCopy = [...original];
seriesStats(original);
ok(JSON.stringify(original) === JSON.stringify(originalCopy), 'seriesStats does not mutate its input array (order/values unchanged)', original);
const originalForSummary = [5, 5, 5, 12, 12, 12, 3, 3, 3];
const originalForSummaryCopy = [...originalForSummary];
projectionStabilitySummary(originalForSummary, originalForSummary.slice(-3));
ok(JSON.stringify(originalForSummary) === JSON.stringify(originalForSummaryCopy), 'projectionStabilitySummary does not mutate its input array', originalForSummary);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
