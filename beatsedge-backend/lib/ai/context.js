'use strict';
// buildAIContext: turns REAL BeatsEdge objects (player, prop, the engine's calculateEdgeScore result) into a structured, provider-independent context.
// PURE and READ-ONLY: it never calls the engine, never computes a projection / probability / grade / Prime / confluence, and never fills a missing value.
// Missing means missing: every absent field is listed in `unavailable` with a reason.
const C = require('./constants');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const DFS_BOOKS = new Set(['prizepicks', 'underdog', 'sleeper', 'pick6', 'betr', 'parlayplay']);

// Which model state does this (prop, edge) carry? Uses the engine's own strings; never infers a state from a missing number.
function resolveModelState(prop, edge) {
  const ps = prop && prop.modelState, es = edge && edge.modelState;
  if (ps === C.ENGINE_STATE_STRINGS.PROBABILITY_ONLY || es === C.ENGINE_STATE_STRINGS.PROBABILITY_ONLY || (edge && /PROBABILITY_ONLY/.test(String(edge.gradePolicy || '')))) return C.MODEL_STATES.PROBABILITY_ONLY;
  if (ps === C.ENGINE_STATE_STRINGS.NOT_YET_MODELED || es === C.ENGINE_STATE_STRINGS.NOT_YET_MODELED) return C.MODEL_STATES.NOT_YET_MODELED;
  if (ps === C.ENGINE_STATE_STRINGS.INSUFFICIENT || es === C.ENGINE_STATE_STRINGS.INSUFFICIENT || (edge && edge.insufficientData === true)) return C.MODEL_STATES.INSUFFICIENT_DATA;
  if (prop && prop.modelSupported === false) return C.MODEL_STATES.PROVIDER_ONLY;
  if (!edge) return C.MODEL_STATES.PROVIDER_ONLY;                                   // nothing evaluated this offering
  if (str(edge.finalGrade || edge.grade)) return C.MODEL_STATES.FULLY_MODELED;
  if (num(edge.modelProb) != null && edge.rankingEligible === false) return C.MODEL_STATES.PROBABILITY_ONLY;   // ungraded modeled probability (e.g. MLB rare-event market)
  return C.MODEL_STATES.PROVIDER_ONLY;                                             // an edge object without a grade or a state: do not promote it to "modeled"
}

function providerLineType(prop) {
  // Only what the prop really carries. Exact provider metadata (odds_type / projection_type) is passed through when a pipeline attaches it; it is never inferred from the line value.
  const label = str(prop.providerLineType) || str(prop.oddsType) || str(prop.projectionType) || str(prop.ppType) || null;
  if (prop.ppKind === 'goblin' || prop.ppKind === 'demon') return { value: String(prop.ppKind).toUpperCase(), providerLabel: label, evidence: 'prop.ppKind' };
  if (label) return { value: String(label).toUpperCase(), providerLabel: label, evidence: 'provider metadata on the prop' };
  if (prop.altLine) return { value: 'ALTERNATE', providerLabel: null, evidence: 'prop.altLine' };
  if (prop.crossBook) return { value: 'CROSS_BOOK', providerLabel: null, evidence: 'prop.crossBook' };
  return { value: 'MAIN', providerLabel: null, evidence: 'not flagged alternate' };
}

function factorEntry(f) {
  const supports = f && f.supports;
  return { key: f.key, name: f.name || f.key, direction: supports === true ? C.DIRECTIONS.SUPPORTS : supports === false ? C.DIRECTIONS.OPPOSES : C.DIRECTIONS.NEUTRAL, detail: str(f.detail), inModel: true };
}

function buildResearch(edge, player, unavailable) {
  const groups = {}; Object.keys(C.FACTOR_GROUPS).forEach(g => { groups[g] = { status: 'UNAVAILABLE', items: [] }; });
  const other = [];
  ((edge && Array.isArray(edge.factors)) ? edge.factors : []).forEach(f => { if (!f || !f.key) return; const e = factorEntry(f); const g = C.FACTOR_KEY_GROUP[f.key]; if (g) { groups[g].items.push(e); groups[g].status = 'AVAILABLE'; } else other.push(e); });
  // Real non-factor facts (no engine direction): the player's availability status and projected minutes. Direction stays UNRATED.
  const status = str(player && player.status);
  if (status) { groups.AVAILABILITY.items.push({ key: 'status', name: 'Player status', direction: C.DIRECTIONS.UNRATED, detail: status, inModel: false }); groups.AVAILABILITY.status = 'AVAILABLE'; }
  const projMin = num(player && player.projMin);
  if (projMin != null) { groups.OPPORTUNITY.items.push({ key: 'projMin', name: 'Projected minutes', direction: C.DIRECTIONS.UNRATED, detail: projMin + ' min', inModel: false }); groups.OPPORTUNITY.status = 'AVAILABLE'; }
  Object.entries(groups).forEach(([g, v]) => { if (v.status === 'UNAVAILABLE') unavailable.push({ field: 'research.' + g, reason: 'No engine factor or supplied fact backs this group for this play.' }); });
  // Context-only items (shown by the engine as labeled context; NOT part of projection / probability / grade).
  const contextOnly = ((edge && Array.isArray(edge.context)) ? edge.context : []).filter(Boolean).map(c => ({ key: c.key, name: c.name || c.key, direction: c.supports === true ? C.DIRECTIONS.SUPPORTS : c.supports === false ? C.DIRECTIONS.OPPOSES : C.DIRECTIONS.NEUTRAL, detail: str(c.detail), inModel: false, label: str(c.label) }));
  return { groups, other, contextOnly };
}

function windowFacts(player, prop) {
  const w = player && player.statsByKey && prop && player.statsByKey[prop.statKey]; if (!w || !w.season) return null;
  const pick = (x) => (x && num(x.avg) != null ? { avg: num(x.avg), games: num(x.games) } : null);
  return { season: pick(w.season), last10: pick(w.last10), last5: pick(w.last5), vsOpp: w.vsOpp && num(w.vsOpp.games) ? pick(w.vsOpp) : null };
}
function hitRateFacts(edge) {
  const h = edge && edge.hitRates; if (!h) return { source: null, windows: null };
  const one = (x) => (x && num(x.pick) != null ? { pickPct: num(x.pick), games: num(x.games) } : null);
  return { source: str(edge.hitRatesSource), windows: { season: one(h.season), last10: one(h.last10), last5: one(h.last5), vsOpp: one(h.vsOpp) } };
}

function buildAIContext(input) {
  input = input || {}; const player = input.player || {}, prop = input.prop || {}, edge = input.edge || null; const unavailable = [];
  const state = resolveModelState(prop, edge); const modeled = !!edge && (state === C.MODEL_STATES.FULLY_MODELED || state === C.MODEL_STATES.PROBABILITY_ONLY); const noOut = C.NO_MODEL_OUTPUT_STATES.indexOf(state) >= 0;
  const grade = modeled && state === C.MODEL_STATES.FULLY_MODELED ? str(edge.finalGrade || edge.grade) : null;
  const projection = modeled ? num(edge.projection) : null, modelEdge = modeled ? num(edge.edge) : null, probRaw = modeled ? num(edge.modelProb) : null;
  const probPct = modeled && num(edge.modelProbPct) != null ? num(edge.modelProbPct) : (probRaw != null ? Math.round(probRaw * 100) : null);   // the engine's own displayed percent when present
  const total = modeled && edge && num(edge.totalFactors) != null ? edge.totalFactors : null, green = modeled && edge && num(edge.greenCount) != null ? edge.greenCount : null;
  const research = buildResearch(modeled ? edge : null, player, unavailable);
  const book = str(prop.book); const move = prop.move && typeof prop.move === 'object' ? prop.move : null;
  const ctx = {
    contractVersion: C.CONTEXT_VERSION,
    selectionKey: [player.id != null ? player.id : str(player.name), prop.statKey, prop.direction || 'over', book, prop.line, prop.eventId || ''].join('|'),
    play: {
      sport: str(player.sport) || str(input.sport),
      player: { name: str(player.name), team: str(player.team), position: str(player.position), status: str(player.status) },
      opponent: str(player.opponent), isHome: typeof player.isHomeTonight === 'boolean' ? player.isHomeTonight : null,
      event: { eventId: str(prop.eventId), home: str(prop.homeTeam), away: str(prop.awayTeam), commenceTimeMs: num(prop.commenceTimeMs), period: str(prop.period) },
      stat: { key: str(prop.statKey), label: str(prop.type) }, direction: prop.direction === 'under' ? 'under' : 'over',
      provider: { book, isDfs: book ? DFS_BOOKS.has(book) : null, lineSource: str(prop.lineSource), line: num(prop.line), odds: num(prop.odds), oppOdds: num(prop.oppOdds), oneWay: !!prop.oneWay,
        lineType: providerLineType(prop), movement: move ? { from: num(move.from), to: num(move.to), delta: num(move.delta), open: num(move.open), openDelta: num(move.openDelta), moves: num(move.moveCount), priceOnly: !!move.priceOnly } : null,
        marketLine: num(prop.marketLine), marketGap: num(prop.mktGap) }
    },
    model: {
      hasOutputs: modeled, state, stateReason: str(prop.modelStateReason) || str(edge && edge.modelStateReason), version: edge && edge.modelMeta ? str(edge.modelMeta.modelVersion) : null, status: edge && edge.modelMeta ? str(edge.modelMeta.state) : null,
      projection, edge: modelEdge, edgeSignalPct: modeled ? num(edge.edgeSignalPct) : null,
      probability: { value: probRaw, pct: probPct },
      grade, prime: state === C.MODEL_STATES.FULLY_MODELED ? edge.prime === true : null,
      confluence: { supporting: green, total, share: total ? Math.round((green / total) * 1000) / 1000 : null },
      confidenceScore: modeled ? num(edge.confidence) : null, thinData: modeled ? edge.thinData === true : null
    },
    research,
    history: { windows: modeled ? windowFacts(player, prop) : null, hitRates: modeled ? hitRateFacts(edge) : { source: null, windows: null } },
    unavailable,
    definitions: C.DEFINITIONS
  };
  // unavailable ledger: every absent field is named, none is filled.
  const need = (cond, field, reason) => { if (!cond) unavailable.push({ field, reason }); };
  need(noOut === false, 'model.outputs', 'State ' + state + ': no projection, probability, edge, grade or Prime exists for this play.');
  need(ctx.model.projection != null, 'model.projection', modeled ? 'The engine returned no projection.' : 'Not modeled.');
  need(ctx.model.probability.pct != null, 'model.probability', modeled ? 'The engine returned no probability.' : 'Not modeled.');
  need(ctx.model.edge != null, 'model.edge', modeled ? 'The engine returned no edge.' : 'Not modeled.');
  need(ctx.model.grade != null, 'model.grade', state === C.MODEL_STATES.PROBABILITY_ONLY ? 'Probability-only market: no letter grade by design.' : 'No validated grade for this play.');
  need(ctx.model.confluence.total != null, 'model.confluence', 'No research factors were evaluated.');
  need(ctx.play.provider.movement != null, 'play.provider.movement', 'No line movement is attached to this prop.');
  need(ctx.play.opponent != null, 'play.opponent', 'No opponent on the player record.'); need(ctx.play.provider.line != null, 'play.provider.line', 'No provider line.');
  need(ctx.history.windows != null, 'history.windows', 'No game-log windows for this stat.'); need(ctx.history.hitRates.windows != null, 'history.hitRates', 'No hit-rate windows.');
  unavailable.push({ field: 'research.usageVolume', reason: 'No usage or volume metric is supplied to the AI context in this version.' });
  // numbers the context really contains: used by the output validator to reject invented statistics
  const nums = []; const walk = (v) => { if (typeof v === 'number' && Number.isFinite(v)) nums.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(ctx.play.provider); walk(ctx.model); walk(ctx.history); [ctx.research.groups, ctx.research.other, ctx.research.contextOnly].forEach(g => JSON.stringify(g).replace(/-?\d+(?:\.\d+)?/g, m => { nums.push(parseFloat(m)); return m; }));
  ctx.allowedNumbers = Array.from(new Set(nums));
  return ctx;
}

// Selected-prop plumbing: the future UI calls this ONCE when a card / row is opened, so "Why is this a good play?" needs no re-typed player / sport / stat / line / provider.
function buildSelectedPropContext(selection) {
  selection = selection || {}; const ctx = buildAIContext(selection);
  return { selected: true, selectionKey: ctx.selectionKey, context: ctx };
}
module.exports = { buildAIContext, buildSelectedPropContext, resolveModelState, providerLineType };
