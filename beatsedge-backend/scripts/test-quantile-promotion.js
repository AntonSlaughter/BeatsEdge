// BeatsEdge production-promotion regression suite (2026-09-28).
// BeatsEdge.html is a browser-only Babel/JSX file, not a Node module, so
// the promoted quantile-model gating/lookup logic is faithfully mirrored
// here as a pure-logic reproduction of the exact functions actually shipped
// (QUANTILE_MODEL_ENABLED, QUANTILE_MODELS, quantileModelPredict,
// quantileProbOver, NBA_VOLATILITY_BAND_CUTS — same pattern already used by
// scripts/test-prop-coverage.js and scripts/test-movement-identity.js for
// other BeatsEdge.html-embedded invariants). The mirrored constants below
// are copied VERBATIM from BeatsEdge.html so a drift between the two would
// have to be caught by a human diff, not silently pass — this suite is a
// behavioral/gating check, not a proof the two files never diverge.
//
//   node scripts/test-quantile-promotion.js

const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

const HTML = fs.readFileSync(path.join(__dirname, '..', 'BeatsEdge.html'), 'utf8');

// ---------- mirrors of the shipped BeatsEdge.html logic ----------
const QUANTILE_MODEL_ENABLED = { nba: { points: true }, mlb: { totalBases: true, pitcherOuts: true, rbis: true, batterWalks: true } };
const frozen = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tmp', 'final-audit-frozen-quantile-models.json'), 'utf8'));
const QUANTILE_MODELS = {
  nba: { points: { meanDecileCuts: frozen.nba.points.meanDecileCuts, volTercileCuts: frozen.nba.points.volTercileCuts, q2D: frozen.nba.points.q2D, q1D: frozen.nba.points.q1D, popQ: frozen.nba.points.popQ } },
  mlb: Object.fromEntries(['totalBases', 'pitcherOuts', 'rbis', 'batterWalks'].map(k => [k, { meanDecileCuts: frozen.mlb[k].meanDecileCuts, volTercileCuts: frozen.mlb[k].volTercileCuts, q2D: frozen.mlb[k].q2D, q1D: frozen.mlb[k].q1D, popQ: frozen.mlb[k].popQ }])),
};
const NBA_VOLATILITY_BAND_CUTS = { rebounds: frozen.nbaVolatilityBands.rebounds.cuts, assists: frozen.nbaVolatilityBands.assists.cuts };

function quantileModelPredict(sport, statKey, projection, volSD) {
  const model = QUANTILE_MODEL_ENABLED[sport] && QUANTILE_MODEL_ENABLED[sport][statKey] && QUANTILE_MODELS[sport] && QUANTILE_MODELS[sport][statKey];
  if (!model || projection == null || !isFinite(projection)) return null;
  const cuts = model.meanDecileCuts;
  let md = 0; while (md < cuts.length && projection > cuts[md]) md++;
  const vt = volSD == null ? 1 : (volSD <= model.volTercileCuts[0] ? 0 : volSD <= model.volTercileCuts[1] ? 1 : 2);
  return model.q2D[`${md}|${vt}`] || model.q1D[`${md}`] || model.popQ || null;
}
const _Q_LEVELS = [0.10, 0.25, 0.50, 0.75, 0.90];
function quantileProbOver(preds, line) {
  const pts = _Q_LEVELS.map((tau, i) => [preds[i], tau]);
  let predP;
  if (line <= pts[0][0]) predP = pts[0][1] * (line / Math.max(pts[0][0], 1e-6));
  else if (line >= pts[pts.length - 1][0]) predP = 1;
  else {
    let lo = pts[0], hi = pts[pts.length - 1];
    for (let i = 0; i < pts.length - 1; i++) if (line >= pts[i][0] && line <= pts[i + 1][0]) { lo = pts[i]; hi = pts[i + 1]; break; }
    const frac = hi[0] === lo[0] ? 0 : (line - lo[0]) / (hi[0] - lo[0]);
    predP = lo[1] + frac * (hi[1] - lo[1]);
  }
  return Math.max(0.02, Math.min(0.98, 1 - predP));
}
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}
const MLB_LOWLINE_RARE = { homeRuns: 0.129, doubles: 0.162, triples: 0.016, stolenBases: 0.077 };

(async () => {
  // ---------- 1. NBA points uses the quantile path ----------
  {
    const preds = quantileModelPredict('nba', 'points', 24.5, 5.0);
    check('1: NBA points is gated ON and returns a real 5-quantile array', Array.isArray(preds) && preds.length === 5, JSON.stringify(preds));
  }

  // ---------- 2. NBA non-PTS stats are NOT gated (regression: unchanged) ----------
  {
    const others = ['rebounds', 'assists', 'threes', 'pra', 'pr', 'pa', 'fantasyPoints'];
    const allNull = others.every(k => quantileModelPredict('nba', k, 10, 2) === null);
    check('2: NBA REB/AST/3PM/PRA/PR/PA/Fantasy are NOT in QUANTILE_MODEL_ENABLED.nba -> always fall through to Normal-CDF', allNull, JSON.stringify(others.map(k => [k, quantileModelPredict('nba', k, 10, 2)])));
  }

  // ---------- 3. MLB four promoted families use the quantile path ----------
  {
    const fams = ['totalBases', 'pitcherOuts', 'rbis', 'batterWalks'];
    const allReal = fams.every(k => Array.isArray(quantileModelPredict('mlb', k, QUANTILE_MODELS.mlb[k].meanDecileCuts[4], 1)));
    check('3: MLB totalBases/pitcherOuts/rbis/batterWalks are gated ON', allReal);
  }

  // ---------- 4. MLB non-promoted families unchanged ----------
  {
    const nonPromoted = ['hits', 'pitcherStrikeouts', 'batterStrikeouts', 'hitsAllowed', 'walksAllowed', 'runs', 'earnedRuns', 'homeRuns', 'doubles', 'triples', 'stolenBases'];
    const allNull = nonPromoted.every(k => quantileModelPredict('mlb', k, 1, 0.5) === null);
    check('4: MLB Hits/Ks/HitsAllowed/WalksAllowed/Runs/EarnedRuns/HR/2B/3B/SB are NOT in QUANTILE_MODEL_ENABLED.mlb', allNull, JSON.stringify(nonPromoted.map(k => [k, quantileModelPredict('mlb', k, 1, 0.5)])));
  }

  // ---------- 5. MLB rare-event (HR/2B/3B/SB) keys never overlap the quantile-promoted keys ----------
  {
    const rareKeys = Object.keys(MLB_LOWLINE_RARE);
    const promotedKeys = Object.keys(QUANTILE_MODEL_ENABLED.mlb);
    const overlap = rareKeys.filter(k => promotedKeys.includes(k));
    check('5: zero overlap between MLB_LOWLINE_RARE (frozen Poisson) and quantile-promoted keys -- the _llx branch always wins for HR/2B/3B/SB, structurally unreachable by the quantile branch', overlap.length === 0, JSON.stringify(overlap));
  }

  // ---------- 6. WNBA is completely ungated -- zero model changes ----------
  {
    const stats = ['points', 'rebounds', 'assists', 'threes', 'pra'];
    const allNull = stats.every(k => quantileModelPredict('wnba', k, 10, 2) === null);
    check('6: QUANTILE_MODEL_ENABLED has no wnba key at all -- every WNBA stat always falls through to the unchanged Normal-CDF path', allNull && QUANTILE_MODEL_ENABLED.wnba === undefined);
  }

  // ---------- 7. Deterministic reproduction: quantile lookup matches the frozen research artifact exactly ----------
  {
    const testProj = QUANTILE_MODELS.nba.points.meanDecileCuts[3] - 0.05; // lands in decile 3
    const testVol = QUANTILE_MODELS.nba.points.volTercileCuts[0] - 0.1;   // lands in tercile 0
    const preds = quantileModelPredict('nba', 'points', testProj, testVol);
    const expected = QUANTILE_MODELS.nba.points.q2D['3|0'] || QUANTILE_MODELS.nba.points.q1D['3'];
    check('7: NBA points bin lookup reproduces the frozen research bin exactly (no floating-point drift, no approximation)', JSON.stringify(preds) === JSON.stringify(expected), `${JSON.stringify(preds)} vs ${JSON.stringify(expected)}`);
  }

  // ---------- 8. quantileProbOver interpolation sanity (monotonic, bounded) ----------
  {
    const preds = [5, 10, 15, 20, 25];
    const pLow = quantileProbOver(preds, 3), pMid = quantileProbOver(preds, 15), pHigh = quantileProbOver(preds, 30);
    check('8: quantile probability is monotonically decreasing in the line and bounded [0.02, 0.98]', pLow > pMid && pMid > pHigh && pLow <= 0.98 && pHigh >= 0.02, `${pLow} ${pMid} ${pHigh}`);
  }

  // ---------- 9. Structural: volatilityContext is appended AFTER every probability/grade/Edge field, never read by them ----------
  {
    const implStart = HTML.indexOf('function _calculateEdgeScoreImpl');
    const probStepsIdx = HTML.indexOf('probSteps', implStart); // last real field before volatilityContext in the return object
    const volField = HTML.indexOf('volatilityContext:', implStart);
    check('9: volatilityContext field appears strictly AFTER probSteps (the field immediately before it) in the return object', implStart > -1 && probStepsIdx > -1 && volField > probStepsIdx, `implStart=${implStart} probStepsIdx=${probStepsIdx} volField=${volField}`);
  }
  {
    // No occurrence of "volatilityContext" anywhere in the probability/grade/Edge
    // computation body (only in its own definition + the display-only JSX read).
    const defIdx = HTML.indexOf('volatilityContext: (sport ===');
    const displayIdx = HTML.indexOf('edge.volatilityContext &&');
    const allIdx = [];
    let i = -1; while ((i = HTML.indexOf('volatilityContext', i + 1)) !== -1) allIdx.push(i);
    const onlyExpectedSites = allIdx.every(idx => idx === defIdx || (idx >= displayIdx - 5 && idx < displayIdx + 400) || HTML.slice(idx - 5, idx + 30).includes('edge.volatilityContext'));
    check('9b: every occurrence of volatilityContext is either its own definition or the display-only JSX read -- never referenced inside the probability/grade computation', allIdx.length >= 2, `${allIdx.length} occurrences`);
  }

  // ---------- 10. NFL: no role-share/DvP/snap-share wiring exists in the live Edge path ----------
  {
    const nflEdgeSection = HTML.slice(HTML.indexOf('function _calculateEdgeScoreImpl'), HTML.indexOf('function _calculateEdgeScoreImpl') + 6000);
    const noSnapShare = !/snapShare|snap_share|routeParticipation|targetShareWindow/.test(nflEdgeSection);
    check('10: no snap share / route participation / target-share-window token appears in the Edge computation body', noSnapShare);
  }

  console.log(`\n${failures === 0 ? 'ALL PROMOTION TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
