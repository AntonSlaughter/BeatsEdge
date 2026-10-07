'use strict';
// FUTURE data contracts. Interfaces only: NOTHING here fabricates data, reads a provider, or answers a question.
// The later completeness-telemetry phase fills SITE_TELEMETRY; the later settlement phase fills SETTLED_PLAY. Until then every answer that needs them is UNAVAILABLE.
const SITE_TELEMETRY_VERSION = 'beatsedge-site-telemetry/1';
const SETTLED_PLAY_VERSION = 'beatsedge-settled-play/1';
// ---- 1. Site / feed completeness telemetry (per sport x source) ----
const FETCH_STATUSES = Object.freeze(['COMPLETE', 'TRUNCATED', 'PROVIDER_ERROR', 'NOT_REQUESTED', 'UNKNOWN']);
const SITE_SOURCE_FIELDS = Object.freeze({
  fetchStatus: 'enum:' + FETCH_STATUSES.join('|'), rawRows: 'int', playerPropRows: 'int', events: 'int', players: 'int',
  mainLineGroups: 'int', mainLinesRetained: 'int', alternates: 'int',
  lineTypes: { standard: 'int', demon: 'int', goblin: 'int', gimme_pick: 'int', stat_slice: 'int', power_up: 'int', unclassified: 'int' },   // exact provider metadata only
  altOnlyGroups: 'int', providerStandardNotReturned: 'int', unmappedMarkets: 'int', playerIdentityFailures: 'int', eventIdentityFailures: 'int', ambiguousMainLines: 'int', truncatedResponses: 'int', providerErrors: 'int'
});
function emptySiteTelemetry() { return { version: SITE_TELEMETRY_VERSION, generatedAt: null, available: false, sportsLoaded: null, sourcesLoaded: null, bySportSource: {} }; }
function validateSiteTelemetry(t) {
  const errors = []; if (!t || typeof t !== 'object') return { ok: false, errors: ['not an object'] }; if (t.version !== SITE_TELEMETRY_VERSION) errors.push('wrong version');
  if (!t.generatedAt) errors.push('generatedAt missing'); if (!t.bySportSource || typeof t.bySportSource !== 'object') errors.push('bySportSource missing');
  Object.entries(t.bySportSource || {}).forEach(([k, v]) => { if (!/^[a-z_]+\|[a-z0-9_]+$/.test(k)) errors.push('bad key ' + k + ' (expected "<sport_key>|<source>")'); if (!v || FETCH_STATUSES.indexOf(v.fetchStatus) < 0) errors.push(k + ': fetchStatus must be one of ' + FETCH_STATUSES.join('|')); });
  return { ok: errors.length === 0, errors };
}
// ---- 2. Settled-play contract (evidence-gated causes; never auto-updates the model) ----
const RESULTS = Object.freeze(['HIT', 'MISS', 'PUSH', 'VOID']);
const CAUSE_EVIDENCE = Object.freeze({   // a cause may be stated ONLY when every listed field is present with a source
  minutesChange: ['expectedMinutes', 'actualMinutes'], usageChange: ['expectedUsage', 'actualUsage'], opportunityChange: ['expectedOpportunity', 'actualOpportunity'], injury: ['injuryEvent'], foulTrouble: ['foulsAtExit'],
  teammateAvailability: ['teammateStatusEvents'], gameEnvironment: ['expectedTotalOrPace', 'actualTotalOrPace'], matchupAssumption: ['assumedMatchupMetric', 'observedMatchupMetric'], lineQuality: ['providerLineAtPlay', 'closingLine']
});
function validateSettledRecord(rec) {
  const errors = []; if (!rec || typeof rec !== 'object') return { ok: false, errors: ['not an object'] }; if (rec.version !== SETTLED_PLAY_VERSION) errors.push('wrong version'); if (!rec.selectionKey) errors.push('selectionKey missing');
  if (RESULTS.indexOf(rec.result) < 0) errors.push('result must be one of ' + RESULTS.join('|')); if (typeof rec.actualStat !== 'number') errors.push('actualStat must be a number'); if (!rec.settledAt) errors.push('settledAt missing');
  if (rec.autoUpdateModel === true) errors.push('autoUpdateModel must never be true: the AI cannot change model weights');
  return { ok: errors.length === 0, errors };
}
// Which causes the evidence ALLOWS an explanation to state. A final score alone allows none.
function allowedCauses(rec) {
  const ev = (rec && rec.evidence) || {}; const out = {};
  Object.entries(CAUSE_EVIDENCE).forEach(([cause, fields]) => { const have = fields.every(f => ev[f] != null && (ev[f].source || ev[f] === true || typeof ev[f] === 'object' || typeof ev[f] === 'number')); out[cause] = have ? 'EVIDENCE_PRESENT' : 'NO_EVIDENCE'; });
  return out;
}
// ---- 3. Extension hooks: the SAME factual context will power these later. Not implemented. ----
const EXTENSIONS = Object.freeze(['correlation', 'smartParlay', 'fantasy', 'discord', 'social']);
const _registry = {};
function registerExtension(name, fn) { if (EXTENSIONS.indexOf(name) < 0) throw new Error('unknown extension ' + name); if (typeof fn !== 'function') throw new Error('extension must be a function'); _registry[name] = fn; }
function runExtension(name, ctx) { if (EXTENSIONS.indexOf(name) < 0) return { status: 'UNKNOWN_EXTENSION' }; if (!_registry[name]) return { status: 'NOT_IMPLEMENTED', extension: name, consumes: require('./constants').CONTEXT_VERSION }; return { status: 'OK', result: _registry[name](ctx) }; }
module.exports = { SITE_TELEMETRY_VERSION, SETTLED_PLAY_VERSION, FETCH_STATUSES, SITE_SOURCE_FIELDS, emptySiteTelemetry, validateSiteTelemetry, RESULTS, CAUSE_EVIDENCE, validateSettledRecord, allowedCauses, EXTENSIONS, registerExtension, runExtension };
