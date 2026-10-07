// NFL BETA (nfl-edge-2026.10-nodef-v1) -- FINAL LEAKAGE SUITE on the approved final configuration (Cap C, identity calibration, 4-factor A requirement removed, defense context-only).
// Runs the REAL production NFL scorer `nflBacktestSeries` (live builders, live grade pipeline) on REAL nfl_player_game_stats rows for every historically testable family, and proves:
//   1  mutating the TARGET game's outcome cannot alter its own prediction;          2  mutating FUTURE games cannot alter earlier predictions;
//   3  mutating target + future cannot alter any prediction at or before the target;
//   4  mutating an eligible PRIOR game DOES alter a later prediction (non-vacuity);  5  the NEXT game after a mutated game CAN change (it is a legitimate prior there);
//   6  every history / window row used for a prediction is strictly EARLIER than the target (row-index marker run: per-game log, L5, L10 and season windows);
//   7  no current / future defensive snapshot enters model math (team-defense rank, DvP table and situational objects cannot change any output).
//   node scripts/test-nfl-leakage.js
const fs = require('fs'), path = require('path');
const { loadNflModel, HTML_PATH } = require('./lib/loadNflModel');
const { toGlRow, UNTESTABLE } = require('./lib/nflDiagData');
let failures = 0;
const check = (n, c, d) => { if (c) console.log(`PASS  ${n}`); else { failures++; console.log(`FAIL  ${n}${d ? '  -- ' + d : ''}`); } };
const CAPTURE = [];
const m = loadNflModel({ capture: true, sandboxExtras: { __capture: CAPTURE } }); CAPTURE.on = false; m.__setGradeCutoffs({}); m.__setProbCalib({});
const html = fs.readFileSync(HTML_PATH, 'utf8');
const SIGF = ['projection', 'predictiveSpreadSD', 'rawModelProbPct', 'modelProbPct', 'confidence', 'rawGrade', 'finalGrade', 'gradeAdjustmentReason', 'prime', 'wildGap', 'thinData', 'gradeScore', 'edge', 'totalFactors', 'greenCount', 'insufficientData', 'modelState'];
const sig = (e) => JSON.stringify(SIGF.map(k => e[k]));
const COMP = { passRushYds: 2, rushRecYds: 2 };   // component stats per family (marker multiplier)
const FUT = Date.now() + 6 * 3600e3;

console.log('# 0. configuration under test');
check('final NFL config is active: Cap C (floored), identity calibration, BETA metadata, defense NONE', m.NFL_GRADE_CONFIG.wildGapRule === 'floored' && m.NFL_GRADE_CONFIG.probCalib === null && m.nflModelMeta().modelState === 'BETA' && m.nflModelMeta().modelVersion === 'nfl-edge-2026.10-nodef-v1' && m.nflModelMeta().defenseFeature === 'NONE');
check('source: the NFL scorer slices windows / history with liveRows.slice(0, i) only and the NFL options (live builder)', /liveRows\.slice\(0, i\)\.filter\(g => _has\(g\.row\)\)/.test(html) && /nflComputeWindows\(liveRows\.slice\(0, i\), \[statKey\], \{ \[statKey\]: line \}/.test(html));
const dbPath = path.join(__dirname, '..', 'data', 'beatsedge.db');
if (!fs.existsSync(dbPath)) { console.log('SKIP  real-row leakage runs -- data/beatsedge.db absent'); process.exit(failures ? 1 : 0); }
const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(dbPath, { readOnly: true });
const all = db.prepare(`SELECT season, week, season_type, game_date, player_id, position, team, opponent, passing_yards, passing_tds, interceptions, rushing_yards, rushing_tds, receptions, targets, receiving_yards, receiving_tds, pass_attempts, completions, rush_attempts FROM nfl_player_game_stats WHERE game_date IS NOT NULL AND opponent IS NOT NULL ORDER BY game_date, season, week`).all();
const byP = new Map(); all.forEach(r => { let a = byP.get(r.player_id); if (!a) byP.set(r.player_id, a = []); a.push(r); });
const pick = []; for (const pos of ['QB', 'RB', 'WR', 'TE']) pick.push(...[...byP.values()].filter(p => p[0].position === pos && p.length >= 45).slice(0, 12));
const FIELDS = ['passingYards', 'passingTouchdowns', 'passingAttempts', 'completions', 'interceptions', 'rushingYards', 'rushingAttempts', 'rushingTouchdowns', 'receivingYards', 'receptions', 'receivingTouchdowns', 'receivingTargets'];
const setAll = (g, v) => { FIELDS.forEach(f => { g.row[f] = v; }); };
const build = (prow, mutFn) => { const rows = prow.map(toGlRow); if (mutFn) mutFn(rows); return rows; };
const series = (rows, k) => { const def = m.NFL_PROP_DEFS[k]; return { vals: rows.map(r => def.get(r.row) || 0), opps: rows.map(r => r.opponent), tss: rows.map(r => r.ts) }; };
// run the REAL scorer; gate = {minTs,maxTs}; returns [{ prop, e }] for every engine call (unsupported / insufficient ones included, their state is part of the signature)
function runScorer(rows, pos, k, gate) { const s = series(rows, k); CAPTURE.length = 0; CAPTURE.on = true; m.nflBacktestSeries(s.vals, s.opps, s.tss, pos, m.NFL_STAT_FAMILY[k], k, m.emptyBacktestAcc(), gate, rows); CAPTURE.on = false; return CAPTURE.slice().map(c => ({ c, e: m.calculateEdgeScore(c.player, c.prop) })); }
const prefix = (rows, pos, k, t) => runScorer(rows, pos, k, { maxTs: rows[t].ts + 1 });                 // every eligible prediction at index <= t
const single = (rows, pos, k, i) => runScorer(rows, pos, k, { minTs: rows[i].ts, maxTs: rows[i].ts + 1 });  // only index i
let seriesN = 0, predsCompared = 0, m1Bad = 0, m2Bad = 0, m12Bad = 0, m3Changed = 0, m3Total = 0, ctlChanged = 0, ctlTotal = 0, noTarget = 0; const statsSeen = new Set(), bad = [];
for (const prow of pick) { const pos = prow[0].position;
  for (const k of m.nflPosKeys(pos).filter(x => !UNTESTABLE.includes(x))) {
    const base0 = build(prow); let t = -1; for (let i = 20 + (prow[0].player_id.length * 3) % 7; i < base0.length - 6; i++) { if (single(base0, pos, k, i).length === 2 && single(base0, pos, k, i)[0].e && !single(base0, pos, k, i)[0].e.insufficientData) { t = i; break; } } if (t < 0) { noTarget++; continue; }
    seriesN++; statsSeen.add(k); const basePre = prefix(base0, pos, k, t).map(x => sig(x.e)), baseT = single(base0, pos, k, t).map(x => sig(x.e));
    const later = (rows, f) => { for (let j = t + 1; j < rows.length; j++) setAll(rows[j], f(j)); };
    const cmp = (rows, label) => { const p = prefix(rows, pos, k, t).map(x => sig(x.e)), s1 = single(rows, pos, k, t).map(x => sig(x.e)); predsCompared += p.length; const diff = (p.length !== basePre.length ? 1 : p.filter((x, i) => x !== basePre[i]).length) + (s1.length !== baseT.length ? 1 : s1.filter((x, i) => x !== baseT[i]).length); if (diff) bad.push(`${prow[0].player_id}/${k}/${label}: ${diff} differ`); return diff ? 1 : 0; };
    m1Bad += cmp(build(prow, (r) => setAll(r[t], 9999)), 'M1');
    m2Bad += cmp(build(prow, (r) => later(r, (j) => j % 2 ? 9000 + j : 0)), 'M2');
    m12Bad += cmp(build(prow, (r) => { setAll(r[t], 9999); later(r, (j) => j % 2 ? 9000 + j : 0); }), 'M1+M2');
    const m3 = single(build(prow, (r) => setAll(r[t - 3], 400)), pos, k, t).map(x => sig(x.e)); m3Total++; if (m3.length === baseT.length && m3.some((x, i) => x !== baseT[i])) m3Changed++;
    // control: the next eligible game after a mutated game is capable of changing
    let nx = -1; for (let i = t + 1; i < base0.length; i++) { const s = single(base0, pos, k, i); if (s.length === 2 && !s[0].e.insufficientData) { nx = i; break; } }
    if (nx > 0) { const bN = single(base0, pos, k, nx).map(x => sig(x.e)), mN = single(build(prow, (r) => setAll(r[t], 9999)), pos, k, nx).map(x => sig(x.e)); ctlTotal++; if (mN.length === bN.length && mN.some((x, i) => x !== bN[i])) ctlChanged++; } } }
console.log(`\n# 1. mutation runs: ${pick.length} players x all testable families -> ${seriesN} series with a scored target (${noTarget} without), ${statsSeen.size}/14 families; ${predsCompared} predictions compared across the mutation runs`);
check('coverage: every historically testable NFL family (14 stats) was exercised on real rows', statsSeen.size === 14 && seriesN >= 250, `stats=${statsSeen.size} series=${seriesN}`);
check('1. mutating the TARGET game\'s outcome (all stat fields) changes NOTHING at or before the target (projection, spread, probability, cap, grade, Prime, ...)', m1Bad === 0, bad.filter(x => /\/M1:/.test(x)).slice(0, 3).join(' | '));
check('2. mutating ALL later games (absurd highs and zeros) changes NOTHING at or before the target', m2Bad === 0, bad.filter(x => /\/M2:/.test(x)).slice(0, 3).join(' | '));
check('3. mutating the target AND all later games changes NOTHING at or before the target', m12Bad === 0, bad.filter(x => /M1\+M2/.test(x)).slice(0, 3).join(' | '));
check(`4. NON-VACUOUS: mutating an eligible PRIOR game (t-3) changes the target prediction (${m3Changed}/${m3Total})`, m3Total >= 250 && m3Changed >= Math.floor(m3Total * 0.95), `${m3Changed}/${m3Total}`);
check(`5. CONTROL: the same target-game mutation DOES change the NEXT game's prediction, where it is a legitimate prior (${ctlChanged}/${ctlTotal})`, ctlTotal >= 250 && ctlChanged >= Math.floor(ctlTotal * 0.90), `${ctlChanged}/${ctlTotal}`);

console.log('\n# 6. marker run: every history / window row is strictly earlier than the target game');
{ let n = 0, longLogs = 0, badLog = [], badWin = [], badSeason = [], tsViol = 0; const r1 = (x) => Math.round(x * 10) / 10;
  for (const prow of pick.slice(0, 24)) { const pos = prow[0].position; const rowsBase = prow.map(toGlRow); for (let i = 1; i < rowsBase.length; i++) if (!(rowsBase[i - 1].ts < rowsBase[i].ts)) tsViol++;
    for (const k of m.nflPosKeys(pos).filter(x => !UNTESTABLE.includes(x))) { const comp = COMP[k] || 1; const rows = build(prow, (rs) => rs.forEach((g, j) => setAll(g, 1000 + j)));
      for (let i = 6; i < rows.length; i++) { const s = single(rows, pos, k, i); if (s.length !== 2 || s[0].e.insufficientData) continue; n++; const player = s[0].c.player, log = (player.gameLogByKey[k] || []), idx = log.map(g => Math.round(g.points / comp) - 1000), len = Math.min(40, i); if (len === 40) longLogs++;
        if (!(idx.length === len && idx.every((v, q) => v === i - len + q))) badLog.push(`${prow[0].player_id}/${k}/i=${i}: ${idx.slice(0, 2)}..${idx.slice(-2)} len ${idx.length}`);
        const w = player.statsByKey[k], mu = (a, b) => { let sum = 0; for (let j = a; j < b; j++) sum += comp * (1000 + j); return sum / (b - a); };
        if (!(w && w.last5 && w.last10 && Math.abs(w.last5.avg - r1(mu(Math.max(0, i - 5), i))) < 0.051 && Math.abs(w.last10.avg - r1(mu(Math.max(0, i - 10), i))) < 0.051)) badWin.push(`${prow[0].player_id}/${k}/i=${i}`);   // (fewer than 10 earlier rows: the window is every earlier row)
        if (!(w && w.season && w.season.games === i && Math.abs(w.season.avg - r1(mu(0, i))) < 0.051)) badSeason.push(`${prow[0].player_id}/${k}/i=${i}: games ${w && w.season && w.season.games}/${i}`); } } }
  check(`row timestamps are strictly increasing within every sampled player history (violations: ${tsViol}), so "index < i" means "date strictly earlier"`, tsViol === 0);
  check(`6. ${n} scored predictions (${longLogs} with the full 40-game log): the per-game log is exactly the strictly-earlier rows (newest = target-1; never the target row or a later row)`, n >= 2000 && badLog.length === 0, badLog.slice(0, 3).join(' | '));
  check(`6. ${n} scored predictions: L5 and L10 windows equal the means of rows t-5..t-1 and t-10..t-1 only`, badWin.length === 0, badWin.slice(0, 3).join(' | '));
  check(`6. ${n} scored predictions: the season window (the loaded gamelog) is exactly the strictly-earlier rows 0..t-1 (games count and average)`, badSeason.length === 0, badSeason.slice(0, 3).join(' | ')); }

console.log('\n# 7. no current / future defensive snapshot enters model math');
{ let n = 0, diff = 0, ctx = 0; const STATS = m.nflPosKeys('WR').concat(m.nflPosKeys('QB')).filter((x, i, a) => a.indexOf(x) === i && !UNTESTABLE.includes(x));
  for (const prow of pick.filter((_, i) => i % 3 === 0)) { const pos = prow[0].position, rows = prow.map(toGlRow);
    for (const k of m.nflPosKeys(pos).filter(x => !UNTESTABLE.includes(x))) for (const t of [20, 32]) { if (t >= rows.length) continue; const def = m.NFL_PROP_DEFS[k], has = m.nflHasFor(def, m.NFL_WINDOW_OPTS); const hv = rows.slice(0, t).filter(g => has(g.row)).map(g => def.get(g.row) || 0); if (!hv.length) continue; const avg = hv.reduce((a, b) => a + b, 0) / hv.length; if (avg <= 0) continue;
      const line = Math.max(0.5, Math.round(avg) - 0.5) + (avg > 15 ? 0 : 0.5); const w = m.nflComputeWindows(rows.slice(0, t), [k], { [k]: line }, rows[t].opponent, rows[t].season, m.NFL_WINDOW_OPTS); if (!w.statsByKey[k]) continue;
      const mkP = (extra) => Object.assign({ id: 'z', sport: 'nfl', role: 'skill', position: pos, opponent: rows[t].opponent, statsByKey: w.statsByKey, gameLogByKey: w.gameLogByKey, stats: {}, gameLog: [] }, extra);
      const variants = [{ oppDef: null }, { oppDef: { rank: 1, paPerGame: 9.1 } }, { oppDef: { rank: 32, paPerGame: 40.3 } }, { oppDef: { rank: 12, paPerGame: 20 }, opponentDefense: { byPosition: { [pos]: { rank: 1, passingYardsAllowed: 9999, rushingYardsAllowed: 9999, receivingYardsAllowed: 9999 } }, defenseInterceptions: { rank: 1 } } }, { oppDef: { rank: 30, paPerGame: 33 }, paceRating: 'neutral' }];
      for (const dir of ['over', 'under']) { let ref = null; for (const v of variants) { const e = m.calculateEdgeScore(mkP(v), { statKey: k, type: def.type, line, direction: dir, lineSource: 'ParlayAPI · prizepicks', eventId: 'e', commenceTimeMs: FUT }); n++; const sg = sig(e); if (ref == null) ref = sg; else if (sg !== ref) diff++; if ((e.context || []).some(c => c.key === 'oppdef')) ctx++; } } } }
  check(`7. ${n} NFL scorings with team-defense rank 1 / 12 / 30 / 32 / absent, an absurd DvP-by-position object, defensive-interception data: every output field is IDENTICAL (the rank is context-only; ${ctx} context rows shown)`, n > 300 && diff === 0, `diff=${diff}`);
  check('7. source: the NFL projection multiplier is gated to CFB only; the NFL defense factor is pushed to context only; the generic DvP factor / nudge exclude NFL', /if \(sport === 'ncaaf' && player\.oppDef && player\.oppDef\.rank\) \{/.test(html) && /\(sport === 'nfl' \? contextFactors : factors\)\.push\(\{\s*\n\s*key: 'oppdef'/.test(html) && /posDefense && sport !== 'nfl' && sport !== 'ncaaf'/.test(html) && /posDefense && posDefense\.rank !== undefined && sport !== 'nfl' && sport !== 'ncaaf' && sport !== 'nba'/.test(html));
  // LATENT PATH (documented, unreachable): the engine's generic rest / venue factors read `player.situational` (backend, points-based splits). It is attached ONLY by fetchPlayerSituationalData,
  // which returns immediately unless the selected sport is NBA, and no NFL player constructor sets it -- so no such snapshot can reach NFL model math.
  check('7. situational (backend splits) can never reach an NFL player: its only attachment point is NBA-only, and the NFL player builder never sets it', /const fetchPlayerSituationalData = async \(players\) => \{\s*\n\s*if \(!backendUrl \|\| selectedSport !== 'nba'\) return;/.test(html) && !/_isNfl: true[^\n]*situational|situational[^\n]*_isNfl: true/.test(html) && (() => { const i = html.indexOf("id: slot.id, name: slot.name, sport: 'nfl', role: 'skill',"); return i > 0 && !/situational/.test(html.slice(i, i + 1600)); })());
  check('7. the scorer feeds the model NO defensive snapshot at all (oppDef / opponentDefense / situational are null in every backtest player)', /opponentDefense: null, oppDef: null, situational: null \};\s*\n\s*for \(const dir of \['over', 'under'\]\) \{\s*\n\s*const e = calculateEdgeScore\(fake, \{ statKey, type: _def\.type/.test(html)); }
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
