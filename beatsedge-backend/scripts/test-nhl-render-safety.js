// NHL unlock project -- regression guard for a real production incident
// (2026-09-29): clicking into NHL after another sport black-screened the
// whole app. Root cause, confirmed by reading the exact call path AND by
// live browser reproduction (intercepting window.fetch with realistic
// ParlayAPI/projections responses, since no real ParlayAPI key was
// available): NHL player objects (fetchNhlPropLines) never populate
// player.statsByKey/player.stats, but `_calculateEdgeScoreImpl` (the
// shared NBA-style factor model, reached via playerBestGrade for any
// real, model-supported prop) unconditionally read `s.last5.avg` where
// `s` was that undefined value -- an uncaught TypeError during React's
// render pass, which unmounts the whole tree with no error boundary here.
//
// This is a SOURCE-level guard (the fix lives inside a giant inline
// React component in BeatsEdge.html, not an importable Node module) --
// it proves the defensive early-return is present and structurally
// complete, so the exact fix can't be silently reverted or drift out of
// sync with what real callers read.
//
//   node scripts/test-nhl-render-safety.js

const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'BeatsEdge.html'), 'utf8');

// Isolate _calculateEdgeScoreImpl's body for targeted assertions.
const startIdx = html.indexOf('function _calculateEdgeScoreImpl(player, prop) {');
const endIdx = html.indexOf('const GRADE_RANK = {');
check('_calculateEdgeScoreImpl is found in BeatsEdge.html', startIdx > -1 && endIdx > startIdx);
const impl = (startIdx > -1 && endIdx > startIdx) ? html.slice(startIdx, endIdx) : '';

check('the defensive guard exists right after computing `s`, before any other code touches it',
  (() => {
    // Phase 1 (NHL release audit): `s` is now computed as
    //   const s = player._isNhl ? null : ((player.statsByKey ...) || player.stats);
    // so NHL is excluded by identity. Anchor on either shape; the ordering requirement is unchanged.
    const sIdx = impl.search(/const s = (?:player\._isNhl\s*\?\s*null\s*:\s*)?\(+player\.statsByKey/);
    const guardIdx = impl.indexOf('if (!s) {');
    const factor1Idx = impl.indexOf('// Factor 1');
    // Ordering matters, not distance (a comment explaining the fix sits
    // in between) -- but the guard must come before Factor 1 starts.
    return sIdx > -1 && guardIdx > sIdx && factor1Idx > guardIdx;
  })());

check('the guard returns BEFORE `s.last5.avg` is ever read (the real exception site)',
  (() => {
    const guardIdx = impl.indexOf('if (!s) {');
    // The CODE usage, not this test's own file's explanatory comment
    // text (which also contains the literal substring "s.last5.avg").
    const readIdx = impl.indexOf('const recentAvg = s.last5.avg;');
    return guardIdx > -1 && readIdx > -1 && guardIdx < readIdx;
  })());

// The fallback object must carry every field real callers actually read,
// or the fix just trades one crash for a different one downstream.
const REQUIRED_FIELDS = [
  'factors', 'greenCount', 'totalFactors', 'confidence', 'projection', 'thinData',
  'edge', 'edgeSignalPct', 'prime', 'matchupLabel', 'grade', 'gradeScore',
  'modelProb', 'modelProbPct', 'rawModelProbPct', 'preFloorProbPct', 'preFloorRaw',
  'sportCalibProbPct', 'familyAdjPts', 'statFamily', 'familyCalibActive',
  'impliedProb', 'impliedProbPct', 'hasRealPrice', 'vigPct', 'edgePct',
  'hitRates', 'probSteps', 'volatilityContext',
];
const guardStart = impl.indexOf('if (!s) {');
const guardEnd = impl.indexOf('// Factor 1');
check('the fallback return block is found', guardStart > -1 && guardEnd > guardStart);
const guardBlock = (guardStart > -1 && guardEnd > guardStart) ? impl.slice(guardStart, guardEnd) : '';
for (const field of REQUIRED_FIELDS) {
  check(`fallback object includes real field "${field}" (a caller reads it elsewhere)`,
    new RegExp(`\\b${field}\\s*:`).test(guardBlock));
}

// playerBestGrade's own real usage of the return value must be satisfied
// by the fallback shape (e.grade / e.gradeScore / e.edge / e.prime).
// `grade` stays a fixed, always-'D' neutral value (never a fabricated
// A/B/C distinction) -- but `edge`/`gradeScore` are deliberately REAL,
// derived from the prop's own already-validated projection/probability
// (never fabricated), so the EXISTING generic sort-by-edge mechanism
// orders NHL players meaningfully. This is sort-ordering-only --
// NhlPlayerCard renders its own real projection/probability/edge
// straight from the prop object, never from this return value.
check('fallback grade is a fixed, always-neutral GRADE_RANK key ("D") -- never a fabricated A/B/C distinction',
  /grade:\s*'D'/.test(guardBlock));
check('fallback edge is a REAL signal derived from the prop\'s own validated projection/probability, not fabricated',
  /const realSignal = prop\.edge != null \? prop\.edge/.test(guardBlock) && /edge:\s*realSignal/.test(guardBlock));
check('fallback gradeScore is derived from the same real signal (so the best-prop comparison isn\'t a no-op tie)',
  /gradeScore:\s*Math\.abs\(realSignal\)/.test(guardBlock));
check('fallback prime is false -- never fabricates a Prime signal for NHL', /prime:\s*false/.test(guardBlock));

console.log(`\n${failures === 0 ? 'ALL NHL RENDER-SAFETY TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
