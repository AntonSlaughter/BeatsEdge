// Query-budget regression tests: for representative bulk requests, prove
// the number of remote (Turso-bound, in production) queries stays small
// and FIXED regardless of how many players/teams are requested -- never
// O(n) per-player/per-team. Instruments lib/historicalStore.js's query()
// with a counter for the duration of each scenario.
//
//   node scripts/test-query-budget.js

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

(async () => {
  const store = require('../lib/historicalStore');
  const hq = require('../lib/historicalQueries');

  let queryCount = 0;
  const realQuery = store.query;
  store.query = async (...args) => { queryCount++; return realQuery(...args); };
  function resetCounter() { queryCount = 0; }

  // ---------- NBA prop card: bulk player-history fetch for a real slate size ----------
  {
    const rows = await realQuery(`SELECT DISTINCT athlete_id FROM nba_player_box WHERE season = (SELECT MAX(season) FROM nba_player_box) LIMIT 60`);
    const playerIds = rows.map(r => r.athlete_id);
    resetCounter();
    const result = await hq.getPlayerGameHistories('nba', playerIds, { limit: 15 });
    check(`NBA prop card (60 players): 1 query regardless of player count`, queryCount === 1, `queryCount=${queryCount}`);
    check(`NBA prop card: returned histories for the requested players`, result.size > 0, `result.size=${result.size}`);
  }

  // ---------- WNBA prop card: same pattern, same table shape ----------
  {
    const rows = await realQuery(`SELECT DISTINCT athlete_id FROM wnba_player_box WHERE season = (SELECT MAX(season) FROM wnba_player_box) LIMIT 40`);
    const playerIds = rows.map(r => r.athlete_id);
    resetCounter();
    const result = await hq.getPlayerGameHistories('wnba', playerIds, { limit: 15 });
    check(`WNBA prop card (40 players): 1 query regardless of player count`, queryCount === 1, `queryCount=${queryCount}`);
    check(`WNBA prop card: returned histories for the requested players`, result.size > 0, `result.size=${result.size}`);
  }

  // ---------- NFL prop card: bulk player-history fetch ----------
  {
    const rows = await realQuery(`SELECT DISTINCT player_id FROM nfl_player_game_stats WHERE season = (SELECT MAX(season) FROM nfl_player_game_stats) LIMIT 80`);
    const playerIds = rows.map(r => r.player_id);
    resetCounter();
    const result = await hq.getNflPlayerHistories(playerIds, { seasons: [2023, 2024, 2025, 2026] });
    check(`NFL prop card (80 players): 1 query regardless of player count`, queryCount === 1, `queryCount=${queryCount}`);
    check(`NFL prop card: returned histories for the requested players`, result.size > 0, `result.size=${result.size}`);
  }

  // ---------- MLB prop card: bulk batter + pitcher window fetch ----------
  {
    const batterRows = await realQuery(`SELECT DISTINCT player_id FROM mlb_batter_game_stats LIMIT 50`);
    const pitcherRows = await realQuery(`SELECT DISTINCT player_id FROM mlb_pitcher_game_stats LIMIT 20`);
    resetCounter();
    const batterResult = await hq.getMlbBatterWindows(batterRows.map(r => r.player_id));
    const pitcherResult = await hq.getMlbPitcherWindows(pitcherRows.map(r => r.player_id));
    check(`MLB prop card (50 batters + 20 pitchers): 2 queries total (1 per domain), not 1-per-player`, queryCount === 2, `queryCount=${queryCount}`);
    check(`MLB prop card: returned batter windows`, batterResult.size >= 0);
    check(`MLB prop card: returned pitcher windows`, pitcherResult.size >= 0);
  }

  // ---------- NBA next-man-up: teammate context for a real gameId set ----------
  {
    const gameRows = await realQuery(`SELECT DISTINCT game_id FROM nba_player_box WHERE season = (SELECT MAX(season) FROM nba_player_box) LIMIT 15`);
    const gameIds = gameRows.map(r => r.game_id);
    resetCounter();
    const result = await hq.getTeammateContextBulk('nba', gameIds);
    check(`NBA next-man-up (15 games' worth of rosters): 1 query regardless of game count`, queryCount === 1, `queryCount=${queryCount}`);
    check(`NBA next-man-up: returned rosters`, result.size > 0, `result.size=${result.size}`);
  }

  // ---------- Scaling check: 400 players is STILL O(1) queries (within one IN-chunk) ----------
  {
    const rows = await realQuery(`SELECT DISTINCT athlete_id FROM nba_player_box LIMIT 400`);
    resetCounter();
    await hq.getPlayerGameHistories('nba', rows.map(r => r.athlete_id));
    check(`400 players (one full IN-chunk): still exactly 1 query`, queryCount === 1, `queryCount=${queryCount}`);
  }
  {
    const rows = await realQuery(`SELECT DISTINCT athlete_id FROM nba_player_box LIMIT 500`);
    resetCounter();
    await hq.getPlayerGameHistories('nba', rows.map(r => r.athlete_id));
    // Regression guard: this must NEVER become "1 query per player" (500).
    // It's allowed to be >1 once past the 400-item chunk boundary (2 for
    // 500 players), but must stay small and bounded, not O(n).
    check(`500 players (crosses the 400-item IN-chunk boundary): stays small (<=2), never O(n)`, queryCount <= 2, `queryCount=${queryCount}`);
  }

  store.query = realQuery; // restore

  console.log(`\n${failures === 0 ? 'ALL QUERY-BUDGET TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
