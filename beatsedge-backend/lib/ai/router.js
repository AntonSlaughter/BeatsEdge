'use strict';
// Deterministic question router. Lightweight keyword classifier + an "answerability" gate that fails closed. No LLM involved.
const C = require('./constants');
const RULES = [   // ORDER MATTERS: more specific / reserved intents first
  ['SITE_STATUS', /(missing (lines?|props?|players?)|incomplete|truncat|feed|provider (is )?(down|error)|site (status|health)|outage|stale|isn'?t .{0,30}showing|not showing|why (isn'?t|is(n'?t)?|aren'?t) .{0,40}(here|showing|listed|loaded)|are we missing)/i],
  ['RESULT_ANALYSIS', /(why did (it|this|he|they|that) (win|lose|hit|miss|cash|fail)|did (it|this|that) (hit|win|lose|cash)|post-?game|settled|final result|what happened (in|to|with))/i],
  ['WHAT_CHANGED', /(what changed|line (move|moved|movement)|changed since|moved since|any update|what'?s new)/i],
  ['EXPLAIN_PRIME', /\bprime\b/i],
  ['EXPLAIN_GRADE', /\b[Gg]rade\b|why (is it|is this|was it) (an? )?[ABCD]\b(?![a-z])/],   // case-sensitive on purpose: the article "a" is not a grade letter
  ['EXPLAIN_PROBABILITY', /probab|\bchance\b|how likely|percent|\d+\s*%/i],
  ['EXPLAIN_EDGE', /\bedge\b|projection|projected|project(s)?\b/i],
  ['BIGGEST_RISK', /(biggest|main|top)?\s*(risk|worr|downside|what could (go wrong|hurt)|concern|danger)/i],
  ['OPPOSING_FACTORS', /(against|oppos|negative|red flags?|\bcons\b|working against|bad (factors|signs?))/i],
  ['WHY_BAD', /(why .{0,30}(bad|weak|avoid|pass on|risky|poor)|bad play|should i (avoid|pass)|not a good)/i],
  ['WHY_GOOD', /(why .{0,30}(good|strong|best|solid|great|top|worth)|good play|top pick|worth (it|playing)|why (is|was) (this|it) (a )?(play|pick))/i],
  ['WHY_UNDER', /why .{0,30}\bunder\b|\bunder\b.{0,20}\bwhy\b|take the under|go under/i],
  ['WHY_OVER', /why .{0,30}\bover\b|\bover\b.{0,20}\bwhy\b|take the over|go over/i],
  ['SUPPORTING_FACTORS', /(supporting|support(s|ing)?\b|positive|green (flags?|factors?)|\bpros\b|reasons?)/i],
  ['EXPLAIN_PLAY_SIMPLE', /(explain|in simple|plain (english|terms)|eli5|break (it )?down|walk me through|summar)/i]
];
const needsModel = new Set(['WHY_GOOD', 'WHY_BAD', 'WHY_OVER', 'WHY_UNDER', 'BIGGEST_RISK', 'SUPPORTING_FACTORS', 'OPPOSING_FACTORS', 'EXPLAIN_GRADE', 'EXPLAIN_PROBABILITY', 'EXPLAIN_EDGE', 'EXPLAIN_PRIME']);
const SECTIONS = { WHY_GOOD: ['PLAY', 'MODEL', 'SUPPORTING_EVIDENCE', 'RISK_OPPOSING_EVIDENCE', 'HISTORY'], WHY_BAD: ['PLAY', 'MODEL', 'RISK_OPPOSING_EVIDENCE', 'SUPPORTING_EVIDENCE'], WHY_OVER: ['PLAY', 'MODEL', 'SUPPORTING_EVIDENCE', 'RISK_OPPOSING_EVIDENCE'], WHY_UNDER: ['PLAY', 'MODEL', 'SUPPORTING_EVIDENCE', 'RISK_OPPOSING_EVIDENCE'],
  BIGGEST_RISK: ['PLAY', 'MODEL', 'RISK_OPPOSING_EVIDENCE', 'UNAVAILABLE_DATA'], SUPPORTING_FACTORS: ['PLAY', 'SUPPORTING_EVIDENCE'], OPPOSING_FACTORS: ['PLAY', 'RISK_OPPOSING_EVIDENCE'], EXPLAIN_GRADE: ['PLAY', 'MODEL', 'SUPPORTING_EVIDENCE', 'RISK_OPPOSING_EVIDENCE'],
  EXPLAIN_PROBABILITY: ['PLAY', 'MODEL', 'HISTORY'], EXPLAIN_EDGE: ['PLAY', 'MODEL', 'HISTORY'], EXPLAIN_PRIME: ['PLAY', 'MODEL', 'SUPPORTING_EVIDENCE'], EXPLAIN_PLAY_SIMPLE: ['PLAY', 'MODEL', 'SUPPORTING_EVIDENCE', 'RISK_OPPOSING_EVIDENCE', 'UNAVAILABLE_DATA'],
  WHAT_CHANGED: ['PLAY', 'OTHER_FACTS'], RESULT_ANALYSIS: ['PLAY', 'MODEL'], UNKNOWN: ['PLAY', 'MODEL'] };

function classifyQuestion(question) {
  const q = String(question == null ? '' : question).trim(); if (!q) return { intent: 'UNKNOWN', matched: null, reason: 'empty question' };
  for (const [intent, re] of RULES) if (re.test(q)) return { intent, matched: re.source.slice(0, 40), reason: null };
  return { intent: 'UNKNOWN', matched: null, reason: 'no rule matched' };
}

// routeQuestion: classify + decide whether the question can be answered from the evidence that really exists. Fails closed.
function routeQuestion(ctx, question, opts) {
  opts = opts || {}; const c = classifyQuestion(question); const intent = c.intent; const out = { intent, sections: SECTIONS[intent] || SECTIONS.UNKNOWN, status: 'READY', refusal: null, notes: [] };
  if (intent === 'SITE_STATUS') { out.status = 'RESERVED'; out.refusal = 'Site and feed completeness answers are not available yet: the completeness telemetry is not connected. BeatsEdge will not guess whether any feed is incomplete.'; out.sections = []; out.telemetryContract = 'beatsedge-site-telemetry/1'; return out; }
  if (intent === 'RESULT_ANALYSIS') { out.status = 'RESERVED'; out.refusal = 'Settled-play analysis needs recorded post-game evidence (minutes, usage, injuries, closing line). None is attached, so no cause can be stated.'; out.sections = []; out.settledContract = 'beatsedge-settled-play/1'; return out; }
  if (!ctx) { out.status = 'NO_CONTEXT'; out.refusal = 'No play is selected, so there is no BeatsEdge evidence to explain.'; out.sections = []; return out; }
  const state = ctx.model.state, hasOutputs = ctx.model.hasOutputs === true;
  if (needsModel.has(intent) && !hasOutputs) { out.status = 'NO_MODEL_EVIDENCE'; out.refusal = `This play is ${state}: BeatsEdge has no validated projection, probability, edge, grade or Prime for it, so there is no model case to explain. Only the provider line is available.`; out.sections = ['PLAY', 'MODEL', 'UNAVAILABLE_DATA']; return out; }
  if ((intent === 'EXPLAIN_GRADE' || intent === 'EXPLAIN_PRIME') && hasOutputs) {
    if (intent === 'EXPLAIN_GRADE' && ctx.model.grade == null) { out.status = 'NO_MODEL_EVIDENCE'; out.refusal = 'This is a probability-only market: it has no letter grade by design.'; out.sections = ['PLAY', 'MODEL']; return out; }
    if (intent === 'EXPLAIN_PRIME' && ctx.model.prime !== true) { out.notes.push('Prime is not set for this play; explain only that it is not Prime.'); }
  }
  if (intent === 'WHY_OVER' && ctx.play.direction === 'under') out.notes.push('The selected play is the UNDER; do not argue the over.');
  if (intent === 'WHY_UNDER' && ctx.play.direction === 'over') out.notes.push('The selected play is the OVER; do not argue the under.');
  if (intent === 'WHAT_CHANGED' && !ctx.play.provider.movement) { out.notes.push('No line movement is attached to this prop; state that movement data is unavailable.'); }
  if (intent === 'UNKNOWN') out.notes.push('Intent not recognized: answer only from the evidence below and say what is not available.');
  return out;
}
module.exports = { classifyQuestion, routeQuestion, SECTIONS };
