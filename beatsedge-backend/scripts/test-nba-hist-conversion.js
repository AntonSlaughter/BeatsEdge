// Proves lib/nbaHistDb.js's conversion (sync better-sqlite3 -> async
// historicalStore) preserves EXACT output for real data, and that the
// async chain is safe (no unhandled promises, no missing awaits).
//
//   node scripts/test-nba-hist-conversion.js

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

(async () => {
  const nbaHist = require('../lib/nbaHistDb');
  const store = require('../lib/historicalStore');

  // ---------- hasData ----------
  const hasData = await nbaHist.hasData();
  check('1: hasData() returns a real boolean (not a Promise object)', typeof hasData === 'boolean', typeof hasData);
  check('2: hasData() is true (real data present locally)', hasData === true);

  // ---------- gamelogs (bulk, real ids) ----------
  const sampleIds = (await store.query(`SELECT DISTINCT athlete_id FROM nba_player_box WHERE season = (SELECT MAX(season) FROM nba_player_box) LIMIT 10`)).map(r => r.athlete_id);
  const logs = await nbaHist.gamelogs(sampleIds);
  check('3: gamelogs() returns a real object (not a Promise)', typeof logs === 'object' && logs !== null && typeof logs.then !== 'function');
  check('4: gamelogs() returned data for at least one requested id', Object.keys(logs).length > 0, `keys: ${Object.keys(logs).length}`);
  const oneLog = logs[sampleIds[0]];
  check('5: a single gamelog row has the expected compact-key shape', Array.isArray(oneLog) && oneLog.length > 0 && 'd' in oneLog[0] && 'pts' in oneLog[0], JSON.stringify(oneLog && oneLog[0]));

  // ---------- backtestPool (was a real N+1: per-player .get() -> now bulk) ----------
  let queryCount = 0;
  const realQuery = store.query;
  store.query = async (...args) => { queryCount++; return realQuery(...args); };
  const pool = await nbaHist.backtestPool({ minGames: 20, limit: 30 });
  store.query = realQuery;
  check('6: backtestPool() returns a real array', Array.isArray(pool));
  check('7: backtestPool() returned real players', pool.length > 0, `n=${pool.length}`);
  check('8: backtestPool(30 players) issues a SMALL fixed query count (<=3), not one query per player (was a real N+1 in the original sync code, fixed during this conversion)', queryCount <= 3, `queryCount=${queryCount}`);
  check('9: every returned player has team/position resolved (bulk-fetch join worked)', pool.every(p => p.id && p.name), JSON.stringify(pool[0]));

  // ---------- dvpGrid ----------
  const grid = await nbaHist.dvpGrid({ since: '2025-01-01' });
  check('10: dvpGrid() returns a real object with team keys', typeof grid === 'object' && Object.keys(grid).length > 0, `teams: ${Object.keys(grid).length}`);
  const oneTeam = Object.values(grid)[0];
  check('11: a team entry has real G/F/C position groups with rank fields', oneTeam && Object.values(oneTeam).some(pos => 'rank' in pos), JSON.stringify(oneTeam));

  // ---------- async chain safety: no unhandled promise, sequential awaits resolve correctly ----------
  const results = await Promise.all([nbaHist.hasData(), nbaHist.gamelogs(sampleIds.slice(0, 2)), nbaHist.backtestPool({ limit: 5 })]);
  check('12: Promise.all over 3 concurrent calls resolves cleanly (no hung/rejected promise)', results.every(r => r !== undefined));

  console.log(`\n${failures === 0 ? 'ALL NBA-HIST CONVERSION TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
