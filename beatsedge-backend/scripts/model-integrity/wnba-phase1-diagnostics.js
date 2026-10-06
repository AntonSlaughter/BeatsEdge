// WNBA MODEL INTEGRITY -- PHASE 1 DIAGNOSTIC & VALIDATION.  DIAGNOSTIC ONLY: nothing in the app is changed.
// PLAYER-STAT PREDICTION VALIDATION on a SYNTHETIC pseudo-line (same convention as the NBA work) -- NOT market validation.
//
// Questions: (1) what exactly does the live WNBA model compute, (2) does historical validation execute the same calculations, (3) does the
// active `simdef` (opponent-points-rank similar-defense split) beat an otherwise-identical NO-DEFENSE baseline, (4) zero-history handling,
// (5) grade/Prime/localStorage behavior.
//
// Inputs are built with the LIVE builders (nbaComputeWindows / nbaMinutesTrend / nbaProjMinutes, extracted verbatim) from each player's strictly
// earlier games (previous + current season, regular + postseason -- what wnbaGamelogMulti fetches). The live `oppRank` is the PREVIOUS season's
// final team points-allowed rank (wnbaFetchTeamDef tries WNBA_YR_PREV first) applied to every history row -- reproduced here from box scores
// (as-of: a completed earlier season).
//
//   node scripts/model-integrity/wnba-phase1-diagnostics.js [--boot 300]
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadModel, sliceArrowFn, HTML_PATH } = require('../lib/loadBeatsEdgeModel');
const { buildLiveShapedNbaPlayer } = require('../lib/nbaHistoricalInputs');
const argv = process.argv.slice(2); const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const BOOT = Number(arg('boot', 300)), SEED = 20261006;
const OUT = path.resolve(__dirname, '..', '..', 'tmp/model-integrity/wnba-phase1');
const TEST_SEASONS = [2021, 2022, 2023, 2024, 2025, 2026];
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const html = fs.readFileSync(HTML_PATH, 'utf8');
const m = loadModel({ liveNba: true }); m.__setGradeCutoffs({}); m.__setProbCalib({});     // ONE explicit default config (live WNBA reads browser localStorage -- see localStorage section)
const SERVED = 'validation-synthetic-line', BT = 'backtest';
const FAMS = { points: r => r.points, rebounds: r => r.rebounds, assists: r => r.assists, threes: r => r.threes, steals: r => r.steals, blocks: r => r.blocks, turnovers: r => r.turnovers, pra: r => r.points + r.rebounds + r.assists, pr: r => r.points + r.rebounds, pa: r => r.points + r.assists, ra: r => r.rebounds + r.assists, blocksSteals: r => r.blocks + r.steals };
const FK = Object.keys(FAMS), LAB = { points: 'PTS', rebounds: 'REB', assists: 'AST', threes: '3PM', steals: 'STL', blocks: 'BLK', turnovers: 'TOV', pra: 'PRA', pr: 'PR', pa: 'PA', ra: 'RA', blocksSteals: 'BLK+STL' };
const POS = ['G', 'F', 'C'];
const R = { meta: { generated: new Date().toISOString(), scope: 'DIAGNOSTIC; player-stat validation on a synthetic pseudo-line; not market validation' } };

// ------------------------------------------------------------------ data
const db = new DatabaseSync(path.resolve(__dirname, '..', '..', 'data', 'beatsedge.db'), { readOnly: true });
const inv = db.prepare(`SELECT COUNT(*) n, COUNT(DISTINCT athlete_id) players, COUNT(DISTINCT game_id) games, MIN(game_date) a, MAX(game_date) b, MIN(season) s0, MAX(season) s1 FROM wnba_player_box`).get();
const played = db.prepare(`SELECT played, COUNT(*) n FROM wnba_player_box GROUP BY played`).all();
const bySeason = db.prepare(`SELECT season, SUM(CASE WHEN season_type=2 THEN 1 ELSE 0 END) reg, SUM(CASE WHEN season_type=3 THEN 1 ELSE 0 END) post, COUNT(DISTINCT game_id) games, MIN(game_date) a, MAX(game_date) b FROM wnba_player_box WHERE season>=2018 GROUP BY season ORDER BY season`).all();
const raw = db.prepare(`SELECT game_id, athlete_id, season, season_type, game_date, team_abbreviation AS team, opponent_team_abbreviation AS opponent, home_away, pos_group, minutes, points, rebounds, assists, threes, steals, blocks, turnovers, team_score, opponent_team_score
  FROM wnba_player_box WHERE season_type IN (2,3) AND played = 1 AND minutes > 0 AND season >= 2018 AND pos_group IN ('G','F','C') AND points IS NOT NULL AND rebounds IS NOT NULL AND assists IS NOT NULL
  AND threes IS NOT NULL AND steals IS NOT NULL AND blocks IS NOT NULL AND turnovers IS NOT NULL AND team_abbreviation IS NOT NULL AND opponent_team_abbreviation IS NOT NULL ORDER BY game_date, game_id`).all();
const ts = new Map(); raw.forEach(r => { let s = ts.get(r.team); if (!s) ts.set(r.team, s = new Set()); s.add(r.season); }); const real = new Set([...ts].filter(([, s]) => s.size >= 3).map(([t]) => t));
const tdG = new Map(); raw.forEach(r => { const k = r.team + '|' + r.game_date; let s = tdG.get(k); if (!s) tdG.set(k, s = new Set()); s.add(r.game_id); }); const badTD = new Set([...tdG].filter(([, s]) => s.size > 1).map(([k]) => k));
const rows = raw.filter(r => real.has(r.team) && real.has(r.opponent) && !badTD.has(r.team + '|' + r.game_date) && !badTD.has(r.opponent + '|' + r.game_date));
R.data = { table: inv, playedFlag: played, usableRows2018plus: rows.length, droppedHygiene: raw.length - rows.length, bySeason, testSeasons: TEST_SEASONS, teams: [...real].sort() };
console.log('WNBA data', JSON.stringify(inv), 'usable', rows.length);
// previous-season final team points-allowed rank (regular season): the live oppRank source
const prevRank = new Map();
{ const g = new Map(); rows.filter(r => r.season_type === 2 && r.team_score != null && r.opponent_team_score != null).forEach(r => { const k = r.season + '|' + r.game_id + '|' + r.team; if (!g.has(k)) g.set(k, { season: r.season, team: r.team, allowed: r.opponent_team_score }); });
  const agg = new Map(); g.forEach(v => { const k = v.season + '|' + v.team; const o = agg.get(k) || { season: v.season, team: v.team, s: 0, n: 0 }; o.s += v.allowed; o.n++; agg.set(k, o); });
  const bs = new Map(); agg.forEach(o => { let a = bs.get(o.season); if (!a) bs.set(o.season, a = []); a.push({ team: o.team, v: o.s / o.n }); });
  bs.forEach((arr, season) => { if (arr.length < 10) return; arr.sort((a, b) => a.v - b.v); prevRank.set(season, new Map(arr.map((x, i) => [x.team, i + 1]))); }); }
const td = new Map(); rows.forEach(r => { let s = td.get(r.team); if (!s) td.set(r.team, s = new Set()); s.add(r.game_date); }); const tds = new Map([...td].map(([t, s]) => [t, [...s].sort()]));
const prevTD = (t, d) => { const a = tds.get(t); let lo = 0, hi = a.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < d) lo = mid + 1; else hi = mid; } return lo ? a[lo - 1] : null; };
const byP = new Map(); rows.forEach(r => { let a = byP.get(r.athlete_id); if (!a) byP.set(r.athlete_id, a = []); a.push(r); });
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const pl = hv => { const avg = mean(hv); let line = null, best = 99; for (let c = 0.5; c <= avg * 2.2 + 1; c += 1) { const o = hv.filter(v => v > c).length / hv.length; const g = Math.abs(o - 0.48); if (g < best) { best = g; line = c; } } return line; };
const GR = { A: 0, B: 1, C: 2, D: 3 }, GL = ['A', 'B', 'C', 'D'];
const nbaProjMin = (hm) => m.nbaProjMinutes(hm.map(x => ({ row: { minutes: x } })));

// ------------------------------------------------------------------ run
const recs = []; const dIdx = new Map(); let nd = 0; let nSamples = 0, projMaxDiff = 0;
for (const season of TEST_SEASONS) {
  const ranks = prevRank.get(season - 1) || null, rankObj = ranks ? Object.fromEntries(ranks) : null;
  // PLACEBO control: the same simdef machinery fed a deterministic PERMUTATION of the team ranks (rank values carry no defensive meaning).
  // If the real simdef is no better than the placebo, its gain is not an opponent-defense effect.
  let placeboRanks = null, placeboObj = null;
  if (ranks) { const teams = [...ranks.keys()].sort(), vals = [...ranks.values()].sort((a, b) => a - b), rr = rng(SEED + season); for (let k = vals.length - 1; k > 0; k--) { const j = Math.floor(rr() * (k + 1)); [vals[k], vals[j]] = [vals[j], vals[k]]; } placeboRanks = new Map(teams.map((t, i) => [t, vals[i]])); placeboObj = Object.fromEntries(placeboRanks); }
  for (const [, prow] of byP) {
    const start = prow.findIndex(r => r.season >= season - 1); if (start < 0) continue;
    for (let i = start; i < prow.length; i++) {
      const target = prow[i]; if (target.season !== season || target.season_type !== 2 || i - start < 10) continue;
      const hist = prow.slice(start, i); const m10 = hist.slice(-10); if (mean(m10.map(x => x.minutes)) < 12) continue;
      const lf = {}; for (const k of FK) { const hv = hist.map(FAMS[k]); if (mean(hv) <= 0) continue; const l = pl(hv); if (l > 0) lf[k] = l; }
      if (!Object.keys(lf).length) continue; nSamples++;
      const ptd = prevTD(target.team, target.game_date), oppRk = ranks ? (ranks.get(target.opponent) ?? null) : null;
      const pA = buildLiveShapedNbaPlayer(m, { target, hist, lineFor: lf, prevTeamDate: ptd, oppRankByAbbr: rankObj, oppRank: oppRk }); pA.sport = 'wnba';
      const pC = buildLiveShapedNbaPlayer(m, { target, hist, lineFor: lf, prevTeamDate: ptd }); pC.sport = 'wnba';
      const pP = buildLiveShapedNbaPlayer(m, { target, hist, lineFor: lf, prevTeamDate: ptd, oppRankByAbbr: placeboObj, oppRank: placeboRanks ? (placeboRanks.get(target.opponent) ?? null) : null }); pP.sport = 'wnba';
      if (ranks && oppRk != null) { let inSub = 0, withRank = 0; hist.forEach(x => { const rk = ranks.get(x.opponent); if (rk != null) { withRank++; if (Math.abs(rk - oppRk) <= 6) inSub++; } }); R.subsetShare = R.subsetShare || { s: 0, n: 0, teams: ranks.size }; if (withRank) { R.subsetShare.s += inSub / withRank; R.subsetShare.n++; } }
      let di = dIdx.get(target.game_date); if (di == null) { di = nd++; dIdx.set(target.game_date, di); }
      const ho = hist.map(x => x.opponent), ht = hist.map(x => Date.parse(x.game_date + 'T12:00:00Z')), hh = hist.map(x => x.home_away !== 'away'), hm = hist.map(x => x.minutes);
      const tNow = Date.parse(target.game_date + 'T12:00:00Z'), tRest = ht.length ? Math.round((tNow - ht[ht.length - 1]) / 864e5) : null;
      FK.forEach((k, fi) => { if (!lf[k]) return; const actual = FAMS[k](target), line = lf[k]; if (actual === line) return;
        const hv = hist.map(FAMS[k]); const w = m.btWindowsAsOf(hv, ho, target.opponent, line);   // what the in-app backtest feeds (nbaBacktestSeries)
        const mM = (a) => { const v = a.filter(x => x != null); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length * 10) / 10 : null; };
        w.last5.minAvg = mM(hm.slice(-5)); w.last10.minAvg = mM(hm.slice(-10)); w.last20.minAvg = mM(hm.slice(-20)); w.season.minAvg = mM(hm); w.vsOpp.minAvg = w.season.minAvg; w.recent.minAvg = w.last5.minAvg;
        const glHist = hv.map((v, j) => ({ points: v, line, opponent: ho[j], vsLabel: (hh[j] ? 'vs ' : '@ ') + ho[j], dow: new Date(ht[j]).getDay(), oppRank: null, rest: j > 0 ? Math.round((ht[j] - ht[j - 1]) / 864e5) : null }));
        const fake = (sport) => ({ sport, position: target.pos_group, opponent: target.opponent, statsByKey: { [k]: w }, gameLogByKey: { [k]: glHist }, opponentDefense: null, oppRank: null, gameDow: new Date(tNow).getDay(),
          b2b: tRest != null ? { restDays: tRest, tonight: tRest <= 1 ? 'second' : null, first: null } : null, isHomeTonight: target.home_away !== 'away', minutesTrend: m.nbaMinutesTrend(hm.map(x => ({ row: { minutes: x } }))), projMin: nbaProjMin(hm), opponentContext: null, oppDef: null, situational: null });
        const f3 = fake('wnba'), f4 = fake('nba');
        const rec = { season, di, fam: fi, g: POS.indexOf(target.pos_group), actual, line, sAvg: pA.statsByKey[k].season.avg };
        for (const [d, dir] of [['o', 'over'], ['u', 'under']]) {
          const live = { statKey: k, type: k, line, direction: dir, lineSource: SERVED }, bt = { statKey: k, type: k, line, direction: dir, lineSource: BT };
          const eA = m.calculateEdgeScore(pA, live), eC = m.calculateEdgeScore(pC, live), eAb = m.calculateEdgeScore(pA, bt), e3 = m.calculateEdgeScore(f3, bt), e4 = m.calculateEdgeScore(f4, bt);
          if (eA.insufficientData || eC.insufficientData) { rec.bad = true; break; }
          if (d === 'o') { rec.projA = eA.projection; rec.projC = eC.projection; rec.proj3 = e3.projection; rec.proj4 = e4.projection; projMaxDiff = Math.max(projMaxDiff, Math.abs(eA.projection - eC.projection)); }
          rec['hit' + d] = (dir === 'over' ? actual > line : actual < line) ? 1 : 0;
          rec['gA' + d] = GR[eA.grade]; rec['gC' + d] = GR[eC.grade]; rec['gAb' + d] = GR[eAb.grade]; rec['g3' + d] = GR[e3.grade]; rec['g4' + d] = GR[e4.grade]; rec['raw' + d] = GR[eA.rawGrade || eA.grade];
          { const eP = m.calculateEdgeScore(pP, live); rec['pP' + d] = eP.modelProbPct; rec['simP' + d] = eP.factors.some(x => x.key === 'simdef') ? 1 : 0; }
          rec['pA' + d] = eA.modelProbPct; rec['pC' + d] = eC.modelProbPct; rec['pAb' + d] = eAb.modelProbPct; rec['p3' + d] = e3.modelProbPct; rec['p4' + d] = e4.modelProbPct;
          rec['prA' + d] = eA.prime ? 1 : 0; rec['prC' + d] = eC.prime ? 1 : 0; rec['prAb' + d] = eAb.prime ? 1 : 0; rec['pr3' + d] = e3.prime ? 1 : 0; rec['pr4' + d] = e4.prime ? 1 : 0;
          rec['cA' + d] = eA.confidence; rec['cC' + d] = eC.confidence; rec['tfA' + d] = eA.totalFactors; rec['tfC' + d] = eC.totalFactors; rec['sim' + d] = eA.factors.some(x => x.key === 'simdef') ? 1 : 0; rec['wg' + d] = eA.wildGap ? 1 : 0; rec['gpd' + d] = eA.gradeAdjustmentReason || '';
        }
        if (!rec.bad) recs.push(rec); });
    }
  }
  console.log('season', season, 'samples so far', nSamples, 'records', recs.length);
}
R.run = { samples: nSamples, records: recs.length, sides: recs.length * 2, projectionMaxAbsDiffSimdefVsNone: projMaxDiff, prevSeasonRanksAvailable: [...prevRank.keys()].sort() };

// ------------------------------------------------------------------ stats helpers
const clip = p => Math.min(0.999, Math.max(0.001, p));
function calib(ps, ys) { const p = ps.map(clip), n = p.length; if (!n) return null; const brier = mean(p.map((v, i) => (v - ys[i]) ** 2)); const bk = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 })); p.forEach((v, i) => { const b = bk[Math.min(9, Math.floor(v * 10))]; b.n++; b.p += v; b.y += ys[i]; }); const ece = bk.reduce((s, b) => s + (b.n ? (b.n / n) * Math.abs(b.p / b.n - b.y / b.n) : 0), 0);
  const x = p.map(v => Math.log(v / (1 - v))); let a = 0, b = 1; for (let it = 0; it < 25; it++) { let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0; for (let i = 0; i < n; i++) { const q = 1 / (1 + Math.exp(-(a + b * x[i]))), w = q * (1 - q); g0 += ys[i] - q; g1 += (ys[i] - q) * x[i]; h00 += w; h01 += w * x[i]; h11 += w * x[i] * x[i]; } const det = h00 * h11 - h01 * h01; if (Math.abs(det) < 1e-12) break; a += (h11 * g0 - h01 * g1) / det; b += (-h01 * g0 + h00 * g1) / det; } return { n, brier, ece, slope: b, meanP: mean(p), rate: mean(ys) }; }
function bootDiff(rs, fn) { const by = new Map(); rs.forEach(r => { let o = by.get(r.di); if (!o) by.set(r.di, o = { s: 0, n: 0 }); o.s += fn(r); o.n++; }); const bl = [...by.values()], N = rs.length; if (!N) return { est: NaN, lo: NaN, hi: NaN }; const est = bl.reduce((s, b) => s + b.s, 0) / N, r2 = rng(SEED), ss = []; for (let b = 0; b < BOOT; b++) { let s = 0, n = 0; for (let k = 0; k < bl.length; k++) { const x = bl[Math.floor(r2() * bl.length)]; s += x.s; n += x.n; } ss.push(s / n); } ss.sort((a, c) => a - c); return { est, lo: ss[Math.floor(0.025 * BOOT)], hi: ss[Math.floor(0.975 * BOOT)] }; }
const sides = (rs, pk, gk, prk) => { const o = []; rs.forEach(r => ['o', 'u'].forEach(d => o.push({ r, d, p: r[pk + d] / 100, pct: r[pk + d], g: gk ? r[gk + d] : null, pr: prk ? r[prk + d] : 0, hit: r['hit' + d] }))); return o; };
const gtab = (sd) => GL.map((G, gi) => { const x = sd.filter(z => z.g === gi); return { grade: G, n: x.length, cov: sd.length ? x.length / sd.length : 0, rate: x.length ? mean(x.map(z => z.hit)) : null }; });
const mono = (t, tol = 0.005) => { const r = t.filter(x => x.n >= 200).map(x => x.rate); return r.every((v, i) => i === 0 || v <= r[i - 1] + tol); };
const brSide = (pk) => (r) => ['o', 'u'].reduce((a, d) => a + (clip(r[pk + d] / 100) - r['hit' + d]) ** 2, 0) / 2;
const mae = (rs, k) => mean(rs.map(r => Math.abs(r[k] - r.actual))), rmse = (rs, k) => Math.sqrt(mean(rs.map(r => (r[k] - r.actual) ** 2))), bias = (rs, k) => mean(rs.map(r => r[k] - r.actual));

// ------------------------------------------------------------------ 3. simdef vs no-defense
const simAny = recs.filter(r => r.simo || r.simu);
R.simdef = { firedSides: recs.reduce((a, r) => a + r.simo + r.simu, 0), totalSides: recs.length * 2, fireRate: recs.reduce((a, r) => a + r.simo + r.simu, 0) / (recs.length * 2),
  overall: { A: calib(sides(recs, 'pA').map(x => x.p), sides(recs, 'pA').map(x => x.hit)), C: calib(sides(recs, 'pC').map(x => x.p), sides(recs, 'pC').map(x => x.hit)) },
  brierDiff_A_minus_C: bootDiff(recs, r => brSide('pA')(r) - brSide('pC')(r)),
  brierDiff_firedOnly: bootDiff(simAny, r => brSide('pA')(r) - brSide('pC')(r)),
  projection: { A_equals_C: projMaxDiff === 0, maxAbsDiff: projMaxDiff },
  probShift: (() => { const d = []; recs.forEach(r => ['o', 'u'].forEach(x => { if (r['pA' + x] !== r['pC' + x]) d.push(Math.abs(r['pA' + x] - r['pC' + x])); })); d.sort((a, b) => a - b); return { sidesChanged: d.length, meanAbsPts: mean(d), p95: d[Math.floor(0.95 * (d.length - 1))] || 0, max: d[d.length - 1] || 0 }; })(),
  gradeChanges: (() => { let n = 0, up = 0, down = 0, pr = 0; recs.forEach(r => ['o', 'u'].forEach(x => { if (r['gA' + x] !== r['gC' + x]) { n++; if (r['gA' + x] < r['gC' + x]) up++; else down++; } if (r['prA' + x] !== r['prC' + x]) pr++; })); return { n, up, down, primeChanged: pr }; })(),
  confidenceShift: mean(recs.map(r => ['o', 'u'].reduce((a, x) => a + Math.abs(r['cA' + x] - r['cC' + x]), 0) / 2)),
  grades: { A: gtab(sides(recs, 'pA', 'gA')), C: gtab(sides(recs, 'pC', 'gC')) },
  prime: { A: (() => { const s = sides(recs, 'pA', 'gA', 'prA').filter(z => z.pr); return { n: s.length, cov: s.length / (recs.length * 2), hit: mean(s.map(z => z.hit)) }; })(), C: (() => { const s = sides(recs, 'pC', 'gC', 'prC').filter(z => z.pr); return { n: s.length, cov: s.length / (recs.length * 2), hit: mean(s.map(z => z.hit)) }; })() },
  bySeason: Object.fromEntries(TEST_SEASONS.map(se => { const rs = recs.filter(r => r.season === se); return [se, { n: rs.length * 2, fire: rs.reduce((a, r) => a + r.simo + r.simu, 0) / (rs.length * 2 || 1), brierA: mean(rs.map(brSide('pA'))), brierC: mean(rs.map(brSide('pC'))), diff: bootDiff(rs, r => brSide('pA')(r) - brSide('pC')(r)) }]; })),
  byFamily: Object.fromEntries(FK.map((k, fi) => { const rs = recs.filter(r => r.fam === fi); return [k, { n: rs.length * 2, fire: rs.reduce((a, r) => a + r.simo + r.simu, 0) / (rs.length * 2 || 1), brierA: mean(rs.map(brSide('pA'))), brierC: mean(rs.map(brSide('pC'))), diff: bootDiff(rs, r => brSide('pA')(r) - brSide('pC')(r)), slopeA: calib(sides(rs, 'pA').map(x => x.p), sides(rs, 'pA').map(x => x.hit)).slope, slopeC: calib(sides(rs, 'pC').map(x => x.p), sides(rs, 'pC').map(x => x.hit)).slope }]; })),
  byPosition: Object.fromEntries(POS.map((P, gi) => { const rs = recs.filter(r => r.g === gi); return [P, { n: rs.length * 2, fire: rs.reduce((a, r) => a + r.simo + r.simu, 0) / (rs.length * 2 || 1), brierA: mean(rs.map(brSide('pA'))), brierC: mean(rs.map(brSide('pC'))), diff: bootDiff(rs, r => brSide('pA')(r) - brSide('pC')(r)) }]; })) };
R.placebo = { desc: 'simdef fed a PERMUTATION of the team ranks (meaningless ranks)', subsetShareOfHistoryInSimilarRankWindow: R.subsetShare ? R.subsetShare.s / R.subsetShare.n : null, teamsRanked: R.subsetShare && R.subsetShare.teams,
  fireRate: recs.reduce((a, r) => a + r.simPo + r.simPu, 0) / (recs.length * 2),
  brierPlaceboMinusNone: bootDiff(recs, r => brSide('pP')(r) - brSide('pC')(r)), brierRealMinusPlacebo: bootDiff(recs, r => brSide('pA')(r) - brSide('pP')(r)),
  byFamily: Object.fromEntries(FK.map((k, fi) => { const rs = recs.filter(r => r.fam === fi); return [k, { placeboMinusNone: bootDiff(rs, r => brSide('pP')(r) - brSide('pC')(r)), realMinusPlacebo: bootDiff(rs, r => brSide('pA')(r) - brSide('pP')(r)) }]; })) };
// projection accuracy (identical for A and C), by family / season
R.projection = { byFamily: Object.fromEntries(FK.map((k, fi) => { const rs = recs.filter(r => r.fam === fi); return [k, { n: rs.length, mae: mae(rs, 'projA'), rmse: rmse(rs, 'projA'), bias: bias(rs, 'projA'), maeSeasonAvg: mae(rs, 'sAvg'), diffVsSeasonAvg: bootDiff(rs, r => Math.abs(r.projA - r.actual) - Math.abs(r.sAvg - r.actual)) }]; })),
  bySeason: Object.fromEntries(TEST_SEASONS.map(se => { const rs = recs.filter(r => r.season === se); return [se, { n: rs.length, mae: mae(rs, 'projA'), rmse: rmse(rs, 'projA'), bias: bias(rs, 'projA') }]; })) };

// ------------------------------------------------------------------ 2/5. live vs backtest parity (same games, same lines)
const cmp = (a, b, pa, pb, pra, prb) => { let n = 0, g = 0, pr = 0, dp = 0, dpMax = 0, ug = 0; recs.forEach(r => ['o', 'u'].forEach(x => { n++; if (r[a + x] !== r[b + x]) { g++; } const d = Math.abs(r[pa + x] - r[pb + x]); dp += d; if (d > dpMax) dpMax = d; if (r[pra + x] !== r[prb + x]) pr++; })); return { sides: n, gradeDiffer: g, gradeDifferPct: g / n, primeDiffer: pr, primeDifferPct: pr / n, meanAbsProbPts: dp / n, maxAbsProbPts: dpMax }; };
const projCmp = (a, b) => ({ meanAbs: mean(recs.map(r => Math.abs(r[a] - r[b]))), differPct: recs.filter(r => r[a] !== r[b]).length / recs.length });
R.parity = {
  note: 'LIVE = sport "wnba", live-shaped inputs (gameLogByKey from nbaComputeWindows, oppRank, windows incl. L15/L40), real-line convention. IN-APP BACKTEST = nbaBacktestSeries: fake player with sport "nba", btWindowsAsOf windows, oppRank null, lineSource "backtest".',
  postRulesOnly: { desc: 'live inputs, lineSource live vs backtest (Prime promotion + probability reconciliation)', ...cmp('gA', 'gAb', 'pA', 'pAb', 'prA', 'prAb') },
  inputShapeOnly: { desc: 'backtest-shaped inputs vs live-shaped inputs, both sport wnba, both lineSource backtest', ...cmp('gAb', 'g3', 'pAb', 'p3', 'prAb', 'pr3'), projection: projCmp('projA', 'proj3') },
  sportKeyOnly: { desc: 'same backtest-shaped inputs, sport "nba" (what the in-app WNBA backtest passes) vs "wnba"', ...cmp('g3', 'g4', 'p3', 'p4', 'pr3', 'pr4'), projection: projCmp('proj3', 'proj4') },
  endToEnd: { desc: 'LIVE (served, live inputs, wnba) vs exact in-app WNBA backtest (nba key, backtest inputs)', ...cmp('gA', 'g4', 'pA', 'p4', 'prA', 'pr4'), projection: projCmp('projA', 'proj4'), maeLive: mae(recs, 'projA'), maeBacktest: mae(recs, 'proj4') },
  primeRewrites: (() => { let promoted = 0, recon = 0, total = 0; recs.forEach(r => ['o', 'u'].forEach(x => { total++; const re = r['gpd' + x]; if (/PRIME_PROMOTION/.test(re)) promoted++; if (/PROB_/.test(re)) recon++; })); return { sides: total, primePromotedCtoA: promoted, probabilityReconciled: recon, anyAdjustment: recs.reduce((a, r) => a + (r.gpdo ? 1 : 0) + (r.gpdu ? 1 : 0), 0) }; })() };
const gradeTransitions = GL.map(() => GL.map(() => 0)); recs.forEach(r => ['o', 'u'].forEach(x => { gradeTransitions[r['gAb' + x]][r['gA' + x]]++; })); R.parity.liveVsRawGradeTransitions = gradeTransitions;
// grade/prime overall (live-served) + cap
R.grades = { servedAll: gtab(sides(recs, 'pA', 'gA')), baseAll: gtab(sides(recs, 'pAb', 'gAb')), servedByFamily: Object.fromEntries(FK.map((k, fi) => [k, gtab(sides(recs.filter(r => r.fam === fi), 'pA', 'gA'))])), capShareByFamily: Object.fromEntries(FK.map((k, fi) => { const rs = recs.filter(r => r.fam === fi); return [k, rs.reduce((a, r) => a + r.wgo + r.wgu, 0) / (rs.length * 2 || 1)]; })), calibration: calib(sides(recs, 'pA').map(x => x.p), sides(recs, 'pA').map(x => x.hit)) };
R.grades.monotone = { all: mono(R.grades.servedAll), byFamily: Object.fromEntries(FK.map(k => [k, mono(R.grades.servedByFamily[k])])) };

// ------------------------------------------------------------------ 4. zero-history integrity (zero observed VALUES vs zero OBSERVATIONS)
const zh = {}; const mkRows = (n, f) => Array.from({ length: n }, (_, i) => ({ eventId: 'z' + i, ts: Date.parse('2026-05-10T12:00:00Z') + i * 2 * 864e5, date: 'd', dateShort: 'd', opponent: ['NY', 'LV'][i % 2], vsLabel: 'vs NY', season: 2026, row: f(i) }));
const edgeFor = (glRows, key, line) => { const { statsByKey, gameLogByKey } = m.nbaComputeWindows(glRows, { [key]: line }, 'NY', null, 2026); const p = { id: 'zz' + Math.random(), sport: 'wnba', position: 'G', opponent: 'NY', statsByKey, gameLogByKey, stats: {}, minutesTrend: 0, props: [] };
  const props = [{ statKey: key, type: key, line, direction: 'over', lineSource: 'x', eventId: 'e', commenceTimeMs: Date.now() + 36e5, modelSupported: true, hitRate: 50 }]; m.applyHistoryGate(props, statsByKey); return { e: m.calculateEdgeScore(p, props[0]), prop: props[0], statsByKey }; };
{ const z5 = edgeFor(mkRows(5, () => ({ points: 8, totalRebounds: 3, assists: 1, steals: 0, blocks: 0, turnovers: 1, minutes: 20, [m.NBA_3PM]: 0 })), 'blocks', 0.5);
  zh.fiveGamesAllZeroBlocks = { insufficient: !!z5.e.insufficientData, modelSupported: z5.prop.modelSupported !== false, games: z5.statsByKey.blocks.season.games, avg: z5.statsByKey.blocks.season.avg, projection: z5.e.projection, grade: z5.e.grade, thinData: z5.e.thinData };
  const z0 = edgeFor(mkRows(5, () => ({ points: 8, minutes: 20 })), 'blocks', 0.5);   // the stat was never RECORDED on any row: zero observations
  zh.statNeverRecorded = { insufficient: !!z0.e.insufficientData, modelSupported: z0.prop.modelSupported !== false, games: z0.statsByKey.blocks.season.games, avg: z0.statsByKey.blocks.season.avg };
  const zn = (() => { const { statsByKey } = { statsByKey: {} }; const p = { id: 'zn', sport: 'wnba', position: 'G', opponent: 'NY', statsByKey, stats: {}, gameLogByKey: {}, props: [] }; return m.calculateEdgeScore(p, { statKey: 'blocks', type: 'blocks', line: 0.5, direction: 'over', lineSource: 'x', eventId: 'e', commenceTimeMs: Date.now() + 36e5 }); })();
  zh.noGamesAtAll = { insufficient: !!zn.insufficientData, projection: zn.projection, grade: zn.grade };
  const z1 = edgeFor(mkRows(1, () => ({ points: 8, totalRebounds: 3, assists: 1, steals: 0, blocks: 0, turnovers: 1, minutes: 20, [m.NBA_3PM]: 0 })), 'blocks', 0.5); zh.oneZeroGame = { insufficient: !!z1.e.insufficientData, games: z1.statsByKey.blocks.season.games, thinData: z1.e.thinData, grade: z1.e.grade };
  zh.hasRealModelHistoryUnit = { zeroValuesFiveGames: m.hasRealModelHistory({ season: { games: 5, avg: 0 } }), zeroObservations: m.hasRealModelHistory({ season: { games: 0, avg: 0 } }), nullAvg: m.hasRealModelHistory({ season: { games: 5, avg: null } }) };
  // the live gamelog PARSER: does a non-numeric cell become an OBSERVED zero?
  try { const src = sliceArrowFn(html, 'const nflParseGamelog = (gl) => {'); const parse = new Function(src + '; return nflParseGamelog;')(); const out = parse({ names: ['minutes', 'points', 'blocks'], events: { e1: { gameDate: '2026-06-01T00:00:00Z', opponent: { abbreviation: 'NY' }, atVs: 'vs' } }, seasonTypes: [{ displayName: 'Regular Season', categories: [{ events: [{ eventId: 'e1', stats: ['--', '--', '--'] }] }] }] });
    zh.parserNonNumericCell = { rowsReturned: out.length, row: out[0] && out[0].row, note: 'a non-numeric cell ("--") is stored as 0 = an OBSERVED zero (minutes=0, points=0, blocks=0); nbaMinutesTrend ignores minutes<=0 but every stat window counts it as a real game of 0' }; } catch (e) { zh.parserNonNumericCell = { error: String(e.message) }; }
  // Best Plays / Prime / Smart Parlay reachability for WNBA missing history
  const empty = { id: 'w1', sport: 'wnba', position: 'G', opponent: 'NY', statsByKey: {}, stats: {}, gameLogByKey: {}, props: [{ statKey: 'points', type: 'points', line: 10.5, direction: 'over', lineSource: 'x', eventId: 'e', commenceTimeMs: Date.now() + 36e5, hitRate: 90, plusEV: { eligible: true, modelDifference: 5, marketDifference: 5 } }] };
  const ee = m.calculateEdgeScore(empty, empty.props[0]); zh.missingHistoryReach = { edgeInsufficient: !!ee.insufficientData, grade: ee.grade, prime: ee.prime, topPicks: m.findTopPicks([empty], 5).length, primePicks: m.findPrimePicks([empty]).length, plusEV: m.findPlusEVPicks([empty]).length, smartParlay: m.smartParlayEligibility(ee, empty.props[0]), playerBestGrade: m.playerBestGrade(empty) }; }
R.zeroHistory = zh;

// ------------------------------------------------------------------ 5. localStorage dependence of WNBA official output
{ const seed = { beatsedge_grade_cutoffs_v1: JSON.stringify({ wnba: { A: 0.30, B: 0.20, C: 0.10 } }), beatsedge_prob_calib_v1: JSON.stringify({ wnba: [[22, 5], [50, 90], [78, 99]] }) };
  const bA = loadModel({ liveNba: true, localStorageSeed: seed }), bB = loadModel({ liveNba: true }); let n = 0, gd = 0, pd = 0;
  for (const r of recs.slice(0, 3000)) { /* identical inputs through two 'browsers' */ }
  const sample = []; let cnt = 0; for (const [, prow] of byP) { if (cnt++ > 60) break; const idx = prow.findIndex(r => r.season === 2025 && r.season_type === 2); if (idx < 15) continue; const target = prow[idx + 10] || prow[idx], hist = prow.slice(0, idx + 10); if (hist.length < 12) continue; const lf = { points: 12.5, rebounds: 4.5, assists: 2.5 }; sample.push({ target, hist, lf }); }
  for (const s of sample) { const pa = buildLiveShapedNbaPlayer(bA, { target: s.target, hist: s.hist, lineFor: s.lf, prevTeamDate: null }), pb = buildLiveShapedNbaPlayer(bB, { target: s.target, hist: s.hist, lineFor: s.lf, prevTeamDate: null }); pa.sport = 'wnba'; pb.sport = 'wnba';
    for (const k of Object.keys(s.lf)) for (const d of ['over', 'under']) { const pr = { statKey: k, type: k, line: s.lf[k], direction: d, lineSource: SERVED }; const a = bA.calculateEdgeScore(pa, pr), b = bB.calculateEdgeScore(pb, Object.assign({}, pr)); n++; if (a.grade !== b.grade) gd++; if (a.modelProbPct !== b.modelProbPct) pd++; } }
  R.localStorage = { scorings: n, gradeDiffersBetweenBrowsers: gd, probabilityDiffersBetweenBrowsers: pd, wnbaBacktestPersists: /if \(selectedSport !== 'nba'\) \{ try \{ localStorage\.setItem\('beatsedge_grade_cutoffs_v1'/.test(html), canBacktestIncludesWnba: /const canBacktest = \(selectedSport === 'mlb' \|\| selectedSport === 'nfl' \|\| selectedSport === 'nba' \|\| selectedSport === 'wnba'\)/.test(html) }; }

fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(R, null, 1));
console.log(JSON.stringify({ run: R.run, simdefFire: R.simdef.fireRate, brierDiff: R.simdef.brierDiff_A_minus_C, parity: { post: R.parity.postRulesOnly.gradeDifferPct, shape: R.parity.inputShapeOnly.gradeDifferPct, sport: R.parity.sportKeyOnly.gradeDifferPct, e2e: R.parity.endToEnd.gradeDifferPct }, zeroHistory: R.zeroHistory.fiveGamesAllZeroBlocks, localStorage: R.localStorage }, null, 1));
console.log('wrote', path.join(OUT, 'results.json'));
