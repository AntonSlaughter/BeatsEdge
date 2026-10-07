'use strict';
// The ONLY integration boundary with an LLM. Provider-independent: no vendor SDK, no model name, no key is referenced here.
// If no production provider is configured the pipeline STOPS here and returns the deterministic evidence (status NO_PROVIDER_CONFIGURED). It never fabricates an answer.
// SECURITY: a future provider adapter and its credentials live on the BACKEND only. This module refuses to call a provider from a browser context.
const C = require('./constants');
const { buildEvidenceSummary } = require('./evidence');
const { routeQuestion } = require('./router');
const { buildSystemContract, validateExplanation } = require('./guardrails');
const _adapters = {};
// adapter contract: { name, explain(request) -> Promise<{ text: string }> }  (registered by backend code only)
function registerProvider(adapter) { if (!adapter || typeof adapter.name !== 'string' || typeof adapter.explain !== 'function') throw new Error('adapter must be { name, explain(request) }'); _adapters[adapter.name] = adapter; }
function getConfiguredProvider(env) { const name = env && env.BEATSEDGE_AI_PROVIDER; return name && _adapters[name] ? _adapters[name] : null; }
function isBrowserContext() { return typeof window !== 'undefined' || typeof document !== 'undefined'; }
// Compact request: selected-play evidence only. Never the board, the props list, history tables or app state.
function buildLLMRequest(ctx, routed, question) {
  const ev = buildEvidenceSummary(ctx); const keep = new Set(routed.sections); const text = Object.keys(ev.sections).filter(k => keep.has(k)).map(k => k.replace(/_/g, ' ') + '\n' + ev.sections[k].map(x => '- ' + x).join('\n')).join('\n\n');
  const user = `QUESTION: ${String(question).slice(0, 300)}\n${routed.notes.length ? 'NOTES: ' + routed.notes.join(' ') + '\n' : ''}\nEVIDENCE\n${text}`;
  const system = buildSystemContract(); const approxTokens = Math.ceil((system.length + user.length) / C.COST_LIMITS.approxCharsPerToken);
  return { system, user, intent: routed.intent, approxTokens, withinBudget: approxTokens <= C.COST_LIMITS.maxRequestTokens, selectionKey: ctx.selectionKey };
}
// answerQuestion: route -> (refuse | build compact request -> provider -> validate). Every failure path is closed and explained.
async function answerQuestion(args) {
  const { ctx, question, env, siteTelemetry } = args || {}; const routed = routeQuestion(ctx, question);
  if (routed.status !== 'READY') return { status: routed.status, intent: routed.intent, text: routed.refusal, source: 'deterministic', siteTelemetryProvided: !!siteTelemetry };
  const request = buildLLMRequest(ctx, routed, question); const evidenceText = request.user;
  if (!request.withinBudget) return { status: 'REQUEST_TOO_LARGE', intent: routed.intent, text: 'The evidence for this question exceeds the request budget; nothing was sent.', approxTokens: request.approxTokens };
  const provider = getConfiguredProvider(env); if (!provider) return { status: 'NO_PROVIDER_CONFIGURED', intent: routed.intent, text: null, evidence: evidenceText, request: { approxTokens: request.approxTokens }, source: 'deterministic' };
  if (isBrowserContext()) return { status: 'BACKEND_ONLY', intent: routed.intent, text: null, evidence: evidenceText, note: 'AI providers may only be called from the backend; credentials never reach the browser.' };
  let out; try { out = await provider.explain({ system: request.system, user: request.user, intent: request.intent }); } catch (e) { return { status: 'PROVIDER_ERROR', intent: routed.intent, text: null, evidence: evidenceText, error: String(e && e.message || e).replace(/(key|token|secret)[=:]\S+/gi, '$1=[redacted]') }; }
  const verdict = validateExplanation(out && out.text, ctx); if (!verdict.ok) return { status: 'REJECTED_BY_GUARDRAILS', intent: routed.intent, text: null, violations: verdict.violations, evidence: evidenceText };
  return { status: 'OK', intent: routed.intent, text: out.text, source: provider.name, violations: [] };
}
module.exports = { registerProvider, getConfiguredProvider, buildLLMRequest, answerQuestion };
