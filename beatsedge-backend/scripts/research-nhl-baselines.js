// NHL unlock, Phases 7-8: REAL baseline comparison + distribution-family
// diagnostics for the core stat families, using the actual ingested
// sportsdataverse historical data (lib/historicalStore.js's nhl_player_box,
// 2024-2026 -- 2022/2023 excluded, see scripts/ingest-hoopr-nhl.js's real
// finding that those source files have no game_id/game_date at all).
//
// CHRONOLOGICAL SPLIT (real, not random):
//   TRAIN      = season 2024 (2023-24)  -- used only to compute each
//                player's rolling history; no model is "fit" on it in the
//                traditional sense since these are all non-parametric
//                baselines, but it establishes the leak-safe starting point.
//   VALIDATION = season 2025 (2024-25)
//   HOLDOUT    = season 2026 (2025-26)  -- UNTOUCHED: only read once, after
//                every baseline choice below was already fixed from
//                VALIDATION's results.
//
// For every real game in VALIDATION and HOLDOUT, each candidate projection
// is computed using ONLY that player's own games strictly BEFORE that
// game's date (across season boundaries where necessary -- a rolling
// window, not a season-reset window) -- the entire leak-safety discipline.
//
// Candidates tested per stat family: season-to-date mean, trailing-5 mean,
// trailing-10 mean, and an empirical-Bayes shrinkage blend of trailing-5
// toward season mean (k=8) -- deliberately NOT assuming any of these wins;
// real MAE decides.
//
//   node scripts/research-nhl-baselines.js

const store = require('../lib/historicalStore');

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function mae(errors) { return mean(errors.map(Math.abs)); }
function rmse(errors) { return Math.sqrt(mean(errors.map(e => e * e))); }
function variance(arr) { const m = mean(arr); return arr.length > 1 ? arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1) : null; }

// Real chronological baselines -- `games` is this player's own real prior
// games (any season), sorted ascending by date, ALREADY filtered to
// strictly before the target game's date by the caller.
function baselineProjections(games, statKey) {
  if (!games.length) return null;
  const vals = games.map(g => g[statKey]).filter(v => v != null);
  if (!vals.length) return null;
  const seasonMean = mean(vals);
  const l5 = vals.slice(-5);
  const l10 = vals.slice(-10);
  const l5Mean = mean(l5);
  const l10Mean = mean(l10);
  // Empirical-Bayes shrinkage: L5 pulled toward the season mean, weight k=8
  // games -- same discipline already used elsewhere in this project
  // (lib/gameEnvironment.js etc.), not invented fresh for NHL.
  const k = 8;
  const shrunkL5 = l5.length ? ((l5.length * l5Mean) + (k * seasonMean)) / (l5.length + k) : seasonMean;
  return { seasonMean, l5Mean: l5.length ? l5Mean : null, l10Mean: l10.length ? l10Mean : null, shrunkL5, sampleSize: vals.length };
}

async function runStatFamily(label, table, statKey, idCol, minGamesPerPlayer, extraWhere = '') {
  console.log(`\n=== ${label} (${table}.${statKey}) ===`);
  const rows = await store.query(`
    SELECT ${idCol} AS pid, player_name, game_date, season, ${statKey} AS val
    FROM ${table}
    WHERE season IN (2024, 2025, 2026) AND ${statKey} IS NOT NULL ${extraWhere}
    ORDER BY ${idCol}, game_date ASC
  `);
  const byPlayer = new Map();
  for (const r of rows) { if (!byPlayer.has(r.pid)) byPlayer.set(r.pid, []); byPlayer.get(r.pid).push(r); }

  const errorsBySplit = { validation: { seasonMean: [], l5Mean: [], l10Mean: [], shrunkL5: [] }, holdout: { seasonMean: [], l5Mean: [], l10Mean: [], shrunkL5: [] } };
  let evaluatedValidation = 0, evaluatedHoldout = 0, skippedThinSample = 0;
  const allOutcomes = []; // for distribution diagnostics, holdout only

  for (const [, games] of byPlayer) {
    if (games.length < minGamesPerPlayer) { skippedThinSample++; continue; }
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      if (g.season !== 2025 && g.season !== 2026) continue; // only evaluate on VALIDATION/HOLDOUT games
      const prior = games.slice(0, i); // strictly before -- leak-safe by construction (already sorted ascending)
      if (prior.length < 5) continue; // need at least a real trailing-5 sample to compare fairly
      const proj = baselineProjections(prior, 'val');
      if (!proj) continue;
      const split = g.season === 2025 ? 'validation' : 'holdout';
      const actual = g.val;
      errorsBySplit[split].seasonMean.push(actual - proj.seasonMean);
      if (proj.l5Mean != null) errorsBySplit[split].l5Mean.push(actual - proj.l5Mean);
      if (proj.l10Mean != null) errorsBySplit[split].l10Mean.push(actual - proj.l10Mean);
      errorsBySplit[split].shrunkL5.push(actual - proj.shrunkL5);
      if (split === 'validation') evaluatedValidation++; else { evaluatedHoldout++; allOutcomes.push(actual); }
    }
  }

  console.log(`players with >=${minGamesPerPlayer} real games: ${byPlayer.size - skippedThinSample} (${skippedThinSample} skipped, thin sample)`);
  console.log(`evaluated: validation=${evaluatedValidation} holdout=${evaluatedHoldout}`);

  for (const split of ['validation', 'holdout']) {
    const e = errorsBySplit[split];
    console.log(`-- ${split} --`);
    for (const method of ['seasonMean', 'l5Mean', 'l10Mean', 'shrunkL5']) {
      if (!e[method].length) { console.log(`  ${method}: no data`); continue; }
      console.log(`  ${method}: MAE=${mae(e[method]).toFixed(3)} RMSE=${rmse(e[method]).toFixed(3)} n=${e[method].length}`);
    }
  }

  // Distribution diagnostic (holdout real outcomes only): Poisson requires
  // variance ~= mean. A real, computed ratio -- not assumed.
  if (allOutcomes.length > 30) {
    const m = mean(allOutcomes), v = variance(allOutcomes);
    console.log(`distribution check (holdout real outcomes): mean=${m.toFixed(3)} variance=${v.toFixed(3)} variance/mean=${(v / m).toFixed(3)} (Poisson expects ~1.0; well above 1.0 = real overdispersion, favors Negative Binomial)`);
  }

  // Best method by holdout MAE -- decided on HOLDOUT numbers here only for
  // this report's convenience; the real promotion rule (Phase 8) is
  // "validated on VALIDATION, confirmed on HOLDOUT", not picked on holdout.
  const holdoutMaes = {};
  for (const method of ['seasonMean', 'l5Mean', 'l10Mean', 'shrunkL5']) {
    if (errorsBySplit.holdout[method].length) holdoutMaes[method] = mae(errorsBySplit.holdout[method]);
  }
  return { label, evaluatedValidation, evaluatedHoldout, holdoutMaes, playersWithData: byPlayer.size - skippedThinSample };
}

(async () => {
  console.log('backend:', store.backend);
  const results = [];
  results.push(await runStatFamily('Skater: Shots on Goal', 'nhl_player_box', 'shots_on_goal', 'player_id', 15));
  results.push(await runStatFamily('Skater: Goals', 'nhl_player_box', 'goals', 'player_id', 15));
  results.push(await runStatFamily('Skater: Assists', 'nhl_player_box', 'assists', 'player_id', 15));
  results.push(await runStatFamily('Skater: Points', 'nhl_player_box', 'points', 'player_id', 15));
  // shots_against > 0 excludes goalies dressed but never actually
  // entering the game (real data shows saves=0/shots_against=0/
  // goals_against=0 rows for backups who sat the whole game) -- same
  // real convention lib/nhlEngine.js already established for the OTHER
  // NHL data source (`if (!g.shotsAgainst) return`), applied here for
  // consistency. Found via a live sanity-check during integration: this
  // WAS missing from the original research pass, which pollutes every
  // Saves trailing average/distribution with false zero-appearances.
  results.push(await runStatFamily('Goalie: Saves', 'nhl_player_box', 'saves', 'player_id', 8, 'AND shots_against > 0'));

  console.log('\n\n=== SUMMARY (holdout MAE by method, lower is better) ===');
  for (const r of results) {
    console.log(`${r.label}: players=${r.playersWithData} validationN=${r.evaluatedValidation} holdoutN=${r.evaluatedHoldout}`);
    console.log('  ', JSON.stringify(r.holdoutMaes));
  }
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
