// NBA opponent-defense REMOVAL + LIVE=BACKTEST PARITY (model nba-edge-2026.10-nodef-v1).
//
// Proves, on the REAL shipped functions extracted from BeatsEdge.html:
//   1. no opponent-defense input of any kind can alter an NBA projection / probability / confidence / grade inputs / Prime (all 12 prop
//      families incl. every combo, both sides) -- including the live-only inputs `opponentDefense`, `oppRank` and per-game `oppRank`;
//   2. matchup defense is still available as PRESENTATION-ONLY context, explicitly labeled, never in `factors`;
//   3. missing history still fails closed for NBA;
//   4. LIVE = BACKTEST: one model implementation, inputs built by the live builders, and a live-shaped player (with every defense input the
//      live path supplies) scores bit-identically to the historical-shaped player (none of them);
//   5. WNBA: only the 2026-10-06 integrity changes (see scripts/test-wnba-integrity.js); its weights/cap/calibration are still unvalidated -- pinned so a change there is deliberate;
//   6. model-version / trace metadata (defense feature = NONE) is present and honest about the calibration in force.
//
//   node scripts/test-nba-defense-removed-and-parity.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadModel, liveNbaSnippet, sliceArrowFn, HTML_PATH } = require('./lib/loadBeatsEdgeModel');
const { buildLiveShapedNbaPlayer, toGlRow } = require('./lib/nbaHistoricalInputs');

let failures = 0;
function check(name, cond, detail) { if (cond) console.log(`PASS  ${name}`); else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); } }
const skip = (name, why) => console.log(`SKIP  ${name}  -- ${why}`);

const m = loadModel({ liveNba: true });
const html = fs.readFileSync(HTML_PATH, 'utf8');
const FUTURE = Date.now() + 6 * 3600e3;
const FAMILIES = ['points', 'rebounds', 'assists', 'threes', 'steals', 'blocks', 'turnovers', 'pra', 'pr', 'pa', 'ra', 'blocksSteals'];
const COMBOS = ['pra', 'pr', 'pa', 'ra', 'blocksSteals'];
const prop = (statKey, line, direction) => ({ statKey, type: statKey, line, direction, lineSource: 'ParlayAPI · draftkings', eventId: 'ev1', commenceTimeMs: FUTURE, book: 'draftkings', odds: -115, oppOdds: -105 });
const CORE = ['projection', 'modelProb', 'modelProbPct', 'rawModelProbPct', 'preFloorProbPct', 'sportCalibProbPct', 'familyAdjPts', 'confidence', 'greenCount', 'totalFactors', 'grade', 'gradeScore', 'edge', 'edgePct', 'edgeSignalPct', 'prime', 'thinData', 'matchupLabel', 'impliedProb'];
const sig = (e) => JSON.stringify({ core: CORE.map(k => e[k]), steps: e.probSteps, factors: e.factors.map(f => [f.key, f.supports, f.detail, f.probDelta]), hit: e.hitRates, src: e.hitRatesSource });

// ---- synthetic player generator (no DB needed) ------------------------------------------------
function synthPlayer(seed, withDefense) {
  let a = seed >>> 0; const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const opps = ['BOS', 'MIA', 'NYK', 'CHI', 'DEN', 'PHX'];
  const hist = Array.from({ length: 60 }, (_, i) => ({ game_id: 'g' + seed + '_' + i, athlete_id: 'a' + seed, season: 2024, season_type: 2, game_date: new Date(Date.UTC(2024, 9, 25) + i * 2 * 864e5).toISOString().slice(0, 10),
    team: 'LAL', opponent: opps[i % 6], home_away: i % 2 ? 'home' : 'away', pos_group: 'F', minutes: 28 + Math.round(r() * 10), points: Math.round(8 + r() * 22), rebounds: Math.round(2 + r() * 9), assists: Math.round(r() * 8),
    threes: Math.round(r() * 5), steals: Math.round(r() * 3), blocks: Math.round(r() * 2.4), turnovers: Math.round(r() * 5) }));
  const target = { game_id: 'gt' + seed, athlete_id: 'a' + seed, season: 2024, season_type: 2, game_date: '2025-03-01', team: 'LAL', opponent: 'BOS', home_away: 'home', pos_group: 'F' };
  const lineFor = { points: 15.5, rebounds: 5.5, assists: 3.5, threes: 1.5, steals: 0.5, blocks: 0.5, turnovers: 2.5, pra: 24.5, pr: 20.5, pa: 19.5, ra: 8.5, blocksSteals: 1.5 };
  const rankMap = { BOS: 3, MIA: 28, NYK: 12, CHI: 22, DEN: 8, PHX: 18 };
  const dvp = (rk) => ({ byPosition: { G: {}, C: {}, F: { rank: rk, rebRank: rk, astRank: rk, tpmRank: rk, stlRank: rk, blkRank: rk, toRank: rk, pointsAllowed: 24.4, reboundsAllowed: 9.1, assistsAllowed: 5.2, threesAllowed: 2.9, stealsAllowed: 1.4, blocksAllowed: 1.1, turnoversAllowed: 2.6, sub: 'SF #1, PF #2' } } });
  return buildLiveShapedNbaPlayer(m, { target, hist, lineFor, prevTeamDate: '2025-02-28',
    ...(withDefense ? { oppRankByAbbr: rankMap, opponentDefense: dvp(withDefense), oppRank: rankMap.BOS } : {}) });
}

console.log('# 1. opponent defense cannot alter any NBA model number');
{
  let compared = 0, diffs = [];
  for (const seed of [11, 22, 33, 44]) {
    const base = synthPlayer(seed, 0);
    for (const rk of [1, 25, 50, 75, 101, 150]) {
      const withDef = synthPlayer(seed, rk);
      for (const k of FAMILIES) for (const dir of ['over', 'under']) {
        const a = m.calculateEdgeScore(base, prop(k, base.gameLogByKey[k][0].line, dir)), b = m.calculateEdgeScore(withDef, prop(k, withDef.gameLogByKey[k][0].line, dir));
        compared++; if (sig(a) !== sig(b)) diffs.push(`${seed}/${rk}/${k}/${dir}`);
      }
    }
  }
  check(`${compared} (player x defense-rank x family x side) comparisons: projection, probability, calibrated probability, confidence, factors, probSteps, grade inputs, grade, Prime all identical with vs without defense inputs`, diffs.length === 0, diffs.slice(0, 5).join(' '));
  const w = synthPlayer(55, 150);
  check('the defense inputs really were present on the "with defense" player (test is not vacuous)', w.opponentDefense && w.opponentDefense.byPosition.F.rank === 150 && w.oppRank === 3 && w.gameLogByKey.points.some(g => g.oppRank != null));
  check('combo families (PRA, PR, PA, RA, BLK+STL) cannot receive a hidden component-defense adjustment', COMBOS.every(k => [1, 150].every(rk => m.calculateEdgeScore(synthPlayer(7, rk), prop(k, 20.5, 'over')).projection === m.calculateEdgeScore(synthPlayer(7, 0), prop(k, 20.5, 'over')).projection)));
  check('the old points-rank nudge numbers are gone (rank 150 vs none: shift = 0.0)', ['points', 'rebounds', 'blocks', 'pra'].every(k => m.calculateEdgeScore(synthPlayer(9, 150), prop(k, 5.5, 'over')).projection - m.calculateEdgeScore(synthPlayer(9, 0), prop(k, 5.5, 'over')).projection === 0));
  // source-level: the three removed paths
  const impl = html.slice(html.indexOf('function _calculateEdgeScoreImpl(player, prop) {'), html.indexOf('const GRADE_RANK = {'));
  check('source: generic nudge guarded off for NBA', /sport !== 'nfl' && sport !== 'ncaaf' && sport !== 'nba'\) \{\s*\n[\s\S]{0,400}defAdjustment/.test(impl));
  check('source: stat-specific NBA multiplier is gone', !/\(rk - 75\.5\) \/ 74\.5/.test(impl) && !/rkField/.test(impl));
  check('source: no NBA code path pushes a defense/simdef item into `factors`', !/factors\.push\(\{\s*\n\s*key: 'defense',\s*\n\s*name: `\$\{player\.opponent\} vs \$\{grpWord\}`/.test(impl));
}

console.log('\n# 2. matchup defense stays available as presentation-only context');
{
  const p = synthPlayer(21, 140);
  const e = m.calculateEdgeScore(p, prop('rebounds', p.gameLogByKey.rebounds[0].line, 'over'));
  const d = (e.context || []).find(x => x.key === 'defense');
  check('a soft matchup produces a `defense` context item (truthful numbers, rank shown)', !!d && /#140 of 150/.test(d.detail));
  check('the context item is explicitly labeled context-only and flagged contextOnly', d && d.contextOnly === true && /^Context only/.test(d.label));
  check('the context item is NOT in `factors` (cannot move confidence / probability / grade)', !e.factors.some(f => f.key === 'defense') && !e.factors.some(f => f.contextOnly));
  const none = m.calculateEdgeScore(synthPlayer(21, 0), prop('rebounds', 5.5, 'over'));
  check('no defense data => no context item (nothing invented)', (none.context || []).length === 0);
  // similar-defense history split (opponent-rank-keyed): context for NBA
  const withRank = synthPlayer(31, 60);
  // force the similar-defense split to fire: big games vs the stingy (rank <= 9) opponents, small games elsewhere
  withRank.gameLogByKey.points.forEach(g => { g.points = (g.oppRank != null && g.oppRank <= 9) ? 34 : 8; });
  const simE = m.calculateEdgeScore(withRank, prop('points', 20.5, 'over'));
  check('similar-ranked-defense split FIRES on the crafted fixture and appears only as context for NBA', (simE.context || []).some(x => x.key === 'simdef' && x.contextOnly) && !simE.factors.some(f => f.key === 'simdef'));
  const wSim = synthPlayer(31, 60); wSim.sport = 'wnba'; wSim.gameLogByKey.points.forEach(g => { g.points = (g.oppRank != null && g.oppRank <= 9) ? 34 : 8; });
  const wE = m.calculateEdgeScore(wSim, prop('points', 20.5, 'over'));
  check('WNBA (2026-10-06 integrity phase): the same split is now context-only too -- placebo-equivalent, not a defense signal (see scripts/test-wnba-integrity.js)', !wE.factors.some(f => f.key === 'simdef') && (wE.context || []).some(x => x.key === 'simdef' && x.contextOnly));
  const ui = html.indexOf('const facBy = (k) => (edge.factors || []).find(f => f.key === k) || (edge.context || []).find(f => f.key === k);');
  check('UI: research modal reads context items (matchup section keeps its information)', ui > -1);
  check('UI: context rows are rendered with a "context only" label', /whiteSpace: 'nowrap' \}\}>context only<\/span>/.test(html));
}

console.log('\n# 3. missing history still fails closed (NBA)');
{
  const e0 = (w) => m.calculateEdgeScore({ id: 'nh' + Math.random(), sport: 'nba', position: 'G', opponent: 'BOS', statsByKey: { points: w }, stats: w, gameLogByKey: {}, opponentDefense: { byPosition: { G: { rank: 140 } } }, props: [] }, prop('points', 20.5, 'under'));
  const seeded = { avg: 0, hitRate: 50, games: 0, seeded: true };
  const w = { recent: { avg: 0, hitRate: 50, median: 0, range: [0, 1], games: 0, seeded: true }, last5: seeded, last10: seeded, last20: seeded, season: seeded, vsOpp: seeded };
  const e = e0(w);
  check('seeded zero-history NBA prop (with a defense object present) => INSUFFICIENT_DATA, all model fields null', e.insufficientData === true && e.projection === null && e.modelProb === null && e.grade === null && e.edge === null && e.prime === false);
}

console.log('\n# 4. LIVE = BACKTEST');
{
  const implStarts = (html.match(/function _calculateEdgeScoreImpl\(/g) || []).length, calcDefs = (html.match(/function calculateEdgeScore\(/g) || []).length;
  check('exactly ONE model implementation exists (`_calculateEdgeScoreImpl`) behind ONE entry point (`calculateEdgeScore`)', implStarts === 1 && calcDefs === 1);
  check('the projection blend formula exists in exactly one place', (html.match(/\(recentAvgS \* 0\.35\)/g) || []).length === 1);
  const bt = ['function backtestSeries(', 'function mlbBacktestSeries(', 'function nflBacktestSeries('].map(n => { const i = html.indexOf(n); return html.slice(i, i + 4500); });
  check('every in-app backtest scores through calculateEdgeScore (no private formula)', bt.every(s => /calculateEdgeScore\(/.test(s)));
  check('in-app NBA backtests never feed a defense input (opponentDefense: null / oppRank: null) -- same as the post-removal live model', (html.match(/opponentDefense: null, oppRank: null/g) || []).length >= 2 && /opponentDefense: null, oppDef: null, situational: null/.test(bt[0]));
  // the harness builders ARE the live source
  const snip = liveNbaSnippet(html), live = sliceArrowFn(html, 'const nbaComputeWindows = (glRows, lineFor, oppAbbr, oppRankByAbbr, seasonYear) => {');
  const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
  check('historical-validation window builder is byte-identical to the live `nbaComputeWindows` source', snip.includes(live) && h(live).length === 64);
  check('historical-validation minutes-trend builder is byte-identical to the live source', snip.includes(sliceArrowFn(html, 'const nbaMinutesTrend = (glRows) => {')));
  check('the live call site uses the same builder (nbaComputeWindows(glRows, lineFor, slot.opponent, ...)) ', /nbaComputeWindows\(glRows, lineFor, slot\.opponent, nbaCache\.current\.oppRankByAbbr, NBA_YR_CUR\)/.test(html));

  // numeric parity on synthetic AND real rows: live-shaped (every defense input the live path supplies) vs historical-shaped (none)
  const cmpFields = ['projection', 'modelProbPct', 'confidence', 'gradeScore', 'greenCount', 'totalFactors', 'edgeSignalPct', 'edge', 'grade', 'prime', 'thinData'];
  let n = 0, bad = [];
  const both = (liveP, histP, tag) => { for (const k of FAMILIES) for (const dir of ['over', 'under']) { const pr = prop(k, histP.gameLogByKey[k][0].line, dir); const a = m.calculateEdgeScore(liveP, pr), b = m.calculateEdgeScore(histP, Object.assign({}, pr)); n++;
    if (cmpFields.some(f => a[f] !== b[f]) || JSON.stringify(a.probSteps) !== JSON.stringify(b.probSteps)) bad.push(tag + '/' + k + '/' + dir); } };
  [101, 202, 303, 404, 505].forEach(seed => both(synthPlayer(seed, 130), synthPlayer(seed, 0), 'synth' + seed));
  check(`synthetic: ${n} live-shaped (defense inputs present) vs historical-shaped (absent) scorings are identical in projection, probability, edge inputs and grade inputs`, bad.length === 0, bad.slice(0, 4).join(' '));

  const dbPath = path.join(__dirname, '..', 'data', 'beatsedge.db');
  if (!fs.existsSync(dbPath)) skip('real box-score rows parity', 'data/beatsedge.db not present');
  else {
    const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(dbPath, { readOnly: true });
    const ids = db.prepare(`SELECT athlete_id FROM nba_player_box WHERE season = 2024 AND season_type = 2 AND played = 1 AND minutes > 15 GROUP BY athlete_id HAVING COUNT(*) >= 60 ORDER BY athlete_id LIMIT 8`).all().map(r => r.athlete_id);
    let nReal = 0, badReal = [], builtFromReal = 0;
    for (const id of ids) {
      const rows = db.prepare(`SELECT game_id, athlete_id, season, season_type, game_date, team, opponent, home_away, pos_group, minutes, points, rebounds, assists, threes, steals, blocks, turnovers FROM nba_player_box
        WHERE athlete_id = ? AND season IN (2023, 2024) AND played = 1 AND minutes > 0 AND points IS NOT NULL AND rebounds IS NOT NULL AND assists IS NOT NULL AND threes IS NOT NULL AND steals IS NOT NULL AND blocks IS NOT NULL AND turnovers IS NOT NULL ORDER BY game_date, game_id`).all(id);
      for (const i of [40, 70, rows.length - 1]) {
        if (i < 20 || i >= rows.length) continue; const target = rows[i], hist = rows.slice(0, i); builtFromReal++;
        const lineFor = Object.fromEntries(FAMILIES.map(k => [k, (k === 'points' ? 15.5 : k === 'pra' ? 24.5 : k === 'pr' ? 20.5 : k === 'pa' ? 19.5 : k === 'ra' ? 8.5 : k === 'blocksSteals' ? 1.5 : k === 'turnovers' ? 2.5 : k === 'rebounds' ? 5.5 : k === 'assists' ? 3.5 : k === 'threes' ? 1.5 : 0.5)]));
        const liveP = buildLiveShapedNbaPlayer(m, { target, hist, lineFor, prevTeamDate: hist[hist.length - 1].game_date, oppRankByAbbr: { [target.opponent]: 4 }, opponentDefense: { byPosition: { [target.pos_group]: { rank: 148, rebRank: 3, astRank: 77, tpmRank: 120, stlRank: 10, blkRank: 149, toRank: 60 } } }, oppRank: 4 });
        const histP = buildLiveShapedNbaPlayer(m, { target, hist, lineFor, prevTeamDate: hist[hist.length - 1].game_date });
        for (const k of FAMILIES) for (const dir of ['over', 'under']) { const pr = prop(k, lineFor[k], dir); const a = m.calculateEdgeScore(liveP, pr), b = m.calculateEdgeScore(histP, Object.assign({}, pr)); nReal++;
          if (cmpFields.some(f => a[f] !== b[f]) || JSON.stringify(a.probSteps) !== JSON.stringify(b.probSteps)) badReal.push(id + '/' + i + '/' + k + '/' + dir); }
      }
    }
    check(`real box-score rows: ${nReal} scorings across ${builtFromReal} real player-games identical between live-shaped and historical-shaped inputs`, nReal > 0 && badReal.length === 0, badReal.slice(0, 4).join(' '));
    const x = db.prepare(`SELECT COUNT(*) c FROM nba_player_box WHERE season = 2024`).get();
    check('real data present for the parity run', x.c > 1000);
  }
  // determinism
  const p1 = synthPlayer(77, 90), p2 = synthPlayer(77, 90), pr1 = prop('points', 15.5, 'over');
  check('same inputs twice => identical output (deterministic, no hidden state)', sig(m.calculateEdgeScore(p1, pr1)) === sig(m.calculateEdgeScore(p2, Object.assign({}, pr1))));
}

console.log('\n# 5. WNBA: integrity changes only -- weights/cap/calibration REQUIRE SEPARATE VALIDATION');
{
  const wp = (rk) => { const p = synthPlayer(88, rk); p.sport = 'wnba'; return p; };
  const k = 'rebounds', line = 5.5;
  const a = m.calculateEdgeScore(wp(150), prop(k, line, 'over')), b = m.calculateEdgeScore(wp(0), prop(k, line, 'over'));
  check('WNBA: the generic points-rank nudge path is still present (dormant in production because wnbaDvpFor() returns null) -- pinned, not endorsed', a.projection !== b.projection);
  check('WNBA: wnbaDvpFor still returns null in the app (so the nudge is not live today)', /const wnbaDvpFor = \(\) => null;/.test(html));
  check('WNBA: `simdef` is context-only for NBA and WNBA (WNBA changed in the 2026-10-06 integrity phase)', /\(sport === 'nba' \|\| sport === 'wnba'\) \? contextFactors : factors\)\.push\(\{\s*\n\s*key: 'simdef'/.test(html));
  check('WNBA: modelMeta carries the frozen WNBA BETA spec (never the NBA model version)', a.modelMeta && a.modelMeta.modelVersion !== 'nba-edge-2026.10-nodef-v1' && a.modelMeta.sport === 'wnba' && a.modelMeta.modelState === 'BETA' && a.modelMeta.modelVersion === 'wnba-edge-2026.10-nodef-v1');
}

console.log('\n# 6. model version / trace metadata');
{
  const p = synthPlayer(5, 100), e = m.calculateEdgeScore(p, prop('points', 15.5, 'over'));
  const mm = e.modelMeta;
  check('NBA edge carries modelMeta with version, feature set, defense feature NONE and calibration id', mm && mm.modelVersion === 'nba-edge-2026.10-nodef-v1' && mm.featureSet === 'nba-window-blend-v1' && mm.defenseFeature === 'NONE' && mm.calibrationId === 'nba-defaults-2026-10-06' && mm.sport === 'nba' && mm.league === 'NBA');
  check('declared state is BETA (new version; UI gating not implemented)', mm.modelState === 'BETA');
  m.__setGradeCutoffs({ nba: { A: 0.8, B: 0.6, C: 0.4 } });
  check('a browser-local NBA cutoff set can no longer change the reported calibration id (NBA authority is the versioned config)', m.nbaModelMeta().calibrationId === 'nba-defaults-2026-10-06');
  m.__setGradeCutoffs({});
  check('archive rows carry modelMeta inside the existing dataQuality JSON (no schema migration)', /modelMeta: e\.modelMeta \|\| null/.test(html));
  const arch = html.slice(html.indexOf('function archivePropSnapshots'), html.indexOf('function allPropSnapshots'));
  check('insufficient-data edges are still never archived', /if \(!e \|\| e\.insufficientData\) return;/.test(arch));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
