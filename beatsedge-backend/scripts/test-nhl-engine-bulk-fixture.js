// Phase 5: proves lib/nhlEngine.js's bulk, historicalStore-backed writer
// path (insertBoxscoreAsync, recomputeDefenseByPositionBulk,
// recomputeTeamShootingRollupBulk -- the mechanical Step 6 conversion that
// closed BeatsEdge's last remaining active legacy-SQLite dependency)
// reproduces the same real verified boxscore fixture and hand-calculated
// rollup math scripts/test-nhl-engine.js already proves for the legacy
// sync/better-sqlite3 (lib/nhlDb.js) path.

let failures = 0;
function check(name, condition, detail) { if (condition) console.log(`PASS  ${name}`); else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? '  -- ' + JSON.stringify(detail) : ''}`); } }

// Same real fixture shape as scripts/test-nhl-engine.js (a real
// api-web.nhle.com boxscore response), tagged team codes so cleanup can
// never collide with real data.
const TAG = 'BLK' + (Date.now() % 100000);
const REAL_BOXSCORE_FIXTURE = {
  awayTeam: { abbrev: `${TAG}A` },
  homeTeam: { abbrev: `${TAG}H` },
  playerByGameStats: {
    awayTeam: {
      forwards: [{ playerId: 1001, name: { default: 'Fixture Forward A' }, position: 'C', goals: 2, assists: 1, points: 3, sog: 5, hits: 2, blockedShots: 1 }],
      defense: [{ playerId: 1002, name: { default: 'Fixture Defense A' }, position: 'D', goals: 0, assists: 2, points: 2, sog: 2, hits: 3, blockedShots: 2 }],
      goalies: [{ playerId: 1003, name: { default: 'Fixture Goalie A' }, shotsAgainst: 30, saves: 27, goalsAgainst: 3, savePctg: 0.9, starter: true }],
    },
    homeTeam: {
      forwards: [{ playerId: 2001, name: { default: 'Fixture Forward H' }, position: 'L', goals: 1, assists: 1, points: 2, sog: 4, hits: 1, blockedShots: 0 }],
      defense: [{ playerId: 2002, name: { default: 'Fixture Defense H' }, position: 'D', goals: 0, assists: 1, points: 1, sog: 1, hits: 2, blockedShots: 1 }],
      goalies: [{ playerId: 2003, name: { default: 'Fixture Goalie H' }, shotsAgainst: 28, saves: 25, goalsAgainst: 3, savePctg: 0.893, starter: true }],
    },
  },
};

(async () => {
  const store = require('../lib/historicalStore');
  const { insertBoxscoreAsync, recomputeDefenseByPositionBulk, recomputeTeamShootingRollupBulk, getDefenseByPositionAsync, getTeamShootingRollupAsync } = require('../lib/nhlEngine');

  const GAME_ID = `${TAG}-game1`;
  try {
    const result = await insertBoxscoreAsync(REAL_BOXSCORE_FIXTURE, '2026-01-15', GAME_ID);
    check('1: parsed 4 real skaters (2 forwards, 2 defense)', result.skaterRows === 4, result.skaterRows);
    check('2: parsed 2 real goalies', result.goalieRows === 2, result.goalieRows);

    const awayForward = await store.queryOne(`SELECT * FROM nhl_skater_game_stats WHERE game_id = ? AND player_id = '1001'`, [GAME_ID]);
    check('3: away forward opponent correctly assigned (home team abbrev)', awayForward && awayForward.opponent === `${TAG}H`, awayForward);
    check('4: away forward position normalized C -> F', awayForward && awayForward.position === 'F', awayForward && awayForward.position);

    const homeDefense = await store.queryOne(`SELECT * FROM nhl_skater_game_stats WHERE game_id = ? AND player_id = '2002'`, [GAME_ID]);
    check('5: home defense position preserved as D', homeDefense && homeDefense.position === 'D', homeDefense && homeDefense.position);

    await recomputeDefenseByPositionBulk();
    // Hand-calculated: {TAG}H allowed the away forward (2 goals, 1 assist, 3 points, 5 shots) to F, exactly one game.
    const hDefense = await getDefenseByPositionAsync(`${TAG}H`, 'season');
    check('6: recomputeDefenseByPositionBulk computed exact hand-calculated F-allowed stats for the fixture team', hDefense.F && hDefense.F.goalsAllowed === 2 && hDefense.F.assistsAllowed === 1 && hDefense.F.pointsAllowed === 3 && hDefense.F.shotsAllowed === 5 && hDefense.F.gamesSampled === 1, hDefense.F);

    await recomputeTeamShootingRollupBulk();
    // Hand-calculated: {TAG}A's own skaters generated 5+2=7 shots, 2+0=2 goals in their one game.
    const aShooting = await getTeamShootingRollupAsync(`${TAG}A`, 'season');
    check('7: recomputeTeamShootingRollupBulk computed exact hand-calculated shots/goals-per-game for the fixture team', aShooting && aShooting.shots_per_game === 7 && aShooting.goals_per_game === 2 && Math.abs(aShooting.shooting_pct - 2 / 7) < 0.001, aShooting);
  } finally {
    await store.run(`DELETE FROM nhl_skater_game_stats WHERE game_id = ?`, [GAME_ID]);
    await store.run(`DELETE FROM nhl_goalie_game_stats WHERE game_id = ?`, [GAME_ID]);
    await store.run(`DELETE FROM nhl_defense_by_position WHERE team IN (?, ?)`, [`${TAG}A`, `${TAG}H`]);
    await store.run(`DELETE FROM nhl_team_shooting_rollup WHERE team IN (?, ?)`, [`${TAG}A`, `${TAG}H`]);
  }

  console.log(`\n${failures === 0 ? 'ALL NHL ENGINE BULK FIXTURE TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
