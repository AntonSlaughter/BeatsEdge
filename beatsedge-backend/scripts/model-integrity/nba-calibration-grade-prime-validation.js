// NBA vNext (nba-edge-2026.10-nodef-v1) -- CALIBRATION, GRADE and PRIME validation.   PLAYER-STAT PREDICTION VALIDATION on a SYNTHETIC pseudo-line.
// NOT real-line / market validation (DATA GAP). Nothing here changes the model; production code is untouched.
//
// ================= PREDECLARED (before any result was seen) =================
// Probability-calibration candidates (3, no search):
//   A  CURRENT DEFAULT, unchanged: GRADE_CUTOFFS {}, PROB_CALIB {} (identity curve), FAMILY_CALIB Prime layer as shipped.   -> `modelProbPct`
//   B  IDENTITY / no calibration at all: the sport-calibrated value before the Prime-scoped family layer (engine `sportCalibProbPct`).
//   C  ONE simple recalibration = the app's OWN mechanism: the monotone piecewise curve `deriveProbCalib()` (pool-adjacent-violators over the
//      raw-probability buckets of an in-app backtest), derived ONLY from strictly EARLIER seasons and installed as PROB_CALIB.nba, then scored
//      through the real engine on the next, unseen season.  Expanding walk-forward: fit 2021-22 -> test 2023; fit 2021-23 -> test 2024; fit 2021-24 -> test 2025.
//   C wins iff, on the pooled unseen seasons: Brier(C) < Brier(A) with the 95% date-block-bootstrap CI excluding 0; |slope-1| smaller; ECE not worse;
//   AND Brier better in every one of the 3 test seasons.  Otherwise A stays.
// Grades: the existing thresholds, NOT retuned, evaluated (a) as the backtest convention scores them (lineSource 'backtest') and (b) AS SERVED LIVE
//   (lineSource set => Prime promotes C/D to A, and the probability-reconciliation rules run). Both are reported; (b) is what a user would see.
// Prime: rules untouched; decomposed and validated.
//
// LIVE = BACKTEST: inputs come from the live builders (scripts/lib/nbaHistoricalInputs.js); the same calculateEdgeScore is used.
//
//   node scripts/model-integrity/nba-calibration-grade-prime-validation.js [--per-season 15000] [--boot 300]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { loadModel } = require('../lib/loadBeatsEdgeModel');
const { buildLiveShapedNbaPlayer } = require('../lib/nbaHistoricalInputs');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const PER_SEASON = Number(arg('per-season', 15000)), BOOT = Number(arg('boot', 300)), SEED = Number(arg('seed', 20261006));
const OUT = path.resolve(__dirname, '..', '..', arg('out', 'tmp/model-integrity/nba-calibration-grade-prime'));
const OLD_HTML = path.resolve(__dirname, '..', '..', 'tmp/model-integrity/baseline/BeatsEdge.pre-defense-removal.html');
const SEASONS = [2021, 2022, 2023, 2024, 2025], TEST_SEASONS = [2023, 2024, 2025];
const MIN_PRIOR_GAMES = 10, MIN_AVG_MIN = 15, MIN_TEAM_GAMES = 10;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(SEED);

// ---------------------------------------------------------------- models
const mDef = loadModel({ liveNba: true });     // A / B  (default config)
const mCur = loadModel({ liveNba: true });     // C      (PROB_CALIB.nba = walk-forward curve, set per fold)
const mOld = loadModel({ liveNba: true, htmlPath: OLD_HTML });   // previous production, only for the Prime-coverage decomposition
for (const m of [mDef, mCur, mOld]) { m.__setGradeCutoffs({}); m.__setProbCalib({}); }
const CALIB_ID = mDef.NBA_CALIBRATION_ID;
const BACKTEST = 'backtest', SERVED = 'validation-synthetic-line';   // any truthy lineSource other than 'backtest' => the live post-rules run (no price => no price cap)

const FAMS = {
  points: { label: 'PTS', get: r => r.points }, rebounds: { label: 'REB', get: r => r.rebounds }, assists: { label: 'AST', get: r => r.assists }, threes: { label: '3PM', get: r => r.threes },
  steals: { label: 'STL', get: r => r.steals }, blocks: { label: 'BLK', get: r => r.blocks }, turnovers: { label: 'TOV', get: r => r.turnovers },
  pra: { label: 'PRA', get: r => r.points + r.rebounds + r.assists, combo: true }, pr: { label: 'PR', get: r => r.points + r.rebounds, combo: true }, pa: { label: 'PA', get: r => r.points + r.assists, combo: true },
  ra: { label: 'RA', get: r => r.rebounds + r.assists, combo: true }, blocksSteals: { label: 'BLK+STL', get: r => r.blocks + r.steals, combo: true },
};
const FKEYS = Object.keys(FAMS);
const GET7 = [r => r.points, r => r.rebounds, r => r.assists, r => r.threes, r => r.steals, r => r.blocks, r => r.turnovers];
const GROUPS = ['G', 'F', 'C'], NSTAT = 7;

// ---------------------------------------------------------------- data (+ hygiene), as-of DvP (OLD model inputs only)
const db = new DatabaseSync(path.resolve(__dirname, '..', '..', 'data', 'beatsedge.db'), { readOnly: true });
const allRaw = db.prepare(`SELECT game_id, athlete_id, season, season_type, game_date, team, opponent, home_away, pos_group, starter, minutes, points, rebounds, assists, threes, steals, blocks, turnovers
  FROM nba_player_box WHERE season_type IN (2,3) AND played = 1 AND minutes > 0 AND season >= 2019 AND pos_group IN ('G','F','C') AND points IS NOT NULL AND rebounds IS NOT NULL AND assists IS NOT NULL
  AND threes IS NOT NULL AND steals IS NOT NULL AND blocks IS NOT NULL AND turnovers IS NOT NULL ORDER BY game_date, game_id`).all();
const teamSeasons = new Map(); allRaw.forEach(r => { let s = teamSeasons.get(r.team); if (!s) teamSeasons.set(r.team, s = new Set()); s.add(r.season); });
const realTeams = new Set([...teamSeasons].filter(([, s]) => s.size >= 5).map(([t]) => t));
const tdG = new Map(); allRaw.forEach(r => { const k = r.team + '|' + r.game_date; let s = tdG.get(k); if (!s) tdG.set(k, s = new Set()); s.add(r.game_id); });
const badTD = new Set([...tdG].filter(([, s]) => s.size > 1).map(([k]) => k));
const hygiene = { rawRows: allRaw.length, nonNbaTeamRows: 0, duplicatedTeamDateRows: 0 };
const all = allRaw.filter(r => {
  if (!realTeams.has(r.team) || !realTeams.has(r.opponent)) { hygiene.nonNbaTeamRows++; return false; }
  if (badTD.has(r.team + '|' + r.game_date) || badTD.has(r.opponent + '|' + r.game_date)) { hygiene.duplicatedTeamDateRows++; return false; }
  return true;
});
const teamDates = new Map(); all.forEach(r => { let s = teamDates.get(r.team); if (!s) teamDates.set(r.team, s = new Set()); s.add(r.game_date); });
const teamDatesSorted = new Map([...teamDates].map(([t, s]) => [t, [...s].sort()]));
function prevTeamDate(team, date) { const a = teamDatesSorted.get(team); let lo = 0, hi = a.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < date) lo = mid + 1; else hi = mid; } return lo > 0 ? a[lo - 1] : null; }
function buildSnaps(rows) {
  const bySeason = new Map(); rows.filter(r => r.season_type === 2).forEach(r => { let s = bySeason.get(r.season); if (!s) bySeason.set(r.season, s = new Map()); let d = s.get(r.game_date); if (!d) s.set(r.game_date, d = []); d.push(r); });
  const snaps = new Map();
  for (const [season, dates] of bySeason) { const teams = new Map();
    for (const date of [...dates.keys()].sort()) { const snap = new Map(); teams.forEach((o, t) => snap.set(t, { n: o.games.size, a: Float64Array.from(o.a) })); snaps.set(season + '|' + date, snap);
      dates.get(date).forEach(r => { let o = teams.get(r.opponent); if (!o) teams.set(r.opponent, o = { games: new Set(), a: new Float64Array(3 * NSTAT) }); o.games.add(r.game_id); const g = GROUPS.indexOf(r.pos_group); for (let j = 0; j < NSTAT; j++) o.a[g * NSTAT + j] += GET7[j](r); }); } }
  return snaps;
}
const SNAPS = buildSnaps(all), rankCache = new Map();
function ranksFor(key, snap, idx) { const ck = key + '|' + idx.join(','); let m = rankCache.get(ck); if (m) return m; const cells = []; snap.forEach((o, t) => { if (o.n < MIN_TEAM_GAMES) return; GROUPS.forEach((g, gi) => cells.push({ k: t + '|' + g, v: idx.reduce((s, j) => s + o.a[gi * NSTAT + j], 0) / o.n })); });
  cells.sort((a, b) => a.v - b.v || (a.k < b.k ? -1 : 1)); m = new Map(); cells.forEach((c, i) => m.set(c.k, cells.length > 1 ? 1 + i * 149 / (cells.length - 1) : 75.5)); rankCache.set(ck, m); return m; }
function teamPtsRank(key, snap) { const ck = key + '|t30'; let m = rankCache.get(ck); if (m) return m; const arr = []; snap.forEach((o, t) => { if (o.n >= MIN_TEAM_GAMES) arr.push({ t, v: [0, 1, 2].reduce((s, g) => s + o.a[g * NSTAT], 0) / o.n }); }); arr.sort((a, b) => a.v - b.v); m = new Map(arr.map((x, i) => [x.t, i + 1])); rankCache.set(ck, m); return m; }
function oldDefenseInputs(season, date, opp) { const key = season + '|' + date, snap = SNAPS.get(key); if (!snap || !snap.get(opp) || snap.get(opp).n < MIN_TEAM_GAMES) return null; let e = 0; snap.forEach(o => { if (o.n >= MIN_TEAM_GAMES) e++; }); if (e < 20) return null;
  const by = {}; for (const g of GROUPS) { const rk = [0, 1, 2, 3, 4, 5, 6].map(j => ranksFor(key, snap, [j]).get(opp + '|' + g)); if (rk.some(x => x == null)) return null;
    by[g] = { rank: Math.round(rk[0]), rebRank: Math.round(rk[1]), astRank: Math.round(rk[2]), tpmRank: Math.round(rk[3]), stlRank: Math.round(rk[4]), blkRank: Math.round(rk[5]), toRank: Math.round(rk[6]), pointsAllowed: 0, reboundsAllowed: 0, assistsAllowed: 0, threesAllowed: 0, stealsAllowed: 0, blocksAllowed: 0, turnoversAllowed: 0 }; }
  return { byPosition: by, oppRankByAbbr: Object.fromEntries(teamPtsRank(key, snap)), oppRank: teamPtsRank(key, snap).get(opp) || null }; }

// ---------------------------------------------------------------- sampling (identical procedure/seed to nba-full-model-validation.js)
const byPlayer = new Map(); all.forEach(r => { let a = byPlayer.get(r.athlete_id); if (!a) byPlayer.set(r.athlete_id, a = []); a.push(r); });
const samples = [];
for (const season of SEASONS) {
  const elig = [];
  for (const [pid, rows] of byPlayer) { const start = rows.findIndex(r => r.season >= season - 1); if (start < 0) continue;
    for (let i = start; i < rows.length; i++) { const r = rows[i]; if (r.season !== season || r.season_type !== 2 || i - start < MIN_PRIOR_GAMES) continue;
      const m10 = rows.slice(Math.max(start, i - 10), i); if (m10.reduce((s, x) => s + x.minutes, 0) / m10.length < MIN_AVG_MIN) continue;
      if (!oldDefenseInputs(season, r.game_date, r.opponent)) continue; elig.push({ rows, start, i }); } }
  for (let k = elig.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [elig[k], elig[j]] = [elig[j], elig[k]]; }
  const take = elig.slice(0, PER_SEASON); console.log(`season ${season}: eligible ${elig.length}, sampled ${take.length}`); take.forEach(e => samples.push(Object.assign({ season }, e)));
}
const mean = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
function pseudoLine(hv) { const avg = mean(hv); let line = null, best = 99; for (let c = 0.5; c <= avg * 2.2 + 1; c += 1) { const over = hv.filter(v => v > c).length / hv.length; const gap = Math.abs(over - 0.48); if (gap < best) { best = gap; line = c; } } return line; }
const GR = { A: 0, B: 1, C: 2, D: 3 }, GL = ['A', 'B', 'C', 'D'];

// ---------------------------------------------------------------- sequential walk-forward run
const recs = []; const dateIdx = new Map(); let nd = 0;
const accTrain = mDef.emptyBacktestAcc();   // raw-probability buckets of all EARLIER seasons (what an in-app backtest would have seen)
const folds = {};                            // season -> { curve, trainedOn, note }
const t0 = Date.now();
for (const season of SEASONS) {
  let useCurve = false;
  if (TEST_SEASONS.includes(season)) {
    const curve = mDef.deriveProbCalib(accTrain.probRaw);
    folds[season] = { trainedOn: SEASONS.filter(s => s < season), curve, note: curve ? 'derived' : 'null (already calibrated / thin) => identity' };
    mCur.__setProbCalib(curve ? { nba: curve } : {}); mCur.bumpEdgeCache(); useCurve = true;
    console.log(`fold ${season}: trained on ${folds[season].trainedOn.join(',')} curve=${JSON.stringify(curve)}`);
  }
  const seasonRecs = [];
  for (const s of samples.filter(x => x.season === season)) {
    const target = s.rows[s.i], hist = s.rows.slice(s.start, s.i), lineFor = {};
    for (const k of FKEYS) { const hv = hist.map(FAMS[k].get); if (mean(hv) <= 0) continue; const line = pseudoLine(hv); if (line != null && line > 0) lineFor[k] = { line, trail: hv.filter(v => v > line).length / hv.length }; }
    if (!Object.keys(lineFor).length) continue;
    const lf = Object.fromEntries(Object.entries(lineFor).map(([k, v]) => [k, v.line]));
    const ptd = prevTeamDate(target.team, target.game_date), def = oldDefenseInputs(season, target.game_date, target.opponent);
    const pNew = buildLiveShapedNbaPlayer(mDef, { target, hist, lineFor: lf, prevTeamDate: ptd });
    const pCur = useCurve ? buildLiveShapedNbaPlayer(mCur, { target, hist, lineFor: lf, prevTeamDate: ptd }) : null;
    const pOld = buildLiveShapedNbaPlayer(mOld, { target, hist, lineFor: lf, prevTeamDate: ptd, oppRankByAbbr: def.oppRankByAbbr, opponentDefense: { byPosition: def.byPosition }, oppRank: def.oppRank });
    let di = dateIdx.get(target.game_date); if (di == null) { di = nd++; dateIdx.set(target.game_date, di); }
    for (const k of FKEYS) {
      if (!lineFor[k]) continue; const actual = FAMS[k].get(target), line = lineFor[k].line; if (actual === line) continue;
      const rec = { season, di, fam: k, g: target.pos_group, actual, line, trail: lineFor[k].trail };
      for (const [d, dir] of [['o', 'over'], ['u', 'under']]) {
        const pb = { statKey: k, type: k, line, direction: dir, lineSource: BACKTEST }, ps = { statKey: k, type: k, line, direction: dir, lineSource: SERVED };
        const eB = mDef.calculateEdgeScore(pNew, pb), eS = mDef.calculateEdgeScore(pNew, ps), eO = mOld.calculateEdgeScore(pOld, pb);
        if (eB.insufficientData) { rec.bad = true; break; }
        rec['hit' + d] = (dir === 'over' ? actual > line : actual < line) ? 1 : 0;
        rec['gb' + d] = GR[eB.grade]; rec['gv' + d] = GR[eS.grade]; rec['gs' + d] = eB.gradeScore;
        rec['pf' + d] = eB.modelProbPct; rec['pr' + d] = eB.rawModelProbPct; rec['ps' + d] = eB.sportCalibProbPct;
        rec['prime' + d] = eB.prime ? 1 : 0; rec['cs' + d] = eB.totalFactors ? eB.greenCount / eB.totalFactors : 0; rec['tf' + d] = eB.totalFactors;
        rec['es' + d] = eB.edgeSignalPct; rec['thin' + d] = eB.thinData ? 1 : 0; rec['red' + d] = eB.matchupLabel === 'RED MATCHUP' ? 1 : 0;
        rec['famAdj' + d] = eB.familyAdjPts;
        rec['primeO' + d] = eO.prime ? 1 : 0; rec['csO' + d] = eO.totalFactors ? eO.greenCount / eO.totalFactors : 0; rec['esO' + d] = eO.edgeSignalPct; rec['thinO' + d] = eO.thinData ? 1 : 0; rec['redO' + d] = eO.matchupLabel === 'RED MATCHUP' ? 1 : 0; rec['gbO' + d] = GR[eO.grade];
        if (useCurve) { const eC = mCur.calculateEdgeScore(pCur, ps), eCb = mCur.calculateEdgeScore(pCur, pb); rec['pc' + d] = eC.modelProbPct; rec['gvc' + d] = GR[eC.grade]; rec['pcs' + d] = eC.sportCalibProbPct; rec['gbc' + d] = GR[eCb.grade]; }
      }
      if (!rec.bad) seasonRecs.push(rec);
    }
  }
  // after the season: add its sides (default-model, backtest convention -- exactly what the in-app backtest tallies) to the training accumulator
  seasonRecs.forEach(r => ['o', 'u'].forEach(d => mDef.btFileProb(accTrain, r['pf' + d], r['pr' + d], r['hit' + d] === 1)));
  for (const r of seasonRecs) recs.push(r);   // (spread would overflow the call stack at ~180k records)
  console.log(`season ${season} done: ${seasonRecs.length} records (${Math.round((Date.now() - t0) / 1000)}s)`);
}

// ---------------------------------------------------------------- statistics helpers
const clip = (p) => Math.min(0.999, Math.max(0.001, p));
const wilson = (h, n) => { if (!n) return [NaN, NaN]; const z = 1.96, p = h / n, d = 1 + z * z / n, c = p + z * z / (2 * n), a = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - a) / d, (c + a) / d]; };
function calib(ps, ys) {
  const p = ps.map(clip), n = p.length; if (!n) return null;
  const brier = mean(p.map((v, i) => (v - ys[i]) ** 2)), ll = mean(p.map((v, i) => -(ys[i] ? Math.log(v) : Math.log(1 - v))));
  const bk = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 })); p.forEach((v, i) => { const b = bk[Math.min(9, Math.floor(v * 10))]; b.n++; b.p += v; b.y += ys[i]; });
  const ece = bk.reduce((s, b) => s + (b.n ? (b.n / n) * Math.abs(b.p / b.n - b.y / b.n) : 0), 0);
  const x = p.map(v => Math.log(v / (1 - v))); let a = 0, b = 1;
  for (let it = 0; it < 25; it++) { let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0; for (let i = 0; i < n; i++) { const q = 1 / (1 + Math.exp(-(a + b * x[i]))), w = q * (1 - q); g0 += ys[i] - q; g1 += (ys[i] - q) * x[i]; h00 += w; h01 += w * x[i]; h11 += w * x[i] * x[i]; } const det = h00 * h11 - h01 * h01; if (Math.abs(det) < 1e-12) break; a += (h11 * g0 - h01 * g1) / det; b += (-h01 * g0 + h00 * g1) / det; }
  return { n, brier, logLoss: ll, ece, slope: b, intercept: a, meanP: mean(p), rate: mean(ys), buckets: bk.map((b, i) => ({ lo: i / 10, n: b.n, meanP: b.n ? b.p / b.n : null, rate: b.n ? b.y / b.n : null })) };
}
function auc(ps, ys) { // Mann-Whitney AUC over integer-percent bins
  const pos = new Float64Array(101), neg = new Float64Array(101); ps.forEach((p, i) => { const b = Math.max(0, Math.min(100, Math.round(p))); (ys[i] ? pos : neg)[b]++; });
  let np = 0, nn = 0; pos.forEach(v => np += v); neg.forEach(v => nn += v); if (!np || !nn) return NaN; let s = 0, cumNeg = 0; for (let b = 0; b <= 100; b++) { s += pos[b] * (cumNeg + neg[b] / 2); cumNeg += neg[b]; } return s / (np * nn);
}
function bootDiff(rs, fn) { const by = new Map(); rs.forEach(r => { let o = by.get(r.di); if (!o) by.set(r.di, o = { s: 0, n: 0 }); o.s += fn(r); o.n++; }); const bl = [...by.values()], N = rs.length, est = bl.reduce((s, b) => s + b.s, 0) / N, r2 = rng(SEED ^ 0x9e3779b1), ss = [];
  for (let b = 0; b < BOOT; b++) { let s = 0, n = 0; for (let k = 0; k < bl.length; k++) { const x = bl[Math.floor(r2() * bl.length)]; s += x.s; n += x.n; } ss.push(s / n); } ss.sort((a, c) => a - c); return { est, lo: ss[Math.floor(0.025 * BOOT)], hi: ss[Math.floor(0.975 * BOOT)] }; }
const sidesOf = (rs, pk, gk) => { const o = []; rs.forEach(r => ['o', 'u'].forEach(d => o.push({ r, d, p: r[pk + d] / 100, pct: r[pk + d], g: gk ? r[gk + d] : null, hit: r['hit' + d] }))); return o; };
const cal = (rs, pk) => { const s = sidesOf(rs, pk); return calib(s.map(x => x.p), s.map(x => x.hit)); };

// ---------------------------------------------------------------- 1. calibration candidates (unseen seasons only)
const testRecs = recs.filter(r => TEST_SEASONS.includes(r.season));
const R = { meta: { generated: new Date().toISOString(), modelVersion: mDef.NBA_MODEL_VERSION, calibrationDefaultId: CALIB_ID, perSeason: PER_SEASON, seed: SEED, bootstrap: BOOT, hygiene, records: recs.length, testRecords: testRecs.length, folds: Object.fromEntries(Object.entries(folds).map(([k, v]) => [k, { trainedOn: v.trainedOn, curve: v.curve, note: v.note }])),
  scope: 'PLAYER-STAT PREDICTION VALIDATION on a SYNTHETIC pseudo-line; NOT market validation.' } };
const CAND = { A: 'pf', B: 'ps', C: 'pc' };
R.cal = { overall: {}, bySeason: {}, byDirection: {}, byFamily: {} };
for (const [c, pk] of Object.entries(CAND)) {
  R.cal.overall[c] = cal(testRecs, pk);
  R.cal.bySeason[c] = Object.fromEntries(TEST_SEASONS.map(s => [s, cal(testRecs.filter(r => r.season === s), pk)]));
  R.cal.byDirection[c] = Object.fromEntries([['over', 'o'], ['under', 'u']].map(([nm, d]) => { const s = sidesOf(testRecs, pk).filter(x => x.d === d); return [nm, calib(s.map(x => x.p), s.map(x => x.hit))]; }));
  R.cal.byFamily[c] = Object.fromEntries(FKEYS.map(k => [k, cal(testRecs.filter(r => r.fam === k), pk)]));
}
const brierSide = (pk) => (r) => ['o', 'u'].reduce((a, d) => a + (clip(r[pk + d] / 100) - r['hit' + d]) ** 2, 0) / 2;
R.cal.diff = { 'C-A': bootDiff(testRecs, (r) => brierSide('pc')(r) - brierSide('pf')(r)), 'B-A': bootDiff(testRecs, (r) => brierSide('ps')(r) - brierSide('pf')(r)) };
R.cal.diffBySeason = Object.fromEntries(TEST_SEASONS.map(s => { const rs = testRecs.filter(r => r.season === s); return [s, { 'C-A': mean(rs.map(r => brierSide('pc')(r) - brierSide('pf')(r))), 'B-A': mean(rs.map(r => brierSide('ps')(r) - brierSide('pf')(r))) }]; }));
const o = R.cal.overall;
const cWins = R.cal.diff['C-A'].hi < 0 && Math.abs(o.C.slope - 1) < Math.abs(o.A.slope - 1) && o.C.ece <= o.A.ece + 1e-9 && TEST_SEASONS.every(s => R.cal.diffBySeason[s]['C-A'] < 0);
R.cal.winner = cWins ? 'C' : 'A';
R.cal.winnerRule = 'C wins iff Brier(C)<Brier(A) with 95% CI excluding 0, |slope-1| smaller, ECE not worse, and Brier better in each of the 3 unseen seasons';
const W = R.cal.winner; const WP = W === 'C' ? 'pc' : 'pf', WG = W === 'C' ? 'gvc' : 'gv', WGB = W === 'C' ? 'gbc' : 'gb';
// does calibration move the grade? (grade is computed from gradeScore/confidence; only the live reconciliation guards read the probability)
R.cal.gradeIndependence = { baseGradeIdenticalAcrossCandidates: testRecs.every(r => r.gbo === r.gbco && r.gbu === r.gbcu), servedGradeChangedByCurve: testRecs.reduce((a, r) => a + (r.gvo !== r.gvco ? 1 : 0) + (r.gvu !== r.gvcu ? 1 : 0), 0), sides: testRecs.length * 2 };

// ---------------------------------------------------------------- 2. grades
function gradeRows(rs, gk, pk) { const s = sidesOf(rs, pk, gk); return GL.map((G, gi) => { const x = s.filter(z => z.g === gi), h = x.reduce((a, z) => a + z.hit, 0), ci = wilson(h, x.length); return { grade: G, n: x.length, cov: s.length ? x.length / s.length : 0, rate: x.length ? h / x.length : null, lo: ci[0], hi: ci[1], meanP: x.length ? mean(x.map(z => z.p)) : null }; }); }
const mono = (t, tol = 0.005) => { const r = t.filter(x => x.n >= 200).map(x => x.rate); return r.every((v, i) => i === 0 || v <= r[i - 1] + tol); };
const monoViol = (t) => { const r = t.filter(x => x.n >= 200); let worst = 0, pair = null; for (let i = 1; i < r.length; i++) { const d = r[i].rate - r[i - 1].rate; if (d > worst) { worst = d; pair = r[i - 1].grade + '<' + r[i].grade; } } return { worst, pair }; };
R.grades = {
  winner: W,
  servedWinnerTest: gradeRows(testRecs, WG, WP), baseWinnerTest: gradeRows(testRecs, WGB, WP),
  servedDefaultAll: gradeRows(recs, 'gv', 'pf'), baseDefaultAll: gradeRows(recs, 'gb', 'pf'),
  bySeasonServed: Object.fromEntries(SEASONS.map(s => [s, gradeRows(recs.filter(r => r.season === s), 'gv', 'pf')])),
  bySeasonBase: Object.fromEntries(SEASONS.map(s => [s, gradeRows(recs.filter(r => r.season === s), 'gb', 'pf')])),
  byFamilyServed: Object.fromEntries(FKEYS.map(k => [k, gradeRows(recs.filter(r => r.fam === k), 'gv', 'pf')])),
  byFamilyBase: Object.fromEntries(FKEYS.map(k => [k, gradeRows(recs.filter(r => r.fam === k), 'gb', 'pf')])),
  byDirectionServed: Object.fromEntries([['over', 'o'], ['under', 'u']].map(([nm, d]) => { const s = sidesOf(recs, 'pf', 'gv').filter(x => x.d === d); return [nm, GL.map((G, gi) => { const x = s.filter(z => z.g === gi), h = x.reduce((a, z) => a + z.hit, 0); return { grade: G, n: x.length, cov: x.length / s.length, rate: x.length ? h / x.length : null }; })]; })),
  byDirectionBase: Object.fromEntries([['over', 'o'], ['under', 'u']].map(([nm, d]) => { const s = sidesOf(recs, 'pf', 'gb').filter(x => x.d === d); return [nm, GL.map((G, gi) => { const x = s.filter(z => z.g === gi), h = x.reduce((a, z) => a + z.hit, 0); return { grade: G, n: x.length, cov: x.length / s.length, rate: x.length ? h / x.length : null }; })]; })),
};
R.grades.monotone = { servedAll: mono(R.grades.servedDefaultAll), baseAll: mono(R.grades.baseDefaultAll), byFamilyServed: Object.fromEntries(FKEYS.map(k => [k, { ok: mono(R.grades.byFamilyServed[k]), ...monoViol(R.grades.byFamilyServed[k]) }])), byFamilyBase: Object.fromEntries(FKEYS.map(k => [k, { ok: mono(R.grades.byFamilyBase[k]), ...monoViol(R.grades.byFamilyBase[k]) }])) };

// ---------------------------------------------------------------- 3. BLK / 3PM diagnosis (evidence only; no thresholds invented)
const diag = {};
for (const k of ['blocks', 'threes', 'points', 'rebounds']) {
  const rs = recs.filter(r => r.fam === k), s = sidesOf(rs, 'pf', 'gb'), ys = s.map(x => x.hit), ps = s.map(x => x.pct);
  const overRate = mean(rs.map(r => r.hito)), trail = mean(rs.map(r => r.trail));
  const line05 = mean(rs.map(r => r.line === 0.5 ? 1 : 0)), line15 = mean(rs.map(r => r.line === 1.5 ? 1 : 0));
  const cell = (gi) => { const x = s.filter(z => z.g === gi); const th = x.filter(z => z.r['thin' + z.d]); const nt = x.filter(z => !z.r['thin' + z.d]); return { n: x.length, rate: mean(x.map(z => z.hit)), thinShare: x.length ? th.length / x.length : 0, rateThin: th.length ? mean(th.map(z => z.hit)) : null, nThin: th.length, rateNotThin: nt.length ? mean(nt.map(z => z.hit)) : null, nNotThin: nt.length, meanP: mean(x.map(z => z.p)), meanEdgeSig: mean(x.map(z => z.r['es' + z.d])) }; };
  diag[k] = { label: FAMS[k].label, overHitRate: overRate, trailingOverRateAtLine: trail, shareLine05: line05, shareLine15: line15, auc: auc(ps, ys), slope: R.cal.byFamily.A[k] ? R.cal.byFamily.A[k].slope : null, cells: GL.map((_, gi) => cell(gi)),
    thinShareAll: mean(s.map(z => z.r['thin' + z.d])), aucWithinGradeBC: auc(s.filter(z => z.g === 1 || z.g === 2).map(z => z.pct), s.filter(z => z.g === 1 || z.g === 2).map(z => z.hit)) };
}
R.diag = diag;

// ---------------------------------------------------------------- 4. PRIME
const sNew = sidesOf(recs, 'pf', 'gb'), primeS = sNew.filter(z => z.r['prime' + z.d]);
const funnel = (sfx, csK, esK, thK, rdK) => { const sd = []; recs.forEach(r => ['o', 'u'].forEach(d => sd.push({ cs: r[csK + d], es: r[esK + d], th: r[thK + d], rd: r[rdK + d] }))); const N = sd.length, f = (fn) => sd.filter(fn).length / N;
  return { N, conf67: f(z => z.cs >= 0.67), edge11: f(z => z.es >= 11), notThin: f(z => !z.th), notRed: f(z => !z.rd), conf67_edge11: f(z => z.cs >= 0.67 && z.es >= 11), plusNotRed: f(z => z.cs >= 0.67 && z.es >= 11 && !z.rd), prime: f(z => z.cs >= 0.67 && z.es >= 11 && !z.rd && !z.th), blockedByThinOnly: f(z => z.cs >= 0.67 && z.es >= 11 && !z.rd && z.th), edgeRatioGt05: f(z => z.es > 50) }; };
R.prime = { funnelNew: funnel('', 'cs', 'es', 'thin', 'red'), funnelOld: funnel('O', 'csO', 'esO', 'thinO', 'redO'),
  meanFactors: { new: mean(recs.map(r => r.tfo)), old: null },
  overall: { n: primeS.length, cov: primeS.length / sNew.length, rate: mean(primeS.map(z => z.hit)), ci: wilson(primeS.reduce((a, z) => a + z.hit, 0), primeS.length), meanP: mean(primeS.map(z => z.p)) },
  bySeason: Object.fromEntries(SEASONS.map(se => { const a = primeS.filter(z => z.r.season === se), t = sNew.filter(z => z.r.season === se); return [se, { n: a.length, cov: a.length / t.length, rate: mean(a.map(z => z.hit)), meanP: mean(a.map(z => z.p)) }]; })),
  byFamily: Object.fromEntries(FKEYS.map(k => { const a = primeS.filter(z => z.r.fam === k), t = sNew.filter(z => z.r.fam === k); return [k, { n: a.length, cov: a.length / t.length, rate: mean(a.map(z => z.hit)), meanP: mean(a.map(z => z.p)) }]; })),
  byDirection: Object.fromEntries([['over', 'o'], ['under', 'u']].map(([nm, d]) => { const a = primeS.filter(z => z.d === d), t = sNew.filter(z => z.d === d); return [nm, { n: a.length, cov: a.length / t.length, rate: mean(a.map(z => z.hit)), meanP: mean(a.map(z => z.p)) }]; })),
  vsGrades: { primeNotA: (() => { const a = primeS.filter(z => z.g !== 0); return { n: a.length, rate: mean(a.map(z => z.hit)) }; })(), primeAndA: (() => { const a = primeS.filter(z => z.g === 0); return { n: a.length, rate: mean(a.map(z => z.hit)) }; })(), nonPrimeA: (() => { const a = sNew.filter(z => !z.r['prime' + z.d] && z.g === 0); return { n: a.length, rate: mean(a.map(z => z.hit)) }; })(), nonPrimeB: (() => { const a = sNew.filter(z => !z.r['prime' + z.d] && z.g === 1); return { n: a.length, rate: mean(a.map(z => z.hit)) }; })() },
  servedPromotion: (() => { const s = sidesOf(recs, 'pf', 'gv'); const prom = s.filter(z => z.g === 0 && z.r['gb' + z.d] !== 0); return { servedA: s.filter(z => z.g === 0).length / s.length, baseA: sNew.filter(z => z.g === 0).length / sNew.length, promotedFromCD: prom.length / s.length, promotedRate: mean(prom.map(z => z.hit)), promotedN: prom.length }; })(),
  newVsOld: (() => { let both = 0, newOnly = 0, oldOnly = 0, newOnlyBlockedByThinOld = 0, newOnlyOtherOldReason = 0; recs.forEach(r => ['o', 'u'].forEach(d => { const n = r['prime' + d], o2 = r['primeO' + d]; if (n && o2) both++; else if (n) { newOnly++; if (r['thinO' + d]) newOnlyBlockedByThinOld++; else newOnlyOtherOldReason++; } else if (o2) oldOnly++; })); return { both, newOnly, oldOnly, newOnlyBlockedByThinOld, newOnlyOtherOldReason }; })() };
R.prime.meanFactors = { new: mean(recs.map(r => r.tfo)), old: null };
// factor count old vs new (the removed defense/simdef factors change confidence shares)
R.prime.factorCounts = { new: mean(recs.map(r => r.tfo)) };

// ---------------------------------------------------------------- write
fs.mkdirSync(OUT, { recursive: true });
const proposed = { id: W === 'C' ? 'nba-calib-2026.10-wf-v1 (PROPOSED, not installed)' : CALIB_ID, winner: W, note: 'Proposal only. A final deployable curve (if C wins) would be fit on ALL of 2021-2025 and frozen/hashed; walk-forward folds below are its out-of-sample evidence.', foldCurves: R.meta.folds };
if (W === 'C') { const accAll = mDef.emptyBacktestAcc(); recs.forEach(r => ['o', 'u'].forEach(d => mDef.btFileProb(accAll, r['pf' + d], r['pr' + d], r['hit' + d] === 1))); proposed.finalCurveFit2021_2025 = mDef.deriveProbCalib(accAll.probRaw); proposed.sha256 = crypto.createHash('sha256').update(JSON.stringify(proposed.finalCurveFit2021_2025)).digest('hex'); }
R.proposedConfig = proposed;
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(R, null, 1));

const f = (x, d = 3) => (x == null || Number.isNaN(x)) ? '--' : x.toFixed(d), pc = (x, d = 1) => (x == null || Number.isNaN(x)) ? '--' : (100 * x).toFixed(d) + '%';
const ci = (x, d = 5) => `${f(x.est, d)} [${f(x.lo, d)}, ${f(x.hi, d)}]`;
let md = `# NBA vNext — calibration, grade and Prime validation (\`${R.meta.modelVersion}\`)\n\n> **PLAYER-STAT PREDICTION VALIDATION on a SYNTHETIC pseudo-line (trailing over-rate ≈ 0.48). NOT real-line/market validation — edge vs actual markets remains DATA GAP.** Grade/Prime results that depend on the line are provisional.\n\n`;
md += `${samples.length.toLocaleString()} sampled player-games → ${recs.length.toLocaleString()} records (${(recs.length * 2).toLocaleString()} graded sides); calibration evaluated ONLY on unseen seasons ${TEST_SEASONS.join(', ')} (${(testRecs.length * 2).toLocaleString()} sides). Hygiene: ${hygiene.nonNbaTeamRows} pseudo-team + ${hygiene.duplicatedTeamDateRows} duplicated-team-date rows dropped.\n\n`;
md += `## 1. Probability calibration — predeclared candidates (unseen seasons only)\n\n- **A** current default unchanged (id \`${CALIB_ID}\`) · **B** identity/no calibration (value before the Prime family layer) · **C** the app's own monotone-curve recalibration (\`deriveProbCalib\`) fit on strictly earlier seasons.\n- Rule: ${R.cal.winnerRule}.\n\nFolds:\n\n| Test season | trained on | curve (raw% → actual%) |\n|---|---|---|\n`;
for (const s of TEST_SEASONS) md += `| ${s} | ${folds[s].trainedOn.join(', ')} | ${folds[s].curve ? '`' + JSON.stringify(folds[s].curve) + '`' : folds[s].note} |\n`;
md += `\n| Candidate | Brier | LogLoss | slope | intercept | ECE | mean P | actual |\n|---|---|---|---|---|---|---|---|\n`;
for (const c of ['A', 'B', 'C']) { const x = o[c]; md += `| ${c} | ${f(x.brier, 5)} | ${f(x.logLoss, 5)} | ${f(x.slope, 3)} | ${f(x.intercept, 3)} | ${f(x.ece, 4)} | ${pc(x.meanP)} | ${pc(x.rate)} |\n`; }
md += `\nBrier C−A: ${ci(R.cal.diff['C-A'])} · B−A: ${ci(R.cal.diff['B-A'])} (negative = first is better). By test season Brier C−A: ${TEST_SEASONS.map(s => `${s}: ${f(R.cal.diffBySeason[s]['C-A'], 5)}`).join(' · ')}.\n\n**Winner: ${W}.** Does the 1.33 slope materially improve? Default slope ${f(o.A.slope, 2)} → C slope ${f(o.C.slope, 2)}; Brier ${f(o.A.brier, 5)} → ${f(o.C.brier, 5)} (Δ ${f(o.C.brier - o.A.brier, 5)}).\n\nGrade independence: base grades identical across candidates = ${R.cal.gradeIndependence.baseGradeIdenticalAcrossCandidates}; served grades changed by the curve on ${R.cal.gradeIndependence.servedGradeChangedByCurve} of ${R.cal.gradeIndependence.sides} sides.\n\n### By season\n\n| Season | slope A | slope B | slope C | Brier A | Brier C | ECE A | ECE C |\n|---|---|---|---|---|---|---|---|\n`;
for (const s of TEST_SEASONS) { const a = R.cal.bySeason.A[s], b = R.cal.bySeason.B[s], c = R.cal.bySeason.C[s]; md += `| ${s} | ${f(a.slope, 2)} | ${f(b.slope, 2)} | ${f(c.slope, 2)} | ${f(a.brier, 5)} | ${f(c.brier, 5)} | ${f(a.ece, 4)} | ${f(c.ece, 4)} |\n`; }
md += `\n### Over vs Under\n\n| Side | slope A | slope C | Brier A | Brier C | ECE A | ECE C | mean P A | actual |\n|---|---|---|---|---|---|---|---|---|\n`;
for (const nm of ['over', 'under']) { const a = R.cal.byDirection.A[nm], c = R.cal.byDirection.C[nm]; md += `| ${nm} | ${f(a.slope, 2)} | ${f(c.slope, 2)} | ${f(a.brier, 5)} | ${f(c.brier, 5)} | ${f(a.ece, 4)} | ${f(c.ece, 4)} | ${pc(a.meanP)} | ${pc(a.rate)} |\n`; }
md += `\n### By prop family\n\n| Family | slope A | slope C | Brier A | Brier C | ECE A | ECE C |\n|---|---|---|---|---|---|---|\n`;
for (const k of FKEYS) { const a = R.cal.byFamily.A[k], c = R.cal.byFamily.C[k]; md += `| ${FAMS[k].label} | ${f(a.slope, 2)} | ${f(c.slope, 2)} | ${f(a.brier, 5)} | ${f(c.brier, 5)} | ${f(a.ece, 4)} | ${f(c.ece, 4)} |\n`; }
md += `\n### Probability buckets (unseen seasons; mean stated P → actual)\n\n| bucket | n (A) | A: P → actual | n (C) | C: P → actual |\n|---|---|---|---|---|\n`;
o.A.buckets.forEach((b, i) => { const c = o.C.buckets[i]; if (!b.n && !c.n) return; md += `| ${pc(b.lo, 0)}–${pc(b.lo + 0.1, 0)} | ${b.n} | ${pc(b.meanP)} → ${pc(b.rate)} | ${c.n} | ${pc(c.meanP)} → ${pc(c.rate)} |\n`; });
const gt = (rows) => rows.map(g => `${g.grade}: ${pc(g.rate)} [${pc(g.lo)}, ${pc(g.hi)}] · N ${g.n} · cov ${pc(g.cov, 2)} · P̄ ${pc(g.meanP)}`).join('<br>');
md += `\n## 2. Grades — existing thresholds, NOT retuned\n\nTwo scorings of the same sides: **base** = backtest convention (what the in-app backtest and the earlier report used); **served** = as a user sees it live (a real line set ⇒ Prime promotes C/D → A, and the probability-reconciliation rules run; the real-price cap cannot be exercised — DATA GAP).\n\n`;
md += `| Grade | base: hit [95% CI] | base N | base cov | served: hit [95% CI] | served N | served cov |\n|---|---|---|---|---|---|---|\n`;
GL.forEach((G, i) => { const b = R.grades.baseDefaultAll[i], s = R.grades.servedDefaultAll[i]; md += `| ${G} | ${pc(b.rate)} [${pc(b.lo)}, ${pc(b.hi)}] | ${b.n} | ${pc(b.cov, 2)} | ${pc(s.rate)} [${pc(s.lo)}, ${pc(s.hi)}] | ${s.n} | ${pc(s.cov, 2)} |\n`; });
md += `\nAll seasons, default (winner ${W} leaves base grades unchanged). Monotone: base ${R.grades.monotone.baseAll}, served ${R.grades.monotone.servedAll}. Served grades on the unseen seasons with the winning calibration (${W}):\n\n| Grade | hit [95% CI] | N | cov | stated P̄ |\n|---|---|---|---|---|\n`;
R.grades.servedWinnerTest.forEach(g => { md += `| ${g.grade} | ${pc(g.rate)} [${pc(g.lo)}, ${pc(g.hi)}] | ${g.n} | ${pc(g.cov, 2)} | ${pc(g.meanP)} |\n`; });
md += `\n### By season (hit rate (N) — base | served)\n\n| Season | A | B | C | D |\n|---|---|---|---|---|\n`;
for (const s of SEASONS) { const b = R.grades.bySeasonBase[s], v = R.grades.bySeasonServed[s]; md += `| ${s} | ${[0, 1, 2, 3].map(i => `${pc(b[i].rate)} (${b[i].n}) \\| ${pc(v[i].rate)} (${v[i].n})`).join(' | ')} |\n`; }
md += `\n### By prop family (hit rate (N) — base | served) and ordering\n\n| Family | A | B | C | D | base ordering (worst inversion) | served ordering |\n|---|---|---|---|---|---|---|\n`;
for (const k of FKEYS) { const b = R.grades.byFamilyBase[k], v = R.grades.byFamilyServed[k], mb = R.grades.monotone.byFamilyBase[k], ms = R.grades.monotone.byFamilyServed[k]; md += `| ${FAMS[k].label} | ${[0, 1, 2, 3].map(i => `${pc(b[i].rate)} (${b[i].n}) \\| ${pc(v[i].rate)} (${v[i].n})`).join(' | ')} | ${mb.ok ? 'ok' : 'BROKEN ' + mb.pair + ' (+' + pc(mb.worst) + ')'} | ${ms.ok ? 'ok' : 'BROKEN ' + ms.pair + ' (+' + pc(ms.worst) + ')'} |\n`; }
md += `\n### By Over/Under (hit rate (N, cov) — base | served)\n\n| Side | A | B | C | D |\n|---|---|---|---|---|\n`;
for (const nm of ['over', 'under']) { const b = R.grades.byDirectionBase[nm], v = R.grades.byDirectionServed[nm]; md += `| ${nm} | ${[0, 1, 2, 3].map(i => `${pc(b[i].rate)} (${b[i].n}, ${pc(b[i].cov, 1)}) \\| ${pc(v[i].rate)} (${v[i].n}, ${pc(v[i].cov, 1)})`).join(' | ')} |\n`; }
md += `\n## 3. BLK / 3PM diagnosis (evidence)\n\n| Family | over-hit base rate | trailing over-rate at pseudo-line | share line 0.5 | share line 1.5 | AUC (stated P) | AUC within B∪C | slope | thin-capped share of sides |\n|---|---|---|---|---|---|---|---|---|\n`;
for (const k of ['blocks', 'threes', 'points', 'rebounds']) { const d = diag[k]; md += `| ${d.label} | ${pc(d.overHitRate)} | ${pc(d.trailingOverRateAtLine)} | ${pc(d.shareLine05)} | ${pc(d.shareLine15)} | ${f(d.auc, 3)} | ${f(d.aucWithinGradeBC, 3)} | ${f(d.slope, 2)} | ${pc(d.thinShareAll)} |\n`; }
md += `\nGrade cells (base convention): hit rate (N) · thin-capped share · hit when thin vs not thin · mean stated P · mean edge signal %\n\n| Family | Grade | hit (N) | thin share | hit if thin (N) | hit if not thin (N) | P̄ | edge% |\n|---|---|---|---|---|---|---|---|\n`;
for (const k of ['blocks', 'threes', 'points']) diag[k].cells.forEach((c, gi) => { md += `| ${diag[k].label} | ${GL[gi]} | ${pc(c.rate)} (${c.n}) | ${pc(c.thinShare)} | ${pc(c.rateThin)} (${c.nThin}) | ${pc(c.rateNotThin)} (${c.nNotThin}) | ${pc(c.meanP)} | ${f(c.meanEdgeSig, 1)} |\n`; });
const P = R.prime;
md += `\n## 4. Prime\n\nRule (untouched): \`!thinData && !RED && confShare ≥ 0.67 && edgeSignal ≥ 11%\`.\n\n### Why coverage moved (all sides)\n\n| Condition | new (no defense) | old |\n|---|---|---|\n| confShare ≥ 0.67 | ${pc(P.funnelNew.conf67)} | ${pc(P.funnelOld.conf67)} |\n| edge signal ≥ 11% | ${pc(P.funnelNew.edge11)} | ${pc(P.funnelOld.edge11)} |\n| not thin-data (incl. wild-gap cap: |edge|/line > 0.5) | ${pc(P.funnelNew.notThin)} | ${pc(P.funnelOld.notThin)} |\n| not RED matchup | ${pc(P.funnelNew.notRed)} | ${pc(P.funnelOld.notRed)} |\n| conf ≥ .67 AND edge ≥ 11% | ${pc(P.funnelNew.conf67_edge11)} | ${pc(P.funnelOld.conf67_edge11)} |\n| … AND not RED | ${pc(P.funnelNew.plusNotRed)} | ${pc(P.funnelOld.plusNotRed)} |\n| **Prime (… AND not thin)** | **${pc(P.funnelNew.prime, 2)}** | **${pc(P.funnelOld.prime, 2)}** |\n| passes everything EXCEPT is thin-capped | ${pc(P.funnelNew.blockedByThinOnly, 2)} | ${pc(P.funnelOld.blockedByThinOnly, 2)} |\n\nPrime sides new-only vs old: both ${P.newVsOld.both} · new-only ${P.newVsOld.newOnly} (of which the OLD model had them thin-capped: ${P.newVsOld.newOnlyBlockedByThinOld}; other reason: ${P.newVsOld.newOnlyOtherOldReason}) · old-only ${P.newVsOld.oldOnly}.\n\n### Prime validation (new model, synthetic pseudo-line)\n\nOverall: N ${P.overall.n} · coverage ${pc(P.overall.cov, 2)} · hit ${pc(P.overall.rate)} [${pc(P.overall.ci[0])}, ${pc(P.overall.ci[1])}] · stated P̄ ${pc(P.overall.meanP)}.\n\n| Season | N | cov | hit | stated P̄ |\n|---|---|---|---|---|\n`;
for (const s of SEASONS) { const x = P.bySeason[s]; md += `| ${s} | ${x.n} | ${pc(x.cov, 2)} | ${pc(x.rate)} | ${pc(x.meanP)} |\n`; }
md += `\n| Family | N | cov | hit | stated P̄ |\n|---|---|---|---|---|\n`; for (const k of FKEYS) { const x = P.byFamily[k]; md += `| ${FAMS[k].label} | ${x.n} | ${pc(x.cov, 2)} | ${pc(x.rate)} | ${pc(x.meanP)} |\n`; }
md += `\n| Side | N | cov | hit | stated P̄ |\n|---|---|---|---|---|\n`; for (const nm of ['over', 'under']) { const x = P.byDirection[nm]; md += `| ${nm} | ${x.n} | ${pc(x.cov, 2)} | ${pc(x.rate)} | ${pc(x.meanP)} |\n`; }
md += `\nPrime vs grade: Prime∧A ${pc(P.vsGrades.primeAndA.rate)} (${P.vsGrades.primeAndA.n}) · Prime but not A ${pc(P.vsGrades.primeNotA.rate)} (${P.vsGrades.primeNotA.n}) · non-Prime A ${pc(P.vsGrades.nonPrimeA.rate)} (${P.vsGrades.nonPrimeA.n}) · non-Prime B ${pc(P.vsGrades.nonPrimeB.rate)} (${P.vsGrades.nonPrimeB.n}).\n\n**Served-grade promotion:** live, Prime promotes C/D → A. Served A coverage ${pc(P.servedPromotion.servedA, 2)} vs base A ${pc(P.servedPromotion.baseA, 2)}; promoted sides ${pc(P.servedPromotion.promotedFromCD, 2)} of all sides (N ${P.servedPromotion.promotedN}), hit ${pc(P.servedPromotion.promotedRate)}.\n`;
md += `\n## 5. Proposed deterministic configuration (NOT installed)\n\n\`\`\`json\n${JSON.stringify(R.proposedConfig, null, 1)}\n\`\`\`\n`;
fs.writeFileSync(path.join(OUT, 'report.md'), md);
console.log('winner', W, 'wrote', path.join(OUT, 'report.md'));
