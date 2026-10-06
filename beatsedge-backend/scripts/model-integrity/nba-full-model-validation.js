// NBA COMPLETE-MODEL WALK-FORWARD VALIDATION -- opponent defense REMOVED (model nba-edge-2026.10-nodef-v1).
//
// WHAT THIS IS: PLAYER-STAT PREDICTION VALIDATION. Every probability/grade/Prime below is scored against a SYNTHETIC pseudo-line (the app's
// own backtest convention: the half-point whose trailing over-rate is closest to 0.48) because NO historical provider/sportsbook lines exist
// locally. It is NOT real-line / market validation. Metrics that need genuine lines are reported as DATA GAP.
//
// LIVE = BACKTEST: model inputs are built with the LIVE builders themselves (nbaComputeWindows / nbaMinutesTrend / nbaProjMinutes extracted
// verbatim from BeatsEdge.html) and scored with the SAME calculateEdgeScore the app runs (see scripts/lib/nbaHistoricalInputs.js and
// scripts/test-nba-defense-removed-and-parity.js).
//
// ONE EXPLICIT CALIBRATION CONFIG (not whatever a browser holds): GRADE_CUTOFFS = {} (=> the engine's hard-coded default thresholds),
// PROB_CALIB = {} (identity probability curve), FAMILY_CALIB as shipped. Its id/hash are asserted and printed. Thresholds are NOT retuned.
//
// OLD vs NEW (for grade migration): the pre-removal HTML (tmp/model-integrity/baseline/BeatsEdge.pre-defense-removal.html, byte copy taken
// before the edit) is run on identical samples with live-shaped defense inputs (as-of reconstructed DvP ranks + as-of team points-allowed rank).
//
//   node scripts/model-integrity/nba-full-model-validation.js [--per-season 15000] [--boot 400] [--seed 20261006]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { loadModel, HTML_PATH } = require('../lib/loadBeatsEdgeModel');
const { buildLiveShapedNbaPlayer } = require('../lib/nbaHistoricalInputs');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const PER_SEASON = Number(arg('per-season', 15000)), BOOT = Number(arg('boot', 400)), SEED = Number(arg('seed', 20261006));
const OUT = path.resolve(__dirname, '..', '..', arg('out', 'tmp/model-integrity/nba-full-validation'));
const OLD_HTML = path.resolve(__dirname, '..', '..', 'tmp/model-integrity/baseline/BeatsEdge.pre-defense-removal.html');
const TEST_SEASONS = [2021, 2022, 2023, 2024, 2025];
const MIN_PRIOR_GAMES = 10, MIN_AVG_MIN = 15, MIN_TEAM_GAMES = 10;

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(SEED);

// ---------------------------------------------------------------- models + the ONE explicit calibration config
const mNew = loadModel({ liveNba: true });
const mOld = loadModel({ liveNba: true, htmlPath: OLD_HTML });
for (const m of [mNew, mOld]) { m.__setGradeCutoffs({}); m.__setProbCalib({}); }
const CALIB = {
  id: mNew.NBA_CALIBRATION_ID,
  gradeCutoffs: {}, probCalib: {},
  gradeDefaults: 'A: gradeScore>=0.86 && confidence>=80; B: >=0.68 && confidence>=50; C: >=0.46; else D (hard-coded in _calculateEdgeScoreImpl; thin-data/RED/crossBook caps unchanged)',
  familyCalibNba: mNew.FAMILY_CALIB && mNew.FAMILY_CALIB.nba,
};
CALIB.sha256 = crypto.createHash('sha256').update(JSON.stringify(CALIB)).digest('hex');
if (mNew.nbaModelMeta().calibrationId !== CALIB.id) throw new Error('calibration id mismatch: another calibration is in force');
console.log('CALIBRATION CONFIG', JSON.stringify({ id: CALIB.id, sha256: CALIB.sha256 }));

// ---------------------------------------------------------------- stats
const FAMS = {
  points: { label: 'PTS', get: r => r.points, idx: [0] }, rebounds: { label: 'REB', get: r => r.rebounds, idx: [1] }, assists: { label: 'AST', get: r => r.assists, idx: [2] },
  threes: { label: '3PM', get: r => r.threes, idx: [3] }, steals: { label: 'STL', get: r => r.steals, idx: [4] }, blocks: { label: 'BLK', get: r => r.blocks, idx: [5] },
  turnovers: { label: 'TOV', get: r => r.turnovers, idx: [6] }, pra: { label: 'PRA', get: r => r.points + r.rebounds + r.assists, idx: [0, 1, 2], combo: true },
  pr: { label: 'PR', get: r => r.points + r.rebounds, idx: [0, 1], combo: true }, pa: { label: 'PA', get: r => r.points + r.assists, idx: [0, 2], combo: true },
  ra: { label: 'RA', get: r => r.rebounds + r.assists, idx: [1, 2], combo: true }, blocksSteals: { label: 'BLK+STL', get: r => r.blocks + r.steals, idx: [5, 4], combo: true },
};
const FKEYS = Object.keys(FAMS);
const GET7 = [r => r.points, r => r.rebounds, r => r.assists, r => r.threes, r => r.steals, r => r.blocks, r => r.turnovers];
const GROUPS = ['G', 'F', 'C'], NCELL = 3, NSTAT = 7;

// ---------------------------------------------------------------- data (+ hygiene)
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
const fingerprint = { rows: all.length, from: all[0].game_date, to: all[all.length - 1].game_date, sumPts: all.reduce((s, r) => s + r.points, 0) };
console.log('data', JSON.stringify(fingerprint), 'hygiene', JSON.stringify(hygiene));

// team schedule (as-of rest) -- from the same box data
const teamDates = new Map(); all.forEach(r => { let s = teamDates.get(r.team); if (!s) teamDates.set(r.team, s = new Set()); s.add(r.game_date); });
const teamDatesSorted = new Map([...teamDates].map(([t, s]) => [t, [...s].sort()]));
function prevTeamDate(team, date) { const a = teamDatesSorted.get(team); let lo = 0, hi = a.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < date) lo = mid + 1; else hi = mid; } return lo > 0 ? a[lo - 1] : null; }

// ---------------------------------------------------------------- as-of DvP snapshots (OLD model inputs only; regular-season games)
function buildSnaps(rows) {
  const bySeason = new Map();
  rows.filter(r => r.season_type === 2).forEach(r => { let s = bySeason.get(r.season); if (!s) bySeason.set(r.season, s = new Map()); let d = s.get(r.game_date); if (!d) s.set(r.game_date, d = []); d.push(r); });
  const snaps = new Map();
  for (const [season, dates] of bySeason) {
    const teams = new Map();
    for (const date of [...dates.keys()].sort()) {
      const snap = new Map(); teams.forEach((o, t) => snap.set(t, { n: o.games.size, a: Float64Array.from(o.a) })); snaps.set(season + '|' + date, snap);
      dates.get(date).forEach(r => {
        let o = teams.get(r.opponent); if (!o) teams.set(r.opponent, o = { games: new Set(), a: new Float64Array(NCELL * NSTAT) });
        o.games.add(r.game_id); const g = GROUPS.indexOf(r.pos_group); for (let j = 0; j < NSTAT; j++) o.a[g * NSTAT + j] += GET7[j](r);
      });
    }
  }
  return snaps;
}
const SNAPS = buildSnaps(all);
const rankCache = new Map();
function ranksFor(key, snap, idx) { // 1-150 ascending allowed-rank among eligible team x group cells (the app's DvP scale)
  const ck = key + '|' + idx.join(','); let m = rankCache.get(ck); if (m) return m;
  const cells = []; snap.forEach((o, t) => { if (o.n < MIN_TEAM_GAMES) return; GROUPS.forEach((g, gi) => cells.push({ k: t + '|' + g, v: idx.reduce((s, j) => s + o.a[gi * NSTAT + j], 0) / o.n })); });
  cells.sort((a, b) => a.v - b.v || (a.k < b.k ? -1 : 1)); m = new Map(); cells.forEach((c, i) => m.set(c.k, cells.length > 1 ? 1 + i * 149 / (cells.length - 1) : 75.5)); rankCache.set(ck, m); return m;
}
function teamPtsRank(key, snap) { // 1-30 (1 = fewest points allowed), as-of -- the live `oppRank` input
  const ck = key + '|team30'; let m = rankCache.get(ck); if (m) return m;
  const arr = []; snap.forEach((o, t) => { if (o.n >= MIN_TEAM_GAMES) arr.push({ t, v: [0, 1, 2].reduce((s, g) => s + o.a[g * NSTAT], 0) / o.n }); });
  arr.sort((a, b) => a.v - b.v); m = new Map(arr.map((x, i) => [x.t, i + 1])); rankCache.set(ck, m); return m;
}
function oldDefenseInputs(season, date, opp) {
  const key = season + '|' + date, snap = SNAPS.get(key); if (!snap || !snap.get(opp) || snap.get(opp).n < MIN_TEAM_GAMES) return null;
  let elig = 0; snap.forEach(o => { if (o.n >= MIN_TEAM_GAMES) elig++; }); if (elig < 20) return null;
  const by = {}; for (const g of GROUPS) { const r = (j) => ranksFor(key, snap, [j]).get(opp + '|' + g); const rk = [0, 1, 2, 3, 4, 5, 6].map(r); if (rk.some(x => x == null)) return null;
    by[g] = { rank: Math.round(rk[0]), rebRank: Math.round(rk[1]), astRank: Math.round(rk[2]), tpmRank: Math.round(rk[3]), stlRank: Math.round(rk[4]), blkRank: Math.round(rk[5]), toRank: Math.round(rk[6]), pointsAllowed: 0, reboundsAllowed: 0, assistsAllowed: 0, threesAllowed: 0, stealsAllowed: 0, blocksAllowed: 0, turnoversAllowed: 0 }; }
  return { byPosition: by, oppRankByAbbr: Object.fromEntries(teamPtsRank(key, snap)), oppRank: teamPtsRank(key, snap).get(opp) || null };
}

// ---------------------------------------------------------------- sampling (as-of eligibility only)
const byPlayer = new Map(); all.forEach(r => { let a = byPlayer.get(r.athlete_id); if (!a) byPlayer.set(r.athlete_id, a = []); a.push(r); });
const samples = [];
for (const season of TEST_SEASONS) {
  const elig = [];
  for (const [pid, rows] of byPlayer) {
    let start = rows.findIndex(r => r.season >= season - 1); if (start < 0) continue;
    for (let i = start; i < rows.length; i++) {
      const r = rows[i]; if (r.season !== season || r.season_type !== 2) continue;
      if (i - start < MIN_PRIOR_GAMES) continue;
      const m10 = rows.slice(Math.max(start, i - 10), i); if (m10.reduce((s, x) => s + x.minutes, 0) / m10.length < MIN_AVG_MIN) continue;
      const def = oldDefenseInputs(season, r.game_date, r.opponent); if (!def) continue;   // same paired subset for old and new
      elig.push({ rows, start, i });
    }
  }
  for (let k = elig.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [elig[k], elig[j]] = [elig[j], elig[k]]; }
  const take = elig.slice(0, PER_SEASON); console.log(`season ${season}: eligible ${elig.length}, sampled ${take.length}`); take.forEach(e => samples.push(Object.assign({ season }, e)));
}
{ let v = 0; samples.forEach(s => { const t = s.rows[s.i]; for (let j = s.start; j < s.i; j++) if (!(s.rows[j].game_date < t.game_date)) v++; }); console.log('as-of check: history rows dated on/after the target game =', v); if (v) throw new Error('history leak'); }

// ---------------------------------------------------------------- helpers
const mean = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const clip = (p) => Math.min(0.999, Math.max(0.001, p));
function pseudoLine(hv) { const avg = mean(hv); let line = null, best = 99; for (let c = 0.5; c <= avg * 2.2 + 1; c += 1) { const over = hv.filter(v => v > c).length / hv.length; const gap = Math.abs(over - 0.48); if (gap < best) { best = gap; line = c; } } return line; }
const GR = { A: 0, B: 1, C: 2, D: 3 }, GL = ['A', 'B', 'C', 'D'];

// ---------------------------------------------------------------- run
const recs = []; const dates = []; const dateIdx = new Map(); const t0 = Date.now(); let done = 0, skipped = 0;
for (const s of samples) {
  const target = s.rows[s.i], hist = s.rows.slice(s.start, s.i);
  const lineFor = {};
  for (const k of FKEYS) { const hv = hist.map(FAMS[k].get); if (mean(hv) <= 0) continue; const line = pseudoLine(hv); if (line == null || line <= 0) continue; lineFor[k] = line; }
  if (!Object.keys(lineFor).length) { skipped++; continue; }
  const ptd = prevTeamDate(target.team, target.game_date);
  const def = oldDefenseInputs(s.season, target.game_date, target.opponent);
  const pNew = buildLiveShapedNbaPlayer(mNew, { target, hist, lineFor, prevTeamDate: ptd });
  // OLD (pre-removal) live-shaped player: same windows + the live defense inputs the old model read
  const pOld = buildLiveShapedNbaPlayer(mOld, { target, hist, lineFor, prevTeamDate: ptd, oppRankByAbbr: def.oppRankByAbbr, opponentDefense: { byPosition: def.byPosition }, oppRank: def.oppRank });
  let di = dateIdx.get(target.game_date); if (di == null) { di = dates.length; dateIdx.set(target.game_date, di); dates.push(target.game_date); }
  for (const k of FKEYS) {
    if (lineFor[k] == null) continue;
    const actual = FAMS[k].get(target), line = lineFor[k]; if (actual === line) continue;
    const w = pNew.statsByKey[k];
    const rec = { season: s.season, di, fam: k, g: target.pos_group, actual, line, sAvg: w.season.avg, l10: w.last10.avg };
    for (const [d, dir] of [['o', 'over'], ['u', 'under']]) {
      const prop = { statKey: k, type: k, line, direction: dir, lineSource: 'backtest' };
      const eN = mNew.calculateEdgeScore(pNew, prop), eO = mOld.calculateEdgeScore(pOld, prop);
      if (eN.insufficientData) { rec.bad = true; break; }
      if (d === 'o') { rec.projN = eN.projection; rec.projO = eO.projection; }
      rec['gN' + d] = GR[eN.grade]; rec['gO' + d] = GR[eO.grade]; rec['pN' + d] = eN.modelProbPct / 100; rec['pO' + d] = eO.modelProbPct / 100;
      rec['primeN' + d] = eN.prime ? 1 : 0; rec['primeO' + d] = eO.prime ? 1 : 0; rec['cN' + d] = eN.confidence; rec['cO' + d] = eO.confidence;
      rec['hit' + d] = (dir === 'over' ? actual > line : actual < line) ? 1 : 0;
    }
    if (!rec.bad) recs.push(rec);
  }
  if (++done % 5000 === 0) console.log(`  ${done}/${samples.length} samples (${Math.round((Date.now() - t0) / 1000)}s)`);
}
console.log('records', recs.length, 'skipped samples', skipped);

// ---------------------------------------------------------------- statistics
const wilson = (h, n) => { if (!n) return [NaN, NaN]; const z = 1.96, p = h / n, d = 1 + z * z / n, c = p + z * z / (2 * n), a = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - a) / d, (c + a) / d]; };
function bootDiff(rs, fn) {
  const by = new Map(); rs.forEach(r => { let o = by.get(r.di); if (!o) by.set(r.di, o = { s: 0, n: 0 }); o.s += fn(r); o.n++; });
  const bl = [...by.values()], N = rs.length, est = bl.reduce((s, b) => s + b.s, 0) / N, r2 = rng(SEED ^ 0x9e3779b1), ss = [];
  for (let b = 0; b < BOOT; b++) { let s = 0, n = 0; for (let k = 0; k < bl.length; k++) { const x = bl[Math.floor(r2() * bl.length)]; s += x.s; n += x.n; } ss.push(s / n); }
  ss.sort((a, c) => a - c); return { est, lo: ss[Math.floor(0.025 * BOOT)], hi: ss[Math.floor(0.975 * BOOT)] };
}
function probMetrics(ps, ys) {
  const p = ps.map(clip), n = p.length, brier = mean(p.map((v, i) => (v - ys[i]) ** 2)), ll = mean(p.map((v, i) => -(ys[i] ? Math.log(v) : Math.log(1 - v))));
  const bk = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 })); p.forEach((v, i) => { const b = bk[Math.min(9, Math.floor(v * 10))]; b.n++; b.p += v; b.y += ys[i]; });
  const ece = bk.reduce((s, b) => s + (b.n ? (b.n / n) * Math.abs(b.p / b.n - b.y / b.n) : 0), 0);
  const x = p.map(v => Math.log(v / (1 - v))); let a = 0, b = 1;
  for (let it = 0; it < 25; it++) { let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0; for (let i = 0; i < n; i++) { const q = 1 / (1 + Math.exp(-(a + b * x[i]))), w = q * (1 - q); g0 += ys[i] - q; g1 += (ys[i] - q) * x[i]; h00 += w; h01 += w * x[i]; h11 += w * x[i] * x[i]; } const det = h00 * h11 - h01 * h01; if (Math.abs(det) < 1e-12) break; a += (h11 * g0 - h01 * g1) / det; b += (-h01 * g0 + h00 * g1) / det; }
  return { n, brier, logLoss: ll, ece, slope: b, intercept: a, meanP: mean(p), rate: mean(ys), buckets: bk.map((b, i) => ({ lo: i / 10, n: b.n, meanP: b.n ? b.p / b.n : null, rate: b.n ? b.y / b.n : null })) };
}
// side rows: one per (record, direction)
const sides = (rs, model) => { const out = []; const M = model === 'new' ? 'N' : 'O'; rs.forEach(r => ['o', 'u'].forEach(d => out.push({ r, d, g: r['g' + M + d], p: r['p' + M + d], prime: r['prime' + M + d], hit: r['hit' + d], conf: r['c' + M + d] }))); return out; };
function gradeTable(sd) { return GL.map((G, gi) => { const x = sd.filter(s => s.g === gi), h = x.reduce((a, s) => a + s.hit, 0), ci = wilson(h, x.length); return { grade: G, n: x.length, share: x.length / sd.length, rate: x.length ? h / x.length : null, lo: ci[0], hi: ci[1], meanP: x.length ? mean(x.map(s => s.p)) : null }; }); }
function mono(t) { const r = t.filter(x => x.n >= 100).map(x => x.rate); return r.every((v, i) => i === 0 || v <= r[i - 1] + 1e-9); }

const R = { meta: { generated: new Date().toISOString(), modelVersion: mNew.NBA_MODEL_VERSION, calibration: CALIB, seasons: TEST_SEASONS, perSeason: PER_SEASON, seed: SEED, bootstrap: BOOT, fingerprint, hygiene, samples: samples.length, records: recs.length,
  scope: 'PLAYER-STAT PREDICTION VALIDATION against a SYNTHETIC pseudo-line. NOT real-line / market validation (DATA GAP).' }, fam: {}, overall: {} };
const overOnly = recs;
// per family projection + probability + grades
for (const k of FKEYS) {
  const rs = recs.filter(r => r.fam === k), F = { label: FAMS[k].label, n: rs.length };
  const err = (key) => rs.map(r => r[key] - r.actual);
  const m = (e) => ({ mae: mean(e.map(Math.abs)), rmse: Math.sqrt(mean(e.map(v => v * v))), bias: mean(e) });
  F.proj = { new: m(err('projN')), old: m(err('projO')), seasonAvg: m(err('sAvg')), l10: m(err('l10')) };
  F.projDiff = bootDiff(rs, r => Math.abs(r.projN - r.actual) - Math.abs(r.projO - r.actual));
  F.projDiffVsSeasonAvg = bootDiff(rs, r => Math.abs(r.projN - r.actual) - Math.abs(r.sAvg - r.actual));
  const sdN = sides(rs, 'new'), sdO = sides(rs, 'old');
  F.prob = { new: probMetrics(sdN.map(s => s.p), sdN.map(s => s.hit)), old: probMetrics(sdO.map(s => s.p), sdO.map(s => s.hit)) };
  F.grades = { new: gradeTable(sdN), old: gradeTable(sdO) };
  F.prime = { new: { n: sdN.filter(s => s.prime).length, hit: mean(sdN.filter(s => s.prime).map(s => s.hit)) }, old: { n: sdO.filter(s => s.prime).length, hit: mean(sdO.filter(s => s.prime).map(s => s.hit)) } };
  R.fam[k] = F;
}
// overall
const sdN = sides(recs, 'new'), sdO = sides(recs, 'old');
R.overall.prob = { new: probMetrics(sdN.map(s => s.p), sdN.map(s => s.hit)), old: probMetrics(sdO.map(s => s.p), sdO.map(s => s.hit)) };
R.overall.brierDiff = bootDiff(recs, r => ['o', 'u'].reduce((a, d) => a + (clip(r['pN' + d]) - r['hit' + d]) ** 2 - (clip(r['pO' + d]) - r['hit' + d]) ** 2, 0) / 2);
R.overall.grades = { new: gradeTable(sdN), old: gradeTable(sdO) };
R.overall.monotone = { new: mono(R.overall.grades.new), old: mono(R.overall.grades.old) };
R.overall.baseRate = mean(sdN.map(s => s.hit));
// by season
R.bySeason = {}; TEST_SEASONS.forEach(se => { const rs = recs.filter(r => r.season === se), a = sides(rs, 'new'), b = sides(rs, 'old'); R.bySeason[se] = { n: rs.length, grades: gradeTable(a), gradesOld: gradeTable(b), brierNew: probMetrics(a.map(s => s.p), a.map(s => s.hit)).brier, brierOld: probMetrics(b.map(s => s.p), b.map(s => s.hit)).brier, mono: mono(gradeTable(a)),
  mae: mean(rs.map(r => Math.abs(r.projN - r.actual))), maeOld: mean(rs.map(r => Math.abs(r.projO - r.actual))) }; });
// over vs under
R.byDirection = {}; for (const [d, nm] of [['o', 'over'], ['u', 'under']]) { const a = sdN.filter(s => s.d === d), b = sdO.filter(s => s.d === d); R.byDirection[nm] = { new: { grades: gradeTable(a), prob: probMetrics(a.map(s => s.p), a.map(s => s.hit)), prime: { n: a.filter(s => s.prime).length, rate: mean(a.filter(s => s.prime).map(s => s.hit)) } }, old: { grades: gradeTable(b), prob: probMetrics(b.map(s => s.p), b.map(s => s.hit)), prime: { n: b.filter(s => s.prime).length, rate: mean(b.filter(s => s.prime).map(s => s.hit)) } } }; }
// prime overall
const prN = sdN.filter(s => s.prime), prO = sdO.filter(s => s.prime);
R.prime = { new: { n: prN.length, rate: mean(prN.map(s => s.hit)), ci: wilson(prN.reduce((a, s) => a + s.hit, 0), prN.length), meanP: mean(prN.map(s => s.p)), share: prN.length / sdN.length }, old: { n: prO.length, rate: mean(prO.map(s => s.hit)), ci: wilson(prO.reduce((a, s) => a + s.hit, 0), prO.length), meanP: mean(prO.map(s => s.p)), share: prO.length / sdO.length },
  bySeason: TEST_SEASONS.map(se => { const x = prN.filter(s => s.r.season === se); return { season: se, n: x.length, rate: mean(x.map(s => s.hit)) }; }) };
// migration (identical (sample, family, direction) keys)
const mig = { grade: GL.map(() => GL.map(() => 0)), prime: { both: 0, oldOnly: 0, newOnly: 0, neither: 0 }, pickSideChanged: 0, pickSideTotal: 0, byFamily: {}, probShiftMeanAbs: 0, total: 0 };
recs.forEach(r => { ['o', 'u'].forEach(d => { mig.grade[r['gO' + d]][r['gN' + d]]++; mig.total++; mig.probShiftMeanAbs += Math.abs(r['pN' + d] - r['pO' + d]);
  const po = r['primeO' + d], pn = r['primeN' + d]; if (po && pn) mig.prime.both++; else if (po) mig.prime.oldOnly++; else if (pn) mig.prime.newOnly++; else mig.prime.neither++; });
  const sideOld = r.projO > r.line, sideNew = r.projN > r.line; mig.pickSideTotal++; if (sideOld !== sideNew) mig.pickSideChanged++;
  const f = mig.byFamily[r.fam] || (mig.byFamily[r.fam] = { n: 0, sideChanged: 0, gradeUp: 0, gradeDown: 0, same: 0, aToLower: 0 }); f.n++; if (sideOld !== sideNew) f.sideChanged++;
  ['o', 'u'].forEach(d => { const a = r['gO' + d], b = r['gN' + d]; if (b === a) f.same++; else if (b < a) f.gradeUp++; else f.gradeDown++; if (a === 0 && b > 0) f.aToLower++; }); });
mig.probShiftMeanAbs /= mig.total; R.migration = mig;

// DATA GAP register
R.dataGap = ['real provider-line hit rate / ROI / CLV for any grade or Prime', 'real-price (vig-aware) edge or EV', 'line-vs-market factor (needs genuine line history)', 'historical alternate-line (goblin/demon) behavior', 'Smart Parlay real-line hit-rate gating on genuine lines', 'recomputation of CURRENT live-slate props (needs a live slate / provider fetch; offseason)'];

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(R, null, 1));

// ---------------------------------------------------------------- report
const f = (x, d = 3) => (x == null || Number.isNaN(x)) ? '--' : x.toFixed(d), pc = (x, d = 1) => (x == null || Number.isNaN(x)) ? '--' : (100 * x).toFixed(d) + '%';
const ci = (o, d = 4) => `${f(o.est, d)} [${f(o.lo, d)}, ${f(o.hi, d)}]`;
let md = `# NBA complete-model validation — opponent defense removed (\`${R.meta.modelVersion}\`)\n\n`;
md += `> **Scope: PLAYER-STAT PREDICTION VALIDATION.** Hit/grade/probability/Prime results are scored against the app's own **synthetic pseudo-line** (trailing over-rate ≈ 0.48). **Not real-line / market validation — DATA GAP** (no historical provider lines locally). Both sides (over and under) are graded per prop, as the app's own backtest does.\n\n`;
md += `**Calibration/cutoff configuration used (single, explicit):** id \`${CALIB.id}\` · sha256 \`${CALIB.sha256.slice(0, 16)}…\` · GRADE_CUTOFFS = {} (engine defaults: ${CALIB.gradeDefaults}) · PROB_CALIB = {} (identity) · FAMILY_CALIB.nba as shipped. **Thresholds were NOT retuned.**\n\n`;
md += `Data: nba_player_box, targets = regular-season ${TEST_SEASONS[0]}–${TEST_SEASONS[TEST_SEASONS.length - 1]}; model inputs built by the **live** window/minutes builders from each player's strictly-earlier games (current + previous season, regular + postseason, as the live fetch does). ${samples.length.toLocaleString()} sampled player-games → ${recs.length.toLocaleString()} (player-game × prop-family) records → ${(recs.length * 2).toLocaleString()} graded sides. Hygiene: dropped ${hygiene.nonNbaTeamRows} pseudo-team and ${hygiene.duplicatedTeamDateRows} duplicated-team-date rows. Seed ${SEED}; date-block bootstrap ×${BOOT}.\n\n`;
md += `## Projection error by prop family (NEW = defense removed; OLD = previous production with live-shaped defense inputs)\n\n| Family | N | MAE new | MAE old | ΔMAE new−old 95% CI | RMSE new | RMSE old | bias new | bias old | MAE season-avg | ΔMAE new−season-avg |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const k of FKEYS) { const F = R.fam[k]; md += `| ${F.label} | ${F.n} | ${f(F.proj.new.mae)} | ${f(F.proj.old.mae)} | ${ci(F.projDiff, 3)} | ${f(F.proj.new.rmse)} | ${f(F.proj.old.rmse)} | ${f(F.proj.new.bias)} | ${f(F.proj.old.bias)} | ${f(F.proj.seasonAvg.mae)} | ${ci(F.projDiffVsSeasonAvg)} |\n`; }
md += `\n## Probability calibration (both sides pooled; synthetic pseudo-line)\n\n| Family | Brier new | Brier old | LogLoss new | ECE new | ECE old | slope new | slope old | mean P new | actual rate |\n|---|---|---|---|---|---|---|---|---|---|\n`;
for (const k of FKEYS) { const F = R.fam[k]; md += `| ${F.label} | ${f(F.prob.new.brier, 4)} | ${f(F.prob.old.brier, 4)} | ${f(F.prob.new.logLoss, 4)} | ${f(F.prob.new.ece, 3)} | ${f(F.prob.old.ece, 3)} | ${f(F.prob.new.slope, 2)} | ${f(F.prob.old.slope, 2)} | ${pc(F.prob.new.meanP)} | ${pc(F.prob.new.rate)} |\n`; }
const O = R.overall; md += `| **ALL** | ${f(O.prob.new.brier, 4)} | ${f(O.prob.old.brier, 4)} | ${f(O.prob.new.logLoss, 4)} | ${f(O.prob.new.ece, 3)} | ${f(O.prob.old.ece, 3)} | ${f(O.prob.new.slope, 2)} | ${f(O.prob.old.slope, 2)} | ${pc(O.prob.new.meanP)} | ${pc(O.prob.new.rate)} |\n\nBrier new−old (all, 95% CI): ${ci(O.brierDiff, 5)} (negative = new better). Reliability buckets (new, all families):\n\n| P bucket | n | mean P | actual |\n|---|---|---|---|\n`;
O.prob.new.buckets.forEach(b => { md += `| ${pc(b.lo, 0)}–${pc(b.lo + 0.1, 0)} | ${b.n} | ${pc(b.meanP)} | ${pc(b.rate)} |\n`; });
md += `\n## Grade performance with the frozen/default thresholds (ALL families, both sides)\n\nBase rate of a side hitting: ${pc(O.baseRate)}.\n\n| Grade | N new | share | hit rate new [95% CI] | mean stated P | N old | hit rate old |\n|---|---|---|---|---|---|---|\n`;
O.grades.new.forEach((g, i) => { const o = O.grades.old[i]; md += `| ${g.grade} | ${g.n} | ${pc(g.share)} | ${pc(g.rate)} [${pc(g.lo)}, ${pc(g.hi)}] | ${pc(g.meanP)} | ${o.n} | ${pc(o.rate)} |\n`; });
md += `\nGrade monotone (A ≥ B ≥ C ≥ D hit rate, groups with n≥100): new **${O.monotone.new}**, old ${O.monotone.old}.\n\n### By prop family — new model grade hit rates (N)\n\n| Family | A | B | C | D |\n|---|---|---|---|---|\n`;
for (const k of FKEYS) { const g = R.fam[k].grades.new; md += `| ${R.fam[k].label} | ${g.map(x => x.n ? `${pc(x.rate)} (${x.n})` : '—').join(' | ')} |\n`; }
md += `\n### Season-by-season (new model)\n\n| Season | records | A hit (N) | B hit (N) | C hit (N) | D hit (N) | monotone | Brier new | Brier old | MAE new | MAE old |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const se of TEST_SEASONS) { const b = R.bySeason[se]; md += `| ${se} | ${b.n} | ${b.grades.map(x => x.n ? `${pc(x.rate)} (${x.n})` : '—').join(' | ')} | ${b.mono} | ${f(b.brierNew, 4)} | ${f(b.brierOld, 4)} | ${f(b.mae)} | ${f(b.maeOld)} |\n`; }
md += `\n## Over vs Under (new model)\n\n| Side | A hit (N) | B hit (N) | C hit (N) | D hit (N) | Brier | ECE | mean P | actual | Prime N / hit |\n|---|---|---|---|---|---|---|---|---|---|\n`;
for (const nm of ['over', 'under']) { const x = R.byDirection[nm].new; md += `| ${nm} | ${x.grades.map(g => g.n ? `${pc(g.rate)} (${g.n})` : '—').join(' | ')} | ${f(x.prob.brier, 4)} | ${f(x.prob.ece, 3)} | ${pc(x.prob.meanP)} | ${pc(x.prob.rate)} | ${x.prime.n} / ${pc(x.prime.rate)} |\n`; }
md += `\n## Prime (new model eligibility unchanged; synthetic pseudo-line)\n\nNew: N=${R.prime.new.n} (${pc(R.prime.new.share, 2)} of sides), hit ${pc(R.prime.new.rate)} [${pc(R.prime.new.ci[0])}, ${pc(R.prime.new.ci[1])}], mean stated P ${pc(R.prime.new.meanP)}. Old: N=${R.prime.old.n} (${pc(R.prime.old.share, 2)}), hit ${pc(R.prime.old.rate)} [${pc(R.prime.old.ci[0])}, ${pc(R.prime.old.ci[1])}], mean stated P ${pc(R.prime.old.meanP)}. By season (new): ${R.prime.bySeason.map(x => `${x.season}: ${x.n} / ${pc(x.rate)}`).join(' · ')}.\n\nPrime by family (new): ${FKEYS.map(k => `${R.fam[k].label} ${R.fam[k].prime.new.n}/${pc(R.fam[k].prime.new.hit)}`).join(' · ')}.\n`;
md += `\n## Grade migration caused by removing the defense effect (identical player-games, families and sides)\n\nRows = OLD grade, columns = NEW grade (counts of graded sides, N=${mig.total.toLocaleString()}):\n\n| old \\ new | A | B | C | D |\n|---|---|---|---|---|\n`;
GL.forEach((G, i) => { md += `| ${G} | ${mig.grade[i].join(' | ')} |\n`; });
const rowTot = (i) => mig.grade[i].reduce((a, b) => a + b, 0);
md += `\nA → B/C/D: ${mig.grade[0][1] + mig.grade[0][2] + mig.grade[0][3]} of ${rowTot(0)} old-A (${pc((mig.grade[0][1] + mig.grade[0][2] + mig.grade[0][3]) / rowTot(0))}); B → other: ${rowTot(1) - mig.grade[1][1]} of ${rowTot(1)} (${pc((rowTot(1) - mig.grade[1][1]) / rowTot(1))}); C → other: ${rowTot(2) - mig.grade[2][2]} of ${rowTot(2)}; D → other: ${rowTot(3) - mig.grade[3][3]} of ${rowTot(3)}.\n\nPrime: both ${mig.prime.both}, old-only (Prime → non-Prime) **${mig.prime.oldOnly}**, new-only ${mig.prime.newOnly}, neither ${mig.prime.neither}.\n\nPick-side (projection vs line) changed: ${mig.pickSideChanged} of ${mig.pickSideTotal} props (${pc(mig.pickSideChanged / mig.pickSideTotal)}). Mean |Δ stated probability|: ${f(mig.probShiftMeanAbs * 100, 2)} points.\n\n| Family | props | pick-side changed | sides regraded up | down | same | A → lower |\n|---|---|---|---|---|---|---|\n`;
for (const k of FKEYS) { const x = mig.byFamily[k]; md += `| ${FAMS[k].label} | ${x.n} | ${x.sideChanged} (${pc(x.sideChanged / x.n)}) | ${x.gradeUp} | ${x.gradeDown} | ${x.same} | ${x.aToLower} |\n`; }
md += `\n## DATA GAP (not substituted with synthetic data)\n\n${R.dataGap.map(x => '- ' + x).join('\n')}\n`;
fs.writeFileSync(path.join(OUT, 'report.md'), md);
console.log('wrote', path.join(OUT, 'report.md'));
