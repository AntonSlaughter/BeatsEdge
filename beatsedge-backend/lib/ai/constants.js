'use strict';
// BeatsEdge AI foundation -- canonical constants. PURE (no I/O, no Node-only APIs): safe to load in Node and to inline into the browser later.
// The AI layer EXPLAINS real BeatsEdge output; it is never the source of truth for projection, probability, grade, Prime, confluence, provider line or model state.
const CONTEXT_VERSION = 'beatsedge-ai-context/1';
// Model states. The three engine constants are the repository's canonical strings (BeatsEdge.html: MODEL_STATE_INSUFFICIENT / _NOT_YET_MODELED / _PROBABILITY_ONLY).
const MODEL_STATES = Object.freeze({
  FULLY_MODELED: 'FULLY_MODELED',            // a real graded engine edge (projection, probability, grade, Prime flag, confluence)
  PROBABILITY_ONLY: 'PROBABILITY_ONLY',      // modeled: projection + probability, deliberately NO letter grade / Prime / ranking (NCAAF passTds & longRush, MLB rare events)
  NOT_YET_MODELED: 'NOT_YET_MODELED',        // the offering has no validated treatment: real provider line only
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',    // a model exists but this entity lacks the history: real provider line only
  PROVIDER_ONLY: 'PROVIDER_ONLY'             // a real provider offering the model never evaluated (unmapped market / modelSupported:false without a state)
});
const ENGINE_STATE_STRINGS = Object.freeze({ INSUFFICIENT: 'INSUFFICIENT_DATA', NOT_YET_MODELED: 'NOT_YET_MODELED', PROBABILITY_ONLY: 'PROBABILITY_ONLY' });
// States in which projection / probability / edge / grade / Prime MUST be null (nothing is ever invented for them).
const NO_MODEL_OUTPUT_STATES = Object.freeze([MODEL_STATES.NOT_YET_MODELED, MODEL_STATES.INSUFFICIENT_DATA, MODEL_STATES.PROVIDER_ONLY]);
// Research factor groups. A group is AVAILABLE only when a real engine factor / field backs it; the engine does not use all six for every sport.
const FACTOR_GROUPS = Object.freeze({ OPPORTUNITY: 'OPPORTUNITY', RECENT_FORM: 'RECENT_FORM', MATCHUP: 'MATCHUP', AVAILABILITY: 'AVAILABILITY', GAME_ENVIRONMENT: 'GAME_ENVIRONMENT', EFFICIENCY: 'EFFICIENCY' });
// engine factor key -> group. Keys not listed here are surfaced under OTHER (never forced into a group). Source: _calculateEdgeScoreImpl factors.push({key: ...}).
const FACTOR_KEY_GROUP = Object.freeze({ minutes: 'OPPORTUNITY', recent: 'RECENT_FORM', season: 'RECENT_FORM', hitrate: 'RECENT_FORM', matchup: 'MATCHUP', defense: 'MATCHUP', oppdef: 'MATCHUP', vsopp: 'MATCHUP', simdef: 'MATCHUP', pace: 'GAME_ENVIRONMENT', venue: 'GAME_ENVIRONMENT', rest: 'GAME_ENVIRONMENT' });
const DIRECTIONS = Object.freeze({ SUPPORTS: 'SUPPORTS', OPPOSES: 'OPPOSES', NEUTRAL: 'NEUTRAL', UNRATED: 'UNRATED' });   // UNRATED = a real fact with no engine-assigned direction
const INTENTS = Object.freeze(['WHY_GOOD', 'WHY_BAD', 'WHY_OVER', 'WHY_UNDER', 'BIGGEST_RISK', 'SUPPORTING_FACTORS', 'OPPOSING_FACTORS', 'EXPLAIN_GRADE', 'EXPLAIN_PROBABILITY', 'EXPLAIN_EDGE', 'EXPLAIN_PRIME', 'EXPLAIN_PLAY_SIMPLE', 'WHAT_CHANGED', 'RESULT_ANALYSIS', 'SITE_STATUS', 'UNKNOWN']);
const DEFINITIONS = Object.freeze({
  MODEL_PROBABILITY: 'The validated model probability that the selected side hits. It is the only probability BeatsEdge states.',
  FACTOR_CONFLUENCE: 'The share of the research factors that were AVAILABLE for this play and point in the selected direction. It is a count of aligned factors, NOT a probability.',
  MODEL_EDGE: 'The model projection relative to the provider line, in the direction of the selected side (positive favors the side).',
  GRADE: 'The validated BeatsEdge letter grade. Absent for probability-only and unmodeled plays.',
  PRIME: 'A separate BeatsEdge designation (high confluence and a large model edge). Independent of the grade letter; absent unless the engine set it.'
});
// Limits that keep every future LLM request compact (cost control).
const COST_LIMITS = Object.freeze({ maxEvidenceChars: 2600, maxFactorsPerSide: 8, maxListItems: 12, approxCharsPerToken: 4, maxRequestTokens: 1400 });
module.exports = { CONTEXT_VERSION, MODEL_STATES, ENGINE_STATE_STRINGS, NO_MODEL_OUTPUT_STATES, FACTOR_GROUPS, FACTOR_KEY_GROUP, DIRECTIONS, INTENTS, DEFINITIONS, COST_LIMITS };
