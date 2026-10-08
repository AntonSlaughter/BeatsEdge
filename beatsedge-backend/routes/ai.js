'use strict';
// AI backend routes (Phase 3A) -- BACKEND ONLY, no UI yet.
//   POST /api/ai/explain-prop    { question, selection }  explain ONE selected prop from validated, client-reported engine evidence (+ site telemetry + recorded results)
//   POST /api/ai/site-question   { question, selection? } read-only site intelligence from client-reported telemetry
//   GET  /api/ai/status          whether an AI provider is configured (name only; never a key / env value)
// With no provider configured every answer is the deterministic evidence. AI credentials live in the SERVER environment (see lib/aiService/providers.js); no endpoint ever returns them.
// Kill switch: BEATSEDGE_AI_DISABLED=1 stops every provider call (deterministic evidence only). Optional hardening: BEATSEDGE_AI_TOKEN (Bearer, for private callers), BEATSEDGE_AI_ALLOWED_ORIGINS (comma list; browsers from other origins are refused when a provider is configured).
const express = require('express'); const service = require('../lib/aiService/service'); const providers = require('../lib/aiService/providers');

function createAiRouter(opts) {
  opts = opts || {}; const router = express.Router(); const env = opts.env || process.env; const store = opts.store; const limiter = opts.limiter || providers.createLimiter({ perMinute: 12, perDay: Number(env.BEATSEDGE_AI_DAILY_LIMIT) || 500 });
  const recordedQuery = opts.recordedQuery !== undefined ? opts.recordedQuery : (async (sql, params) => require('../lib/snapshotStore').query(sql, params));
  const getStatus = () => (store ? store.status() : { ok: true, freshness: 'NO_DATA', sports: {} });
  const hits = new Map(); const RATE = 40;   // cheap per-client cap on the DETERMINISTIC path as well (it still validates and sanitizes input)
  const gate = (req, res, next) => {
    const t = Date.now(); const id = String(req.ip || (req.socket && req.socket.remoteAddress) || 'anon'); const e = hits.get(id) || { s: t, n: 0 }; if (t - e.s > 60000) { e.s = t; e.n = 0; } e.n++; hits.set(id, e); if (hits.size > 500) for (const [k, v] of hits) if (t - v.s > 60000) hits.delete(k); if (e.n > RATE) return res.status(429).json({ ok: false, status: 'RATE_LIMITED' });
    if (env.BEATSEDGE_AI_TOKEN && String(req.headers.authorization || '') !== 'Bearer ' + env.BEATSEDGE_AI_TOKEN) return res.status(401).json({ ok: false, status: 'UNAUTHORIZED' });
    const allowed = String(env.BEATSEDGE_AI_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean); const origin = req.headers.origin;
    if (allowed.length && origin && allowed.indexOf(origin) < 0) return res.status(403).json({ ok: false, status: 'ORIGIN_NOT_ALLOWED' });
    req.aiClientId = id; next(); };
  const run = (fn) => async (req, res) => { try { const out = await fn({ body: req.body, env, status: getStatus(), recordedQuery, limiter, clientId: req.aiClientId }); const { http, ...body } = out; res.set('Cache-Control', 'no-store'); res.status(http || 200).json(body); } catch (e) { res.status(500).json({ ok: false, status: 'ERROR', error: 'internal error' }); } };
  router.post('/ai/explain-prop', gate, run(service.explainProp));
  router.post('/ai/site-question', gate, run(service.askSite));
  router.get('/ai/status', (req, res) => { const p = providers.loadConfiguredProvider(env); res.set('Cache-Control', 'no-store'); res.json({ ok: true, aiProviderConfigured: p.configured, provider: p.configured ? p.name : null, mode: p.disabled ? 'DISABLED_BY_OPERATOR' : (p.configured ? 'PROVIDER_WITH_GUARDRAILS' : 'DETERMINISTIC_EVIDENCE_ONLY'), note: 'Credentials are server-side only and are never returned.' }); });
  router.limiter = limiter; return router;
}
// Body-parser failures (malformed JSON / oversize body) happen in the app-level express.json BEFORE any route; without this the default handler would return an HTML page with a stack trace.
function jsonErrorHandler(err, req, res, next) { if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large' || err.status === 400 || err.status === 413)) { const big = err.status === 413 || err.type === 'entity.too.large'; return res.status(big ? 413 : 400).json({ ok: false, status: big ? 'PAYLOAD_TOO_LARGE' : 'MALFORMED_JSON' }); } return next(err); }
module.exports = { createAiRouter, jsonErrorHandler };
