// NBA DEFENSE-FEATURE HARNESS -- PLAYER-STAT PREDICTION VALIDATION ONLY.
//
// This is NOT sportsbook edge / EV validation. No historical sportsbook closing lines exist locally, so nothing here can say whether any
// variant beats the market. "Directional accuracy" and "calibration" below are measured against a SYNTHETIC pseudo-line built exactly the
// way the app's own backtest builds one (backtestSeries: the half-point whose trailing over-rate is closest to 0.48). Treat them as
// model-self-consistency diagnostics, not betting results.
//
// What it compares (the REAL shipped calculateEdgeScore, extracted from BeatsEdge.html -- production is never modified):
//   A  current production: generic points-rank nudge  +  stat-specific DvP factor/multiplier
//   B  stat-specific only (generic nudge disabled via a TEST-ONLY source transform)
//   C  no defense effect at all (opponentDefense = null)
// plus plain baselines: season average, last-10 average.
//
// Honesty rules enforced here:
//   * every feature is strictly as-of: player windows use only games before the target date; DvP ranks use only games before the target
//     date of the same regular season (>= MIN_TEAM_GAMES team games, else no defense info -> all variants identical);
//   * the production formulas have no fitted parameters, so "walk-forward" = each season is predicted from data that precedes each date;
//     results are reported PER SEASON for stability;
//   * uncertainty: block bootstrap by date (dependence within a slate) on paired differences;
//   * the DvP here is reconstructed from box scores (team x G/F/C group, ranked across 90 cells, rescaled to the app's 1-150 scale).
//     It is an approximation of the app's embedded NBA_DVP_CSV, NOT the same table -- stated as a limitation, not hidden.
//
//   node scripts/model-integrity/nba-defense-harness.js [--seasons 2021,2022,...] [--per-season 6000] [--seed 20261006] [--boot 600] [--out tmp/model-integrity/nba-defense]

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadModel } = require('../lib/loadBeatsEdgeModel');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const SEASONS = String(arg('seasons', '2021,2022,2023,2024,2025')).split(',').map(Number);
const PER_SEASON = Number(arg('per-season', 6000));
const SEED = Number(arg('seed', 20261006));
const BOOT = Number(arg('boot', 600));
const OUT = path.resolve(__dirname, '..', '..', arg('out', 'tmp/model-integrity/nba-defense'));
const MIN_TEAM_GAMES = 10, MIN_PRIOR_GAMES = 10, HIST_N = 40, MIN_AVG_MIN = 15;

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(SEED);

// -- models ------------------------------------------------------------------
const GENERIC_BLOCK = "if (posDefense && posDefense.rank !== undefined && sport !== 'nfl' && sport !== 'ncaaf') {";
const mA = loadModel();
const mB = loadModel({ transform: (src) => { if (!src.includes(GENERIC_BLOCK)) throw new Error('generic block anchor not found -- BeatsEdge.html changed; update the harness'); return src.replace(GENERIC_BLOCK, 'if (false) {'); } });

// -- stat definitions ----------------------------------------------------------
const STATS = {
  points:       { label: 'PTS',     get: r => r.points },
  rebounds:     { label: 'REB',     get: r => r.rebounds },
  assists:      { label: 'AST',     get: r => r.assists },
  threes:       { label: '3PM',     get: r => r.threes },
  steals:       { label: 'STL',     get: r => r.steals },
  blocks:       { label: 'BLK',     get: r => r.blocks },
  turnovers:    { label: 'TOV',     get: r => r.turnovers },
  pra:          { label: 'PRA',     get: r => r.points + r.rebounds + r.assists, combo: true },
  pr:           { label: 'PR',      get: r => r.points + r.rebounds, combo: true },
  pa:           { label: 'PA',      get: r => r.points + r.assists, combo: true },
  ra:           { label: 'RA',      get: r => r.rebounds + r.assists, combo: true },
  blocksSteals: { label: 'BLK+STL', get: r => r.blocks + r.steals, combo: true },
};
const DVP_STATS = { pts: r => r.points, reb: r => r.rebounds, ast: r => r.assists, tpm: r => r.threes, stl: r => r.steals, blk: r => r.blocks, to: r => r.turnovers };
const DVP_KEYS = Object.keys(DVP_STATS);
const GROUPS = ['G', 'F', 'C'];

// -- data ------------------------------------------------------------------------
const db = new DatabaseSync(path.resolve(__dirname, '..', '..', 'data', 'beatsedge.db'), { readOnly: true });
const lo = Math.min(...SEASONS) - 1;
const all = db.prepare(`SELECT game_id, athlete_id, season, game_date, team, opponent, pos_group, minutes, points, rebounds, assists, threes, steals, blocks, turnovers
  FROM nba_player_box WHERE season_type = 2 AND played = 1 AND minutes > 0 AND season >= ? AND pos_group IN ('G','F','C') AND points IS NOT NULL AND rebounds IS NOT NULL AND assists IS NOT NULL
  AND threes IS NOT NULL AND steals IS NOT NULL AND blocks IS NOT NULL AND turnovers IS NOT NULL ORDER BY game_date, game_id`).all(lo);
const fingerprint = { rows: all.length, from: all[0].game_date, to: all[all.length - 1].game_date, sumPts: all.reduce((s, r) => s + r.points, 0) };
console.log('data', JSON.stringify(fingerprint));

// per-player chronological history
const byPlayer = new Map();
all.forEach(r => { let a = byPlayer.get(r.athlete_id); if (!a) byPlayer.set(r.athlete_id, a = []); a.push(r); });

// -- as-of DvP snapshots ------------------------------------------------------
// cum[season][team] = { games:Set, cell: {G:{pts,reb,..}, F:..., C:...} } built date by date.
function buildDvpSnapshots() {
  const bySeasonDate = new Map();            // season -> Map(date -> rows)
  all.forEach(r => { let s = bySeasonDate.get(r.season); if (!s) bySeasonDate.set(r.season, s = new Map()); let d = s.get(r.game_date); if (!d) s.set(r.game_date, d = []); d.push(r); });
  const snaps = new Map();                   // `${season}|${date}` -> { team: { G: {rank150 per stat key + allowed}, ... } } | null
  for (const [season, dates] of bySeasonDate) {
    const teams = new Map();                 // defending team -> { games:Set, cells:{G:{pts..}} }
    const ensure = (t) => { let o = teams.get(t); if (!o) { o = { games: new Set(), cells: {} }; GROUPS.forEach(g => { o.cells[g] = {}; DVP_KEYS.forEach(k => o.cells[g][k] = 0); }); teams.set(t, o); } return o; };
    for (const date of [...dates.keys()].sort()) {
      // snapshot BEFORE adding this date's games (strictly as-of)
      const eligible = [...teams.entries()].filter(([, o]) => o.games.size >= MIN_TEAM_GAMES);
      let snap = null;
      if (eligible.length >= 20) {
        const cells = [];
        eligible.forEach(([t, o]) => GROUPS.forEach(g => { const rec = { t, g }; DVP_KEYS.forEach(k => rec[k] = o.cells[g][k] / o.games.size); cells.push(rec); }));
        const n = cells.length;
        DVP_KEYS.forEach(k => { const sorted = cells.slice().sort((a, b) => a[k] - b[k] || (a.t + a.g < b.t + b.g ? -1 : 1)); sorted.forEach((c, i) => { c['r_' + k] = n > 1 ? 1 + i * 149 / (n - 1) : 75.5; }); });
        snap = {};
        cells.forEach(c => { (snap[c.t] = snap[c.t] || {})[c.g] = c; });
      }
      snaps.set(season + '|' + date, snap);
      // then add games
      dates.get(date).forEach(r => {
        const def = ensure(r.opponent);       // the defending team is the player's opponent
        def.games.add(r.game_id);
        DVP_KEYS.forEach(k => { def.cells[r.pos_group][k] += DVP_STATS[k](r); });
      });
    }
  }
  return snaps;
}
const SNAPS = buildDvpSnapshots();
function oppDefenseFor(season, date, oppTeam) {
  const snap = SNAPS.get(season + '|' + date); if (!snap || !snap[oppTeam]) return null;
  const byPosition = {};
  GROUPS.forEach(g => { const c = snap[oppTeam][g]; if (!c) return; byPosition[g] = { rank: Math.round(c.r_pts), rebRank: Math.round(c.r_reb), astRank: Math.round(c.r_ast), tpmRank: Math.round(c.r_tpm), stlRank: Math.round(c.r_stl), blkRank: Math.round(c.r_blk), toRank: Math.round(c.r_to),
    pointsAllowed: +c.pts.toFixed(1), reboundsAllowed: +c.reb.toFixed(1), assistsAllowed: +c.ast.toFixed(1), threesAllowed: +c.tpm.toFixed(1), stealsAllowed: +c.stl.toFixed(1), blocksAllowed: +c.blk.toFixed(1), turnoversAllowed: +c.to.toFixed(1) }; });
  return Object.keys(byPosition).length === 3 ? { byPosition } : null;
}

// -- samples (as-of eligibility only; never conditioned on the target outcome) -------
function sampleRows() {
  const out = [];
  for (const season of SEASONS) {
    const elig = [];
    for (const [pid, rows] of byPlayer) {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]; if (r.season !== season || i < MIN_PRIOR_GAMES) continue;
        const prior = rows.slice(Math.max(0, i - HIST_N), i);
        const m10 = prior.slice(-10); if (m10.reduce((s, x) => s + x.minutes, 0) / m10.length < MIN_AVG_MIN) continue;
        if (!oppDefenseFor(season, r.game_date, r.opponent)) continue;       // need defense info present so A/B/C are comparable
        elig.push({ pid, i });
      }
    }
    for (let k = elig.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [elig[k], elig[j]] = [elig[j], elig[k]]; }
    const take = elig.slice(0, PER_SEASON);
    console.log(`season ${season}: eligible ${elig.length}, sampled ${take.length}`);
    take.forEach(e => out.push({ season, rows: byPlayer.get(e.pid), i: e.i }));
  }
  return out;
}

// -- evaluation ------------------------------------------------------------------
const mean = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const clip = (p) => Math.min(0.999, Math.max(0.001, p));
function pseudoLine(hv) { const avg = mean(hv); let line = null, best = 99; for (let c = 0.5; c <= avg * 2.2 + 1; c += 1) { const over = hv.filter(v => v > c).length / hv.length; const gap = Math.abs(over - 0.48); if (gap < best) { best = gap; line = c; } } return line; }

const samples = sampleRows();
const acc = {};      // statKey -> { recs: [] }
Object.keys(STATS).forEach(k => acc[k] = []);
let done = 0; const t0 = Date.now();
for (const s of samples) {
  const r = s.rows[s.i], prior = s.rows.slice(Math.max(0, s.i - HIST_N), s.i);
  const od = oppDefenseFor(s.season, r.game_date, r.opponent);
  const opps = prior.map(x => x.opponent);
  for (const [statKey, def] of Object.entries(STATS)) {
    const hv = prior.map(def.get), actual = def.get(r);
    if (mean(hv) <= 0) continue;
    const line = pseudoLine(hv); if (line == null || line <= 0 || actual === line) continue;
    const w = mA.btWindowsAsOf(hv, opps, r.opponent, line);
    const mk = (model, defense) => model.calculateEdgeScore({ id: 'h', sport: 'nba', position: r.pos_group, opponent: r.opponent, statsByKey: { [statKey]: w }, opponentDefense: defense, oppDef: null, situational: null, props: [] },
      { statKey, type: statKey, line, direction: 'over', lineSource: 'backtest' });
    const eA = mk(mA, od), eB = mk(mB, od), eC = mk(mA, null);
    if (eA.insufficientData || eC.insufficientData) continue;
    acc[statKey].push({ season: s.season, date: r.game_date, actual, line, hit: actual > line ? 1 : 0,
      pA: eA.projection, pB: eB.projection, pC: eC.projection, sAvg: w.season.avg, l10: w.last10.avg,
      probA: eA.modelProbPct / 100, probB: eB.modelProbPct / 100, probC: eC.modelProbPct / 100,
      rk: { rank: od.byPosition[r.pos_group].rank, rebRank: od.byPosition[r.pos_group].rebRank, astRank: od.byPosition[r.pos_group].astRank, tpmRank: od.byPosition[r.pos_group].tpmRank, stlRank: od.byPosition[r.pos_group].stlRank, blkRank: od.byPosition[r.pos_group].blkRank, toRank: od.byPosition[r.pos_group].toRank } });
  }
  if (++done % 5000 === 0) console.log(`  ${done}/${samples.length} player-games (${Math.round((Date.now() - t0) / 1000)}s)`);
}

const RANK_FIELD = { points: 'rank', pra: 'rank', pr: 'rank', pa: 'rank', rebounds: 'rebRank', ra: 'rebRank', assists: 'astRank', threes: 'tpmRank', blocks: 'blkRank', blocksSteals: 'blkRank', steals: 'stlRank', turnovers: 'toRank' };

function metrics(recs, key) {
  const err = recs.map(r => r[key] - r.actual);
  return { n: recs.length, mae: mean(err.map(Math.abs)), rmse: Math.sqrt(mean(err.map(e => e * e))), bias: mean(err) };
}
function dirAcc(recs, key) { return mean(recs.map(r => ((r[key] > r.line) === (r.actual > r.line)) ? 1 : 0)); }
function probMetrics(recs, key) {
  const p = recs.map(r => clip(r[key])); const y = recs.map(r => r.hit);
  const brier = mean(p.map((v, i) => (v - y[i]) ** 2)), ll = mean(p.map((v, i) => -(y[i] ? Math.log(v) : Math.log(1 - v))));
  // calibration: 10 equal-width buckets, ECE
  const bk = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  p.forEach((v, i) => { const b = bk[Math.min(9, Math.floor(v * 10))]; b.n++; b.p += v; b.y += y[i]; });
  const ece = bk.reduce((s, b) => s + (b.n ? (b.n / p.length) * Math.abs(b.p / b.n - b.y / b.n) : 0), 0);
  // calibration slope/intercept via logistic regression of y on logit(p) (Newton, 25 iters)
  const x = p.map(v => Math.log(v / (1 - v))); let a = 0, b = 1;
  for (let it = 0; it < 25; it++) { let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0; for (let i = 0; i < x.length; i++) { const q = 1 / (1 + Math.exp(-(a + b * x[i]))); const w = q * (1 - q); g0 += y[i] - q; g1 += (y[i] - q) * x[i]; h00 += w; h01 += w * x[i]; h11 += w * x[i] * x[i]; } const det = h00 * h11 - h01 * h01; if (Math.abs(det) < 1e-12) break; a += (h11 * g0 - h01 * g1) / det; b += (-h01 * g0 + h00 * g1) / det; }
  return { brier, logLoss: ll, ece, calSlope: b, calIntercept: a, meanProb: mean(p), actualOverRate: mean(y), sharpnessSD: Math.sqrt(mean(p.map(v => (v - mean(p)) ** 2))) };
}
// date-block bootstrap of a paired per-record difference d(rec)
function bootDiff(recs, fn) {
  const byDate = new Map(); recs.forEach(r => { let o = byDate.get(r.date); if (!o) byDate.set(r.date, o = { s: 0, n: 0 }); o.s += fn(r); o.n++; });
  const blocks = [...byDate.values()], N = recs.length, tot = blocks.reduce((s, b) => s + b.s, 0);
  const est = tot / N, r2 = rng(SEED ^ 0x9e3779b1), samples = [];
  for (let b = 0; b < BOOT; b++) { let s = 0, n = 0; for (let k = 0; k < blocks.length; k++) { const bl = blocks[Math.floor(r2() * blocks.length)]; s += bl.s; n += bl.n; } samples.push(s / n); }
  samples.sort((a, c) => a - c);
  return { est, lo: samples[Math.floor(0.025 * BOOT)], hi: samples[Math.floor(0.975 * BOOT)] };
}
function slopeBoot(recs, xf, yf) {
  const byDate = new Map(); recs.forEach(r => { let o = byDate.get(r.date); if (!o) byDate.set(r.date, o = []); o.push(r); });
  const blocks = [...byDate.values()];
  const slope = (rs) => { let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0; rs.forEach(r => { const x = xf(r), y = yf(r); n++; sx += x; sy += y; sxx += x * x; sxy += x * y; }); const den = n * sxx - sx * sx; return den ? (n * sxy - sx * sy) / den : NaN; };
  const est = slope(recs), r2 = rng(SEED ^ 0x85ebca6b), ss = [];
  for (let b = 0; b < BOOT; b++) { const rs = []; for (let k = 0; k < blocks.length; k++) rs.push(...blocks[Math.floor(r2() * blocks.length)]); ss.push(slope(rs)); }
  ss.sort((a, c) => a - c); return { est, lo: ss[Math.floor(0.025 * BOOT)], hi: ss[Math.floor(0.975 * BOOT)] };
}

const results = { meta: { generated: new Date().toISOString(), seasons: SEASONS, perSeasonRequested: PER_SEASON, seed: SEED, bootstrap: BOOT, fingerprint, limits: 'PLAYER-STAT PREDICTION VALIDATION ONLY. Pseudo-line (backtestSeries convention), NOT a sportsbook line. DvP reconstructed from box scores (team x G/F/C, as-of), approximating -- not equal to -- the app NBA_DVP_CSV.' }, stats: {} };
for (const [statKey, def] of Object.entries(STATS)) {
  const recs = acc[statKey]; if (!recs.length) continue;
  const rf = RANK_FIELD[statKey];
  const R = { label: def.label, combo: !!def.combo, n: recs.length, rankField: rf, seasons: {} };
  ['pA', 'pB', 'pC', 'sAvg', 'l10'].forEach(k => R[k] = Object.assign(metrics(recs, k), { dirAcc: dirAcc(recs, k) }));
  ['probA', 'probB', 'probC'].forEach(k => R[k] = probMetrics(recs, k));
  const absd = (x, y) => (r) => Math.abs(r[x] - r.actual) - Math.abs(r[y] - r.actual);
  const sqd = (x, y) => (r) => (r[x] - r.actual) ** 2 - (r[y] - r.actual) ** 2;
  R.diff = {
    'A-C_absErr': bootDiff(recs, absd('pA', 'pC')), 'B-C_absErr': bootDiff(recs, absd('pB', 'pC')), 'A-B_absErr': bootDiff(recs, absd('pA', 'pB')),
    'A-C_sqErr': bootDiff(recs, sqd('pA', 'pC')), 'B-C_sqErr': bootDiff(recs, sqd('pB', 'pC')),
    'A-C_brier': bootDiff(recs, (r) => (clip(r.probA) - r.hit) ** 2 - (clip(r.probC) - r.hit) ** 2), 'B-C_brier': bootDiff(recs, (r) => (clip(r.probB) - r.hit) ** 2 - (clip(r.probC) - r.hit) ** 2),
    'A-C_dirCorrect': bootDiff(recs, (r) => (((r.pA > r.line) === (r.hit === 1)) ? 1 : 0) - (((r.pC > r.line) === (r.hit === 1)) ? 1 : 0)),
  };
  // does defense rank explain residuals of the NO-defense projection? slope per rank point (stat-units / rank), vs the production nudge
  R.residualVsRank = { slopePerRankPoint: slopeBoot(recs, r => r.rk[rf], r => r.actual - r.pC), productionGenericSlopePerRankPoint: 0.12 };
  R.residualVsPtsRank = { slopePerRankPoint: slopeBoot(recs, r => r.rk.rank, r => r.actual - r.pC) };
  for (const season of SEASONS) {
    const sr = recs.filter(r => r.season === season); if (sr.length < 200) continue;
    R.seasons[season] = { n: sr.length, maeA: metrics(sr, 'pA').mae, maeB: metrics(sr, 'pB').mae, maeC: metrics(sr, 'pC').mae,
      dAC: mean(sr.map(absd('pA', 'pC'))), dBC: mean(sr.map(absd('pB', 'pC'))), brierA: probMetrics(sr, 'probA').brier, brierC: probMetrics(sr, 'probC').brier };
  }
  results.stats[statKey] = R;
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));

// markdown report
const f = (x, d = 3) => (x == null || Number.isNaN(x)) ? '--' : x.toFixed(d);
const ci = (o, d = 3) => `${f(o.est, d)} [${f(o.lo, d)}, ${f(o.hi, d)}]`;
const verdict = (o) => (o.hi < 0 ? 'IMPROVES' : o.lo > 0 ? 'DEGRADES' : 'no detectable difference');
let md = `# NBA defense-feature validation (PLAYER-STAT PREDICTION ONLY)\n\n> Not sportsbook edge/EV validation. No historical sportsbook lines exist locally. "Line" below is the app's own **synthetic** pseudo-line (trailing over-rate ~0.48). DvP is reconstructed from box scores as-of each date (approximation of the app's embedded table).\n\n`;
md += `Data: nba_player_box regular season, seasons ${SEASONS.join(', ')}, ${fingerprint.rows.toLocaleString()} rows loaded (${fingerprint.from} -> ${fingerprint.to}); up to ${PER_SEASON} as-of-eligible player-games per season (avg last-10 minutes >= ${MIN_AVG_MIN}, >= ${MIN_PRIOR_GAMES} prior games, defense info present). Seed ${SEED}; date-block bootstrap x${BOOT}.\n\n`;
md += `Variants: **A** current production (generic points-rank nudge + stat-specific) · **B** stat-specific only · **C** no defense. Differences are paired (A-C etc.); **negative absolute-error difference = the first variant is better**.\n\n`;
md += `## Projection error (lower is better)\n\n| Stat | N | MAE A | MAE B | MAE C | MAE season-avg | MAE L10 | A-C ΔMAE [95% CI] | verdict | B-C ΔMAE [95% CI] | verdict |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const [k, R] of Object.entries(results.stats)) md += `| ${R.label}${R.combo ? ' (combo)' : ''} | ${R.n} | ${f(R.pA.mae)} | ${f(R.pB.mae)} | ${f(R.pC.mae)} | ${f(R.sAvg.mae)} | ${f(R.l10.mae)} | ${ci(R.diff['A-C_absErr'])} | ${verdict(R.diff['A-C_absErr'])} | ${ci(R.diff['B-C_absErr'])} | ${verdict(R.diff['B-C_absErr'])} |\n`;
md += `\n## Bias (mean projection − actual) and RMSE\n\n| Stat | bias A | bias B | bias C | RMSE A | RMSE B | RMSE C | A-C ΔRMSE² [95% CI] |\n|---|---|---|---|---|---|---|---|\n`;
for (const [k, R] of Object.entries(results.stats)) md += `| ${R.label} | ${f(R.pA.bias)} | ${f(R.pB.bias)} | ${f(R.pC.bias)} | ${f(R.pA.rmse)} | ${f(R.pB.rmse)} | ${f(R.pC.rmse)} | ${ci(R.diff['A-C_sqErr'])} |\n`;
md += `\n## Directional accuracy vs the synthetic pseudo-line, and probability quality\n\n| Stat | dir A | dir B | dir C | A-C Δdir [95% CI] | Brier A | Brier B | Brier C | A-C ΔBrier [95% CI] | cal slope A | cal slope C | ECE A | ECE C |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const [k, R] of Object.entries(results.stats)) md += `| ${R.label} | ${f(R.pA.dirAcc)} | ${f(R.pB.dirAcc)} | ${f(R.pC.dirAcc)} | ${ci(R.diff['A-C_dirCorrect'])} | ${f(R.probA.brier, 4)} | ${f(R.probB.brier, 4)} | ${f(R.probC.brier, 4)} | ${ci(R.diff['A-C_brier'], 4)} | ${f(R.probA.calSlope, 2)} | ${f(R.probC.calSlope, 2)} | ${f(R.probA.ece, 3)} | ${f(R.probC.ece, 3)} |\n`;
md += `\n## Does defense rank explain what the no-defense projection misses?\n\nResidual (actual − C projection) regressed on the opponent's rank (1 = toughest … 150 = softest) for the stat's own rank field. The production **generic** nudge adds **+0.12 stat-units per rank point to every prop**; the table shows what the data supports.\n\n| Stat | rank field | slope per rank point [95% CI] | production generic slope | residual slope on points-rank [95% CI] |\n|---|---|---|---|---|\n`;
for (const [k, R] of Object.entries(results.stats)) md += `| ${R.label} | ${R.rankField} | ${ci(R.residualVsRank.slopePerRankPoint, 4)} | +0.1200 | ${ci(R.residualVsPtsRank.slopePerRankPoint, 4)} |\n`;
md += `\n## Stability by season (mean absolute-error difference vs C; negative = better than no-defense)\n\n| Stat | ${SEASONS.map(s => s + ' A-C').join(' | ')} | ${SEASONS.map(s => s + ' B-C').join(' | ')} |\n|---|${SEASONS.map(() => '---|').join('')}${SEASONS.map(() => '---|').join('')}\n`;
for (const [k, R] of Object.entries(results.stats)) md += `| ${R.label} | ${SEASONS.map(s => R.seasons[s] ? f(R.seasons[s].dAC) : '--').join(' | ')} | ${SEASONS.map(s => R.seasons[s] ? f(R.seasons[s].dBC) : '--').join(' | ')} |\n`;
fs.writeFileSync(path.join(OUT, 'report.md'), md);
console.log(md);
console.log('\nwrote', path.join(OUT, 'results.json'), 'and report.md');
