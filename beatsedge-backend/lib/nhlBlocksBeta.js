'use strict';
// NHL SKATER BLOCKED SHOTS -- isolated BETA adapter, version `nhl-blocks-beta-v1`. NOT ACTIVATED: nothing in server.js, routes/, cron/, the page or any other lib file requires this module, and `ACTIVATED` is a constant false.
// It packages the FROZEN research candidate C1 of `nhl-hits-blocks-research-v0.1` (scripts/research/nhl-hits-blocks, frozen-v0.1.json, sha256 below) as pure functions, separately versioned from the frozen NHL model (lib/nhlModel.js, 2026.10-v2),
// which it does not import and does not change. No refit happens here: every constant is the frozen one, pinned by scripts/test-nhl-blocks-beta.js against the research file.
//
// TWO READINESS TRACKS (kept apart on purpose):
//   1. STATISTICAL MODEL (this file): P(blocked shots >= k) for k = 1..4 from as-of history. State BETA (probability only). Evidence and limits are in docs/COVERAGE_INVENTORY_RECONCILED_2026-10-12.md section 8f: the registered stricter slope test FAILED on the 2025
//      development fold (that verdict stands); the approved BETA criteria are met; the 2026 over-prediction (+1.2 points) and the pooled regular-season / playoff history are limitations; no real-price evidence exists.
//   2. SPORTSBOOK SETTLEMENT (SETTLEMENT below): what each platform's first-party rules establish for a blocked-shots offering. Unresolved rules are recorded as unresolved. Whatever the state of track 2, this adapter NEVER enables a grade, Prime, a slip /
//      recommendation, an EV figure or automatic settlement (`PERMISSIONS`), and it classifies every provider row by platform + label + period + line type -- never by market key alone (the key `player_blocks` carries two different markets).
const FROZEN = Object.freeze({
  sourceVersion: 'nhl-hits-blocks-research-v0.1', sourceFile: 'scripts/research/nhl-hits-blocks/frozen-v0.1.json', sourceSha256: '9c49743fcf5d62d6c0264ccfaa60d89b09786a98bc8937922dbf64794639291e', candidate: 'C1', fitSeasons: Object.freeze([2024, 2025]),
  kMinutes: 200, halfLifeGames: 40, nbDispersion: Object.freeze({ F: 6.423936982450981, D: 11.886459300546608 }),
  minPriorGames: 15, minIceTimeGames: 10, iceTimeWindow: 10, leaguePriorMinRows: 2000, thresholds: Object.freeze([1, 2, 3, 4]) });
const VERSION = 'nhl-blocks-beta-v1', ACTIVATED = false;
const MODEL_META = Object.freeze({ modelVersion: VERSION, state: 'BETA', family: 'nhl_blocked_shots', stat: 'skater blocked shots, full game', output: 'P(blocked shots >= k), k = 1..4 (half-point lines 0.5-3.5)', gradePolicy: 'PROBABILITY_ONLY', calibration: 'none applied (the frozen candidate is used as fitted)',
  realLineValidation: 'PENDING / DATA GAP', registeredVerdict: 'NOT a candidate under its own registered stricter slope rule (2025 dev fold: slope 0.944 [0.921, 0.967])', approvedPolicyAssessment: 'meets the BETA statistical criteria; not promoted: settlement rules unresolved for the displayed books',
  knownLimits: Object.freeze(['2025 development fold ~5.6% over-confident (registered stricter test failed there)', '2026 confirmation mean over-prediction about +1.2 points at the primary line (league rate fell)', 'history mixes regular-season and playoff games (6.1% of skater rows)', 'no archived real prices: no profitability or edge claim']) });
// every permission the adapter could ever grant is false: a probability is shown (when classification allows) as a labelled BETA estimate and nothing else
const PERMISSIONS = Object.freeze({ gradeLetter: false, prime: false, slipOrRecommendation: false, expectedValue: false, automaticSettlement: false, bestPlays: false, smartParlay: false });
// ---------------- the frozen negative binomial ----------------
const lgamma = (x) => { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const cj of c) s += cj / ++y; return -t + Math.log(2.5066282746310005 * s / x); };
const nbP = (m, r, k) => { m = Math.max(m, 1e-9); return Math.exp(lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(r / (r + m)) + k * Math.log(m / (r + m))); };
const nbSF = (m, r, k) => { let c = 0; for (let j = 0; j < k; j++) c += nbP(m, r, j); return Math.min(1 - 1e-12, Math.max(1e-12, 1 - c)); };
const group = (pos) => (pos === 'D' ? 'D' : 'F');
// ---------------- as-of inputs ----------------
// rows: league skater rows STRICTLY BEFORE the target date: { pos, blocks, toi (seconds) }. Goalies / null blocks are not skater rows and must not be passed.
function computeLeaguePriors(rows) { const a = { F: { n: 0, tmin: 0, b: 0 }, D: { n: 0, tmin: 0, b: 0 } }; (rows || []).forEach(r => { if (!Number.isFinite(r.blocks) || !Number.isFinite(r.toi)) return; const g = a[group(r.pos)]; g.n++; if (r.toi > 0) { g.tmin += r.toi / 60; g.b += r.blocks; } });
  const out = {}; ['F', 'D'].forEach(g => { out[g] = a[g].n >= FROZEN.leaguePriorMinRows && a[g].tmin > 0 ? { n: a[g].n, ratePerMinute: a[g].b / a[g].tmin } : null; }); return out; }
// playerRows: this skater's rows { date: 'YYYY-MM-DD', gameId, blocks, toi }, any order; only rows with date < asOfDate are used (a same-day row never is).
function playerFeatures(playerRows, asOfDate, pos, priors) {
  const g = group(pos), L = priors && priors[g]; if (!L) return { eligible: false, reason: 'LEAGUE_PRIOR_UNAVAILABLE', group: g };
  const rows = (playerRows || []).filter(r => r && r.date < asOfDate && Number.isFinite(r.blocks) && Number.isFinite(r.toi)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.gameId).localeCompare(String(b.gameId))));
  const lam = Math.pow(0.5, 1 / FROZEN.halfLifeGames); let sMin = 0, sB = 0; const toiHist = [];
  rows.forEach(r => { if (r.toi > 0) { const m = r.toi / 60; sMin = sMin * lam + m; sB = sB * lam + r.blocks; toiHist.push(m); } });
  if (rows.length < FROZEN.minPriorGames) return { eligible: false, reason: 'INSUFFICIENT_HISTORY', priorGames: rows.length, group: g };
  if (toiHist.length < FROZEN.minIceTimeGames) return { eligible: false, reason: 'INSUFFICIENT_ICE_TIME_HISTORY', priorGames: rows.length, group: g };
  const w = toiHist.slice(-FROZEN.iceTimeWindow), ePT = w.reduce((a, b) => a + b, 0) / w.length, rate = (sB + FROZEN.kMinutes * L.ratePerMinute) / (sMin + FROZEN.kMinutes);
  return { eligible: true, reason: null, group: g, priorGames: rows.length, iceTimeGames: toiHist.length, expectedIceMinutes: ePT, shrunkRatePerMinute: rate, mean: ePT * rate };
}
// P(blocks >= k) for k = 1..4 from a feature object; null when not eligible
function thresholdProbabilities(features) { if (!features || !features.eligible) return null; const r = FROZEN.nbDispersion[features.group]; return { 1: nbSF(features.mean, r, 1), 2: nbSF(features.mean, r, 2), 3: nbSF(features.mean, r, 3), 4: nbSF(features.mean, r, 4) }; }
// probability of ONE offering's side at a half-point line 0.5-3.5 (Over = P(>= line + 0.5); Under = 1 - Over). Integer lines (a push is possible) and out-of-range lines are withheld: the push semantics of every book are unresolved.
function sideProbability(probs, line, side) {
  if (!probs) return { probability: null, withheld: 'NOT_ELIGIBLE' }; if (side !== 'over' && side !== 'under') return { probability: null, withheld: 'SIDE_UNKNOWN' }; if (!Number.isFinite(line)) return { probability: null, withheld: 'LINE_MISSING' };
  if (Math.abs(line - Math.round(line)) < 1e-9) return { probability: null, withheld: 'INTEGER_LINE_PUSH_RULE_UNRESOLVED' }; const k = line + 0.5; if (!(k >= 1 && k <= 4) || !Number.isInteger(k)) return { probability: null, withheld: 'LINE_OUTSIDE_FROZEN_RANGE' };
  const over = probs[k]; return { probability: side === 'over' ? over : 1 - over, threshold: k, withheld: null }; }
// ---------------- provider-row classification: platform + label + period + line type, never the market key alone ----------------
const LINE_TYPES = Object.freeze({ MAIN: 'MAIN', MAIN_SINGLE_LINE: 'MAIN_SINGLE_LINE', ALTERNATE: 'ALTERNATE', GOBLIN: 'GOBLIN', DEMON: 'DEMON', MILESTONE: 'MILESTONE', IN_HOUSE_MAIN: 'IN_HOUSE_MAIN', IN_HOUSE_MILESTONE: 'IN_HOUSE_MILESTONE' });
const STAT_LABEL_RE = /^\s*blocked shots\s*$/i;
// row: a flat ParlayAPI row { bookmaker, market_key, market, period, line, odds_type, projection_type, over_price, under_price, is_dfs_flat_payout, event_id, player }; groupLines (optional): how many distinct lines the same (event, player, platform, key) has
function classifyOffering(row, groupLines) {
  const platform = String(row.bookmaker || '').toLowerCase(), key = String(row.market_key || ''), label = String(row.market || ''), text = key + ' ' + label; if (!/block/i.test(text)) return null;
  const type = String(row.odds_type || row.projection_type || '').toLowerCase(), sides = []; if (row.over_price != null) sides.push('over'); if (row.under_price != null) sides.push('under');
  let lineType, reason = null;
  if (/in[_ ]house/i.test(text)) lineType = /milestone/i.test(text) ? LINE_TYPES.IN_HOUSE_MILESTONE : LINE_TYPES.IN_HOUSE_MAIN;
  else if (/milestone/i.test(text)) lineType = LINE_TYPES.MILESTONE;
  else if (type === 'goblin') lineType = LINE_TYPES.GOBLIN; else if (type === 'demon') lineType = LINE_TYPES.DEMON; else if (type === 'alternate') lineType = LINE_TYPES.ALTERNATE; else if (type === 'standard') lineType = LINE_TYPES.MAIN;
  else if (STAT_LABEL_RE.test(label) && (groupLines == null || groupLines === 1)) lineType = LINE_TYPES.MAIN_SINGLE_LINE; else { lineType = null; reason = 'MAIN_LINE_NOT_IDENTIFIED'; }
  const isStatLabel = STAT_LABEL_RE.test(label), full = String(row.period || '').toUpperCase() === 'FULL', main = lineType === LINE_TYPES.MAIN || lineType === LINE_TYPES.MAIN_SINGLE_LINE, line = row.line;
  const whyNot = !isStatLabel ? 'LABEL_IS_NOT_THE_BLOCKED_SHOTS_MAIN_MARKET' : !full ? 'PERIOD_NOT_FULL' : !main ? (lineType === LINE_TYPES.ALTERNATE || lineType === LINE_TYPES.GOBLIN || lineType === LINE_TYPES.DEMON ? 'ALT_LINE_RULE' : (reason || 'LINE_TYPE_' + lineType)) : sides.length !== 2 ? 'ONE_SIDED' : null;
  return { family: 'nhl_blocked_shots', platform, marketKey: key, label, period: row.period || null, lineType, line, offeredSides: sides, twoSided: sides.length === 2, integerLine: Number.isFinite(line) && Math.abs(line - Math.round(line)) < 1e-9, flatPayout: !!row.is_dfs_flat_payout,
    statEligible: isStatLabel && full && lineType !== LINE_TYPES.IN_HOUSE_MAIN && lineType !== LINE_TYPES.IN_HOUSE_MILESTONE && lineType !== LINE_TYPES.MILESTONE, probabilityEligible: whyNot === null, withheldBecause: whyNot, settlement: SETTLEMENT[platform] || SETTLEMENT.unknown, permissions: PERMISSIONS };
}
// classify a whole row set (adds the single-line group context used for books that do not flag the main line)
function classifyRows(rows) { const cnt = new Map(); const gk = (r) => [r.event_id, r.player, r.bookmaker, r.market_key].join('|'); const lines = new Map(); (rows || []).forEach(r => { if (!/block/i.test(String(r.market_key) + ' ' + String(r.market))) return; const k = gk(r); if (!lines.has(k)) lines.set(k, new Set()); lines.get(k).add(r.line); });
  return (rows || []).map(r => classifyOffering(r, (lines.get(gk(r)) || new Set()).size)).filter(Boolean); }
// ---------------- sportsbook settlement readiness (recorded as found; 2026-10-14) ----------------
const SETTLEMENT = Object.freeze({
  nhl: Object.freeze({ role: 'official statistic', status: 'STAT_DEFINITION_ESTABLISHED', documented: ['NHL stats glossary (api.nhle.com/stats/rest/en/glossary, term BkS): "A blocked shot occurs when an opponent\'s shot attempt is blocked by a skater, with his stick or body"; recorded since 2002-03; credited to the blocker', 'NHL Official Rules 2019-20 Rule 36: Real Time Scorers record all official statistics "in strict conformity with the instructions provided by the League"; the rulebook has no blocked-shot paragraph (Rule 33 covers goals and assists)'], unresolved: ['the current-season rulebook could not be located (2019-20 read); the league\'s scorer instructions are not public'] }),
  prizepicks: Object.freeze({ status: 'UNRESOLVED_NEEDS_IN_APP_DOCUMENT', documented: ['no participation "in a single second" = DNP (generic, all sports; league thresholds are "in the in-app scoring chart")', '"Tied Projection": not a correct or incorrect pick (generic)', 'official box score is authoritative over third-party stats; results use originally posted stats; later corrections are not applied after settlement; scoring partners named (SportRadar, Genius, Stats Perform, Grid) without league mapping'], unresolved: ['STANDARD half-point lines: ONE residual rule, the NHL skater participation threshold that defines a DNP (the generic rule says "a single second"; the league threshold is "in the in-app scoring chart" -- the in-app NHL scoring chart). Everything else that bears on a Standard half-point line is established: the stat definition (NHL glossary), ties are impossible on a half-point line, results use the originally posted stats. Size of the residual: 56 of 150,893 skater rows (0.04%) have under one minute of ice time and 773 (0.5%) under five, so any plausible skater threshold barely changes the population; only an "entire game" requirement would', 'Goblin / Demon settlement and the tie rule for integer lines (not needed for Standard half-point eligibility; those offerings stay withheld)'], standardHalfPointResidual: 'NHL skater DNP participation threshold (in-app chart)' }),
  underdog: Object.freeze({ status: 'PARTIAL_PAGE_NOT_DIRECTLY_RETRIEVABLE', documented: ['(search-tool excerpt of help.underdogsports.com, page returned 403 to scripted fetches) skaters need time on ice per the governing body box score; one second makes selections valid; NHL selections settle on official league statistics'], unresolved: ['NHL tie rule', 'stat-correction handling', 'direct retrieval of the NHL scoring article'] }),
  sleeper: Object.freeze({ status: 'UNRESOLVED', documented: ['stats page defines blocked shots as a non-goalie blocking or deflecting a shot attempt and preventing it reaching the net; a dressed player with at least one shift and no credited hit or faceoff win is scored 0 (stated for hits and faceoffs)'], unresolved: ['DNP / void rule', 'tie rule', 'stat source and corrections'] }),
  fliff: Object.freeze({ status: 'UNRESOLVED', documented: [], unresolved: ['no first-party rule found (void, tie, stat source)'] }),
  bovada: Object.freeze({ status: 'NOT_THIS_MARKET', documented: [], unresolved: ['"Blocks Milestones" is a different (ladder, yes-only) market that shares the key player_blocks'] }),
  draftkings: Object.freeze({ status: 'HELD', documented: [], unresolved: ['"In House Pre Match" / "In House" qualifier undocumented'] }),
  unknown: Object.freeze({ status: 'UNRESOLVED', documented: [], unresolved: ['platform not assessed'] }) });
module.exports = { VERSION, ACTIVATED, FROZEN, MODEL_META, PERMISSIONS, SETTLEMENT, LINE_TYPES, computeLeaguePriors, playerFeatures, thresholdProbabilities, sideProbability, classifyOffering, classifyRows };
