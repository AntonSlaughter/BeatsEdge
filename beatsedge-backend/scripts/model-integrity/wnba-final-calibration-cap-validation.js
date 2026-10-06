// WNBA -- FINAL CALIBRATION + WILD-GAP VALIDATION (2026-10-06).  VALIDATION / DECISION ONLY: no formula, config or app file is changed.
// PLAYER-STAT PREDICTION VALIDATION on a SYNTHETIC pseudo-line (trailing over-rate ~0.48), NOT market validation.  REAL-LINE VALIDATION: DATA GAP.
//
// ===================== PREDECLARED BEFORE ANY RESULT WAS SEEN =====================
// Data: wnba_player_box, strict as-of (same builders/filters as scripts/model-integrity/wnba-phase1-diagnostics.js), validation period 2021-2026,
//   regular-season target games, >=10 prior games, mean minutes over the last 10 >= 12, pseudo-line from the player's own prior games only.
// The engine is the REAL shipped one (loaded verbatim). Only two sandbox-only hooks are added by this script's loader transform (never in the app):
//   __WCAP = the WNBA wild-gap rule, __WCAL = the WNBA probability-calibration anchors (the two config values under test).
//
// ---- CALIBRATION candidates (probabilities scored on UNSEEN seasons only: expanding walk-forward, fit 2021-22 -> test 2023, fit 2021-23 -> 2024,
//      fit 2021-24 -> 2025, fit 2021-25 -> 2026) ----
//   A  current WNBA default: WNBA_GRADE_CONFIG.probCalib = null (identity curve).
//   B  "no calibration / control". If A and B are mathematically identical (expected: FAMILY_CALIB has no wnba entry, probCalib null) it is reported
//      as ONE candidate, verified over every side, and not counted as a separate competitor.
//   C  temporal monotone calibration = the app's OWN mechanism deriveProbCalib() (pool-adjacent-violators over raw-probability buckets, with its own
//      thin-sample / already-calibrated gates), derived ONLY from earlier seasons, installed as the WNBA curve, scored on the next unseen season.
//   D  the ONE additional candidate: a 2-parameter logistic (Platt) recalibration  p' = sigmoid(a + b*logit(p_raw)), fit by maximum likelihood on the
//      earlier seasons only, rendered as 15 piecewise-linear anchors (raw 22..78 step 4) so it would deploy through the same applyProbCalib.
//      Strong a-priori reason: if the only defect is a mis-scaled confidence (slope != 1), the minimal-variance fix is TWO parameters, not a free-form
//      bucket curve whose 7 noisy anchors can chase per-bucket noise; it is the standard parametric reference to the non-parametric C.
//   WINNER RULE (X in {C, D} beats A iff ALL hold on the pooled unseen seasons; otherwise A stays -- parsimony):
//     (c1) Brier(X) - Brier(A) <= -0.0005 AND the 95% date-block-bootstrap CI of the difference excludes 0 (material, not noise-level);
//     (c2) Brier better in >= 3 of the 4 test seasons and no season worse by more than 0.0005;
//     (c3) |slope(X) - 1| < |slope(A) - 1| and ECE(X) <= ECE(A) + 0.002;
//     (c4) no prop family with >= 2,000 sides is worse than A by more than 0.0010 Brier ("no material family degradation").
//     If both C and D qualify: lower pooled Brier wins; if their difference CI contains 0, D (fewer parameters) wins.
//     A curve that deriveProbCalib() returns null for (its own "already calibrated" gate) is the identity for that fold.
//
// ---- WILD-GAP CAP candidates (0.50 threshold NOT tuned; no family-specific values; predictive spread = the engine's own projStdDev) ----
//   A  current:        |edge| / line > 0.50                       (WNBA_GRADE_CONFIG.wildGapRule 'relative')
//   B  no cap:         CONTROL ONLY, ineligible to win (a safety cap is not removed because removal yields more A grades)
//   C  floored (NBA-style): |edge| / max(line, predictiveSpreadSD) > 0.50   (invalid/missing SD -> engine falls back to rule A: fail-closed)
//   D  the ONE additional scale-aware candidate: |edge| > 1.0 x predictiveSpreadSD  (the 'sigma' rule: the gap in the stat's own predictive-SD units --
//      the same unit the probability layer's z-score uses; independent of the line level, so it cannot over-penalise low lines by construction).
//   ELIGIBILITY (A, C, D; the final pipeline is the one a user would see = resolveFinalGrade with the live rules, which WNBA always runs):
//     (e1) every one of the 12 families has NO SIGNIFICANT grade inversion (an inversion = lower grade out-hits the higher grade by > 0.5 pt AND
//          one-sided z > 1.64; cells n >= 200). Strict point-estimate monotonicity is ALSO reported.  [significance-aware on purpose: WNBA cells are
//          smaller than NBA's; recorded before results];
//     (e2) no degradation outside the low-line stats: pooled A-grade and B-grade hit rates over PTS, REB, AST, PRA, PR, PA, RA within 1.0 pt of
//          candidate A's, and overall Prime hit within 1.0 pt;
//     (e3) season stability: overall grades have no significant inversion in each of the 6 seasons, and BLK B >= C (within 0.5 pt) in at least 2/3 of
//          the seasons where both cells have n >= 100;
//     (e4) [C and D only] the predictive spread must be defensible as a scale measure: Spearman(SD, |residual|) > 0 in >= 10 of 12 families AND
//          mean SD / RMSE within [0.5, 2.0] in >= 9 of 12 families. Floor-dominated families (>= 50% of observations exactly on the engine's 1.0
//          floor) are FLAGGED (the SD there is a constant, so max(line, SD) is max(line, 1.0): a floor, not a per-player scale) but are not
//          disqualifying by themselves.
//   WINNER: among eligible candidates the smallest sum over families of the worst adjacent (point-estimate) inversion; tie -> fewer changed sides
//     versus A. If none is eligible, the CURRENT rule (A) stays and the failure is reported.  B is reported as evidence, never eligible.
// GRADE / PRIME: thresholds, confidence and the Prime rule (!thin && !RED && confShare>=.67 && edgeSignal>=11%) are UNCHANGED; reported, not tuned.
//
//   node scripts/model-integrity/wnba-final-calibration-cap-validation.js [--boot 500] [--max-samples N]
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadModel } = require('../lib/loadBeatsEdgeModel');
const { buildLiveShapedNbaPlayer } = require('../lib/nbaHistoricalInputs');
const argv = process.argv.slice(2); const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const BOOT = Number(arg('boot', 500)), MAXS = Number(arg('max-samples', 0)), SEED = 20261006;
const OUT = path.resolve(__dirname, '..', '..', 'tmp/model-integrity/wnba-final');
const SEASONS = [2021, 2022, 2023, 2024, 2025, 2026], TEST = [2023, 2024, 2025, 2026];
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(SEED);

// ---------------------------------------------------------------- models (real engine; two sandbox-only hooks for the values under test)
const CAPSRC = "sport === 'wnba' ? WNBA_GRADE_CONFIG.wildGapRule : 'relative'", CALSRC = "sport === 'wnba' ? WNBA_GRADE_CONFIG.probCalib : (PROB_CALIB && PROB_CALIB[sport])";
const hook = (src) => { for (const [from, to] of [[CAPSRC, "sport === 'wnba' ? __WCAP.v : 'relative'"], [CALSRC, "sport === 'wnba' ? __WCAL.v : (PROB_CALIB && PROB_CALIB[sport])"]]) { if (src.split(from).length !== 2) throw new Error('hook anchor not found exactly once: ' + from); src = src.replace(from, to); } return src; };
const mk = (rule) => { const m = loadModel({ liveNba: true, sandboxExtras: { __WCAP: { v: rule }, __WCAL: { v: null } }, transform: hook }); m.__setGradeCutoffs({}); m.__setProbCalib({}); return m; };
const CAPS = [{ id: 'A', rule: 'relative', label: 'current |edge|/line>.5' }, { id: 'B', rule: 'none', label: 'no cap (control)' }, { id: 'C', rule: 'floored', label: '|edge|/max(line,SD)>.5' }, { id: 'D', rule: 'sigma', label: '|edge|>1.0*SD' }];
const M = CAPS.map(c => mk(c.rule));
const COMP = mk('relative');                        // offline composition (applyProbCalib + resolveFinalGrade) -- the real functions
const VER = { C: mk('floored'), D: mk('floored') }; // direct-engine verification of calibrated composition
const SERVED = 'validation-synthetic-line';
const FAMS = { points: r => r.points, rebounds: r => r.rebounds, assists: r => r.assists, threes: r => r.threes, steals: r => r.steals, blocks: r => r.blocks, turnovers: r => r.turnovers, pra: r => r.points + r.rebounds + r.assists, pr: r => r.points + r.rebounds, pa: r => r.points + r.assists, ra: r => r.rebounds + r.assists, blocksSteals: r => r.blocks + r.steals };
const FK = Object.keys(FAMS), LAB = { points: 'PTS', rebounds: 'REB', assists: 'AST', threes: '3PM', steals: 'STL', blocks: 'BLK', turnovers: 'TOV', pra: 'PRA', pr: 'PR', pa: 'PA', ra: 'RA', blocksSteals: 'BLK+STL' };
const HIGH = ['points', 'rebounds', 'assists', 'pra', 'pr', 'pa', 'ra'].map(k => FK.indexOf(k)), LOW4 = ['blocks', 'steals', 'threes', 'turnovers'].map(k => FK.indexOf(k));
const GR = { A: 0, B: 1, C: 2, D: 3 }, GL = ['A', 'B', 'C', 'D'];

// ---------------------------------------------------------------- data (identical filters to Phase 1)
const db = new DatabaseSync(path.resolve(__dirname, '..', '..', 'data', 'beatsedge.db'), { readOnly: true });
const inv = db.prepare(`SELECT COUNT(*) n, COUNT(DISTINCT athlete_id) players, COUNT(DISTINCT game_id) games, MIN(game_date) a, MAX(game_date) b FROM wnba_player_box`).get();
const raw = db.prepare(`SELECT game_id, athlete_id, season, season_type, game_date, team_abbreviation AS team, opponent_team_abbreviation AS opponent, home_away, pos_group, minutes, points, rebounds, assists, threes, steals, blocks, turnovers, team_score, opponent_team_score
  FROM wnba_player_box WHERE season_type IN (2,3) AND played = 1 AND minutes > 0 AND season >= 2018 AND pos_group IN ('G','F','C') AND points IS NOT NULL AND rebounds IS NOT NULL AND assists IS NOT NULL
  AND threes IS NOT NULL AND steals IS NOT NULL AND blocks IS NOT NULL AND turnovers IS NOT NULL AND team_abbreviation IS NOT NULL AND opponent_team_abbreviation IS NOT NULL ORDER BY game_date, game_id`).all();
const ts = new Map(); raw.forEach(r => { let s = ts.get(r.team); if (!s) ts.set(r.team, s = new Set()); s.add(r.season); }); const real = new Set([...ts].filter(([, s]) => s.size >= 3).map(([t]) => t));
const tdG = new Map(); raw.forEach(r => { const k = r.team + '|' + r.game_date; let s = tdG.get(k); if (!s) tdG.set(k, s = new Set()); s.add(r.game_id); }); const badTD = new Set([...tdG].filter(([, s]) => s.size > 1).map(([k]) => k));
const rows = raw.filter(r => real.has(r.team) && real.has(r.opponent) && !badTD.has(r.team + '|' + r.game_date) && !badTD.has(r.opponent + '|' + r.game_date));
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
console.log('WNBA table', JSON.stringify(inv), 'usable rows (2018+, hygiene-filtered)', rows.length, 'dropped', raw.length - rows.length);

// ---------------------------------------------------------------- run: flat typed arrays (record = player-game x family; 2 sides each)
const CAP_R = 270000, NC = CAPS.length;
const rSeason = new Int8Array(CAP_R), rFam = new Int8Array(CAP_R), rDi = new Int32Array(CAP_R), rProj = new Float32Array(CAP_R), rActual = new Float32Array(CAP_R), rLine = new Float32Array(CAP_R), rSd = new Float32Array(CAP_R), rEdgeAbs = new Float32Array(CAP_R), rPos = new Int8Array(CAP_R);
const sHit = new Int8Array(CAP_R * 2), sPAdj = new Float64Array(CAP_R * 2), sMP = new Float64Array(CAP_R * 2), sConf = new Int16Array(CAP_R * 2);
const sRaw = [], sFin = [], sWg = [], sThin = [], sPrime = [];
for (let c = 0; c < NC; c++) { sRaw.push(new Int8Array(CAP_R * 2)); sFin.push(new Int8Array(CAP_R * 2)); sWg.push(new Int8Array(CAP_R * 2)); sThin.push(new Int8Array(CAP_R * 2)); sPrime.push(new Int8Array(CAP_R * 2)); }
let nRec = 0, nSamples = 0, maxProjDiff = 0, maxProbDiff = 0; const perSeasonSamples = {};
const dIdx = new Map(); let nd = 0;
const clip = p => Math.min(0.999, Math.max(0.001, p));
const RAWCLAMP = p => Math.max(0.22, Math.min(0.78, p));
// ---- calibration fitting (earlier seasons only)
function fitCurves(upToSeason) {
  const acc = COMP.emptyBacktestAcc(); const xs = [], ys = [];
  for (let r = 0; r < nRec; r++) { if (rSeason[r] + 2021 >= upToSeason) continue; for (let d = 0; d < 2; d++) { const i = 2 * r + d, rawP = RAWCLAMP(sPAdj[i]); COMP.btFileProb(acc, Math.round(sMP[i] * 100), Math.round(rawP * 100), sHit[i] === 1); xs.push(Math.log(clip(rawP) / (1 - clip(rawP)))); ys.push(sHit[i]); } }
  const C = COMP.deriveProbCalib(acc.probRaw);
  let a = 0, b = 1; const n = xs.length; for (let it = 0; it < 30; it++) { let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0; for (let i = 0; i < n; i++) { const q = 1 / (1 + Math.exp(-(a + b * xs[i]))), w = q * (1 - q); g0 += ys[i] - q; g1 += (ys[i] - q) * xs[i]; h00 += w; h01 += w * xs[i]; h11 += w * xs[i] * xs[i]; } const det = h00 * h11 - h01 * h01; if (Math.abs(det) < 1e-12) break; const da = (h11 * g0 - h01 * g1) / det, db2 = (-h01 * g0 + h00 * g1) / det; a += da; b += db2; if (Math.abs(da) + Math.abs(db2) < 1e-9) break; }
  let D = null; if (b > 0) { D = []; for (let x = 22; x <= 78; x += 4) { const y = 100 / (1 + Math.exp(-(a + b * Math.log(x / 100 / (1 - x / 100))))); D.push([x, Math.round(Math.max(1, Math.min(99, y)) * 10) / 10]); } }
  return { C, D, platt: { a, b, n }, bucketsUsed: Object.fromEntries(Object.entries(acc.probRaw).map(([k, v]) => [k, { n: v.n, hit: v.hit / (v.n || 1), meanRaw: v.sumPct / (v.n || 1) }])) };
}
const folds = {}; const ver = [];     // direct-engine verification tuples
const t0 = Date.now();
for (const season of SEASONS) {
  const ranks = prevRank.get(season - 1) || null, rankObj = ranks ? Object.fromEntries(ranks) : null;
  if (TEST.includes(season)) { folds[season] = fitCurves(season); VER.C.__sandbox.__WCAL.v = folds[season].C; VER.D.__sandbox.__WCAL.v = folds[season].D; VER.C.bumpEdgeCache(); VER.D.bumpEdgeCache(); console.log('fold', season, 'C=', JSON.stringify(folds[season].C), 'D=', JSON.stringify(folds[season].D), 'platt', JSON.stringify(folds[season].platt)); }
  const elig = [];
  for (const [, prow] of byP) { const start = prow.findIndex(r => r.season >= season - 1); if (start < 0) continue;
    for (let i = start; i < prow.length; i++) { const t = prow[i]; if (t.season !== season || t.season_type !== 2 || i - start < 10) continue; elig.push({ prow, start, i }); } }   // minutes filter (mean of last 10 >= 12) applied below, as in Phase 1
  let take = elig; if (MAXS) { for (let k = elig.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [elig[k], elig[j]] = [elig[j], elig[k]]; } take = elig.slice(0, MAXS); }
  let sampled = 0;
  for (const { prow, start, i } of take) {
    const target = prow[i], hist = prow.slice(start, i); if (mean(hist.slice(-10).map(x => x.minutes)) < 12) continue;
    const lf = {}; for (const k of FK) { const hv = hist.map(FAMS[k]); if (mean(hv) <= 0) continue; const l = pl(hv); if (l > 0) lf[k] = l; }
    if (!Object.keys(lf).length) continue; sampled++; nSamples++;
    const ptd = prevTD(target.team, target.game_date), oppRk = ranks ? (ranks.get(target.opponent) ?? null) : null;
    const player = buildLiveShapedNbaPlayer(M[0], { target, hist, lineFor: lf, prevTeamDate: ptd, oppRankByAbbr: rankObj, oppRank: oppRk }); player.sport = 'wnba';
    let di = dIdx.get(target.game_date); if (di == null) { di = nd++; dIdx.set(target.game_date, di); }
    FK.forEach((k, fi) => { if (!lf[k]) return; const actual = FAMS[k](target), line = lf[k]; if (actual === line) return;
      const E = [[], []]; let bad = false;
      for (let d = 0; d < 2 && !bad; d++) { const dir = d === 0 ? 'over' : 'under'; for (let c = 0; c < NC; c++) { const e = M[c].calculateEdgeScore(player, { statKey: k, type: k, line, direction: dir, lineSource: SERVED }); if (e.insufficientData) { bad = true; break; } E[d][c] = e; } }
      if (bad) return;
      const r = nRec++; rSeason[r] = season - 2021; rFam[r] = fi; rDi[r] = di; rActual[r] = actual; rLine[r] = line; rPos[r] = 'GFC'.indexOf(target.pos_group);
      const e0 = E[0][0]; rProj[r] = e0.projection; rSd[r] = e0.predictiveSpreadSD; rEdgeAbs[r] = Math.abs(e0.edge);
      for (let d = 0; d < 2; d++) { const s = 2 * r + d; sHit[s] = (d === 0 ? actual > line : actual < line) ? 1 : 0; const ee = E[d][0]; sPAdj[s] = ee.preFloorRaw; sMP[s] = ee.modelProb; sConf[s] = ee.confidence;
        for (let c = 0; c < NC; c++) { const e = E[d][c]; sRaw[c][s] = GR[e.rawGrade]; sFin[c][s] = GR[e.finalGrade]; sWg[c][s] = e.wildGap ? 1 : 0; sThin[c][s] = e.thinData ? 1 : 0; sPrime[c][s] = e.prime ? 1 : 0;
          maxProjDiff = Math.max(maxProjDiff, Math.abs(e.projection - ee.projection)); maxProbDiff = Math.max(maxProbDiff, Math.abs(e.modelProb - ee.modelProb)); }
        if (TEST.includes(season) && rand() < 0.01) for (const cal of ['C', 'D']) { const e = VER[cal].calculateEdgeScore(player, { statKey: k, type: k, line, direction: d === 0 ? 'over' : 'under', lineSource: SERVED }); ver.push({ s, season, cal, fin: GR[e.finalGrade], mp: e.modelProb, raw: GR[e.rawGrade], prime: e.prime ? 1 : 0 }); } } });
  }
  perSeasonSamples[season] = sampled; console.log(`season ${season}: samples ${sampled}, records so far ${nRec} (${Math.round((Date.now() - t0) / 1000)}s)`);
}
const N = nRec, NS = N * 2;
const DATASET = { table: inv, hygiene: { rawRows2018plus: raw.length, kept: rows.length, dropped: raw.length - rows.length }, seasons: SEASONS, testSeasons: TEST, playerGames: nSamples, perSeasonPlayerGames: perSeasonSamples, records: N, sides: NS,
  bySeasonRecords: Object.fromEntries(SEASONS.map(s => [s, countWhere(r => rSeason[r] + 2021 === s)])), byFamilyRecords: Object.fromEntries(FK.map((k, fi) => [LAB[k], countWhere(r => rFam[r] === fi)])), engineChecks: { maxProjectionDiffAcrossCaps: maxProjDiff, maxProbabilityDiffAcrossCaps: maxProbDiff } };
function countWhere(f) { let n = 0; for (let r = 0; r < N; r++) if (f(r)) n++; return n; }
console.log('records', N, 'sides', NS, 'maxProjDiffAcrossCaps', maxProjDiff, 'maxProbDiffAcrossCaps', maxProbDiff);

// ---------------------------------------------------------------- stats helpers
const wilson = (h, n) => { if (!n) return [NaN, NaN]; const z = 1.96, p = h / n, d = 1 + z * z / n, c = p + z * z / (2 * n), a = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - a) / d, (c + a) / d]; };
function calibM(ps, ys) { const n = ps.length; if (!n) return null; let br = 0, ll = 0, sp = 0, sy = 0; const bk = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 })); const x = new Float64Array(n);
  for (let i = 0; i < n; i++) { const p = clip(ps[i]); br += (p - ys[i]) ** 2; ll += -(ys[i] ? Math.log(p) : Math.log(1 - p)); sp += p; sy += ys[i]; const b = bk[Math.min(9, Math.floor(p * 10))]; b.n++; b.p += p; b.y += ys[i]; x[i] = Math.log(p / (1 - p)); }
  const ece = bk.reduce((s, b) => s + (b.n ? (b.n / n) * Math.abs(b.p / b.n - b.y / b.n) : 0), 0); let a = 0, b = 1;
  for (let it = 0; it < 25; it++) { let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0; for (let i = 0; i < n; i++) { const q = 1 / (1 + Math.exp(-(a + b * x[i]))), w = q * (1 - q); g0 += ys[i] - q; g1 += (ys[i] - q) * x[i]; h00 += w; h01 += w * x[i]; h11 += w * x[i] * x[i]; } const det = h00 * h11 - h01 * h01; if (Math.abs(det) < 1e-12) break; a += (h11 * g0 - h01 * g1) / det; b += (-h01 * g0 + h00 * g1) / det; }
  return { n, brier: br / n, logLoss: ll / n, ece, slope: b, intercept: a, meanP: sp / n, rate: sy / n, buckets: bk.map((q, i) => ({ lo: i / 10, n: q.n, meanP: q.n ? q.p / q.n : null, rate: q.n ? q.y / q.n : null })) }; }
function bootDiff(recIdx, diffFn) { const by = new Map(); for (const r of recIdx) { let o = by.get(rDi[r]); if (!o) by.set(rDi[r], o = { s: 0, n: 0 }); o.s += diffFn(r); o.n++; } const bl = [...by.values()], n = recIdx.length; if (!n) return { est: NaN, lo: NaN, hi: NaN }; const est = bl.reduce((s, b) => s + b.s, 0) / n, r2 = rng(SEED ^ 0x9e3779b1), ss = [];
  for (let b = 0; b < BOOT; b++) { let s = 0, nn = 0; for (let k = 0; k < bl.length; k++) { const x = bl[Math.floor(r2() * bl.length)]; s += x.s; nn += x.n; } ss.push(s / nn); } ss.sort((a, c) => a - c); return { est, lo: ss[Math.floor(0.025 * BOOT)], hi: ss[Math.floor(0.975 * BOOT)] }; }
const recSel = (pred) => { const o = []; for (let r = 0; r < N; r++) if (pred(r)) o.push(r); return o; };
const sideSel = (recs, dirs) => { const o = []; for (const r of recs) for (const d of (dirs || [0, 1])) o.push(2 * r + d); return o; };

// ---------------------------------------------------------------- 0. engine/definition checks used to collapse or verify candidates
const idOnly = (() => { let maxD = 0; for (let s = 0; s < NS; s++) { const d = Math.abs(sMP[s] - Math.max(0.03, Math.min(0.97, RAWCLAMP(sPAdj[s])))); if (d > maxD) maxD = d; } return maxD; })();
const familyAdjActive = (() => { let n = 0; for (let s = 0; s < NS; s++) if (Math.abs(sMP[s] - RAWCLAMP(sPAdj[s])) > 1e-9) n++; return n; })();
// offline composition: calibrated probability & final grade, exactly via the real applyProbCalib / resolveFinalGrade
const CAL = { C: new Float64Array(NS).fill(NaN), D: new Float64Array(NS).fill(NaN) };
for (const se of TEST) for (const cal of ['C', 'D']) { COMP.__sandbox.__WCAL.v = folds[se][cal]; COMP.bumpEdgeCache(); for (let r = 0; r < N; r++) { if (rSeason[r] + 2021 !== se) continue; for (let d = 0; d < 2; d++) { const s = 2 * r + d; CAL[cal][s] = Math.max(0.03, Math.min(0.97, COMP.applyProbCalib(RAWCLAMP(sPAdj[s]), 'wnba'))); } } }
const FINCAL = {}; // [cal][cap] -> Int8Array final grade under that calibration
function finalUnder(cal, c) { const key = cal + c; if (FINCAL[key]) return FINCAL[key]; const out = new Int8Array(NS).fill(-1);
  for (let s = 0; s < NS; s++) { const p = cal === 'ID' ? Math.max(0.03, Math.min(0.97, RAWCLAMP(sPAdj[s]))) : CAL[cal][s]; if (Number.isNaN(p)) continue; out[s] = GR[COMP.resolveFinalGrade({ rawGrade: GL[sRaw[c][s]], prime: !!sPrime[c][s], modelProbSport: p, impliedProb: 0.5, hasRealPrice: false, liveRules: true }).finalGrade]; }
  FINCAL[key] = out; return out; }
const probOf = (cal) => cal === 'ID' ? (s) => Math.max(0.03, Math.min(0.97, RAWCLAMP(sPAdj[s]))) : (s) => CAL[cal][s];
const compIdentityMismatch = (() => { let bad = 0; for (let c = 0; c < NC; c++) { const f = finalUnder('ID', c); for (let s = 0; s < NS; s++) if (f[s] !== sFin[c][s]) bad++; } return bad; })();
const verBad = (() => { let bad = 0, n = 0; for (const v of ver) { n++; const f = finalUnder(v.cal, 2); if (f[v.s] !== v.fin || Math.abs(CAL[v.cal][v.s] - Math.max(0.03, Math.min(0.97, v.mp))) > 1e-9) bad++; } return { n, bad }; })();
DATASET.engineChecks.identityGradeCompositionMismatchSides = compIdentityMismatch; DATASET.engineChecks.calibratedCompositionVsDirectEngine = verBad; DATASET.engineChecks.A_equals_B = { maxAbsProbabilityDiff: idOnly, sidesWithNonIdentityAdjustment: familyAdjActive };
console.log('A==B max diff', idOnly, 'family-adjusted sides', familyAdjActive, '| composition(identity) mismatches', compIdentityMismatch, '| calibrated composition vs direct engine', JSON.stringify(verBad));

// ---------------------------------------------------------------- 1. CALIBRATION
const testRecs = recSel(r => TEST.includes(rSeason[r] + 2021)), R = { DATASET, calibration: {}, spread: {}, cap: {}, meta: { generated: new Date().toISOString(), boot: BOOT, seed: SEED } };
const pSel = (sidx, f) => { const p = new Float64Array(sidx.length), y = new Int8Array(sidx.length); sidx.forEach((s, i) => { p[i] = f(s); y[i] = sHit[s]; }); return [p, y]; };
const CANDP = { A: probOf('ID'), C: probOf('C'), D: probOf('D') };
const cm = (name, sidx) => { const [p, y] = pSel(sidx, CANDP[name]); return calibM(p, y); };
const brRec = (name) => (r) => ((CANDP[name](2 * r) - sHit[2 * r]) ** 2 + (CANDP[name](2 * r + 1) - sHit[2 * r + 1]) ** 2) / 2;
const calR = { folds: Object.fromEntries(TEST.map(se => [se, { trainedOn: SEASONS.filter(x => x < se), C: folds[se].C, D: folds[se].D, platt: folds[se].platt, rawBuckets: folds[se].bucketsUsed }])), overall: {}, bySeason: {}, byDirection: {}, byFamily: {}, diff: {}, diffBySeason: {}, diffByFamily: {} };
const testSides = sideSel(testRecs);
for (const nm of ['A', 'C', 'D']) { calR.overall[nm] = cm(nm, testSides); calR.bySeason[nm] = Object.fromEntries(TEST.map(se => [se, cm(nm, sideSel(testRecs.filter(r => rSeason[r] + 2021 === se)))])); calR.byDirection[nm] = { over: cm(nm, sideSel(testRecs, [0])), under: cm(nm, sideSel(testRecs, [1])) }; calR.byFamily[nm] = Object.fromEntries(FK.map((k, fi) => [LAB[k], cm(nm, sideSel(testRecs.filter(r => rFam[r] === fi)))])); }
for (const nm of ['C', 'D']) { const f = (r) => brRec(nm)(r) - brRec('A')(r); calR.diff[nm] = bootDiff(testRecs, f); calR.diffBySeason[nm] = Object.fromEntries(TEST.map(se => [se, mean(testRecs.filter(r => rSeason[r] + 2021 === se).map(f))])); calR.diffByFamily[nm] = Object.fromEntries(FK.map((k, fi) => [LAB[k], { n: testRecs.filter(r => rFam[r] === fi).length * 2, est: mean(testRecs.filter(r => rFam[r] === fi).map(f)) }])); }
calR.diff['D-C'] = bootDiff(testRecs, (r) => brRec('D')(r) - brRec('C')(r));
calR.identicalToA = { C: testSides.every(s => Math.abs(CANDP.C(s) - CANDP.A(s)) < 1e-12), D: testSides.every(s => Math.abs(CANDP.D(s) - CANDP.A(s)) < 1e-12), foldsWhereCIsNull: TEST.filter(se => !folds[se].C) };
const calRule = {}; for (const nm of ['C', 'D']) { const A = calR.overall.A, X = calR.overall[nm]; const sd = calR.diffBySeason[nm];
  const c1 = calR.diff[nm].est <= -0.0005 && calR.diff[nm].hi < 0, c2 = TEST.filter(se => sd[se] < 0).length >= 3 && TEST.every(se => sd[se] <= 0.0005), c3 = Math.abs(X.slope - 1) < Math.abs(A.slope - 1) && X.ece <= A.ece + 0.002, c4 = FK.every((k) => { const d = calR.diffByFamily[nm][LAB[k]]; return d.n < 2000 || d.est <= 0.0010; });
  calRule[nm] = { c1_materialBrierAndCI: c1, c2_seasons: c2, c3_slopeECE: c3, c4_noFamilyDegradation: c4, qualifies: c1 && c2 && c3 && c4 && !calR.identicalToA[nm] }; }
let calWinner = 'A'; { const q = ['C', 'D'].filter(n => calRule[n].qualifies); if (q.length === 1) calWinner = q[0]; else if (q.length === 2) { const dc = calR.diff['D-C']; calWinner = (dc.lo < 0 && dc.hi > 0) ? 'D' : (dc.est < 0 ? 'D' : 'C'); } }
calR.rule = calRule; calR.winner = calWinner; R.calibration = calR;
console.log('calibration: pooled Brier A/C/D', ['A', 'C', 'D'].map(n => calR.overall[n].brier.toFixed(5)).join(' / '), 'slope', ['A', 'C', 'D'].map(n => calR.overall[n].slope.toFixed(3)).join(' / '), 'winner', calWinner, JSON.stringify(calRule));

// ---------------------------------------------------------------- 2. PREDICTIVE SPREAD VALIDITY (before the cap verdict)
function spearman(x, y) { const n = x.length; const rk = (a) => { const idx = Array.from(a.keys()).sort((i, j) => a[i] - a[j]); const r = new Float64Array(n); for (let i = 0; i < n;) { let j = i; while (j + 1 < n && a[idx[j + 1]] === a[idx[i]]) j++; const v = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k]] = v; i = j + 1; } return r; }; const rx = rk(x), ry = rk(y); const mx = mean(Array.from(rx)), my = mean(Array.from(ry)); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; } return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN; }
const med = a => { const b = Array.from(a).sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] / 2 + b[Math.ceil((b.length - 1) / 2)] / 2 : NaN; };
const spreadFor = (recs) => { const n = recs.length; const sd = recs.map(r => rSd[r]), res = recs.map(r => rActual[r] - rProj[r]), ab = res.map(Math.abs); const rmse = Math.sqrt(mean(res.map(x => x * x))), meanRes = mean(res), resSd = Math.sqrt(mean(res.map(x => (x - meanRes) ** 2)));
  const floor = recs.filter(r => rSd[r] <= 1.000001).length / n; const nf = recs.filter(r => rSd[r] > 1.000001); let sp = NaN, spNF = NaN; if (n > 50) sp = spearman(sd, ab); if (nf.length > 50) spNF = spearman(nf.map(r => rSd[r]), nf.map(r => Math.abs(rActual[r] - rProj[r])));
  return { n, meanSD: mean(sd), medianSD: med(sd), rmsSD: Math.sqrt(mean(sd.map(x => x * x))), meanLine: mean(recs.map(r => rLine[r])), meanProj: mean(recs.map(r => rProj[r])), meanAbsResid: mean(ab), rmse, residSD: resSd, bias: meanRes, ratioMeanSDtoRMSE: mean(sd) / rmse, ratioMedianSDtoRMSE: med(sd) / rmse, ratioRmsSDtoRMSE: Math.sqrt(mean(sd.map(x => x * x))) / rmse, pctOnFloor: floor, spearmanSDvsAbsResid: sp, spearmanNonFloor: spNF, nNonFloor: nf.length, pctWithin1SD: recs.filter(r => Math.abs(rActual[r] - rProj[r]) <= rSd[r]).length / n, pctSDgtLine: recs.filter(r => rSd[r] > rLine[r]).length / n, pctCappedRelative: recs.filter(r => rEdgeAbs[r] / rLine[r] > 0.5).length / n }; };
R.spread.byFamily = Object.fromEntries(FK.map((k, fi) => [LAB[k], spreadFor(recSel(r => rFam[r] === fi))]));
R.spread.lowLineBySeason = Object.fromEntries(LOW4.map(fi => [LAB[FK[fi]], Object.fromEntries(SEASONS.map(se => [se, (() => { const rs = recSel(r => rFam[r] === fi && rSeason[r] + 2021 === se); const x = spreadFor(rs); return { n: x.n, meanSD: x.meanSD, rmse: x.rmse, ratio: x.ratioMeanSDtoRMSE, pctOnFloor: x.pctOnFloor }; })()]))]));
{ const fam = Object.values(R.spread.byFamily); R.spread.gate = { spearmanPositive: fam.filter(x => x.spearmanSDvsAbsResid > 0).length, ratioInRange: fam.filter(x => x.ratioMeanSDtoRMSE >= 0.5 && x.ratioMeanSDtoRMSE <= 2.0).length, floorDominated: Object.entries(R.spread.byFamily).filter(([, x]) => x.pctOnFloor >= 0.5).map(([k]) => k), ratioOutOfRange: Object.entries(R.spread.byFamily).filter(([, x]) => x.ratioMeanSDtoRMSE < 0.5 || x.ratioMeanSDtoRMSE > 2.0).map(([k, x]) => k + ' ' + x.ratioMeanSDtoRMSE.toFixed(2)) }; R.spread.gate.passes = R.spread.gate.spearmanPositive >= 10 && R.spread.gate.ratioInRange >= 9; }
console.log('spread gate', JSON.stringify(R.spread.gate));

// ---------------------------------------------------------------- 3. CAP candidates
const gradeTab = (sidx, fin, pf) => GL.map((G, gi) => { let n = 0, h = 0, sp = 0; for (const s of sidx) if (fin[s] === gi) { n++; h += sHit[s]; sp += pf(s); } const ci = wilson(h, n); return { grade: G, n, cov: sidx.length ? n / sidx.length : 0, rate: n ? h / n : null, lo: ci[0], hi: ci[1], meanP: n ? sp / n : null }; });
const monoStrict = (t, tol = 0.005) => { const q = t.filter(x => x.n >= 200); let worst = 0, pair = null; for (let i = 1; i < q.length; i++) { const d = q[i].rate - q[i - 1].rate; if (d > worst) { worst = d; pair = q[i - 1].grade + '<' + q[i].grade; } } return { ok: worst <= tol, worst: Math.max(0, worst), pair }; };
const monoSig = (t) => { const q = t.filter(x => x.n >= 200); let worst = 0, pair = null, sig = false; for (let i = 1; i < q.length; i++) { const d = q[i].rate - q[i - 1].rate; if (d > worst) { worst = d; pair = q[i - 1].grade + '<' + q[i].grade; } const se = Math.sqrt(q[i].rate * (1 - q[i].rate) / q[i].n + q[i - 1].rate * (1 - q[i - 1].rate) / q[i - 1].n); if (d > 0.005 && se > 0 && d / se > 1.64) sig = true; } return { ok: !sig, worst: Math.max(0, worst), pair }; };
const primeTab = (sidx, pr, pf) => { let n = 0, h = 0, sp = 0; for (const s of sidx) if (pr[s]) { n++; h += sHit[s]; sp += pf(s); } return { n, cov: sidx.length ? n / sidx.length : 0, rate: n ? h / n : null, meanP: n ? sp / n : null, ci: wilson(h, n) }; };
const SIDE = { all: (seasonSet) => sideSel(recSel(r => seasonSet.includes(rSeason[r] + 2021))), };
function evalCaps(cal, seasonSet) {
  const pf = probOf(cal), recsAll = recSel(r => seasonSet.includes(rSeason[r] + 2021)), sAll = sideSel(recsAll); const out = { cal, seasons: seasonSet, sides: sAll.length, caps: {} };
  const famRecs = FK.map((k, fi) => recsAll.filter(r => rFam[r] === fi)), seaRecs = Object.fromEntries(seasonSet.map(se => [se, recsAll.filter(r => rSeason[r] + 2021 === se)]));
  for (let c = 0; c < NC; c++) { const fin = finalUnder(cal, c), pr = sPrime[c], o = {};
    o.capShareOverall = sAll.filter(s => sWg[c][s]).length / sAll.length; o.thinShareOverall = sAll.filter(s => sThin[c][s]).length / sAll.length;
    o.capShareByFamily = Object.fromEntries(FK.map((k, fi) => { const sx = sideSel(famRecs[fi]); return [LAB[k], sx.filter(s => sWg[c][s]).length / (sx.length || 1)]; }));
    o.grades = gradeTab(sAll, fin, pf); o.monoStrict = monoStrict(o.grades); o.monoSig = monoSig(o.grades);
    o.bySeason = Object.fromEntries(seasonSet.map(se => { const sx = sideSel(seaRecs[se]); const t = gradeTab(sx, fin, pf); return [se, { grades: t, monoStrict: monoStrict(t), monoSig: monoSig(t) }]; }));
    o.byFamily = Object.fromEntries(FK.map((k, fi) => { const t = gradeTab(sideSel(famRecs[fi]), fin, pf); return [LAB[k], { grades: t, monoStrict: monoStrict(t), monoSig: monoSig(t) }]; }));
    o.byDirection = { over: gradeTab(sideSel(recsAll, [0]), fin, pf), under: gradeTab(sideSel(recsAll, [1]), fin, pf) };
    o.high = (() => { const sx = sideSel(recsAll.filter(r => HIGH.includes(rFam[r]))); const t = gradeTab(sx, fin, pf); return { A: t[0], B: t[1] }; })();
    o.blkBySeason = Object.fromEntries(seasonSet.map(se => { const sx = sideSel(seaRecs[se].filter(r => rFam[r] === FK.indexOf('blocks'))); const t = gradeTab(sx, fin, pf); return [se, { B: t[1], C: t[2] }]; }));
    o.prime = { overall: primeTab(sAll, pr, pf), bySeason: Object.fromEntries(seasonSet.map(se => [se, primeTab(sideSel(seaRecs[se]), pr, pf)])), byFamily: Object.fromEntries(FK.map((k, fi) => [LAB[k], primeTab(sideSel(famRecs[fi]), pr, pf)])), byDirection: { over: primeTab(sideSel(recsAll, [0]), pr, pf), under: primeTab(sideSel(recsAll, [1]), pr, pf) } };
    o.sumWorstInversion = FK.reduce((a, k) => a + o.byFamily[LAB[k]].monoStrict.worst, 0);
    o.famBrokenStrict = FK.filter(k => !o.byFamily[LAB[k]].monoStrict.ok).map(k => LAB[k] + ' ' + o.byFamily[LAB[k]].monoStrict.pair + ' +' + (100 * o.byFamily[LAB[k]].monoStrict.worst).toFixed(1) + 'pt'); o.famBrokenSig = FK.filter(k => !o.byFamily[LAB[k]].monoSig.ok).map(k => LAB[k]);
    // capped sides: what they would have been (no-cap engine B = index 1), and what they actually do
    if (c !== 1) { const fN = finalUnder(cal, 1); const rows2 = [0, 1, 2, 3].map(gi => { let nc = 0, hc = 0, nu = 0, hu = 0; for (const s of sAll) { if (fN[s] !== gi) continue; if (sWg[c][s]) { nc++; hc += sHit[s]; } else { nu++; hu += sHit[s]; } } const se = Math.sqrt((nc ? (hc / nc) * (1 - hc / nc) / nc : 0) + (nu ? (hu / nu) * (1 - hu / nu) / nu : 0)); return { wouldBe: GL[gi], nCapped: nc, hitCapped: nc ? hc / nc : null, nUncapped: nu, hitUncapped: nu ? hu / nu : null, diff: nc && nu ? hc / nc - hu / nu : null, z: nc && nu && se ? (hc / nc - hu / nu) / se : null }; });
      const topCapped = sAll.filter(s => sWg[c][s] && fN[s] <= 1); const topUncapped = sAll.filter(s => !sWg[c][s] && fN[s] <= 1);
      o.capped = { byWouldBeGrade: rows2, wouldBeAorB: { nCapped: topCapped.length, hitCapped: mean(topCapped.map(s => sHit[s])), nUncapped: topUncapped.length, hitUncapped: mean(topUncapped.map(s => sHit[s])) },
        byFamilyWouldBeAorB: Object.fromEntries(FK.map((k, fi) => { const sx = sideSel(famRecs[fi]); const a = sx.filter(s => sWg[c][s] && fN[s] <= 1), b = sx.filter(s => !sWg[c][s] && fN[s] <= 1); return [LAB[k], { nCapped: a.length, hitCapped: a.length ? mean(a.map(s => sHit[s])) : null, nUncapped: b.length, hitUncapped: b.length ? mean(b.map(s => sHit[s])) : null, sharePctOfSidesWouldBeAB: sx.length ? a.length / sx.length : 0 }]; })) };
      o.changedVsA = sAll.filter(s => fin[s] !== finalUnder(cal, 0)[s]).length; }
    out.caps[CAPS[c].id] = o; }
  // eligibility
  const A = out.caps.A, elig = {};
  for (const id of ['A', 'C', 'D']) { const o = out.caps[id]; const e1 = o.famBrokenSig.length === 0, e2 = Math.abs(o.high.A.rate - A.high.A.rate) <= 0.01 && Math.abs(o.high.B.rate - A.high.B.rate) <= 0.01 && Math.abs(o.prime.overall.rate - A.prime.overall.rate) <= 0.01,
    e3a = seasonSet.every(se => o.bySeason[se].monoSig.ok), q = seasonSet.filter(se => o.blkBySeason[se].B.n >= 100 && o.blkBySeason[se].C.n >= 100), e3b = q.length === 0 || q.filter(se => o.blkBySeason[se].B.rate >= o.blkBySeason[se].C.rate - 0.005).length >= Math.ceil(q.length * 2 / 3), e4 = id === 'A' ? true : R.spread.gate.passes;
    elig[id] = { e1_noSignificantFamilyInversion: e1, e2_noHighCountDegradation: e2, e3_seasonStability: e3a && e3b, e3a_overallMonotoneEachSeason: e3a, e3b_BLK_BgeC: e3b, blkSeasonsCounted: q.length, e4_spreadDefensible: e4, eligible: e1 && e2 && e3a && e3b && e4, sumWorstInversion: o.sumWorstInversion, changedVsA: o.changedVsA || 0 }; }
  out.eligibility = elig; const ok = ['A', 'C', 'D'].filter(id => elig[id].eligible); out.winner = ok.length ? ok.sort((a, b) => elig[a].sumWorstInversion - elig[b].sumWorstInversion || elig[a].changedVsA - elig[b].changedVsA)[0] : 'A (none eligible -- current rule stays)'; return out; }
R.cap.identityAllSeasons = evalCaps('ID', SEASONS);
R.cap.identityTestSeasons = evalCaps('ID', TEST);
if (calWinner !== 'A') R.cap.calibratedTestSeasons = evalCaps(calWinner, TEST);
R.cap.final = calWinner === 'A' ? R.cap.identityAllSeasons : R.cap.calibratedTestSeasons;
console.log('cap eligibility (final pipeline):', JSON.stringify(R.cap.final.eligibility), 'winner', R.cap.final.winner);
// cross-check: identity-test-seasons winner
console.log('cap eligibility (identity, 2023-26):', JSON.stringify(R.cap.identityTestSeasons.eligibility), 'winner', R.cap.identityTestSeasons.winner);

// ---------------------------------------------------------------- 4. real-line availability (facts only)
try { const sdb = new DatabaseSync(path.resolve(__dirname, '..', '..', 'data', 'snapshots.db'), { readOnly: true });
  const arch = sdb.prepare(`SELECT COUNT(*) n, MIN(captured_at) a, MAX(captured_at) b, COUNT(DISTINCT event_id) ev, COUNT(DISTINCT player_raw) pl FROM wnba_provider_line_archive`).get();
  const snap = sdb.prepare(`SELECT COUNT(*) n, COUNT(DISTINCT snap_date) days, SUM(CASE WHEN result IS NOT NULL THEN 1 ELSE 0 END) settled FROM prop_snapshots WHERE sport='wnba'`).get();
  R.realLines = { archiveRows: arch.n, capturedFrom: new Date(arch.a).toISOString(), capturedTo: new Date(arch.b).toISOString(), events: arch.ev, players: arch.pl, wnbaPropSnapshotRows: snap.n, snapshotDays: snap.days, settledSnapshotRows: snap.settled, verdict: 'REAL-LINE VALIDATION: DATA GAP' }; } catch (e) { R.realLines = { error: String(e.message), verdict: 'REAL-LINE VALIDATION: DATA GAP' }; }

fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(R, null, 1));
console.log('wrote', path.join(OUT, 'results.json'), `(${Math.round((Date.now() - t0) / 1000)}s total)`);
