// WNBA BETA (wnba-edge-2026.10-nodef-v1) -- ONE targeted LEAKAGE suite on the accepted final configuration (Cap C, identity calibration).
// Runs the REAL production walk-forward scorer `nbaBacktestSeries` (WNBA mode: live builders from strictly earlier rows, sport 'wnba') on REAL
// wnba_player_box rows, for all 12 prop families, and proves that no outcome of the target game or of any later game can reach a prediction:
//   M1 current-game outcome (stats + minutes) mutated to absurd values -> every prediction at game index <= t is IDENTICAL (projection,
//        predictiveSpreadSD, raw / final probability, cap state, thin flag, raw / final grade, Prime, confidence, edge, factors);
//   M2 ALL later games mutated (absurd highs and zeros)                -> identical;     M1+M2 combined                         -> identical;
//   M3 an eligible PRIOR game (t-3) mutated                            -> the prediction at t CHANGES (non-vacuity);
//   CONTROL: the M1 mutation DOES change the NEXT game's prediction (it is a legitimate prior there);
//   MARKER run: every row carries its own index; for EVERY scored prediction the model's per-game log, L5 / L10 windows and season window must
//        contain exactly the strictly-earlier rows (never the target row, never a later row).
// Each captured prediction is mapped to its true game index by replicating the scorer's eligibility rule (and asserting the capture count matches).
//   node scripts/test-wnba-leakage.js
const fs = require('fs'), path = require('path');
const { loadModel, HTML_PATH } = require('./lib/loadBeatsEdgeModel');
const { toGlRow } = require('./lib/nbaHistoricalInputs');
let failures = 0;
const check = (n, c, d) => { if (c) console.log(`PASS  ${n}`); else { failures++; console.log(`FAIL  ${n}${d ? '  -- ' + d : ''}`); } };
const CAPTURE = [];
const m = loadModel({ liveNba: true, sandboxExtras: { __capture: CAPTURE }, transform: (s) => s.replace('function calculateEdgeScore(player, prop) {', 'function calculateEdgeScore(player, prop) { if (typeof __capture !== "undefined" && __capture.on) __capture.push({ player, prop });') });
CAPTURE.on = false;
const html = fs.readFileSync(HTML_PATH, 'utf8');
const FAMS = ['points', 'rebounds', 'assists', 'threes', 'steals', 'blocks', 'turnovers', 'pra', 'pr', 'pa', 'ra', 'blocksSteals'];
const K = { points: 1, rebounds: 1, assists: 1, threes: 1, steals: 1, blocks: 1, turnovers: 1, pra: 3, pr: 2, pa: 2, ra: 2, blocksSteals: 2 };   // component stats per family
const SIGF = ['projection', 'predictiveSpreadSD', 'modelProbPct', 'rawModelProbPct', 'modelProb', 'wildGap', 'thinData', 'rawGrade', 'grade', 'finalGrade', 'prime', 'confidence', 'gradeScore', 'edge', 'edgeSignalPct', 'greenCount', 'totalFactors', 'gradeAdjustmentReason'];
const sig = (e) => JSON.stringify(SIGF.map(k => e[k]));
const LOGCAP = 40;   // the live builder keeps the most recent 40 games in the per-game log (verified below, not assumed)

console.log('# 0. configuration under test');
check('Cap C (floored), identity calibration, BETA metadata are the active WNBA configuration', m.WNBA_GRADE_CONFIG.wildGapRule === 'floored' && m.WNBA_GRADE_CONFIG.probCalib === null && m.wnbaModelMeta().modelState === 'BETA' && m.wnbaModelMeta().modelVersion === 'wnba-edge-2026.10-nodef-v1');
check('source: the validation harness builds history and the pseudo-line ONLY from strictly earlier games (hist = prow.slice(start, i))', (() => { const h = fs.readFileSync(path.join(__dirname, 'model-integrity', 'wnba-final-calibration-cap-validation.js'), 'utf8'); return /hist = prow\.slice\(start, i\)/.test(h) && /const hv = hist\.map\(FAMS\[k\]\)/.test(h); })());
check('source: the in-app WNBA backtest slices windows / history with liveRows.slice(0, i) and vals.slice(0, i) only', /liveRows\.slice\(0, i\)\.filter\(g => _def\.has\(g\.row\)\)/.test(html) && /nbaComputeWindows\(liveRows\.slice\(0, i\), \{ \[statKey\]: line \}/.test(html) && /let hv = vals\.slice\(0, i\)/.test(html));

const dbPath = path.join(__dirname, '..', 'data', 'beatsedge.db');
if (!fs.existsSync(dbPath)) { console.log('SKIP  real-row leakage runs -- data/beatsedge.db absent'); process.exit(failures ? 1 : 0); }
const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(dbPath, { readOnly: true });
const players = [];
for (const g of ['G', 'F', 'C']) players.push(...db.prepare(`SELECT athlete_id FROM wnba_player_box WHERE season >= 2023 AND played = 1 AND minutes > 10 AND pos_group = ? GROUP BY athlete_id HAVING COUNT(*) >= 70 ORDER BY athlete_id LIMIT 4`).all(g).map(r => r.athlete_id));
const dbRows = (id) => db.prepare(`SELECT game_id, athlete_id, season, season_type, game_date, team_abbreviation AS team, opponent_team_abbreviation AS opponent, home_away, pos_group, minutes, points, rebounds, assists, threes, steals, blocks, turnovers FROM wnba_player_box
  WHERE athlete_id = ? AND season >= 2022 AND played = 1 AND minutes > 0 AND points IS NOT NULL AND rebounds IS NOT NULL AND assists IS NOT NULL AND threes IS NOT NULL AND steals IS NOT NULL AND blocks IS NOT NULL AND turnovers IS NOT NULL ORDER BY game_date, game_id`).all(id).slice(-120);
const PD = m.NBA_PROP_DEFS, mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
// the scorer's own eligibility rule (nbaBacktestSeries, WNBA mode), replicated ONLY to map each captured prediction to its game index
function eligible(rows, fam) { const def = PD[fam], out = [];
  for (let i = 14; i < rows.length; i++) { if (!def.has(rows[i].row)) continue; const hv = rows.slice(0, i).filter(g => def.has(g.row)).map(g => def.get(g.row) || 0); if (!hv.length) continue; const avg = mean(hv); if (avg <= 0) continue;
    let line = null, best = 99; for (let c = 0.5; c <= avg * 2.2 + 1; c += 1) { const o = hv.filter(v => v > c).length / hv.length, g = Math.abs(o - 0.48); if (g < best) { best = g; line = c; } }
    if (line == null || line <= 0) continue; if ((def.get(rows[i].row) || 0) === line) continue; out.push(i); } return out; }
let mapMismatch = 0;
function runSeries(rows, fam, pos) {                                    // rows already built/mutated; returns Map(gameIndex -> { over, under, player })
  const def = PD[fam]; const vals = rows.map(r => def.get(r.row) || 0), mins = rows.map(r => r.row.minutes), opps = rows.map(r => r.opponent), tss = rows.map(r => r.ts), homes = rows.map(r => !/^@/.test(r.vsLabel));
  CAPTURE.length = 0; CAPTURE.on = true; m.nbaBacktestSeries(vals, mins, opps, tss, homes, pos, fam, m.emptyBacktestAcc(), undefined, 'wnba', rows); CAPTURE.on = false;
  const caps = CAPTURE.slice(), el = eligible(rows, fam); const out = new Map();
  if (caps.length !== 2 * el.length) { mapMismatch++; return out; }
  el.forEach((i, p) => { const a = caps[2 * p], b = caps[2 * p + 1]; if (a.prop.direction !== 'over' || b.prop.direction !== 'under') { mapMismatch++; return; } out.set(i, { player: a.player, over: m.calculateEdgeScore(a.player, a.prop), under: m.calculateEdgeScore(b.player, b.prop) }); });
  return out; }
const build = (dbr, mutFn) => { const rows = dbr.map(r => toGlRow(m, r)); if (mutFn) mutFn(rows); return rows; };
const mutate = (g, v) => { g.row.points = v; g.row.totalRebounds = v; g.row.assists = v; g.row.steals = v; g.row.blocks = v; g.row.turnovers = v; g.row[m.NBA_3PM] = v; g.row.minutes = v === 0 ? 0.0001 : 48; };
let series = 0, comparedPreds = 0, m1Bad = 0, m2Bad = 0, m12Bad = 0, m3Changed = 0, m3Total = 0, ctlChanged = 0, ctlTotal = 0, capFired = 0, unscored = 0; const bad = [], famSeen = new Set();
for (const pid of players) {
  const dbr = dbRows(pid); if (dbr.length < 60) continue; const pgroup = dbr[0].pos_group;
  FAMS.forEach((fam, fi) => {
    const base = runSeries(build(dbr), fam, pgroup); const idxs = [...base.keys()]; if (idxs.length < 25) { unscored++; return; }
    const pos = 10 + ((pid * 7 + fi * 11) % (idxs.length - 20)), t = idxs[pos], next = idxs[pos + 1]; series++; famSeen.add(fam);
    const cmp = (run, label) => { let diff = 0; for (const i of idxs) { if (i > t) break; const x = base.get(i), y = run.get(i); if (!y || sig(x.over) !== sig(y.over) || sig(x.under) !== sig(y.under)) diff++; } if (diff) bad.push(`${pid}/${fam}/${label}: ${diff} predictions differ`); return diff ? 1 : 0; };
    const later = (rows, f) => { for (let j = t + 1; j < rows.length; j++) mutate(rows[j], f(j)); };
    const M1 = runSeries(build(dbr, (rows) => mutate(rows[t], 9999)), fam, pgroup);
    const M2 = runSeries(build(dbr, (rows) => later(rows, (j) => j % 2 ? 9000 + j : 0)), fam, pgroup);
    const M12 = runSeries(build(dbr, (rows) => { mutate(rows[t], 9999); later(rows, (j) => j % 2 ? 9000 + j : 0); }), fam, pgroup);
    m1Bad += cmp(M1, 'M1'); m2Bad += cmp(M2, 'M2'); m12Bad += cmp(M12, 'M1+M2');
    for (const i of idxs) { if (i > t) break; comparedPreds += 2; if (base.get(i).over.wildGap) capFired++; if (base.get(i).under.wildGap) capFired++; }
    const M3 = runSeries(build(dbr, (rows) => mutate(rows[t - 3], 400)), fam, pgroup); const b3 = base.get(t), c3 = M3.get(t); m3Total++; if (b3 && c3 && (sig(b3.over) !== sig(c3.over) || sig(b3.under) !== sig(c3.under))) m3Changed++;
    const bn = base.get(next), mn = M1.get(next); if (bn && mn) { ctlTotal++; if (sig(bn.over) !== sig(mn.over) || sig(bn.under) !== sig(mn.under)) ctlChanged++; } });
}
console.log(`\n# 1. mutation runs: ${players.length} players x 12 families -> ${series} series with a scored target (${unscored} too short); ${comparedPreds} predictions compared per mutation; Cap C fired on ${capFired} of them`);
check('capture -> game-index mapping consistent in every run (capture count == 2 x eligible games, over/under order)', mapMismatch === 0, 'mismatches=' + mapMismatch);
check(`coverage: all 12 prop families exercised on real WNBA rows (${[...famSeen].length}/12 families, ${series} series)`, famSeen.size === 12 && series >= 100);
check('M1: mutating the CURRENT game\'s outcome (stats + minutes) changes NOTHING at or before the target (projection, spread, probability, cap, grade, Prime, ...)', m1Bad === 0, bad.filter(x => /M1:/.test(x)).slice(0, 3).join(' | '));
check('M2: mutating ALL later games (absurd highs and zeros) changes NOTHING at or before the target', m2Bad === 0, bad.filter(x => /M2:/.test(x)).slice(0, 3).join(' | '));
check('M1+M2 combined: changes NOTHING at or before the target', m12Bad === 0, bad.filter(x => /M1\+M2/.test(x)).slice(0, 3).join(' | '));
check(`NON-VACUOUS: mutating an eligible PRIOR game (t-3) changes the target prediction (${m3Changed}/${m3Total})`, m3Total >= 100 && m3Changed >= Math.floor(m3Total * 0.97), `${m3Changed}/${m3Total}`);
check(`CONTROL: the same current-game mutation DOES change the NEXT game's prediction, where it is a legitimate prior (${ctlChanged}/${ctlTotal})`, ctlTotal >= 100 && ctlChanged >= Math.floor(ctlTotal * 0.97), `${ctlChanged}/${ctlTotal}`);

console.log('\n# 2. marker run: for EVERY scored prediction, every window row is strictly earlier than the target game');
{ let n = 0, longLogs = 0, badLog = [], badL5 = [], badSeason = [];
  const r1 = (x) => Math.round(x * 10) / 10;
  for (const pid of players.slice(0, 8)) { const dbr = dbRows(pid); if (dbr.length < 60) continue; const pgroup = dbr[0].pos_group;
    for (const fam of FAMS) { const k = K[fam];
      const rows = build(dbr, (rs) => rs.forEach((g, j) => { mutate(g, 1000 + j); g.row.minutes = 24; }));
      const el = eligible(rows, fam), run = runSeries(rows, fam, pgroup);
      for (const i of el) { const e = run.get(i); if (!e) continue; n++; const log = e.player.gameLogByKey[fam] || [], idx = log.map(g => Math.round(g.points / k) - 1000), len = Math.min(LOGCAP, i); if (len === LOGCAP) longLogs++;
        // exactly the LAST `len` strictly-earlier rows, consecutive, newest = i-1 (never row i, never later)
        if (!(idx.length === len && idx.every((v, q) => v === i - len + q))) badLog.push(`${pid}/${fam}/i=${i}: ${idx.slice(0, 2)}..${idx.slice(-2)} len ${idx.length}`);
        const w = e.player.statsByKey[fam], mu = (a, b) => { let s = 0; for (let j = a; j < b; j++) s += k * (1000 + j); return s / (b - a); };
        if (!(w && w.last5 && w.last10 && Math.abs(w.last5.avg - r1(mu(i - 5, i))) < 0.051 && Math.abs(w.last10.avg - r1(mu(i - 10, i))) < 0.051)) badL5.push(`${pid}/${fam}/i=${i}: L5 ${w && w.last5 && w.last5.avg} vs ${r1(mu(i - 5, i))}`);
        // The live design feeds the previous + current season's gamelog, so the "season" window is ALL strictly-earlier loaded rows (0..i-1).
        const expS = r1(mu(0, i)); if (!(w && w.season && w.season.games === i && Math.abs(w.season.avg - expS) < 0.051)) badSeason.push(`${pid}/${fam}/i=${i}: season games ${w && w.season && w.season.games}/${i} avg ${w && w.season && w.season.avg} vs ${expS}`); } } }
  check(`${n} scored predictions (${longLogs} with the full 40-game log): the per-game log is exactly the strictly-earlier rows (newest = target-1; never the target row or a later row)`, n >= 1000 && badLog.length === 0, badLog.slice(0, 3).join(' | '));
  check(`${n} scored predictions: L5 and L10 window averages equal the means of rows t-5..t-1 and t-10..t-1 only`, badL5.length === 0, badL5.slice(0, 3).join(' | '));
  check(`${n} scored predictions: the season window (previous + current season, as the live gamelog is loaded) is exactly the strictly-earlier loaded rows 0..t-1 (games count and average) -- never the target or a later row`, badSeason.length === 0, badSeason.slice(0, 3).join(' | ')); }

console.log('\n# 3. the cap itself (Cap C)');
check('cap state, spread and thin flag are part of every compared signature (so M1/M2/M3 above cover the wild-gap inputs: as-of projection, line, predictive spread)', SIGF.includes('wildGap') && SIGF.includes('predictiveSpreadSD') && SIGF.includes('thinData') && capFired > 0, 'capFired=' + capFired);
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
