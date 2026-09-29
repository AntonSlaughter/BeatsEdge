// NHL unlock project -- real market_key -> internal stat classification,
// built from the actual live ParlayAPI discovery pull (10,001 real rows,
// 12 events, 736 players, 2026-09-29). NOT wired into BeatsEdge.html's
// live prop pipeline yet -- that wiring is deliberately deferred to the
// UI-unlock phase (after the release gate), so this module is inert
// today. It exists so that wiring, when it happens, uses a real,
// evidence-based classification instead of guessing at market_key names.
//
// Four buckets, matching this project's validated research (see
// scripts/research-nhl-baselines.js, research-nhl-features.js,
// research-nhl-distributions.js):
//
// MODEL_CANDIDATE: full projection + distribution validated on real
//   chronological holdout data (Shots on Goal: Poisson; Goalie Saves:
//   empirical/NB). Only applies to FULL-game markets -- P1/period-scoped
//   variants of the same stat are explicitly NOT covered (separate,
//   unvalidated market shape).
//
// BINARY_THRESHOLD_CONDITIONAL: P(stat >= 1) only, validated via real
//   Brier score + decile calibration against holdout data, for Goals/
//   Assists/Points. This is NOT the same claim as "Goals/Assists/Points
//   are supported" -- full count projection for these families remains
//   RESEARCH ONLY (poor calibration once discreteness dominates). The
//   binary claim only holds on a FULL-game market at the specific real
//   line each market_key actually uses for "at least 1" -- confirmed
//   from real discovery sample rows, NOT assumed: player_goals/
//   player_assists/player_points use a real 0.5 line, while the
//   Yes/No-style "anytime scorer" markets (player_anytime_goal_scorer
//   and its spelling variants) encode their own boundary as line=0. A
//   line of 1.5+ (e.g. "_alt" variants) was never tested and must NOT
//   use this classification.
//
// UNMAPPED (no entry below): falls through to the existing pipeline's
// "Model not supported yet" DISPLAY ONLY behavior. This is the default
// and deliberately covers: first/last goal scorer (an ordering/
// comparative market across ~12-18 goal events per game, not the same
// problem as "does this player score at least one goal" -- never
// modeled), 2-or-more/3-or-more goal milestones, exact-goals-scored,
// assists_alt/points_alt (untested higher thresholds), power-play
// points, hits, blocked shots, plus/minus, faceoffs (no raw won-count
// column, only a rate), all period-scoped (P1) markets, and every
// team/game-level market (correct score, totals, spreads, moneylines,
// combo/parlay markets -- these aren't this player's individual stat at
// all, confirmed from real sample rows where "player" was actually a
// team matchup or a score string).

const MODEL_CANDIDATE_SHOTS_ON_GOAL = new Set([
  'player_shots_on_goal', 'player_shots', 'player_shots_on_target',
  'prophetx_player_total_shots_on_goal',
  'player_shots_on_goal_milestones_1_or_more', 'player_shots_on_goal_milestones_2_or_more',
  'player_shots_on_goal_milestones_3_or_more', 'player_shots_on_goal_milestones_4_or_more',
  'player_shots_on_goal_milestones_5_or_more', 'player_shots_on_goal_milestones_6_or_more',
  'player_shots_on_goal_milestones_7_or_more', 'player_shots_on_goal_milestones_8_or_more',
]);

const MODEL_CANDIDATE_GOALIE_SAVES = new Set([
  'player_saves', 'player_goalie_saves', 'prophetx_player_total_saves',
  'player_saves_milestones_20_or_more', 'player_saves_milestones_25_or_more',
  'player_saves_milestones_30_or_more', 'player_saves_milestones_40_or_more',
]);

// P1/period-scoped variants of the same underlying stat -- real markets,
// but our validated models are FULL-game only. Never route these through
// the FULL-game distribution.
const PERIOD_SCOPED_MARKETS = new Set([
  'player_shots_on_goal_1st_period', 'player_player_shots_on_goal___1st_period',
  'player_player_shots_on_goal_milestones___in_house', 'player_player_shots_on_goal_ou_in_house_pre_match',
  'player_goals_1st_period', 'player_points_1st_period', 'player_player_points___1st_period',
  'player_player_assists___1st_period', 'player_anytime_goalscorer___1st_period',
]);

// Real discovery data (2026-09-29 live pull) showed two DIFFERENT real
// line conventions for "does this player score >=1 goal": the base O/U
// market (player_goals) uses a real numeric line (0.5, confirmed from
// real sample rows), while the Yes/No-style "anytime scorer" markets
// encode their boundary as line=0 (also confirmed from real sample rows
// -- every anytime_goal_scorer sample row showed line:0, never 0.5).
// Both are validated by the same real research (P(goals>=1), Poisson,
// real Brier skill vs base rate), but each needs its OWN real gate --
// treating them identically would have silently rejected every real
// anytime_goal_scorer row (the single largest real Goals-family market).
const BINARY_THRESHOLD_GOALS_LINE_0 = new Set([
  'player_anytime_goal_scorer', 'anytime_goalscorer', 'player_anytime_goal', 'player_anytime_goalscorer',
]);
const BINARY_THRESHOLD_GOALS_LINE_HALF = new Set(['player_goals']);
const BINARY_THRESHOLD_ASSISTS = new Set(['player_assists']);
const BINARY_THRESHOLD_POINTS = new Set(['player_points']);

/**
 * @param {string} marketKey raw ParlayAPI market_key
 * @param {number|null} line the actual line offered (required for the
 *   binary-threshold families -- only a 0.5 line was ever validated)
 * @param {string|null} period e.g. 'FULL' or 'P1'
 * @returns {{ bucket: string, statKey: string|null, reason: string }}
 */
function classifyNhlMarket(marketKey, line, period) {
  const key = (marketKey || '').toLowerCase();
  const isFullGame = !period || period === 'FULL';

  if (PERIOD_SCOPED_MARKETS.has(key) || (!isFullGame && (MODEL_CANDIDATE_SHOTS_ON_GOAL.has(key) || MODEL_CANDIDATE_GOALIE_SAVES.has(key)))) {
    return { bucket: 'UNMAPPED', statKey: null, reason: 'period-scoped market -- validated model is FULL-game only' };
  }
  if (MODEL_CANDIDATE_SHOTS_ON_GOAL.has(key)) {
    return { bucket: 'MODEL_CANDIDATE', statKey: 'shots_on_goal', reason: 'Poisson, validated on 2026 holdout (research-nhl-distributions.js)' };
  }
  if (MODEL_CANDIDATE_GOALIE_SAVES.has(key)) {
    return { bucket: 'MODEL_CANDIDATE', statKey: 'goalie_saves', reason: 'empirical/NB, validated on 2026 holdout (research-nhl-distributions.js)' };
  }
  if (isFullGame && line === 0 && BINARY_THRESHOLD_GOALS_LINE_0.has(key)) {
    return { bucket: 'BINARY_THRESHOLD_CONDITIONAL', statKey: 'goals_at_least_1', reason: 'P(goals>=1), real Brier/calibration skill vs base rate; anytime-scorer-style market, real line convention is 0 not 0.5' };
  }
  if (isFullGame && line === 0.5 && BINARY_THRESHOLD_GOALS_LINE_HALF.has(key)) {
    return { bucket: 'BINARY_THRESHOLD_CONDITIONAL', statKey: 'goals_at_least_1', reason: 'P(goals>=1), real Brier/calibration skill vs base rate; base O/U market, real line convention is 0.5' };
  }
  if (isFullGame && line === 0.5 && BINARY_THRESHOLD_ASSISTS.has(key)) {
    return { bucket: 'BINARY_THRESHOLD_CONDITIONAL', statKey: 'assists_at_least_1', reason: 'P(assists>=1) only, real Brier/calibration skill vs base rate at line=0.5' };
  }
  if (isFullGame && line === 0.5 && BINARY_THRESHOLD_POINTS.has(key)) {
    return { bucket: 'BINARY_THRESHOLD_CONDITIONAL', statKey: 'points_at_least_1', reason: 'P(points>=1) only, real Brier/calibration skill vs base rate at line=0.5' };
  }
  return { bucket: 'UNMAPPED', statKey: null, reason: 'not validated -- falls through to existing "Model not supported yet" DISPLAY ONLY behavior' };
}

module.exports = { classifyNhlMarket, MODEL_CANDIDATE_SHOTS_ON_GOAL, MODEL_CANDIDATE_GOALIE_SAVES, PERIOD_SCOPED_MARKETS, BINARY_THRESHOLD_GOALS_LINE_0, BINARY_THRESHOLD_GOALS_LINE_HALF, BINARY_THRESHOLD_ASSISTS, BINARY_THRESHOLD_POINTS };
