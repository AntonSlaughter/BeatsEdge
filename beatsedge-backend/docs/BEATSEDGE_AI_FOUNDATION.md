# BeatsEdge AI — Phase 1A foundation (provider-independent)

**Scope:** deterministic context → evidence → routed question → (future) LLM explanation. No LLM, no vendor SDK, no key, no UI, no ParlayAPI call. `BeatsEdge.html` is untouched.

```
BEATSEDGE DATA (player, prop, calculateEdgeScore result)
  → lib/ai/context.js     buildAIContext / buildSelectedPropContext   (read-only copy of REAL fields; absent = absent)
  → lib/ai/evidence.js    buildEvidenceSummary                         (deterministic, compact, no marketing, no advice)
  → lib/ai/router.js      classifyQuestion / routeQuestion             (16 intents, fails closed)
  → lib/ai/provider.js    answerQuestion / buildLLMRequest             (the ONLY LLM boundary; stops with NO_PROVIDER_CONFIGURED)
  → lib/ai/guardrails.js  buildSystemContract / validateExplanation    (any LLM answer is validated; violations are withheld)
```

**The AI never calculates or overrides** projection, probability, edge, grade, Prime, confluence, provider line or model state.

## Definitions (also embedded in every request)
- **Model Probability** — the validated probability (`modelProbPct`). The only probability stated.
- **Factor Confluence** — `greenCount / totalFactors` of the factors the engine actually evaluated. A count of aligned factors, **never** a probability.
- **Model Edge** — direction-adjusted projection vs the provider line (positive favors the side).
- **Grade / Prime** — validated letter / separate designation; absent for probability-only and unmodeled plays.

## Model states (canonical engine strings)
`FULLY_MODELED` (graded edge) · `PROBABILITY_ONLY` · `NOT_YET_MODELED` · `INSUFFICIENT_DATA` · `PROVIDER_ONLY` (unmapped / never evaluated). For the last three no projection, probability, edge, grade or Prime exists in the context; the real provider line is retained. An edge object with no grade and no state is **not** promoted to modeled.

## Research groups
`OPPORTUNITY`, `RECENT_FORM`, `MATCHUP`, `AVAILABILITY`, `GAME_ENVIRONMENT`, `EFFICIENCY`. A group is `AVAILABLE` only when a real engine factor (mapped by its engine key) or a real supplied fact backs it, else `UNAVAILABLE` and named in `unavailable[]`. Direction is `SUPPORTS`/`OPPOSES` from the engine boolean, `UNRATED` for plain facts (e.g. player status). Engine **context-only** rows (not in the projection/probability/grade) are kept separate.

## Question intents
`WHY_GOOD, WHY_BAD, WHY_OVER, WHY_UNDER, BIGGEST_RISK, SUPPORTING_FACTORS, OPPOSING_FACTORS, EXPLAIN_GRADE, EXPLAIN_PROBABILITY, EXPLAIN_EDGE, EXPLAIN_PRIME, EXPLAIN_PLAY_SIMPLE, WHAT_CHANGED, RESULT_ANALYSIS, SITE_STATUS, UNKNOWN`. `SITE_STATUS` and `RESULT_ANALYSIS` are **reserved** and always refuse until their telemetry / settled evidence exists.

## Future contracts (interfaces only)
- **Site telemetry** `beatsedge-site-telemetry/1` (`lib/ai/contracts.js`): per `<sport_key>|<source>` — fetch status (`COMPLETE|TRUNCATED|PROVIDER_ERROR|NOT_REQUESTED|UNKNOWN`), raw rows, player-prop rows, events, players, main-line groups/retained, alternates, exact line types (standard, demon, goblin, gimme_pick, stat_slice, power_up, unclassified), alt-only groups, provider-standard-not-returned, unmapped markets, identity failures, ambiguous main lines, truncated responses, provider errors.
- **Settled play** `beatsedge-settled-play/1`: a cause (minutes, usage, opportunity, injury, foul trouble, teammate availability, game environment, matchup assumption, line quality) may be stated only when its listed evidence fields are present with a source. `autoUpdateModel:true` is rejected: the AI never changes model weights.
- **Extensions** (`correlation, smartParlay, fantasy, discord, social`): registry only, `NOT_IMPLEMENTED`; they will consume the same context object.

## Provider independence, security, cost
- `registerProvider({name, explain(request)})` is the single integration point; selected by `env.BEATSEDGE_AI_PROVIDER` on the **backend**. No adapter exists yet, so the pipeline stops at `NO_PROVIDER_CONFIGURED` and returns the deterministic evidence. Nothing fake is ever generated.
- Credentials are backend-only: the provider is never called from a browser context, `lib/ai` references no key/vendor/localStorage/fetch, `BeatsEdge.html` contains no AI endpoint or key (tested).
- A request carries one play's evidence only (≤ 2,600 chars of evidence, ≤ ~1,400 tokens including the system contract); never the board, props list, history tables or app state.

Tests: `node scripts/test-ai-foundation.js` (real-engine fixtures, no network).
