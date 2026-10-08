// Site / provider completeness status routes (2026-10-08). Kept in their own router (no DB, no provider call) and mounted under /api in server.js.
//   POST /api/site-telemetry  -- the browser reports a beatsedge-site-telemetry/1 object (validated + sanitized + rate limited, see lib/siteTelemetry.js)
//   GET  /api/site-status     -- latest report per sport with freshness + per-source completeness, plus the merged contract object
// If BEATSEDGE_STATUS_TOKEN is set, GET additionally requires `Authorization: Bearer <token>` (for a private dashboard); POST is never token-gated because a browser cannot
// hold a secret, and it accepts only whitelisted aggregate counters. Neither route reads, echoes or stores any provider key, URL or configuration.
const express = require('express');
const { createStore } = require('../lib/siteTelemetry');

function createSiteStatusRouter(opts) {
  opts = opts || {}; const router = express.Router(); const store = opts.store || createStore();
  const tokenOk = (req) => { const want = opts.statusToken !== undefined ? opts.statusToken : process.env.BEATSEDGE_STATUS_TOKEN; if (!want) return true; const h = String(req.headers.authorization || ''); return h === 'Bearer ' + want; };
  router.post('/site-telemetry', (req, res) => { const r = store.ingest(req.body, req.ip || (req.socket && req.socket.remoteAddress)); const { status, ...body } = r; res.status(status).json(body); });
  router.get('/site-status', (req, res) => { if (!tokenOk(req)) return res.status(401).json({ ok: false, error: 'unauthorized' }); res.set('Cache-Control', 'no-store'); res.json(store.status()); });
  router.store = store; return router;
}
module.exports = { createSiteStatusRouter };
