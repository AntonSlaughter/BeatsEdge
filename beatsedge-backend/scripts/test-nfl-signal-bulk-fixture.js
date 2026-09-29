// Phase 4: proves the NEW historicalStore-backed async paths in
// lib/nflGameEnvironment.js (buildNflGameEnvironmentSignalAsync) and
// lib/nflMatchupSignal.js (computeDefenseAllowedAsOfAsync,
// bulkDefenseAllowedHistoryAsync, bulkPlayerHistoryAsync, backtestPoolAsync)
// reproduce the same real behaviors their legacy sync/nflDb (better-sqlite3)
// counterparts already prove in scripts/test-game-environment.js and
// scripts/test-matchup-signal.js -- using clearly-tagged fake rows
// (team/player_id prefixed with a unique per-run tag) inserted into and
// cleaned up from the REAL local data/beatsedge.db via historicalStore
// (node:sqlite), never better-sqlite3/nflDb. See
// scripts/test-nba-signal-bulk-fixture.js's header for why this project
// avoids combining better-sqlite3 and node:sqlite usage with heavy query
// volume in one process on this machine.

let failures = 0;
function check(name, condition, detail) { if (condition) console.log(`PASS  ${name}`); else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? '  -- ' + JSON.stringify(detail) : ''}`); } }

(async () => {
  const store = require('../lib/historicalStore');
  const { computeTeamPlayVolumeAsOfAsync, buildNflGameEnvironmentSignalAsync } = require('../lib/nflGameEnvironment');
  const { computeDefenseAllowedAsOfAsync, bulkDefenseAllowedHistoryAsync, bulkPlayerHistoryAsync, backtestPoolAsync } = require('../lib/nflMatchupSignal');

  const TAG = 'BLK' + (Date.now() % 100000); // short -- team column has real-world-length expectations, keep it team-code-ish
  const rows = [];
  function row(o) {
    return {
      season: o.season, week: o.week, season_type: 'REG', game_date: null,
      player_id: `${TAG}-${o.player_id}`, player_name: o.player_name || 'Test Player', position: o.position, team: o.team, opponent: o.opponent,
      passing_yards: o.passing_yards || 0, passing_tds: 0, interceptions: 0,
      rushing_yards: o.rushing_yards || 0, rushing_tds: 0,
      receptions: o.receptions || 0, targets: o.targets || 0, receiving_yards: o.receiving_yards || 0, receiving_tds: 0,
      fantasy_points_ppr: 0, source: 'bulktest',
      pass_attempts: o.pass_attempts || 0, completions: o.completions || 0, rush_attempts: o.rush_attempts || 0,
    };
  }

  const KC = `${TAG}KC`, BUF = `${TAG}BF`, LEG = `${TAG}LG`;
  // KC: 4 real weeks (1-4) of real play data, season 2025
  [1, 2, 3, 4].forEach(week => {
    rows.push(row({ season: 2025, week, player_id: 'qb1', player_name: 'QB One', position: 'QB', team: KC, opponent: 'OPP', pass_attempts: 35, rush_attempts: 3, completions: 24 }));
    rows.push(row({ season: 2025, week, player_id: 'rb1', player_name: 'RB One', position: 'RB', team: KC, opponent: 'OPP', pass_attempts: 0, rush_attempts: 18, completions: 0 }));
  });
  // BUF: 3 real weeks
  [1, 2, 3].forEach(week => {
    rows.push(row({ season: 2025, week, player_id: 'qb2', player_name: 'QB Two', position: 'QB', team: BUF, opponent: 'OPP', pass_attempts: 28, rush_attempts: 5, completions: 19 }));
    rows.push(row({ season: 2025, week, player_id: 'rb2', player_name: 'RB Two', position: 'RB', team: BUF, opponent: 'OPP', pass_attempts: 0, rush_attempts: 22, completions: 0 }));
  });
  // LEGACY: unpopulated 2022 rows -- zeros throughout, must never count as real "0-play" games
  [1, 2, 3, 4, 5].forEach(week => {
    rows.push(row({ season: 2022, week, player_id: 'qb3', player_name: 'QB Legacy', position: 'QB', team: LEG, opponent: 'OPP', pass_attempts: 0, rush_attempts: 0, completions: 0 }));
  });
  // Future week that must never leak
  rows.push(row({ season: 2025, week: 99, player_id: 'qb1', player_name: 'QB One', position: 'QB', team: KC, opponent: 'OPP', pass_attempts: 999, rush_attempts: 999, completions: 999 }));

  // DAL/SF matchup-signal fixtures
  const DAL = `${TAG}DL`, SF = `${TAG}SF`, PHI = `${TAG}PH`, SEA = `${TAG}SE`, NYG = `${TAG}NY`, WAS = `${TAG}WS`;
  [1, 2, 3, 4].forEach(week => {
    rows.push(row({ season: 2024, week, player_id: 'wr1', player_name: 'WR One', position: 'WR', team: PHI, opponent: DAL, receiving_yards: 90, targets: 9, receptions: 6 }));
    rows.push(row({ season: 2024, week, player_id: 'wr2', player_name: 'WR Two', position: 'WR', team: PHI, opponent: DAL, receiving_yards: 40, targets: 5, receptions: 3 }));
  });
  [1, 2, 3, 4].forEach(week => {
    rows.push(row({ season: 2024, week, player_id: 'wr3', player_name: 'WR Three', position: 'WR', team: SEA, opponent: SF, receiving_yards: 30, targets: 4, receptions: 2 }));
  });
  rows.push(row({ season: 2024, week: 99, player_id: 'wr1', player_name: 'WR One', position: 'WR', team: PHI, opponent: DAL, receiving_yards: 999, targets: 99, receptions: 9 }));
  rows.push(row({ season: 2025, week: 1, player_id: 'wr4', player_name: 'WR Four', position: 'WR', team: NYG, opponent: DAL, receiving_yards: 500, targets: 50, receptions: 5 }));
  rows.push(row({ season: 2025, week: 1, player_id: 'wr5', player_name: 'WR Five', position: 'WR', team: WAS, opponent: DAL, receiving_yards: 60, targets: 7, receptions: 4 }));

  // backtestPool fixture: 20 players with >=15 games each, on 2 distinct teams
  for (let pi = 0; pi < 20; pi++) {
    for (let week = 1; week <= 16; week++) {
      rows.push(row({ season: 2023, week, player_id: `bt${pi}`, player_name: `BT Player ${pi}`, position: 'WR', team: pi < 10 ? `${TAG}TA` : `${TAG}TB`, opponent: 'OPP', receiving_yards: 50 }));
    }
  }

  try {
    await store.transaction(async (exec) => {
      for (const r of rows) {
        await exec(`INSERT INTO nfl_player_game_stats (season, week, season_type, game_date, player_id, player_name, position, team, opponent, passing_yards, passing_tds, interceptions, rushing_yards, rushing_tds, receptions, targets, receiving_yards, receiving_tds, fantasy_points_ppr, source, pass_attempts, completions, rush_attempts)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [r.season, r.week, r.season_type, r.game_date, r.player_id, r.player_name, r.position, r.team, r.opponent, r.passing_yards, r.passing_tds, r.interceptions, r.rushing_yards, r.rushing_tds, r.receptions, r.targets, r.receiving_yards, r.receiving_tds, r.fantasy_points_ppr, r.source, r.pass_attempts, r.completions, r.rush_attempts]);
      }
    });

    // ---------------- game environment ----------------
    const win = await computeTeamPlayVolumeAsOfAsync(KC, 2025, 5, { games: 5 });
    check('1: KC trailing play volume/pass-rate computed from real weeks 1-4', win.sufficient && win.playVolume === 56 && Math.abs(win.passRate - 35 / 56) < 0.001, win);

    const futureCheck = await computeTeamPlayVolumeAsOfAsync(KC, 2025, 5, { games: 100 });
    check('2: week 99 (future, pass_attempts=999) never leaks into an earlier (season,week) lookup', !JSON.stringify(futureCheck).includes('999'));

    const legacy = await computeTeamPlayVolumeAsOfAsync(LEG, 2022, 6, { games: 5, minGames: 1 });
    check('3: unpopulated legacy rows (all-zero pass/rush attempts) never counted as real 0-play games', legacy.sufficient === false && legacy.playVolume === null, legacy);

    const signal = await buildNflGameEnvironmentSignalAsync({ team: KC, opponent: BUF, season: 2025, week: 4, games: 5 });
    check('4: KC signal carries the real trailing play volume (weeks 1-3)', signal.teamPlayVolume === 56, signal.teamPlayVolume);
    check('5: BUF signal carries its own real trailing play volume (weeks 1-2)', signal.opponentPlayVolume === 55, signal.opponentPlayVolume);
    check('6: expectedPlayVolume is the real average of both teams', signal.expectedPlayVolume === Math.round(((56 + 55) / 2) * 10) / 10, signal.expectedPlayVolume);

    // ---------------- matchup signal ----------------
    const dalWindow = await computeDefenseAllowedAsOfAsync(DAL, 'WR', 'receivingYards', 2024, 5, { games: 5 });
    check('7: DAL real trailing receiving-yards-allowed to WR (90+40 per week x4 weeks = 130)', dalWindow.sufficient && dalWindow.avgAllowed === 130, dalWindow);
    check('8: bye week never counted as a real 0-allowed game (DAL games=4, not 5)', dalWindow.games === 4, dalWindow.games);

    const sfWindow = await computeDefenseAllowedAsOfAsync(SF, 'WR', 'receivingYards', 2024, 5, { games: 5 });
    check('9: SF real trailing receiving-yards-allowed to WR (30/week)', sfWindow.sufficient && sfWindow.avgAllowed === 30, sfWindow);

    const dalNoLeak = await computeDefenseAllowedAsOfAsync(DAL, 'WR', 'receivingYards', 2024, 5, { games: 20 });
    check('10: future week 99 (999 yards) never leaks into an earlier lookup', !JSON.stringify(dalNoLeak).includes('999') && dalNoLeak.avgAllowed === 130, dalNoLeak);

    const dalSeason2025 = await computeDefenseAllowedAsOfAsync(DAL, 'WR', 'receivingYards', 2025, 2, { games: 1, minGames: 1 });
    check('11: season-2025 lookup correctly sums both real players facing DAL that week (500+60=560), never leaks into/from 2024', dalSeason2025.sufficient && dalSeason2025.games === 1 && dalSeason2025.avgAllowed === 560, dalSeason2025);

    const bulk = await bulkDefenseAllowedHistoryAsync([DAL, SF], ['WR']);
    check('12: bulk history returns real per-team-week rows for DAL|WR (4 weeks 2024 + 1 week 2025 + week 99 = 6)', bulk[`${DAL}|WR`] && bulk[`${DAL}|WR`].length === 6, bulk[`${DAL}|WR`] && bulk[`${DAL}|WR`].length);
    check('13: bulk history returns real per-team-week rows for SF|WR', bulk[`${SF}|WR`] && bulk[`${SF}|WR`].length === 4, bulk[`${SF}|WR`] && bulk[`${SF}|WR`].length);

    const playerHist = await bulkPlayerHistoryAsync([`${TAG}-wr1`, `${TAG}-wr2`]);
    check('14: bulkPlayerHistoryAsync returns real per-game rows for requested players', playerHist[`${TAG}-wr1`] && playerHist[`${TAG}-wr1`].length === 5, playerHist[`${TAG}-wr1`] && playerHist[`${TAG}-wr1`].length);

    // ---------------- backtestPoolAsync: N+1 fix + query budget ----------------
    const origQuery = store.query.bind(store);
    let queryCount = 0;
    store.query = async (...args) => { queryCount++; return origQuery(...args); };
    // limit is generous (real nfl_player_game_stats already has thousands of
    // real players with >=15 games across 2023-2026 -- a small limit would
    // rank the fixture's 20 16-game players below the real top players and
    // silently exclude them, which is a fixture-scale artifact, not a bug).
    let pool;
    try { pool = await backtestPoolAsync({ minGames: 15, limit: 20000 }); } finally { store.query = origQuery; }
    const fixturePoolEntries = pool.filter(p => p.id.startsWith(`${TAG}-bt`));
    check('15: backtestPoolAsync finds all 20 real fixture players with >=15 games', fixturePoolEntries.length === 20, fixturePoolEntries.length);
    check('16: backtestPoolAsync correctly attributes each player\'s real last-known team (not cross-contaminated)', fixturePoolEntries.every(p => p.team === `${TAG}TA` || p.team === `${TAG}TB`), fixturePoolEntries.map(p => p.team));
    check(`17: backtestPoolAsync issues O(1) queries (2), NOT one per returned player (${queryCount} queries)`, queryCount === 2, `${queryCount} queries`);
  } finally {
    await store.run(`DELETE FROM nfl_player_game_stats WHERE player_id LIKE ? OR team LIKE ?`, [`${TAG}-%`, `${TAG}%`]);
  }

  console.log(`\n${failures === 0 ? 'ALL NFL SIGNAL BULK FIXTURE TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
