// NFL integrity phase 2 (2026-10-06) -- CLEAN PIPELINE before calibration / cap validation. Proves, on the REAL shipped functions:
//   1  live == backtest: the in-app NFL scorer (nflBacktestSeries) and a production-shaped live scoring give identical projection, predictiveSpreadSD,
//      raw / final probability, confidence, raw / final grade, grade adjustment reason, Prime and wild-gap state;
//   2  the generic team points-allowed rank is CONTEXT ONLY (cannot change projection, probability, confidence, grade or Prime);
//   3  browser localStorage cannot alter official NFL output (versioned NFL_GRADE_CONFIG, state CANDIDATE);
//   4  history semantics: recorded 0 is valid, ALL-ZERO recorded history is valid history, "--" / blank / null / undefined are MISSING, a combo with a
//      missing component is MISSING for that game (never zero-filled); other sports' parser / windows unchanged;
//   5  rushTds / recTds rare-event logic unchanged; every other NFL line < 1 fails closed (NOT_YET_MODELED); +EV gate; insufficient history fails closed;
//   6  NBA / WNBA frozen output unchanged, MLB / NCAAF unchanged, the WNBA period-model work is not referenced.
//   node scripts/test-nfl-integrity.js
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { execSync } = require('child_process');
const { loadNflModel, HTML_PATH } = require('./lib/loadNflModel');
const { loadModel, readRegion } = require('./lib/loadBeatsEdgeModel');
const { buildLiveShapedNbaPlayer } = require('./lib/nbaHistoricalInputs');
const { toGlRow, UNTESTABLE } = require('./lib/nflDiagData');
// The 'committed page' baseline is PINNED to the last commit BEFORE the NFL freeze (71e1dc9): after the NFL commit, HEAD is the NFL page itself, so a HEAD baseline made every old-vs-new NFL assertion compare the page to itself.
const PRE_NFL_COMMIT = '71e1dc9';
let failures = 0;
const check = (n, c, d) => { if (c) console.log(`PASS  ${n}`); else { failures++; console.log(`FAIL  ${n}${d ? '  -- ' + d : ''}`); } };
const skip = (n, w) => console.log(`SKIP  ${n}  -- ${w}`);
const html = fs.readFileSync(HTML_PATH, 'utf8');
const FUT = Date.now() + 6 * 3600e3;
const CAP = [];
const m = loadNflModel({ capture: true, sandboxExtras: { __capture: CAP } }); CAP.on = false; m.__setGradeCutoffs({}); m.__setProbCalib({});
const OPP = ['NYG', 'DAL', 'PHI', 'WAS'];
const mkRows = (n, f, start) => Array.from({ length: n }, (_, i) => ({ eventId: 'e' + (start || 0) + '_' + i, ts: Date.parse('2025-09-01T12:00:00Z') + ((start || 0) + i) * 7 * 864e5, date: 'd' + i, dateShort: 'd' + i, opponent: OPP[i % 4], vsLabel: 'vs ' + OPP[i % 4], season: 2025, row: f(i) }));
const LIVE = (k, line, dir, x) => Object.assign({ statKey: k, type: k, line, direction: dir, lineSource: 'ParlayAPI · prizepicks', eventId: 'ev1', commenceTimeMs: FUT, book: 'prizepicks' }, x || {});
const SIGF = ['projection', 'predictiveSpreadSD', 'rawModelProbPct', 'modelProbPct', 'confidence', 'rawGrade', 'finalGrade', 'grade', 'gradeAdjustmentReason', 'prime', 'wildGap', 'thinData', 'gradeScore', 'edge', 'totalFactors', 'greenCount', 'modelState'];
const sig = (e, f) => JSON.stringify((f || SIGF).map(k => e[k]));
function nflPlayer(mm, rows, k, line, extra, wopts) {
  const w = mm.nflComputeWindows(rows, [k], { [k]: line }, 'NYG', 2025, wopts);
  return Object.assign({ id: 'p' + Math.random(), sport: 'nfl', role: 'skill', position: 'QB', opponent: 'NYG', statsByKey: w.statsByKey, gameLogByKey: w.gameLogByKey, stats: {}, gameLog: [] }, extra || {});
}
// reproducible synthetic NFL-shaped histories (varied levels so every grade / rule can occur)
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const synthRows = (seed, n) => { const r = rng(seed), sc = 0.4 + r() * 1.4; return mkRows(n || 40, () => ({ passingYards: Math.round((120 + r() * 220) * sc), passingTouchdowns: Math.round(r() * 3.2 * sc), passingAttempts: Math.round((20 + r() * 25) * sc), completions: Math.round((12 + r() * 20) * sc), interceptions: Math.round(r() * 1.8), rushingYards: Math.round(r() * 80 * sc), rushingAttempts: Math.round(r() * 14 * sc), rushingTouchdowns: r() < 0.2 ? 1 : 0, receivingYards: Math.round(r() * 100 * sc), receptions: Math.round(r() * 8 * sc), receivingTouchdowns: r() < 0.18 ? 1 : 0, receivingTargets: Math.round(r() * 11 * sc) }), seed); };
const STATS = Object.keys(m.NFL_PROP_DEFS).filter(k => !UNTESTABLE.includes(k));
const LINES = { passYds: 235.5, passTds: 1.5, passAttempts: 33.5, passCompletions: 21.5, interceptions: 0.5, passRushYds: 250.5, rushYds: 45.5, rushAttempts: 12.5, rushTds: 0.5, recYds: 55.5, receptions: 4.5, recTds: 0.5, targets: 6.5, rushRecYds: 70.5 };

console.log('# 1. live == backtest (the in-app NFL scorer vs production-shaped live scoring)');
{
  const dbPath = path.join(__dirname, '..', 'data', 'beatsedge.db');
  check('source: nflBacktestSeries lives inside the App closure and builds windows with the LIVE builder (no fake stat key X, no btWindowsAsOf)', /const nflBacktestSeries = \(vals, opps, tss, position, fam, statKey, acc, gate, liveRows\) => \{/.test(html) && /nflComputeWindows\(liveRows\.slice\(0, i\), \[statKey\], \{ \[statKey\]: line \}/.test(html) && !/function nflBacktestSeries/.test(html) && !/_nflRealStat: statKey/.test(html));
  check('source: both NFL backtest callers (generic runBacktest + temporal validation) pass the live rows; the generic fake-player scorer is no longer used for NFL', (html.match(/nflBacktestSeries\(s\.vals, s\.opps, s\.tss, s\.position, s\.fam, s\.k, acc\w+, \{[^}]*\}, s\.rows\)|nflBacktestSeries\(s\.vals, s\.opps, s\.tss, s\.position, s\.fam, s\.k, accFull, \{\}, s\.rows\)/g) || []).length === 4 && !/backtestSeries\(vals, opps, 'nfl'/.test(html));
  if (!fs.existsSync(dbPath)) skip('real-row parity', 'data/beatsedge.db absent');
  else {
    const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(dbPath, { readOnly: true });
    const all = db.prepare(`SELECT season, week, season_type, game_date, player_id, position, team, opponent, passing_yards, passing_tds, interceptions, rushing_yards, rushing_tds, receptions, targets, receiving_yards, receiving_tds, pass_attempts, completions, rush_attempts FROM nfl_player_game_stats WHERE game_date IS NOT NULL AND opponent IS NOT NULL ORDER BY game_date, season, week`).all();
    const byP = new Map(); all.forEach(r => { let a = byP.get(r.player_id); if (!a) byP.set(r.player_id, a = []); a.push(r); });
    const pick = []; for (const pos of ['QB', 'RB', 'WR', 'TE']) pick.push(...[...byP.values()].filter(p => p[0].position === pos && p.length >= 45).slice(0, 12));
    let preds = 0, bad = [], adj = 0, unsupp = 0, series = 0, realKey = true, hasLog = true; const stats = new Set();
    for (const prow of pick) { const rows = prow.map(toGlRow); const opps = rows.map(r => r.opponent), tss = rows.map(r => r.ts);
      for (const k of m.nflPosKeys(prow[0].position).filter(x => !UNTESTABLE.includes(x))) { const def = m.NFL_PROP_DEFS[k]; const vals = rows.map(r => def.get(r.row) || 0);
        for (const t of [14, 24, 34, 42]) { if (t >= rows.length) continue;
          CAP.length = 0; CAP.on = true; m.nflBacktestSeries(vals, opps, tss, prow[0].position, m.NFL_STAT_FAMILY[k], k, m.emptyBacktestAcc(), { minTs: tss[t], maxTs: tss[t] + 1 }, rows); CAP.on = false; const caps = CAP.slice(); if (caps.length !== 2) continue; series++; stats.add(k);
          for (const c of caps) { if (c.prop.statKey !== k) realKey = false; if (!c.player.gameLogByKey || !c.player.gameLogByKey[k]) hasLog = false;
            const bt = m.calculateEdgeScore(c.player, c.prop);                                                                                   // the in-app scorer's own scoring
            const livePlayer = nflPlayer(m, rows.slice(0, t), k, c.prop.line, { position: prow[0].position, opponent: rows[t].opponent, oppDef: { rank: 12, paPerGame: 21.4 } }, m.NFL_WINDOW_OPTS);   // independently built, production-shaped
            livePlayer.opponent = rows[t].opponent; const lw = m.nflComputeWindows(rows.slice(0, t), [k], { [k]: c.prop.line }, rows[t].opponent, rows[t].season, m.NFL_WINDOW_OPTS); livePlayer.statsByKey = lw.statsByKey; livePlayer.gameLogByKey = lw.gameLogByKey;
            const liveProp = LIVE(k, c.prop.line, c.prop.direction); m.applyNflLowLineGate([liveProp]); const live = m.calculateEdgeScore(livePlayer, liveProp); preds++; if (bt.gradeAdjustmentReason) adj++; if (bt.insufficientData) unsupp++;
            if ((liveProp.modelSupported !== false) !== !bt.insufficientData || (live.insufficientData !== bt.insufficientData)) bad.push(`${prow[0].player_id}/${k}/t${t}/${c.prop.direction}: model-supported state differs`);   // model-supported state: builder gate + engine == backtest
            if (sig(bt) !== sig(live)) bad.push(`${prow[0].player_id}/${k}/t${t}/${c.prop.direction}: ${sig(bt)} vs ${sig(live)}`); } } } }
    check(`${preds} real-row predictions across ${stats.size} stats: backtest == live on projection, predictiveSpreadSD, raw / final probability, confidence, raw / final grade, adjustment reason, Prime, wild-gap, thin, edge, factors`, preds > 800 && bad.length === 0, `bad=${bad.length} ${bad[0] || ''}`);
    check('the scorer feeds the model the REAL stat key and a per-game log (never the generic key "X", never a missing log)', realKey && hasLog);
    check(`the live post-rules run in the backtest too (${adj} predictions carry a grade adjustment reason; ${unsupp} unsupported/insufficient mirrored exactly)`, adj > 0, `adj=${adj}`);
  }
}

console.log('\n# 2. generic defense is CONTEXT ONLY for NFL');
{
  let n = 0, badOut = 0, badRows = [];
  const RANKS = [null, 1, 5, 10, 16, 23, 28, 32];
  for (const seed of [3, 8, 13, 21]) { const rows = synthRows(seed); for (const k of STATS) { const line = LINES[k]; for (const dir of ['over', 'under']) { let ref = null;
    for (const rk of RANKS) { const p = nflPlayer(m, rows, k, line, { oppDef: rk == null ? null : { rank: rk, paPerGame: 14 + rk * 0.4 } }, m.NFL_WINDOW_OPTS); const e = m.calculateEdgeScore(p, LIVE(k, line, dir)); n++;
      if (ref == null) ref = sig(e); else if (sig(e) !== ref) { badOut++; badRows.push(`${seed}/${k}/${dir}/rank${rk}`); }
      if (rk != null && (e.factors || []).some(f => f.key === 'oppdef')) { badOut++; badRows.push('oppdef in factors ' + rk); }
      if (rk != null && !e.insufficientData && (rk >= 23 || rk <= 10) && !(e.context || []).some(c => c.key === 'oppdef' && c.contextOnly)) { badOut++; badRows.push('context row missing ' + rk); } } } } }
  check(`${n} NFL scorings across ranks null / 1 / 5 / 10 / 16 / 23 / 28 / 32: projection, spread, probability, confidence, grade, Prime, cap, factor count are IDENTICAL; oppdef never in factors`, badOut === 0, badRows.slice(0, 3).join(' '));
  const e = m.calculateEdgeScore(nflPlayer(m, synthRows(3), 'recYds', 55.5, { oppDef: { rank: 30, paPerGame: 28.2 } }, m.NFL_WINDOW_OPTS), LIVE('recYds', 55.5, 'over'));
  check('the defense row is still shown, labeled context-only (information preserved for display / research)', (e.context || []).length === 1 && e.context[0].contextOnly === true && /^Context only/.test(e.context[0].label) && /28\.2 pts\/game/.test(e.context[0].detail));
  check('source: the +-6% rank multiplier no longer applies to NFL (nor to NCAAF since 2026-10-07; see scripts/test-ncaaf-integrity.js)', !/if \(sport === 'ncaaf' && player\.oppDef && player\.oppDef\.rank\) \{/.test(html) && !/projection \*= 1 \+ \(\(player\.oppDef\.rank - _mid\)[^\n]*\n[^\n]*\n[^\n]*sport === 'nfl'/.test(html));
}

console.log('\n# 3. versioned NFL config; localStorage has no authority');
{
  const c = m.NFL_GRADE_CONFIG, meta = m.nflModelMeta();
  check('NFL_GRADE_CONFIG is the frozen BETA spec: null cutoffs (default thresholds), IDENTITY calibration, Cap C (floored, spec text with 0.50), 4-factor A rule removed for NFL only, defense NONE, state BETA, version nfl-edge-2026.10-nodef-v1', Object.isFrozen(c) && c.id === 'nfl-defaults-2026-10-06' && c.gradeCutoffs === null && c.probCalib === null && c.wildGapRule === 'floored' && c.wildGapRuleSpec === 'abs(edge) / max(line, predictiveSpreadSD) > 0.50' && c.fourFactorARequirement === 'REMOVED_FOR_NFL_ONLY' && meta.modelState === 'BETA' && meta.modelVersion === 'nfl-edge-2026.10-nodef-v1' && meta.defenseFeature === 'NONE' && meta.realLineValidation === 'PENDING');
  check('NFL config documents the spread caveat (conservative scale/floor, not a validated per-player SD); no family-specific cap values exist', /not a validated per-player SD/.test(c.predictiveSpreadCaveat) && Object.keys(c).every(k => !/family|perFamily|byFamily/i.test(k)));
  const SEED = { beatsedge_grade_cutoffs_v1: JSON.stringify({ nfl: { A: 0.30, B: 0.20, C: 0.10 }, xsport: { A: 0.30, B: 0.20, C: 0.10 } }), beatsedge_prob_calib_v1: JSON.stringify({ nfl: [[22, 5], [50, 90], [78, 99]], xsport: [[22, 5], [50, 90], [78, 99]] }) };   // control sport: an UNLISTED sport still reads browser-local values (NCAAF no longer does, 2026-10-07)
  const bA = loadNflModel({ localStorageSeed: SEED }), bB = loadNflModel({}); let n = 0, bad = 0;
  for (const seed of [4, 9, 16]) { const rows = synthRows(seed); for (const k of STATS) for (const dir of ['over', 'under']) { const a = bA.calculateEdgeScore(nflPlayer(bA, rows, k, LINES[k], { oppDef: { rank: 25, paPerGame: 24 } }, bA.NFL_WINDOW_OPTS), LIVE(k, LINES[k], dir)), b = bB.calculateEdgeScore(nflPlayer(bB, rows, k, LINES[k], { oppDef: { rank: 25, paPerGame: 24 } }, bB.NFL_WINDOW_OPTS), LIVE(k, LINES[k], dir)); n++; if (sig(a) !== sig(b)) bad++; } }
  check(`two browsers with DIFFERENT NFL localStorage give IDENTICAL official NFL output (${n} scorings)`, bad === 0, 'bad=' + bad);
  let mlbDiff = 0; for (const seed of [4, 9]) { const rows = synthRows(seed); for (const k of ['passYds', 'recYds', 'rushYds', 'receptions']) { const a = bA.calculateEdgeScore(nflPlayer(bA, rows, k, LINES[k], { sport: 'xsport' }), LIVE(k, LINES[k], 'over')), b = bB.calculateEdgeScore(nflPlayer(bB, rows, k, LINES[k], { sport: 'xsport' }), LIVE(k, LINES[k], 'over')); if (a.grade !== b.grade || a.modelProbPct !== b.modelProbPct) mlbDiff++; } }
  check('control: the same stored values still alter an unlisted sport (so the NFL equality is real)', mlbDiff > 0, 'mlbDiff=' + mlbDiff);
  const pB = nflPlayer(bB, synthRows(77), 'recYds', 55.5, {}, bB.NFL_WINDOW_OPTS), before = sig(bB.calculateEdgeScore(pB, LIVE('recYds', 55.5, 'over')));
  bB.__setGradeCutoffs({ nfl: { A: 0.2, B: 0.1, C: 0.05 } }); bB.__setProbCalib({ nfl: [[20, 1], [60, 99]] }); bB.bumpEdgeCache();
  check('an in-memory GRADE_CUTOFFS / PROB_CALIB override for NFL (what the in-app backtest does) leaves official output unchanged', before === sig(bB.calculateEdgeScore(nflPlayer(bB, synthRows(77), 'recYds', 55.5, {}, bB.NFL_WINDOW_OPTS), LIVE('recYds', 55.5, 'over'))));
  check('source: NFL reads cutoffs / calibration only from NFL_GRADE_CONFIG; the NFL in-app backtest persists nothing', /sport === 'nfl' \? NFL_GRADE_CONFIG\.gradeCutoffs/.test(html) && /sport === 'nfl' \? NFL_GRADE_CONFIG\.probCalib/.test(html) && /selectedSport !== 'nba' && selectedSport !== 'wnba' && selectedSport !== 'nfl'( && selectedSport !== 'mlb')?( && selectedSport !== 'ncaaf')?\) \{ try \{ localStorage\.setItem\('beatsedge_grade_cutoffs_v1'/.test(html) && /selectedSport !== 'nba' && selectedSport !== 'wnba' && selectedSport !== 'nfl'( && selectedSport !== 'mlb')?( && selectedSport !== 'ncaaf')?\) \{ try \{ localStorage\.setItem\('beatsedge_prob_calib_v1'/.test(html));
  const e = m.calculateEdgeScore(nflPlayer(m, synthRows(3), 'recYds', 55.5, {}, m.NFL_WINDOW_OPTS), LIVE('recYds', 55.5, 'over'));
  check('NFL edge exposes rawGrade / finalGrade / gradeAdjustmentReason and the BETA modelMeta (one authoritative resolveFinalGrade path)', 'rawGrade' in e && 'finalGrade' in e && 'gradeAdjustmentReason' in e && e.finalGrade === e.grade && e.modelMeta && e.modelMeta.modelState === 'BETA' && e.modelMeta.calibrationId === 'nfl-defaults-2026-10-06' && e.modelMeta.wildGapRule === 'floored');
  const fp = require('./lib/nflSpecFingerprint').nflSpecFingerprint(m).sha256;
  check('FROZEN NFL SPEC FINGERPRINT unchanged (any change to the NFL spec must be a NEW model version + new hash): ' + fp.slice(0, 16) + '...', fp === 'f82b3a3a521311d9e568c111c8c85491be194901ce2e4f7f510cfec955baabc3', fp);
}

console.log('\n# 4. history semantics (parse + windows)');
{
  const mkGl = (cells) => ({ names: ['passingYards', 'rushingYards', 'receptions'], events: { e1: { gameDate: '2025-09-07T17:00:00Z', opponent: { abbreviation: 'NYG' }, atVs: 'vs' } }, seasonTypes: [{ displayName: '2025 Regular Season', categories: [{ events: [{ eventId: 'e1', stats: cells }] }] }] });
  const P = (cells, o) => m.nflParseGamelog(mkGl(cells), o)[0].row, O = { nonNumericAsMissing: true };
  const keys = (r) => Object.keys(r).filter(k => !/__attempted$/.test(k)).length;
  check('"--", blank, null and undefined cells are MISSING (field absent) under the NFL parse option; a recorded "0" stays the number 0', keys(P(['--', '--', '--'], O)) === 0 && keys(P(['', '', ''], O)) === 0 && keys(P([null, null, null], O)) === 0 && keys(P([undefined, undefined, undefined], O)) === 0 && P(['0', '0', '0'], O).passingYards === 0 && 'passingYards' in P(['0', '0', '0'], O) && P(['250', '12', '3'], O).passingYards === 250);
  check('default parse (CFB / NBA) keeps its previous behavior: non-numeric -> 0 (scope-limited fix)', P(['--', '--', '--']).passingYards === 0 && P(['', '', '']).rushingYards === 0);
  { const body = (name, len) => { const i = html.indexOf('const ' + name + ' = async'); return i < 0 ? '' : html.slice(i, i + len); }; const OPT = 'nflParseGamelog(gl, { nonNumericAsMissing: true })';
    check('source: the two NFL gamelog loaders pass nonNumericAsMissing; the NBA loader does NOT (its parser behavior is unchanged); the CFB loader moved to the strict NCAAF parser 2026-10-07', body('nflGamelogMulti', 900).includes(OPT) && body('nflGamelogsMulti', 900).includes(OPT)
      && body('cfbGamelogMulti', 900).includes('cfbParseGamelog(gl, years[i])') && body('nbaGamelogMulti', 900).includes('nflParseGamelog(gl)') && !body('nbaGamelogMulti', 900).includes('nonNumericAsMissing')); }
  const base = [250, 260, 240, 270, 255, 265, 245, 280].map((v, i) => ({ eventId: 'g' + i, ts: Date.parse('2025-09-01T12:00:00Z') + i * 7 * 864e5, date: 'd' + i, dateShort: 'd' + i, opponent: OPP[i % 4], vsLabel: 'vs X', season: 2025, row: { passingYards: v, rushingYards: 5 } }));
  const wd = base.map((g, i) => i === 3 ? Object.assign({}, g, { row: P(['--', '--', '--'], O) }) : g);
  const w1 = m.nflComputeWindows(wd, ['passYds'], { passYds: 250.5 }, 'NYG', 2025, m.NFL_WINDOW_OPTS).statsByKey.passYds;
  check('a "--" game is excluded from history (7 games, average of the 7 real games), not counted as a game of 0', w1.season.games === 7 && Math.abs(w1.season.avg - 256.4) < 0.1, `games=${w1.season.games} avg=${w1.season.avg}`);
  // real zero and all-zero history
  const mixed = [0, 0, 0, 1, 0, 0].map((v, i) => ({ eventId: 'z' + i, ts: 1e12 + i * 6e8, date: 'd', dateShort: 'd', opponent: 'NYG', vsLabel: 'vs X', season: 2025, row: { rushingTouchdowns: v, rushingYards: 4 } }));
  const wm = m.nflComputeWindows(mixed, ['rushTds'], { rushTds: 0.5 }, 'NYG', 2025, m.NFL_WINDOW_OPTS).statsByKey.rushTds;
  check('a REAL recorded 0 is a valid observation (6 games, average 0.2)', wm.season.games === 6 && wm.season.avg === 0.2);
  const zeros = Array.from({ length: 8 }, (_, i) => ({ eventId: 'q' + i, ts: 1e12 + i * 6e8, date: 'd', dateShort: 'd', opponent: 'NYG', vsLabel: 'vs X', season: 2025, row: { rushingTouchdowns: 0, rushingYards: 0, receivingYards: 0 } }));
  const wz = m.nflComputeWindows(zeros, ['rushTds', 'recYds'], { rushTds: 0.5, recYds: 24.5 }, 'NYG', 2025, m.NFL_WINDOW_OPTS);
  check('ALL-ZERO recorded history is valid history: eight real games of 0 rushing TDs = 8 observations, average 0 (not "no history")', !!wz.statsByKey.rushTds && wz.statsByKey.rushTds.season.games === 8 && wz.statsByKey.rushTds.season.avg === 0 && m.hasRealModelHistory(wz.statsByKey.rushTds));
  const pz = nflPlayer(m, zeros, 'recYds', 24.5, {}, m.NFL_WINDOW_OPTS), prz = LIVE('recYds', 24.5, 'over'); m.applyHistoryGate([prz], pz.statsByKey); const ez = m.calculateEdgeScore(pz, prz);
  check('an all-zero-history prop at a normal line is NOT gated: it is modeled (real history, average 0), not INSUFFICIENT_DATA', prz.modelSupported !== false && !ez.insufficientData && ez.grade != null && ez.projection === 0, JSON.stringify({ g: ez.grade, p: ez.projection, ms: prz.modelState }));
  const pzt = nflPlayer(m, zeros, 'rushTds', 0.5, {}, m.NFL_WINDOW_OPTS), eT = m.calculateEdgeScore(pzt, LIVE('rushTds', 0.5, 'under'));
  check('an all-zero TD history still uses the validated rare-event recipe (rushTds 0.5) and is graded', !eT.insufficientData && eT.probSteps.some(s => s.label === 'Rare-event market'));
  const norec = Array.from({ length: 8 }, (_, i) => ({ eventId: 'n' + i, ts: 1e12 + i * 6e8, date: 'd', dateShort: 'd', opponent: 'NYG', vsLabel: 'vs X', season: 2025, row: { rushingYards: 3 } }));
  check('ZERO OBSERVATIONS (the stat was never recorded) still builds no window -> INSUFFICIENT_DATA; and the CFB default (no NFL option) keeps its previous all-zero behavior', !m.nflComputeWindows(norec, ['rushTds'], { rushTds: 0.5 }, 'NYG', 2025, m.NFL_WINDOW_OPTS).statsByKey.rushTds && !m.nflComputeWindows(zeros, ['rushTds'], { rushTds: 0.5 }, 'NYG', 2025).statsByKey.rushTds);
  // combos
  const cb = [[300, undefined], [310, undefined], [290, 20], [305, 10], [295, undefined], [315, 5]].map(([a, b], i) => ({ eventId: 'c' + i, ts: 1e12 + i * 6e8, date: 'd', dateShort: 'd', opponent: 'NYG', vsLabel: 'vs X', season: 2025, row: Object.assign({ passingYards: a }, b !== undefined ? { rushingYards: b } : {}) }));
  const strict = m.nflComputeWindows(cb, ['passRushYds'], { passRushYds: 300.5 }, 'NYG', 2025, m.NFL_WINDOW_OPTS).statsByKey.passRushYds, loose = m.nflComputeWindows(cb, ['passRushYds'], { passRushYds: 300.5 }, 'NYG', 2025).statsByKey.passRushYds;
  check('combo (Pass+Rush): a game with a MISSING component is missing for that game (3 complete games, average of those), never zero-filled; CFB default keeps the older either-component rule (6 games)', strict.season.games === 3 && Math.abs(strict.season.avg - 315) < 0.1 && loose.season.games === 6, `strict=${strict.season.games}/${strict.season.avg} loose=${loose.season.games}`);
  const cr = [[60, undefined], [70, 10], [undefined, 20], [80, 30], [50, 5], [65, 15]].map(([a, b], i) => ({ eventId: 'r' + i, ts: 1e12 + i * 6e8, date: 'd', dateShort: 'd', opponent: 'NYG', vsLabel: 'vs X', season: 2025, row: Object.assign(a !== undefined ? { rushingYards: a } : {}, b !== undefined ? { receivingYards: b } : {}) }));
  check('combo (Rush+Rec): same rule (4 complete games of 6)', m.nflComputeWindows(cr, ['rushRecYds'], { rushRecYds: 70.5 }, 'NYG', 2025, m.NFL_WINDOW_OPTS).statsByKey.rushRecYds.season.games === 4 && m.nflComputeWindows(cr, ['rushRecYds'], { rushRecYds: 70.5 }, 'NYG', 2025).statsByKey.rushRecYds.season.games === 6);
}

console.log('\n# 5. rare-event logic preserved; sub-1 fail-closed; +EV; containment');
{
  const headPath = (() => { try { const buf = execSync('git show ' + PRE_NFL_COMMIT + ':./BeatsEdge.html', { cwd: path.join(__dirname, '..'), maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }); const p = path.join(os.tmpdir(), 'BeatsEdge.PRE_NFL.' + process.pid + '.html'); fs.writeFileSync(p, buf); return p; } catch (e) { return null; } })();
  check('rare-event constants / recipe unchanged in source (rushTds .175, recTds .187; Poisson, bypass curve, 0.03-0.97 band)', /const NFL_LOWLINE_RARE = \{ rushTds: 0\.175, recTds: 0\.187 \};/.test(html) && /_nflScoped \? \{ stats: NFL_LOWLINE_RARE, bypassCurve: true, rawFloor: 0\.03, rawCeil: 0\.97, distModel: 'poisson' \}/.test(html) && m.NFL_LOWLINE_RARE.rushTds === 0.175 && m.NFL_LOWLINE_RARE.recTds === 0.187);
  if (!headPath) skip('NFL / NBA / WNBA / MLB / NCAAF vs the committed page', 'git HEAD not available');
  else {
    const head = loadNflModel({ htmlPath: headPath }); head.__setGradeCutoffs({}); head.__setProbCalib({});
    // The final page with its TWO approved grade changes REVERTED (sandbox transform: Cap C -> the original relative rule; NFL-only 4-factor removal -> the original football rule).
    const reverted = loadNflModel({ transform: (s) => { s = s.replace("sport === 'nfl' ? NFL_GRADE_CONFIG.wildGapRule : 'relative'", "sport === 'nfl' ? 'relative' : 'relative'"); return s.replace("if (sport === 'ncaaf' && grade === 'A' && (s.season && s.season.games || 0) < 6) grade = 'B';", "if (_football && grade === 'A' && totalFactors < 4) grade = 'B';\n            if (sport === 'ncaaf' && grade === 'A' && (s.season && s.season.games || 0) < 6) grade = 'B';"); } }); reverted.__setGradeCutoffs({}); reverted.__setProbCalib({});
    let n = 0, bad = [], rareN = 0, rareBad = 0, subOnePairs = 0, mathBad = 0, capOnlyDiffs = 0, capOnlyLeak = 0, nCmp = 0;
    const MATH = ['projection', 'predictiveSpreadSD', 'rawModelProbPct', 'modelProbPct', 'confidence', 'edge', 'edgeSignalPct', 'totalFactors', 'greenCount'];
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) { const rows = synthRows(seed); for (const k of STATS) for (const dir of ['over', 'under']) for (const line of [LINES[k], LINES[k] * 0.6 + 0.5, 0.5]) {
      const ln = Math.round(line * 2) / 2; const a = m.calculateEdgeScore(nflPlayer(m, rows, k, ln, { oppDef: null }), LIVE(k, ln, dir)), b = head.calculateEdgeScore(nflPlayer(head, rows, k, ln, { oppDef: null }), LIVE(k, ln, dir)), r0 = reverted.calculateEdgeScore(nflPlayer(reverted, rows, k, ln, { oppDef: null }), LIVE(k, ln, dir));   // default (old) windows everywhere, defense absent
      const unsupported = ln < 1 && !m.NFL_LOWLINE_RARE[k]; if (unsupported) { subOnePairs++; if (!(a.insufficientData && a.modelState === 'NOT_YET_MODELED' && !b.insufficientData && r0.modelState === 'NOT_YET_MODELED')) bad.push('sub1 ' + k + ' ' + ln); continue; }
      n++; const F = SIGF.filter(x => x !== 'modelState'); if (sig(r0, F) !== sig(b, F)) bad.push(`${seed}/${k}/${dir}/${ln}`);                                  // final-with-two-changes-reverted == committed page
      if (sig(a, MATH) !== sig(b, MATH) || JSON.stringify(a.probSteps) !== JSON.stringify(b.probSteps)) mathBad++;                                                      // projection / probability / confidence untouched by the two grade changes
      nCmp++; if (sig(a, F) !== sig(r0, F)) capOnlyDiffs++; if (sig(a, MATH) !== sig(r0, MATH)) capOnlyLeak++;
      if (ln < 1) { rareN++; if (a.modelProbPct !== b.modelProbPct || a.rawModelProbPct !== b.rawModelProbPct || JSON.stringify(a.probSteps) !== JSON.stringify(b.probSteps)) rareBad++; } } }
    check(`${n} NFL scorings: the final page with its TWO approved grade changes (Cap C, NFL-only 4-factor removal) reverted is IDENTICAL to the committed page on every field -- nothing else about the NFL grade path changed`, !bad.some(x => !/^sub1/.test(x)), bad.filter(x => !/^sub1/.test(x)).slice(0, 3).join(' '));
    check(`projection, predictiveSpreadSD, raw / final probability (every probability step), confidence, edge and factors are IDENTICAL to the committed page (${n} scorings): the two approved changes cannot touch the probability path`, mathBad === 0, 'bad=' + mathBad);
    check(`the two approved changes DO change grades / Prime / wild-gap state somewhere (${capOnlyDiffs} of ${nCmp} scorings), and only there (projection / probability / confidence differences: ${capOnlyLeak})`, capOnlyDiffs > 0 && capOnlyLeak === 0, `diffs=${capOnlyDiffs} leak=${capOnlyLeak}`);
    check(`rushTds / recTds rare-event output is bit-identical to the committed page, including every probability step (${rareN} sub-1 scorings)`, rareN > 20 && rareBad === 0, `rareN=${rareN} bad=${rareBad}`);
    check(`every OTHER NFL line < 1 (${subOnePairs} scorings: INT, passTds, rushYds, recYds, receptions, targets, ...) fails closed (NOT_YET_MODELED), where the committed page scored them`, subOnePairs > 30 && !bad.some(x => /^sub1/.test(x)), bad.filter(x => /^sub1/.test(x)).slice(0, 2).join(' '));
    // Cap C = the formula, exactly (and the original relative rule where line >= predictiveSpreadSD)
    { let capN = 0, capBad = 0, floorFired = 0; for (const seed of [3, 8, 13, 21]) { const rows = synthRows(seed); for (const k of STATS) for (const dir of ['over', 'under']) for (const ln of [0.5, 1.5, 4.5, 24.5, 55.5, 235.5]) { const e = m.calculateEdgeScore(nflPlayer(m, rows, k, ln, {}, m.NFL_WINDOW_OPTS), LIVE(k, ln, dir)); if (e.insufficientData) continue; capN++; const expC = Math.abs(e.edge) / Math.max(ln, e.predictiveSpreadSD) > 0.5; if (!!e.wildGap !== expC) capBad++; if (Math.abs(e.edge) / ln > 0.5 && !expC) floorFired++; } }   // (the football small-sample clause needs < 6 games: never true for these 40-game histories)
      check(`engine: ${capN} NFL scorings -- wildGap equals abs(edge)/max(line, predictiveSpreadSD) > 0.50 exactly (the floor changes the outcome vs the old rule in ${floorFired} of them)`, capN > 300 && capBad === 0 && floorFired > 0, `bad=${capBad}`); }
    // other sports unchanged vs HEAD
    const nbaNew = loadModel({ liveNba: true }), nbaHead = loadModel({ liveNba: true, htmlPath: headPath }); for (const mm of [nbaNew, nbaHead]) { mm.__setGradeCutoffs({}); mm.__setProbCalib({}); }
    const FAMS = ['points', 'rebounds', 'assists', 'threes', 'steals', 'blocks', 'turnovers', 'pra', 'pr', 'pa', 'ra', 'blocksSteals'], NL = { points: 10.5, rebounds: 4.5, assists: 2.5, threes: 1.5, steals: 0.5, blocks: 0.5, turnovers: 1.5, pra: 17.5, pr: 14.5, pa: 13.5, ra: 6.5, blocksSteals: 1.5 };
    const synthNba = (mm, seed, sport) => { const r = rng(seed), opps = ['NY', 'LV', 'SEA', 'CHI', 'MIN', 'PHX'], scale = 0.5 + r() * 1.1; const hist = Array.from({ length: 60 }, (_, i) => ({ game_id: 'w' + seed + '_' + i, athlete_id: 'w' + seed, season: 2025, season_type: 2, game_date: new Date(Date.UTC(2025, 4, 20) + i * 2 * 864e5).toISOString().slice(0, 10), team: 'IND', opponent: opps[i % 6], home_away: i % 2 ? 'home' : 'away', pos_group: 'G', minutes: 20 + Math.round(r() * 12), points: Math.round((4 + r() * 18) * scale), rebounds: Math.round((1 + r() * 7) * scale), assists: Math.round(r() * 6 * scale), threes: Math.round(r() * 3.5 * scale), steals: Math.round(r() * 2.4), blocks: Math.round(r() * 1.6), turnovers: Math.round(r() * 3.4) })); const target = { game_id: 'wt' + seed, athlete_id: 'w' + seed, season: 2025, season_type: 2, game_date: '2025-09-10', team: 'IND', opponent: 'NY', home_away: 'home', pos_group: 'G' }; const p = buildLiveShapedNbaPlayer(mm, { target, hist, lineFor: NL, prevTeamDate: '2025-09-08' }); p.sport = sport; return p; };
    const NSIG = ['projection', 'predictiveSpreadSD', 'rawModelProbPct', 'modelProbPct', 'confidence', 'rawGrade', 'finalGrade', 'gradeAdjustmentReason', 'prime', 'wildGap', 'thinData', 'gradeScore', 'edge', 'totalFactors'];
    const cmpSport = (sport, withDef) => { let c = 0, b2 = 0; for (const seed of [2, 7, 12, 19]) { const pn = synthNba(nbaNew, seed, sport), ph = synthNba(nbaHead, seed, sport); if (withDef) { pn.oppDef = ph.oppDef = { rank: 60, paPerGame: 29 }; } for (const k of FAMS) for (const dir of ['over', 'under']) for (const src of ['backtest', 'ParlayAPI · prizepicks']) { const prop = { statKey: k, type: k, line: NL[k], direction: dir, lineSource: src, eventId: 'e', commenceTimeMs: FUT, odds: -110, oppOdds: -110 }; c++; if (sig(nbaNew.calculateEdgeScore(pn, prop), NSIG) !== sig(nbaHead.calculateEdgeScore(ph, Object.assign({}, prop)), NSIG)) b2++; } } return { c, b2 }; };
    for (const [sp, wd] of [['nba', false], ['wnba', false]]   /* MLB moved onto its own cleaned pipeline (scripts/test-mlb-integrity.js), NCAAF too (2026-10-07: scripts/test-ncaaf-integrity.js) */) { const r = cmpSport(sp, wd); check(`${sp.toUpperCase()}${wd ? ' (with a team-defense rank)' : ''}: ${r.c} scorings (backtest + live shapes) identical to the committed page`, r.c > 100 && r.b2 === 0, `bad=${r.b2}`); }
    // the 4-factor A requirement: removed for NFL here (NCAAF removed it 2026-10-07: scripts/test-ncaaf-integrity.js)
    { const strongRows = (opp) => mkRows(30, (i) => ({ receivingYards: 26, receptions: 5, receivingTargets: 7, receivingTouchdowns: 0 })).map((g, i) => Object.assign(g, { opponent: opp(i) }));
      const build = (mm, sport, rows) => { const w = mm.nflComputeWindows(rows, ['recYds'], { recYds: 20.5 }, 'ZZZ', 2025, mm.NFL_WINDOW_OPTS); return { id: 'f', sport, role: 'skill', position: 'WR', opponent: 'ZZZ', oppDef: null, statsByKey: w.statsByKey, gameLogByKey: w.gameLogByKey, stats: {}, gameLog: [] }; };
      const noOpp = strongRows((i) => OPP[i % 4]), withOpp = strongRows((i) => (i % 3 === 0 ? 'ZZZ' : OPP[i % 4]));   // vs-opponent factor absent (0 prior games) vs present (>= 2)
      const sc = (mm, sport, rows) => { const e = mm.calculateEdgeScore(build(mm, sport, rows), LIVE('recYds', 20.5, 'over')); return { tf: e.totalFactors, raw: e.rawGrade, fin: e.finalGrade, prime: e.prime, wg: e.wildGap }; };
      const nflNew = sc(m, 'nfl', noOpp), nflOld = sc(head, 'nfl', noOpp), nflNew4 = sc(m, 'nfl', withOpp);
      check('NFL: an A no longer needs 4 supporting factors -- 3 factors, strong edge, not capped => grade A (the committed page capped it at B)', nflNew.tf === 3 && nflNew.fin === 'A' && nflNew.raw === 'A' && nflOld.tf === 3 && nflOld.fin === 'B', JSON.stringify({ nflNew, nflOld }));
      check('NFL with 4 factors is still an A (the change only removes the extra requirement); thresholds and the Prime rule are untouched', nflNew4.tf === 4 && nflNew4.fin === 'A' && /else if \(gradeScore >= 0\.86 && confidence >= 80\) grade = 'A';/.test(html) && /gradeScore >= 0\.68 && confidence >= 50/.test(html) && /confShare >= 0\.67/.test(html) && /edgeSigPct >= 11/.test(html)); }
    // NHL is excluded from the grade model by identity: unchanged
    { const nhlP = (id) => ({ id, sport: 'nhl', _isNhl: true, position: 'F', props: [] }), nhlProp = { statKey: 'shots_on_goal', line: 2.5, direction: 'over', lineSource: 'x', edge: 0.4, probability: 0.55, modelSupported: true };
      check('NHL (excluded from the grade model by identity) returns the identical neutral result as the committed page', JSON.stringify(m.calculateEdgeScore(nhlP('a'), nhlProp)) === JSON.stringify(head.calculateEdgeScore(nhlP('a'), nhlProp)) && m.calculateEdgeScore(nhlP('b'), nhlProp).grade === 'D'); }
    try { fs.unlinkSync(headPath); } catch (e) { }
  }
  // unsupported sub-1: engine + builder gate + every downstream surface
  const rowsI = synthRows(11); const ints = nflPlayer(m, rowsI, 'interceptions', 0.5, { position: 'QB' }, m.NFL_WINDOW_OPTS); const propI = LIVE('interceptions', 0.5, 'over', { plusEV: { eligible: true, modelDifference: 9, marketDifference: 9 }, hitRate: 90 }); ints.props = [propI];
  const eI = m.calculateEdgeScore(ints, propI);
  check('NFL INT line 0.5 (no validated recipe): the engine withholds EVERYTHING (state NOT_YET_MODELED, no projection / probability / grade / Prime / edge)', eI.insufficientData === true && eI.modelState === 'NOT_YET_MODELED' && eI.grade === null && eI.prime === false && eI.projection === null && eI.modelProbPct === null && eI.edge === null && eI.finalGrade === null);
  const gated = [LIVE('interceptions', 0.5, 'under'), LIVE('rushYds', 0.5, 'over'), LIVE('recYds', 0.5, 'over'), LIVE('receptions', 0.5, 'under'), LIVE('passTds', 0.5, 'over'), LIVE('targets', 0.5, 'over'), LIVE('rushTds', 0.5, 'over'), LIVE('recTds', 0.5, 'under'), LIVE('interceptions', 1.5, 'over'), LIVE('passTds', 1.5, 'over'), LIVE('rushYds', 45.5, 'over')]; m.applyNflLowLineGate(gated);
  const st = gated.map(p => p.modelSupported === false ? p.modelState : 'ok');
  check('the builder gate marks exactly the unsupported sub-1 offerings (INT/rushYds/recYds/receptions/passTds/targets at 0.5) and leaves rushTds / recTds 0.5 and the same stats at normal lines untouched', st.slice(0, 6).every(x => x === 'NOT_YET_MODELED') && st.slice(6).every(x => x === 'ok'), JSON.stringify(st));
  const normalInt = nflPlayer(m, rowsI, 'interceptions', 1.5, { position: 'QB' }, m.NFL_WINDOW_OPTS), eN = m.calculateEdgeScore(normalInt, LIVE('interceptions', 1.5, 'over'));
  check('the same stat at a normal line (INT 1.5) is still modeled; rushTds / recTds 0.5 keep the recipe', !eN.insufficientData && eN.grade != null && ['rushTds', 'recTds'].every(k => { const e = m.calculateEdgeScore(nflPlayer(m, synthRows(12), k, 0.5, {}, m.NFL_WINDOW_OPTS), LIVE(k, 0.5, 'over')); return !e.insufficientData && e.probSteps.some(s => s.label === 'Rare-event market'); }));
  const good = nflPlayer(m, synthRows(21), 'recYds', 55.5, { position: 'WR', id: 'good' }, m.NFL_WINDOW_OPTS); good.props = [Object.assign(LIVE('recYds', 55.5, 'over'), { plusEV: { eligible: true, modelDifference: 5, marketDifference: 5 } })];
  const mkU = (id, over) => { const p = nflPlayer(m, synthRows(30), 'recYds', 55.5, { position: 'WR', id }, m.NFL_WINDOW_OPTS); p.props = [Object.assign(LIVE('recYds', 55.5, 'over'), { plusEV: { eligible: true, modelDifference: 9, marketDifference: 9 } }, over)]; return p; };
  const subOneUnflagged = (() => { const p = nflPlayer(m, rowsI, 'interceptions', 0.5, { position: 'QB', id: 'sub1' }, m.NFL_WINDOW_OPTS); p.props = [Object.assign(LIVE('interceptions', 0.5, 'over'), { plusEV: { eligible: true, modelDifference: 9, marketDifference: 9 } })]; return p; })();   // NOT pre-flagged: the list itself must refuse it
  const noHist = { id: 'nohist', sport: 'nfl', position: 'WR', opponent: 'NYG', statsByKey: {}, stats: {}, gameLogByKey: {}, props: [Object.assign(LIVE('recYds', 55.5, 'over'), { plusEV: { eligible: true, modelDifference: 9, marketDifference: 9 } })] };
  const ids = m.findPlusEVPicks([good, mkU('insuff', { modelState: 'INSUFFICIENT_DATA' }), mkU('unsup', { modelSupported: false }), mkU('nym', { modelState: 'NOT_YET_MODELED' }), subOneUnflagged, noHist]).map(r => r.player.id);
  check('+EV: insufficient data, modelSupported:false, a NOT_YET_MODELED state, an UNFLAGGED sub-1 offering and a no-history prop are all refused by the list itself; a valid prop still lists', ids.length === 1 && ids[0] === 'good', ids.join(','));
  const surf = (p) => { const e = m.calculateEdgeScore(p, p.props[0]); return { top: m.findTopPicks([p], 5).length, prime: m.findPrimePicks([p]).length, ev: m.findPlusEVPicks([p]).length, sp: m.smartParlayEligibility(e, p.props[0]).eligible, best: m.playerBestGrade(p).grade, grade: e.grade, isPrime: e.prime }; };
  const s1 = surf(subOneUnflagged), s2 = surf(noHist); const empty = { id: 'e', sport: 'nfl', position: 'QB', opponent: 'NYG', statsByKey: {}, stats: {}, gameLogByKey: {}, props: [Object.assign(LIVE('passYds', 235.5, 'over'), { plusEV: { eligible: true, modelDifference: 9, marketDifference: 9 }, hitRate: 95 })] }; const s3 = surf(empty);
  check('unsupported sub-1 offering AND missing history: no grade, no Prime, not in Top / Prime picks, no +EV, not Smart-Parlay eligible, no best grade', [s1, s2, s3].every(s => s.top === 0 && s.prime === 0 && s.ev === 0 && s.sp === false && s.best === null && s.grade === null && s.isPrime === false), JSON.stringify([s1, s2, s3]));
  // the scorer itself skips unsupported lines (never tallied)
  { const rows = synthRows(55, 60), def = m.NFL_PROP_DEFS.interceptions; const vals = rows.map(r => def.get(r.row) || 0), opps = rows.map(r => r.opponent), tss = rows.map(r => r.ts); const acc = m.emptyBacktestAcc(); CAP.length = 0; CAP.on = true; m.nflBacktestSeries(vals, opps, tss, 'QB', 'interception', 'interceptions', acc, {}, rows); CAP.on = false;
    const caps = CAP.slice(), subOne = caps.filter(c => c.prop.line < 1).length, scored = caps.filter(c => !m.calculateEdgeScore(c.player, c.prop).insufficientData).length;
    check(`the NFL backtest scorer never tallies an unsupported sub-1 offering (${subOne} of ${caps.length} INT predictions were sub-1 and skipped)`, subOne > 0 && acc._total.n === scored && scored < caps.length); }
}

console.log('\n# 6. other work untouched');
{
  check('the full-game model region does not reference the WNBA period model (periodEdge / wnbaPeriodModel / WNBA_PERIOD_*)', !/periodEdge|wnbaPeriodModel|WNBA_PERIOD|wnbaEnrichPeriod/.test(readRegion()));
  const a = html.indexOf('Phase 2I-L -- WNBA PERIOD MODEL'), b = html.indexOf('const fetchWnbaSlate = async'); const block = a > -1 && b > a ? html.slice(a, b) : '';
  if (!block) skip('period-model block checks', 'the WNBA period-model work is separate and not part of this build');
  else check('the period-model block is intact and does not touch NFL config / NFL scoring', /function wnbaPeriodModel\(/.test(block) && !/NFL_GRADE_CONFIG|nflComputeWindows|nflBacktestSeries|nflSubOneLineUnsupported/.test(block));
  check('the frozen WNBA / NBA configs are untouched in source (floored caps, identity calibration, frozen versions)', /wildGapRule: 'floored'/.test(html) && /NBA_MODEL_VERSION = 'nba-edge-2026\.10-nodef-v1'/.test(html) && /WNBA_MODEL_VERSION = 'wnba-edge-2026\.10-nodef-v1'/.test(html));
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
