// NHL MODEL v2 -- the FROZEN, validated formulas, as pure functions (no DB, no I/O).
//
// Source of truth: docs/NHL_MODEL_CANDIDATES_FROZEN_2026-10-05.md and scripts/research/nhl-phase3a/frozen-config.json
// (config SHA-256 below). Confirmed once on the untouched-by-parameters 2026 data (docs/NHL_MODEL_2026_CONFIRMATION_2026-10-05.md):
// SOG S1, Saves V5, Goal B2, Assist B2, Point B3 all PASSED the pre-registered rule.
//
// DO NOT retune: no parameter, window, prior or transform here may change without a new frozen specification and a new
// confirmation. scripts/test-nhl-model-parity.js proves these functions reproduce the research implementation and that
// the constants below equal frozen-config.json; it fails if either drifts.
//
// Boundaries (unchanged): no NHL grade / Prime / confluence, no DvP, no injury / PP / TOI / rest factors, no EV or price logic.

const NHL_MODEL_VERSION = '2026.10-v2';
const NHL_MODEL_SPEC_SHA256 = '0527985d73ff2b49798be29838b4eeaf29585d1c4f14e3e22f7abad9461b42f5'; // frozen-config.json

// Frozen per-family specification.
//   minGames : minimum prior games (unchanged production gates)
//   eb       : shrink lambda0 toward the as-of league prior with weight K (null = none); prior 'position' (F/D skaters) or 'goalie'
//   opp      : opponent-environment factor 1 + strength*(ratio - 1); kind 'allowed' = opponent shots-ALLOWED L15 / league,
//              'offense' = opponent shots-FOR L15 / league; null = no opponent factor (Goal, Assist deliberately have none)
const FAMILY_SPEC = {
  shots_on_goal:      { minGames: 10, eb: null,                          opp: { kind: 'allowed', strength: 1 } },     // S1
  goalie_saves:       { minGames: 8,  eb: { K: 40, prior: 'goalie' },    opp: { kind: 'offense', strength: 0.5 } },   // V5 (TRAIN chose the V3 structure inside V5)
  goals_at_least_1:   { minGames: 15, eb: { K: 40, prior: 'position' },  opp: null },                                 // B2
  assists_at_least_1: { minGames: 15, eb: { K: 20, prior: 'position' },  opp: null },                                 // B2
  points_at_least_1:  { minGames: 15, eb: { K: 10, prior: 'position' },  opp: { kind: 'allowed', strength: 1 } },     // B3
};
const PRIOR_MIN_ROWS = { position: 2000, goalie: 200 };            // prior pool must have at least this many player-games, else no shrinkage
const TEAM_CONTEXT = { windowGames: 15, minTeamGames: 10, minLeagueTeamGames: 200 };
const BINARY_FAMILIES = new Set(['goals_at_least_1', 'assists_at_least_1', 'points_at_least_1']);

const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

// eb(lambda, n, mu, K) = (n*lambda + K*mu) / (n + K); unchanged when mu is unavailable or K == 0.
function eb(lambda, n, mu, K) { return (mu == null || !K) ? lambda : (n * lambda + K * mu) / (n + K); }
// opp(lambda, r, g) = lambda * (1 + g*(r - 1)); unchanged when the ratio is unavailable / not finite or g == 0.
function opp(lambda, r, g) { return (r == null || !Number.isFinite(r) || !g) ? lambda : lambda * (1 + g * (r - 1)); }
// P(stat >= 1) = 1 - exp(-max(0, lambda))  (the unchanged Poisson transform)
function probabilityFromLambda(lambda) { return 1 - Math.exp(-Math.max(0, lambda)); }
// 'D' if position == 'D', else 'F' (C, L, R, and anything unknown/null).
function positionGroup(position) { return position === 'D' ? 'D' : 'F'; }

// As-of league prior: mean of the stat over ALL player-games in the pool. rows: [{position, val}] (already restricted to
// games strictly before the as-of date by the caller). Returns {F, D} (position) or {ALL} (goalie); null when the pool is too small.
function buildPrior(rows, kind) {
  const min = PRIOR_MIN_ROWS[kind === 'goalie' ? 'goalie' : 'position'];
  if (kind === 'goalie') return { ALL: rows.length >= min ? mean(rows.map(r => r.val)) : null };
  const acc = { F: { s: 0, n: 0 }, D: { s: 0, n: 0 } };
  for (const r of rows) { const a = acc[positionGroup(r.position)]; a.s += r.val; a.n++; }
  return { F: acc.F.n >= min ? acc.F.s / acc.F.n : null, D: acc.D.n >= min ? acc.D.s / acc.D.n : null };
}

// Per-player, opponent-INDEPENDENT output for one family, from lambda0 (= production shrinkageFive) and the player's prior-game count n.
//   projection / probability : the value to show when NO opponent adjustment is available (the frozen fallback)
//   baseLambda               : the lambda the opponent factor multiplies (only for families that have one), else null
function familyOutput(family, { lambda0, n, mu }) {
  const spec = FAMILY_SPEC[family];
  const lam = spec.eb ? eb(lambda0, n, mu, spec.eb.K) : lambda0;
  const hasOpp = !!spec.opp;
  if (BINARY_FAMILIES.has(family)) return { projection: null, probability: probabilityFromLambda(lam), baseLambda: hasOpp ? lam : null };
  return { projection: lam, probability: null, baseLambda: hasOpp ? lam : null };
}

// Opponent context, STRICTLY AS-OF: only team-games dated before asOfExclusive (or all stored games when omitted = "now", which is
// what the nightly materializer uses: every stored game is already completed, so none is dated on or after an upcoming game).
// teamGames: [{game_id, team, game_date, sf, sv}] where sf = SUM(skater shots_on_goal), sv = SUM(goalie saves), derived from nhl_player_box
// (the live sync writes no team box). sa (shots against) = the OTHER team's sf in the same game; only games with exactly two team rows count.
function buildOpponentContext(teamGames, { asOfExclusive } = {}) {
  const byGame = new Map();
  for (const r of teamGames) { if (!byGame.has(r.game_id)) byGame.set(r.game_id, []); byGame.get(r.game_id).push(r); }
  const saOf = new Map();
  for (const [, rs] of byGame) if (rs.length === 2) { saOf.set(rs[0].game_id + '|' + rs[0].team, rs[1].sf); saOf.set(rs[1].game_id + '|' + rs[1].team, rs[0].sf); }
  let games = teamGames.filter(r => saOf.has(r.game_id + '|' + r.team) && r.sf != null && saOf.get(r.game_id + '|' + r.team) != null)
    .map(r => ({ team: r.team, game_date: r.game_date, game_id: r.game_id, sf: r.sf, sa: saOf.get(r.game_id + '|' + r.team) }));
  if (asOfExclusive) games = games.filter(g => g.game_date < asOfExclusive);
  const league = games.length >= TEAM_CONTEXT.minLeagueTeamGames ? mean(games.map(g => g.sf)) : null;
  const byTeam = new Map();
  for (const g of games) { if (!byTeam.has(g.team)) byTeam.set(g.team, []); byTeam.get(g.team).push(g); }
  const teams = {};
  for (const [team, tg] of byTeam) {
    tg.sort((a, b) => a.game_date < b.game_date ? -1 : a.game_date > b.game_date ? 1 : (a.game_id < b.game_id ? -1 : 1));
    const n = tg.length; const last = tg.slice(-TEAM_CONTEXT.windowGames);
    const sa15 = n >= TEAM_CONTEXT.minTeamGames ? mean(last.map(g => g.sa)) : null, sf15 = n >= TEAM_CONTEXT.minTeamGames ? mean(last.map(g => g.sf)) : null;
    teams[team] = { games: n, latestGameDate: tg[n - 1].game_date, sa15, sf15, allowed: (sa15 != null && league) ? sa15 / league : null, offense: (sf15 != null && league) ? sf15 / league : null };
  }
  const dates = games.map(g => g.game_date);
  return { league, leagueGames: games.length, asOf: dates.length ? dates.reduce((a, b) => a > b ? a : b) : null, teams };
}

// The deterministic last step, applied once the upcoming opponent is known. teamEntry = opponentContext.teams[opponentAbbr] (or null/undefined).
// Missing entry / ratio => the unadjusted fallback value is returned and adjusted === false (never a fabricated factor).
function applyOpponent(family, baseLambda, teamEntry) {
  const spec = FAMILY_SPEC[family];
  if (!spec || !spec.opp || baseLambda == null) return { projection: null, probability: null, adjusted: false };
  const ratio = teamEntry ? teamEntry[spec.opp.kind] : null;
  const adjusted = ratio != null && Number.isFinite(ratio) && !!spec.opp.strength;
  const lam = opp(baseLambda, ratio, spec.opp.strength);
  return BINARY_FAMILIES.has(family) ? { projection: null, probability: probabilityFromLambda(lam), adjusted } : { projection: lam, probability: null, adjusted };
}

// Metadata the API publishes so clients apply exactly the frozen adjustment without hard-coding constants.
function opponentAdjustmentMeta() {
  const o = {}; for (const [fam, s] of Object.entries(FAMILY_SPEC)) if (s.opp) o[fam] = { factor: s.opp.kind, strength: s.opp.strength, output: BINARY_FAMILIES.has(fam) ? 'probability' : 'projection' };
  return o;
}

module.exports = { NHL_MODEL_VERSION, NHL_MODEL_SPEC_SHA256, FAMILY_SPEC, PRIOR_MIN_ROWS, TEAM_CONTEXT, BINARY_FAMILIES, eb, opp, probabilityFromLambda, positionGroup, buildPrior, familyOutput, buildOpponentContext, applyOpponent, opponentAdjustmentMeta };
