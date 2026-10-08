'use strict';
// Read-only site intelligence: answers questions about data completeness / freshness / why something is missing or not modeled -- ONLY from (a) the client-reported site telemetry
// (lib/siteTelemetry.js status()) and (b) the selected play's own context when one is supplied. No telemetry for a sport = no claim for that sport. Everything is labeled CLIENT-REPORTED:
// browsers report what THEY fetched; this is not authoritative server-side monitoring. Pure functions (no I/O).
const { text: clean } = require('./text');
const { SPORT_COVERAGE, STATE_MEANING } = require('./coverage');
const SPORT_KEYS = { nba: 'basketball_nba', wnba: 'basketball_wnba', nfl: 'americanfootball_nfl', ncaaf: 'americanfootball_ncaaf', nhl: 'icehockey_nhl', mlb: 'baseball_mlb' };
const SHORT = Object.fromEntries(Object.entries(SPORT_KEYS).map(([k, v]) => [v, k]));
const LABEL = { nba: 'NBA', wnba: 'WNBA', nfl: 'NFL', ncaaf: 'NCAAF', nhl: 'NHL', mlb: 'MLB' };
const BOOK_LABEL = { prizepicks: 'PrizePicks', underdog: 'Underdog', pick6: 'Pick6', sleeper: 'Sleeper' };
const CAVEAT = 'Based on CLIENT-REPORTED BeatsEdge telemetry (browsers report what they fetched), not authoritative server-side monitoring.';
const sum = (arr, k) => arr.reduce((a, s) => a + (Number(s[k]) || 0), 0);

// Structured facts per sport from status().sports. Categories are kept SEPARATE on purpose: provider errors / truncation (unresolved vs recovered) / missing Standard lines / provider-only
// listings / staleness are different problems with different meanings.
function siteFacts(status, only) {
  const out = []; const sports = (status && status.sports) || {};
  Object.keys(SHORT).forEach(key => { const sp = SHORT[key]; if (only && only.indexOf(sp) < 0) return; const r = sports[key];
    if (!r || r.reported !== true) { out.push({ sport: sp, label: LABEL[sp], reported: false, freshness: (r && r.freshness) || 'NO_DATA', flags: ['NO_REPORT'] }); return; }
    const srcs = Array.isArray(r.sources) ? r.sources : []; const flags = [];
    const providerErrors = { fetchStatus: r.fetchStatus, failedBooks: r.failedBooks || [], sourcesWithErrors: srcs.filter(s => (s.providerErrors || 0) > 0).map(s => s.source), errorCount: sum(srcs, 'providerErrors') };
    const truncated = { unresolved: r.fetchStatus === 'TRUNCATED', truncatedResponses: sum(srcs, 'truncatedResponses'), fetchMode: r.fetchMode || null, recoveredBySplit: r.fetchStatus === 'COMPLETE' && sum(srcs, 'truncatedResponses') > 0 };
    const missingStandard = srcs.filter(s => (s.providerStandardNotReturned || 0) > 0 || (s.standardPresentGroups || 0) > 0 || (s.altOnlyGroups || 0) > 0).map(s => ({ source: s.source, standardPresentGroups: s.standardPresentGroups == null ? null : s.standardPresentGroups, notReturnedGroups: s.providerStandardNotReturned || 0, altOnlyGroups: s.altOnlyGroups || 0, lineTypes: s.lineTypes || null }));
    const providerOnly = { unmappedMarkets: sum(srcs, 'unmappedMarkets'), routedMarketRows: sum(srcs, 'routedMarketRows'), ambiguousMainLines: sum(srcs, 'ambiguousMainLines') };
    const identity = { playerIdentityFailures: sum(srcs, 'playerIdentityFailures'), eventIdentityFailures: sum(srcs, 'eventIdentityFailures') };
    if (providerErrors.fetchStatus === 'PROVIDER_ERROR' || providerErrors.failedBooks.length || providerErrors.errorCount) flags.push('PROVIDER_ERRORS');
    if (truncated.unresolved) flags.push('TRUNCATED_UNRESOLVED'); else if (truncated.recoveredBySplit) flags.push('TRUNCATED_RECOVERED');
    if (missingStandard.some(m => m.notReturnedGroups > 0)) flags.push('STANDARD_NOT_RETURNED');
    if (providerOnly.ambiguousMainLines > 0) flags.push('AMBIGUOUS_MAIN_LINES'); if (providerOnly.unmappedMarkets + providerOnly.routedMarketRows > 0) flags.push('PROVIDER_ONLY_LISTINGS');
    if (identity.playerIdentityFailures + identity.eventIdentityFailures > 0) flags.push('IDENTITY_FAILURES');
    if (r.freshness === 'STALE') flags.push('STALE_REPORT'); if (r.freshness === 'EXPIRED') flags.push('EXPIRED_REPORT');
    out.push({ sport: sp, label: LABEL[sp], reported: true, freshness: r.freshness, ageSeconds: r.ageSeconds, generatedAt: r.generatedAt, fetchStatus: r.fetchStatus, providerErrors, truncated, missingStandard, providerOnly, identity, modelCoverage: SPORT_COVERAGE[sp], flags }); });
  return out;
}
const INCOMPLETE_FLAGS = ['PROVIDER_ERRORS', 'TRUNCATED_UNRESOLVED'];

// ---- question classification (deterministic) ----
const RULES = [
  ['STANDARD_LINES', /(standard|demon|goblin|gimme|power.?up|stat.?slice).{0,40}(line|lines|available|present|missing|returned)|(prizepicks|underdog|pick6|sleeper).{0,40}(standard|available|lines)/i],
  ['WHY_NOT_MODELED', /(why|how come).{0,30}(isn'?t|is not|aren'?t|not|no).{0,30}(model|graded|projection|probability)|not modeled|unmodeled|model not supported/i],
  ['PLAYER_MISSING', /(why|where).{0,30}(is|are|isn'?t|did|was).{0,60}\b(missing|gone|not (showing|listed|here|on)|absent)|missing (player|prop|line)|can'?t find/i],
  ['PROVIDER_ERRORS', /(provider|api|feed|book).{0,25}(error|down|fail|outage)|failed books?|errors?\b/i],
  ['TRUNCATION', /truncat|cut off|partial (data|board)|sampled/i],
  ['FRESHNESS', /stale|expired|fresh|up to date|how old|last updated|recent/i],
  ['INCOMPLETE_SPORTS', /(which|what).{0,30}(sports?|leagues?).{0,40}(incomplete|missing|gaps?|problem|issue|bad)|incomplete|gaps?|complete(ness)?|any (problems|issues)/i],
  ['GENERAL_STATUS', /(site|data|board|everything).{0,20}(status|health|ok|fine|working)|status|health/i]
];
function classifySiteQuestion(question) {
  const q = String(question == null ? '' : question).slice(0, 300); let intent = 'UNKNOWN'; for (const [i, re] of RULES) if (re.test(q)) { intent = i; break; }
  const sports = Object.keys(LABEL).filter(sp => new RegExp('\\b' + (sp === 'ncaaf' ? '(ncaaf|cfb|college football)' : sp) + '\\b', 'i').test(q));
  const book = Object.keys(BOOK_LABEL).find(b => new RegExp('\\b' + b + '\\b', 'i').test(q)) || null;
  let player = null; const m = /why (?:is|are|isn'?t|was)\s+(.{2,60}?)\s+(?:missing|gone|not (?:showing|listed|here|on))/i.exec(q) || /(?:where is|can'?t find)\s+(.{2,60}?)(?:\?|$|\s+(?:in|on|for)\b)/i.exec(q); if (m) player = clean(m[1], 60);
  return { intent, sports, book, player };
}

const flagText = (f) => ({ PROVIDER_ERRORS: 'provider errors were reported', TRUNCATED_UNRESOLVED: 'the board was truncated and NOT fully recovered', TRUNCATED_RECOVERED: 'truncation occurred but was recovered by splitting the request', STANDARD_NOT_RETURNED: 'some Standard lines were not returned by the provider', AMBIGUOUS_MAIN_LINES: 'some main lines are ambiguous (shown as provider-only)', PROVIDER_ONLY_LISTINGS: 'some listings are provider-only (unmapped / routed markets)', IDENTITY_FAILURES: 'some player/event identities could not be resolved', STALE_REPORT: 'the report is stale', EXPIRED_REPORT: 'the report is expired', NO_REPORT: 'no report exists' }[f] || f);
const ageText = (f) => (f.ageSeconds == null ? '' : ` (report ${f.freshness}, ${f.ageSeconds}s old)`);

function answerSite(args) {
  const { question, status, ctx } = args || {}; const c = classifySiteQuestion(question); const only = c.sports.length ? c.sports : (ctx && ctx.play && ctx.play.sport ? [ctx.play.sport] : null);
  const facts = siteFacts(status, only); const reported = facts.filter(f => f.reported); const lines = []; let state = 'ANSWERED'; const notes = [CAVEAT];
  const noData = () => { state = 'INSUFFICIENT_EVIDENCE'; lines.push('No current telemetry report exists for ' + (only ? only.map(s => LABEL[s]).join(', ') : 'any sport') + ' (' + facts.map(f => f.label + ': ' + f.freshness).join('; ') + '), so this cannot be answered.'); };
  switch (c.intent) {
    case 'STANDARD_LINES': {
      const book = c.book || 'prizepicks'; if (!reported.length) { noData(); break; }
      reported.forEach(f => { const m = f.missingStandard.find(x => x.source === book); if (!m) { lines.push(`${f.label}: no ${BOOK_LABEL[book] || book} line-type data was reported${ageText(f)}.`); return; }
        const lt = m.lineTypes ? Object.entries(m.lineTypes).filter(([k, v]) => k !== 'other' && v > 0).map(([k, v]) => k + ' ' + v).join(', ') : null;
        lines.push(`${f.label}: ${BOOK_LABEL[book] || book} Standard ${m.standardPresentGroups == null ? 'presence not reported' : 'present in ' + m.standardPresentGroups + ' group(s)'}, provider did not return a Standard for ${m.notReturnedGroups} group(s) (shown only as alternates)${lt ? '; line types seen: ' + lt : ''}${ageText(f)}.`); });
      notes.push('A missing Standard means the provider did not return one in its feed; BeatsEdge never creates a Standard line.'); break; }
    case 'INCOMPLETE_SPORTS': {
      if (!reported.length) { noData(); break; }
      reported.forEach(f => { const inc = f.flags.filter(x => INCOMPLETE_FLAGS.indexOf(x) >= 0); const other = f.flags.filter(x => INCOMPLETE_FLAGS.indexOf(x) < 0); lines.push(`${f.label}: ${inc.length ? 'INCOMPLETE - ' + inc.map(flagText).join('; ') : 'no provider error or unresolved truncation reported'}${other.length ? '; also: ' + other.map(flagText).join('; ') : ''}${ageText(f)}.`); });
      facts.filter(f => !f.reported).forEach(f => lines.push(`${f.label}: no current report (${f.freshness}); completeness is unknown, not confirmed.`)); break; }
    case 'PROVIDER_ERRORS': {
      if (!reported.length) { noData(); break; }
      reported.forEach(f => lines.push(`${f.label}: fetch status ${f.fetchStatus}; failed books: ${f.providerErrors.failedBooks.length ? f.providerErrors.failedBooks.join(', ') : 'none'}; sources reporting errors: ${f.providerErrors.sourcesWithErrors.length ? f.providerErrors.sourcesWithErrors.join(', ') : 'none'}${ageText(f)}.`)); break; }
    case 'TRUNCATION': {
      if (!reported.length) { noData(); break; }
      reported.forEach(f => lines.push(`${f.label}: ${f.truncated.unresolved ? 'truncated and NOT fully recovered' : f.truncated.recoveredBySplit ? 'truncated responses occurred (' + f.truncated.truncatedResponses + ') and were recovered by splitting (' + f.truncated.fetchMode + ')' : 'no truncation reported'}${ageText(f)}.`)); break; }
    case 'FRESHNESS': {
      facts.forEach(f => lines.push(f.reported ? `${f.label}: ${f.freshness}, ${f.ageSeconds}s since the last report.` : `${f.label}: no current report (${f.freshness}).`)); if (!reported.length) state = 'INSUFFICIENT_EVIDENCE'; break; }
    case 'PLAYER_MISSING': {
      const who = c.player ? '"' + c.player + '"' : 'that player';
      if (ctx && ctx.model && ctx.model.state && ctx.model.state !== 'FULLY_MODELED') lines.push(`The selected prop is listed but is ${ctx.model.state}: ${STATE_MEANING[ctx.model.state]}.`);
      lines.push(`Telemetry carries counts, not player names, so BeatsEdge cannot confirm why ${who} is missing.`);
      if (reported.length) { lines.push('Reported conditions that could affect what is shown (no evidence ties any of them to ' + who + '):'); reported.forEach(f => lines.push(`- ${f.label}: ${f.flags.length ? f.flags.map(flagText).join('; ') : 'nothing unusual reported'}; identity failures ${f.identity.playerIdentityFailures}, unmapped markets ${f.providerOnly.unmappedMarkets}${ageText(f)}.`)); }
      else lines.push('No current telemetry report exists for ' + (only ? only.map(s => LABEL[s]).join(', ') : 'any sport') + '.');
      state = 'INSUFFICIENT_EVIDENCE'; notes.push('Verdict: insufficient evidence for the specific player.'); break; }
    case 'WHY_NOT_MODELED': {
      if (!ctx) { state = 'INSUFFICIENT_EVIDENCE'; lines.push('No prop is selected, so BeatsEdge cannot say why a specific prop is not modeled. Select a prop (sport, player, stat, line, book) and ask again.'); break; }
      const m = ctx.model, pr = ctx.play; lines.push(`Model state: ${m.state} - ${STATE_MEANING[m.state] || 'state not recognized'}.`);
      if (m.stateReason) lines.push('Engine reason: ' + m.stateReason);
      if (pr.provider.lineStatus) lines.push('Line status: ' + pr.provider.lineStatus + (pr.provider.flagReason ? ' (' + pr.provider.flagReason + ')' : '') + '.');
      if (pr.provider.marketClass) lines.push('Market class: ' + pr.provider.marketClass + ' (a different market than the base stat; routed to its own provider-only group).');
      const unav = (ctx.unavailable || []).filter(u => /^(history|model\.outputs)/.test(u.field)).map(u => u.field + ': ' + u.reason); if (unav.length && m.state !== 'FULLY_MODELED') lines.push('Missing: ' + unav.slice(0, 3).join(' | '));
      if (SPORT_COVERAGE[pr.sport]) lines.push('Documented coverage for ' + LABEL[pr.sport] + ': ' + SPORT_COVERAGE[pr.sport] + ' (static policy, not live).'); break; }
    case 'GENERAL_STATUS': {
      if (!reported.length) { noData(); break; }
      reported.forEach(f => lines.push(`${f.label}: ${f.fetchStatus}, flags: ${f.flags.length ? f.flags.map(x => x.toLowerCase()).join(', ') : 'none'}${ageText(f)}.`)); break; }
    default: { state = 'INSUFFICIENT_EVIDENCE'; lines.push('This question is not one BeatsEdge can answer from its telemetry. It can answer: which sports have incomplete data, whether PrizePicks / Underdog / Pick6 Standard lines are available, provider errors, truncation, report freshness, why a selected prop is not modeled, and (with limits) why a player is missing.'); }
  }
  const nums = new Set(); JSON.stringify(facts, (k, v) => { if (typeof v === 'number' && Number.isFinite(v)) nums.add(v); return v; });
  return { intent: c.intent, status: state, text: lines.join('\n'), notes, caveat: CAVEAT, facts, parsed: { sports: c.sports, book: c.book, player: c.player }, allowedNumbers: Array.from(nums) };
}

// Compact evidence for an optional provider rewrite (facts only; no board, no rows).
function siteEvidenceText(ans, maxChars) {
  const t = ['CAVEAT: ' + CAVEAT, 'QUESTION INTENT: ' + ans.intent, 'DETERMINISTIC ANSWER:', ans.text, 'FACTS:'].concat(ans.facts.map(f => f.reported ? `${f.label}: freshness ${f.freshness}, age ${f.ageSeconds}s, fetch ${f.fetchStatus}, flags ${f.flags.join(',') || 'none'}` : `${f.label}: no report (${f.freshness})`)).join('\n');
  return t.length > (maxChars || 2400) ? t.slice(0, (maxChars || 2400) - 14) + '\n[...truncated]' : t;
}
// Output validator for a provider-written site answer: fails closed.
function validateSiteAnswer(textIn, allowedNumbers, facts) {
  const v = []; const t = String(textIn == null ? '' : textIn); if (!t.trim()) return { ok: false, violations: [{ rule: 'EMPTY' }] };
  const allowed = allowedNumbers || []; const re = /(\d+(?:\.\d+)?)/g; let m; while ((m = re.exec(t))) { const n = parseFloat(m[1]); const before = t.slice(Math.max(0, m.index - 1), m.index); if (/[A-Za-z]/.test(before)) continue; if (Number.isInteger(n) && n <= 1) continue; if (!allowed.some(a => Math.abs(a - n) <= 0.051)) { v.push({ rule: 'INVENTED_NUMBER', detail: m[1] + ' is not in the telemetry evidence' }); if (v.length > 4) break; } }
  if (/\b(confirmed|verified|authoritative|guaranteed)\b[^.\n]{0,40}\b(outage|down|monitor|incident)|our servers (detected|confirm|monitor)|server-?side monitoring (shows|confirms|detected)/i.test(t)) v.push({ rule: 'AUTHORITY_OVERCLAIM', detail: 'telemetry is client-reported, not authoritative monitoring' });
  if (!/client-?reported|reported by|browsers? report/i.test(t)) v.push({ rule: 'MISSING_CAVEAT', detail: 'the answer must state that the telemetry is client-reported' });
  if (/\b(fixed|resolved|will be (back|fixed)|eta|root cause)\b/i.test(t)) v.push({ rule: 'UNSUPPORTED_CLAIM', detail: 'remediation / cause / ETA claim with no evidence' });
  if (/https?:\/\/|\]\(|```/.test(t)) v.push({ rule: 'FORMAT', detail: 'links / code blocks are not allowed' });
  const claimedSports = Object.entries(LABEL).filter(([sp, l]) => new RegExp('\\b' + l + '\\b').test(t)).map(([sp]) => sp); (facts || []).forEach(f => { if (!f.reported && claimedSports.indexOf(f.sport) >= 0 && /\b(complete|healthy|fine|all good|no issues)\b/i.test(t) && !/no (current )?report|unknown|not confirmed/i.test(t)) v.push({ rule: 'CLAIM_WITHOUT_REPORT', detail: f.label + ' has no current report but the answer calls it healthy / complete' }); });
  return { ok: v.length === 0, violations: v };
}
module.exports = { siteFacts, classifySiteQuestion, answerSite, siteEvidenceText, validateSiteAnswer, CAVEAT, LABEL, SPORT_KEYS };
