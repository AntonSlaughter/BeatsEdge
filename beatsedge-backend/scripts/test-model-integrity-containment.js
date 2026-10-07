// Model-integrity containment tests (BeatsEdge.html). Runs the REAL shipped functions (extracted via scripts/lib/loadBeatsEdgeModel.js).
//
// Proves:
//   1. missing / empty / zero-length / seeded history is NOT numeric zero and produces NO projection, probability, confidence, grade,
//      edge, Prime, Best Plays (Top Picks / Prime Plays / +EV) or Smart Parlay eligibility -- the real line is untouched;
//   2. a synthetic (`estHitRate`) hit rate can never make a prop Smart-Parlay eligible; only a real game-log hit rate can;
//   3. real history still grades normally (the gate is not a blanket kill-switch);
//   4. (originally a CHARACTERIZATION of the NBA stat-agnostic defense nudge; since 2026-10-06 the defect is REMOVED and section 6 asserts
//      the removal -- the full proof is scripts/test-nba-defense-removed-and-parity.js).
//
//   node scripts/test-model-integrity-containment.js

const fs = require('fs');
const { loadModel, HTML_PATH } = require('./lib/loadBeatsEdgeModel');

let failures = 0;
function check(name, cond, detail) { if (cond) console.log(`PASS  ${name}`); else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); } }

const m = loadModel();
const html = fs.readFileSync(HTML_PATH, 'utf8');
const FUTURE = Date.now() + 6 * 3600e3;

// -- fixtures ---------------------------------------------------------------
const estHitRate = (avg, line) => Math.max(15, Math.min(90, Math.round(50 + (avg - line) * 22)));
const round1 = (n) => Math.round(n * 10) / 10;
// Exact replica of the builders' placeholder (nflSeedWindows) -- asserted against the real source below.
function seedWindows(perGame, line) {
  const avg = round1(perGame), hr = estHitRate(avg, line);
  const w = (g) => ({ avg, hitRate: hr, games: g, seeded: true });
  return { recent: { avg, hitRate: hr, median: Math.round(perGame), range: [0, Math.max(1, Math.ceil(perGame * 2))], games: 0, seeded: true },
    last5: w(0), last10: w(0), last15: w(0), last20: w(0), last40: w(0), season: w(0), trueSeason: w(0), vsOpp: { avg, hitRate: hr, games: 0, seeded: true } };
}
const series = (n, base) => Array.from({ length: n }, (_, i) => base + ((i * 7) % 9) - 4);       // deterministic, varied, >0
const opps = (n) => Array.from({ length: n }, (_, i) => ['BOS', 'MIA', 'NYK', 'CHI'][i % 4]);
function realPlayer(sport, statKey, line, opts) {
  opts = opts || {};
  const vals = series(opts.games || 30, opts.base || 24);
  const w = m.btWindowsAsOf(vals, opps(vals.length), 'BOS', line);
  const log = vals.map((v, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, opponent: opps(vals.length)[i], points: v, line }));
  return { id: 'p-' + sport + '-' + statKey, sport, position: opts.position || 'G', opponent: 'BOS', statsByKey: { [statKey]: w }, gameLogByKey: opts.noLog ? {} : { [statKey]: log }, stats: w,
    opponentDefense: opts.opponentDefense || null, oppDef: null, props: [] };
}
const prop = (statKey, line, extra) => Object.assign({ statKey, type: statKey, line, direction: 'over', lineSource: 'ParlayAPI · draftkings', eventId: 'ev1', commenceTimeMs: FUTURE, book: 'draftkings', odds: -115, oppOdds: -105, hitRate: 62 }, extra || {});

// Seeded builders must really produce what the fixtures claim.
{
  const a = html.indexOf('const nflSeedWindows = (perGame, line) => {'), b = html.indexOf('const mlbSeedWindows', a);
  const src = html.slice(a, b);
  check('real nflSeedWindows source still marks every window `seeded: true` with games 0', /const w = \(g\) => \(\{ avg, hitRate: hr, games: g, seeded: true \}\)/.test(src) && /last5: w\(0\)/.test(src) && /season: w\(0\)/.test(src));
  check('real mlbSeedWindows source marks windows `seeded: true`', /const w = \(g\) => \(\{ avg, hitRate: hr, games: g, seeded: true \}\);/.test(html.slice(b, b + 2500)));
}

// -- 1. missing history is not zero and not evidence --------------------------
console.log('\n# missing history fails closed');
const noHistoryCases = {
  'seeded zero-game windows (NBA/WNBA/NFL/NCAAF builders)': { stats: seedWindows(0, 22.5), sbk: { points: seedWindows(0, 22.5) } },
  'statsByKey entry missing, stats = {}': { stats: {}, sbk: {} },
  'empty real windows (avg: null, games: 0)': (() => { const e = { avg: null, hitRate: null, games: 0 }; const w = { last5: e, last10: e, last20: e, season: e, vsOpp: e, recent: { avg: null, hitRate: null, median: 0, range: [0, 0], games: 0 } }; return { stats: w, sbk: { points: w } }; })(),
  'real avg 0 over 0 games': (() => { const e = { avg: 0, hitRate: 0, games: 0 }; const w = { last5: e, last10: e, last20: e, season: e, vsOpp: e, recent: { avg: 0, hitRate: 0, median: 0, range: [0, 0], games: 0 } }; return { stats: w, sbk: { points: w } }; })(),
};
for (const [label, c] of Object.entries(noHistoryCases)) {
  for (const dir of ['over', 'under']) {
    const player = { id: 'nh', sport: 'nba', position: 'G', opponent: 'BOS', statsByKey: c.sbk, stats: c.stats, gameLogByKey: {}, opponentDefense: null, oppDef: null, props: [] };
    const p = prop('points', 22.5, { direction: dir });
    const e = m.calculateEdgeScore(player, p);
    const allNull = e.projection === null && e.modelProb === null && e.modelProbPct === null && e.confidence === null && e.grade === null && e.gradeScore === null && e.edge === null && e.edgePct === null && e.edgeSignalPct === null;
    check(`[${label}] ${dir}: every model field is null/unavailable (not 0, not 'D', not the line)`, allNull, JSON.stringify({ proj: e.projection, prob: e.modelProbPct, conf: e.confidence, grade: e.grade, edge: e.edge }));
    check(`[${label}] ${dir}: explicit INSUFFICIENT_DATA state, no Prime`, e.insufficientData === true && e.modelState === m.MODEL_STATE_INSUFFICIENT && e.prime === false);
    check(`[${label}] ${dir}: no hit rate / hit-rate source`, e.hitRates === null && e.hitRatesSource === null);
    check(`[${label}] ${dir}: not Smart-Parlay eligible, no substitute hit rate`, (() => { const s = m.smartParlayEligibility(e, p); return s.eligible === false && s.hitRate === null; })());
  }
}

// The same case BEFORE the fix (gate line removed from the shipped source) -- documents the defect that existed.
console.log('\n# characterization of the BEFORE behaviour (gate disabled via source transform; test-only, never shipped)');
{
  const before = loadModel({ transform: (src) => src.replace('if (!hasRealModelHistory(s)) return insufficientDataEdge();', '') });
  const player = { id: 'nh', sport: 'nba', position: 'G', opponent: 'BOS', statsByKey: { points: seedWindows(0, 22.5) }, stats: seedWindows(0, 22.5), gameLogByKey: {}, opponentDefense: null, oppDef: null, props: [] };
  const e = before.calculateEdgeScore(player, prop('points', 22.5, { direction: 'under' }));
  check('BEFORE: a no-history UNDER prop got a numeric projection of 0 and a numeric probability/grade (the defect)', e.projection === 0 && typeof e.modelProbPct === 'number' && e.grade != null, JSON.stringify({ proj: e.projection, prob: e.modelProbPct, conf: e.confidence, grade: e.grade }));
  console.log(`      (before: projection=${e.projection} prob=${e.modelProbPct}% confidence=${e.confidence} grade=${e.grade} edge=${e.edge})`);
}

// -- 2. downstream surfaces: grade badge, Best Plays, Prime, +EV, Smart Parlay --
console.log('\n# no-history props cannot reach Best Plays / Prime / +EV / grade badge');
{
  const mk = (id, statsByKey, flagViaGate) => {
    const pl = { id, sport: 'nba', position: 'G', opponent: 'BOS', statsByKey, stats: statsByKey.points || {}, gameLogByKey: {}, opponentDefense: null, oppDef: null, props: [] };
    pl.props = [prop('points', 22.5, { plusEV: { eligible: true, modelDifference: 5, marketDifference: 5 }, hitRate: 88 })];
    if (flagViaGate) m.applyHistoryGate(pl.props, statsByKey);
    return pl;
  };
  const seeded = { points: seedWindows(0, 22.5) };
  const gated = mk('gated', seeded, true);
  const ungated = mk('ungated', seeded, false);   // engine alone must still fail closed (defence in depth)
  const real = Object.assign(realPlayer('nba', 'points', 22.5), { props: [prop('points', 22.5, { plusEV: { eligible: true, modelDifference: 5, marketDifference: 5 } })] });
  const all = [gated, ungated, real];

  check('applyHistoryGate flags the seeded prop modelSupported:false + INSUFFICIENT_DATA, drops synthetic hitRate, keeps the real line', gated.props[0].modelSupported === false && gated.props[0].modelState === m.MODEL_STATE_INSUFFICIENT && gated.props[0].hitRate === null && gated.props[0].line === 22.5 && gated.props[0].book === 'draftkings');
  check('applyHistoryGate leaves a real-history prop untouched', real.props[0].modelSupported !== false && real.props[0].modelState === undefined);
  const best = m.playerBestGrade(gated);
  check('playerBestGrade for a no-history player: grade null (no fabricated "D"), not Prime, noModel', best.grade === null && best.prime === false && best.noModel === true && best.modelState === m.MODEL_STATE_INSUFFICIENT);
  check('playerBestGrade also fails closed without the builder flag', (() => { const b = m.playerBestGrade(ungated); return b.grade === null && b.prime === false; })());
  check('playerBestGrade for a real-history player still grades', (() => { const b = m.playerBestGrade(real); return b.grade != null && 'ABCD'.includes(b.grade); })());

  const top = m.findTopPicks(all, 10).map(r => r.player.id);
  check('Top Picks / Best Plays excludes both no-history players, keeps the real one', !top.includes('gated') && !top.includes('ungated') && top.includes('p-nba-points'), top.join(','));
  const prime = m.findPrimePicks(all).map(r => r.player.id);
  check('Prime Plays never contains a no-history player', !prime.includes('gated') && !prime.includes('ungated'), prime.join(','));
  const ev = m.findPlusEVPicks(all).map(r => r.player.id);
  check('+EV list excludes the (flagged) no-history player even if a stale plusEV were attached', !ev.includes('gated'), ev.join(','));
  check('the real-history control is still a live pick (gate is not a blanket kill-switch)', top.includes('p-nba-points'));
}

// -- 3. gate boundaries --------------------------------------------------------
console.log('\n# gate boundaries');
{
  check('hasRealModelHistory: 1 real game with finite avg passes (policy minimum is the model-validation question, thinData still caps)', m.hasRealModelHistory({ season: { games: 1, avg: 12 } }));
  check('hasRealModelHistory: games 0 fails even with a real-looking avg', !m.hasRealModelHistory({ season: { games: 0, avg: 12 } }));
  check('hasRealModelHistory: avg null/NaN/undefined fails', !m.hasRealModelHistory({ season: { games: 10, avg: null } }) && !m.hasRealModelHistory({ season: { games: 10, avg: NaN } }) && !m.hasRealModelHistory({ season: { games: 10 } }));
  check('hasRealModelHistory: missing window / {} / null fails', !m.hasRealModelHistory(undefined) && !m.hasRealModelHistory({}) && !m.hasRealModelHistory(null));
  const e = m.calculateEdgeScore({ id: 'thin', sport: 'nba', position: 'G', opponent: 'BOS', statsByKey: { points: m.btWindowsAsOf([20, 24], ['BOS', 'MIA'], 'BOS', 22.5) }, stats: {}, gameLogByKey: {}, props: [] }, prop('points', 22.5));
  check('2 real games: still graded but flagged thinData (existing cap), not insufficient', e.insufficientData !== true && e.thinData === true && e.projection != null);
  const mlbSeeded = { avg: 0.9, hitRate: 62, games: 80, seeded: true };
  check('MLB-style seeded window with real season games passes the history gate (real season avg)', m.hasRealModelHistory({ season: mlbSeeded }));
}

// -- 4. Smart Parlay evidence --------------------------------------------------
console.log('\n# Smart Parlay: only real, line-specific game-log evidence');
{
  const fakeEdge = (src, pick) => ({ insufficientData: false, hitRatesSource: src, hitRates: { season: { pick }, last10: { pick } } });
  const p = prop('points', 22.5, { hitRate: 99 });
  check('seeded/estimated hit rate 95% is NOT eligible and yields null (no estHitRate substitute)', (() => { const s = m.smartParlayEligibility(fakeEdge('seeded_estimate', 95), p); return s.eligible === false && s.hitRate === null; })());
  check('window-derived (non-game-log) hit rate is NOT eligible', m.smartParlayEligibility(fakeEdge('window', 95), p).eligible === false);
  check('prop.hitRate placeholder (99) is ignored entirely', m.smartParlayEligibility({ insufficientData: false, hitRatesSource: 'window', hitRates: null }, p).hitRate === null);
  check('real game-log hit rate >= 80 IS eligible', (() => { const s = m.smartParlayEligibility(fakeEdge('game_log', 85), p); return s.eligible === true && s.hitRate === 85; })());
  check('real game-log hit rate < 80 is not eligible but is reported', (() => { const s = m.smartParlayEligibility(fakeEdge('game_log', 70), p); return s.eligible === false && s.hitRate === 70; })());
  check('provider-only / INSUFFICIENT prop is never eligible even with a game_log edge', m.smartParlayEligibility(fakeEdge('game_log', 99), Object.assign({}, p, { modelSupported: false })).eligible === false && m.smartParlayEligibility(fakeEdge('game_log', 99), Object.assign({}, p, { modelState: m.MODEL_STATE_INSUFFICIENT })).eligible === false);
  const gl = realPlayer('nba', 'points', 22.5, { games: 30, base: 40 });          // always way over the line -> real hit rate ~100%
  const eGl = m.calculateEdgeScore(gl, prop('points', 22.5));
  check('engine: a player with a real game log reports hitRatesSource "game_log"', eGl.hitRatesSource === 'game_log', String(eGl.hitRatesSource));
  const eNoGl = m.calculateEdgeScore(realPlayer('nba', 'points', 22.5, { games: 30, base: 40, noLog: true }), prop('points', 22.5));
  check('engine: same player WITHOUT a game log is "window", never "game_log" -> not eligible', eNoGl.hitRatesSource !== 'game_log' && m.smartParlayEligibility(eNoGl, prop('points', 22.5)).eligible === false, String(eNoGl.hitRatesSource));
  const eSeedMlb = m.calculateEdgeScore({ id: 'mlbs', sport: 'mlb', role: 'batter', position: 'SS', opponent: 'NYY', statsByKey: { hits: { recent: { avg: 0.9, hitRate: 62, median: 1, range: [0, 6], games: 80, seeded: true }, last5: { avg: 0.9, hitRate: 62, games: 5, seeded: true }, last10: { avg: 0.9, hitRate: 62, games: 10, seeded: true }, last20: { avg: 0.9, hitRate: 62, games: 20, seeded: true }, season: { avg: 0.9, hitRate: 62, games: 80, seeded: true }, vsOpp: { avg: 0.9, hitRate: 62, games: 0, seeded: true } } }, stats: {}, gameLogByKey: {}, props: [] }, prop('hits', 0.5, { hitRate: 62 }));
  // 2026-10-06 MLB clean candidate: a SEEDED MLB window is a placeholder, so the engine now withholds it entirely (INSUFFICIENT_DATA, MLB_HISTORY_NOT_LOADED) instead of scoring it with a 'seeded_estimate' source -- still never Smart-Parlay eligible.
  check('engine: MLB seeded windows (hitRate = estHitRate placeholder) are withheld (INSUFFICIENT_DATA, no probability/grade) and never Smart Parlay eligible', eSeedMlb.insufficientData === true && eSeedMlb.modelStateReason === 'MLB_HISTORY_NOT_LOADED' && eSeedMlb.modelProb == null && eSeedMlb.grade == null && m.smartParlayEligibility(eSeedMlb, prop('hits', 0.5)).eligible === false, String(eSeedMlb.hitRatesSource));

  // Source-level: the Smart Parlay UI block uses the gate, never prop.hitRate / realHR / estHitRate.
  const a = html.indexOf('const spGate = smartParlayEligibility(edge, activeProp);');
  check('Smart Parlay block uses smartParlayEligibility()', a > -1);
  const blk = a > -1 ? html.slice(a, a + 2500) : '';
  check('Smart Parlay block no longer falls back to activeProp.hitRate / estHitRate', !/realHR/.test(blk) && !/estHitRate/.test(blk) && !/\|\|\s*activeProp\.hitRate/.test(blk));
  check('Smart Parlay button explains a missing real hit rate instead of inventing one', /Smart Parlay needs a real game-log hit rate/.test(blk));
}

// -- 5. archived rows / sort / fantasy ---------------------------------------
console.log('\n# archive / sort / fantasy guards (source-level -- these live inside App)');
{
  const arch = html.slice(html.indexOf('function archivePropSnapshots'), html.indexOf('function allPropSnapshots'));
  check('archivePropSnapshots skips insufficient-data edges', /if \(!e \|\| e\.insufficientData\) return;/.test(arch));
  const sortSrc = html.slice(html.indexOf('const sortPropsByEdge'), html.indexOf('const sortPropsByEdge') + 1800);
  check('sortPropsByEdge ranks insufficient-data props last with no edge', /e\.insufficientData/.test(sortSrc) && /__edge = null/.test(sortSrc));
  const fb = html.slice(html.indexOf('function fbProjectFantasy'), html.indexOf('function fbFpAllowedByPos'));
  check('fantasy projection requires real history (no 0 stand-in)', /hasRealModelHistory\(w\)/.test(fb) && /hasRealModelHistory\(player\.stats\)/.test(fb));
  const n = (html.match(/return applyHistoryGate\(props, statsByKey\);/g) || []).length;
  const nMlb = (html.match(/return applyMlbModelGates\(props, statsByKey\);/g) || []).length;   // MLB (2026-10-06): its two returns now use applyMlbModelGates (real-window history gate + sub-1 fail-closed gate)
  check('every prop builder post-passes through its history gate (NFL/CFB + NBA/WNBA via applyHistoryGate; MLB x2 returns via applyMlbModelGates)', n >= 2 && nMlb === 2 && /const applyMlbModelGates = [\s\S]{0,900}hasRealModelHistory\(w\)/.test(html), 'count=' + n + '/' + nMlb);
}

// -- 6. NBA opponent-defense effect REMOVED (2026-10-06) -- this section replaces the earlier CHARACTERIZATION of the defect --
// History (kept as documentation): before the removal a points-rank nudge `projection += (rank - 15.5) * 0.12` added +4.14 / +7.14 / +10.14 / +16.14
// stat units at points-rank 50 / 75 / 100 / 150 to EVERY NBA prop type (rebounds, blocks, ... included). The walk-forward comparison against the
// no-defense model rejected it (tmp/model-integrity/nba-defense*/report.md), and it was removed. The full proof lives in scripts/test-nba-defense-removed-and-parity.js.
console.log('\n# RESOLVED: the generic NBA points-rank nudge no longer moves any NBA projection');
{
  const dvp = (rank) => ({ byPosition: { G: { rank, rebRank: 75, astRank: 75, tpmRank: 75, stlRank: 75, blkRank: 75, toRank: 75, pointsAllowed: 25, reboundsAllowed: 5, assistsAllowed: 5, threesAllowed: 2, stealsAllowed: 1, blocksAllowed: 1, turnoversAllowed: 2 } } });
  const proj = (statKey, rank) => m.calculateEdgeScore(Object.assign(realPlayer('nba', statKey, 20.5, { games: 30, base: 20 }), { opponentDefense: rank == null ? null : dvp(rank) }), prop(statKey, 20.5)).projection;
  const stats = ['points', 'rebounds', 'assists', 'threes', 'steals', 'blocks', 'turnovers', 'pra', 'pr', 'pa', 'ra', 'blocksSteals'];
  check('with ANY points-rank (1, 50, 75, 100, 150) every NBA prop type projects exactly as with no defense data', stats.every(s => [1, 50, 75, 100, 150].every(rk => proj(s, rk) === proj(s, null))));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
