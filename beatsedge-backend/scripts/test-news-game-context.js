// News Intelligence Phase 2H -- game/slate research context regression
// suite. BeatsEdge.html has no module system, so this is a FAITHFUL
// STANDALONE EXTRACTION of the exact logic added this phase
// (articleMatchesGame/buildGameResearchContext, reusing Phase 2E/2F/2G's
// IMPACT_TO_BUCKET/NEWS_STATUS_LABELS/newsImpactEmoji/
// NEWS_CONTEXT_BUCKET_ORDER unchanged), same convention already used by
// every other frontend-logic test in this repo. Fixture articles use the
// real post-Phase-2H fetchMultiSportNews shape (teams: [], eventId, etc.)
// confirmed by direct read of BeatsEdge.html this session.

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}

console.log('=== News Game / Slate Research Context (Phase 2H) Test ===\n');

// ---- Faithful extraction from BeatsEdge.html (Phase 2E, unchanged) ----
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

// ---- Faithful extraction from BeatsEdge.html (Phase 2H, this phase) ----
const articleMatchesGame = (article, game) => {
  if (!article || !game) return false;
  if (article.eventId != null && game.eventId != null && String(article.eventId) === String(game.eventId)) return true;
  if (!article.sport || article.sport !== game.sport) return false;
  const teams = Array.isArray(article.teams) ? article.teams : [];
  if (!teams.length) return false;
  const home = game.homeTeam ? String(game.homeTeam).trim().toUpperCase() : null;
  const away = game.awayTeam ? String(game.awayTeam).trim().toUpperCase() : null;
  return teams.some(t => {
    const teamNorm = t ? String(t).trim().toUpperCase() : '';
    return !!teamNorm && ((!!home && teamNorm === home) || (!!away && teamNorm === away));
  });
};
const buildGameResearchContext = (game, newsList) => {
  const list = (Array.isArray(newsList) ? newsList : [])
    .filter(a => articleMatchesGame(a, game))
    .slice()
    .sort((a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0));

  const byBucket = new Map();
  const recentChanges = [];
  let hasRecentUp = false, hasRecentDown = false;
  list.forEach(n => {
    (Array.isArray(n.impactSignals) ? n.impactSignals : []).forEach(s => {
      if (s.impact === 'NO_DIRECT_IMPACT') return;
      const bucket = IMPACT_TO_BUCKET[s.impact];
      if (!bucket) return;
      const ts = Date.parse(s.publishedAt || n.published) || 0;
      const cur = byBucket.get(bucket);
      if (!cur || ts > cur.ts) byBucket.set(bucket, { n, s, ts });
      recentChanges.push({
        bucket, emoji: newsImpactEmoji(s.direction, s.strength), direction: s.direction,
        directionLabel: s.direction === 'UP' ? 'Up' : s.direction === 'DOWN' ? 'Down' : (NEWS_STATUS_LABELS[s.sourceStatus] || bucket),
        statusLabel: NEWS_STATUS_LABELS[s.sourceStatus] || (s.sourceStatus ? s.sourceStatus.replace(/_/g, ' ') : bucket),
        sourceStatus: s.sourceStatus, evidence: s.evidence, source: n.source, ageLabel: n.ageLabel,
        publishedAt: s.publishedAt, freshness: s.freshness, url: n.url, articleId: n.articleId,
        impact: s.impact, strength: s.strength, team: (Array.isArray(n.teams) && n.teams[0]) || null
      });
      if (s.freshness && s.freshness !== 'OLDER') {
        if (s.direction === 'UP') hasRecentUp = true;
        if (s.direction === 'DOWN') hasRecentDown = true;
      }
    });
  });
  recentChanges.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));

  const currentContext = NEWS_CONTEXT_BUCKET_ORDER.filter(b => byBucket.has(b)).map(bucket => {
    const { n, s } = byBucket.get(bucket);
    return {
      bucket, emoji: newsImpactEmoji(s.direction, s.strength),
      statusLabel: NEWS_STATUS_LABELS[s.sourceStatus] || (s.sourceStatus ? s.sourceStatus.replace(/_/g, ' ') : bucket),
      sourceStatus: s.sourceStatus, source: n.source, ageLabel: n.ageLabel,
      publishedAt: s.publishedAt, freshness: s.freshness, url: n.url, articleId: n.articleId
    };
  });

  const conflicts = (hasRecentUp && hasRecentDown)
    ? recentChanges.filter(c => c.freshness && c.freshness !== 'OLDER' && (c.direction === 'UP' || c.direction === 'DOWN'))
    : [];

  const DAY_MS = 24 * 3600 * 1000;
  const changesLast24h = recentChanges.filter(c => {
    const ts = Date.parse(c.publishedAt);
    return Number.isFinite(ts) && (Date.now() - ts) < DAY_MS;
  }).length;

  return {
    game, currentContext, recentChanges, conflicts,
    counts: { totalArticles: list.length, linkedArticles: list.length, recentChanges: recentChanges.length, changesLast24h }
  };
};

// ---- Fixture helpers (match the real post-Phase-2H article shape) ----
function impactSignal({ impact, direction, strength, sourceStatus, evidence = 'evidence', publishedAt, freshness = 'RECENT' }) {
  return { impact, direction, strength, evidence, sourceCategory: null, sourceStatus, classificationSource: 'newsImpact:rule-based', freshness, publishedAt, updatedAt: null };
}
function article({ sport = 'nba', teams = [], eventId = null, published, ageLabel = '1h', headline = 'Headline', source = 'ESPN', url = 'https://example.com/a', articleId, impactSignals = [] }) {
  return { headline, description: '', published, ageLabel, url, athlete: null, teams, kind: null, sport, source, image: null, articleId: articleId || `${source}:${url || headline}`, playerId: null, playerIdSource: null, playerMatchMethod: null, isNew: false, classifications: [], impactSignals, eventId };
}
function game({ eventId = 'evt1', sport = 'nba', homeTeam = 'Los Angeles Lakers', awayTeam = 'Phoenix Suns', commenceTimeMs = Date.now() + 3600000, status = 'UPCOMING' }) {
  return { eventId, sport, homeTeam, awayTeam, commenceTimeMs, status };
}
const sig = (over = {}) => impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'OUT', publishedAt: '2026-09-21T10:00:00Z', ...over });

// ============================================================================
// 1. Exact eventId match
// ============================================================================
{
  const g = game({ eventId: 'evt-real-123' });
  const a = article({ eventId: 'evt-real-123', teams: [], impactSignals: [sig()] }); // no team needed -- eventId alone is sufficient
  ok(articleMatchesGame(a, g) === true, '1. Exact eventId match (both real, non-null, equal) -> true', null);
}

// ============================================================================
// 2. eventId mismatch
// ============================================================================
{
  const g = game({ eventId: 'evt-A' });
  const a = article({ eventId: 'evt-B', teams: [] });
  ok(articleMatchesGame(a, g) === false, '2. eventId present on both sides but different -> false (falls through to team check, which also fails with no teams)', null);
}

// ============================================================================
// 3. Missing eventId
// ============================================================================
{
  const g = game({ eventId: 'evt-A' });
  const a = article({ eventId: null, teams: [] });
  ok(articleMatchesGame(a, g) === false, '3. Missing article.eventId (the real, current production state -- always null) never matches via tier 1, correctly falls through', null);
}

// ============================================================================
// 4. Team match
// ============================================================================
{
  const g = game({ homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns', sport: 'nba' });
  const a = article({ sport: 'nba', teams: ['Los Angeles Lakers'] });
  ok(articleMatchesGame(a, g) === true, '4. Team string exactly matching homeTeam (case-normalized) -> true', null);
}

// ============================================================================
// 5. Team mismatch
// ============================================================================
{
  const g = game({ homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns', sport: 'nba' });
  const a = article({ sport: 'nba', teams: ['Boston Celtics'] });
  ok(articleMatchesGame(a, g) === false, '5. Team string matching neither homeTeam nor awayTeam -> false', null);
}

// ============================================================================
// 6. Sport mismatch
// ============================================================================
{
  const g = game({ homeTeam: 'BOS', awayTeam: 'NYY', sport: 'mlb' });
  const a = article({ sport: 'nba', teams: ['BOS'] }); // FIXTURE: same abbreviation text, different sport
  ok(articleMatchesGame(a, g) === false, '6. Identical team text but different sport -> false (sport is a hard boundary, never crossed)', null);
}

// ============================================================================
// 7. League mismatch (represented via sport key, since this app has no
// separate league field distinct from its internal sport key -- ncaaf vs
// nfl are themselves the two "leagues" for football)
// ============================================================================
{
  const g = game({ homeTeam: 'Texas', awayTeam: 'Oklahoma', sport: 'ncaaf' });
  const a = article({ sport: 'nfl', teams: ['Texas'] });
  ok(articleMatchesGame(a, g) === false, '7. NFL article never matches an NCAAF game even with identical team text -- sport key doubles as the league boundary', null);
}

// ============================================================================
// 8. Empty news
// ============================================================================
{
  const g = game({});
  const gr = buildGameResearchContext(g, []);
  ok(gr.currentContext.length === 0 && gr.recentChanges.length === 0 && gr.conflicts.length === 0 && gr.counts.totalArticles === 0, '8. Empty news list -> empty context, zero counts', gr.counts);
}

// ============================================================================
// 9. Player-only article exclusion (no team tag, no eventId -- Step 2/4:
// never inferred from the mere fact a player plays in this game)
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const a = article({ sport: 'nba', teams: [], impactSignals: [sig()] }); // FIXTURE: a real player-linked article with NO verified team tag
  ok(articleMatchesGame(a, g) === false, '9. A player-only article with no verified team tag never attaches to the game, even carrying a real impact signal', null);
}

// ============================================================================
// 10. Verified team article inclusion
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const a = article({ sport: 'nba', teams: ['Phoenix Suns'], impactSignals: [sig()] });
  const gr = buildGameResearchContext(g, [a]);
  ok(gr.counts.totalArticles === 1 && gr.currentContext.length === 1, '10. A verified-team article (real ESPN team tag matching awayTeam) is included', gr.counts);
}

// ============================================================================
// 11. Game-context article inclusion
// ============================================================================
{
  const g = game({ sport: 'mlb', homeTeam: 'Boston Red Sox', awayTeam: 'New York Yankees' });
  const a = article({ sport: 'mlb', teams: ['Boston Red Sox'], impactSignals: [impactSignal({ impact: 'GAME_CONTEXT', direction: 'NEUTRAL', strength: 'LOW', sourceStatus: 'POSTPONED_OR_SUSPENDED', publishedAt: '2026-09-21T10:00:00Z' })] });
  const gr = buildGameResearchContext(g, [a]);
  ok(gr.currentContext.length === 1 && gr.currentContext[0].bucket === 'Game context', '11. A GAME_CONTEXT signal on a verified-team article populates the Game context bucket', gr.currentContext[0]);
}

// ============================================================================
// 12. Weather/game-context handling
// ============================================================================
{
  const g = game({ sport: 'nfl', homeTeam: 'Green Bay Packers', awayTeam: 'Chicago Bears' });
  const a = article({ sport: 'nfl', teams: ['Green Bay Packers'], impactSignals: [impactSignal({ impact: 'WEATHER_CONTEXT', direction: 'NEUTRAL', strength: 'LOW', sourceStatus: 'WEATHER_IMPACT', publishedAt: '2026-09-21T10:00:00Z' })] });
  const gr = buildGameResearchContext(g, [a]);
  ok(gr.currentContext[0].bucket === 'Weather' && gr.currentContext[0].statusLabel === 'Weather impact', '12. WEATHER_CONTEXT correctly populates the Weather bucket', gr.currentContext[0]);
}

// ============================================================================
// 13. Availability signal handling
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const a = article({ sport: 'nba', teams: ['Los Angeles Lakers'], impactSignals: [sig({ sourceStatus: 'OUT' })] });
  const gr = buildGameResearchContext(g, [a]);
  ok(gr.currentContext[0].bucket === 'Availability' && gr.currentContext[0].statusLabel === 'Out', '13. AVAILABILITY_DOWN/OUT on a verified-team article populates Availability', gr.currentContext[0]);
}

// ============================================================================
// 14. Transaction handling
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const a = article({ sport: 'nba', teams: ['Phoenix Suns'], impactSignals: [impactSignal({ impact: 'TRANSACTION', direction: 'NEUTRAL', strength: 'HIGH', sourceStatus: 'TRADE', publishedAt: '2026-09-21T10:00:00Z' })] });
  const gr = buildGameResearchContext(g, [a]);
  ok(gr.currentContext[0].bucket === 'Transaction' && gr.currentContext[0].statusLabel === 'Trade', '14. TRANSACTION/TRADE on a verified team-level article populates Transaction', gr.currentContext[0]);
}

// ============================================================================
// 15. Roster-change handling
// ============================================================================
{
  const g = game({ sport: 'mlb', homeTeam: 'Boston Red Sox', awayTeam: 'New York Yankees' });
  const a = article({ sport: 'mlb', teams: ['Boston Red Sox'], impactSignals: [impactSignal({ impact: 'ROSTER_CHANGE', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'PLACED_ON_IL', publishedAt: '2026-09-21T10:00:00Z' })] });
  const gr = buildGameResearchContext(g, [a]);
  ok(gr.currentContext[0].bucket === 'Roster' && gr.currentContext[0].statusLabel === 'Placed on IL', '15. ROSTER_CHANGE/PLACED_ON_IL populates the Roster bucket (Phase 2F\'s own fix, reused correctly here)', gr.currentContext[0]);
}

// ============================================================================
// 16. Return handling
// ============================================================================
{
  const g = game({ sport: 'nfl', homeTeam: 'Green Bay Packers', awayTeam: 'Chicago Bears' });
  const a = article({ sport: 'nfl', teams: ['Chicago Bears'], impactSignals: [impactSignal({ impact: 'RETURN', direction: 'UP', strength: 'MEDIUM', sourceStatus: 'RETURNING', publishedAt: '2026-09-21T10:00:00Z' })] });
  const gr = buildGameResearchContext(g, [a]);
  ok(gr.currentContext[0].bucket === 'Return' && gr.currentContext[0].statusLabel === 'Returning', '16. RETURN/RETURNING populates the Return bucket', gr.currentContext[0]);
}

// ============================================================================
// 17. Recent-change generation
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const a = article({ sport: 'nba', teams: ['Los Angeles Lakers'], impactSignals: [sig()] });
  const gr = buildGameResearchContext(g, [a]);
  ok(gr.recentChanges.length === 1, '17. A single qualifying signal produces exactly one recentChanges entry', gr.recentChanges.length);
}

// ============================================================================
// 18. Current-context generation
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const arts = [
    article({ articleId: 'a1', sport: 'nba', teams: ['Los Angeles Lakers'], published: '2026-09-19T08:00:00Z', ageLabel: '2d', impactSignals: [sig({ publishedAt: '2026-09-19T08:00:00Z', freshness: 'OLDER' })] }),
    article({ articleId: 'a2', sport: 'nba', teams: ['Los Angeles Lakers'], published: '2026-09-20T08:00:00Z', ageLabel: '1d', impactSignals: [sig({ sourceStatus: 'QUESTIONABLE', strength: 'MEDIUM', publishedAt: '2026-09-20T08:00:00Z', freshness: 'OLDER' })] })
  ];
  const gr = buildGameResearchContext(g, arts);
  ok(gr.currentContext.length === 1 && gr.currentContext[0].statusLabel === 'Questionable', '18. currentContext keeps only the NEWEST signal per bucket (Questionable, from the newer article) -- not both', gr.currentContext[0]);
}

// ============================================================================
// 19. Conflict detection
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const arts = [
    article({ articleId: 'c1', sport: 'nba', teams: ['Los Angeles Lakers'], published: '2026-09-21T10:00:00Z', impactSignals: [impactSignal({ impact: 'STARTING_UP', direction: 'UP', strength: 'HIGH', sourceStatus: 'STARTING', publishedAt: '2026-09-21T10:00:00Z', freshness: 'RECENT' })] }),
    article({ articleId: 'c2', sport: 'nba', teams: ['Los Angeles Lakers'], published: '2026-09-21T12:00:00Z', impactSignals: [sig({ sourceStatus: 'QUESTIONABLE', strength: 'MEDIUM', publishedAt: '2026-09-21T12:00:00Z', freshness: 'RECENT' })] })
  ];
  const gr = buildGameResearchContext(g, arts);
  ok(gr.conflicts.length === 2, '19. Recent STARTING_UP + AVAILABILITY_DOWN for the same team -> conflict flagged, both preserved', gr.conflicts.map(c => c.statusLabel));
}

// ============================================================================
// 20. Freshness
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const a = article({ sport: 'nba', teams: ['Los Angeles Lakers'], impactSignals: [sig({ freshness: 'NEW' })] });
  const gr = buildGameResearchContext(g, [a]);
  ok(gr.currentContext[0].freshness === 'NEW', '20. Real freshness value preserved unchanged, not recomputed', gr.currentContext[0].freshness);
}

// ============================================================================
// 21. Source preservation
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const a = article({ sport: 'nba', teams: ['Los Angeles Lakers'], source: 'Yahoo Sports', impactSignals: [sig()] });
  const gr = buildGameResearchContext(g, [a]);
  ok(gr.currentContext[0].source === 'Yahoo Sports', '21. Real outlet name preserved, never genericized', gr.currentContext[0].source);
}

// ============================================================================
// 22. URL preservation
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const a = article({ sport: 'nba', teams: ['Los Angeles Lakers'], url: 'https://espn.com/real-game-article', impactSignals: [sig()] });
  const gr = buildGameResearchContext(g, [a]);
  ok(gr.currentContext[0].url === 'https://espn.com/real-game-article', '22. Real article URL preserved for traceability to the original source', gr.currentContext[0].url);
}

// ============================================================================
// 23. articleId preservation
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const a = article({ sport: 'nba', teams: ['Los Angeles Lakers'], articleId: 'ESPN:real-id-999', impactSignals: [sig()] });
  const gr = buildGameResearchContext(g, [a]);
  ok(gr.currentContext[0].articleId === 'ESPN:real-id-999', '23. Real articleId preserved', gr.currentContext[0].articleId);
}

// ============================================================================
// 24. Newest-first ordering
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const arts = [
    article({ articleId: 'o1', sport: 'nba', teams: ['Los Angeles Lakers'], published: '2026-09-18T08:00:00Z', impactSignals: [impactSignal({ impact: 'TRANSACTION', direction: 'NEUTRAL', strength: 'MEDIUM', sourceStatus: 'SIGNED', publishedAt: '2026-09-18T08:00:00Z' })] }),
    article({ articleId: 'o2', sport: 'nba', teams: ['Los Angeles Lakers'], published: '2026-09-20T08:00:00Z', impactSignals: [impactSignal({ impact: 'ROLE_UP', direction: 'UP', strength: 'MEDIUM', sourceStatus: 'INCREASED_ROLE', publishedAt: '2026-09-20T08:00:00Z' })] }),
    article({ articleId: 'o3', sport: 'nba', teams: ['Los Angeles Lakers'], published: '2026-09-19T08:00:00Z', impactSignals: [impactSignal({ impact: 'RETURN', direction: 'UP', strength: 'MEDIUM', sourceStatus: 'RETURNING', publishedAt: '2026-09-19T08:00:00Z' })] })
  ];
  const gr = buildGameResearchContext(g, arts);
  ok(gr.recentChanges.map(c => c.articleId).join(',') === 'o2,o3,o1', '24. recentChanges sorted strictly newest -> oldest', gr.recentChanges.map(c => c.articleId));
}

// ============================================================================
// 25. Duplicate handling (same articleId twice -- upstream Phase 1 dedupe
// guarantees this never happens in production; verify the join layer
// doesn't itself explode/double-count if it ever did)
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const a = article({ sport: 'nba', teams: ['Los Angeles Lakers'], articleId: 'dup1', impactSignals: [sig()] });
  const gr = buildGameResearchContext(g, [a, { ...a }]);
  ok(gr.counts.totalArticles === 2 && gr.recentChanges.length === 2, '25. Two rows sharing one articleId are both processed without crashing (Phase 1\'s own UNIQUE constraint prevents this in real production)', gr.counts);
}

// ============================================================================
// 26. Multiple articles
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const arts = [
    article({ articleId: 'm1', sport: 'nba', teams: ['Los Angeles Lakers'], impactSignals: [sig()] }),
    article({ articleId: 'm2', sport: 'nba', teams: ['Phoenix Suns'], impactSignals: [impactSignal({ impact: 'ROLE_UP', direction: 'UP', strength: 'MEDIUM', sourceStatus: 'INCREASED_ROLE', publishedAt: '2026-09-21T09:00:00Z' })] })
  ];
  const gr = buildGameResearchContext(g, arts);
  ok(gr.counts.totalArticles === 2 && gr.currentContext.length === 2, '26. Multiple distinct articles for the same game both contribute', gr.counts);
}

// ============================================================================
// 27. Multiple teams (home AND away both contribute to the SAME game context)
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const arts = [
    article({ articleId: 't1', sport: 'nba', teams: ['Los Angeles Lakers'], impactSignals: [sig()] }),
    article({ articleId: 't2', sport: 'nba', teams: ['Phoenix Suns'], impactSignals: [impactSignal({ impact: 'STARTING_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'NOT_STARTING', publishedAt: '2026-09-21T09:00:00Z' })] })
  ];
  const gr = buildGameResearchContext(g, arts);
  ok(gr.recentChanges.some(c => c.team === 'Los Angeles Lakers') && gr.recentChanges.some(c => c.team === 'Phoenix Suns'), '27. Both the home team\'s and the away team\'s verified articles contribute to the one shared game context', gr.recentChanges.map(c => c.team));
}

// ============================================================================
// 28. Home team
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const a = article({ sport: 'nba', teams: ['Los Angeles Lakers'] });
  ok(articleMatchesGame(a, g) === true, '28. An article tagged with the real homeTeam matches', null);
}

// ============================================================================
// 29. Away team
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const a = article({ sport: 'nba', teams: ['Phoenix Suns'] });
  ok(articleMatchesGame(a, g) === true, '29. An article tagged with the real awayTeam matches', null);
}

// ============================================================================
// 30. Unrelated team
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const a = article({ sport: 'nba', teams: ['Miami Heat'] });
  ok(articleMatchesGame(a, g) === false, '30. An article tagged with a team unrelated to either side of this game never matches', null);
}

// ============================================================================
// 31. Cross-sport isolation
// ============================================================================
{
  const nbaGame = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const mlbArticle = article({ sport: 'mlb', teams: ['Los Angeles Lakers'] }); // FIXTURE: nonsensical but proves the boundary
  ok(articleMatchesGame(mlbArticle, nbaGame) === false, '31. An article from a different sport never matches, even with identical team text', null);
}

// ============================================================================
// 32. Cross-league isolation (NCAAF vs NFL, this app's own "league" boundary)
// ============================================================================
{
  const ncaafGame = game({ sport: 'ncaaf', homeTeam: 'Ohio State', awayTeam: 'Michigan' });
  const nflArticle = article({ sport: 'nfl', teams: ['Ohio State'] });
  ok(articleMatchesGame(nflArticle, ncaafGame) === false, '32. An NFL-sport article never matches an NCAAF game', null);
}

// ============================================================================
// 33. Empty-state behavior
// ============================================================================
{
  const g = game({ sport: 'wnba', homeTeam: 'Las Vegas Aces', awayTeam: 'New York Liberty' });
  const gr = buildGameResearchContext(g, []);
  ok(gr.currentContext.length === 0 && gr.recentChanges.length === 0 && gr.conflicts.length === 0, '33. No matching news at all -> every array empty, nothing invented', gr);
}

// ============================================================================
// 34. Counts
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const arts = [
    article({ articleId: 'ct1', sport: 'nba', teams: ['Los Angeles Lakers'], impactSignals: [sig()] }),
    article({ articleId: 'ct2', sport: 'nba', teams: ['Phoenix Suns'], impactSignals: [] }) // real article, no qualifying signal
  ];
  const gr = buildGameResearchContext(g, arts);
  ok(gr.counts.totalArticles === 2 && gr.counts.linkedArticles === 2 && gr.counts.recentChanges === 1, '34. counts correctly reflects 2 matched articles but only 1 real change event', gr.counts);
}

// ============================================================================
// 35. changesLast24h
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const oldArt = article({ sport: 'nba', teams: ['Los Angeles Lakers'], impactSignals: [sig({ publishedAt: '2026-08-01T08:00:00Z' })] });
  const gr = buildGameResearchContext(g, [oldArt]);
  ok(gr.counts.changesLast24h === 0, '35. A 51-day-old change does not count toward changesLast24h', gr.counts.changesLast24h);
}

// ============================================================================
// 36. No player inference (a change entry carries no playerId field)
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const a = article({ sport: 'nba', teams: ['Los Angeles Lakers'], impactSignals: [sig()] });
  const gr = buildGameResearchContext(g, [a]);
  ok(!('playerId' in gr.recentChanges[0]) && !('playerName' in gr.recentChanges[0]), '36. A game-level change entry never carries a playerId/playerName field -- structurally cannot infer a specific player', Object.keys(gr.recentChanges[0]));
}

// ============================================================================
// 37. No teammate inference
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const a = article({ sport: 'nba', teams: ['Los Angeles Lakers'], impactSignals: [sig()] });
  const gr = buildGameResearchContext(g, [a]);
  const json = JSON.stringify(gr);
  ok(!json.toLowerCase().includes('teammate'), '37. No teammate-effect field or inference exists anywhere in the game research context output', null);
}

// ============================================================================
// 38. No model fields
// ============================================================================
{
  const g = game({ sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' });
  const a = article({ sport: 'nba', teams: ['Los Angeles Lakers'], impactSignals: [sig()] });
  const gr = buildGameResearchContext(g, [a]);
  const forbidden = ['probability', 'projection', 'edge', 'grade', 'prime', 'confluence', 'newsadj', 'injuryadj', 'roleadj', 'minutesadj', 'opportunityadj'];
  const json = JSON.stringify(gr).toLowerCase();
  const leaked = forbidden.filter(f => json.includes(f));
  ok(leaked.length === 0, '38. buildGameResearchContext\'s output contains no model-related field name whatsoever', leaked);
}

// ============================================================================
// 39. No provider fields modified (game object's own real fields --
// homeTeam/awayTeam/commenceTimeMs/status -- are carried through unchanged
// inside the returned `game` key, never rewritten)
// ============================================================================
{
  const g = game({ eventId: 'evt-real', sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns', commenceTimeMs: 1234567890, status: 'UPCOMING' });
  const gr = buildGameResearchContext(g, []);
  ok(gr.game.eventId === 'evt-real' && gr.game.homeTeam === 'Los Angeles Lakers' && gr.game.commenceTimeMs === 1234567890 && gr.game.status === 'UPCOMING', '39. The real game object (real provider eventId/homeTeam/awayTeam/commenceTimeMs/status) is carried through completely unchanged', gr.game);
}

// ============================================================================
// 40. Multi-sport game object support
// ============================================================================
{
  const sports = [
    { sport: 'mlb', homeTeam: 'Boston Red Sox', awayTeam: 'New York Yankees' },
    { sport: 'nfl', homeTeam: 'Green Bay Packers', awayTeam: 'Chicago Bears' },
    { sport: 'ncaaf', homeTeam: 'Ohio State', awayTeam: 'Michigan' },
    { sport: 'nba', homeTeam: 'Los Angeles Lakers', awayTeam: 'Phoenix Suns' },
    { sport: 'wnba', homeTeam: 'Las Vegas Aces', awayTeam: 'New York Liberty' }
  ];
  const results = sports.map(s => {
    const g = game(s);
    const a = article({ sport: s.sport, teams: [s.homeTeam], impactSignals: [sig()] });
    const gr = buildGameResearchContext(g, [a]);
    return { sport: s.sport, matched: gr.counts.totalArticles === 1 };
  });
  ok(results.every(r => r.matched), '40. All five active live-prop sports (MLB/NFL/NCAAF/NBA/WNBA) work generically through the same buildGameResearchContext -- no sport-specific branching needed', results);
}

// ============================================================================
// 41. Unsupported sports never fabricated (Step 8 -- NHL/soccer/esports
// remain unsupported; the function itself is sport-agnostic and would
// technically process an NHL game object if given one, but this app never
// constructs slateGames entries for those sports in the first place --
// verified here only that passing one through doesn't special-case or
// silently "support" it any more than any other sport)
// ============================================================================
{
  const g = game({ sport: 'nhl', homeTeam: 'Boston Bruins', awayTeam: 'Toronto Maple Leafs' });
  const a = article({ sport: 'nhl', teams: ['Boston Bruins'], impactSignals: [sig()] });
  const gr = buildGameResearchContext(g, [a]);
  ok(gr.counts.totalArticles === 1, '41. buildGameResearchContext itself is generic (would process an NHL game if ever given one) -- Phase 2H adds no NHL-specific UI/slate support anywhere; NHL games are never constructed by this app\'s own slateGames builder', gr.counts);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
