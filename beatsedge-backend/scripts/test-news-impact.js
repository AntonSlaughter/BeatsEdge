// News Intelligence Phase 2D -- research-only news impact signal
// regression suite. Tests lib/newsImpact.js DIRECTLY (a real backend
// module, required here, never reimplemented). Consumes Phase 2C
// classification SHAPES exactly as lib/newsClassifier.js actually
// produces them (confirmed by direct read of that file this phase) --
// fixtures use Phase 2C's real category/status strings, not invented
// ones. A few fixtures (marked DORMANT) exercise mapping table entries
// for classifications Phase 2C's current rules never actually emit live
// (no "increased minutes"/"reduced opportunity" detector exists yet) --
// these test the MAPPING TABLE's correctness/forward-compatibility, not
// a live capability; the live-validation report states this plainly.

const { classifyNewsImpact, computeArticleImpact, freshnessLabel, IMPACT_TAXONOMY } = require('../lib/newsImpact');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}

console.log('=== News Impact Signals (Phase 2D) Test ===\n');

function classification({ category, status, direction = null, evidence = 'evidence text' }) {
  return { category, subcategory: null, status, direction, evidence, classificationSource: 'newsClassifier:rule-based' };
}
function article({ classifications, publishedAt = '2026-09-20T12:00:00Z', updatedAt = null, isNew = false }) {
  return { title: 't', summary: 's', playerId: '1966', playerName: 'Test Player', sport: 'nba', classifications, publishedAt, updatedAt, isNew };
}

// ============================================================================
// 1-18: required category -> impact mappings (Step 15)
// ============================================================================
{
  const r = classifyNewsImpact(classification({ category: 'AVAILABILITY', status: 'OUT', direction: 'NEGATIVE' }));
  ok(r.impact === 'AVAILABILITY_DOWN' && r.strength === 'HIGH', '1. OUT -> AVAILABILITY_DOWN/HIGH', r);
}
{
  const r = classifyNewsImpact(classification({ category: 'AVAILABILITY', status: 'QUESTIONABLE', direction: 'NEGATIVE' }));
  ok(r.impact === 'AVAILABILITY_DOWN' && r.strength === 'MEDIUM', '2. QUESTIONABLE -> AVAILABILITY_DOWN/MEDIUM (never escalated to OUT-strength)', r);
}
{
  const r = classifyNewsImpact(classification({ category: 'AVAILABILITY', status: 'AVAILABLE', direction: 'POSITIVE' }));
  ok(r.impact === 'AVAILABILITY_UP', '3. AVAILABLE -> AVAILABILITY_UP', r);
}
{
  const r = classifyNewsImpact(classification({ category: 'STARTING_STATUS', status: 'STARTING', direction: 'POSITIVE' }));
  ok(r.impact === 'STARTING_UP' && r.strength === 'HIGH', '4. STARTING -> STARTING_UP/HIGH', r);
}
{
  const r = classifyNewsImpact(classification({ category: 'STARTING_STATUS', status: 'NOT_STARTING', direction: 'NEGATIVE' }));
  ok(r.impact === 'STARTING_DOWN', '5. NOT_STARTING (bench/scratch) -> STARTING_DOWN', r);
}
{
  const r = classifyNewsImpact(classification({ category: 'ROLE_CHANGE', status: 'INCREASED_ROLE', direction: 'POSITIVE' }));
  ok(r.impact === 'ROLE_UP', '6. INCREASED_ROLE -> ROLE_UP', r);
}
{
  const r = classifyNewsImpact(classification({ category: 'ROLE_CHANGE', status: 'REDUCED_ROLE', direction: 'NEGATIVE' }));
  ok(r.impact === 'ROLE_DOWN', '7. REDUCED_ROLE -> ROLE_DOWN', r);
}
{
  const r = classifyNewsImpact(classification({ category: 'MINUTES_RESTRICTION', status: 'RESTRICTED', direction: 'NEGATIVE' }));
  ok(r.impact === 'MINUTES_DOWN' && r.strength === 'HIGH', '8. MINUTES_RESTRICTED -> MINUTES_DOWN/HIGH', r);
}
{
  // DORMANT: Phase 2C has no live rule that emits MINUTES_RESTRICTION/INCREASED today.
  const r = classifyNewsImpact(classification({ category: 'MINUTES_RESTRICTION', status: 'INCREASED', direction: 'POSITIVE' }));
  ok(r.impact === 'MINUTES_UP', '9. (DORMANT mapping) INCREASED_MINUTES -> MINUTES_UP', r);
}
{
  const r = classifyNewsImpact(classification({ category: 'RETURN', status: 'RETURNING', direction: 'POSITIVE' }));
  ok(r.impact === 'RETURN' && r.strength === 'MEDIUM', '10. RETURN -> RETURN/MEDIUM', r);
}
{
  const r = classifyNewsImpact(classification({ category: 'TRADE_TRANSACTION', status: 'TRADE', direction: null }));
  ok(r.impact === 'TRANSACTION' && r.strength === 'HIGH', '11. TRADE -> TRANSACTION/HIGH', r);
}
{
  const r = classifyNewsImpact(classification({ category: 'TRADE_TRANSACTION', status: 'SIGNED', direction: null }));
  ok(r.impact === 'TRANSACTION', '12. SIGNED -> TRANSACTION', r);
}
{
  const r = classifyNewsImpact(classification({ category: 'ROSTER_MOVE', status: 'CALLED_UP', direction: 'POSITIVE' }));
  ok(r.impact === 'ROSTER_CHANGE', '13. ROSTER_MOVE (CALLED_UP) -> ROSTER_CHANGE', r);
}
{
  const r = classifyNewsImpact(classification({ category: 'OPPORTUNITY', status: 'INCREASED_OPPORTUNITY', direction: 'POSITIVE' }));
  ok(r.impact === 'OPPORTUNITY_UP', '14. OPPORTUNITY (INCREASED_OPPORTUNITY) -> OPPORTUNITY_UP', r);
}
{
  // DORMANT: Phase 2C's OPPORTUNITY rule never currently emits a REDUCED_OPPORTUNITY status.
  const r = classifyNewsImpact(classification({ category: 'OPPORTUNITY', status: 'REDUCED_OPPORTUNITY', direction: 'NEGATIVE' }));
  ok(r.impact === 'OPPORTUNITY_DOWN', '15. (DORMANT mapping) OPPORTUNITY_DOWN -> OPPORTUNITY_DOWN', r);
}
{
  const r = classifyNewsImpact(classification({ category: 'WEATHER', status: 'WEATHER_IMPACT', direction: null }));
  ok(r.impact === 'WEATHER_CONTEXT' && r.strength === 'LOW', '16. WEATHER -> WEATHER_CONTEXT/LOW', r);
}
{
  const r = classifyNewsImpact(classification({ category: 'GAME_STATUS', status: 'POSTPONED_OR_SUSPENDED', direction: null }));
  ok(r.impact === 'GAME_CONTEXT' && r.strength === 'LOW', '17. GAME_STATUS -> GAME_CONTEXT/LOW', r);
}
{
  const r = classifyNewsImpact(classification({ category: 'GENERAL_NEWS', status: null, direction: null, evidence: null }));
  ok(r.impact === 'NO_DIRECT_IMPACT', '18. GENERAL_NEWS -> NO_DIRECT_IMPACT', r);
}

// ============================================================================
// 19. Multiple classifications -> multiple independent signals (real
// scenario: "Player traded to Team B and signs five-year extension" ->
// Phase 2C's own TRADE_TRANSACTION rule emits BOTH TRADE and SIGNED from
// one article -- confirmed live this session against a real ESPN article
// about Luke Evangelista; not treated as mutually exclusive here either)
// ============================================================================
{
  const a = article({ classifications: [
    classification({ category: 'TRADE_TRANSACTION', status: 'TRADE', evidence: 'acquired from' }),
    classification({ category: 'TRADE_TRANSACTION', status: 'SIGNED', evidence: 'signed a contract extension' })
  ] });
  const { impactSignals } = computeArticleImpact(a);
  ok(impactSignals.length === 2 && impactSignals.every(s => s.impact === 'TRANSACTION'), '19a. TRADE + SIGNED in one article -> TWO independent TRANSACTION signals, not collapsed', impactSignals.map(s => s.sourceStatus));
  const a2 = article({ classifications: [
    classification({ category: 'RETURN', status: 'RETURNING' }),
    classification({ category: 'ROLE_CHANGE', status: 'INCREASED_ROLE' })
  ] });
  const r2 = computeArticleImpact(a2).impactSignals;
  ok(r2.length === 2 && r2.some(s => s.impact === 'RETURN') && r2.some(s => s.impact === 'ROLE_UP'), '19b. RETURN + ROLE_UP in one article both preserved as independent signals', r2.map(s => s.impact));
}

// ============================================================================
// 20. Duplicate classifications deduplicated
// ============================================================================
{
  const dup = classification({ category: 'AVAILABILITY', status: 'OUT' });
  const a = article({ classifications: [dup, { ...dup }, { ...dup }] });
  const { impactSignals } = computeArticleImpact(a);
  ok(impactSignals.length === 1, '20. Three identical classifications produce exactly ONE deduplicated signal', impactSignals.length);
}

// ============================================================================
// 21. Conflicting articles -- both preserved, no "final truth" resolution
// ============================================================================
{
  const article1 = article({ classifications: [classification({ category: 'STARTING_STATUS', status: 'STARTING' })], publishedAt: '2026-09-19T08:00:00Z' });
  const article2 = article({ classifications: [classification({ category: 'AVAILABILITY', status: 'QUESTIONABLE' })], publishedAt: '2026-09-20T08:00:00Z' });
  const s1 = computeArticleImpact(article1).impactSignals;
  const s2 = computeArticleImpact(article2).impactSignals;
  ok(s1.length === 1 && s1[0].impact === 'STARTING_UP' && s1[0].publishedAt === '2026-09-19T08:00:00Z', '21a. Older "expected to start" article keeps its own signal + its own publishedAt, untouched', s1[0]);
  ok(s2.length === 1 && s2[0].impact === 'AVAILABILITY_DOWN' && s2[0].publishedAt === '2026-09-20T08:00:00Z', '21b. Newer, conflicting "now questionable" article ALSO keeps its own signal -- no engine resolves which one is "true"', s2[0]);
}

// ============================================================================
// 22. Old article -- timestamp preserved, no automatic freshness assumption
// ============================================================================
{
  const oldArticle = article({ classifications: [classification({ category: 'STARTING_STATUS', status: 'STARTING' })], publishedAt: '2026-08-01T08:00:00Z', isNew: false });
  const { impactSignals } = computeArticleImpact(oldArticle);
  ok(impactSignals[0].publishedAt === '2026-08-01T08:00:00Z' && impactSignals[0].freshness === 'OLDER', '22. An 18-day-old article keeps its real publishedAt and is correctly labeled OLDER, never assumed current', impactSignals[0]);
  ok(freshnessLabel({ publishedAt: null }) === 'OLDER', '22b. Missing publishedAt is OLDER, never assumed fresh', null);
  ok(freshnessLabel({ publishedAt: new Date().toISOString(), isNew: true }) === 'NEW', '22c. isNew:true (Phase 1\'s own <2h field, reused not redefined) -> freshness NEW', null);
  ok(freshnessLabel({ publishedAt: new Date(Date.now() - 10 * 3600 * 1000).toISOString(), isNew: false }) === 'RECENT', '22d. A 10-hour-old article (not isNew, under 48h) -> RECENT', null);
}

// ============================================================================
// 23. No secondary teammate inference (Step 4/17's central safety requirement)
// ============================================================================
{
  // Mirrors Phase 2C's own test #14 scenario: one resolved player (the
  // article's playerId), whose OWN classifications may legitimately
  // produce multiple signals -- but there is no code path anywhere in
  // lib/newsImpact.js that can reference or infer a SECOND player. A
  // classification object never carries player identity at all (Phase 2C
  // deliberately keeps that external, one level up, on the article) --
  // proven structurally: classifyNewsImpact()'s return value below has no
  // player field whatsoever, so it is IMPOSSIBLE for it to name "Player B."
  const backupOutMention = classification({ category: 'STARTING_STATUS', status: 'STARTING', evidence: 'named the starter' }); // the article ALSO mentions "backup center out" in free text, never modeled here
  const r = classifyNewsImpact(backupOutMention);
  ok(!('player' in r) && !('playerId' in r) && !('secondaryPlayer' in r), '23. An impact signal object has no player/playerId/secondaryPlayer field at all -- structurally cannot name a second, inferred player', Object.keys(r));
  // And explicitly: an AVAILABILITY_DOWN fact about Player A never
  // manufactures an OPPORTUNITY_UP entry for anyone else in the SAME call.
  const onlyFact = computeArticleImpact(article({ classifications: [classification({ category: 'AVAILABILITY', status: 'OUT' })] })).impactSignals;
  ok(onlyFact.length === 1 && onlyFact[0].impact === 'AVAILABILITY_DOWN', '23b. "Player A ruled out" produces exactly one AVAILABILITY_DOWN signal -- no automatic OPPORTUNITY_UP for any other player is ever created', onlyFact);
}

// ============================================================================
// 24. No betting-language output
// ============================================================================
{
  const BETTING_WORDS = /\b(bet this|fade|over|under|boost|lock|smash|good bet|bad bet)\b/i;
  const allInputs = [
    ['AVAILABILITY', 'OUT'], ['AVAILABILITY', 'QUESTIONABLE'], ['STARTING_STATUS', 'STARTING'],
    ['ROLE_CHANGE', 'INCREASED_ROLE'], ['MINUTES_RESTRICTION', 'RESTRICTED'], ['RETURN', 'RETURNING'],
    ['TRADE_TRANSACTION', 'TRADE'], ['ROSTER_MOVE', 'CALLED_UP'], ['OPPORTUNITY', 'INCREASED_OPPORTUNITY'],
    ['WEATHER', 'WEATHER_IMPACT'], ['GAME_STATUS', 'POSTPONED_OR_SUSPENDED']
  ];
  let clean = true;
  const flagged = [];
  for (const [category, status] of allInputs) {
    const r = classifyNewsImpact(classification({ category, status }));
    const text = `${r.impact} ${r.direction} ${r.strength}`;
    if (BETTING_WORDS.test(text)) { clean = false; flagged.push(r); }
  }
  ok(clean, '24. No impact/direction/strength value ever contains betting-advice language (fade/over/under/boost/lock/smash/bet this)', flagged);
  ok(IMPACT_TAXONOMY.every(t => !BETTING_WORDS.test(t)), '24b. The IMPACT_TAXONOMY vocabulary itself contains no betting-advice terms', IMPACT_TAXONOMY);
}

// ============================================================================
// 25. Unknown classification -> NO_DIRECT_IMPACT
// ============================================================================
{
  const r1 = classifyNewsImpact(classification({ category: 'SOME_FUTURE_CATEGORY', status: 'UNSEEN_STATUS' }));
  ok(r1.impact === 'NO_DIRECT_IMPACT', '25a. A completely unrecognized category/status pair -> NO_DIRECT_IMPACT, never a guess', r1);
  const r2 = classifyNewsImpact(classification({ category: 'UNCLASSIFIED', status: null }));
  ok(r2.impact === 'NO_DIRECT_IMPACT', '25b. Phase 2C\'s reserved-but-unused UNCLASSIFIED taxonomy member also -> NO_DIRECT_IMPACT', r2);
  ok(classifyNewsImpact(null).impact === 'NO_DIRECT_IMPACT', '25c. A null/missing classification input -> NO_DIRECT_IMPACT, never throws', null);
}

// ============================================================================
// Extra: additive-only guarantees + empty-classifications passthrough
// ============================================================================
{
  const unresolved = article({ classifications: [] }); // Phase 2C's own shape for an unlinked article
  ok(computeArticleImpact(unresolved).impactSignals.length === 0, 'Extra-1. An article with classifications:[] (unresolved player) gets impactSignals:[] -- never a NO_DIRECT_IMPACT filler for a non-existent classification', null);

  const c = classification({ category: 'AVAILABILITY', status: 'OUT' });
  const beforeJson = JSON.stringify(c);
  classifyNewsImpact(c);
  ok(JSON.stringify(c) === beforeJson, 'Extra-2. classifyNewsImpact never mutates the classification object it is given', null);

  const a = article({ classifications: [classification({ category: 'AVAILABILITY', status: 'OUT' })] });
  const beforeArticleJson = JSON.stringify(a);
  computeArticleImpact(a);
  ok(JSON.stringify(a) === beforeArticleJson, 'Extra-3. computeArticleImpact never mutates the article it is given (title/summary/url/playerId/publishedAt all untouched)', null);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
