'use strict';
// NHL BLOCKED SHOTS -- BETA integration service (the ONLY consumer of lib/nhlBlocksBeta.js). INACTIVE BY DEFAULT: nothing is computed, read or returned unless the environment flag BETA_NHL_BLOCKED_SHOTS is exactly "1".
// It turns a list of provider OFFERINGS (what the page already holds for a player whose id the page's EXISTING fail-closed resolver resolved) into labelled BETA probabilities. It never resolves a player from a name: only an already-resolved numeric NHL player_id is accepted (a name, a team
// suffix or a missing id is withheld), so the page's collision-aware identity resolution stays the single authority. It reads history through the injected store (lib/historicalStore: local SQLite or Turso) and never writes.
//   WHAT IT PRODUCES: P(blocks >= k) over / under for the TWO-SIDED, MAIN, FULL-GAME, HALF-POINT offerings the adapter classifies as probability-eligible (see nhlBlocksBeta.classifyOffering). Everything else is returned as WITHHELD with a reason.
//   WHAT IT NEVER GRANTS: a letter grade, Prime, a slip / recommendation, EV, Best Plays, Smart Parlay or automatic settlement (the adapter's PERMISSIONS, all false, travel with every result). The frozen NHL model (lib/nhlModel.js) is not imported.
//   HISTORY CURRENCY (fail closed): the frozen candidate needs ice time for every recent game. A player whose latest 10 pre-game rows include one without ice time or blocks (the live nightly sync stored no toi_seconds before its 2026-10-14 fix) is WITHHELD, never silently scored on a stale window.
const FLAG = 'BETA_NHL_BLOCKED_SHOTS';
const LIMITS = Object.freeze({ maxOfferings: 1200, maxPlayers: 500, maxDates: 6, recentRowsChecked: 10, priorsCacheMs: 60 * 60 * 1000, priorsCacheEntries: 8 });
const ID_RE = /^\d{5,9}$/, DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isEnabled = (env) => String((env || process.env)[FLAG] || '') === '1';
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, n) => (typeof v === 'string' && v.length <= n ? v : null);
const etDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
// One offering, sanitized. Anything malformed becomes { invalid: reason } (that offering is withheld; the rest are unaffected).
function sanitize(o, defaultDate) {
  if (!o || typeof o !== 'object') return { invalid: 'OFFERING_NOT_AN_OBJECT' }; const ref = str(o.ref, 160); if (!ref) return { invalid: 'REF_MISSING' };
  const id = o.playerId == null ? null : String(o.playerId); if (!id || !ID_RE.test(id)) return { ref, invalid: 'PLAYER_ID_MISSING_OR_NOT_A_RESOLVED_NHL_ID' };
  const asOf = o.asOfDate == null ? defaultDate : o.asOfDate; if (typeof asOf !== 'string' || !DATE_RE.test(asOf)) return { ref, invalid: 'AS_OF_DATE_INVALID' };
  const sides = Array.isArray(o.available_sides) ? o.available_sides.filter(s => s === 'over' || s === 'under') : null;
  const row = { bookmaker: str(o.bookmaker, 40), market_key: str(o.market_key, 120), market: str(o.market, 120), period: str(o.period, 24), line: num(o.line), odds_type: str(o.odds_type, 24), projection_type: str(o.projection_type, 24), over_price: num(o.over_price), under_price: num(o.under_price), is_dfs_flat_payout: o.is_dfs_flat_payout === true, event_id: str(o.event_id, 80), player: id };
  if (!row.bookmaker || !row.market_key) return { ref, invalid: 'BOOK_OR_MARKET_KEY_MISSING' };
  // A provider row can carry a filler price on a side it does not offer (a DFS row lists over-only with an under price of -100): when the page reports the sides actually available, a side not listed has no price.
  if (sides) { if (!sides.includes('over')) row.over_price = null; if (!sides.includes('under')) row.under_price = null; }
  const gl = Number.isInteger(o.groupLines) && o.groupLines >= 1 && o.groupLines <= 50 ? o.groupLines : null;
  return { ref, playerId: id, asOfDate: asOf, row, groupLines: gl, availableSides: sides };
}
function createService({ store, adapter, nowMs }) {
  const A = adapter || require('../nhlBlocksBeta'); const clock = nowMs || (() => Date.now()); const priorsCache = new Map();
  async function priorsFor(asOf) {
    const hit = priorsCache.get(asOf); if (hit && clock() - hit.at < LIMITS.priorsCacheMs) return hit.priors;
    const rows = await store.query(`SELECT CASE WHEN position = 'D' THEN 'D' ELSE 'F' END AS g, COUNT(*) AS n, SUM(CASE WHEN toi_seconds > 0 THEN toi_seconds / 60.0 END) AS tmin, SUM(CASE WHEN toi_seconds > 0 THEN blocked_shots END) AS b FROM nhl_player_box WHERE game_date < ? AND blocked_shots IS NOT NULL AND toi_seconds IS NOT NULL GROUP BY g`, [asOf]);
    const priors = { F: null, D: null }; rows.forEach(r => { if (r.n >= A.FROZEN.leaguePriorMinRows && r.tmin > 0) priors[r.g] = { n: r.n, ratePerMinute: r.b / r.tmin }; });
    if (priorsCache.size >= LIMITS.priorsCacheEntries) priorsCache.delete(priorsCache.keys().next().value); priorsCache.set(asOf, { at: clock(), priors }); return priors; }
  async function historyFor(ids, maxDate) {
    const by = new Map(); for (const part of chunk([...ids], 400)) { const rows = await store.query(`SELECT player_id, game_id, game_date, position, blocked_shots, toi_seconds FROM nhl_player_box WHERE player_id IN (${part.map(() => '?').join(',')}) AND game_date < ?`, part.concat([maxDate]));
      rows.forEach(r => { const k = String(r.player_id); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }); } by.forEach(a => a.sort((x, y) => (x.game_date < y.game_date ? -1 : x.game_date > y.game_date ? 1 : String(x.game_id).localeCompare(String(y.game_id))))); return by; }
  const withheld = (ref, reason, extra) => Object.assign({ ref, state: 'WITHHELD', withheld: reason, sides: [], permissions: A.PERMISSIONS }, extra || {});
  async function evaluate(body, env) {
    if (!isEnabled(env)) return { status: 200, body: { enabled: false, results: [] } };
    if (!body || !Array.isArray(body.offerings) || !body.offerings.length) return { status: 400, body: { error: 'offerings must be a non-empty array' } }; if (body.offerings.length > LIMITS.maxOfferings) return { status: 400, body: { error: 'too many offerings (max ' + LIMITS.maxOfferings + ')' } };
    const defaultDate = typeof body.asOfDate === 'string' && DATE_RE.test(body.asOfDate) ? body.asOfDate : etDate(clock()); const items = body.offerings.map(o => sanitize(o, defaultDate)); const valid = items.filter(i => !i.invalid);
    const dates = [...new Set(valid.map(i => i.asOfDate))]; if (dates.length > LIMITS.maxDates) return { status: 400, body: { error: 'too many distinct game dates (max ' + LIMITS.maxDates + ')' } };
    const ids = [...new Set(valid.map(i => i.playerId))]; if (ids.length > LIMITS.maxPlayers) return { status: 400, body: { error: 'too many players (max ' + LIMITS.maxPlayers + ')' } };
    const maxDate = dates.sort().slice(-1)[0] || defaultDate; const hist = ids.length ? await historyFor(ids, maxDate) : new Map(); const priorsByDate = {}; for (const d of dates) priorsByDate[d] = await priorsFor(d);
    const results = items.map(it => {
      if (it.invalid) return withheld(it.ref || null, it.invalid);
      const cls = A.classifyOffering(it.row, it.groupLines == null ? Infinity : it.groupLines); /* an unknown count of posted lines is not "one line": a book that flags no main line is then not identified (fail closed) */ if (!cls) return withheld(it.ref, 'NOT_A_BLOCKED_SHOTS_MARKET'); const meta = { classification: { platform: cls.platform, lineType: cls.lineType, label: cls.label, line: cls.line, offeredSides: cls.offeredSides, probabilityEligible: cls.probabilityEligible, withheldBecause: cls.withheldBecause, settlement: cls.settlement.status } };
      if (!cls.probabilityEligible) return withheld(it.ref, cls.withheldBecause, meta);
      const rows = (hist.get(it.playerId) || []).filter(r => r.game_date < it.asOfDate); if (!rows.length) return withheld(it.ref, 'NO_HISTORY_FOR_PLAYER_ID', meta);
      const last = rows[rows.length - 1]; if (last.position == null) return withheld(it.ref, 'GOALIE_OR_POSITION_UNKNOWN', meta);
      const recent = rows.slice(-LIMITS.recentRowsChecked); if (recent.some(r => !Number.isFinite(r.blocked_shots) || !Number.isFinite(r.toi_seconds))) return withheld(it.ref, 'HISTORY_NOT_CURRENT_MISSING_ICE_TIME', meta);
      const feats = A.playerFeatures(rows.map(r => ({ date: r.game_date, gameId: r.game_id, blocks: r.blocked_shots, toi: r.toi_seconds })), it.asOfDate, last.position, priorsByDate[it.asOfDate]); if (!feats.eligible) return withheld(it.ref, feats.reason, meta);
      const probs = A.thresholdProbabilities(feats), sides = [];
      for (const dir of cls.offeredSides) { const s = A.sideProbability(probs, cls.line, dir); sides.push(s.probability == null ? { dir, probability: null, withheld: s.withheld } : { dir, probability: s.probability, threshold: s.threshold }); }
      if (!sides.some(s => s.probability != null)) return withheld(it.ref, sides[0] ? sides[0].withheld : 'NO_SIDE', meta);
      return Object.assign({ ref: it.ref, state: 'BETA', modelVersion: A.VERSION, withheld: null, sides, features: { priorGames: feats.priorGames, iceTimeGames: feats.iceTimeGames, expectedIceMinutes: feats.expectedIceMinutes }, permissions: A.PERMISSIONS }, meta); });
    const m = A.MODEL_META; return { status: 200, body: { enabled: true, asOfDates: dates, model: { version: A.VERSION, state: m.state, family: m.family, stat: m.stat, output: m.output, gradePolicy: m.gradePolicy, realLineValidation: m.realLineValidation, registeredVerdict: m.registeredVerdict, approvedPolicyAssessment: m.approvedPolicyAssessment, knownLimits: m.knownLimits, permissions: A.PERMISSIONS }, results,
      counts: { offerings: results.length, beta: results.filter(r => r.state === 'BETA').length, withheld: results.filter(r => r.state === 'WITHHELD').length } } }; }
  return { evaluate, isEnabled, priorsFor, LIMITS };
}
module.exports = { FLAG, LIMITS, isEnabled, createService, sanitize };
