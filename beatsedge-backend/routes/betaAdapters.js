// BETA adapter routes (probability-only, flag-gated, read-only). Mounted in server.js; INACTIVE until the environment flag of an adapter is exactly "1": with the flag off every route answers { enabled: false, results: [] } and touches no data.
//   POST /api/nhl/beta/blocked-shots   flag BETA_NHL_BLOCKED_SHOTS   body { asOfDate?, offerings: [ { ref, playerId, asOfDate, bookmaker, market_key, market, period, line, odds_type, projection_type, available_sides, over_price, under_price, is_dfs_flat_payout, event_id, groupLines } ] }
//   POST /api/nhl/beta/plus-minus      flag BETA_NHL_PLUS_MINUS       same body (lib/betaAdapters/nhlCountsService.js)
//   POST /api/nhl/beta/hits            flag BETA_NHL_HITS             same body (lib/betaAdapters/nhlCountsService.js)
// The player id must be the one the page's existing fail-closed resolver produced; the server never resolves a player from a name. See each service for exactly what is produced and what is withheld.
const express = require('express');

// opts: { env, store, adapter, serviceModule, countsModule } -- everything injectable so the route can be exercised against a throw-away database and a mutated copy without any environment-controlled module loading.
function createBetaRouter(opts = {}) {
  const router = express.Router(); const env = opts.env || process.env; let service = null; const mod = () => opts.serviceModule || require('../lib/betaAdapters/nhlBlocksService');
  const svc = () => { if (!service) service = mod().createService({ store: opts.store || require('../lib/historicalStore'), adapter: opts.adapter }); return service; };
  router.post('/nhl/beta/blocked-shots', async (req, res) => {
    try {
      if (!mod().isEnabled(env)) return res.json({ enabled: false, results: [] });
      const out = await svc().evaluate(req.body, env); res.status(out.status).json(out.body);
    } catch (e) { res.status(500).json({ error: 'beta blocked-shots evaluation failed', detail: String(e && e.message || e).slice(0, 200) }); }
  });
  // plus/minus and hits: one shared service, one flag each
  const counts = () => opts.countsModule || require('../lib/betaAdapters/nhlCountsService'); const countsSvc = {};
  const countsRoute = (familyId, urlPath) => router.post(urlPath, async (req, res) => {
    try {
      const m = counts(), family = m.FAMILIES[familyId]; if (!m.isEnabled(family, env)) return res.json({ enabled: false, results: [] });
      if (!countsSvc[familyId]) countsSvc[familyId] = m.createService({ store: opts.store || require('../lib/historicalStore'), family, adapter: opts.countsAdapters && opts.countsAdapters[familyId] });
      const out = await countsSvc[familyId].evaluate(req.body, env); res.status(out.status).json(out.body);
    } catch (e) { res.status(500).json({ error: 'beta ' + familyId + ' evaluation failed', detail: String(e && e.message || e).slice(0, 200) }); }
  });
  countsRoute('plus_minus', '/nhl/beta/plus-minus'); countsRoute('hits', '/nhl/beta/hits');
  return router;
}
module.exports = { createBetaRouter };
