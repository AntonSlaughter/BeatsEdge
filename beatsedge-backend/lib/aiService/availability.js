'use strict';
// Availability evidence for the AI (2026-10-19). The page sends, per selected play, the injury status of THE PLAYER (with its source and the source's own timestamp), the absent / at-risk TEAMMATES at his position (whether or not they have a prop) and who else is available there.
// It is CLIENT-REPORTED like every other page figure: whitelisted field by field, length-capped, never repaired. The evidence lines below are what the AI may say, and they carry the rules the page itself follows:
//   - UNKNOWN (report missing, stale, ambiguous or not covering the sport) is stated as unknown, never as healthy or available; "not on the report" means no designation was reported, not that he will play;
//   - depth-chart order is a listing, not a workload split; who inherits carries / targets / minutes is uncertain unless stated otherwise; NO workload adjustment is applied and the model probability is unchanged;
//   - historical hit rates and averages may reflect a different role than tonight's when a same-position teammate is absent.
const { text } = require('./text');
const STATES = ['LISTED', 'NO_DESIGNATION', 'UNKNOWN']; const CODES = ['OUT', 'IR', 'SUSPENDED', 'DOUBTFUL', 'QUESTIONABLE', 'PROBABLE', 'ACTIVE', 'UNKNOWN'];
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/; const ts = (v) => (typeof v === 'string' && TIME_RE.test(v) ? v : null);
const LABEL = { OUT: 'Out', IR: 'Injured reserve', SUSPENDED: 'Suspended', DOUBTFUL: 'Doubtful', QUESTIONABLE: 'Questionable', PROBABLE: 'Probable', ACTIVE: 'Listed with no designation', UNKNOWN: 'Unknown' };
function validateAvailability(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null; const state = STATES.indexOf(raw.state) >= 0 ? raw.state : null; if (!state) return null;
  const code = (v) => (CODES.indexOf(v) >= 0 ? v : null); const rep = { field: 'availability', list: [] };
  const mates = (Array.isArray(raw.teammates) ? raw.teammates : []).slice(0, 4).map(t => (t && typeof t === 'object' ? { name: text(t.name, 60, rep), position: text(t.position, 12, rep), status: code(t.status) || 'UNKNOWN', source: text(t.source, 60, rep), updatedAt: ts(t.updatedAt), hasProp: t.hasProp === true } : null)).filter(t => t && t.name);
  const cands = (Array.isArray(raw.candidates) ? raw.candidates : []).slice(0, 4).map(c => (c && typeof c === 'object' ? { name: text(c.name, 60, rep), depthRank: Number.isInteger(c.depthRank) && c.depthRank >= 1 && c.depthRank <= 20 ? c.depthRank : null } : null)).filter(c => c && c.name);
  return { state, status: code(raw.status), label: text(raw.label, 40, rep), source: text(raw.source, 60, rep), sourceUpdatedAt: ts(raw.sourceUpdatedAt), fetchedAt: ts(raw.fetchedAt), reason: text(raw.reason, 200, rep), teammates: mates, candidates: cands, splitUncertain: raw.splitUncertain === true ? true : raw.splitUncertain === false ? false : null };
}
// the evidence lines (each short) + the numbers the answer may quote
function availabilityLines(av) {
  if (!av) return { lines: ['Injury status was not provided for this play: it is UNKNOWN. Do not describe him as healthy or available.'], nums: [] }; const L = [];
  const when = (t) => (t ? ', updated ' + t : ''); const src = av.source || 'the injury report';
  if (av.state === 'LISTED') L.push(`Injury status (client-reported, ${src}${when(av.sourceUpdatedAt)}): ${av.label || LABEL[av.status] || 'listed'}${av.status === 'ACTIVE' ? ' (listed on the report without a designation; that is not a confirmation that he will play)' : ''}.`);
  else if (av.state === 'NO_DESIGNATION') L.push(`Injury status: not on the injury report (${src}${av.fetchedAt ? ', checked ' + av.fetchedAt : ''}). No designation was reported; that is not a confirmation that he is healthy or will play.`);
  else L.push(`Injury status is UNKNOWN: ${av.reason || 'the injury report is missing, stale or ambiguous'}. Do not describe him as healthy or available.`);
  av.teammates.forEach(t => L.push(`Teammate ${t.name}${t.position ? ' (' + t.position + ')' : ''} is ${(LABEL[t.status] || t.status).toLowerCase()} per ${t.source || 'the injury report'}${when(t.updatedAt)}; ${t.hasProp ? 'a prop is offered for him' : 'NO prop is offered for him, so he does not appear on the board'}.`));
  if (av.teammates.length) {
    if (av.candidates.length) L.push(`Other available players at that spot (depth-chart order is a listing, not a workload split): ${av.candidates.map(c => c.name + (c.depthRank ? ' (#' + c.depthRank + ')' : '')).join(', ')}. How the work is shared is ${av.splitUncertain === false ? 'not flagged as uncertain' : 'uncertain'}.`); else L.push('No other available player at that spot is known: who inherits the work is unknown.');
    L.push('Historical hit rates and averages may reflect a different role than tonight\'s. No workload adjustment is applied and the model probability is unchanged.');
  }
  const nums = []; L.forEach(l => (String(l).match(/\d+(?:\.\d+)?/g) || []).forEach(n => nums.push(Number(n)))); return { lines: L.map(l => String(l).slice(0, 300)), nums };
}

// ---- line freshness (2026-10-20) ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// After a failed provider refresh the page keeps the lines it already had and marks them STALE (it sends { state: 'STALE', fetchedAt, failedAt }). The AI must describe such a line as of its fetch time, never as current. Only STALE is accepted: anything else is dropped (absent = no claim).
function validateFreshness(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.state !== 'STALE') return null; const rep = { field: 'dataFreshness', list: [] };
  return { state: 'STALE', fetchedAt: ts(raw.fetchedAt), failedAt: ts(raw.failedAt), reason: text(raw.reason, 160, rep) };
}
function freshnessLines(fr) {
  if (!fr) return { lines: [], nums: [] };
  const l = `The lines for this play are STALE: ${fr.fetchedAt ? 'they were fetched at ' + fr.fetchedAt : 'their fetch time is not known'}${fr.failedAt ? ' and the provider refresh at ' + fr.failedAt + ' failed' : ' and the provider refresh that followed failed'}, so the line may have moved or been pulled. Describe the line as of its fetch time, never as the current line. The model values were computed from these retained lines.`;
  const nums = []; (String(l).match(/\d+(?:\.\d+)?/g) || []).forEach(n => nums.push(Number(n))); return { lines: [l], nums };
}
// What the injury / line evidence says against the play, as short clauses. The engine's own factors never include any of it (the injury report is not a model input), so "no engine factor opposes" must not be read as "nothing opposes".
const AT_RISK = ['OUT', 'IR', 'SUSPENDED', 'DOUBTFUL', 'QUESTIONABLE'];
function riskClauses(av, fr) {
  const c = []; const src = (a) => (a && a.source ? a.source : 'the injury report');
  if (fr) c.push(`the lines are stale (${fr.fetchedAt ? 'fetched at ' + fr.fetchedAt : 'fetch time unknown'}; the provider refresh failed)`);
  if (!av || av.state === 'UNKNOWN') c.push(`his injury status is unknown (${(av && av.reason) || 'it was not provided'}): do not treat him as healthy`);
  else if (av.state === 'LISTED' && AT_RISK.indexOf(av.status) >= 0) c.push(`he is listed ${(LABEL[av.status] || av.status).toLowerCase()} per ${src(av)}${av.sourceUpdatedAt ? ', updated ' + av.sourceUpdatedAt : ''}`);
  const away = (av && av.teammates ? av.teammates : []).filter(t => AT_RISK.indexOf(t.status) >= 0); if (away.length) c.push(`a same-position teammate is out or at risk (${away.slice(0, 3).map(t => t.name + ', ' + (LABEL[t.status] || t.status).toLowerCase()).join('; ')}), so his history may reflect a different role`);
  return c;
}
const NO_OPPOSE = 'No available factor opposes the selected direction.';
// Reconcile the opposing-evidence section with the injury / line evidence. The core evidence builder (lib/ai, untouched) prints "No available factor opposes the selected direction." whenever the ENGINE's factors do not oppose; that sentence must not stand next to a Questionable / Out / unknown status or stale lines. Both the text and the section are rewritten; nothing is added when there is nothing to reconcile.
function reconcile(ev, av, fr) {
  const clauses = riskClauses(av, fr); if (!clauses.length || !ev) return ev; const sent = clauses.join('; ');
  const fixed = `No ENGINE factor opposes the selected direction, but that does not mean nothing opposes this play: ${sent}.`; const extra = `Availability / line risk (not an engine factor; no model value was changed): ${sent}.`;
  let text = String(ev.text); const sections = Object.assign({}, ev.sections); const opp = Array.isArray(sections.RISK_OPPOSING_EVIDENCE) ? sections.RISK_OPPOSING_EVIDENCE.slice() : null;
  if (opp) { const i = opp.indexOf(NO_OPPOSE); if (i >= 0) opp[i] = fixed; else opp.push(extra); sections.RISK_OPPOSING_EVIDENCE = opp; }
  const hasHeading = /(^|\n)RISK OPPOSING EVIDENCE\n/.test(text);
  if (text.indexOf('- ' + NO_OPPOSE) >= 0) text = text.replace('- ' + NO_OPPOSE, '- ' + fixed);
  else if (hasHeading) text = text.replace(/((?:^|\n)RISK OPPOSING EVIDENCE\n(?:- [^\n]*\n?)*)/, (m) => m.replace(/\n?$/, '\n') + '- ' + extra + '\n').replace(/\n\n\n/g, '\n\n');
  return Object.assign({}, ev, { text, sections });
}
// A provider-written answer must not contradict the evidence: while an injury / stale-line risk is listed, it may not say nothing opposes the play, that there is no risk or concern, or that the player is healthy / a full go. (A sentence that negates the claim, "does not mean nothing opposes", is allowed.)
function contradictsRisk(answer) {
  const s = String(answer || '').replace(/\b(?:does|do|did|is|are) not (?:mean|say|imply|show|prove)(?: that)? (?:nothing|there is no)[^.\n]*/gi, ' ');
  return /\bno available factor opposes\b/i.test(s) || /\b(?:nothing|no (?:factors?|risks?|concerns?|downside|red flags?))\b[^.\n]{0,60}\b(?:oppos\w*|against (?:this|the)|concern\w*|risk\w*|worr\w*)/i.test(s) || /\b(?:is|are|looks?|appears?|remains?) (?:fully |completely |100% )?healthy\b|\bfull[- ]go\b|\bno (?:injury|availability) (?:concerns?|issues?|worries)\b|\bnot (?:injured|hurt)\b/i.test(s);
}
// The core guardrail (lib/ai, untouched) rejects any provider answer that mentions an injury unless the player's status field is an injury status, and the page's legacy status can lag the availability object it sent in the same request. The availability object is the specific, sourced fact: when it LISTS an out / at-risk status, the status field the core sees follows it (IR and suspension read as OUT). Nothing else is changed.
function alignStatus(input) {
  const av = input && input.availability; if (!av || av.state !== 'LISTED' || AT_RISK.indexOf(av.status) < 0 || !input.player) return input; input.player.status = (av.status === 'IR' || av.status === 'SUSPENDED') ? 'OUT' : av.status; return input;
}
module.exports = { validateAvailability, availabilityLines, validateFreshness, freshnessLines, riskClauses, reconcile, contradictsRisk, alignStatus, LABEL };
