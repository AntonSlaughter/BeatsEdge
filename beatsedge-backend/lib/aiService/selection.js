'use strict';
// Selection identity validation for the prop-explanation endpoint. The browser sends the selected play + the BeatsEdge ENGINE's own output for it (the engine lives in the page, not on the
// server). That is CLIENT-REPORTED evidence: it is whitelisted field by field, range-checked, internally cross-checked (state vs outputs, probability vs percent, edge vs projection-line, grade
// shape, confluence counts), and any output that cannot be validated is DROPPED -- never repaired, never invented. Placeholder history ("seeded estimate") is never accepted as evidence.
const { text, finite } = require('./text');
const SPORTS = ['nba', 'wnba', 'nfl', 'ncaaf', 'nhl', 'mlb'];
const SPORT_KEY = { basketball_nba: 'nba', basketball_wnba: 'wnba', americanfootball_nfl: 'nfl', americanfootball_ncaaf: 'ncaaf', icehockey_nhl: 'nhl', baseball_mlb: 'mlb' };
const NO_OUTPUT_STATES = ['NOT_YET_MODELED', 'INSUFFICIENT_DATA'];
const GRADE_RE = /^[ABCD][+-]?$/; const BOOK_RE = /^[a-z0-9_]{2,32}$/; const STAT_RE = /^[A-Za-z0-9_~.\-]{1,90}$/; const KEY_RE = /^[A-Za-z0-9_.\-]{1,40}$/;
const WINDOWS = ['season', 'last10', 'last5', 'vsOpp'];

function validateSelection(raw) {
  const errors = [], issues = [], sanitized = []; const rep = (field) => ({ field, list: sanitized });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['selection must be an object'] };
  const sport = SPORTS.indexOf(raw.sport) >= 0 ? raw.sport : (SPORT_KEY[raw.sport] || null); if (!sport) errors.push('sport must be one of ' + SPORTS.join(', '));
  const p = raw.player && typeof raw.player === 'object' ? raw.player : null, pr = raw.prop && typeof raw.prop === 'object' ? raw.prop : null; if (!p) errors.push('player is required'); if (!pr) errors.push('prop is required');
  if (errors.length) return { ok: false, errors };
  const name = text(p.name, 60, rep('player.name')); if (!name) errors.push('player.name is required');
  const statKey = typeof pr.statKey === 'string' && STAT_RE.test(pr.statKey) ? pr.statKey : null; if (!statKey) errors.push('prop.statKey is required (letters, digits, _ ~ . - only)');
  const line = finite(pr.line, -1e4, 1e4); if (line == null) errors.push('prop.line must be a finite number');
  const direction = pr.direction === 'under' ? 'under' : pr.direction === 'over' ? 'over' : null; if (!direction) errors.push('prop.direction must be "over" or "under"');
  const book = typeof pr.book === 'string' && BOOK_RE.test(pr.book) ? pr.book : null; if (!book) errors.push('prop.book must be a provider id (a-z, 0-9, _)');
  if (errors.length) return { ok: false, errors };

  const player = { id: typeof p.id === 'string' || typeof p.id === 'number' ? String(p.id).replace(/[^A-Za-z0-9:_~.\-]/g, '').slice(0, 60) : null, name, sport, team: text(p.team, 12, rep('player.team')), position: text(p.position, 12, rep('player.position')),
    status: text(p.status, 16, rep('player.status')), opponent: text(p.opponent, 12, rep('player.opponent')), isHomeTonight: typeof p.isHomeTonight === 'boolean' ? p.isHomeTonight : undefined, projMin: finite(p.projMin, 0, 80) };
  const mv = pr.move && typeof pr.move === 'object' ? pr.move : null;
  const prop = { statKey, type: text(pr.type, 60, rep('prop.type')), line, direction, book, odds: finite(pr.odds, -100000, 100000), oppOdds: finite(pr.oppOdds, -100000, 100000), oneWay: pr.oneWay === true, eventId: typeof pr.eventId === 'string' ? pr.eventId.replace(/[^A-Za-z0-9:_.\-]/g, '').slice(0, 80) || null : null,
    homeTeam: text(pr.homeTeam, 40, rep('prop.homeTeam')), awayTeam: text(pr.awayTeam, 40, rep('prop.awayTeam')), commenceTimeMs: finite(pr.commenceTimeMs, 0, 4e12), period: text(pr.period, 12, rep('prop.period')),
    lineSource: text(pr.lineSource, 60, rep('prop.lineSource')), marketLine: finite(pr.marketLine, -1e4, 1e4), mktGap: finite(pr.mktGap, -1e4, 1e4), altLine: pr.altLine === true, crossBook: pr.crossBook === true,
    ppKind: typeof pr.ppKind === 'string' && /^[a-z_]{2,24}$/.test(pr.ppKind) ? pr.ppKind : null, modelSupported: pr.modelSupported === false ? false : undefined,
    modelState: NO_OUTPUT_STATES.concat(['PROBABILITY_ONLY']).indexOf(pr.modelState) >= 0 ? pr.modelState : undefined, modelStateReason: text(pr.modelStateReason, 160, rep('prop.modelStateReason')),
    lineStatus: ['AMBIGUOUS_MAIN_LINE', 'LINE_FLAGGED'].indexOf(pr.lineStatus) >= 0 ? pr.lineStatus : null, flagReason: text(pr.flagReason, 140, rep('prop.flagReason')), marketClass: typeof pr.marketClass === 'string' && /^[A-Z_]{3,24}$/.test(pr.marketClass) ? pr.marketClass : null,
    move: mv ? { from: finite(mv.from, -1e4, 1e4), to: finite(mv.to, -1e4, 1e4), delta: finite(mv.delta, -1e4, 1e4), open: finite(mv.open, -1e4, 1e4), openDelta: finite(mv.openDelta, -1e4, 1e4), moveCount: finite(mv.moveCount, 0, 1e4), priceOnly: mv.priceOnly === true } : null };
  prop.providerLineType = text(pr.providerLineType, 24, rep('prop.providerLineType'));

  // ---- model evidence (client-reported engine output) ----
  let e = raw.edge && typeof raw.edge === 'object' && !Array.isArray(raw.edge) ? raw.edge : null; let edge = null; let outputsDropped = false;
  const noOutput = prop.modelSupported === false || NO_OUTPUT_STATES.indexOf(prop.modelState) >= 0 || (e && (e.insufficientData === true || NO_OUTPUT_STATES.indexOf(e.modelState) >= 0));
  if (e && noOutput) { outputsDropped = true; if (!prop.modelState) prop.modelState = NO_OUTPUT_STATES.indexOf(e.modelState) >= 0 ? e.modelState : (e.insufficientData === true ? 'INSUFFICIENT_DATA' : prop.modelState); issues.push({ field: 'edge', issue: 'state is unmodeled / insufficient: every supplied model output was ignored' }); e = null; }
  if (e) {
    const probOnly = prop.modelState === 'PROBABILITY_ONLY' || e.modelState === 'PROBABILITY_ONLY' || /PROBABILITY_ONLY/.test(String(e.gradePolicy || '')) || e.rankingEligible === false;
    const projection = finite(e.projection, 0, 2000), modelProb = finite(e.modelProb, 0, 1); let modelProbPct = finite(e.modelProbPct, 0, 100);
    if (modelProb != null && modelProbPct != null && Math.abs(modelProbPct - Math.round(modelProb * 100)) > 1) { issues.push({ field: 'edge.modelProbPct', issue: 'does not match modelProb: probability dropped' }); modelProbPct = null; }
    let grade = typeof (e.finalGrade || e.grade) === 'string' ? (e.finalGrade || e.grade).trim() : null; if (grade && !GRADE_RE.test(grade)) { issues.push({ field: 'edge.grade', issue: 'not a valid grade: dropped' }); grade = null; }
    if (probOnly && grade) { issues.push({ field: 'edge.grade', issue: 'probability-only markets have no grade: dropped' }); grade = null; }
    let eEdge = finite(e.edge, -2000, 2000); if (eEdge != null && projection != null) { const exp = direction === 'over' ? projection - line : line - projection; if (Math.abs(exp - eEdge) > 0.16 && Math.abs(Math.abs(exp) - Math.abs(eEdge)) > 0.16) { issues.push({ field: 'edge.edge', issue: 'inconsistent with projection and line: edge dropped' }); eEdge = null; } }
    let total = finite(e.totalFactors, 0, 60), green = finite(e.greenCount, 0, 60); if (total != null && green != null && green > total) { issues.push({ field: 'edge.greenCount', issue: 'greater than totalFactors: confluence dropped' }); total = null; green = null; }
    const keep = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : []).filter(f => f && typeof f === 'object' && typeof f.key === 'string' && KEY_RE.test(f.key)).map(f => ({ key: f.key, name: text(f.name, 50, rep('edge.factor.name')) || f.key, supports: f.supports === true ? true : f.supports === false ? false : null, detail: text(f.detail, 160, rep('edge.factor.detail')), label: text(f.label, 80, rep('edge.factor.label')) }));
    let hitRates = null, hitRatesSource = e.hitRatesSource === 'game_log' ? 'game_log' : null;
    if (e.hitRates && typeof e.hitRates === 'object') { if (hitRatesSource) { hitRates = {}; WINDOWS.forEach(w => { const x = e.hitRates[w]; hitRates[w] = x && typeof x === 'object' && finite(x.pick, 0, 100) != null && finite(x.games, 1, 5000) != null ? { pick: x.pick, over: finite(x.over, 0, 100), games: x.games } : null; }); } else issues.push({ field: 'edge.hitRates', issue: 'hit rates are not game-log based (placeholder / estimated): ignored' }); }
    const meta = e.modelMeta && typeof e.modelMeta === 'object' ? { modelVersion: text(e.modelMeta.modelVersion, 60, rep('edge.modelMeta')), state: text(e.modelMeta.state, 20, rep('edge.modelMeta')) } : null;
    edge = { projection, edge: eEdge, edgeSignalPct: finite(e.edgeSignalPct, -1000, 1000), modelProb, modelProbPct, grade: grade || undefined, finalGrade: grade || undefined, prime: probOnly ? false : e.prime === true, confidence: finite(e.confidence, 0, 100), thinData: e.thinData === true,
      totalFactors: total, greenCount: green, factors: keep(e.factors, 24), context: keep(e.context, 8), hitRates, hitRatesSource, modelMeta: meta, ...(probOnly ? { rankingEligible: false, gradePolicy: 'PROBABILITY_ONLY', modelState: 'PROBABILITY_ONLY' } : {}) };
    if (edge.projection == null && edge.modelProb == null && !edge.grade) { outputsDropped = true; issues.push({ field: 'edge', issue: 'no validated output survived: treated as not modeled' }); edge = null; }
  }
  // ---- historical windows (only real ones; seeded placeholders are never accepted) ----
  let windows = null; if (raw.windows && typeof raw.windows === 'object' && !Array.isArray(raw.windows)) { windows = {}; WINDOWS.forEach(w => { const x = raw.windows[w]; windows[w] = x && typeof x === 'object' && x.seeded !== true && finite(x.avg, -1e4, 1e4) != null && finite(x.games, 1, 5000) != null ? { avg: x.avg, games: x.games } : null; }); if (!WINDOWS.some(w => windows[w])) windows = null; }
  const input = { sport, player: Object.assign({}, player, windows ? { statsByKey: { [statKey]: { season: windows.season || { avg: null, games: 0 }, last10: windows.last10 || undefined, last5: windows.last5 || undefined, vsOpp: windows.vsOpp || undefined } } } : {}), prop, edge };
  return { ok: true, input, integrity: { evidenceOrigin: 'CLIENT_REPORTED_ENGINE_OUTPUT', note: 'The BeatsEdge engine runs in the browser; the server validated and sanitized what it sent but did not recompute it.', issues, sanitized, outputsDropped } };
}
module.exports = { validateSelection, SPORTS, SPORT_KEY };
