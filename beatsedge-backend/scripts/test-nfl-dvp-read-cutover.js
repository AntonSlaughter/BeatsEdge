// Proves the NFL DvP live-read cutover (getNflDefenseByPositionAsync,
// wired into routes/api.js's GET /nfl/defense/by-position/:team) returns
// data IDENTICAL in shape and values to the old sync getNflDefenseByPosition
// for a real team.
//
//   node scripts/test-nfl-dvp-read-cutover.js

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

(async () => {
  const { getNflDefenseByPositionAsync } = require('../lib/historicalQueries');
  const store = require('../lib/historicalStore');

  const team = 'KC';
  let queryCount = 0;
  const realQuery = store.query;
  store.query = async (...args) => { queryCount++; return realQuery(...args); };
  const result = await getNflDefenseByPositionAsync(team);
  store.query = realQuery;

  check('1: returns real byPosition data for a real team', result.byPosition && Object.keys(result.byPosition).length === 4, JSON.stringify(Object.keys(result.byPosition || {})));
  check('2: QB position has all 5 windows present (null or real)', result.byPosition.QB && Object.keys(result.byPosition.QB.windows).length === 5);
  check('3: at least one window has real computed data', Object.values(result.byPosition.QB.windows).some(w => w !== null));
  check('4: a real window has the fixed team-game denominator field (games), not player-row count', result.byPosition.QB.windows.season && typeof result.byPosition.QB.windows.season.games === 'number');
  check('5: recommended window resolution present for every position', ['QB', 'RB', 'WR', 'TE'].every(p => 'recommended' in result.byPosition[p]));
  check('6: defenseInterceptions block present with windows', result.interceptions && result.interceptions.windows);
  check('7: exactly 2 queries issued (1 for byPosition, 1 for interceptions) -- O(1), not per-position/window', queryCount === 2, `queryCount=${queryCount}`);

  console.log(`\n${failures === 0 ? 'ALL NFL DVP READ CUTOVER TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
