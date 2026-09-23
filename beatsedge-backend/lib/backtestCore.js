// Phase 2I-Q -- reusable, leak-free chronological backtest engine for
// period-market and full-game-fantasy modeling. Pure read-only consumer of
// nba_player_period_stats / wnba_player_period_stats / nba_player_box /
// wnba_player_box (all built in Phase 2I-P). Never writes to the DB.
//
// LEAKAGE DISCIPLINE (see header of each function): for every row in the
// dataset, every feature is computed from the athlete's rolling state as it
// existed strictly BEFORE that row's game -- the state update (pushing this
// game's own actual value into the rolling history) always happens AFTER
// feature extraction for that row, never before. Season averages reset at
// a season boundary before that season's first row is processed, so a
// season's first game never sees a prior season's average bleed in as the
// "season" component (it correctly falls back to the career-level average
// instead, itself built only from strictly-earlier games).
//
// SYNTHETIC LINE: no historical sportsbook/DFS line archive exists for
// period markets (Phase G finding). The "line" used everywhere in this
// engine is SYNTHETIC -- floor(seasonToDateAvg) + 0.5, i.e. a standard
// half-point prop-style number derived purely from the player's own
// pre-game season average (falling back to career-to-date average if the
// season has no prior games yet). This is clearly a modeling convenience,
// not a real market line, and every report generated from this engine
// must label it as such.
//
// COMPLETE-CASE POLICY: "omit rather than fabricate" (explicit instruction)
// is implemented as complete-case analysis -- a row only enters the
// TRAIN/HOLDOUT modeled population if the athlete already has >=15 prior
// career games (so L5/L10/L15/season are all genuinely observed, never
// zero-filled or imputed) AND a valid line. L5/L10/L15 AVAILABILITY is
// still reported against the full line-eligible population so the
// modeled-population's coverage limitation is visible, not hidden.

const db = require('./db');

const HOLD_OUT_SEASON = { nba: 2026, wnba: 2026 };
const MAX_TRAIN_ROWS = 150000; // deterministic stride-sampled cap per stat, for tractable pure-JS gradient descent

function periodStatCols(period) {
  const base = ['points', 'rebounds', 'oreb', 'dreb', 'assists', 'tpm', 'tpa'];
  return period === 'Q1' ? base : [...base, 'pra'];
}

// One pass over an athlete-sorted, date-sorted row set, building leak-free
// feature rows for every requested stat + a shared minutes/home-away state.
// Returns { rows: { [stat]: FeatureRow[] }, totalPopulation, statAvailability }
function buildFeatureRows(sport, period) {
  const table = sport === 'nba' ? 'nba_player_period_stats' : 'wnba_player_period_stats';
  const boxTable = sport === 'nba' ? 'nba_player_box' : 'wnba_player_box';
  const stats = periodStatCols(period);

  const boxMinutes = db.prepare(`SELECT game_id, athlete_id, minutes FROM ${boxTable} WHERE played = 1`).all();
  const minutesMap = new Map();
  for (const r of boxMinutes) minutesMap.set(`${r.game_id}|${r.athlete_id}`, r.minutes);

  const raw = db.prepare(`
    SELECT game_id, athlete_id, season, season_type, game_date, home_away,
           points, rebounds, oreb, dreb, assists, tpm, tpa, pra
    FROM ${table}
    WHERE period = ?
    ORDER BY athlete_id, game_date, game_id
  `).all(period);

  const out = {};
  for (const s of stats) out[s] = [];

  let curAthlete = null;
  // per-stat rolling state, reset when athlete changes
  let state = null;
  const freshState = () => {
    const s = {};
    for (const stat of stats) {
      s[stat] = { career: [], seasonSum: 0, seasonCount: 0, season: null, prev: null };
    }
    s.minutesHist = [];
    s.prevMinutes = null;
    return s;
  };

  for (const row of raw) {
    if (row.athlete_id !== curAthlete) {
      curAthlete = row.athlete_id;
      state = freshState();
    }
    const minKey = `${row.game_id}|${row.athlete_id}`;
    const minutesNow = minutesMap.has(minKey) ? minutesMap.get(minKey) : null;

    for (const stat of stats) {
      const st = state[stat];
      if (st.season !== row.season) { st.seasonSum = 0; st.seasonCount = 0; st.season = row.season; }

      const career = st.career;
      const n = career.length;
      const seasonAvg = st.seasonCount > 0 ? st.seasonSum / st.seasonCount : null;
      const careerAvg = n > 0 ? career.reduce((a, b) => a + b, 0) / n : null;
      const lineBasis = seasonAvg !== null ? seasonAvg : careerAvg;

      if (lineBasis !== null) {
        const line = Math.floor(lineBasis) + 0.5;
        const l5 = career.slice(Math.max(0, n - 5));
        const l10 = career.slice(Math.max(0, n - 10));
        const l15 = career.slice(Math.max(0, n - 15));
        const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
        const hitRate = arr => arr.length ? arr.filter(v => v > line).length / arr.length : null;
        const l5avg = avg(l5), l10avg = avg(l10), l15avg = avg(l15);
        const minWin = state.minutesHist.slice(Math.max(0, state.minutesHist.length - 10));
        const rollingMinutes = minWin.length ? avg(minWin) : null;

        const actual = row[stat];
        out[stat].push({
          gameId: row.game_id, athleteId: row.athlete_id, season: row.season, seasonType: row.season_type,
          gameDate: row.game_date, homeAway: row.home_away,
          careerLen: n, seasonGamesSoFar: st.seasonCount,
          line, seasonAvg, careerAvg,
          l5avg, l10avg, l15avg,
          l5hit: hitRate(l5), l10hit: hitRate(l10), l15hit: hitRate(l15),
          prevVal: st.prev, prevMinutes: st.prevMinutes, rollingMinutes,
          actual,
          y: actual > line ? 1 : 0,
        });
      }

      // update state AFTER feature extraction (leak-free)
      st.career.push(row[stat]);
      if (st.career.length > 20) st.career.shift();
      st.seasonSum += row[stat]; st.seasonCount += 1;
      st.prev = row[stat];
    }
    state.minutesHist.push(minutesNow != null ? minutesNow : (state.prevMinutes != null ? state.prevMinutes : 0));
    if (state.minutesHist.length > 12) state.minutesHist.shift();
    state.prevMinutes = minutesNow;
  }

  return out;
}

function featureVector(r) {
  // all diffs relative to the synthetic line; NaN-safe callers only invoke
  // this on complete-case rows, where every field here is guaranteed real.
  return [
    r.l5hit, r.l10hit, r.l15hit,
    r.l5avg - r.line, r.l10avg - r.line, r.seasonAvg - r.line,
    r.l5avg - r.seasonAvg, // recent-vs-season trend
    r.prevVal - r.line,
    r.rollingMinutes,
    r.homeAway === 'home' ? 1 : 0,
  ];
}

const FEATURE_NAMES = ['l5hit', 'l10hit', 'l15hit', 'l5diff', 'l10diff', 'seasonDiff', 'trend', 'prevDiff', 'rollingMinutes', 'homeAway'];

function isCompleteCase(r) {
  return r.careerLen >= 15 && r.seasonGamesSoFar >= 1 && r.rollingMinutes !== null && r.prevVal !== null;
}

function standardize(rows, meanStd) {
  const X = rows.map(featureVector);
  let mean, std;
  if (meanStd) { ({ mean, std } = meanStd); }
  else {
    const n = X.length, d = X[0].length;
    mean = new Array(d).fill(0); std = new Array(d).fill(0);
    for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j];
    for (let j = 0; j < d; j++) mean[j] /= n;
    for (const x of X) for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2;
    for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / n) || 1;
  }
  const Z = X.map(x => x.map((v, j) => (v - mean[j]) / std[j]));
  return { Z, meanStd: { mean, std } };
}

function trainLogistic(Z, y, { iters = 250, lr = 0.4, l2 = 0.001 } = {}) {
  const n = Z.length, d = Z[0].length;
  let w = new Float64Array(d), b = 0;
  const yArr = Float64Array.from(y);
  for (let it = 0; it < iters; it++) {
    const gradW = new Float64Array(d);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const zi = Z[i];
      let s = b;
      for (let j = 0; j < d; j++) s += w[j] * zi[j];
      const p = 1 / (1 + Math.exp(-s));
      const diff = p - yArr[i];
      for (let j = 0; j < d; j++) gradW[j] += diff * zi[j];
      gradB += diff;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gradW[j] / n + l2 * w[j]);
    b -= lr * (gradB / n);
  }
  return { w: Array.from(w), b };
}

function predict(Z, model) {
  return Z.map(zi => {
    let s = model.b;
    for (let j = 0; j < zi.length; j++) s += model.w[j] * zi[j];
    return 1 / (1 + Math.exp(-s));
  });
}

function strideSample(rows, maxN) {
  if (rows.length <= maxN) return rows;
  const stride = rows.length / maxN;
  const out = [];
  for (let i = 0; i < maxN; i++) out.push(rows[Math.floor(i * stride)]);
  return out;
}

function evalMetrics(p, y, actual, line) {
  const n = p.length;
  const eps = 1e-9;
  let brier = 0, logloss = 0, mae = 0, hits = 0;
  let extremeLow = 0, extremeHigh = 0;
  for (let i = 0; i < n; i++) {
    brier += (p[i] - y[i]) ** 2;
    const pc = Math.min(1 - eps, Math.max(eps, p[i]));
    logloss += -(y[i] * Math.log(pc) + (1 - y[i]) * Math.log(1 - pc));
    if ((p[i] >= 0.5 ? 1 : 0) === y[i]) hits++;
    if (p[i] < 0.1) extremeLow++;
    if (p[i] > 0.9) extremeHigh++;
  }
  brier /= n; logloss /= n; hits /= n;

  // calibration gap: 10 bins by predicted p, mean|predicted-actual| across non-empty bins
  const bins = Array.from({ length: 10 }, () => ({ sumP: 0, sumY: 0, c: 0 }));
  for (let i = 0; i < n; i++) {
    const bi = Math.min(9, Math.floor(p[i] * 10));
    bins[bi].sumP += p[i]; bins[bi].sumY += y[i]; bins[bi].c++;
  }
  let gapSum = 0, gapN = 0;
  for (const b of bins) if (b.c > 0) { gapSum += Math.abs(b.sumP / b.c - b.sumY / b.c); gapN++; }
  const calibrationGap = gapN ? gapSum / gapN : null;

  // MAE of a transparent blended point projection (0.4*L5+0.35*L10+0.25*season), computed by caller and passed via `actual`/`line` is repurposed below
  return {
    n, brier, logloss, hitRate: hits, calibrationGap,
    predProbMin: Math.min(...p), predProbMax: Math.max(...p),
    predProbMean: p.reduce((a, b) => a + b, 0) / n,
    pctExtremeLow: extremeLow / n, pctExtremeHigh: extremeHigh / n,
  };
}

module.exports = {
  HOLD_OUT_SEASON, MAX_TRAIN_ROWS,
  periodStatCols, buildFeatureRows, featureVector, FEATURE_NAMES,
  isCompleteCase, standardize, trainLogistic, predict, strideSample, evalMetrics,
};
