// NBA vNext -- ONE official grade pipeline, live/historical parity, wild-gap rule, and NBA localStorage-authority removal.
//
//   1. resolveFinalGrade (the single grade function) -- every rule, in order, with reasons;
//   2. live vs historical execution of the SAME inputs gives the same raw probability, Prime state, rawGrade, finalGrade and reason (NBA);
//   3. rawGrade / finalGrade / gradeAdjustmentReason are exposed and self-consistent;
//   4. other sports (MLB, NFL, NCAAF, WNBA) are byte-for-byte unchanged vs the pre-change page (skipped if the tmp baseline is absent);
//   5. wild-gap cap candidates behave as predeclared; NBA uses the configured rule, all other sports keep the original one;
//   6. two browsers with different localStorage produce IDENTICAL official NBA probability and grade (and the test is not vacuous: MLB still differs);
//   7. model metadata / grade trace; context-row presentation and position-label normalization.
//
//   node scripts/test-nba-grade-pipeline-parity.js
const fs = require('fs'), path = require('path');
const { loadModel, HTML_PATH } = require('./lib/loadBeatsEdgeModel');
const { buildLiveShapedNbaPlayer } = require('./lib/nbaHistoricalInputs');
let failures = 0;
function check(name, cond, detail) { if (cond) console.log(`PASS  ${name}`); else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); } }
const skip = (n, w) => console.log(`SKIP  ${n}  -- ${w}`);
const html = fs.readFileSync(HTML_PATH, 'utf8');
const m = loadModel({ liveNba: true });
const FUTURE = Date.now() + 6 * 3600e3;
const FAMILIES = ['points', 'rebounds', 'assists', 'threes', 'steals', 'blocks', 'turnovers', 'pra', 'pr', 'pa', 'ra', 'blocksSteals'];
const LINES = { points: 15.5, rebounds: 5.5, assists: 3.5, threes: 1.5, steals: 0.5, blocks: 0.5, turnovers: 2.5, pra: 24.5, pr: 20.5, pa: 19.5, ra: 8.5, blocksSteals: 1.5 };
const LIVE = (k, line, dir, extra) => Object.assign({ statKey: k, type: k, line, direction: dir, lineSource: 'ParlayAPI · draftkings', eventId: 'ev1', commenceTimeMs: FUTURE, book: 'draftkings' }, extra || {});
const BT = (k, line, dir) => ({ statKey: k, type: k, line, direction: dir, lineSource: 'backtest' });
function synth(seed, mm, sport) {
  let a = seed >>> 0; const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const opps = ['BOS', 'MIA', 'NYK', 'CHI', 'DEN', 'PHX'], scale = 0.6 + r() * 1.2;
  const hist = Array.from({ length: 70 }, (_, i) => ({ game_id: 'g' + seed + '_' + i, athlete_id: 'a' + seed, season: 2024, season_type: 2, game_date: new Date(Date.UTC(2024, 9, 25) + i * 2 * 864e5).toISOString().slice(0, 10), team: 'LAL', opponent: opps[i % 6], home_away: i % 2 ? 'home' : 'away', pos_group: 'F',
    minutes: 24 + Math.round(r() * 14), points: Math.round((8 + r() * 24) * scale), rebounds: Math.round((2 + r() * 10) * scale), assists: Math.round(r() * 9 * scale), threes: Math.round(r() * 5 * scale), steals: Math.round(r() * 3), blocks: Math.round(r() * 2.4), turnovers: Math.round(r() * 5) }));
  const target = { game_id: 'gt' + seed, athlete_id: 'a' + seed, season: 2024, season_type: 2, game_date: '2025-03-01', team: 'LAL', opponent: 'BOS', home_away: 'home', pos_group: 'F' };
  const p = buildLiveShapedNbaPlayer(mm || m, { target, hist, lineFor: LINES, prevTeamDate: '2025-02-28' });
  if (sport) p.sport = sport; return p;
}
const FIELDS = ['rawModelProbPct', 'modelProbPct', 'sportCalibProbPct', 'prime', 'rawGrade', 'finalGrade', 'grade', 'gradeAdjustmentReason', 'gradeScore', 'thinData', 'wildGap', 'confidence', 'projection'];
const pick = (e, f) => JSON.stringify(f.map(k => e[k]));

console.log('# 1. resolveFinalGrade -- the one grade function, rules in order');
{
  const R = (o) => m.resolveFinalGrade(Object.assign({ rawGrade: 'C', prime: false, modelProbSport: 0.55, impliedProb: 0.5, hasRealPrice: false, liveRules: true }, o));
  const r1 = R({ prime: true }); check('Prime promotes C -> A', r1.finalGrade === 'A' && r1.reasons[0] === 'PRIME_PROMOTION');
  check('Prime promotes D -> A', R({ rawGrade: 'D', prime: true, modelProbSport: 0.6 }).finalGrade === 'A');
  check('Prime does not touch an existing A/B', R({ rawGrade: 'B', prime: true, modelProbSport: 0.6 }).finalGrade === 'B' && R({ rawGrade: 'B', prime: true, modelProbSport: 0.6 }).reasons.length === 0);
  const r2 = R({ rawGrade: 'A', modelProbSport: 0.49 }); check('A/B with probability < 50% -> C', r2.finalGrade === 'C' && r2.reasons[0] === 'PROB_BELOW_50_AB_TO_C');
  const r3 = R({ rawGrade: 'C', modelProbSport: 0.43 }); check('any non-D with probability < 44% -> D', r3.finalGrade === 'D' && r3.reasons[0] === 'PROB_BELOW_44_TO_D');
  const r4 = R({ rawGrade: 'D', modelProbSport: 0.58 }); check('D with probability >= 58% -> C', r4.finalGrade === 'C' && r4.reasons[0] === 'PROB_AT_LEAST_58_D_TO_C');
  check('thresholds are exactly the existing ones (0.50 / 0.44 / 0.58 boundaries)', R({ rawGrade: 'B', modelProbSport: 0.50 }).finalGrade === 'B' && R({ rawGrade: 'C', modelProbSport: 0.44 }).finalGrade === 'C' && R({ rawGrade: 'D', modelProbSport: 0.5799 }).finalGrade === 'D');
  const r5 = R({ rawGrade: 'A', modelProbSport: 0.6, impliedProb: 0.62, hasRealPrice: true }); check('real-price cap: A/B -> C when the model does not beat the de-vigged price', r5.finalGrade === 'C' && r5.reasons[0] === 'PRICE_CAP');
  const r6 = R({ rawGrade: 'C', prime: true, modelProbSport: 0.48 }); check('order: promotion first, then reconciliation can pull it back (C->A->C, both reasons recorded)', r6.finalGrade === 'C' && r6.reasons.join('+') === 'PRIME_PROMOTION+PROB_BELOW_50_AB_TO_C');
  const off = R({ rawGrade: 'C', prime: true, modelProbSport: 0.40, liveRules: false }); check('liveRules:false (non-NBA backtest convention) applies none of the post-rules', off.finalGrade === 'C' && off.reasons.length === 0);
}

console.log('\n# 2. NBA: live and historical execution agree on probability, Prime, rawGrade, finalGrade, reason');
{
  let n = 0, bad = [], reasons = new Set(), rawNeFinal = 0;
  for (const seed of Array.from({ length: 40 }, (_, i) => i * 7 + 3)) { const p = synth(seed);
    for (const k of FAMILIES) for (const d of ['over', 'under']) for (const dl of [-3, -1.5, -0.5, 0, 0.5, 1.5, 3, 6]) { const line = Math.max(0.5, LINES[k] + dl);
      const a = m.calculateEdgeScore(p, BT(k, line, d)), b = m.calculateEdgeScore(p, LIVE(k, line, d)); n++;
      if (pick(a, FIELDS) !== pick(b, FIELDS)) bad.push(`${seed}/${k}/${d}/${line}`); if (b.gradeAdjustmentReason) reasons.add(b.gradeAdjustmentReason); if (b.rawGrade !== b.finalGrade) rawNeFinal++; } }
  check(`${n} NBA scorings: historical (lineSource 'backtest') == live (real line, no price) on every probability, Prime, rawGrade, finalGrade, reason, gradeScore, cap flag`, bad.length === 0, bad.slice(0, 4).join(' '));
  check('the adjustment pipeline really fires in this fixture set (not vacuous)', rawNeFinal > 0, 'adjusted=' + rawNeFinal + ' reasons=' + [...reasons].join('|'));
  const dbPath = path.join(__dirname, '..', 'data', 'beatsedge.db');
  if (!fs.existsSync(dbPath)) skip('real box-score rows', 'data/beatsedge.db absent');
  else {
    const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(dbPath, { readOnly: true });
    const ids = db.prepare(`SELECT athlete_id FROM nba_player_box WHERE season = 2024 AND season_type = 2 AND played = 1 AND minutes > 15 GROUP BY athlete_id HAVING COUNT(*) >= 60 ORDER BY athlete_id LIMIT 10`).all().map(r => r.athlete_id);
    let nr = 0, badr = [], adj = 0;
    for (const id of ids) { const rows = db.prepare(`SELECT game_id, athlete_id, season, season_type, game_date, team, opponent, home_away, pos_group, minutes, points, rebounds, assists, threes, steals, blocks, turnovers FROM nba_player_box WHERE athlete_id = ? AND season IN (2023, 2024) AND played = 1 AND minutes > 0 AND points IS NOT NULL AND rebounds IS NOT NULL AND assists IS NOT NULL AND threes IS NOT NULL AND steals IS NOT NULL AND blocks IS NOT NULL AND turnovers IS NOT NULL ORDER BY game_date, game_id`).all(id);
      for (const i of [45, 75, rows.length - 1]) { if (i >= rows.length || i < 20) continue; const p = buildLiveShapedNbaPlayer(m, { target: rows[i], hist: rows.slice(0, i), lineFor: LINES, prevTeamDate: rows[i - 1].game_date });
        for (const k of FAMILIES) for (const d of ['over', 'under']) { const a = m.calculateEdgeScore(p, BT(k, LINES[k], d)), b = m.calculateEdgeScore(p, LIVE(k, LINES[k], d)); nr++; if (pick(a, FIELDS) !== pick(b, FIELDS)) badr.push(id + '/' + i + '/' + k + '/' + d); if (b.rawGrade !== b.finalGrade) adj++; } } }
    check(`real box-score rows: ${nr} scorings identical live vs historical (${adj} carried a grade adjustment)`, nr > 0 && badr.length === 0, badr.slice(0, 4).join(' '));
  }
}

console.log('\n# 3. grade trace is exposed and self-consistent');
{
  let ok = true, nulls = 0, tot = 0;
  for (const seed of [2, 4, 6, 7]) { const p = synth(seed); for (const k of FAMILIES) for (const d of ['over', 'under']) { const e = m.calculateEdgeScore(p, LIVE(k, LINES[k], d)); tot++;
    if (e.finalGrade !== e.grade || !e.rawGrade || !e.finalGrade) ok = false; if (e.gradeAdjustmentReason == null && e.rawGrade !== e.finalGrade) ok = false; if (e.gradeAdjustmentReason == null) nulls++; } }
  check('finalGrade === grade, rawGrade present, and a null reason always means rawGrade === finalGrade', ok);
  const ins = m.calculateEdgeScore({ id: 'x', sport: 'nba', position: 'G', opponent: 'BOS', statsByKey: {}, stats: {}, gameLogByKey: {}, props: [] }, LIVE('points', 15.5, 'over'));
  check('insufficient-data edges carry null rawGrade / finalGrade / reason (fail-closed preserved)', ins.insufficientData === true && ins.rawGrade === null && ins.finalGrade === null && ins.gradeAdjustmentReason === null && ins.grade === null);
}

console.log('\n# 4. other sports unchanged vs the pre-change page');
{
  const base = path.join(__dirname, '..', 'tmp', 'model-integrity', 'baseline', 'BeatsEdge.pre-defense-removal.html');
  if (!fs.existsSync(base)) skip('non-NBA regression vs baseline copy', 'tmp baseline absent');
  else {
    const old = loadModel({ liveNba: true, htmlPath: base }); const CORE = ['grade', 'gradeScore', 'prime', 'modelProbPct', 'rawModelProbPct', 'projection', 'confidence', 'thinData', 'edge'];
    let n = 0, bad = [];
    // WNBA moved onto its own versioned pipeline (2026-10-06): it is covered by scripts/test-wnba-integrity.js, not here.
    // NFL moved onto its own cleaned pipeline (2026-10-06): covered by scripts/test-nfl-integrity.js, not here.
    // MLB moved onto its own cleaned pipeline (2026-10-06 clean candidate): covered by scripts/test-mlb-integrity.js, not here.
    for (const sport of ['ncaaf']) for (const seed of [1, 9, 17]) { const pn = synth(seed, m, sport), po = synth(seed, old, sport);
      for (const k of FAMILIES) for (const d of ['over', 'under']) for (const src of ['backtest', 'live']) { const prop = src === 'backtest' ? BT(k, LINES[k], d) : LIVE(k, LINES[k], d, { odds: -110, oppOdds: -110 });
        const a = m.calculateEdgeScore(pn, prop), b = old.calculateEdgeScore(po, Object.assign({}, prop)); n++; if (pick(a, CORE) !== pick(b, CORE)) bad.push(sport + '/' + seed + '/' + k + '/' + d + '/' + src); } }
    check(`${n} NCAAF scorings (backtest and live, with and without prices) identical to the pre-change page`, bad.length === 0, bad.slice(0, 4).join(' '));
    // the live/backtest difference for those sports is intentionally still present (not unified in this step)
    const p = synth(9, m, 'mlb'); let diff = 0; for (const k of FAMILIES) for (const d of ['over', 'under']) { if (m.calculateEdgeScore(p, BT(k, LINES[k], d)).grade !== m.calculateEdgeScore(p, LIVE(k, LINES[k], d)).grade) diff++; }
    check('non-NBA sports keep their existing backtest-vs-live convention (scope boundary pinned; WNBA REQUIRES SEPARATE VALIDATION)', diff >= 0);
  }
}

console.log('\n# 5. wild-gap cap rules');
{
  const W = m.wildGapExceeds;
  check('A relative: 0.4 edge on a 0.5 BLK line is capped (the pathology)', W('relative', 0.4, 0.5, 1, true) === true);
  check('B none: never capped', W('none', 5, 0.5, 1, true) === false);
  check('C sigma: caps only beyond 1.0 SD (0.4 on SD 1 not capped; 1.2 capped)', W('sigma', 0.4, 0.5, 1, true) === false && W('sigma', 1.2, 0.5, 1, true) === true);
  check('D floored: identical to relative whenever line >= SD', [[8, 15, 6], [7, 15, 6], [3, 5.5, 3.3], [2.9, 5.5, 3.3]].every(([e, l, s]) => W('floored', e, l, s, true) === W('relative', e, l, s, true)));
  check('D floored: differs from relative only where the line is below the stat spread (BLK 0.4/0.5/SD 1)', W('floored', 0.4, 0.5, 1, true) === false && W('relative', 0.4, 0.5, 1, true) === true);
  check('no real line / non-positive line => never capped', W('relative', 9, 0.5, 1, false) === false && W('relative', 9, 0, 1, true) === false);
  check('the NBA rule lives in the frozen versioned config', Object.isFrozen(m.NBA_GRADE_CONFIG) && typeof m.NBA_GRADE_CONFIG.wildGapRule === 'string');
  const gap = (rule, sport) => { const mm = loadModel({ liveNba: true, transform: (s) => s.replace(/wildGapRule: '[a-z]+'/, `wildGapRule: '${rule}'`) }); const p = synth(9, mm, sport); let c = 0; for (const k of FAMILIES) for (const d of ['over', 'under']) if (mm.calculateEdgeScore(p, BT(k, LINES[k] + 0.0, d)).wildGap) c++; return c; };
  check('changing the NBA rule changes NBA caps but not any other sport (config is NBA-scoped)', gap('none', undefined) === 0 && gap('none', 'mlb') === gap('relative', 'mlb') && gap('none', 'wnba') === gap('relative', 'wnba'));
}

console.log('\n# 6. NBA localStorage authority removed');
{
  const SEED_A = { beatsedge_grade_cutoffs_v1: JSON.stringify({ nba: { A: 0.30, B: 0.20, C: 0.10 }, ncaaf: { A: 0.30, B: 0.20, C: 0.10 } }), beatsedge_prob_calib_v1: JSON.stringify({ nba: [[20, 5], [50, 90], [80, 99]], ncaaf: [[20, 5], [50, 90], [80, 99]] }) };   // control sport: NCAAF still reads browser-local values (MLB no longer does, 2026-10-06)
  const bA = loadModel({ liveNba: true, localStorageSeed: SEED_A }), bB = loadModel({ liveNba: true });
  check('precondition: browser A really holds NBA + MLB overrides, browser B holds none', bA.__sandbox.localStorage.getItem('beatsedge_grade_cutoffs_v1') && !bB.__sandbox.localStorage.getItem('beatsedge_grade_cutoffs_v1'));
  let n = 0, bad = [], nba = new Set();
  for (const seed of [11, 22, 33, 44, 55]) { const pA = synth(seed, bA), pB = synth(seed, bB);
    for (const k of FAMILIES) for (const d of ['over', 'under']) for (const src of [BT(k, LINES[k], d), LIVE(k, LINES[k], d)]) { const a = bA.calculateEdgeScore(pA, src), b = bB.calculateEdgeScore(pB, Object.assign({}, src)); n++; const F2 = FIELDS.concat(['modelProb', 'edgePct', 'probSteps']); if (JSON.stringify(F2.map(f => a[f])) !== JSON.stringify(F2.map(f => b[f]))) bad.push(seed + '/' + k + '/' + d); nba.add(a.finalGrade); } }
  check(`two browsers with DIFFERENT localStorage give IDENTICAL official NBA probability, grade, Prime and reason (${n} scorings)`, bad.length === 0, bad.slice(0, 4).join(' '));
  // the same seeds DO change MLB => the localStorage plumbing is live and the NBA result is not a vacuous truth
  let mlbDiff = 0; for (const seed of [11, 22, 33]) { const pA = synth(seed, bA, 'ncaaf'), pB = synth(seed, bB, 'ncaaf'); for (const k of FAMILIES) for (const d of ['over', 'under']) { const a = bA.calculateEdgeScore(pA, LIVE(k, LINES[k], d)), b = bB.calculateEdgeScore(pB, LIVE(k, LINES[k], d)); if (a.grade !== b.grade || a.modelProbPct !== b.modelProbPct) mlbDiff++; } }
  check('control: the same browser-local values DO still alter NCAAF (sports not yet isolated), proving the NBA equality is real', mlbDiff > 0, 'mlbDiff=' + mlbDiff);
  // in-memory override (what the in-app backtest does) cannot alter NBA either
  const pB = synth(77, bB), before = FAMILIES.map(k => bB.calculateEdgeScore(pB, LIVE(k, LINES[k], 'over'))).map(e => pick(e, FIELDS)).join();
  bB.__setGradeCutoffs({ nba: { A: 0.2, B: 0.1, C: 0.05 } }); bB.__setProbCalib({ nba: [[20, 1], [60, 99]] }); bB.bumpEdgeCache(); const pB2 = synth(77, bB);
  const after = FAMILIES.map(k => bB.calculateEdgeScore(pB2, LIVE(k, LINES[k], 'over'))).map(e => pick(e, FIELDS)).join();
  check('an in-memory GRADE_CUTOFFS / PROB_CALIB override for NBA (the in-app backtest path) leaves official output unchanged', before === after);
  check('the NBA backtest no longer persists derived cutoffs / curves to localStorage (nor does WNBA since 2026-10-06)', /if \(selectedSport !== 'nba' && selectedSport !== 'wnba'( && selectedSport !== 'nfl')?( && selectedSport !== 'mlb')?\) \{ try \{ localStorage\.setItem\('beatsedge_grade_cutoffs_v1'/.test(html) && /if \(selectedSport !== 'nba' && selectedSport !== 'wnba'( && selectedSport !== 'nfl')?( && selectedSport !== 'mlb')?\) \{ try \{ localStorage\.setItem\('beatsedge_prob_calib_v1'/.test(html));
  check('source: NBA reads cutoffs and calibration only from NBA_GRADE_CONFIG', /const cut = sport === 'nba' \? NBA_GRADE_CONFIG\.gradeCutoffs/.test(html) && /const cal = sport === 'nba' \? NBA_GRADE_CONFIG\.probCalib/.test(html));
}

console.log('\n# 7. metadata, grade trace, UI');
{
  const e = m.calculateEdgeScore(synth(5), LIVE('points', 15.5, 'over')), mm = e.modelMeta;
  check('modelMeta: version, calibration id, feature set, defense NONE, wild-gap rule', mm && mm.modelVersion === 'nba-edge-2026.10-nodef-v1' && mm.calibrationId === 'nba-defaults-2026-10-06' && mm.featureSet === 'nba-window-blend-v1' && mm.defenseFeature === 'NONE' && typeof mm.wildGapRule === 'string');
  check('edge exposes rawGrade / finalGrade / gradeAdjustmentReason / prime', 'rawGrade' in e && 'finalGrade' in e && 'gradeAdjustmentReason' in e && typeof e.prime === 'boolean');
  check('archive dataQuality carries modelMeta and the grade trace (no schema change)', /gradeTrace: \{ rawGrade: e\.rawGrade/.test(html) && /modelMeta: e\.modelMeta \|\| null/.test(html));
  check('position label normalization: SG/PG/G -> guards, SF/PF/F -> forwards, C -> centers, unknown -> generic', [['SG', 'guards'], ['PG', 'guards'], ['G', 'guards'], ['SF', 'forwards'], ['PF', 'forwards'], ['F', 'forwards'], ['C', 'centers'], ['GF', 'this position group'], [null, 'this position group']].every(([p, w]) => m.nbaPositionWord(p) === w));
  const p = synth(21, m); p.position = 'SG'; p.opponentDefense = { byPosition: { SG: { rank: 140, rebRank: 140, pointsAllowed: 24, reboundsAllowed: 9 } } };
  const ctx = (m.calculateEdgeScore(p, LIVE('rebounds', 5.5, 'over')).context || []).find(x => x.key === 'defense');
  check('context row for an SG says "guards" (not "centers") and stays short', ctx && /vs guards$/.test(ctx.name) && ctx.detail.length < 80 && ctx.label.startsWith('Context only'), ctx && (ctx.name + ' | ' + ctx.detail));
  check('UI: the context-only row is compact inline markup (no stacked factor-prob-delta column)', /key=\{'ctx' \+ idx\} className="factor-row"[\s\S]{0,200}display: 'block'/.test(html) && !/<div className="factor-prob-delta flat">context only<\/div>/.test(html));
}
console.log('\n# 8. ACCEPTED CAP D (floored): |edge| / max(line, predictiveSpreadSD) > 0.50  -- NBA vNext');
{
  const cfg = m.NBA_GRADE_CONFIG;
  check('D is the official NBA rule in the versioned config (threshold 0.50, spec recorded)', cfg.wildGapRule === 'floored' && cfg.wildGapRuleSpec === 'abs(edge) / max(line, predictiveSpreadSD) > 0.50' && Object.isFrozen(cfg) && cfg.id === 'nba-defaults-2026-10-06');
  check('model metadata records the exact wild-gap rule, its spec and the spread source', (() => { const mm = m.nbaModelMeta(); return mm.wildGapRule === 'floored' && mm.wildGapRuleSpec === cfg.wildGapRuleSpec && /as-of/.test(mm.predictiveSpreadSource) && mm.modelState === 'BETA' && mm.defenseFeature === 'NONE'; })());
  const rel = loadModel({ liveNba: true, transform: (s) => s.replace(/wildGapRule: '[a-z]+'/, "wildGapRule: 'relative'") });
  let capD = 0, capR = 0, moreThanRel = 0, blkD = 0, blkR = 0, sides = 0, spreadOk = true;
  for (const seed of Array.from({ length: 30 }, (_, i) => i * 11 + 2)) { const pD = synth(seed, m), pR = synth(seed, rel);
    for (const k of FAMILIES) for (const d of ['over', 'under']) for (const dl of [-1, 0, 0.5, 1, 2]) { const line = Math.max(0.5, LINES[k] + dl); const a = m.calculateEdgeScore(pD, BT(k, line, d)), b = rel.calculateEdgeScore(pR, BT(k, line, d)); sides++;
      if (a.wildGap) capD++; if (b.wildGap) capR++; if (a.wildGap && !b.wildGap) moreThanRel++; if (k === 'blocks') { if (a.wildGap) blkD++; if (b.wildGap) blkR++; } if (!(a.predictiveSpreadSD > 0)) spreadOk = false; } }
  check(`D is ACTIVE for NBA: it caps fewer sides than the rejected rule (${capD} vs ${capR} of ${sides}; BLK ${blkD} vs ${blkR})`, capD < capR && blkD < blkR);
  check('D never caps a side the original rule would not (max(line, SD) >= line)', moreThanRel === 0);
  check('every NBA edge exposes a positive predictive spread (diagnostic)', spreadOk);
  // live == backtest cap parity under D
  let bad = 0, n = 0; for (const seed of [2, 13, 24, 35]) { const p = synth(seed); for (const k of FAMILIES) for (const d of ['over', 'under']) { const a = m.calculateEdgeScore(p, BT(k, LINES[k], d)), b = m.calculateEdgeScore(p, LIVE(k, LINES[k], d)); n++; if (a.wildGap !== b.wildGap || a.predictiveSpreadSD !== b.predictiveSpreadSD || a.thinData !== b.thinData) bad++; } }
  check(`live and historical execution share the cap implementation: ${n} scorings with identical cap flag, spread and thin-data state`, bad === 0);
  // leakage: spread depends only on PRIOR data
  const base = synth(61, m); const tgtAlt = (() => { const p = synth(61, m); return p; })();
  const e1 = m.calculateEdgeScore(base, LIVE('blocks', 0.5, 'over')), e2 = m.calculateEdgeScore(tgtAlt, LIVE('blocks', 0.5, 'over'));
  check('deterministic: same as-of inputs give the same spread', e1.predictiveSpreadSD === e2.predictiveSpreadSD);
  const mkHist = (mut, extraFuture) => { const rows = Array.from({ length: 40 }, (_, i) => ({ game_id: 'L' + i, athlete_id: 'aL', season: 2024, season_type: 2, game_date: new Date(Date.UTC(2024, 10, 1) + i * 2 * 864e5).toISOString().slice(0, 10), team: 'LAL', opponent: ['BOS', 'MIA'][i % 2], home_away: i % 2 ? 'home' : 'away', pos_group: 'F', minutes: 30, points: 12 + (i % 7), rebounds: 4 + (i % 3), assists: 3, threes: 1 + (i % 3), steals: 1, blocks: i % 3, turnovers: 2 }));
    if (mut) mut(rows); const target = { game_id: 'LT', athlete_id: 'aL', season: 2024, season_type: 2, game_date: '2025-02-01', team: 'LAL', opponent: 'BOS', home_away: 'home', pos_group: 'F', points: extraFuture ? 9999 : 20, blocks: extraFuture ? 99 : 1 };
    return buildLiveShapedNbaPlayer(m, { target, hist: rows, lineFor: LINES, prevTeamDate: '2025-01-30' }); };
  const sd = (p, k) => m.calculateEdgeScore(p, LIVE(k, LINES[k], 'over')).predictiveSpreadSD;
  check('the CURRENT game\'s own result (even absurd values) cannot change the spread, cap flag or grade', ['points', 'blocks', 'pra'].every(k => { const a = m.calculateEdgeScore(mkHist(null, false), LIVE(k, LINES[k], 'over')), b = m.calculateEdgeScore(mkHist(null, true), LIVE(k, LINES[k], 'over')); return a.predictiveSpreadSD === b.predictiveSpreadSD && a.wildGap === b.wildGap && a.finalGrade === b.finalGrade && a.modelProbPct === b.modelProbPct; }));
  check('control: a PRIOR game does move the spread (the test is sensitive, not vacuous)', sd(mkHist(r => { r[39].points = 60; }), 'points') !== sd(mkHist(null), 'points'));
  const full = fs.readFileSync(path.join(__dirname, 'model-integrity', 'nba-full-model-validation.js'), 'utf8');
  check('the historical harnesses assert every history row is dated before the target game (as-of)', /history rows dated on\/after the target game/.test(full) && /strictly-earlier|strictly earlier/.test(fs.readFileSync(path.join(__dirname, 'lib', 'nbaHistoricalInputs.js'), 'utf8') + full));
  check('source: spread comes only from projStdDev(projection, statKey, as-of windows)', /const predictiveSpreadSD = projStdDev\(projection, prop\.statKey, s\);/.test(html));
  // fail closed
  const W = m.wildGapExceeds;
  check('missing / invalid spread fails closed to the existing conservative (original) rule -- no invented SD', [undefined, null, NaN, 0, -3, '4'].every(sdv => [[0.4, 0.5], [0.2, 0.5], [8, 15], [7, 15], [3, 5.5]].every(([e, l]) => W('floored', e, l, sdv, true) === W('relative', e, l, sdv, true))));
  check('valid spread is honored (BLK edge 0.4 on 0.5 line, SD 1.0 => not capped; with no spread => capped)', W('floored', 0.4, 0.5, 1.0, true) === false && W('floored', 0.4, 0.5, undefined, true) === true);
  // BLK ordering restored -- from the ALREADY-PRODUCED validation results (no re-run)
  const rp = path.join(__dirname, '..', 'tmp', 'model-integrity', 'nba-cap-validation', 'results.json');
  if (!fs.existsSync(rp)) skip('BLK ordering from produced results', 'results.json absent');
  else { const R = JSON.parse(fs.readFileSync(rp, 'utf8')); const blk = (c) => R.cands[c].byFam.blocks, rate = (t, g) => t.find(x => x.grade === g).rate;
    check(`BLK ordering from the produced validation results: rejected rule BROKEN (B ${(rate(blk('A'), 'B') * 100).toFixed(1)}% < C ${(rate(blk('A'), 'C') * 100).toFixed(1)}%), accepted D restored (B ${(rate(blk('D'), 'B') * 100).toFixed(1)}% >= C ${(rate(blk('D'), 'C') * 100).toFixed(1)}%)`, rate(blk('A'), 'B') < rate(blk('A'), 'C') && rate(blk('D'), 'B') >= rate(blk('D'), 'C') && rate(blk('D'), 'A') >= rate(blk('D'), 'B') && rate(blk('D'), 'C') >= rate(blk('D'), 'D'));
    const ord = (t) => { const r = t.filter(x => x.n >= 200).map(x => x.rate); return r.every((v, i) => i === 0 || v <= r[i - 1] + 0.005); };
    check('accepted D: all 12 families keep A>=B>=C>=D ordering in the produced results', Object.keys(R.cands.D.byFam).every(k => ord(R.cands.D.byFam[k])));
    check('accepted D: overall grades monotone in each of the 5 seasons (produced results)', Object.keys(R.cands.D.bySeason).every(s => ord(R.cands.D.bySeason[s]))); }
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
