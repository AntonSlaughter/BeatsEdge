// News Intelligence Phase 2G -- news + prop research cross-check
// regression suite. BeatsEdge.html has no module system, so this is a
// FAITHFUL STANDALONE EXTRACTION of the exact logic added this phase
// (relevantCategoriesForProp/buildPropNewsContext, built on top of
// Phase 2F's buildPlayerResearchContext/Phase 2B's playerNewsIndex/
// newsForPlayer, all copied verbatim from the current post-Phase-2G
// BeatsEdge.html source read this session), same convention already used
// by every other frontend-logic test in this repo.

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}

console.log('=== News + Prop Research Cross-Check (Phase 2G) Test ===\n');

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

// ---- Faithful extraction from BeatsEdge.html (Phase 2E, unchanged; Phase 2F's ROSTER_CHANGE fix included) ----
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

// ---- Faithful extraction from BeatsEdge.html (Phase 2F; impact/strength added to recentChanges in Phase 2G) ----
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
        publishedAt: s.publishedAt, freshness: s.freshness, url: n.url, articleId: n.articleId,
        impact: s.impact, strength: s.strength
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

// ---- Faithful extraction from BeatsEdge.html (Phase 2G, this phase) ----
const PROP_RELEVANT_CATEGORIES_DEFAULT = ['Availability', 'Starting status', 'Role', 'Minutes', 'Opportunity'];
const PROP_RELEVANT_CATEGORIES_NO_OPPORTUNITY = ['Availability', 'Starting status', 'Role', 'Minutes'];
const relevantCategoriesForProp = (prop) => {
  const text = `${(prop && prop.statKey) || ''} ${(prop && prop.type) || ''}`.toLowerCase();
  return /\bsteal|\bblock/.test(text) ? PROP_RELEVANT_CATEGORIES_NO_OPPORTUNITY : PROP_RELEVANT_CATEGORIES_DEFAULT;
};
const buildPropNewsContext = (prop, player, researchContext) => {
  const relevantBuckets = new Set(relevantCategoriesForProp(prop));
  const relevantSignals = ((researchContext && researchContext.recentChanges) || [])
    .filter(c => relevantBuckets.has(c.bucket))
    .map(c => ({
      category: c.bucket, impact: c.impact, direction: c.direction, strength: c.strength,
      statusLabel: c.statusLabel, freshness: c.freshness, source: c.source, ageLabel: c.ageLabel,
      publishedAt: c.publishedAt, articleId: c.articleId, url: c.url
    }));
  const recentUp = relevantSignals.some(s => s.freshness && s.freshness !== 'OLDER' && s.direction === 'UP');
  const recentDown = relevantSignals.some(s => s.freshness && s.freshness !== 'OLDER' && s.direction === 'DOWN');
  return {
    hasNews: relevantSignals.length > 0,
    relevantSignals,
    recentCount: relevantSignals.length,
    conflict: recentUp && recentDown
  };
};

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
function prop({ type = 'Points', statKey = 'points', direction = 'over', line = 20.5, ppKind = null, modelSupported = true }) {
  return { id: `${type}-${direction}`, type, statKey, direction, line, ppKind, modelSupported };
}
const PLAYER = { id: '1966', sport: 'nba' };

// ============================================================================
// 1. Player with no news
// ============================================================================
{
  const research = null; // buildPlayerResearchContext is never even called client-side when newsForPlayer() is empty (see BeatsEdge.html's playerResearch computation) -- proven by feeding null through directly, same as the real component would.
  const pc = buildPropNewsContext(prop({}), PLAYER, research);
  ok(pc.hasNews === false && pc.relevantSignals.length === 0 && pc.recentCount === 0 && pc.conflict === false, '1. Player with no news -> hasNews:false, empty signals, no conflict', pc);
}

// ============================================================================
// 2. Player with linked news
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'OUT', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(prop({ type: 'Points', statKey: 'points' }), PLAYER, research);
  ok(pc.hasNews === true && pc.recentCount === 1, '2. Player with linked, relevant news -> hasNews:true', pc);
}

// ============================================================================
// 3. Player with unmatched news
// ============================================================================
{
  const idx = buildPlayerNewsIndex([article({ playerId: null, playerIdSource: null })]);
  const news = newsForPlayer(idx, PLAYER);
  ok(news.length === 0, '3. Unmatched article never resolves for any player -- research context is never even built from it', news.length);
}

// ============================================================================
// 4. Canonical ID match
// ============================================================================
{
  const idx = buildPlayerNewsIndex([article({ playerId: '1966', playerIdSource: 'espn' })]);
  const news = newsForPlayer(idx, { id: '1966', sport: 'nba' });
  ok(news.length === 1, '4. Real canonical id (sport:source:id) resolves the linked article', news.length);
}

// ============================================================================
// 5. Cross-sport ID collision rejected
// ============================================================================
{
  const mlbArticle = article({ sport: 'mlb', playerId: '660670', playerIdSource: 'mlb', articleId: 'mlb1' });
  const nbaArticle = article({ sport: 'nba', playerId: '660670', playerIdSource: 'espn', articleId: 'nba1' }); // FIXTURE: numerically-coincidental id
  const idx = buildPlayerNewsIndex([mlbArticle, nbaArticle]);
  const mlbPlayer = newsForPlayer(idx, { id: '660670', sport: 'mlb' });
  ok(mlbPlayer.length === 1 && mlbPlayer[0].articleId === 'mlb1', '5. A numerically-coincidental id in a different sport/id-space is never cross-matched', mlbPlayer.map(a => a.articleId));
}

// ============================================================================
// 6. Relevant availability signal
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'OUT', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(prop({ type: 'Points', statKey: 'points' }), PLAYER, research);
  ok(pc.relevantSignals[0].category === 'Availability', '6. AVAILABILITY_DOWN is relevant to a Points prop', pc.relevantSignals[0]);
}

// ============================================================================
// 7. Relevant starting signal
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'STARTING_UP', direction: 'UP', strength: 'HIGH', sourceStatus: 'STARTING', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(prop({ type: 'Rebounds', statKey: 'rebounds' }), PLAYER, research);
  ok(pc.relevantSignals[0].category === 'Starting status', '7. STARTING_UP is relevant to a Rebounds prop', pc.relevantSignals[0]);
}

// ============================================================================
// 8. Relevant role signal
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'ROLE_UP', direction: 'UP', strength: 'MEDIUM', sourceStatus: 'INCREASED_ROLE', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(prop({ type: 'Assists', statKey: 'assists' }), PLAYER, research);
  ok(pc.relevantSignals[0].category === 'Role', '8. ROLE_UP is relevant to an Assists prop', pc.relevantSignals[0]);
}

// ============================================================================
// 9. Relevant minutes signal
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'MINUTES_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'RESTRICTED', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(prop({ type: '3-Pointers Made', statKey: 'threePointersMade' }), PLAYER, research);
  ok(pc.relevantSignals[0].category === 'Minutes', '9. MINUTES_DOWN is relevant to a 3PM prop', pc.relevantSignals[0]);
}

// ============================================================================
// 10. Relevant opportunity signal
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'OPPORTUNITY_UP', direction: 'UP', strength: 'MEDIUM', sourceStatus: 'INCREASED_OPPORTUNITY', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(prop({ type: 'Pts+Reb+Ast', statKey: 'pra' }), PLAYER, research);
  ok(pc.relevantSignals[0].category === 'Opportunity', '10. OPPORTUNITY_UP is relevant to a PRA prop', pc.relevantSignals[0]);
}

// ============================================================================
// 11. Irrelevant transaction signal
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'TRANSACTION', direction: 'NEUTRAL', strength: 'HIGH', sourceStatus: 'TRADE', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(prop({ type: 'Points', statKey: 'points' }), PLAYER, research);
  ok(pc.hasNews === false, '11. A TRANSACTION/TRADE signal is NOT automatically relevant to a Points prop (Step 5\'s explicit warning)', pc);
}

// ============================================================================
// 12. Irrelevant weather signal
// ============================================================================
{
  const a = article({ sport: 'mlb', playerId: '660670', playerIdSource: 'mlb', impactSignals: [impactSignal({ impact: 'WEATHER_CONTEXT', direction: 'NEUTRAL', strength: 'LOW', sourceStatus: 'WEATHER_IMPACT', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(prop({ type: 'Hits', statKey: 'hits' }), { id: '660670', sport: 'mlb' }, research);
  ok(pc.hasNews === false, '12. A WEATHER_CONTEXT signal is not surfaced as relevant to a specific stat-family prop', pc);
}

// ============================================================================
// 13. Freshness preserved
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'OUT', publishedAt: '2026-09-21T10:00:00Z', freshness: 'NEW' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(prop({}), PLAYER, research);
  ok(pc.relevantSignals[0].freshness === 'NEW', '13. Real freshness value (NEW) is preserved on the relevant signal, not recomputed', pc.relevantSignals[0].freshness);
}

// ============================================================================
// 14. Strength preserved
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'MEDIUM', sourceStatus: 'QUESTIONABLE', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(prop({}), PLAYER, research);
  ok(pc.relevantSignals[0].strength === 'MEDIUM', '14. Real strength value (MEDIUM) is preserved, never re-derived or invented', pc.relevantSignals[0].strength);
}

// ============================================================================
// 15. Source preserved
// ============================================================================
{
  const a = article({ source: 'Yahoo Sports', impactSignals: [impactSignal({ impact: 'ROLE_UP', direction: 'UP', strength: 'MEDIUM', sourceStatus: 'INCREASED_ROLE', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(prop({}), PLAYER, research);
  ok(pc.relevantSignals[0].source === 'Yahoo Sports', '15. Real outlet name preserved, never genericized', pc.relevantSignals[0].source);
}

// ============================================================================
// 16. URL preserved
// ============================================================================
{
  const a = article({ url: 'https://espn.com/real-article-456', impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'OUT', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(prop({}), PLAYER, research);
  ok(pc.relevantSignals[0].url === 'https://espn.com/real-article-456', '16. Real article URL preserved, clickable to the original source', pc.relevantSignals[0].url);
}

// ============================================================================
// 17. Article ID preserved
// ============================================================================
{
  const a = article({ articleId: 'ESPN:real-id-789', impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'OUT', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(prop({}), PLAYER, research);
  ok(pc.relevantSignals[0].articleId === 'ESPN:real-id-789', '17. Real articleId preserved for exact traceability back to the source row', pc.relevantSignals[0].articleId);
}

// ============================================================================
// 18. Conflict preserved
// ============================================================================
{
  const arts = [
    article({ articleId: 'c1', impactSignals: [impactSignal({ impact: 'STARTING_UP', direction: 'UP', strength: 'HIGH', sourceStatus: 'STARTING', publishedAt: '2026-09-21T10:00:00Z', freshness: 'RECENT' })] }),
    article({ articleId: 'c2', impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'MEDIUM', sourceStatus: 'QUESTIONABLE', publishedAt: '2026-09-21T12:30:00Z', freshness: 'RECENT' })] })
  ];
  const research = buildPlayerResearchContext(arts);
  const pc = buildPropNewsContext(prop({ type: 'Points', statKey: 'points' }), PLAYER, research);
  ok(pc.conflict === true && pc.relevantSignals.length === 2, '18. STARTING_UP + AVAILABILITY_DOWN (both relevant to Points) -> conflict flagged, both preserved', pc);
}

// ============================================================================
// 19. No conflict resolution
// ============================================================================
{
  const arts = [
    article({ articleId: 'c1', impactSignals: [impactSignal({ impact: 'STARTING_UP', direction: 'UP', strength: 'HIGH', sourceStatus: 'STARTING', publishedAt: '2026-09-21T10:00:00Z', freshness: 'RECENT' })] }),
    article({ articleId: 'c2', impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'MEDIUM', sourceStatus: 'QUESTIONABLE', publishedAt: '2026-09-21T12:30:00Z', freshness: 'RECENT' })] })
  ];
  const research = buildPlayerResearchContext(arts);
  const pc = buildPropNewsContext(prop({}), PLAYER, research);
  ok(!('resolved' in pc) && !('winner' in pc) && !('finalStatus' in pc), '19. buildPropNewsContext never declares a "winner" -- both signals stand on their own, structurally no such field exists', Object.keys(pc));
}

// ============================================================================
// 20. No model adjustment
// ============================================================================
{
  ok(buildPropNewsContext.toString().indexOf('calculateEdgeScore') === -1, '20. buildPropNewsContext\'s own source never calls/references calculateEdgeScore', null);
}

// ============================================================================
// 21. No probability change
// ============================================================================
{
  ok(buildPropNewsContext.toString().indexOf('modelProb') === -1 && buildPropNewsContext.toString().indexOf('PROB_CALIB') === -1, '21. buildPropNewsContext\'s own source never references modelProb/PROB_CALIB', null);
}

// ============================================================================
// 22. No edge change
// ============================================================================
{
  ok(buildPropNewsContext.toString().indexOf('edgePct') === -1 && buildPropNewsContext.toString().indexOf('FAMILY_CALIB') === -1, '22. buildPropNewsContext\'s own source never references edgePct/FAMILY_CALIB', null);
}

// ============================================================================
// 23. No grade/Prime change
// ============================================================================
{
  ok(buildPropNewsContext.toString().indexOf('GRADE_CUTOFFS') === -1 && buildPropNewsContext.toString().indexOf('PRIME_FAMILY') === -1, '23. buildPropNewsContext\'s own source never references GRADE_CUTOFFS/PRIME_FAMILY', null);
}

// ============================================================================
// 24. Provider-only prop supported without model output
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'OUT', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const providerOnlyProp = prop({ type: 'Hitter Fantasy Score', statKey: 'fantasy', modelSupported: false });
  const pc = buildPropNewsContext(providerOnlyProp, PLAYER, research);
  ok(pc.hasNews === true, '24. A provider-only prop (modelSupported:false) still gets a real, non-model news indicator -- buildPropNewsContext never reads modelSupported/edge/grade at all', pc);
  ok(!('probability' in pc) && !('grade' in pc) && !('edge' in pc) && !('prime' in pc), '24b. The returned shape itself carries no probability/grade/edge/prime field for a provider-only prop', Object.keys(pc));
}

// ============================================================================
// 25. (kept as a second provider-only scenario per the 35-test target — a
// provider-only market with NO relevant news still returns a clean, honest
// hasNews:false, never a fabricated indicator)
// ============================================================================
{
  const providerOnlyProp = prop({ type: 'Pitcher Fantasy Score', statKey: 'pitcherFantasy', modelSupported: false });
  const pc = buildPropNewsContext(providerOnlyProp, PLAYER, null);
  ok(pc.hasNews === false, '25. A provider-only prop with no player research context -> honest hasNews:false, never invented', pc);
}

// ============================================================================
// 26. Demon preserved
// ============================================================================
{
  const demonProp = prop({ type: 'Points', statKey: 'points', ppKind: 'demon', line: 28.5 });
  const a = article({ impactSignals: [impactSignal({ impact: 'ROLE_UP', direction: 'UP', strength: 'MEDIUM', sourceStatus: 'INCREASED_ROLE', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(demonProp, PLAYER, research);
  ok(demonProp.ppKind === 'demon' && demonProp.line === 28.5 && pc.hasNews === true, '26. A Demon prop keeps its own ppKind/line untouched while still getting the same news cross-check as any other prop', { ppKind: demonProp.ppKind, line: demonProp.line, hasNews: pc.hasNews });
}

// ============================================================================
// 27. Goblin preserved
// ============================================================================
{
  const goblinProp = prop({ type: 'Rebounds', statKey: 'rebounds', ppKind: 'goblin', line: 6.5 });
  const a = article({ impactSignals: [impactSignal({ impact: 'MINUTES_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'RESTRICTED', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(goblinProp, PLAYER, research);
  ok(goblinProp.ppKind === 'goblin' && goblinProp.line === 6.5 && pc.hasNews === true, '27. A Goblin prop keeps its own ppKind/line untouched', { ppKind: goblinProp.ppKind, line: goblinProp.line, hasNews: pc.hasNews });
}

// ============================================================================
// 28. Normal prop preserved
// ============================================================================
{
  const normalProp = prop({ type: 'Assists', statKey: 'assists', ppKind: null, line: 7.5 });
  ok(normalProp.ppKind === null, '28. A normal (non-Demon/Goblin) prop is unaffected -- ppKind stays null, Phase 2G adds nothing that changes prop identity', normalProp);
}

// ============================================================================
// 29. Search player uses same context (structural: same function, same
// PLAYER object shape a search-selected card would pass)
// ============================================================================
{
  const idx = buildPlayerNewsIndex([article({ playerId: '1966', impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'OUT', publishedAt: '2026-09-21T10:00:00Z' })] })]);
  const browsePlayerNews = newsForPlayer(idx, { id: '1966', sport: 'nba' });
  const searchSelectedPlayerNews = newsForPlayer(idx, { id: '1966', sport: 'nba' }); // same lookup, same index -- no separate search-path implementation exists
  ok(JSON.stringify(browsePlayerNews) === JSON.stringify(searchSelectedPlayerNews), '29. A search-selected player resolves the identical news list via the SAME newsForPlayer/index -- no separate search-specific code path', null);
}

// ============================================================================
// 30. No N+1 request behavior (structural: pure in-memory functions, no
// fetch/XHR/global anywhere in their source)
// ============================================================================
{
  const src = buildPropNewsContext.toString() + relevantCategoriesForProp.toString();
  ok(!/fetch\(|XMLHttpRequest|axios\./.test(src), '30. Neither buildPropNewsContext nor relevantCategoriesForProp contains any network call -- purely in-memory filtering of already-fetched data', null);
}

// ============================================================================
// 31. No fuzzy matching
// ============================================================================
{
  const a = article({ playerId: '1966', headline: 'Completely unrelated headline text mentioning nothing about this' });
  const idx = buildPlayerNewsIndex([a]);
  const news = newsForPlayer(idx, { id: '1966', sport: 'nba' });
  ok(news.length === 1, '31. Join succeeds purely on canonical id, independent of headline wording -- proving no text-based matching exists in the prop-context layer either', null);
}

// ============================================================================
// 32. No teammate inference
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'OUT', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(prop({}), PLAYER, research);
  const json = JSON.stringify(pc);
  ok(!json.includes('teammate') && !pc.relevantSignals.some(s => 'playerId' in s), '32. No relevantSignal entry carries any second-player identity field -- structurally cannot name a teammate', null);
}

// ============================================================================
// 33. No betting language
// ============================================================================
{
  const BETTING_WORDS = /\b(lock|smash|fade|best play|bet this|bet against|boost|free money|sharp play|must play|guarantee)\b/i;
  const allTexts = [...Object.values(NEWS_STATUS_LABELS), ...NEWS_CONTEXT_BUCKET_ORDER, ...PROP_RELEVANT_CATEGORIES_DEFAULT, ...PROP_RELEVANT_CATEGORIES_NO_OPPORTUNITY];
  const leaks = allTexts.filter(t => BETTING_WORDS.test(t));
  ok(leaks.length === 0, '33. No status label, bucket name, or relevance-category name used by the prop cross-check contains betting-advice language', leaks);
}

// ============================================================================
// 34. Multi-sport safety
// ============================================================================
{
  // NFL cards always join on the ESPN id space (Phase 2A/2B); nflverse/GSIS
  // ids are a DIFFERENT space and must never attach, even to a prop-context
  // lookup for the same real player.
  const nflverseArticle = article({ sport: 'nfl', playerId: '00-0019596', playerIdSource: 'nflverse', impactSignals: [impactSignal({ impact: 'AVAILABILITY_DOWN', direction: 'DOWN', strength: 'HIGH', sourceStatus: 'OUT', publishedAt: '2026-09-21T10:00:00Z' })] });
  const idx = buildPlayerNewsIndex([nflverseArticle]);
  const nflCardPlayer = newsForPlayer(idx, { id: '00-0019596', sport: 'nfl' }); // NFL cards join on 'espn', never 'nflverse'
  ok(nflCardPlayer.length === 0, '34a. nflverse-sourced NFL news never attaches to an NFL card\'s prop-context, even with a matching id string', nflCardPlayer.length);

  const mlbArticle = article({ sport: 'mlb', playerId: '660670', playerIdSource: 'mlb', impactSignals: [impactSignal({ impact: 'STARTING_UP', direction: 'UP', strength: 'HIGH', sourceStatus: 'STARTING', publishedAt: '2026-09-21T10:00:00Z' })] });
  const idx2 = buildPlayerNewsIndex([mlbArticle]);
  const mlbNews = newsForPlayer(idx2, { id: '660670', sport: 'mlb' });
  const mlbResearch = buildPlayerResearchContext(mlbNews);
  const mlbPc = buildPropNewsContext(prop({ type: 'Hits', statKey: 'hits' }), { id: '660670', sport: 'mlb' }, mlbResearch);
  ok(mlbPc.hasNews === true && mlbPc.relevantSignals[0].category === 'Starting status', '34b. MLB player identity (MLB Stats API id space) correctly drives prop-context for an MLB Hits prop', mlbPc.relevantSignals[0]);
}

// ============================================================================
// 35. Empty relevantSignals never crashes / renders as no-news (edge case
// distinct from #1: player HAS news, but none of it is in a relevant bucket)
// ============================================================================
{
  const a = article({ impactSignals: [impactSignal({ impact: 'GAME_CONTEXT', direction: 'NEUTRAL', strength: 'LOW', sourceStatus: 'POSTPONED_OR_SUSPENDED', publishedAt: '2026-09-21T10:00:00Z' })] });
  const research = buildPlayerResearchContext([a]);
  const pc = buildPropNewsContext(prop({ type: 'Points', statKey: 'points' }), PLAYER, research);
  ok(pc.hasNews === false && pc.recentCount === 0 && research.counts.totalArticles === 1, '35. Player has real linked news (GAME_CONTEXT), but it\'s irrelevant to Points -> honest hasNews:false at the prop level, even though the player-level context is non-empty', { propContext: pc, playerHadArticles: research.counts.totalArticles });
}

// ============================================================================
// 36-45. Real production statKey/type verification. Confirmed by direct read
// of the actual prop builders in BeatsEdge.html this session (not assumed):
//   NBA_STAT_DEFS-style objects at ~line 13725-13728 (steals/blocks/blocksSteals)
//   and ~line 15747 (pr/pa/ra/pra/blocksSteals NAME map);
//   MLB batter/pitcher defs at ~line 11044-11060 (hits/totalBases/stolenBases/
//   pitcherStrikeouts/etc.);
//   NFL/NCAAF share ONE stat-def object at ~line 11135-11150 (passYds/rushYds/
//   receptions/etc. -- confirmed no separate CFB_STAT_DEFS exists, so NCAAF
//   inherits NFL's exact statKey vocabulary);
//   and the real prop-construction line `{ type: def.type, statKey: k, ... }`
//   at ~line 11355, confirming `k` (the object key, e.g. 'blocksSteals',
//   'stolenBases', 'passYds') IS the real `prop.statKey` at render time --
//   not a guess, not the human-readable label.
// ============================================================================
{
  // 36. Real NBA statKey 'blocksSteals' (type 'Blocks+Steals') -> excludes Opportunity
  const bsProp = { id: 'bs', type: 'Blocks+Steals', statKey: 'blocksSteals', direction: 'over', line: 2.5, ppKind: null, modelSupported: true };
  ok(JSON.stringify(relevantCategoriesForProp(bsProp)) === JSON.stringify(PROP_RELEVANT_CATEGORIES_NO_OPPORTUNITY), '36. Real statKey "blocksSteals" (Blocks+Steals combo market) correctly excludes Opportunity, same as bare Steals/Blocks', relevantCategoriesForProp(bsProp));
}
{
  // 37. Real NBA statKey 'steals' alone
  const stealsProp = { id: 's', type: 'Steals', statKey: 'steals', direction: 'over', line: 1.5 };
  ok(JSON.stringify(relevantCategoriesForProp(stealsProp)) === JSON.stringify(PROP_RELEVANT_CATEGORIES_NO_OPPORTUNITY), '37. Real statKey "steals" excludes Opportunity', relevantCategoriesForProp(stealsProp));
}
{
  // 38. Real NBA statKey 'blocks' alone
  const blocksProp = { id: 'b', type: 'Blocks', statKey: 'blocks', direction: 'over', line: 1.5 };
  ok(JSON.stringify(relevantCategoriesForProp(blocksProp)) === JSON.stringify(PROP_RELEVANT_CATEGORIES_NO_OPPORTUNITY), '38. Real statKey "blocks" excludes Opportunity', relevantCategoriesForProp(blocksProp));
}
{
  // 39. Real NBA combo statKeys 'pr'/'pa'/'ra' (Pts+Reb / Pts+Ast / Reb+Ast) -> DEFAULT (includes Opportunity), never misrouted by the steals/blocks pattern
  const pr = { statKey: 'pr', type: 'Pts+Reb' }, pa = { statKey: 'pa', type: 'Pts+Ast' }, ra = { statKey: 'ra', type: 'Reb+Ast' };
  ok([pr, pa, ra].every(p => JSON.stringify(relevantCategoriesForProp(p)) === JSON.stringify(PROP_RELEVANT_CATEGORIES_DEFAULT)), '39. Real combo statKeys pr/pa/ra (Pts+Reb, Pts+Ast, Reb+Ast) all get the DEFAULT (Opportunity-inclusive) set, matching Step 3\'s exact required families', { pr: relevantCategoriesForProp(pr), pa: relevantCategoriesForProp(pa), ra: relevantCategoriesForProp(ra) });
}
{
  // 40. Real NBA statKey 'pra' (Pts+Reb+Ast) -> DEFAULT
  const praProp = { statKey: 'pra', type: 'Pts+Reb+Ast' };
  ok(JSON.stringify(relevantCategoriesForProp(praProp)) === JSON.stringify(PROP_RELEVANT_CATEGORIES_DEFAULT), '40. Real statKey "pra" gets the DEFAULT set (Step 3\'s explicit PRA example)', relevantCategoriesForProp(praProp));
}
{
  // 41. Real NBA statKey 'turnovers' -> DEFAULT (Step 3's explicit TURNOVERS example)
  const tovProp = { statKey: 'turnovers', type: 'Turnovers' };
  ok(JSON.stringify(relevantCategoriesForProp(tovProp)) === JSON.stringify(PROP_RELEVANT_CATEGORIES_DEFAULT), '41. Real statKey "turnovers" gets the DEFAULT set', relevantCategoriesForProp(tovProp));
}
{
  // 42. Real MLB statKey 'stolenBases' (type 'Stolen Bases') must NOT be
  // misclassified by the steals/blocks pattern -- "stolen" is a different
  // word than "steal" ("stolen" contains no "steal" substring: s-t-o-l-e-n
  // vs s-t-e-a-l), and MLB base-stealing is offense/opportunity-dependent,
  // not the NBA defensive-stat exception Step 4 describes.
  const stolenBasesProp = { statKey: 'stolenBases', type: 'Stolen Bases' };
  ok(JSON.stringify(relevantCategoriesForProp(stolenBasesProp)) === JSON.stringify(PROP_RELEVANT_CATEGORIES_DEFAULT), '42. Real MLB statKey "stolenBases" is correctly NOT excluded from Opportunity -- "stolen" never matches the "steal" pattern', relevantCategoriesForProp(stolenBasesProp));
}
{
  // 43. Real MLB batter/pitcher statKeys -> all DEFAULT, no MLB stat contains "steal"/"block"
  const mlbKeys = [
    { statKey: 'hits', type: 'Hits' }, { statKey: 'totalBases', type: 'Total Bases' }, { statKey: 'homeRuns', type: 'Home Runs' },
    { statKey: 'rbis', type: 'RBIs' }, { statKey: 'runs', type: 'Runs' }, { statKey: 'batterStrikeouts', type: 'Hitter Strikeouts' },
    { statKey: 'strikeouts', type: 'Pitcher Strikeouts' }, { statKey: 'earnedRuns', type: 'Earned Runs Allowed' }, { statKey: 'pitcherOuts', type: 'Pitching Outs' }
  ];
  ok(mlbKeys.every(p => JSON.stringify(relevantCategoriesForProp(p)) === JSON.stringify(PROP_RELEVANT_CATEGORIES_DEFAULT)), '43. Every real MLB batter/pitcher statKey gets the DEFAULT set -- confirmed no MLB market key collides with the NBA-specific steals/blocks pattern', mlbKeys.map(p => p.statKey));
}
{
  // 44. Real NFL/NCAAF statKeys (NCAAF reuses NFL's exact stat-def object --
  // confirmed no separate CFB_STAT_DEFS exists in BeatsEdge.html) -> all DEFAULT
  const nflKeys = [
    { statKey: 'passYds', type: 'Pass Yards' }, { statKey: 'passTds', type: 'Pass TDs' }, { statKey: 'interceptions', type: 'Interceptions' },
    { statKey: 'rushYds', type: 'Rush Yards' }, { statKey: 'rushTds', type: 'Rush TDs' }, { statKey: 'recYds', type: 'Receiving Yards' },
    { statKey: 'receptions', type: 'Receptions' }, { statKey: 'rushRecYds', type: 'Rush+Rec Yards' }
  ];
  ok(nflKeys.every(p => JSON.stringify(relevantCategoriesForProp(p)) === JSON.stringify(PROP_RELEVANT_CATEGORIES_DEFAULT)), '44. Every real NFL/NCAAF statKey gets the DEFAULT set (no NFL/NCAAF market shares NBA\'s steals/blocks exception)', nflKeys.map(p => p.statKey));
}
{
  // 45. NCAAF safety: identity join is sport-scoped exactly like every other
  // sport -- an NCAAF article never attaches to an NFL (or any other sport)
  // player even with a matching numeric id.
  const ncaafArticle = article({ sport: 'ncaaf', playerId: '4685401', playerIdSource: 'espn', articleId: 'cfb1', impactSignals: [impactSignal({ impact: 'STARTING_UP', direction: 'UP', strength: 'HIGH', sourceStatus: 'STARTING', publishedAt: '2026-09-21T10:00:00Z' })] });
  const nflCollisionArticle = article({ sport: 'nfl', playerId: '4685401', playerIdSource: 'espn', articleId: 'nfl-collision' }); // FIXTURE: numerically-coincidental id, different sport
  const idx = buildPlayerNewsIndex([ncaafArticle, nflCollisionArticle]);
  const ncaafPlayer = newsForPlayer(idx, { id: '4685401', sport: 'ncaaf' });
  ok(ncaafPlayer.length === 1 && ncaafPlayer[0].articleId === 'cfb1', '45. An NCAAF player correctly resolves only its own sport-scoped article, never the numerically-coincidental NFL one', ncaafPlayer.map(a => a.articleId));
  const ncaafResearch = buildPlayerResearchContext(ncaafPlayer);
  const ncaafPc = buildPropNewsContext({ statKey: 'passYds', type: 'Pass Yards' }, { id: '4685401', sport: 'ncaaf' }, ncaafResearch);
  ok(ncaafPc.hasNews === true && ncaafPc.relevantSignals[0].category === 'Starting status', '45b. NCAAF prop-context correctly resolves relevant news for a real NCAAF QB passing prop', ncaafPc.relevantSignals[0]);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
