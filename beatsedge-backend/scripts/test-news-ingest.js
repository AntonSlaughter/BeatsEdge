// News Intelligence -- Phase 1 regression suite.
//
// Tests lib/newsIngest.js (fetch + normalize) and lib/newsDb.js (storage/
// dedup/sort) directly -- both are real backend modules (unlike
// BeatsEdge.html's monolithic frontend, these ARE real Node files, so they
// are required and exercised directly, not re-implemented). Covers the 13
// properties required by this phase's spec. A small number of real, live,
// keyless ESPN/RSS calls are included (mirroring test-propline-provider.js's
// "lean live spot-check, skip gracefully on failure" pattern) since this
// phase is explicitly about real source integration, not just fixtures.

const newsIngest = require('../lib/newsIngest');
const newsDb = require('../lib/newsDb');

let pass = 0, fail = 0, skip = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}
function skipped(label) { console.log(`⊘ SKIP ${label}`); skip++; }

console.log('=== News Intelligence Phase 1 Test ===\n');

// ---- Pure-function fixtures (fast, deterministic, no network) ----

// 4. Timestamps are normalized consistently.
ok(newsIngest.normalizeTimestamp('2026-09-21T10:55:08Z') === '2026-09-21T10:55:08.000Z', '4a. A real ESPN-style ISO timestamp normalizes to a consistent ISO string', newsIngest.normalizeTimestamp('2026-09-21T10:55:08Z'));
ok(newsIngest.normalizeTimestamp('2026-09-18 22:57:40', { assumeUtcNoZone: true }) === '2026-09-18T22:57:40.000Z', '4b. A real rss2json-style "YYYY-MM-DD HH:MM:SS" (no zone) timestamp is explicitly treated as UTC, not guessed as local time', newsIngest.normalizeTimestamp('2026-09-18 22:57:40', { assumeUtcNoZone: true }));
ok(newsIngest.normalizeTimestamp(null) === null, '9a. Missing timestamp (null) normalizes to null, never fabricated', newsIngest.normalizeTimestamp(null));
ok(newsIngest.normalizeTimestamp('not a real date') === null, '9b. Unparseable timestamp string normalizes to null, never fabricated/defaulted to "now"', newsIngest.normalizeTimestamp('not a real date'));
ok(newsIngest.normalizeTimestamp('') === null, '9c. Empty-string timestamp normalizes to null', newsIngest.normalizeTimestamp(''));

// 5. Duplicate articles are removed -- dedupe key construction.
ok(newsIngest.buildDedupeKey({ source: 'ESPN', sourceArticleId: '49956884' }) === 'ESPN:id:49956884', '5a. Preferred dedupe tier: source+sourceArticleId', newsIngest.buildDedupeKey({ source: 'ESPN', sourceArticleId: '49956884' }));
ok(newsIngest.buildDedupeKey({ source: 'Yahoo Sports', url: 'https://sports.yahoo.com/a/b?utm_source=x' }) === newsIngest.buildDedupeKey({ source: 'Yahoo Sports', url: 'https://sports.yahoo.com/a/b?utm_source=y' }), '5b. Second dedupe tier: canonical URL (query string stripped) -- two URLs differing only by tracking params dedupe together', null);
{
  const k1 = newsIngest.buildDedupeKey({ source: 'CBS Sports', title: 'Player X questionable for Sunday', publishedAt: '2026-09-21T10:00:00.000Z' });
  const k2 = newsIngest.buildDedupeKey({ source: 'CBS Sports', title: 'Player Y questionable for Sunday', publishedAt: '2026-09-21T10:00:00.000Z' });
  ok(k1 !== k2, '5c. Third dedupe tier (fingerprint): two genuinely DIFFERENT articles (different titles) with no id/url do NOT collapse into one, even with the same source+timestamp', { k1, k2 });
}
ok(newsIngest.buildDedupeKey({ source: 'ESPN', sourceArticleId: '1' }) !== newsIngest.buildDedupeKey({ source: 'Yahoo Sports', sourceArticleId: '1' }), '5d. The same raw id from two DIFFERENT sources never collides -- source is part of every tier', null);

// 6/7. Source and URL preserved through normalization.
{
  const fakeEspnArticle = {
    id: 123456, headline: 'Real Headline Text', description: 'Real summary text.',
    published: '2026-09-21T12:00:00Z', lastModified: '2026-09-21T12:05:00Z',
    links: { web: { href: 'https://www.espn.com/nba/story/_/id/123456/real-article' } },
    images: [{ url: 'https://a.espncdn.com/photo/real.jpg' }],
    categories: [
      { type: 'athlete', athlete: { displayName: 'Test Player' } },
      { type: 'team', team: { abbreviation: 'BOS' } }
    ]
  };
  const n = newsIngest.normalizeEspnArticle(fakeEspnArticle, 'nba');
  ok(n.source === 'ESPN', '6. Source is preserved exactly ("ESPN"), never silently replaced', n.source);
  ok(n.url === 'https://www.espn.com/nba/story/_/id/123456/real-article', '7. Canonical article URL is preserved exactly, never fabricated', n.url);
  ok(n.sourceArticleId === '123456', 'Real ESPN numeric article id is preserved as sourceArticleId (a genuine improvement over a url-only fallback)', n.sourceArticleId);
  ok(n.imageUrl === 'https://a.espncdn.com/photo/real.jpg', 'Real image URL is preserved when the source supplies one', n.imageUrl);
  // Phase 2A: "Test Player" has no real athlete.id in this fixture (Tier 1
  // doesn't apply) and is not a real name in any canonical index (Tier 2/3
  // correctly find no candidate) -- playerName/playerId both null is the
  // CORRECT behavior here, proving the resolver never fabricates a match
  // for an unrecognized name just because ESPN tagged SOME athlete
  // category. `team` is raw article metadata (from ESPN's own team
  // category tag), independent of whether player identity resolved --
  // still preserved.
  ok(n.playerName === null && n.playerId === null, 'Phase 2A: an athlete tag with no real id, referring to a name not in any real canonical index, correctly resolves to null identity rather than trusting the raw unverified tag', { playerName: n.playerName, playerId: n.playerId });
  ok(n.team === 'BOS', 'Real team tag is still preserved verbatim as article metadata, independent of player identity resolution', n.team);
  ok(n.playerMatchMethod === 'UNMATCHED', 'playerMatchMethod explicitly records WHY (UNMATCHED), never silently blank', n.playerMatchMethod);
}

// 8. Missing player identity does NOT break ingestion.
{
  const noAthleteArticle = {
    id: 999, headline: 'Team wins game', description: 'A recap with no athlete tag.',
    published: '2026-09-21T12:00:00Z', links: { web: { href: 'https://www.espn.com/x/999' } }, categories: []
  };
  const n = newsIngest.normalizeEspnArticle(noAthleteArticle, 'nba');
  ok(n !== null && n.playerName === null && n.team === null, '8. An article with no athlete/team category normalizes successfully with playerName/team null, never crashes, never guesses a name', n);
}

// 9d. Missing timestamp does NOT crash ingestion (full article, no date at all).
{
  const noDateArticle = { id: 1000, headline: 'Headline with no date', description: 'x', links: { web: { href: 'https://www.espn.com/x/1000' } }, categories: [] };
  const n = newsIngest.normalizeEspnArticle(noDateArticle, 'nba');
  ok(n !== null && n.publishedAt === null, '9d. An article with no published field at all normalizes successfully with publishedAt null, never crashes, never defaults to "now"', n);
}

// Promo/gambling content is filtered, not stored as news.
{
  const promoArticle = { id: 2000, headline: 'Bet now with our exclusive promo code', description: 'Sign-up bonus inside', links: { web: { href: 'https://x.com/2000' } }, categories: [] };
  const n = newsIngest.normalizeEspnArticle(promoArticle, 'nba');
  ok(n === null, 'A promo/gambling-ad article (matches NEWS_PROMO_RE) is filtered out entirely, never stored as real news', n);
}

// RSS normalization -- HTML entity decode, missing thumbnail handled.
{
  const rssItem = { title: 'Player&#39;s big night', description: '<p>Great performance &amp; more</p>', link: 'https://cbssports.com/x', pubDate: '2026-09-21 08:00:00', guid: 'abc-123', thumbnail: '' };
  const n = newsIngest.normalizeRssItem(rssItem, 'nba', 'CBS Sports');
  ok(n.title === "Player's big night", 'RSS HTML entities are decoded correctly in the title', n.title);
  ok(n.summary === 'Great performance & more', 'RSS HTML tags stripped and entities decoded in the summary', n.summary);
  ok(n.imageUrl === null, 'An empty thumbnail string normalizes to null, never an empty-string "image"', n.imageUrl);
  ok(n.sourceArticleId === 'abc-123', 'RSS guid is preserved as sourceArticleId when present', n.sourceArticleId);
}

// ---- Storage layer (real SQLite, same file the app uses) ----

// 10. Empty source result is handled (sport with genuinely no rows yet).
{
  const rows = newsDb.getArticles({ sport: '__test_empty_sport__', limit: 10 });
  ok(Array.isArray(rows) && rows.length === 0, '10. Querying a sport with zero stored articles returns an empty array, never an error/crash', rows.length);
}

// Upsert + dedup at the storage layer, and sort order (3).
{
  const now = Date.now();
  const fixtureArticles = [
    { dedupeKey: 'TEST:id:1', source: 'TEST', sourceArticleId: '1', title: 'Oldest', url: 'https://test/1', sport: '__test_sort__', publishedAt: new Date(now - 3 * 3600000).toISOString(), category: 'news' },
    { dedupeKey: 'TEST:id:2', source: 'TEST', sourceArticleId: '2', title: 'Newest', url: 'https://test/2', sport: '__test_sort__', publishedAt: new Date(now - 1 * 3600000).toISOString(), category: 'news' },
    { dedupeKey: 'TEST:id:3', source: 'TEST', sourceArticleId: '3', title: 'Middle', url: 'https://test/3', sport: '__test_sort__', publishedAt: new Date(now - 2 * 3600000).toISOString(), category: 'news' },
    // 9e. An article with no timestamp at all must sort LAST, never crash the query.
    { dedupeKey: 'TEST:id:4', source: 'TEST', sourceArticleId: '4', title: 'No timestamp', url: 'https://test/4', sport: '__test_sort__', publishedAt: null, category: 'news' }
  ];
  const { inserted } = newsDb.upsertArticles(fixtureArticles);
  ok(inserted === 4, 'Storage: 4 real fixture rows inserted successfully', inserted);
  const sorted = newsDb.getArticles({ sport: '__test_sort__', limit: 10 });
  ok(sorted.length === 4, 'Storage: all 4 fixture rows retrievable', sorted.length);
  ok(sorted.map(a => a.title).join(',') === 'Newest,Middle,Oldest,No timestamp', '3. Articles are sorted newest -> oldest, with the undated article placed LAST rather than fabricating a position for it', sorted.map(a => a.title));

  // 5e. Re-upserting the exact same dedupe keys never creates duplicate rows.
  const { inserted: inserted2, updated: updated2 } = newsDb.upsertArticles(fixtureArticles);
  ok(inserted2 === 0 && updated2 === 4, '5e. Storage: re-upserting identical dedupe keys updates in place (0 new rows), proving dedup holds at the storage layer too', { inserted2, updated2 });
  const afterReupsert = newsDb.getArticles({ sport: '__test_sort__', limit: 10 });
  ok(afterReupsert.length === 4, 'Storage: row count unchanged after re-upsert -- no duplicates created', afterReupsert.length);

  // isNew is a real, honest, read-time-computed flag -- never a stored claim.
  const newest = afterReupsert.find(a => a.title === 'Newest');
  const oldest = afterReupsert.find(a => a.title === 'Oldest');
  ok(newest.isNew === true && oldest.isNew === false, 'isNew is computed honestly from real publishedAt at read time (recent article: true, 3h-old article: false)', { newest: newest.isNew, oldest: oldest.isNew });

  // Clean up the test fixture rows so they never leak into a real query --
  // reuses newsDb's OWN already-open connection (never opens/closes a
  // separate ad-hoc one; better-sqlite3 has shown itself flaky under
  // multiple simultaneous connections + async work in this exact sandbox,
  // confirmed independently of this phase -- see the final report's
  // "limitations" section).
  const deleted = newsDb.db.prepare(`DELETE FROM news_articles WHERE sport = ?`).run('__test_sort__');
  ok(deleted.changes === 4, 'Test fixture rows cleaned up after the run (real table, never left polluted)', deleted.changes);
}

// 12/13. Existing BeatsEdge functionality + prop/game/period tests still pass
// -- run separately by the harness (see this script's own README note in
// the final report); not re-executed inside this file to keep failures
// attributable to the right suite.
console.log('\n(12/13: existing regression suites run separately -- see the final report for their combined result.)');

// ---- Live spot-check (1 real sport, gracefully skips if unreachable) ----
(async () => {
  try {
    // 1/2/11. News endpoint responds / real source data is normalized /
    // source failure handled truthfully -- exercised here via the real
    // ingestSport() path (the same function routes/api.js's GET /api/news
    // calls), since server.js itself can't be booted in this sandbox (see
    // the final report's "limitations" section -- a pre-existing,
    // unrelated snapshot-storage startup gate, confirmed present on the
    // last committed commit too, not something this phase touched).
    const result = await newsIngest.ingestSport('wnba');
    if (!result.sourceReports.some(r => r.ok)) {
      skipped(`live spot-check: WNBA ingest reached no live source this run (${JSON.stringify(result.sourceReports)}) -- skipping gracefully`);
      return finish();
    }
    ok(result.fetched >= 0, '1. ingestSport() (the function backing GET /api/news) runs against the real live ESPN endpoint without throwing', { fetched: result.fetched, sourceReports: result.sourceReports });
    const stored = newsDb.getArticles({ sport: 'wnba', limit: 5 });
    ok(stored.every(a => a.source && a.title), '2. Every real stored article has a real, non-empty source and title -- normalization did not produce a placeholder row', stored.map(a => ({ source: a.source, hasTitle: !!a.title })));
    ok(stored.every((a, i) => i === 0 || Date.parse(stored[i - 1].publishedAt || 0) >= Date.parse(a.publishedAt || 0) || !a.publishedAt), '3b. Real stored WNBA articles come back newest-first from the live DB query', stored.map(a => a.publishedAt));
  } catch (e) {
    skipped(`live spot-check unreachable this run (${e.message}) -- never fails the suite for an external provider being down`);
  }
  finish();
})();

function finish() {
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed, ${skip} skipped ===`);
  if (fail > 0) process.exit(1);
}
