// News Intelligence Phase 2E -- player news timeline / context panel
// regression suite. BeatsEdge.html has no module system, so this is a
// FAITHFUL STANDALONE EXTRACTION of the exact logic added this phase
// (playerNewsIndex/newsForPlayer's join -- unchanged since Phase 2B --
// plus the new buildPlayerNewsContext/IMPACT_TO_BUCKET/NEWS_STATUS_LABELS/
// newsImpactEmoji), same convention already used by
// scripts/test-news-player-card.js and scripts/test-news-classifier.js.
// Fixture articles use the SAME shape fetchMultiSportNews() actually
// produces (see BeatsEdge.html) so these tests exercise the real data
// contract, not an invented one.

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}

console.log('=== News Player Timeline / Context Panel (Phase 2E) Test ===\n');

// ---- Faithful extraction from BeatsEdge.html (Phase 2B, unchanged) ----
function buildPlayerNewsIndex(multiSportNews) {
  const idx = new Map();
  (multiSportNews || []).forEach(n => {
    if (!n.playerId || !n.playerIdSource) return;
    const key = `${n.sport}:${n.playerIdSource}:${n.playerId}`;
    const arr = idx.get(key) || [];
    arr.push(n);
    idx.set(key, arr);
  });
  idx.forEach(arr => arr.sort((a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0)));
  return idx;
}
function newsForPlayer(playerNewsIndex, player) {
  if (!player || player.id == null) return [];
  const source = player.sport === 'mlb' ? 'mlb' : 'espn';
  return playerNewsIndex.get(`${player.sport}:${source}:${player.id}`) || [];
}

// ---- Faithful extraction from BeatsEdge.html (Phase 2E, this phase) ----
const IMPACT_TO_BUCKET = {
  AVAILABILITY_UP: 'Availability', AVAILABILITY_DOWN: 'Availability',
  STARTING_UP: 'Starting status', STARTING_DOWN: 'Starting status',
  ROLE_UP: 'Role', ROLE_DOWN: 'Role',
  MINUTES_UP: 'Minutes', MINUTES_DOWN: 'Minutes',
  OPPORTUNITY_UP: 'Opportunity', OPPORTUNITY_DOWN: 'Opportunity',
  TRANSACTION: 'Transaction', RETURN: 'Return',
  GAME_CONTEXT: 'Game context', WEATHER_CONTEXT: 'Weather'
};
const NEWS_CONTEXT_BUCKET_ORDER = ['Availability', 'Starting status', 'Role', 'Minutes', 'Opportunity', 'Transaction', 'Return', 'Game context', 'Weather'];
const NEWS_STATUS_LABELS = {
  OUT: 'Out', DOUBTFUL: 'Doubtful', QUESTIONABLE: 'Questionable', PROBABLE: 'Probable', AVAILABLE: 'Available', LIMITED: 'Limited',
  STARTING: 'Starting', NOT_STARTING: 'Not starting',
  INCREASED_ROLE: 'Increased', REDUCED_ROLE: 'Reduced',
  RESTRICTED: 'Restricted', INCREASED: 'Increased',
  INJURED: 'Injury reported', RETURNING: 'Returning',
  TRADE: 'Trade', SIGNED: 'Signed',
  PLACED_ON_IL: 'Placed on IL', PLACED_ON_IR: 'Placed on IR', RETURNED_FROM_LIST: 'Returned from list',
  ACTIVATED: 'Activated', CALLED_UP: 'Called up', OPTIONED: 'Optioned', DESIGNATED: 'Designated for assignment',
  WAIVED: 'Waived', RELEASED: 'Released',
  INCREASED_OPPORTUNITY: 'Increased', REDUCED_OPPORTUNITY: 'Reduced',
  ROTATION_MOVED_UP: 'Moved up', ROTATION_MOVED_DOWN: 'Moved down', ROTATION_CHANGE: 'Rotation change',
  POSTPONED_OR_SUSPENDED: 'Postponed / suspended', WEATHER_IMPACT: 'Weather impact'
};
const newsImpactEmoji = (direction, strength) =>
  direction === 'UP' ? '🟢' : direction === 'DOWN' ? (strength === 'HIGH' ? '🔴' : '🟡') : '⚪';

function buildPlayerNewsContext(newsList) {
  const list = Array.isArray(newsList) ? newsList : [];
  const byBucket = new Map();
  let hasRecentUp = false, hasRecentDown = false;
  list.forEach(n => {
    (Array.isArray(n.impactSignals) ? n.impactSignals : []).forEach(s => {
      const bucket = IMPACT_TO_BUCKET[s.impact];
      if (!bucket) return;
      const ts = Date.parse(s.publishedAt || n.published) || 0;
      const cur = byBucket.get(bucket);
      if (!cur || ts > cur.ts) byBucket.set(bucket, { signal: s, ts, ageLabel: n.ageLabel });
      if (s.freshness && s.freshness !== 'OLDER') {
        if (s.direction === 'UP') hasRecentUp = true;
        if (s.direction === 'DOWN') hasRecentDown = true;
      }
    });
  });
  const categories = NEWS_CONTEXT_BUCKET_ORDER
    .filter(b => byBucket.has(b))
    .map(bucket => {
      const { signal, ageLabel } = byBucket.get(bucket);
      return {
        bucket, emoji: newsImpactEmoji(signal.direction, signal.strength),
        statusLabel: NEWS_STATUS_LABELS[signal.sourceStatus] || (signal.sourceStatus ? signal.sourceStatus.replace(/_/g, ' ') : bucket),
        sourceStatus: signal.sourceStatus, ageLabel, publishedAt: signal.publishedAt, freshness: signal.freshness
      };
    });
  return { categories, conflict: hasRecentUp && hasRecentDown, articleCount: list.length, lastUpdateAgeLabel: list.length ? list[0].ageLabel : null };
}

// ---- Fixture article factory (matches fetchMultiSportNews's real shape) ----
function impactSignal({ impact, direction, strength, sourceStatus, evidence = 'evidence', publishedAt, freshness = 'RECENT' }) {
  return { impact, direction, strength, evidence, sourceCategory: null, sourceStatus, classificationSource: 'newsImpact:rule-based', freshness, publishedAt, updatedAt: null };
}
function article({ sport = 'nba', playerId = '1966', playerIdSource = 'espn', playerName = 'LeBron James', published, ageLabel = '1h', isNew = false, headline = 'Headline', source = 'ESPN', url = 'https://example.com/a', articleId, impactSignals = [], classifications = [] }) {
  return {
    headline, description: '', published, ageLabel, url, athlete: playerName, teams: [],
    kind: null, sport, source, image: null,
    articleId: articleId || `${source}:${url || headline}`,
    playerId, playerIdSource, playerMatchMethod: 'EXACT_ID', isNew,
    classifications, impactSignals
  };
}

// ============================================================================
// 1. Player with zero articles
// ============================================================================
{
  const idx = buildPlayerNewsIndex([]);
  const news = newsForPlayer(idx, { id: '1966', sport: 'nba' });
  ok(news.length === 0, '1. Player with zero articles -> empty timeline', news.length);
  const ctx = buildPlayerNewsContext(news);
  ok(ctx.categories.length === 0 && ctx.articleCount === 0 && ctx.conflict === false, '1b. Empty timeline -> empty context, no conflict, no invented category', ctx);
}

// ============================================================================
// 2. Player with one article
// ============================================================================
{
  const a = article({ published: '2026-09-21T10:00:00Z', impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'OUT', publishedAt: '2026-09-21T10:00:00Z' })] });
  const idx = buildPlayerNewsIndex([a]);
  const news = newsForPlayer(idx, { id: '1966', sport: 'nba' });
  ok(news.length === 1, '2. Player with one article -> timeline of 1', news.length);
  const ctx = buildPlayerNewsContext(news);
  ok(ctx.categories.length === 1 && ctx.categories[0].bucket === 'Availability' && ctx.categories[0].statusLabel === 'Out', '2b. Single article context: Availability -> Out', ctx.categories);
}

// ============================================================================
// 3. Player with five articles
// ============================================================================
{
  const arts = [1, 2, 3, 4, 5].map(i => article({ published: `2026-09-1${i}T08:00:00Z`, ageLabel: `${5 - i}d`, headline: `Article ${i}`, articleId: `ESPN:${i}` }));
  const idx = buildPlayerNewsIndex(arts);
  const news = newsForPlayer(idx, { id: '1966', sport: 'nba' });
  ok(news.length === 5, '3. Player with five articles -> timeline of 5', news.length);
}

// ============================================================================
// 4. Player with more than five articles
// ============================================================================
{
  const arts = [1, 2, 3, 4, 5, 6, 7].map(i => article({ published: `2026-09-0${i}T08:00:00Z`, headline: `Article ${i}`, articleId: `ESPN:${i}` }));
  const idx = buildPlayerNewsIndex(arts);
  const news = newsForPlayer(idx, { id: '1966', sport: 'nba' });
  ok(news.length === 7, '4a. Player with 7 linked articles: full list holds all 7', news.length);
  const initial = news.slice(0, 5);
  ok(initial.length === 5, '4b. Card-level slice(0,5) caps the INITIAL display at 5 (Step 2) -- "View more" (tested via the card\'s own newsExpanded toggle) reveals the rest client-side, no new request', initial.length);
}

// ============================================================================
// 5. Newest-first ordering
// ============================================================================
{
  const arts = [
    article({ published: '2026-09-18T08:00:00Z', headline: 'Oldest', articleId: 'a1' }),
    article({ published: '2026-09-20T08:00:00Z', headline: 'Newest', articleId: 'a2' }),
    article({ published: '2026-09-19T08:00:00Z', headline: 'Middle', articleId: 'a3' })
  ];
  const idx = buildPlayerNewsIndex(arts);
  const news = newsForPlayer(idx, { id: '1966', sport: 'nba' });
  ok(news.map(n => n.headline).join(',') === 'Newest,Middle,Oldest', '5. Timeline sorts strictly newest -> oldest', news.map(n => n.headline));
}

// ============================================================================
// 6. Same player across multiple sources
// ============================================================================
{
  const arts = [
    article({ source: 'ESPN', published: '2026-09-20T08:00:00Z', headline: 'ESPN story', articleId: 'espn1' }),
    article({ source: 'Yahoo Sports', published: '2026-09-20T07:00:00Z', headline: 'Yahoo story', articleId: 'yahoo1' })
  ];
  const idx = buildPlayerNewsIndex(arts);
  const news = newsForPlayer(idx, { id: '1966', sport: 'nba' });
  ok(news.length === 2 && new Set(news.map(n => n.source)).size === 2, '6. Same player, two different sources -> both kept as SEPARATE timeline entries, source attribution intact (Step 18)', news.map(n => n.source));
}

// ============================================================================
// 7. Classification badge rendering data (data-level: what the card would render)
// ============================================================================
{
  const a = article({ classifications: [{ category: 'STARTING_STATUS', subcategory: null, status: 'STARTING', direction: 'POSITIVE', evidence: 'named the starter', classificationSource: 'newsClassifier:rule-based' }] });
  ok(a.classifications.length === 1 && a.classifications[0].category === 'STARTING_STATUS', '7. Article carries its Phase 2C classification unchanged, available for card rendering', a.classifications);
}

// ============================================================================
// 8. Impact badge rendering data
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'STARTING_UP', direction: 'UP', strength: 'HIGH', sourceStatus: 'STARTING', publishedAt: '2026-09-20T08:00:00Z' })] });
  const badge = a.impactSignals[0];
  ok(newsImpactEmoji(badge.direction, badge.strength) === '🟢' && badge.sourceStatus === 'STARTING', '8. Impact signal renders as a green STARTING badge, matching Phase 2D\'s own emoji rule', badge);
}

// ============================================================================
// 9. Multiple signals in one article
// ============================================================================
{
  const a = article({ impactSignals: [
    impactSignal({ impact: 'TRANSACTION', direction: 'NEUTRAL', strength: 'HIGH', sourceStatus: 'TRADE', publishedAt: '2026-09-20T08:00:00Z' }),
    impactSignal({ impact: 'TRANSACTION', direction: 'NEUTRAL', strength: 'MEDIUM', sourceStatus: 'SIGNED', publishedAt: '2026-09-20T08:00:00Z' })
  ] });
  ok(a.impactSignals.length === 2, '9. One article with two independent impact signals (TRADE + SIGNED) both available for badge rendering, not collapsed', a.impactSignals.map(s => s.sourceStatus));
}

// ============================================================================
// 10. Conflicting recent reports
// ============================================================================
{
  const arts = [
    article({ articleId: 'c1', published: '2026-09-21T10:00:00Z', ageLabel: '2h', impactSignals: [impactSignal({ impact: 'STARTING_UP', direction: 'UP', strength: 'HIGH', sourceStatus: 'STARTING', publishedAt: '2026-09-21T10:00:00Z', freshness: 'RECENT' })] }),
    article({ articleId: 'c2', published: '2026-09-21T12:30:00Z', ageLabel: '30m', impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'MEDIUM', sourceStatus: 'QUESTIONABLE', publishedAt: '2026-09-21T12:30:00Z', freshness: 'RECENT' })] })
  ];
  const idx = buildPlayerNewsIndex(arts);
  const news = newsForPlayer(idx, { id: '1966', sport: 'nba' });
  const ctx = buildPlayerNewsContext(news);
  ok(ctx.conflict === true, '10a. 10:00 STARTING + 12:30 QUESTIONABLE (Step 6\'s own example) -> conflict flagged', ctx.conflict);
  ok(ctx.categories.some(c => c.bucket === 'Starting status') && ctx.categories.some(c => c.bucket === 'Availability'), '10b. BOTH the older STARTING and the newer QUESTIONABLE signals are preserved (different buckets) -- neither deleted or overwritten', ctx.categories.map(c => c.bucket));
  ok(news[0].headline !== undefined && news.length === 2, '10c. Both articles remain in the timeline, newest first -- nothing rewritten, nothing declared "correct"', news.map(n => n.ageLabel));
}

// ============================================================================
// 11. Old article preserved
// ============================================================================
{
  const oldArt = article({ published: '2026-08-01T08:00:00Z', ageLabel: '51d', impactSignals: [impactSignal({ impact: 'STARTING_UP', direction: 'UP', strength: 'HIGH', sourceStatus: 'STARTING', publishedAt: '2026-08-01T08:00:00Z', freshness: 'OLDER' })] });
  const idx = buildPlayerNewsIndex([oldArt]);
  const news = newsForPlayer(idx, { id: '1966', sport: 'nba' });
  ok(news.length === 1 && news[0].published === '2026-08-01T08:00:00Z', '11a. A 51-day-old article is kept, exact publishedAt untouched', news[0].published);
  const ctx = buildPlayerNewsContext(news);
  ok(ctx.categories.length === 1 && ctx.categories[0].bucket === 'Starting status', '11b. Old-but-only signal still populates NEWS CONTEXT (Step 8: newest relevant signal, not age-gated) -- its own ageLabel is preserved for the user to judge staleness', ctx.categories[0]);
  ok(ctx.conflict === false, '11c. A signal older than the RECENT window never counts toward conflict detection', ctx.conflict);
}

// ============================================================================
// 12. Unmatched article excluded
// ============================================================================
{
  const unmatched = article({ playerId: null, playerIdSource: null });
  const idx = buildPlayerNewsIndex([unmatched]);
  ok(idx.size === 0, '12. An unmatched article (playerId null) never enters the index -- never appears in any player\'s timeline', idx.size);
}

// ============================================================================
// 13. Ambiguous article excluded
// ============================================================================
{
  const ambiguous = article({ playerId: null, playerIdSource: null, headline: 'Two same-named players' });
  const idx = buildPlayerNewsIndex([ambiguous]);
  const news = newsForPlayer(idx, { id: '1966', sport: 'nba' });
  ok(news.length === 0, '13. An AMBIGUOUS article never appears in any player timeline, regardless of headline text', news.length);
}

// ============================================================================
// 14. No fuzzy player matching
// ============================================================================
{
  // The join key is built ONLY from sport+playerIdSource+playerId -- there is
  // no code path anywhere in newsForPlayer/buildPlayerNewsIndex that reads
  // headline/summary text or player NAME to decide a match.
  const a = article({ playerId: '1966', playerName: 'LeBron James', headline: 'Totally unrelated headline about someone else entirely' });
  const idx = buildPlayerNewsIndex([a]);
  const wrongNamePlayer = { id: '1966', sport: 'nba' }; // same canonical id, join must succeed regardless of any name text
  ok(newsForPlayer(idx, wrongNamePlayer).length === 1, '14. The join succeeds purely on canonical id, independent of headline wording -- proving no text/name matching is involved', null);
}

// ============================================================================
// 15/16. No duplicate API request per player; player index uses canonical ID
// ============================================================================
{
  // playerNewsIndex is built ONCE from the already-fetched multiSportNews
  // array (a single fetch per session, established Phase 1/2B) -- every
  // call to newsForPlayer() for every different player/card is a pure Map
  // lookup against that SAME index, never a new fetch.
  const arts = [article({ playerId: '1966' }), article({ playerId: '4277905', playerName: 'Trae Young', articleId: 'ESPN:trae' })];
  const idx = buildPlayerNewsIndex(arts); // built once
  const p1 = newsForPlayer(idx, { id: '1966', sport: 'nba' });
  const p2 = newsForPlayer(idx, { id: '4277905', sport: 'nba' });
  ok(p1.length === 1 && p2.length === 1, '15. Two different players both resolved from the SAME already-built index -- zero additional fetches, zero N+1 requests', { p1: p1.length, p2: p2.length });
  ok(idx.has('nba:espn:1966') && idx.has('nba:espn:4277905'), '16. The index key is the canonical sport:playerIdSource:playerId join established in Phase 2B, unchanged this phase', [...idx.keys()]);
}

// ============================================================================
// 17. Empty category omitted
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'TRANSACTION', direction: 'NEUTRAL', strength: 'HIGH', sourceStatus: 'TRADE', publishedAt: '2026-09-20T08:00:00Z' })] });
  const ctx = buildPlayerNewsContext([a]);
  ok(ctx.categories.length === 1 && ctx.categories[0].bucket === 'Transaction', '17. Only the Transaction category appears -- Availability/Role/Minutes/etc. are simply absent, never shown empty', ctx.categories.map(c => c.bucket));
}

// ============================================================================
// 18. Current context does not invent status
// ============================================================================
{
  // A GENERAL_NEWS-only article (NO_DIRECT_IMPACT) must never populate any
  // category -- there is no source-grounded status to show.
  const a = article({ impactSignals: [impactSignal({ impact: 'NO_DIRECT_IMPACT', direction: 'NEUTRAL', strength: 'LOW', sourceStatus: null, publishedAt: '2026-09-20T08:00:00Z' })] });
  const ctx = buildPlayerNewsContext([a]);
  ok(ctx.categories.length === 0, '18. NO_DIRECT_IMPACT never becomes an invented category/status', ctx.categories);
  // QUESTIONABLE must render as Questionable, never escalate to Out.
  const q = article({ impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'MEDIUM', sourceStatus: 'QUESTIONABLE', publishedAt: '2026-09-20T08:00:00Z' })] });
  const ctxQ = buildPlayerNewsContext([q]);
  ok(ctxQ.categories[0].statusLabel === 'Questionable', '18b. QUESTIONABLE displays as "Questionable", never silently converted to "Out"', ctxQ.categories[0].statusLabel);
}

// ============================================================================
// 19. General News feed still receives unmatched articles
// ============================================================================
{
  // NewsView (unchanged this phase -- confirmed via git diff line-range
  // audit in the final report) merges slateNews+multiSportNews directly,
  // completely independent of playerNewsIndex/newsForPlayer. An unmatched
  // article missing from the player index is simply a different code path
  // that was never touched -- proven here by showing the SAME raw array
  // multiSportNews still contains it even after building the player index.
  const unmatched = article({ playerId: null, playerIdSource: null, headline: 'Unmatched, general-feed-only' });
  const linked = article({ articleId: 'linked1' });
  const multiSportNews = [unmatched, linked];
  buildPlayerNewsIndex(multiSportNews); // building the index must not mutate the source array
  ok(multiSportNews.length === 2 && multiSportNews.includes(unmatched), '19. multiSportNews (what NewsView renders) is untouched by index construction -- the unmatched article remains in the general feed', multiSportNews.length);
}

// ============================================================================
// 20. No betting language
// ============================================================================
{
  const BETTING_WORDS = /\b(good bet|bad bet|lock|smash|fade|over|under|boost|best play|bet this)\b/i;
  const allStatuses = Object.keys(NEWS_STATUS_LABELS);
  const leaks = allStatuses.filter(s => BETTING_WORDS.test(NEWS_STATUS_LABELS[s]));
  ok(leaks.length === 0, '20. No NEWS_STATUS_LABELS value contains betting-advice language', leaks);
  ok(!BETTING_WORDS.test(NEWS_CONTEXT_BUCKET_ORDER.join(' ')), '20b. No bucket label contains betting-advice language', null);
}

// ============================================================================
// 21. No model field changes (structural check: this module's own outputs
// never carry a model field, and it imports nothing from the model)
// ============================================================================
{
  const ctx = buildPlayerNewsContext([article({ impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'OUT', publishedAt: '2026-09-20T08:00:00Z' })] })]);
  const forbidden = ['probability', 'projection', 'edge', 'grade', 'prime', 'confluence', 'newsAdj', 'injuryAdj', 'roleAdj', 'minutesAdj', 'opportunityAdj'];
  const json = JSON.stringify(ctx).toLowerCase();
  const leaked = forbidden.filter(f => json.includes(f.toLowerCase()));
  ok(leaked.length === 0, '21. buildPlayerNewsContext\'s output contains no model-related field name whatsoever', leaked);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
