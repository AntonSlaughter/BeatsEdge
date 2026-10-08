// Backend-readable site / provider completeness status (2026-10-08).
//
// The browser (BeatsEdge.html, fetchParlayPropsBulk) builds `beatsedge-site-telemetry/1` objects -- the SAME contract lib/ai/contracts.js validates -- and reports them here;
// this module validates, SANITIZES (field whitelist, numeric clamps, slug-only keys), stores the latest report per sport in memory and derives freshness + completeness.
//
// Trust model (stated plainly): reports are CLIENT-REPORTED aggregate counters. They contain no provider key, URL, player name, price or user data -- only counts and the
// provider's own line-type tags -- so accepting them unauthenticated cannot leak anything; the risk is a spoofed / noisy report, which is bounded by: the strict contract
// validation, a hard payload cap, a per-client rate limit, a sport / source allow-shape, clamped numbers and the `trust: 'client_reported'` label on every output. The store is
// in-memory only (ephemeral on a restart / Render free spin-down: status then reads NO_DATA until a browser reports again) -- nothing is written to a database.
const { validateSiteTelemetry, SITE_TELEMETRY_VERSION, FETCH_STATUSES } = require('./ai');

const MAX_PAYLOAD_BYTES = 64 * 1024;
const SPORT_KEYS = ['basketball_nba', 'basketball_wnba', 'baseball_mlb', 'americanfootball_nfl', 'americanfootball_ncaaf', 'icehockey_nhl'];
const FRESH_MS = 10 * 60 * 1000;      // a refreshing browser reports every ~1-2 min; 10 min without a report = no longer "fresh"
const STALE_MS = 60 * 60 * 1000;      // beyond an hour the report is EXPIRED
const INT_FIELDS = ['rawRows', 'playerPropRows', 'events', 'players', 'mainLineGroups', 'mainLinesRetained', 'alternates', 'altOnlyGroups', 'providerStandardNotReturned', 'standardPresentGroups', 'unmappedMarkets',
  'routedMarketRows', 'playerIdentityFailures', 'playerNameSuffixStripped', 'eventIdentityFailures', 'ambiguousMainLines', 'truncatedResponses', 'providerErrors', 'duplicates'];
const LINE_TYPE_FIELDS = ['standard', 'demon', 'goblin', 'gimme_pick', 'stat_slice', 'power_up', 'unclassified'];
const SOURCE_RE = /^[a-z0-9_]{1,32}$/;
const clampInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1e7, Math.round(n))) : 0; };
const slug = (v) => (typeof v === 'string' && SOURCE_RE.test(v) ? v : null);
const isoOrNull = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

// Whitelist-copy ONE per-source record. Unknown fields are dropped; `lineTypes.other` keeps only slug-shaped line-type names with clamped counts.
function sanitizeSource(v) {
  const out = { fetchStatus: FETCH_STATUSES.indexOf(v.fetchStatus) >= 0 ? v.fetchStatus : 'UNKNOWN' };
  INT_FIELDS.forEach(k => { out[k] = clampInt(v[k]); });
  out.lineTypes = {}; LINE_TYPE_FIELDS.forEach(k => { out.lineTypes[k] = clampInt(v.lineTypes && v.lineTypes[k]); });
  out.lineTypes.other = {}; Object.entries((v.lineTypes && v.lineTypes.other) || {}).slice(0, 12).forEach(([k, n]) => { if (slug(k)) out.lineTypes.other[k] = clampInt(n); });
  return out;
}

function sanitizeReport(t) {
  const sport = SPORT_KEYS.indexOf(t.sport) >= 0 ? t.sport : null; if (!sport) return { ok: false, errors: ['unknown sport'] };
  const bySportSource = {}; const errors = [];
  Object.entries(t.bySportSource || {}).slice(0, 40).forEach(([k, v]) => { const [sp, src] = String(k).split('|'); if (sp !== sport || !slug(src) || !v || typeof v !== 'object') { errors.push('bad key ' + String(k).slice(0, 40)); return; } bySportSource[sport + '|' + src] = sanitizeSource(v); });
  if (errors.length) return { ok: false, errors };
  return { ok: true, report: {
    version: SITE_TELEMETRY_VERSION, generatedAt: isoOrNull(t.generatedAt), available: true, sport,
    fetchStatus: FETCH_STATUSES.indexOf(t.fetchStatus) >= 0 ? t.fetchStatus : 'UNKNOWN', fetchMode: ['BROAD', 'SPLIT_BY_BOOK', 'SPLIT_BY_MARKET'].indexOf(t.fetchMode) >= 0 ? t.fetchMode : null,
    requests: clampInt(t.requests), pagesFetched: clampInt(t.pagesFetched), rowsReceived: clampInt(t.rowsReceived),
    failedBooks: (Array.isArray(t.failedBooks) ? t.failedBooks : []).map(slug).filter(Boolean).slice(0, 20), skippedEmptyBooks: (Array.isArray(t.skippedEmptyBooks) ? t.skippedEmptyBooks : []).map(slug).filter(Boolean).slice(0, 20),
    bySportSource } };
}

function createStore(opts) {
  opts = opts || {}; const now = opts.now || (() => Date.now()); const rate = new Map(); const RATE_WINDOW_MS = 60 * 1000, RATE_MAX = opts.rateMax || 30; const latest = {};
  const rateOk = (clientId) => { const t = now(); const e = rate.get(clientId) || { start: t, n: 0 }; if (t - e.start > RATE_WINDOW_MS) { e.start = t; e.n = 0; } e.n++; rate.set(clientId, e); if (rate.size > 500) { for (const [k, v] of rate) if (t - v.start > RATE_WINDOW_MS) rate.delete(k); } return e.n <= RATE_MAX; };
  function ingest(body, clientId) {
    if (!rateOk(String(clientId || 'anon'))) return { status: 429, ok: false, error: 'rate limited' };
    let size; try { size = Buffer.byteLength(JSON.stringify(body || null)); } catch (e) { return { status: 400, ok: false, error: 'unreadable body' }; }
    if (size > MAX_PAYLOAD_BYTES) return { status: 413, ok: false, error: 'payload too large' };
    const v = validateSiteTelemetry(body); if (!v.ok) return { status: 400, ok: false, error: 'invalid telemetry', details: v.errors.slice(0, 5) };
    const s = sanitizeReport(body); if (!s.ok) return { status: 400, ok: false, error: 'invalid telemetry', details: s.errors.slice(0, 5) };
    const prev = latest[s.report.sport]; const gen = Date.parse(s.report.generatedAt || ''); if (prev && Number.isFinite(gen) && gen < Date.parse(prev.report.generatedAt || 0)) return { status: 200, ok: true, accepted: false, reason: 'older than the stored report' };
    latest[s.report.sport] = { report: s.report, receivedAt: now() }; return { status: 200, ok: true, accepted: true, sport: s.report.sport };
  }
  const freshnessOf = (receivedAt) => { const age = now() - receivedAt; return age <= FRESH_MS ? 'FRESH' : age <= STALE_MS ? 'STALE' : 'EXPIRED'; };
  function status() {
    const t = now(); const sports = {}; const merged = {}; let worst = 'FRESH', any = false;
    SPORT_KEYS.forEach(sp => { const e = latest[sp]; if (!e) { sports[sp] = { freshness: 'NO_DATA', reported: false }; return; } any = true;
      const fr = freshnessOf(e.receivedAt); if (fr === 'EXPIRED' || (fr === 'STALE' && worst === 'FRESH')) worst = fr;
      const srcs = Object.entries(e.report.bySportSource).map(([k, v]) => ({ source: k.split('|')[1], fetchStatus: v.fetchStatus, rawRows: v.rawRows, playerPropRows: v.playerPropRows, mainLineGroups: v.mainLineGroups, mainLinesRetained: v.mainLinesRetained,
        mainLineRetentionPct: v.mainLineGroups ? Math.round(1000 * v.mainLinesRetained / v.mainLineGroups) / 10 : null, altOnlyGroups: v.altOnlyGroups, providerStandardNotReturned: v.providerStandardNotReturned, standardPresentGroups: v.standardPresentGroups, ambiguousMainLines: v.ambiguousMainLines, unmappedMarkets: v.unmappedMarkets,
        routedMarketRows: v.routedMarketRows, playerIdentityFailures: v.playerIdentityFailures, eventIdentityFailures: v.eventIdentityFailures,
        truncatedResponses: v.truncatedResponses, providerErrors: v.providerErrors, lineTypes: v.lineTypes }));
      const sum = (k) => srcs.reduce((a, s) => a + (s[k] || 0), 0);
      sports[sp] = { reported: true, freshness: fr, generatedAt: e.report.generatedAt, receivedAt: new Date(e.receivedAt).toISOString(), ageSeconds: Math.round((t - e.receivedAt) / 1000), fetchStatus: e.report.fetchStatus, fetchMode: e.report.fetchMode,
        requests: e.report.requests, rowsReceived: e.report.rowsReceived, failedBooks: e.report.failedBooks, skippedEmptyBooks: e.report.skippedEmptyBooks,
        completeness: { sources: srcs.length, mainLineGroups: sum('mainLineGroups'), mainLinesRetained: sum('mainLinesRetained'), ambiguousMainLines: sum('ambiguousMainLines'), altOnlyGroups: sum('altOnlyGroups'), providerStandardNotReturned: sum('providerStandardNotReturned'), unmappedMarkets: sum('unmappedMarkets'),
          truncatedResponses: sum('truncatedResponses'), providerErrors: sum('providerErrors'), complete: e.report.fetchStatus === 'COMPLETE' }, sources: srcs };
      Object.assign(merged, e.report.bySportSource); });
    // `contract` is a beatsedge-site-telemetry/1 object (every reported sport / source) -- exactly what lib/ai's SITE_STATUS evidence will consume.
    const reported = SPORT_KEYS.filter(sp => latest[sp]); const newest = reported.reduce((m, sp) => Math.max(m, Date.parse(latest[sp].report.generatedAt || 0) || 0), 0);
    const contract = { version: SITE_TELEMETRY_VERSION, generatedAt: newest ? new Date(newest).toISOString() : null, available: any, sportsLoaded: reported, sourcesLoaded: [...new Set(Object.keys(merged).map(k => k.split('|')[1]))].sort(), bySportSource: merged };
    return { ok: true, trust: 'client_reported', generatedAt: new Date(t).toISOString(), freshness: any ? worst : 'NO_DATA', thresholds: { freshSeconds: FRESH_MS / 1000, expiredAfterSeconds: STALE_MS / 1000 }, sports, contract };
  }
  return { ingest, status, _latest: latest };
}
module.exports = { createStore, sanitizeReport, MAX_PAYLOAD_BYTES, SPORT_KEYS, FRESH_MS, STALE_MS };
