// News Intelligence — Phase 2D: research-only news impact signals.
//
// Answers "how should this VERIFIED news affect the research context for
// this player?" -- never "should I bet this prop?" A deterministic,
// rule-based mapping from Phase 2C's already-validated classifications
// (lib/newsClassifier.js) to a small, controlled research vocabulary. No
// LLM, no paid service, no new credential, no new provider. Does not
// touch the model: no newsAdj/injuryAdj/roleAdj/minutesAdj/opportunityAdj
// is added anywhere, and calculateEdgeScore/GRADE_CUTOFFS/PROB_CALIB/
// FAMILY_CALIB/PRIME_FAMILY/findPrimePicks/findTopPicks/findPlusEVPicks/
// confluence/projection/model probability/edge/grade/Prime/prop
// eligibility are never read or written by this module.
//
// Architecture: this module ONLY consumes Phase 2C's `classifications`
// array -- it never re-reads title/summary text itself and never
// introduces a second player-matching system. Phase 2C already resolves
// at most one player per article (see lib/newsClassifier.js's header), so
// Phase 2D inherits that same constraint for free: an impact signal is
// only ever produced FROM a classification that already exists, for the
// ONE player that classification already belongs to. There is no code
// path anywhere in this file that can reference or infer anything about
// a second ("teammate") player -- Step 4/17's "no secondary effects"
// requirement holds structurally, not by a special-cased check.
//
// Computed at READ TIME (mirrors Phase 2C's own justification, see that
// module's header): cheap (one object-key lookup per classification,
// no regex), and a future mapping fix applies retroactively to
// already-ingested articles with zero migration/backfill.

// ── Impact taxonomy (Step 2) ──────────────────────────────────────────
const IMPACT_TAXONOMY = [
  'OPPORTUNITY_UP', 'OPPORTUNITY_DOWN', 'AVAILABILITY_UP', 'AVAILABILITY_DOWN',
  'STARTING_UP', 'STARTING_DOWN', 'MINUTES_UP', 'MINUTES_DOWN', 'ROLE_UP', 'ROLE_DOWN',
  'RETURN', 'TRANSACTION', 'ROSTER_CHANGE', 'GAME_CONTEXT', 'WEATHER_CONTEXT', 'NO_DIRECT_IMPACT'
];
const DIRECTIONS = ['UP', 'DOWN', 'NEUTRAL'];
const STRENGTHS = ['HIGH', 'MEDIUM', 'LOW'];

// ── Mapping table (Steps 3, 5, 6) ─────────────────────────────────────
// Keyed by "CATEGORY:STATUS" using Phase 2C's OWN literal strings (see
// lib/newsClassifier.js -- confirmed by direct read, not assumed). impact/
// direction/strength are all hand-specified per entry rather than
// derived from the input classification's own `direction` field, so this
// mapping is fully self-contained and doesn't silently drift if Phase
// 2C's internal `direction` values ever change.
//
// A few keys below (marked DORMANT) describe classifications Phase 2C's
// CURRENT regex rules never actually emit from real text today (it has
// no "increased minutes" or "reduced opportunity" detector) -- they are
// included because the phase spec's own Step 3 lists them as required
// mappings, kept here for forward-compatibility if Phase 2C ever adds
// that detection, and called out explicitly in the live-validation
// report so "supported" is never confused with "observed live."
const IMPACT_MAP = {
  // AVAILABILITY -- QUESTIONABLE/DOUBTFUL never escalated to OUT-strength;
  // each stays its own distinct strength tier (Step 3's explicit example).
  'AVAILABILITY:OUT': { impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH' },
  'AVAILABILITY:DOUBTFUL': { impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'MEDIUM' },
  'AVAILABILITY:QUESTIONABLE': { impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'MEDIUM' },
  'AVAILABILITY:PROBABLE': { impact: 'AVAILABILITY_UP', direction: 'UP', strength: 'LOW' },
  'AVAILABILITY:AVAILABLE': { impact: 'AVAILABILITY_UP', direction: 'UP', strength: 'LOW' },
  'AVAILABILITY:LIMITED': { impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'LOW' },

  // STARTING_STATUS -- a confirmed lineup fact either way, so both HIGH.
  'STARTING_STATUS:STARTING': { impact: 'STARTING_UP', direction: 'UP', strength: 'HIGH' },
  'STARTING_STATUS:NOT_STARTING': { impact: 'STARTING_DOWN', direction: 'DOWN', strength: 'HIGH' },

  // ROLE_CHANGE -- Phase 2C's own regexes for this category are inherently
  // forward-looking ("will see an increased role", "role is expected to
  // grow"), matching Step 6's MEDIUM bucket ("expected increased/reduced
  // role"), not the HIGH bucket's "explicit major role change" (which
  // Phase 2C has no separate, more-definite detector for).
  'ROLE_CHANGE:INCREASED_ROLE': { impact: 'ROLE_UP', direction: 'UP', strength: 'MEDIUM' },
  'ROLE_CHANGE:REDUCED_ROLE': { impact: 'ROLE_DOWN', direction: 'DOWN', strength: 'MEDIUM' },

  // MINUTES_RESTRICTION -- Phase 2C only ever emits status RESTRICTED
  // (direction NEGATIVE always); the ":INCREASED" key is DORMANT -- no
  // live rule in lib/newsClassifier.js currently produces it.
  'MINUTES_RESTRICTION:RESTRICTED': { impact: 'MINUTES_DOWN', direction: 'DOWN', strength: 'HIGH' },
  'MINUTES_RESTRICTION:INCREASED': { impact: 'MINUTES_UP', direction: 'UP', strength: 'LOW' }, // DORMANT

  // INJURY_STATUS -- Phase 2C's own fallback for "an injury was reported"
  // without a formal AVAILABILITY designation word. Reusing its own
  // direction:NEGATIVE (never inventing a new fact) maps this to
  // AVAILABILITY_DOWN at LOW strength -- real information, but not a
  // formal OUT/QUESTIONABLE designation, so it never outranks one.
  'INJURY_STATUS:INJURED': { impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'LOW' },

  // RETURN -- "returning" only, never upgraded to STARTING_UP or
  // MINUTES_UP (Step 5's explicit example; also see the false-positive
  // test in scripts/test-news-impact.js).
  'RETURN:RETURNING': { impact: 'RETURN', direction: 'UP', strength: 'MEDIUM' },

  // TRADE_TRANSACTION -- both TRADE and SIGNED map to the SAME impact
  // (TRANSACTION), never ROLE_UP/OPPORTUNITY_UP (Step 17's explicit
  // false-positive requirement) -- a transaction is a real event, not a
  // role prediction. direction NEUTRAL: whether a trade helps or hurts
  // this player's own opportunity isn't something the bare event
  // supports without speculating about the new team's depth chart.
  'TRADE_TRANSACTION:TRADE': { impact: 'TRANSACTION', direction: 'NEUTRAL', strength: 'HIGH' },
  'TRADE_TRANSACTION:SIGNED': { impact: 'TRANSACTION', direction: 'NEUTRAL', strength: 'MEDIUM' },

  // ROSTER_MOVE -- IL/IR placement and waived/released are Step 6's
  // explicit HIGH examples; DFA is treated the same (a definite,
  // negative roster-status event, effectively a release precursor).
  // Call-ups/activations/returns-from-list are real but not in Step 6's
  // explicit HIGH list, so MEDIUM.
  'ROSTER_MOVE:PLACED_ON_IL': { impact: 'ROSTER_CHANGE', direction: 'DOWN', strength: 'HIGH' },
  'ROSTER_MOVE:PLACED_ON_IR': { impact: 'ROSTER_CHANGE', direction: 'DOWN', strength: 'HIGH' },
  'ROSTER_MOVE:WAIVED': { impact: 'ROSTER_CHANGE', direction: 'DOWN', strength: 'HIGH' },
  'ROSTER_MOVE:RELEASED': { impact: 'ROSTER_CHANGE', direction: 'DOWN', strength: 'HIGH' },
  'ROSTER_MOVE:DESIGNATED': { impact: 'ROSTER_CHANGE', direction: 'DOWN', strength: 'HIGH' },
  'ROSTER_MOVE:RETURNED_FROM_LIST': { impact: 'ROSTER_CHANGE', direction: 'UP', strength: 'MEDIUM' },
  'ROSTER_MOVE:ACTIVATED': { impact: 'ROSTER_CHANGE', direction: 'UP', strength: 'MEDIUM' },
  'ROSTER_MOVE:CALLED_UP': { impact: 'ROSTER_CHANGE', direction: 'UP', strength: 'MEDIUM' },
  'ROSTER_MOVE:OPTIONED': { impact: 'ROSTER_CHANGE', direction: 'DOWN', strength: 'MEDIUM' },

  // OPPORTUNITY -- Phase 2C only ever emits INCREASED_OPPORTUNITY (its
  // OPPORTUNITY rule requires an explicit causal vacancy clause -- see
  // that module's header); ":REDUCED_OPPORTUNITY" is DORMANT, no live
  // rule currently produces it.
  'OPPORTUNITY:INCREASED_OPPORTUNITY': { impact: 'OPPORTUNITY_UP', direction: 'UP', strength: 'MEDIUM' },
  'OPPORTUNITY:REDUCED_OPPORTUNITY': { impact: 'OPPORTUNITY_DOWN', direction: 'DOWN', strength: 'MEDIUM' }, // DORMANT

  // COACHING_ROTATION -- a directional rotation move reads as a role
  // change (pitcher moved up/down a rotation = more/less opportunity);
  // the bare "rotation shuffle" status carries no stated direction in
  // Phase 2C (direction: null) and is deliberately NOT forced into
  // ROLE_UP or ROLE_DOWN (Step 4's "do not invent secondary effects"
  // principle applies just as much to an ambiguous single-player fact).
  'COACHING_ROTATION:ROTATION_MOVED_UP': { impact: 'ROLE_UP', direction: 'UP', strength: 'MEDIUM' },
  'COACHING_ROTATION:ROTATION_MOVED_DOWN': { impact: 'ROLE_DOWN', direction: 'DOWN', strength: 'MEDIUM' },
  'COACHING_ROTATION:ROTATION_CHANGE': { impact: 'NO_DIRECT_IMPACT', direction: 'NEUTRAL', strength: 'LOW' },

  // Context-only categories -- Step 6's explicit LOW examples.
  'GAME_STATUS:POSTPONED_OR_SUSPENDED': { impact: 'GAME_CONTEXT', direction: 'NEUTRAL', strength: 'LOW' },
  'WEATHER:WEATHER_IMPACT': { impact: 'WEATHER_CONTEXT', direction: 'NEUTRAL', strength: 'LOW' }
};
// RECAP and GENERAL_NEWS (status always null) and any category/status
// pair not in the table above (including Phase 2C's own reserved-but-
// unused 'UNCLASSIFIED' taxonomy member) fall through to this shared
// fallback -- Step 3's "no explicit impact implication -> NO_DIRECT_IMPACT"
// and Step 15 test #25's "unknown classification -> NO_DIRECT_IMPACT".
const NO_IMPACT = { impact: 'NO_DIRECT_IMPACT', direction: 'NEUTRAL', strength: 'LOW' };

// classifyNewsImpact(classification) -> one impact signal object.
// `classification` is one entry from Phase 2C's `article.classifications`
// array: { category, subcategory, status, direction, evidence,
// classificationSource }. Never mutates its input.
function classifyNewsImpact(classification) {
  const category = classification && classification.category;
  const status = classification && classification.status;
  const mapped = (category != null && status != null) ? IMPACT_MAP[`${category}:${status}`] : null;
  const result = mapped || NO_IMPACT;
  return {
    impact: result.impact,
    direction: result.direction,
    strength: result.strength,
    // The evidence is Phase 2C's own verbatim source quote, carried
    // through unchanged -- Phase 2D never invents or rewords evidence.
    evidence: (classification && classification.evidence) || null,
    sourceCategory: category || null,
    sourceStatus: status || null,
    classificationSource: 'newsImpact:rule-based'
  };
}

// ── Freshness (Step 7) ─────────────────────────────────────────────────
// No decay math -- three plain, deterministic buckets from the article's
// own EXISTING publishedAt/isNew (Phase 1's isNew, reused as-is for the
// NEW bucket rather than redefined -- same "no new calculation, no
// redefinition" precedent this repo already follows for isNew). A
// missing/unparsable publishedAt is OLDER, never assumed current.
function freshnessLabel(article) {
  if (!article || !article.publishedAt) return 'OLDER';
  if (article.isNew) return 'NEW';
  const ageMs = Date.now() - Date.parse(article.publishedAt);
  if (!Number.isFinite(ageMs)) return 'OLDER';
  return ageMs < 48 * 3600 * 1000 ? 'RECENT' : 'OLDER';
}

// computeArticleImpact(article) -> { impactSignals: [...] }
//
// `article` is the already-classified shape Phase 2C's classifyArticle()
// (or the equivalent API response object) produces -- must carry
// `classifications` (array), `publishedAt`, `updatedAt`, `isNew`. Maps
// EVERY classification 1:1 to its own impact signal (Step 8: independent
// classifications are never collapsed into one signal); exact-duplicate
// signals (identical impact+sourceCategory+sourceStatus) are deduped,
// but genuinely different signals from the same article never are.
// publishedAt/updatedAt are carried through unchanged (Step 7/9 -- never
// deleted, never overwritten, no "final truth" resolution between
// conflicting articles; each article's own signals stand on their own).
function computeArticleImpact(article) {
  const classifications = Array.isArray(article && article.classifications) ? article.classifications : [];
  if (!classifications.length) return { impactSignals: [] }; // no classification (e.g. unresolved player) -> no signal
  const freshness = freshnessLabel(article);
  const seen = new Set();
  const impactSignals = [];
  for (const c of classifications) {
    const base = classifyNewsImpact(c);
    const key = `${base.impact}:${base.sourceCategory}:${base.sourceStatus}`;
    if (seen.has(key)) continue; // Step 8: dedupe only EXACT duplicates
    seen.add(key);
    impactSignals.push({
      ...base,
      freshness,
      publishedAt: (article && article.publishedAt) || null,
      updatedAt: (article && article.updatedAt) || null
    });
  }
  return { impactSignals };
}

module.exports = { classifyNewsImpact, computeArticleImpact, freshnessLabel, IMPACT_TAXONOMY, DIRECTIONS, STRENGTHS, IMPACT_MAP };
