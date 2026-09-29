// Phase 4: proves lib/historicalQueries.js's computeDefenseByPositionBulk/
// getDefenseByPositionAsync/getTeamAdvancedStatsAsync (the bulk,
// historicalStore-backed replacement for lib/dvpEngine.js's ~450-query
// recomputeDefenseByPosition) reproduce the SAME hand-calculated averages
// scripts/test-dvp-engine.js already proves for the legacy sync/better-
// sqlite3 path -- using the identical fixture scenario, isolated under
// sport='test_nba_bulk' so it never touches real data, via historicalStore
// (node:sqlite) only.

let failures = 0;
function check(name, condition, detail) { if (condition) console.log(`PASS  ${name}`); else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? '  -- ' + JSON.stringify(detail) : ''}`); } }

(async () => {
  const store = require('../lib/historicalStore');
  const { computeDefenseByPositionBulk, getDefenseByPositionAsync, getTeamAdvancedStatsAsync } = require('../lib/historicalQueries');

  const SPORT = 'test_nba_bulk';
  const rows = [];
  function insertGame(opponent, position, points, rebounds, assists, daysAgo) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    const gameId = `TEST-${opponent}-${position}-${daysAgo}-${Math.random().toString(36).slice(2, 8)}`;
    rows.push([SPORT, date.toISOString().slice(0, 10), gameId, `Fixture Player ${Math.random()}`, position, 'OPP', opponent, points, rebounds, assists, 30, 'test-fixture']);
  }

  // --- Identical fixture scenario to scripts/test-dvp-engine.js ---
  insertGame('SAC', 'PG', 20, 5, 8, 10);
  insertGame('SAC', 'PG', 30, 6, 7, 5);
  insertGame('SAC', 'PG', 40, 4, 9, 1);
  insertGame('BOS', 'PG', 10, 3, 4, 10);
  insertGame('BOS', 'PG', 12, 4, 5, 5);
  insertGame('BOS', 'PG', 14, 5, 6, 1);
  for (let i = 0; i < 5; i++) insertGame('SAC', 'SG', 50, 5, 5, 15 - i);
  for (let i = 0; i < 10; i++) insertGame('SAC', 'SG', 10, 5, 5, 10 - i);

  try {
    await store.transaction(async (exec) => {
      for (const r of rows) {
        await exec(`INSERT INTO box_scores (sport, game_date, game_id, player_name, position, team, opponent, points, rebounds, assists, minutes, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, r);
      }
    });

    const inserted = await store.query(`SELECT COUNT(*) c FROM box_scores WHERE sport = ?`, [SPORT]);
    check('0: inserted 21 synthetic box score rows', inserted[0].c === 21, inserted[0].c);

    const origQuery = store.query.bind(store);
    let queryCount = 0;
    store.query = async (...args) => { queryCount++; return origQuery(...args); };
    let summary;
    try { summary = await computeDefenseByPositionBulk(SPORT); } finally { store.query = origQuery; }
    check(`1: computeDefenseByPositionBulk issues O(1) queries (2), NOT ~450 (3 windows x 5 positions x N teams) (${queryCount} queries)`, queryCount === 2, `${queryCount} queries`);

    const sacSeason = await getDefenseByPositionAsync(SPORT, 'SAC', 'season');
    const bosSeason = await getDefenseByPositionAsync(SPORT, 'BOS', 'season');
    const sacLast10 = await getDefenseByPositionAsync(SPORT, 'SAC', 'last10');

    check('2: SAC allows to PG (season avg) = 30.0', Math.abs(sacSeason.PG.pointsAllowed - 30.0) < 0.01, sacSeason.PG.pointsAllowed);
    check('3: BOS allows to PG (season avg) = 12.0', Math.abs(bosSeason.PG.pointsAllowed - 12.0) < 0.01, bosSeason.PG.pointsAllowed);
    check('4: BOS PG rank #1 (toughest, fewest allowed)', bosSeason.PG.rank === 1, bosSeason.PG.rank);
    check('5: SAC PG rank #2', sacSeason.PG.rank === 2, sacSeason.PG.rank);
    check('6: SAC allows to SG (last10, excludes the 5 old 50-pt games) = 10.0', Math.abs(sacLast10.SG.pointsAllowed - 10.0) < 0.01, sacLast10.SG.pointsAllowed);
    check('7: SAC allows to SG (season, all 15 games) = 23.3', Math.abs(sacSeason.SG.pointsAllowed - 23.3) < 0.01, sacSeason.SG.pointsAllowed);
    check('8: SAC SG last10 games_sampled = 10', sacLast10.SG.gamesSampled === 10, sacLast10.SG.gamesSampled);
    check('9: SAC SG season games_sampled = 15', sacSeason.SG.gamesSampled === 15, sacSeason.SG.gamesSampled);

    // getTeamAdvancedStatsAsync: real read against team_advanced_rollup (a
    // separate, CSV-sourced table dvpEngine.js never writes -- just proves
    // the async read path itself works; a real row may or may not exist
    // for this fixture-only sport, so only assert it doesn't throw and
    // returns the documented null-when-absent shape.
    const advanced = await getTeamAdvancedStatsAsync(SPORT, 'SAC', 'season');
    check('10: getTeamAdvancedStatsAsync returns null for a sport/team with no real advanced-rollup row (never fabricated)', advanced === null, advanced);
  } finally {
    await store.run(`DELETE FROM box_scores WHERE sport = ?`, [SPORT]);
    await store.run(`DELETE FROM defense_by_position WHERE sport = ?`, [SPORT]);
  }

  console.log(`\n${failures === 0 ? 'ALL NBA DVP BULK FIXTURE TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
