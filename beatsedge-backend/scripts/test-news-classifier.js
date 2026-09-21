// News Intelligence Phase 2C -- source-grounded classification regression
// suite. Tests lib/newsClassifier.js DIRECTLY (a real backend module,
// required here, never reimplemented). Every fixture below is a
// deterministic, clearly-labeled article object -- FIXTURE headline/
// summary text written to exercise one specific rule, using real player
// ids/names observed live in earlier phases where convenient. See
// scripts/test-news-player-card.js for the sibling player-card-join suite
// this one is a companion to (that one assumes classification-free
// articles; this one tests the classifier that produces the
// `classifications` array those articles now also carry).

const { classifyArticle, TAXONOMY } = require('../lib/newsClassifier');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}

console.log('=== News Classifier (Phase 2C) Test ===\n');

function article({ title, summary, playerId = '1966', playerName = 'LeBron James', sport = 'nba' }) {
  return { title, summary: summary || '', playerId, playerName, sport, url: 'https://example.com/x', source: 'ESPN', publishedAt: '2026-09-20T12:00:00Z' };
}
function firstCat(result, category) { return result.classifications.find(c => c.category === category); }

// ============================================================================
// 1. Explicit player OUT
// ============================================================================
{
  const r = classifyArticle(article({ title: 'LeBron James ruled out for Friday\'s game', summary: 'LeBron James has been ruled out with ankle soreness.' }));
  const c = firstCat(r, 'AVAILABILITY');
  ok(c && c.status === 'OUT' && c.direction === 'NEGATIVE' && c.evidence, '1. Explicit OUT classifies AVAILABILITY/OUT with source evidence', c);
}

// ============================================================================
// 2. Explicit QUESTIONABLE
// ============================================================================
{
  const r = classifyArticle(article({ title: 'LeBron James listed as questionable with ankle injury' }));
  const c = firstCat(r, 'AVAILABILITY');
  ok(c && c.status === 'QUESTIONABLE' && c.direction === 'NEGATIVE', '2. Explicit QUESTIONABLE classifies AVAILABILITY/QUESTIONABLE, never escalated to OUT', c);
}

// ============================================================================
// 3. Explicit AVAILABLE/RETURN
// ============================================================================
{
  const r1 = classifyArticle(article({ title: 'LeBron James is available tonight, cleared to play' }));
  const c1 = firstCat(r1, 'AVAILABILITY');
  ok(c1 && c1.status === 'AVAILABLE' && c1.direction === 'POSITIVE', '3a. Explicit AVAILABLE classifies AVAILABILITY/AVAILABLE', c1);
  const r2 = classifyArticle(article({ title: 'LeBron James returns to practice' }));
  const c2 = firstCat(r2, 'RETURN');
  ok(c2 && c2.status === 'RETURNING' && !firstCat(r2, 'STARTING_STATUS'), '3b. "Returned to practice" classifies RETURN/RETURNING only -- never auto-upgraded to STARTING (Step 5)', c2);
}

// ============================================================================
// 4. Explicit STARTING
// ============================================================================
{
  const r = classifyArticle(article({ title: 'LeBron James named the starter for tonight\'s game' }));
  const c = firstCat(r, 'STARTING_STATUS');
  ok(c && c.status === 'STARTING' && c.direction === 'POSITIVE', '4. Explicit STARTING classifies STARTING_STATUS/STARTING', c);
}

// ============================================================================
// 5. Explicit bench/starting change
// ============================================================================
{
  const r = classifyArticle(article({ title: 'LeBron James benched, will come off the bench tonight' }));
  const c = firstCat(r, 'STARTING_STATUS');
  ok(c && c.status === 'NOT_STARTING' && c.direction === 'NEGATIVE', '5. Explicit bench language classifies STARTING_STATUS/NOT_STARTING', c);
}

// ============================================================================
// 6. Explicit increased role
// ============================================================================
{
  const r = classifyArticle(article({ title: 'Coach says LeBron James will see an increased role going forward' }));
  const c = firstCat(r, 'ROLE_CHANGE');
  ok(c && c.status === 'INCREASED_ROLE' && c.direction === 'POSITIVE', '6. Explicit increased-role language classifies ROLE_CHANGE/INCREASED_ROLE', c);
}

// ============================================================================
// 7. Explicit reduced role
// ============================================================================
{
  const r = classifyArticle(article({ title: 'LeBron James role has been reduced after the coaching change' }));
  const c = firstCat(r, 'ROLE_CHANGE');
  ok(c && c.status === 'REDUCED_ROLE' && c.direction === 'NEGATIVE', '7. Explicit reduced-role language classifies ROLE_CHANGE/REDUCED_ROLE', c);
}

// ============================================================================
// 8. Explicit minutes restriction
// ============================================================================
{
  const r = classifyArticle(article({ title: 'LeBron James on a minutes restriction after injury return' }));
  const c = firstCat(r, 'MINUTES_RESTRICTION');
  ok(c && c.status === 'RESTRICTED' && c.subcategory === 'MINUTES_LIMIT', '8. Explicit minutes restriction classifies MINUTES_RESTRICTION/RESTRICTED with MINUTES_LIMIT subcategory', c);
}

// ============================================================================
// 9. Explicit snap-count restriction
// ============================================================================
{
  const r = classifyArticle(article({ title: 'Rookie QB on a snap count restriction for Week 3', sport: 'nfl', playerId: '3139477', playerName: 'Rookie QB' }));
  const c = firstCat(r, 'MINUTES_RESTRICTION');
  ok(c && c.subcategory === 'SNAP_COUNT', '9. Explicit snap-count restriction classifies MINUTES_RESTRICTION with SNAP_COUNT subcategory (sport nuance via subcategory, not a new category -- Step 2)', c);
}

// ============================================================================
// 10. Explicit trade
// ============================================================================
{
  const r = classifyArticle(article({ title: 'LeBron James traded to the Lakers in blockbuster deal' }));
  const c = firstCat(r, 'TRADE_TRANSACTION');
  ok(c && c.status === 'TRADE' && c.direction === null, '10. Explicit trade classifies TRADE_TRANSACTION/TRADE with no direction inferred (Step 5: not a role/performance prediction)', c);
}

// ============================================================================
// 11. Explicit signing
// ============================================================================
{
  const r = classifyArticle(article({ title: 'LeBron James signs a contract extension with the Lakers' }));
  const c = firstCat(r, 'TRADE_TRANSACTION');
  ok(c && c.status === 'SIGNED', '11. Explicit signing classifies TRADE_TRANSACTION/SIGNED', c);
}

// ============================================================================
// 12. Explicit roster move
// ============================================================================
{
  const r1 = classifyArticle(article({ title: 'Team places LeBron James on the 10-day IL', sport: 'mlb', playerId: '660670', playerName: 'MLB Player' }));
  ok(firstCat(r1, 'ROSTER_MOVE') && firstCat(r1, 'ROSTER_MOVE').status === 'PLACED_ON_IL', '12a. Explicit IL placement classifies ROSTER_MOVE/PLACED_ON_IL', firstCat(r1, 'ROSTER_MOVE'));
  const r2 = classifyArticle(article({ title: 'Player called up from Triple-A ahead of tonight\'s game', sport: 'mlb', playerId: '660671', playerName: 'MLB Player 2' }));
  ok(firstCat(r2, 'ROSTER_MOVE') && firstCat(r2, 'ROSTER_MOVE').status === 'CALLED_UP' && firstCat(r2, 'ROSTER_MOVE').direction === 'POSITIVE', '12b. Explicit call-up classifies ROSTER_MOVE/CALLED_UP', firstCat(r2, 'ROSTER_MOVE'));
}

// ============================================================================
// 13. Explicit opportunity statement (Step 9's own example)
// ============================================================================
{
  const r = classifyArticle(article({ title: 'With the starting center out, LeBron James is expected to take on a larger role tonight' }));
  const c = firstCat(r, 'OPPORTUNITY');
  ok(c && c.status === 'INCREASED_OPPORTUNITY' && c.direction === 'POSITIVE', '13. Explicit causal opportunity statement classifies OPPORTUNITY/INCREASED_OPPORTUNITY (Step 9)', c);
  ok(!firstCat(r, 'ROLE_CHANGE'), '13b. The same sentence is NOT also double-classified as ROLE_CHANGE (OPPORTUNITY takes precedence per the documented rule order)', r.classifications.map(x => x.category));
}

// ============================================================================
// 14. Article containing two players with different classifications
// (Phase 2A resolves at most ONE player per article -- see the module's own
// header. This case proves the RESOLVED player's own multiple facts within
// one article DO both surface, while explicitly documenting that a SECOND,
// unresolved player mentioned in the same text is never guessed at.)
// ============================================================================
{
  const r = classifyArticle(article({ title: 'Backup center out; LeBron James named the starter and will see an increased role tonight' }));
  ok(firstCat(r, 'STARTING_STATUS') && firstCat(r, 'STARTING_STATUS').status === 'STARTING', '14a. The resolved player (LeBron James) gets STARTING_STATUS/STARTING from the same article', firstCat(r, 'STARTING_STATUS'));
  ok(firstCat(r, 'ROLE_CHANGE') && firstCat(r, 'ROLE_CHANGE').status === 'INCREASED_ROLE', '14b. AND ROLE_CHANGE/INCREASED_ROLE -- two distinct classifications from one article, not collapsed into one (Step 10)', firstCat(r, 'ROLE_CHANGE'));
  ok(r.classifications.every(c => !c.playerId), '14c. No classification object carries a second player\'s identity -- the "backup center" mentioned in the same text is never resolved or guessed at (Step 11)', null);
}

// ============================================================================
// 15. Article with no actionable classification
// ============================================================================
{
  const r = classifyArticle(article({ title: 'LeBron James could be a key player down the stretch this season' }));
  ok(r.classifications.length === 1 && r.classifications[0].category === 'GENERAL_NEWS' && r.classifications[0].status === null, '15. Vague/speculative language with no explicit signal falls back to GENERAL_NEWS, never guessed', r.classifications);
}

// ============================================================================
// 16. Ambiguous player (Phase 2A convention: playerId null)
// ============================================================================
{
  const r = classifyArticle({ title: 'Two same-named players in this story, ruled out for tonight', summary: '', playerId: null, playerName: null, sport: 'nba' });
  ok(r.classifications.length === 0, '16. An AMBIGUOUS article (playerId null) gets classifications: [] even though the text says "ruled out" -- never attached without safe identity (Step 11)', r.classifications);
}

// ============================================================================
// 17. Unmatched player
// ============================================================================
{
  const r = classifyArticle({ title: 'Unrecognized player ruled out for Sunday', summary: '', playerId: null, playerName: null, sport: 'nfl' });
  ok(r.classifications.length === 0, '17. An UNMATCHED article gets classifications: [] regardless of explicit-sounding text', r.classifications);
}

// ============================================================================
// 18. Stale/old article preserving publishedAt
// ============================================================================
{
  const staleArticle = article({ title: 'LeBron James named the starter Friday', playerId: '1966' });
  staleArticle.publishedAt = '2026-09-03T08:00:00Z'; // FIXTURE: 18 days before "today" (2026-09-21)
  const r = classifyArticle(staleArticle);
  ok(staleArticle.publishedAt === '2026-09-03T08:00:00Z', '18. Classifying an old article does not mutate or clear its publishedAt (Step 12/15) -- no expiration logic added, timestamp just preserved as-is', staleArticle.publishedAt);
  ok(firstCat(r, 'STARTING_STATUS'), '18b. The classification is still produced for a stale article -- freshness/expiration is explicitly out of scope this phase (Step 12)', null);
}

// ============================================================================
// 19. Duplicate classification prevention
// ============================================================================
{
  const a = article({ title: 'LeBron James is out, ruled out for tonight\'s game (out)' }); // FIXTURE: "out" language repeated 3x on purpose
  const r1 = classifyArticle(a);
  const r2 = classifyArticle(a); // calling twice must be idempotent -- pure function, no accumulation
  const availabilityEntries = r1.classifications.filter(c => c.category === 'AVAILABILITY');
  ok(availabilityEntries.length === 1, '19a. Repeated "out" language in one article produces exactly ONE AVAILABILITY/OUT entry, not three', availabilityEntries.length);
  ok(JSON.stringify(r1) === JSON.stringify(r2), '19b. classifyArticle is a pure, idempotent function -- calling it twice on the same article yields identical results, never accumulating duplicates across calls (read-time computation, Step 16)', null);
}

// ============================================================================
// 20. False-positive language tests
// ============================================================================
{
  const cases = [
    'LeBron James had 30 points last night',
    'LeBron James could be a key player this season',
    'LeBron James has been playing well lately',
    'Fantasy managers should watch LeBron James this week'
  ];
  let allSafe = true;
  const details = [];
  for (const title of cases) {
    const r = classifyArticle(article({ title }));
    const specific = r.classifications.filter(c => c.category !== 'GENERAL_NEWS' && c.category !== 'RECAP');
    details.push({ title, categories: r.classifications.map(c => c.category) });
    if (specific.length) allSafe = false;
  }
  ok(allSafe, '20. None of the false-positive-risk headlines produce an AVAILABILITY/STARTING_STATUS/ROLE_CHANGE/etc. classification -- box-score recaps and vague praise never get read as an actionable signal', details);
}

// ============================================================================
// Extra: taxonomy sanity + no betting-language leakage + additive-only guarantee
// ============================================================================
{
  ok(TAXONOMY.includes('AVAILABILITY') && TAXONOMY.includes('UNCLASSIFIED') && TAXONOMY.length === 15, 'Extra-1. Exported TAXONOMY has exactly the 15 required categories', TAXONOMY);
  const BETTING_WORDS = /\b(bet|over|under|boost|fade|buy|good play|bad play)\b/i;
  const sample = classifyArticle(article({ title: 'LeBron James expected to start tonight, will see an increased role with the starting center out' }));
  const leaks = sample.classifications.filter(c => BETTING_WORDS.test(`${c.category} ${c.status} ${c.evidence}`));
  ok(leaks.length === 0, 'Extra-2. No classification field ever contains betting-advice language (bet/over/under/boost/fade/buy)', sample.classifications);

  const original = article({ title: 'LeBron James ruled out for tonight' });
  const beforeJson = JSON.stringify(original);
  classifyArticle(original);
  ok(JSON.stringify(original) === beforeJson, 'Extra-3. classifyArticle never mutates the article object it is given (Step 15)', null);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
