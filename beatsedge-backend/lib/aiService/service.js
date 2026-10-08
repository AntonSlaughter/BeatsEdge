'use strict';
// AI backend orchestration (Phase 3A). Reuses the committed lib/ai foundation (context, evidence, router, guardrails, provider registry) and adds: selection validation, client-reported site
// telemetry in the context, recorded results, deterministic answers, the guarded provider call and output validation. The AI NEVER computes or changes a projection, probability, edge, grade,
// Prime, confluence, provider line or model state; with no provider configured the response is the deterministic evidence.
const ai = require('../ai'); const { validateSelection } = require('./selection'); const { recordedPerformance } = require('./recorded'); const providers = require('./providers');
const { text: clean } = require('./text'); const S = require('./siteIntel');
const MAX_BODY_BYTES = 64 * 1024, MAX_QUESTION = 300;
const SITE_DELEGATE = new Set(['WHY_NOT_MODELED', 'STANDARD_LINES', 'PLAYER_MISSING', 'PROVIDER_ERRORS', 'TRUNCATION']);
const WITH_RECORDED = new Set(['WHY_GOOD', 'WHY_BAD', 'EXPLAIN_GRADE', 'EXPLAIN_PROBABILITY', 'EXPLAIN_PLAY_SIMPLE', 'BIGGEST_RISK']);
const WITH_QUALITY = new Set(['WHY_GOOD', 'WHY_BAD', 'BIGGEST_RISK', 'EXPLAIN_PLAY_SIMPLE', 'OPPOSING_FACTORS', 'UNKNOWN']);

function questionOf(body) { const q = clean(body && body.question, MAX_QUESTION); return q || null; }
function sizeOk(body) { try { return Buffer.byteLength(JSON.stringify(body || null)) <= MAX_BODY_BYTES; } catch (e) { return false; } }
const bullets = (arr) => arr.map(x => '- ' + x).join('\n');

// Client-reported telemetry that bears on THIS play: the sport's report and the play's book. Never presented as server monitoring.
function dataQuality(status, sel) {
  const sp = sel.input.sport, book = sel.input.prop.book; const f = S.siteFacts(status, [sp])[0]; const lines = [], nums = [];
  if (!f || !f.reported) { lines.push(`No current client-reported telemetry exists for ${S.LABEL[sp]} (${f ? f.freshness : 'NO_DATA'}; telemetry is client-reported, not server monitoring): completeness of this board is unknown.`); return { lines, nums, reported: false, flags: f ? f.flags : ['NO_REPORT'], freshness: f ? f.freshness : 'NO_DATA' }; }
  lines.push(`Client-reported telemetry for ${S.LABEL[sp]} (not server monitoring): report ${f.freshness}, ${f.ageSeconds}s old, fetch status ${f.fetchStatus}.`); nums.push(f.ageSeconds);
  const src = ((status.sports[S.SPORT_KEYS[sp]] || {}).sources || []).find(s => s.source === book);
  if (src) { lines.push(`Source ${book}: provider errors ${src.providerErrors || 0}, truncated responses ${src.truncatedResponses || 0}, ambiguous main lines ${src.ambiguousMainLines || 0}, Standard not returned in ${src.providerStandardNotReturned || 0} group(s).`); nums.push(src.providerErrors || 0, src.truncatedResponses || 0, src.ambiguousMainLines || 0, src.providerStandardNotReturned || 0); }
  else lines.push(`The ${book} source was not in the latest ${S.LABEL[sp]} report.`);
  f.flags.filter(x => x !== 'TRUNCATED_RECOVERED').forEach(x => lines.push('Flag: ' + x.toLowerCase().replace(/_/g, ' ')));
  return { lines, nums, reported: true, flags: f.flags, freshness: f.freshness, fetchStatus: f.fetchStatus };
}
function recordedLines(rec) {
  if (!rec || !rec.available) return { lines: ['Recorded results unavailable: ' + String((rec && rec.reason) || 'not connected').replace(/\.+$/, '') + '.'], nums: [] };
  const ex = rec.excluded.otherVersionOrUntagged, nums = [rec.sameVersion.n, rec.minN, ex]; const lines = [];
  if (rec.enough) { lines.push(`Recorded settled snapshots tagged with this model version (${rec.modelVersion}): ${rec.sameVersion.hits} of ${rec.sameVersion.n} landed on the selected side (${rec.rate}%).`); nums.push(rec.sameVersion.hits, rec.rate); lines.push('Client-captured version tag; recorded snapshots are not a validation of the model and not live customer results.'); }
  else lines.push('No recorded success rate is stated: ' + rec.reason);
  if (ex) lines.push(`${ex} other settled snapshot(s) for this sport / stat / grade come from other or untagged model versions; they are excluded and never combined into a rate.`);
  return { lines, nums };
}function evidenceFor(ctx, routed, extraSections, intent) {
  const ev = ai.buildEvidenceSummary(ctx); const keep = new Set(routed.sections);
  let base = Object.keys(ev.sections).filter(k => keep.has(k)).map(k => k.replace(/_/g, ' ') + '\n' + bullets(ev.sections[k])).join('\n\n'); const truncated = base.length > ai.COST_LIMITS.maxEvidenceChars; if (truncated) base = base.slice(0, ai.COST_LIMITS.maxEvidenceChars - 14) + '\n[...truncated]';
  // the short data-quality / recorded-results sections are appended AFTER the cap so a long factor list can never push them out
  const extra = Object.entries(extraSections).filter(([, lines]) => lines && lines.length).map(([k, lines]) => k.replace(/_/g, ' ') + '\n' + bullets(lines.map(l => String(l).slice(0, 260)).slice(0, 8)));
  return { text: [base].concat(extra).join('\n\n'), sections: Object.assign({}, ev.sections, extraSections), truncated };
}
const ORIGIN_LINES = ['Model outputs in this evidence (projection, probability, edge, grade, Prime, factors, hit rates) were reported by the BeatsEdge page, where the engine runs. The server validated them for internal consistency but did NOT recompute or verify them.'];
function providerBlock(question, evidence) { return `<<<DATA\nQUESTION: ${question}\n${evidence}\nDATA>>>`; }
function safeText(t) { return typeof t === 'string' && t.length <= 1500 && !/https?:\/\/|\]\(|```|<\/?[a-z]/i.test(t); }

// ---------------- selected prop ----------------
async function explainProp(a) {
  const { body, env, status, recordedQuery, limiter, clientId } = a;
  if (!sizeOk(body)) return { http: 413, ok: false, status: 'PAYLOAD_TOO_LARGE', error: 'request too large' };
  const question = questionOf(body); if (!question) return { http: 400, ok: false, status: 'INVALID_QUESTION', error: 'question is required (max ' + MAX_QUESTION + ' characters)' };
  const sel = validateSelection(body.selection); if (!sel.ok) return { http: 400, ok: false, status: 'INVALID_SELECTION', errors: sel.errors };
  const ctx = ai.buildAIContext(sel.input); const p = sel.input.prop;
  Object.assign(ctx.play.provider, { lineStatus: p.lineStatus || null, flagReason: p.flagReason || null, marketClass: p.marketClass || null }); ctx.play.sport = sel.input.sport;
  const providerInfo = providers.loadConfiguredProvider(env || {}); const prov = { configured: providerInfo.configured, name: providerInfo.configured ? providerInfo.name : null, error: providerInfo.error, disabled: providerInfo.disabled === true };
  const base = { ok: true, kind: 'prop', selectionKey: ctx.selectionKey, model: { state: ctx.model.state, hasOutputs: ctx.model.hasOutputs, evidenceOrigin: sel.integrity.evidenceOrigin, serverVerified: false }, integrity: sel.integrity, provider: prov, limits: { maxQuestion: MAX_QUESTION, maxBodyBytes: MAX_BODY_BYTES } };
  // Site / data-quality questions about this prop are answered from telemetry + the play's own state (never from a model).
  const sc = S.classifySiteQuestion(question); const cls = ai.classifyQuestion(question);
  if (SITE_DELEGATE.has(sc.intent) || cls.intent === 'SITE_STATUS') { const ans = S.answerSite({ question, status, ctx }); return Object.assign(base, { http: 200, status: ans.status === 'ANSWERED' ? 'DETERMINISTIC_ANSWER' : 'INSUFFICIENT_EVIDENCE', intent: 'SITE_' + (sc.intent === 'UNKNOWN' ? 'STATUS' : sc.intent), answer: { text: ans.text + '\n' + ans.notes.join(' '), source: 'deterministic', aiGenerated: false }, telemetryTrust: 'client_reported' }); }
  const routed = ai.routeQuestion(ctx, question); const dq = dataQuality(status, sel); const rec = WITH_RECORDED.has(routed.intent) && ctx.model.grade ? await recordedPerformance(recordedQuery, { sport: sel.input.sport, statKey: p.statKey, grade: ctx.model.grade, modelVersion: ctx.model.version }) : null; const rl = recordedLines(rec);
  ctx.allowedNumbers = Array.from(new Set((ctx.allowedNumbers || []).concat(dq.nums, rl.nums)));
  if (routed.status !== 'READY') { const ev = evidenceFor(ctx, routed, { EVIDENCE_ORIGIN: ORIGIN_LINES, DATA_QUALITY: dq.lines }, routed.intent); return Object.assign(base, { http: 200, status: routed.status, intent: routed.intent, answer: { text: routed.refusal, source: 'deterministic', aiGenerated: false }, evidence: { text: ev.text, sections: ev.sections, truncated: ev.truncated }, dataQuality: { reported: dq.reported, freshness: dq.freshness, flags: dq.flags } }); }
  const extra = { EVIDENCE_ORIGIN: ORIGIN_LINES }; if (WITH_QUALITY.has(routed.intent)) extra.DATA_QUALITY = dq.lines; if (WITH_RECORDED.has(routed.intent) && ctx.model.grade) extra.RECORDED_RESULTS = rl.lines;
  const ev = evidenceFor(ctx, routed, extra, routed.intent); const det = { text: 'BeatsEdge evidence (deterministic' + (prov.configured ? '' : '; no AI provider is configured') + ')\n' + ev.text, source: 'deterministic', aiGenerated: false };
  const res = Object.assign(base, { http: 200, intent: routed.intent, evidence: { text: ev.text, sections: ev.sections, truncated: ev.truncated }, dataQuality: { reported: dq.reported, freshness: dq.freshness, flags: dq.flags }, recorded: rec });
  if (!prov.configured) return Object.assign(res, { status: 'NO_PROVIDER_CONFIGURED', answer: det });
  const system = ai.buildSystemContract() + '\n' + providers.EXTRA_RULES.map((r, i) => `${ai.GUARDRAIL_RULES.length + i + 1}. ${r}`).join('\n'); const user = providerBlock(question, ev.text); const approx = Math.ceil((system.length + user.length) / ai.COST_LIMITS.approxCharsPerToken);
  if (approx > ai.COST_LIMITS.maxRequestTokens + 300) return Object.assign(res, { status: 'REQUEST_TOO_LARGE', answer: det });
  const lim = limiter ? limiter.acquire(clientId || 'anon') : { ok: true }; if (!lim.ok) return Object.assign(res, { status: 'PROVIDER_LIMITED', providerLimit: lim.reason, answer: det });
  let out; try { out = await providers.callProvider(ai.getConfiguredProvider(env), { system, user, intent: routed.intent }, { timeoutMs: a.timeoutMs, maxChars: 1500 }); } catch (e) { return Object.assign(res, { status: 'PROVIDER_ERROR', answer: det }); } finally { if (limiter) limiter.release(); }
  const verdict = ai.validateExplanation(out.text, ctx); const extraV = []; if (!safeText(out.text)) extraV.push({ rule: 'FORMAT', detail: 'links, markup or oversize text' });
  if (!verdict.ok || extraV.length) return Object.assign(res, { status: 'REJECTED_BY_GUARDRAILS', violations: verdict.violations.concat(extraV), answer: det });
  return Object.assign(res, { status: 'OK', answer: { text: out.text, source: prov.name, aiGenerated: true, validatedBy: 'lib/ai validateExplanation' } });
}

// ---------------- site intelligence (read-only) ----------------
async function askSite(a) {
  const { body, env, status, limiter, clientId } = a;
  if (!sizeOk(body)) return { http: 413, ok: false, status: 'PAYLOAD_TOO_LARGE', error: 'request too large' };
  const question = questionOf(body); if (!question) return { http: 400, ok: false, status: 'INVALID_QUESTION', error: 'question is required (max ' + MAX_QUESTION + ' characters)' };
  let ctx = null; if (body.selection !== undefined && body.selection !== null) { const sel = validateSelection(body.selection); if (!sel.ok) return { http: 400, ok: false, status: 'INVALID_SELECTION', errors: sel.errors }; ctx = ai.buildAIContext(sel.input); const p = sel.input.prop; Object.assign(ctx.play.provider, { lineStatus: p.lineStatus || null, flagReason: p.flagReason || null, marketClass: p.marketClass || null }); ctx.play.sport = sel.input.sport; }
  const ans = S.answerSite({ question, status, ctx }); const providerInfo = providers.loadConfiguredProvider(env || {}); const prov = { configured: providerInfo.configured, name: providerInfo.configured ? providerInfo.name : null, error: providerInfo.error, disabled: providerInfo.disabled === true };
  const res = { http: 200, ok: true, kind: 'site', intent: ans.intent, status: ans.status === 'ANSWERED' ? 'DETERMINISTIC_ANSWER' : 'INSUFFICIENT_EVIDENCE', answer: { text: ans.text + '\n' + ans.caveat, source: 'deterministic', aiGenerated: false }, caveat: ans.caveat, notes: ans.notes, telemetryTrust: 'client_reported', telemetryFreshness: status && status.freshness, sports: ans.facts.map(f => ({ sport: f.sport, reported: f.reported, freshness: f.freshness, flags: f.flags })), provider: prov, readOnly: true };
  if (!prov.configured || ans.status !== 'ANSWERED') return res;   // insufficient evidence is never "improved" by a model
  const lim = limiter ? limiter.acquire(clientId || 'anon') : { ok: true }; if (!lim.ok) return Object.assign(res, { providerLimit: lim.reason });
  const system = ai.buildSystemContract().split('\n')[0] + '\nYou rephrase BeatsEdge site-status facts. Use ONLY the facts below. State that the telemetry is client-reported. Never claim server-side monitoring, causes, fixes or ETAs.\n' + providers.EXTRA_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n');
  const user = providerBlock(question, S.siteEvidenceText(ans)); let out; try { out = await providers.callProvider(ai.getConfiguredProvider(env), { system, user, intent: 'SITE_STATUS' }, { timeoutMs: a.timeoutMs, maxChars: 1200 }); } catch (e) { return Object.assign(res, { providerStatus: 'PROVIDER_ERROR' }); } finally { if (limiter) limiter.release(); }
  const v = S.validateSiteAnswer(out.text, ans.allowedNumbers, ans.facts); if (!v.ok || !safeText(out.text)) return Object.assign(res, { providerStatus: 'REJECTED_BY_GUARDRAILS', violations: v.violations });
  return Object.assign(res, { status: 'OK', answer: { text: out.text, source: prov.name, aiGenerated: true, validatedBy: 'site-answer validator' }, deterministic: ans.text });
}
module.exports = { explainProp, askSite, dataQuality, recordedLines, evidenceFor, MAX_BODY_BYTES, MAX_QUESTION };
