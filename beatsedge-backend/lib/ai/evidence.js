'use strict';
// buildEvidenceSummary: DETERMINISTIC, compact, factual. Runs BEFORE any LLM. No marketing language, no recommendations, no inference.
const C = require('./constants');
const fmt = (v, suffix) => (v == null ? 'unavailable' : String(v) + (suffix || ''));
const sgn = (v) => (v == null ? 'unavailable' : (v > 0 ? '+' : '') + v);
const cap = (arr, n) => arr.slice(0, n);

function factorLines(ctx) {
  const supporting = [], opposing = [], neutral = [];
  Object.entries(ctx.research.groups).forEach(([g, grp]) => grp.items.forEach(it => { const line = `${g}: ${it.name}${it.detail ? ' - ' + it.detail : ''}`; if (it.direction === C.DIRECTIONS.SUPPORTS) supporting.push(line); else if (it.direction === C.DIRECTIONS.OPPOSES) opposing.push(line); else neutral.push(line + ' (' + (it.direction === C.DIRECTIONS.UNRATED ? 'fact, no engine direction' : 'neutral') + ')'); }));
  ctx.research.other.forEach(it => { const line = `OTHER: ${it.name}${it.detail ? ' - ' + it.detail : ''}`; if (it.direction === C.DIRECTIONS.SUPPORTS) supporting.push(line); else if (it.direction === C.DIRECTIONS.OPPOSES) opposing.push(line); else neutral.push(line); });
  return { supporting, opposing, neutral };
}

function buildEvidenceSummary(ctx) {
  const L = C.COST_LIMITS, p = ctx.play, m = ctx.model, state = m.state; const f = factorLines(ctx); const sections = {};
  sections.PLAY = [`Player: ${fmt(p.player.name)} (${fmt(p.player.team)}, ${fmt(p.player.position)})`, `Sport: ${fmt(p.sport)}`, `Opponent: ${fmt(p.opponent)}`, `Stat: ${fmt(p.stat.label || p.stat.key)}`, `Direction: ${p.direction}`,
    `Provider: ${fmt(p.provider.book)} - line ${fmt(p.provider.line)} (${p.provider.lineType.value}${p.provider.lineType.providerLabel ? ', provider label ' + p.provider.lineType.providerLabel : ''})`].concat(p.provider.movement ? [`Line movement: ${fmt(p.provider.movement.from)} -> ${fmt(p.provider.movement.to)} (open ${fmt(p.provider.movement.open)})`] : []);
  const modelLines = [`Model state: ${state}${m.status ? ' (' + m.status + (m.version ? ', ' + m.version : '') + ')' : ''}`];
  if (m.hasOutputs) {
    modelLines.push(`Projection: ${fmt(m.projection)}`, `Model Edge (direction-adjusted): ${sgn(m.edge)}`, `Model Probability: ${fmt(m.probability.pct, '%')}`, `Grade: ${m.grade || (state === C.MODEL_STATES.PROBABILITY_ONLY ? 'none (probability-only market)' : 'unavailable')}`, `Prime: ${m.prime === true ? 'yes' : m.prime === false ? 'no' : 'not applicable'}`,
      `Factor Confluence: ${m.confluence.total != null ? m.confluence.supporting + ' of ' + m.confluence.total + ' available factors support the direction (a count of aligned factors, not a probability)' : 'unavailable'}`);
    if (m.thinData) modelLines.push('Data note: thin sample for this play');
  } else modelLines.push('Projection: none', 'Model Edge: none', 'Model Probability: none', 'Grade: none', 'Prime: none', `Reason: ${m.stateReason || 'No validated BeatsEdge model output exists for this play; only the provider line is shown.'}`);
  sections.MODEL = modelLines;
  const modeled = m.hasOutputs === true;
  sections.SUPPORTING_EVIDENCE = modeled ? (f.supporting.length ? cap(f.supporting, L.maxFactorsPerSide) : ['No available factor supports the selected direction.']) : ['Not applicable: no model factors were evaluated.'];
  sections.RISK_OPPOSING_EVIDENCE = modeled ? (f.opposing.length ? cap(f.opposing, L.maxFactorsPerSide) : ['No available factor opposes the selected direction.']).concat(m.thinData ? ['Thin sample for this play.'] : []) : ['Not applicable: no model factors were evaluated.'];
  sections.OTHER_FACTS = cap(f.neutral, L.maxListItems).concat(ctx.research.contextOnly.length ? cap(ctx.research.contextOnly, 4).map(c => `CONTEXT ONLY (not in projection, probability or grade): ${c.name}${c.detail ? ' - ' + c.detail : ''}`) : []);
  const hr = ctx.history.hitRates.windows, hist = []; if (hr) Object.entries(hr).forEach(([k, v]) => { if (v) hist.push(`Hit rate ${k}: ${v.pickPct}% over ${fmt(v.games)} games`); }); const w = ctx.history.windows; if (w) Object.entries(w).forEach(([k, v]) => { if (v) hist.push(`Average ${k}: ${v.avg} over ${fmt(v.games)} games`); });
  sections.HISTORY = hist.length ? cap(hist, L.maxListItems) : ['unavailable'];
  sections.UNAVAILABLE_DATA = cap(ctx.unavailable.map(u => `${u.field}: ${u.reason}`), L.maxListItems);
  const order = ['PLAY', 'MODEL', 'SUPPORTING_EVIDENCE', 'RISK_OPPOSING_EVIDENCE', 'OTHER_FACTS', 'HISTORY', 'UNAVAILABLE_DATA'];
  let text = order.map(k => k.replace(/_/g, ' ') + '\n' + sections[k].map(x => '- ' + x).join('\n')).join('\n\n');
  const truncated = text.length > L.maxEvidenceChars; if (truncated) text = text.slice(0, L.maxEvidenceChars - 16) + '\n[...truncated]';
  return { text, sections, truncated, chars: text.length };
}
module.exports = { buildEvidenceSummary, factorLines };
