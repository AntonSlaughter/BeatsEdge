// Proves lib/newsPlayerIdentity.js's new Turso-safe bulk index builder
// (buildCanonicalIndexBulk, via lib/historicalStore.js) produces an
// IDENTICAL resolution outcome to the old direct-SQLite per-sport index
// (getIndexForSport, via lib/newsDb.js's shared connection) for real
// player names -- the fix for the news/historical cross-database problem
// (news_articles and mlb/nfl/nba historical tables no longer need to be
// queryable from ONE connection/physical file once historical tables move
// to Turso).
//
//   node scripts/test-news-identity-bulk.js

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

(async () => {
  const { getIndexForSport, buildCanonicalIndexBulk, resolvePlayerForArticle } = require('../lib/newsPlayerIdentity');

  for (const sport of ['nba', 'nfl', 'mlb']) {
    const oldIndex = getIndexForSport(sport);
    const newIndex = await buildCanonicalIndexBulk(sport);
    check(`${sport}: bulk index built successfully`, !!newIndex, 'index was null');
    if (!oldIndex || !newIndex) continue;
    check(`${sport}: playerIdSource matches`, oldIndex.playerIdSource === newIndex.playerIdSource, `${oldIndex.playerIdSource} vs ${newIndex.playerIdSource}`);
    check(`${sport}: same number of distinct player ids`, oldIndex.byId.size === newIndex.byId.size, `${oldIndex.byId.size} vs ${newIndex.byId.size}`);
    // Spot check: every id in the old index resolves to the exact same name+team in the new one.
    let mismatch = null;
    for (const [id, entry] of oldIndex.byId) {
      const newEntry = newIndex.byId.get(id);
      if (!newEntry || newEntry.name !== entry.name || newEntry.team !== entry.team) { mismatch = { id, old: entry, new: newEntry }; break; }
    }
    check(`${sport}: every player id resolves to identical name+team in both indexes`, mismatch === null, JSON.stringify(mismatch));
  }

  // End-to-end: a real article shape resolves identically whether given the
  // old sync index (via getIndexForSport, the resolvePlayerForArticle
  // default) or the new prebuilt bulk index.
  {
    const nbaOld = getIndexForSport('nba');
    const nbaNew = await buildCanonicalIndexBulk('nba');
    if (nbaOld && nbaOld.byId.size) {
      const sample = [...nbaOld.byId.values()][0];
      const resultOld = resolvePlayerForArticle({ sport: 'nba', espnAthleteId: null, espnAthleteName: null, rawName: sample.name, team: sample.team });
      const resultNew = resolvePlayerForArticle({ sport: 'nba', espnAthleteId: null, espnAthleteName: null, rawName: sample.name, team: sample.team, prebuiltIndex: nbaNew });
      check('nba: resolvePlayerForArticle gives identical result via old sync index vs new prebuilt bulk index', JSON.stringify(resultOld) === JSON.stringify(resultNew), `${JSON.stringify(resultOld)} vs ${JSON.stringify(resultNew)}`);
    } else {
      console.log('SKIPPED: no local NBA player index rows to sample from');
    }
  }

  // Tier 1 (explicit ESPN athlete id) never touches either index -- must
  // still resolve correctly with prebuiltIndex present, absent, or null.
  {
    const r1 = resolvePlayerForArticle({ sport: 'nba', espnAthleteId: 1966, espnAthleteName: 'LeBron James', rawName: 'LeBron James', team: 'LAL' });
    const r2 = resolvePlayerForArticle({ sport: 'nba', espnAthleteId: 1966, espnAthleteName: 'LeBron James', rawName: 'LeBron James', team: 'LAL', prebuiltIndex: null });
    check('Tier-1 explicit athlete id resolution unaffected by prebuiltIndex presence/absence', JSON.stringify(r1) === JSON.stringify(r2) && r1.playerMatchMethod === 'EXACT_ID');
  }

  console.log(`\n${failures === 0 ? 'ALL NEWS-IDENTITY BULK TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
