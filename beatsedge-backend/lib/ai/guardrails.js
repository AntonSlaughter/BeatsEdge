'use strict';
// Guardrails: the system contract any future LLM must obey + a deterministic output validator that FAILS CLOSED (a violating answer is rejected, never shown).
const C = require('./constants');
const GUARDRAIL_RULES = Object.freeze([
  'Use ONLY the BeatsEdge evidence provided. It is the source of truth.',
  'Never invent statistics, injuries, line movement, model factors, probabilities or grades.',
  'Never calculate or override projection, probability, edge, grade, Prime, confluence, provider line or model state.',
  'Factor Confluence is a count of aligned research factors. It is NOT a probability; never convert it into one or use it as one.',
  'Model Probability is the only probability. If it is unavailable, say so; do not estimate one.',
  'Never claim unsupported causation. Describe what the evidence shows, not why it happened, unless the evidence states the cause.',
  'Never present provider-only data as a validated edge. Never present NOT_YET_MODELED, INSUFFICIENT_DATA or PROVIDER_ONLY plays as modeled.',
  'A PROBABILITY_ONLY play has a probability and projection but no letter grade and no Prime; do not give it either.',
  'Historical backtests and validation are not live customer results; never present them as such.',
  'When evidence is unavailable, say it is unavailable. Do not fill gaps.',
  'No guarantees, no "locks", no betting-certainty language. This is research, not a promise.'
]);
function buildSystemContract() { return ['You explain BeatsEdge research. You are an explainer, not the model.', ...GUARDRAIL_RULES.map((r, i) => `${i + 1}. ${r}`), 'DEFINITIONS:', ...Object.entries(C.DEFINITIONS).map(([k, v]) => `${k}: ${v}`)].join('\n'); }

const NEAR = (text, idx, len, re) => re.test(text.slice(Math.max(0, idx - 45), idx + len + 45));
// validateExplanation(text, ctx) -> { ok, violations[] }. Deterministic; conservative. Numbers must come from the context; forbidden claims are pattern-checked.
function validateExplanation(text, ctx) {
  const v = []; const t = String(text == null ? '' : text); if (!t.trim()) return { ok: false, violations: [{ rule: 'EMPTY', detail: 'empty answer' }] };
  if (!ctx) return { ok: false, violations: [{ rule: 'NO_CONTEXT', detail: 'no evidence context to validate against' }] };
  const allowed = ctx.allowedNumbers || []; const near = (n) => allowed.some(a => Math.abs(a - n) <= 0.051 || Math.abs(a * 100 - n) <= 0.51 || Math.abs(a - n * 100) <= 0.51);
  const re = /(\d+(?:\.\d+)?)(\s*%)?/g; let m;
  while ((m = re.exec(t))) { const n = parseFloat(m[1]); const before = t.slice(Math.max(0, m.index - 1), m.index); if (/[A-Za-z]/.test(before)) continue; const trivial = Number.isInteger(n) && n <= 1 && !m[2]; const listMarker = /^\s*$/.test(t.slice(Math.max(0, t.lastIndexOf('\n', m.index) + 1), m.index)) && /^\.\s/.test(t.slice(m.index + m[1].length, m.index + m[1].length + 2));
    if (trivial || listMarker || near(n)) continue; v.push({ rule: 'INVENTED_NUMBER', detail: `"${m[0].trim()}" is not in the evidence` }); if (v.length > 6) break; }
  const conf = ctx.model.confluence; const confPct = conf && conf.share != null ? Math.round(conf.share * 100) : null;
  if (confPct != null) { const cre = new RegExp('\\b' + confPct + '\\s*%', 'g'); let c; while ((c = cre.exec(t))) { if (confPct !== ctx.model.probability.pct && NEAR(t, c.index, c[0].length, /(probab|chance|likel)/i)) v.push({ rule: 'CONFLUENCE_AS_PROBABILITY', detail: 'confluence share presented as a probability' }); } }
  if (/confluence[^.\n]{0,50}(probab|chance)|(probab|chance)[^.\n]{0,50}confluence/i.test(t) && !/not a probab|isn'?t a probab|not (the )?probab|no probab/i.test(t)) v.push({ rule: 'CONFLUENCE_AS_PROBABILITY', detail: 'confluence discussed as a probability' });
  if (/\b(guarantee[sd]?|lock|sure thing|can'?t lose|risk-?free|certain to)\b/i.test(t)) v.push({ rule: 'CERTAINTY_LANGUAGE', detail: 'guarantee / certainty wording' });
  const st = ctx.model.state, noOut = C.NO_MODEL_OUTPUT_STATES.indexOf(st) >= 0;
  if (noOut && /\b(BeatsEdge|the model|our model)\b[^.\n]{0,40}\b(projects?|projection|estimates?|gives?|grades?|rates?)\b/i.test(t) && !/\b(no|not|without|isn'?t|doesn'?t|unavailable|none)\b/i.test(t)) v.push({ rule: 'PRETENDS_MODELED', detail: `play is ${st} but the answer describes a model output` });
  if (noOut && /(probability|edge|projection)\s*(of|is|:|at)?\s*\+?\d/i.test(t)) v.push({ rule: 'INVENTED_MODEL_OUTPUT', detail: `play is ${st}; no model number exists` });
  if (ctx.model.grade == null && (/\bgrade\s*(of|is|:)?\s*[ABCD]\b|\bgraded\s+[ABCD]\b/i.test(t) || /\b[ABCD]\s*-?\s*grade\b/.test(t))) v.push({ rule: 'INVENTED_GRADE', detail: 'a grade is stated but none exists' });
  if (ctx.model.prime !== true && /\bprime\b/i.test(t) && !/\bnot\b[^.\n]{0,25}\bprime\b|\bprime\b[^.\n]{0,25}\b(not|no|isn'?t)\b|no prime|not prime/i.test(t)) v.push({ rule: 'INVENTED_PRIME', detail: 'Prime claimed but not set' });
  if (!ctx.play.provider.movement && /\bline\b[^.\n]{0,30}\b(moved|steamed|shifted|dropped|jumped)\b|\b(steam|sharp money|reverse line)\b/i.test(t)) v.push({ rule: 'INVENTED_LINE_MOVEMENT', detail: 'line movement claimed; none supplied' });
  const status = (ctx.play.player.status || '').toUpperCase(); if (!/OUT|DOUBT|QUESTION|INJUR|IR|DAY/.test(status) && /\b(injur(y|ed)|questionable|doubtful|ruled out|out for the game|game-time decision|limited in practice)\b/i.test(t) && !/\b(no|not|isn'?t|unavailable)\b[^.\n]{0,40}\b(injur|status)/i.test(t)) v.push({ rule: 'INVENTED_INJURY', detail: 'injury claimed; none in the evidence' });
  if (/\b(our|beatsedge'?s?)\b[^.\n]{0,30}\b(plays?|picks?|a-?grades?|prime)\b[^.\n]{0,30}\b(have|has|hit|won|cashed)\b[^.\n]{0,20}\d+\s*%/i.test(t)) v.push({ rule: 'BACKTEST_AS_LIVE', detail: 'historical validation presented as live results' });
  if (/\b(because|due to|caused by)\b[^.\n]{0,60}\b(revenge|motivation|coach(ing)? decision|trap|narrative|vibes?)\b/i.test(t)) v.push({ rule: 'UNSUPPORTED_CAUSATION', detail: 'causal claim with no evidence' });
  return { ok: v.length === 0, violations: v };
}
module.exports = { GUARDRAIL_RULES, buildSystemContract, validateExplanation };
