// NHL unlock, Part 5: formal distribution fitting + probability
// calibration for every stat family, on the same real chronological split
// (TRAIN=2024, VALIDATION=2025 for distribution selection, UNTOUCHED
// HOLDOUT=2026 reported only once for the winning distribution per family).
//
// Candidates per family, at each evaluation point, fit ONLY from that
// player's own strictly-prior real games (no leakage):
//   - Poisson(lambda = trailing shrunk mean)
//   - Negative Binomial (method-of-moments from the player's own trailing
//     mean/variance; falls back to Poisson if the sample isn't
//     overdispersed for that player)
//   - Empirical (the player's own trailing sample's order statistics --
//     no distributional assumption at all)
//
// Evaluated with pinball (quantile) loss at q in {0.1,0.25,0.5,0.75,0.9}
// -- a proper scoring rule -- plus empirical coverage (calibration) at
// each of those quantiles. There is no real historical NHL prop-line
// archive yet, so calibration is tested against quantiles of each
// player's OWN real outcome distribution, not against actual sportsbook
// lines (that gap is tracked separately as REAL-LINE VALIDATION: DATA
// GAP, and stays open regardless of this script's results).
//
//   node --env-file=.env scripts/research-nhl-distributions.js

const store = require('../lib/historicalStore');

const QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9];

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function variance(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1);
}

// Lanczos approximation for ln(Gamma(x)), x > 0.
const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = LANCZOS_C[0];
  const t = x + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_G + 2; i++) a += LANCZOS_C[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function lchoose(n, k) { return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1); }

function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda + k * Math.log(lambda) - lgamma(k + 1));
}
function poissonQuantile(q, lambda) {
  let cum = 0;
  for (let k = 0; k < 500; k++) { cum += poissonPMF(k, lambda); if (cum >= q) return k; }
  return 500;
}

// NB parameterized by mean mu and dispersion r (variance = mu + mu^2/r).
function nbPMF(k, mu, r) {
  if (mu <= 0) return k === 0 ? 1 : 0;
  const logP = lchoose(k + r - 1, k) + r * Math.log(r / (r + mu)) + k * Math.log(mu / (r + mu));
  return Math.exp(logP);
}
function nbQuantile(q, mu, r) {
  let cum = 0;
  for (let k = 0; k < 500; k++) { cum += nbPMF(k, mu, r); if (cum >= q) return k; }
  return 500;
}
function fitNB(sample) {
  const mu = mean(sample);
  const v = variance(sample);
  if (mu == null || v == null || v <= mu) return null; // not overdispersed for this player -- Poisson is the honest choice
  const r = (mu * mu) / (v - mu);
  return { mu, r };
}
function empiricalQuantile(sortedSample, q) {
  const idx = Math.min(sortedSample.length - 1, Math.floor(q * sortedSample.length));
  return sortedSample[idx];
}

function pinball(actual, forecast, q) {
  const diff = actual - forecast;
  return diff >= 0 ? q * diff : (q - 1) * diff;
}

async function runFamily(label, sql, statKey, idCol, minPrior) {
  console.log(`\n=== ${label} : distribution fitting + calibration ===`);
  const rows = await store.query(sql);
  const byEntity = new Map();
  for (const r of rows) { if (!byEntity.has(r.eid)) byEntity.set(r.eid, []); byEntity.get(r.eid).push(r); }

  const results = {
    validation: { poisson: [], nb: [], empirical: [] },
    holdout: { poisson: [], nb: [], empirical: [] },
  };
  const coverage = { poisson: {}, nb: {}, empirical: {} };
  for (const dist of Object.keys(coverage)) for (const q of QUANTILES) coverage[dist][q] = { hits: 0, total: 0 };
  let nbUsedCount = 0, nbEligibleCount = 0;

  for (const [, games] of byEntity) {
    if (games.length < minPrior + 5) continue;
    for (let i = minPrior; i < games.length; i++) {
      const g = games[i];
      if (g.season !== 2025 && g.season !== 2026) continue;
      const prior = games.slice(0, i).map(p => p.val).filter(v => v != null);
      if (prior.length < minPrior) continue;
      const actual = g.val;
      const split = g.season === 2025 ? 'validation' : 'holdout';

      const shrunkMu = ((prior.slice(-5).reduce((s, x) => s + x, 0)) + 8 * mean(prior)) / (Math.min(5, prior.length) + 8);
      const nbFit = fitNB(prior.slice(-20));
      nbEligibleCount++;
      if (nbFit) nbUsedCount++;
      const sortedPrior = [...prior].sort((a, b) => a - b);

      for (const q of QUANTILES) {
        const pF = poissonQuantile(q, shrunkMu);
        const nF = nbFit ? nbQuantile(q, nbFit.mu, nbFit.r) : pF;
        const eF = empiricalQuantile(sortedPrior, q);
        results[split].poisson.push(pinball(actual, pF, q));
        results[split].nb.push(pinball(actual, nF, q));
        results[split].empirical.push(pinball(actual, eF, q));
        coverage.poisson[q].total++; if (actual <= pF) coverage.poisson[q].hits++;
        coverage.nb[q].total++; if (actual <= nF) coverage.nb[q].hits++;
        coverage.empirical[q].total++; if (actual <= eF) coverage.empirical[q].hits++;
      }
    }
  }

  for (const split of ['validation', 'holdout']) {
    console.log(`  [${split}] avg pinball loss (lower=better), n=${results[split].poisson.length / QUANTILES.length} evals x ${QUANTILES.length}q:`);
    for (const dist of ['poisson', 'nb', 'empirical']) {
      console.log(`    ${dist}: ${mean(results[split][dist]).toFixed(4)}`);
    }
  }
  console.log(`  NB fit used (player overdispersed vs their own trailing sample) in ${nbUsedCount}/${nbEligibleCount} evals (${(100 * nbUsedCount / nbEligibleCount).toFixed(1)}%)`);
  console.log(`  Calibration (target coverage at q == empirical fraction actual<=forecast; should equal q):`);
  for (const dist of ['poisson', 'nb', 'empirical']) {
    const line = QUANTILES.map(q => `q${q}=${(coverage[dist][q].hits / coverage[dist][q].total).toFixed(3)}`).join(' ');
    console.log(`    ${dist}: ${line}`);
  }
}

// Binary-threshold calibration: for the REAL dominant market shape found
// in discovery (anytime-goal-scorer / assist / point style markets are
// P(stat >= 1), the single largest real Goals-family market group), test
// Brier score + decile calibration buckets -- more decision-relevant than
// generic quantile pinball loss for a mostly-zero count stat.
async function runBinaryThreshold(label, sql, threshold, minPrior) {
  console.log(`\n=== ${label}: P(stat >= ${threshold}) calibration (Brier + decile buckets) ===`);
  const rows = await store.query(sql);
  const byEntity = new Map();
  for (const r of rows) { if (!byEntity.has(r.eid)) byEntity.set(r.eid, []); byEntity.get(r.eid).push(r); }

  const evalsBySplit = { validation: [], holdout: [] };
  for (const [, games] of byEntity) {
    if (games.length < minPrior + 5) continue;
    for (let i = minPrior; i < games.length; i++) {
      const g = games[i];
      if (g.season !== 2025 && g.season !== 2026) continue;
      const prior = games.slice(0, i).map(p => p.val).filter(v => v != null);
      if (prior.length < minPrior) continue;
      const split = g.season === 2025 ? 'validation' : 'holdout';
      const shrunkMu = ((prior.slice(-5).reduce((s, x) => s + x, 0)) + 8 * mean(prior)) / (Math.min(5, prior.length) + 8);
      const pOver = 1 - poissonPMF(0, shrunkMu) - (threshold >= 2 ? poissonPMF(1, shrunkMu) : 0);
      const outcome = g.val >= threshold ? 1 : 0;
      evalsBySplit[split].push({ pOver, outcome });
    }
  }

  for (const split of ['validation', 'holdout']) {
    const evals = evalsBySplit[split];
    if (!evals.length) continue;
    const brier = mean(evals.map(e => (e.outcome - e.pOver) ** 2));
    console.log(`  [${split}] n=${evals.length}  Brier=${brier.toFixed(4)}  base rate=${mean(evals.map(e => e.outcome)).toFixed(3)}`);
    const buckets = Array.from({ length: 10 }, () => ({ predSum: 0, outcomeSum: 0, n: 0 }));
    for (const e of evals) {
      const b = Math.min(9, Math.floor(e.pOver * 10));
      buckets[b].predSum += e.pOver; buckets[b].outcomeSum += e.outcome; buckets[b].n++;
    }
    const bucketLine = buckets.map((b, i) => b.n ? `[${i / 10}-${(i + 1) / 10}) pred=${(b.predSum / b.n).toFixed(2)} actual=${(b.outcomeSum / b.n).toFixed(2)} n=${b.n}` : null).filter(Boolean).join(' | ');
    console.log(`    ${bucketLine}`);
  }
}

(async () => {
  console.log('backend:', store.backend);

  await runFamily(
    'Shots on Goal (MODEL CANDIDATE)',
    `SELECT player_id AS eid, game_date, season, shots_on_goal AS val FROM nhl_player_box WHERE season IN (2024,2025,2026) AND shots_on_goal IS NOT NULL ORDER BY player_id, game_date ASC`,
    'val', 'eid', 10
  );
  await runFamily(
    'Goalie Saves (MODEL CANDIDATE)',
    // shots_against > 0 excludes goalies dressed but never actually
    // entering the game -- see research-nhl-baselines.js's identical fix.
    `SELECT player_id AS eid, game_date, season, saves AS val FROM nhl_player_box WHERE season IN (2024,2025,2026) AND saves IS NOT NULL AND shots_against > 0 ORDER BY player_id, game_date ASC`,
    'val', 'eid', 8
  );
  await runFamily(
    'Goals (RESEARCH ONLY -- final verdict check)',
    `SELECT player_id AS eid, game_date, season, goals AS val FROM nhl_player_box WHERE season IN (2024,2025,2026) AND goals IS NOT NULL ORDER BY player_id, game_date ASC`,
    'val', 'eid', 15
  );
  await runFamily(
    'Assists (RESEARCH ONLY -- final verdict check)',
    `SELECT player_id AS eid, game_date, season, assists AS val FROM nhl_player_box WHERE season IN (2024,2025,2026) AND assists IS NOT NULL ORDER BY player_id, game_date ASC`,
    'val', 'eid', 15
  );
  await runFamily(
    'Points (RESEARCH ONLY -- final verdict check)',
    `SELECT player_id AS eid, game_date, season, points AS val FROM nhl_player_box WHERE season IN (2024,2025,2026) AND points IS NOT NULL ORDER BY player_id, game_date ASC`,
    'val', 'eid', 15
  );

  await runBinaryThreshold(
    'Goals (matches real "anytime goal scorer" market, ~802 real rows)',
    `SELECT player_id AS eid, game_date, season, goals AS val FROM nhl_player_box WHERE season IN (2024,2025,2026) AND goals IS NOT NULL ORDER BY player_id, game_date ASC`,
    1, 15
  );
  await runBinaryThreshold(
    'Assists (matches real "player_assists" 0.5-line market)',
    `SELECT player_id AS eid, game_date, season, assists AS val FROM nhl_player_box WHERE season IN (2024,2025,2026) AND assists IS NOT NULL ORDER BY player_id, game_date ASC`,
    1, 15
  );
  await runBinaryThreshold(
    'Points (matches real "player_points" 0.5-line market)',
    `SELECT player_id AS eid, game_date, season, points AS val FROM nhl_player_box WHERE season IN (2024,2025,2026) AND points IS NOT NULL ORDER BY player_id, game_date ASC`,
    1, 15
  );

  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
