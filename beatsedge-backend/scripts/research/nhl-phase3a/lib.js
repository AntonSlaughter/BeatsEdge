// Phase 3A research library. RESEARCH ONLY -- nothing here is imported by production code.
// Seasons 2024 (TRAIN) and 2025 (VALIDATION) only, enforced by ./guard. The production formulas are imported, never re-typed.
const { q } = require('./guard');
const { shrinkageFive, poissonPOver1 } = require('../../../lib/nhlProjectionEngine');

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const dnum = s => Date.parse(s + 'T00:00:00Z');

// ---------- loaders: the SAME row populations lib/nhlProjectionEngine.js's getPlayerGames() reads ----------
async function loadSkater(col) {
  return q(`SELECT player_id pid, game_id gid, game_date d, season s, team, opponent opp, position pos, ${col} v
            FROM nhl_player_box WHERE season IN (2024,2025) AND ${col} IS NOT NULL ORDER BY player_id, game_date ASC`);
}
async function loadGoalie() { // production: saves IS NOT NULL AND shots_against > 0
  return q(`SELECT player_id pid, game_id gid, game_date d, season s, team, opponent opp, position pos, saves v
            FROM nhl_player_box WHERE season IN (2024,2025) AND saves IS NOT NULL AND shots_against > 0 ORDER BY player_id, game_date ASC`);
}
async function loadTeamGames() { // team shots-for / saves DERIVED FROM PLAYER ROWS (the live nightly sync writes no nhl_team_box)
  return q(`SELECT game_id gid, team, opponent opp, game_date d, season s, SUM(shots_on_goal) sf, SUM(saves) sv
            FROM nhl_player_box WHERE season IN (2024,2025) GROUP BY game_id, team, opponent, game_date, season`);
}
function groupBy(rows, key) { const m = new Map(); for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); } return m; }

// ---------- team / league context, STRICTLY AS-OF the target game ----------
// For a target game on date D: only team-games with game_date < D (and, for a team's own history, only that team's earlier games).
function buildTeamCtx(teamGames) {
  const byGame = groupBy(teamGames, 'gid'); const sa = new Map();
  for (const [, rs] of byGame) if (rs.length === 2) { sa.set(rs[0].gid + '|' + rs[0].team, rs[1].sf); sa.set(rs[1].gid + '|' + rs[1].team, rs[0].sf); }
  const games = teamGames.filter(r => sa.has(r.gid + '|' + r.team) && r.sf != null).map(r => ({ ...r, sa: sa.get(r.gid + '|' + r.team), t: dnum(r.d) }));
  const dates = [...new Set(games.map(g => g.d))].sort(); const byDate = groupBy(games, 'd');
  const leagueBefore = new Map(); let sum = 0, cnt = 0;
  for (const d of dates) { leagueBefore.set(d, cnt >= 200 ? sum / cnt : null); for (const g of byDate.get(d)) { sum += g.sf; cnt++; } }
  const ctx = new Map();
  for (const [team, tg] of groupBy(games, 'team')) {
    tg.sort((a, b) => a.t - b.t);
    for (let j = 0; j < tg.length; j++) {
      const prior = tg.slice(0, j); const n = prior.length;
      ctx.set(tg[j].gid + '|' + team, {
        n,
        sf15: n >= 10 ? mean(prior.slice(-15).map(x => x.sf)) : null,   // shots-for, last <=15 prior team games
        sa15: n >= 10 ? mean(prior.slice(-15).map(x => x.sa)) : null,   // shots-against, last <=15 prior team games
        sv10: n >= 10 ? mean(prior.slice(-10).filter(x => x.sv != null).map(x => x.sv)) : null, // team saves, last 10 prior team games
      });
    }
  }
  return { ctx, leagueBefore };
}

// ---------- league priors, as-of (all player-games strictly before the date) ----------
// kind 'pos': separate mean for F and D skaters; kind 'all': one mean (goalies).
function buildPrior(rows, kind, minRows) {
  const byDate = groupBy(rows, 'd'); const dates = [...byDate.keys()].sort();
  const cum = new Map(); const acc = { F: { s: 0, n: 0 }, D: { s: 0, n: 0 }, A: { s: 0, n: 0 } };
  const posKey = r => kind === 'all' ? 'A' : (r.pos === 'D' ? 'D' : 'F');
  for (const d of dates) {
    cum.set(d, { F: acc.F.n >= minRows ? acc.F.s / acc.F.n : null, D: acc.D.n >= minRows ? acc.D.s / acc.D.n : null, A: acc.A.n >= minRows ? acc.A.s / acc.A.n : null });
    for (const r of byDate.get(d)) { const k = posKey(r); acc[k].s += r.v; acc[k].n++; }
  }
  return (row) => { const c = cum.get(row.d); return c ? c[posKey(row)] : null; };
}

// ---------- evaluation iteration: every (player, game i) with >= minPrior prior games, in the given season(s) ----------
function* evals(byPlayer, minPrior, seasons) {
  for (const [, games] of byPlayer) {
    const vals = games.map(g => g.v);
    for (let i = minPrior; i < games.length; i++) {
      if (!seasons.includes(games[i].s)) continue;
      yield { row: games[i], prior: vals.slice(0, i), n: i, i };
    }
  }
}

// ---------- statistics ----------
function quant(sorted, qq) { return sorted[Math.min(sorted.length - 1, Math.floor(qq * sorted.length))]; }
function clusterSE(diffs, dates) { // mean of paired differences with SE clustered by game date
  const N = diffs.length, m = mean(diffs), by = new Map();
  for (let i = 0; i < N; i++) { const c = by.get(dates[i]) || { s: 0, n: 0 }; c.s += diffs[i]; c.n++; by.set(dates[i], c); }
  const T = by.size; let ss = 0; for (const [, c] of by) ss += (c.s - m * c.n) ** 2;
  return { mean: m, se: Math.sqrt((T / Math.max(1, T - 1)) * ss) / N, T };
}
function ece(ps, ys, bins = 10) {
  const B = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  ps.forEach((p, i) => { const k = Math.min(bins - 1, Math.floor(p * bins)); B[k].n++; B[k].p += p; B[k].y += ys[i]; });
  let e = 0; for (const b of B) if (b.n) e += (b.n / ps.length) * Math.abs(b.p / b.n - b.y / b.n);
  return { ece: e, bins: B.map((b, i) => b.n ? { bin: `${(i / bins).toFixed(1)}-${((i + 1) / bins).toFixed(1)}`, n: b.n, pred: +(b.p / b.n).toFixed(4), act: +(b.y / b.n).toFixed(4) } : null).filter(Boolean) };
}
function pointMetrics(preds, ys) {
  const errs = ys.map((y, i) => y - preds[i]); const ab = errs.map(Math.abs).sort((a, b) => a - b), se = [...errs].sort((a, b) => a - b);
  const idx = preds.map((p, i) => i).sort((a, b) => preds[a] - preds[b]); const nb = 5, buckets = [];
  for (let b = 0; b < nb; b++) { const sl = idx.slice(Math.floor(b * idx.length / nb), Math.floor((b + 1) * idx.length / nb)); buckets.push({ bucket: `Q${b + 1}`, n: sl.length, meanPred: +mean(sl.map(i => preds[i])).toFixed(3), meanActual: +mean(sl.map(i => ys[i])).toFixed(3), MAE: +mean(sl.map(i => Math.abs(ys[i] - preds[i]))).toFixed(3) }); }
  return { n: preds.length, MAE: +mean(ab).toFixed(4), RMSE: +Math.sqrt(mean(errs.map(x => x * x))).toFixed(4), bias_actual_minus_pred: +mean(errs).toFixed(4),
    share_overprojected: +(errs.filter(e => e < 0).length / errs.length).toFixed(3), err_P10: +quant(se, 0.1).toFixed(2), err_P50: +quant(se, 0.5).toFixed(2), err_P90: +quant(se, 0.9).toFixed(2), absErr_P90: +quant(ab, 0.9).toFixed(2),
    within_1: +(ab.filter(x => x <= 1).length / ab.length).toFixed(3), within_2: +(ab.filter(x => x <= 2).length / ab.length).toFixed(3), mean_pred: +mean(preds).toFixed(3), mean_actual: +mean(ys).toFixed(3), calibration_by_projection_quintile: buckets };
}
function binaryMetrics(ps, ys, refRate) {
  const brier = mean(ps.map((p, i) => (p - ys[i]) ** 2)); const brierConst = mean(ys.map(y => (refRate - y) ** 2));
  const ll = mean(ps.map((p, i) => -(ys[i] * Math.log(Math.max(1e-9, p)) + (1 - ys[i]) * Math.log(Math.max(1e-9, 1 - p)))));
  const E = ece(ps, ys); const tail = (f) => { const x = ps.map((p, i) => [p, ys[i]]).filter(f); return x.length ? { n: x.length, pred: +mean(x.map(a => a[0])).toFixed(3), act: +mean(x.map(a => a[1])).toFixed(3) } : null; };
  return { n: ps.length, base_rate: +mean(ys).toFixed(4), mean_pred: +mean(ps).toFixed(4), mean_gap: +(mean(ps) - mean(ys)).toFixed(4), Brier: +brier.toFixed(5), Brier_const_prior_rate: +brierConst.toFixed(5), Brier_skill_vs_const: +(1 - brier / brierConst).toFixed(4),
    LogLoss: +ll.toFixed(4), ECE10: +E.ece.toFixed(4), calibration_by_probability_decile: E.bins, tail_p_ge_0p40: tail(x => x[0] >= 0.4), tail_p_lt_0p10: tail(x => x[0] < 0.1) };
}

module.exports = { mean, groupBy, shrinkageFive, poissonPOver1, loadSkater, loadGoalie, loadTeamGames, buildTeamCtx, buildPrior, evals, quant, clusterSE, ece, pointMetrics, binaryMetrics };
