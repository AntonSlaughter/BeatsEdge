'use strict';
// DOCUMENTED model-coverage policy (static text distilled from CLAUDE.md / the model-freeze docs). It is NOT live telemetry and carries no numbers: it only lets the AI explain WHY a prop has no
// model output. Per-play state always comes from the engine output the page sent (see selection.js); this table is never used to grant a model output.
const SPORT_COVERAGE = Object.freeze({
  nba: 'Frozen BETA model (no opponent-defense effect). Props without enough as-of game history are INSUFFICIENT_DATA; markets the engine has no recipe for are shown as provider lines only.',
  wnba: 'Frozen BETA model (no opponent-defense effect). Validation is pseudo-line only; real-line validation is pending. Unsupported markets are provider lines only.',
  nfl: 'Frozen BETA model (no opponent-defense effect). Most non-yardage / non-reception markets and sub-1 lines are NOT_YET_MODELED and shown as provider lines only.',
  ncaaf: 'Frozen BETA model. Some markets are probability-only by design (no letter grade, no Prime); unsupported markets are provider lines only.',
  mlb: 'Frozen BETA model. Rare-event markets are probability-only by design (no letter grade); markets without a validated recipe are provider lines only.',
  nhl: 'Frozen model covers five families only: shots on goal, goalie saves, anytime goal / assist / point at the 0.5 (or 0) line. Every other NHL market is a real provider line shown as "Model not supported yet".'
});
const STATE_MEANING = Object.freeze({
  FULLY_MODELED: 'a graded engine edge exists (projection, probability, grade, Prime flag, confluence)',
  PROBABILITY_ONLY: 'modeled with a projection and probability but deliberately no letter grade or Prime',
  NOT_YET_MODELED: 'no validated model treatment exists for this market; only the provider line is available',
  INSUFFICIENT_DATA: 'a model exists, but this player/stat lacks the as-of game history it needs; only the provider line is available',
  PROVIDER_ONLY: 'a real provider offering the model never evaluated (unmapped market, flagged or ambiguous line, or player not identified)'
});
module.exports = { SPORT_COVERAGE, STATE_MEANING };
