// News Intelligence Phase 2F -- research context layer regression suite.
// BeatsEdge.html has no module system, so this is a FAITHFUL STANDALONE
// EXTRACTION of the exact logic added this phase (buildPlayerResearchContext,
// built on top of Phase 2E's buildPlayerNewsContext/playerNewsIndex/
// newsForPlayer, all copied verbatim from the current post-Phase-2E/2F
// BeatsEdge.html source read this session), same convention already used
// by scripts/test-news-timeline.js and every other frontend-logic test in
// this repo.

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}

console.log('=== News Research Context (Phase 2F) Test ===\n');

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

// ---- Faithful extraction from BeatsEdge.html (Phase 2E, unchanged this phase) ----
const IMPACT_TO_BUCKET = {
  AVAILABILITY_UP: 'Availability', AVAILABILITY_DOWN: 'Availability',
  STARTING_UP: 'Starting status', STARTING_DOWN: 'Starting status',
  ROLE_UP: 'Role', ROLE_DOWN: 'Role',
  MINUTES_UP: 'Minutes', MINUTES_DOWN: 'Minutes',
  OPPORTUNITY_UP: 'Opportunity', OPPORTUNITY_DOWN: 'Opportunity',
  TRANSACTION: 'Transaction', ROSTER_CHANGE: 'Roster', RETURN: 'Return',
  GAME_CONTEXT: 'Game context', WEATHER_CONTEXT: 'Weather'
};
const NEWS_CONTEXT_BUCKET_ORDER = ['Availability', 'Starting status', 'Role', 'Minutes', 'Opportunity', 'Transaction', 'Roster', 'Return', 'Game context', 'Weather'];
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

// ---- Faithful extraction from BeatsEdge.html (Phase 2F, this phase) ----
function buildPlayerResearchContext(newsList) {
  const list = Array.isArray(newsList) ? newsList : [];
  const base = buildPlayerNewsContext(list);

  const byBucket = new Map();
  list.forEach(n => {
    (Array.isArray(n.impactSignals) ? n.impactSignals : []).forEach(s => {
      const bucket = IMPACT_TO_BUCKET[s.impact];
      if (!bucket) return;
      const ts = Date.parse(s.publishedAt || n.published) || 0;
      const cur = byBucket.get(bucket);
      if (!cur || ts > cur.ts) byBucket.set(bucket, { n, s, ts });
    });
  });
  const currentContext = NEWS_CONTEXT_BUCKET_ORDER.filter(b => byBucket.has(b)).map(bucket => {
    const { n, s } = byBucket.get(bucket);
    return {
      bucket, emoji: newsImpactEmoji(s.direction, s.strength),
      statusLabel: NEWS_STATUS_LABELS[s.sourceStatus] || (s.sourceStatus ? s.sourceStatus.replace(/_/g, ' ') : bucket),
      sourceStatus: s.sourceStatus, source: n.source, ageLabel: n.ageLabel,
      publishedAt: s.publishedAt, freshness: s.freshness, url: n.url, articleId: n.articleId
    };
  });

  const recentChanges = [];
  list.forEach(n => {
    (Array.isArray(n.impactSignals) ? n.impactSignals : []).forEach(s => {
      if (s.impact === 'NO_DIRECT_IMPACT') return;
      const bucket = IMPACT_TO_BUCKET[s.impact];
      if (!bucket) return;
      recentChanges.push({
        bucket, emoji: newsImpactEmoji(s.direction, s.strength), direction: s.direction,
        directionLabel: s.direction === 'UP' ? 'Up' : s.direction === 'DOWN' ? 'Down' : (NEWS_STATUS_LABELS[s.sourceStatus] || bucket),
        statusLabel: NEWS_STATUS_LABELS[s.sourceStatus] || (s.sourceStatus ? s.sourceStatus.replace(/_/g, ' ') : bucket),
        sourceStatus: s.sourceStatus, evidence: s.evidence, source: n.source, ageLabel: n.ageLabel,
        publishedAt: s.publishedAt, freshness: s.freshness, url: n.url, articleId: n.articleId
      });
    });
  });
  recentChanges.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));

  const conflicts = base.conflict
    ? recentChanges.filter(c => c.freshness && c.freshness !== 'OLDER' && (c.direction === 'UP' || c.direction === 'DOWN'))
    : [];

  const DAY_MS = 24 * 3600 * 1000;
  const changesLast24h = recentChanges.filter(c => {
    const ts = Date.parse(c.publishedAt);
    return Number.isFinite(ts) && (Date.now() - ts) < DAY_MS;
  }).length;

  return {
    currentContext, recentChanges, conflicts,
    counts: { totalArticles: list.length, linkedArticles: list.length, recentChanges: recentChanges.length, changesLast24h },
    lastUpdateAgeLabel: base.lastUpdateAgeLabel
  };
}

// ---- Fixture helpers (match fetchMultiSportNews's real shape) ----
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
// 1. Player with no news
// ============================================================================
{
  const research = buildPlayerResearchContext([]);
  ok(research.currentContext.length === 0 && research.recentChanges.length === 0 && research.conflicts.length === 0, '1. Player with no news -> empty currentContext/recentChanges/conflicts', research);
  ok(research.counts.totalArticles === 0 && research.counts.linkedArticles === 0 && research.counts.recentChanges === 0, '1b. Counts all zero for no news', research.counts);
}

// ============================================================================
// 2. Player with one article
// ============================================================================
{
  const a = article({ published: '2026-09-21T10:00:00Z', impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'OUT', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  ok(research.currentContext.length === 1 && research.currentContext[0].statusLabel === 'Out', '2. Player with one article -> currentContext has exactly one entry', research.currentContext);
  ok(research.recentChanges.length === 1, '2b. One article with one real signal -> one recent change', research.recentChanges.length);
}

// ============================================================================
// 3. Player with multiple articles
// ============================================================================
{
  const arts = [
    article({ articleId: 'a1', published: '2026-09-19T08:00:00Z', ageLabel: '2d', impactSignals: [impactSignal({ impact: 'STARTING_UP', direction: 'UP', strength: 'HIGH', sourceStatus: 'STARTING', publishedAt: '2026-09-19T08:00:00Z', freshness: 'OLDER' })] }),
    article({ articleId: 'a2', published: '2026-09-20T08:00:00Z', ageLabel: '1d', impactSignals: [impactSignal({ impact: 'ROLE_UP', direction: 'UP', strength: 'MEDIUM', sourceStatus: 'INCREASED_ROLE', publishedAt: '2026-09-20T08:00:00Z', freshness: 'RECENT' })] })
  ];
  const research = buildPlayerResearchContext(arts);
  ok(research.currentContext.length === 2 && research.recentChanges.length === 2, '3. Player with multiple articles across different buckets -> both appear in currentContext and recentChanges', { cc: research.currentContext.length, rc: research.recentChanges.length });
}

// ============================================================================
// 4. Current context uses source-derived data only
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'MEDIUM', sourceStatus: 'QUESTIONABLE', evidence: 'is questionable', publishedAt: '2026-09-20T08:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const row = research.currentContext[0];
  ok(row.statusLabel === 'Questionable' && row.sourceStatus === 'QUESTIONABLE', '4. currentContext status is the literal source-reported status (Questionable), never invented/escalated', row);
}

// ============================================================================
// 5. Recent changes require actual direction
// ============================================================================
{
  const noSignal = article({ impactSignals: [] });
  const research = buildPlayerResearchContext([noSignal]);
  ok(research.recentChanges.length === 0, '5. An article with no impact signals at all produces zero recent changes -- a static article is never treated as a change', research.recentChanges);
}

// ============================================================================
// 6. NO_DIRECT_IMPACT creates no change
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'NO_DIRECT_IMPACT', direction: 'NEUTRAL', strength: 'LOW', sourceStatus: null, publishedAt: '2026-09-20T08:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  ok(research.recentChanges.length === 0 && research.currentContext.length === 0, '6. NO_DIRECT_IMPACT -> zero recentChanges AND zero currentContext rows', research);
}

// ============================================================================
// 7. UP creates correct change
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'ROLE_UP', direction: 'UP', strength: 'MEDIUM', sourceStatus: 'INCREASED_ROLE', publishedAt: '2026-09-20T08:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  ok(research.recentChanges.length === 1 && research.recentChanges[0].direction === 'UP' && research.recentChanges[0].directionLabel === 'Up' && research.recentChanges[0].emoji === '🟢', '7. UP-direction signal creates a correctly-labeled, green change event', research.recentChanges[0]);
}

// ============================================================================
// 8. DOWN creates correct change
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'MINUTES_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'RESTRICTED', publishedAt: '2026-09-20T08:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  ok(research.recentChanges[0].direction === 'DOWN' && research.recentChanges[0].directionLabel === 'Down' && research.recentChanges[0].emoji === '🔴', '8. DOWN-direction HIGH-strength signal creates a correctly-labeled, red change event', research.recentChanges[0]);
}

// ============================================================================
// 9. RETURN preserved correctly
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'RETURN', direction: 'UP', strength: 'MEDIUM', sourceStatus: 'RETURNING', publishedAt: '2026-09-20T08:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  ok(research.recentChanges[0].bucket === 'Return' && research.recentChanges[0].statusLabel === 'Returning', '9. RETURN/RETURNING is preserved as its own Return-bucket change, never auto-upgraded to Starting', research.recentChanges[0]);
}

// ============================================================================
// 10. TRANSACTION preserved correctly
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'TRANSACTION', direction: 'NEUTRAL', strength: 'HIGH', sourceStatus: 'TRADE', publishedAt: '2026-09-20T08:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const c = research.recentChanges[0];
  ok(c.bucket === 'Transaction' && c.direction === 'NEUTRAL' && c.directionLabel === 'Trade' && c.emoji === '⚪', '10. TRANSACTION/TRADE (NEUTRAL direction) still becomes a real change event, labeled by its status since there is no UP/DOWN word for it', c);
}

// ============================================================================
// 11. ROSTER_CHANGE preserved correctly
// ============================================================================
{
  // Phase 2F fix (surfaced while writing this exact test): ROSTER_CHANGE
  // (lib/newsImpact.js's real impact name for ROSTER_MOVE classifications
  // -- call-ups, IL/IR placement, waivers, releases) had NO IMPACT_TO_BUCKET
  // entry since Phase 2E shipped, so real roster-move news never appeared
  // in the context summary. Step 3 explicitly requires a ROSTER category;
  // fixed in BeatsEdge.html this phase, verified here.
  const a = article({ sport: 'mlb', playerId: '660670', playerIdSource: 'mlb', impactSignals: [impactSignal({ impact: 'ROSTER_CHANGE', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'PLACED_ON_IL', publishedAt: '2026-09-20T08:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  ok(research.currentContext.length === 1 && research.currentContext[0].bucket === 'Roster' && research.currentContext[0].statusLabel === 'Placed on IL', '11a. ROSTER_CHANGE/PLACED_ON_IL correctly populates the Roster bucket with "Placed on IL"', research.currentContext[0]);
  ok(research.recentChanges.length === 1 && research.recentChanges[0].bucket === 'Roster', '11b. ROSTER_CHANGE also produces a real recentChanges entry, not silently dropped', research.recentChanges[0]);
}

// ============================================================================
// 12. Conflicting reports preserved
// ============================================================================
{
  const arts = [
    article({ articleId: 'c1', published: '2026-09-21T10:00:00Z', ageLabel: '2h', impactSignals: [impactSignal({ impact: 'STARTING_UP', direction: 'UP', strength: 'HIGH', sourceStatus: 'STARTING', publishedAt: '2026-09-21T10:00:00Z', freshness: 'RECENT' })] }),
    article({ articleId: 'c2', published: '2026-09-21T12:30:00Z', ageLabel: '30m', impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'MEDIUM', sourceStatus: 'QUESTIONABLE', publishedAt: '2026-09-21T12:30:00Z', freshness: 'RECENT' })] })
  ];
  const research = buildPlayerResearchContext(arts);
  ok(research.conflicts.length === 2, '12a. Both conflicting change events (STARTING then QUESTIONABLE) are preserved in conflicts', research.conflicts.map(c => c.statusLabel));
  ok(research.conflicts.some(c => c.articleId === 'c1') && research.conflicts.some(c => c.articleId === 'c2'), '12b. Both original articles are individually traceable via articleId inside conflicts', research.conflicts.map(c => c.articleId));
}

// ============================================================================
// 13. Conflicting reports do not resolve automatically
// ============================================================================
{
  const arts = [
    article({ articleId: 'c1', published: '2026-09-21T10:00:00Z', impactSignals: [impactSignal({ impact: 'STARTING_UP', direction: 'UP', strength: 'HIGH', sourceStatus: 'STARTING', publishedAt: '2026-09-21T10:00:00Z', freshness: 'RECENT' })] }),
    article({ articleId: 'c2', published: '2026-09-21T12:30:00Z', impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'MEDIUM', sourceStatus: 'QUESTIONABLE', publishedAt: '2026-09-21T12:30:00Z', freshness: 'RECENT' })] })
  ];
  const research = buildPlayerResearchContext(arts);
  // No field anywhere claims a single resolved/"final" status -- currentContext
  // simply keeps BOTH buckets (Starting status AND Availability) side by side,
  // neither overwriting nor suppressing the other.
  ok(research.currentContext.some(c => c.bucket === 'Starting status') && research.currentContext.some(c => c.bucket === 'Availability'), '13. Both the Starting-status and Availability current-context rows coexist -- no "final truth" merge or override', research.currentContext.map(c => c.bucket));
  ok(!('resolved' in research) && !('winner' in research) && !('finalStatus' in research), '13b. The research context object itself has no "resolved"/"winner"/"finalStatus" field -- structurally cannot declare a winner', Object.keys(research));
}

// ============================================================================
// 14. Newest article ordering
// ============================================================================
{
  const arts = [
    article({ articleId: 'o1', published: '2026-09-18T08:00:00Z', impactSignals: [impactSignal({ impact: 'TRANSACTION', direction: 'NEUTRAL', strength: 'MEDIUM', sourceStatus: 'SIGNED', publishedAt: '2026-09-18T08:00:00Z' })] }),
    article({ articleId: 'o2', published: '2026-09-20T08:00:00Z', impactSignals: [impactSignal({ impact: 'ROLE_UP', direction: 'UP', strength: 'MEDIUM', sourceStatus: 'INCREASED_ROLE', publishedAt: '2026-09-20T08:00:00Z' })] }),
    article({ articleId: 'o3', published: '2026-09-19T08:00:00Z', impactSignals: [impactSignal({ impact: 'RETURN', direction: 'UP', strength: 'MEDIUM', sourceStatus: 'RETURNING', publishedAt: '2026-09-19T08:00:00Z' })] })
  ];
  const research = buildPlayerResearchContext(arts);
  ok(research.recentChanges.map(c => c.articleId).join(',') === 'o2,o3,o1', '14. recentChanges sorted strictly newest -> oldest by publishedAt', research.recentChanges.map(c => c.articleId));
}

// ============================================================================
// 15. Old article remains historical
// ============================================================================
{
  const oldArt = article({ published: '2026-08-01T08:00:00Z', ageLabel: '51d', impactSignals: [impactSignal({ impact: 'STARTING_UP', direction: 'UP', strength: 'HIGH', sourceStatus: 'STARTING', publishedAt: '2026-08-01T08:00:00Z', freshness: 'OLDER' })] });
  const research = buildPlayerResearchContext([oldArt]);
  ok(research.recentChanges.length === 1 && research.recentChanges[0].publishedAt === '2026-08-01T08:00:00Z', '15a. A 51-day-old article still produces its own recentChanges entry with its real, untouched publishedAt', research.recentChanges[0].publishedAt);
  ok(research.counts.changesLast24h === 0, '15b. It does NOT count toward changesLast24h -- an old event is never presented as "just happened"', research.counts.changesLast24h);
}

// ============================================================================
// 16. Source URL preserved
// ============================================================================
{
  const a = article({ url: 'https://espn.com/real-article-123', impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'OUT', publishedAt: '2026-09-20T08:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  ok(research.currentContext[0].url === 'https://espn.com/real-article-123', '16a. currentContext row carries the real article URL, never fabricated/omitted', research.currentContext[0].url);
  ok(research.recentChanges[0].url === 'https://espn.com/real-article-123', '16b. recentChanges entry also carries the real URL', research.recentChanges[0].url);
}

// ============================================================================
// 17. Source attribution preserved
// ============================================================================
{
  const a = article({ source: 'Yahoo Sports', impactSignals: [impactSignal({ impact: 'ROLE_UP', direction: 'UP', strength: 'MEDIUM', sourceStatus: 'INCREASED_ROLE', publishedAt: '2026-09-20T08:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  ok(research.currentContext[0].source === 'Yahoo Sports' && research.recentChanges[0].source === 'Yahoo Sports', '17. Real outlet name (Yahoo Sports) is preserved on both currentContext and recentChanges, never replaced with a generic label', { cc: research.currentContext[0].source, rc: research.recentChanges[0].source });
}

// ============================================================================
// 18. Canonical player ID required
// ============================================================================
{
  const idx = buildPlayerNewsIndex([article({ playerId: '1966' })]);
  const withId = newsForPlayer(idx, { id: '1966', sport: 'nba' });
  const withoutId = newsForPlayer(idx, { id: null, sport: 'nba' });
  ok(withId.length === 1, '18a. A player object WITH a canonical id resolves real news', withId.length);
  ok(withoutId.length === 0, '18b. A player object with id:null resolves nothing -- canonical id is required, never optional/guessed', withoutId.length);
}

// ============================================================================
// 19. Unmatched article excluded
// ============================================================================
{
  const unmatched = article({ playerId: null, playerIdSource: null });
  const idx = buildPlayerNewsIndex([unmatched]);
  ok(idx.size === 0, '19. An unmatched article (playerId null) never enters the player index at all', idx.size);
}

// ============================================================================
// 20. Ambiguous article excluded
// ============================================================================
{
  const ambiguous = article({ playerId: null, playerIdSource: null, headline: 'Two same-named players ruled out' });
  const idx = buildPlayerNewsIndex([ambiguous]);
  const news = newsForPlayer(idx, { id: '1966', sport: 'nba' });
  ok(news.length === 0, '20. An AMBIGUOUS article never appears in any player\'s research context, regardless of explicit-sounding text', news.length);
}

// ============================================================================
// 21. No fuzzy matching
// ============================================================================
{
  // The join key is built purely from sport+playerIdSource+playerId -- no
  // code path in newsForPlayer/buildPlayerNewsIndex/buildPlayerResearchContext
  // reads headline/summary text to decide a match.
  const a = article({ playerId: '1966', headline: 'Completely unrelated headline text about nothing in particular' });
  const idx = buildPlayerNewsIndex([a]);
  const news = newsForPlayer(idx, { id: '1966', sport: 'nba' });
  ok(news.length === 1, '21. Join succeeds purely on canonical id, independent of headline wording -- proving no text-based matching is involved anywhere in the Phase 2F layer', null);
}

// ============================================================================
// 22. No teammate inference
// ============================================================================
{
  // buildPlayerResearchContext only ever reads the SAME player's own
  // already-linked article list -- there is no code path that could
  // reference or infer a second player from an article mentioning one.
  const a = article({ impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'OUT', publishedAt: '2026-09-20T08:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const allFields = JSON.stringify(research);
  ok(!allFields.includes('teammate') && !research.currentContext.some(c => 'playerId' in c) && !research.recentChanges.some(c => 'playerId' in c), '22. No currentContext/recentChanges entry carries any player-identity field -- structurally cannot name a second, inferred player', null);
}

// ============================================================================
// 23. Empty categories omitted
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'TRANSACTION', direction: 'NEUTRAL', strength: 'HIGH', sourceStatus: 'TRADE', publishedAt: '2026-09-20T08:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  ok(research.currentContext.length === 1 && research.currentContext[0].bucket === 'Transaction', '23. Only Transaction appears -- Availability/Role/Minutes/etc. are simply absent, never shown as empty rows', research.currentContext.map(c => c.bucket));
}

// ============================================================================
// 24. No duplicate API requests
// ============================================================================
{
  // playerNewsIndex is built ONCE (Phase 2B, unchanged); buildPlayerResearchContext
  // is a pure function over whatever list it's given -- calling it repeatedly
  // for different players never triggers a new fetch, it's just a Map lookup
  // + in-memory transform each time.
  const arts = [article({ playerId: '1966' }), article({ playerId: '4277905', articleId: 'ESPN:trae' })];
  const idx = buildPlayerNewsIndex(arts); // built once
  const r1 = buildPlayerResearchContext(newsForPlayer(idx, { id: '1966', sport: 'nba' }));
  const r2 = buildPlayerResearchContext(newsForPlayer(idx, { id: '4277905', sport: 'nba' }));
  ok(r1.counts.totalArticles === 1 && r2.counts.totalArticles === 1, '24. Two different players\' research context both computed from the SAME pre-built index -- zero additional fetches, zero N+1 requests', { r1: r1.counts.totalArticles, r2: r2.counts.totalArticles });
}

// ============================================================================
// 25. No betting language
// ============================================================================
{
  const BETTING_WORDS = /\b(good bet|bad bet|lock|smash|fade|over|under|boost|best play|bet this)\b/i;
  const labels = [...Object.values(NEWS_STATUS_LABELS), ...NEWS_CONTEXT_BUCKET_ORDER];
  const leaks = labels.filter(l => BETTING_WORDS.test(l));
  ok(leaks.length === 0, '25. No status label or bucket name used by the research context layer contains betting-advice language', leaks);
}

// ============================================================================
// 26. No model fields modified
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'OUT', publishedAt: '2026-09-20T08:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const forbidden = ['probability', 'projection', 'edge', 'grade', 'prime', 'confluence', 'newsadj', 'injuryadj', 'roleadj', 'minutesadj', 'opportunityadj', 'newsprobability', 'newsedge', 'newsgrade', 'newsprime'];
  const json = JSON.stringify(research).toLowerCase();
  const leaked = forbidden.filter(f => json.includes(f));
  ok(leaked.length === 0, '26. buildPlayerResearchContext\'s output contains no model-related field name whatsoever', leaked);
}

// ============================================================================
// 27. No probability modification (structural: module never touches it)
// ============================================================================
{
  ok(typeof buildPlayerResearchContext === 'function' && buildPlayerResearchContext.toString().indexOf('modelProb') === -1 && buildPlayerResearchContext.toString().indexOf('calculateEdgeScore') === -1, '27. buildPlayerResearchContext\'s own source never references modelProb/calculateEdgeScore', null);
}

// ============================================================================
// 28. No edge modification
// ============================================================================
{
  ok(buildPlayerResearchContext.toString().indexOf('edgePct') === -1 && buildPlayerResearchContext.toString().indexOf('GRADE_CUTOFFS') === -1, '28. buildPlayerResearchContext\'s own source never references edgePct/GRADE_CUTOFFS', null);
}

// ============================================================================
// 29. No grade/Prime modification
// ============================================================================
{
  ok(buildPlayerResearchContext.toString().indexOf('PRIME_FAMILY') === -1 && buildPlayerResearchContext.toString().indexOf('findPrimePicks') === -1, '29. buildPlayerResearchContext\'s own source never references PRIME_FAMILY/findPrimePicks', null);
}

// ============================================================================
// 30. Multi-sport identity safety
// ============================================================================
{
  // MLB cards join on playerIdSource:'mlb'; NFL/NBA/etc join on 'espn'.
  // An MLB-sourced article must never satisfy an NBA player's context, and
  // nflverse-space NFL news (a different id space than the live NFL card's
  // own id -- see Phase 2A/2B) must never attach either.
  const mlbArticle = article({ sport: 'mlb', playerId: '660670', playerIdSource: 'mlb', articleId: 'mlb1' });
  const nbaArticle = article({ sport: 'nba', playerId: '660670', playerIdSource: 'espn', articleId: 'nba1' }); // FIXTURE: numerically-coincidental id, different sport+source
  const nflverseArticle = article({ sport: 'nfl', playerId: '00-0019596', playerIdSource: 'nflverse', articleId: 'nflv1' });
  const idx = buildPlayerNewsIndex([mlbArticle, nbaArticle, nflverseArticle]);
  const mlbPlayer = newsForPlayer(idx, { id: '660670', sport: 'mlb' });
  const nflCardPlayer = newsForPlayer(idx, { id: '00-0019596', sport: 'nfl' }); // NFL cards always join on 'espn', never 'nflverse'
  ok(mlbPlayer.length === 1 && mlbPlayer[0].articleId === 'mlb1', '30a. MLB player resolves only the mlb-id-space article, not the numerically-coincidental NBA one', mlbPlayer.map(a => a.articleId));
  ok(nflCardPlayer.length === 0, '30b. An NFL card (which always joins on the ESPN id space) never resolves nflverse-sourced news, even with a matching id string', nflCardPlayer.length);
  const researchMlb = buildPlayerResearchContext(mlbPlayer);
  ok(researchMlb.counts.totalArticles === 1, '30c. Multi-sport safety holds all the way through buildPlayerResearchContext -- no cross-sport bleed in counts', researchMlb.counts);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
