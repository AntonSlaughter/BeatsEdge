// NHL unlock: volatility / projection-stability research. Tests whether a
// player's own trailing coefficient of variation (CV = stdev/mean) is
// real, useful evidence for a "Projection Stability" trust display --
// i.e., do HIGH-CV players actually produce bigger real projection
// errors than LOW-CV players? If not, the feature is not honest to ship.
//
//   node --env-file=.env scripts/research-nhl-volatility.js

const store = require('../lib/historicalStore');
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

async function run(label, sql, minPrior) {
  const rows = await store.query(sql);
  const byEntity = new Map();
  for (const r of rows) { if (!byEntity.has(r.eid)) byEntity.set(r.eid, []); byEntity.get(r.eid).push(r); }

  const tiers = { low: [], mid: [], high: [] };
  for (const [, games] of byEntity) {
    if (games.length < minPrior + 5) continue;
    for (let i = minPrior; i < games.length; i++) {
      const g = games[i];
      if (g.season !== 2025 && g.season !== 2026) continue;
      const prior = games.slice(0, i).map(p => p.val).filter(v => v != null);
      if (prior.length < minPrior) continue;
      const window = prior.slice(-10);
      const m = mean(window), sd = stdev(window);
      if (!m || m <= 0 || sd == null) continue;
      const cv = sd / m;
      const shrunkMu = ((prior.slice(-5).reduce((s, x) => s + x, 0)) + 8 * mean(prior)) / (Math.min(5, prior.length) + 8);
      const absErr = Math.abs(g.val - shrunkMu);
      const tier = cv < 0.4 ? 'low' : (cv < 0.8 ? 'mid' : 'high');
      tiers[tier].push(absErr);
    }
  }
  console.log(`\n=== ${label}: volatility tier -> real MAE ===`);
  for (const t of ['low', 'mid', 'high']) {
    console.log(`  ${t}-CV: n=${tiers[t].length}  MAE=${tiers[t].length ? mean(tiers[t]).toFixed(4) : 'n/a'}`);
  }
}

(async () => {
  console.log('backend:', store.backend);
  await run('Shots on Goal', `SELECT player_id AS eid, game_date, season, shots_on_goal AS val FROM nhl_player_box WHERE season IN (2024,2025,2026) AND shots_on_goal IS NOT NULL ORDER BY player_id, game_date ASC`, 10);
  // shots_against > 0 excludes goalies dressed but never actually entering the game -- see research-nhl-baselines.js's identical fix.
  await run('Goalie Saves', `SELECT player_id AS eid, game_date, season, saves AS val FROM nhl_player_box WHERE season IN (2024,2025,2026) AND saves IS NOT NULL AND shots_against > 0 ORDER BY player_id, game_date ASC`, 8);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
