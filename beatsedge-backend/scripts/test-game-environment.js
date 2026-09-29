// Real test of lib/nflGameEnvironment.js's LEGACY sync path (still
// fixture-injectable via a `db` param -- kept for local-development/
// offline-script/test-fixture use per Phase 4, no longer on the live
// production route) against a throwaway, hand-built SQLite fixture DB --
// never touches the real data/beatsedge.db.
//
// The NBA half of this file (lib/gameEnvironment.js) was REMOVED here --
// Phase 3 converted computeTeamEnvironmentAsOf/buildGameEnvironmentSignal/
// bulkTeamHistory to async AND to always read via historicalStore
// (ignoring any `db` argument), so fixture injection like this file did is
// no longer possible for that module; the fixture-style assertions below
// silently produced `undefined`/`Promise` comparisons after that
// conversion landed, which is a real, PRE-EXISTING regression from Phase 3
// this Phase 4 pass discovered and is fixing by removing the now-impossible
// fixture section rather than leaving a permanently-broken test in the
// suite. lib/gameEnvironment.js's real, historicalStore-backed behavior is
// already covered by scripts/test-game-environment-conversion.js (Phase 3),
// which tests it the correct way (async, against real local data).

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { computeTeamPlayVolumeAsOf, buildNflGameEnvironmentSignal } = require('../lib/nflGameEnvironment');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}

console.log('=== game-environment signal test (NFL legacy sync path) ===\n');

// ---------------- NFL (lib/nflGameEnvironment.js) ----------------
const nflPath = path.join(os.tmpdir(), `gameenv-nfl-${Date.now()}.db`);
const nflFixtureDb = new Database(nflPath);
nflFixtureDb.exec(`
  CREATE TABLE nfl_player_game_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, season INTEGER, week INTEGER, season_type TEXT, game_date TEXT,
    player_id TEXT, player_name TEXT, position TEXT, team TEXT, opponent TEXT,
    passing_yards REAL DEFAULT 0, rushing_yards REAL DEFAULT 0,
    pass_attempts REAL DEFAULT 0, rush_attempts REAL DEFAULT 0, completions REAL DEFAULT 0
  )
`);
const insNfl = nflFixtureDb.prepare(`
  INSERT INTO nfl_player_game_stats (season, week, season_type, player_id, player_name, position, team, opponent, pass_attempts, rush_attempts, completions)
  VALUES (@season,@week,'REG',@player_id,@player_name,@position,@team,@opponent,@pass_attempts,@rush_attempts,@completions)
`);

// KC: 4 real weeks (1-4) with real play data, season 2025
[1, 2, 3, 4].forEach(week => {
  insNfl.run({ season: 2025, week, player_id: 'qb1', player_name: 'QB One', position: 'QB', team: 'KC', opponent: 'OPP', pass_attempts: 35, rush_attempts: 3, completions: 24 });
  insNfl.run({ season: 2025, week, player_id: 'rb1', player_name: 'RB One', position: 'RB', team: 'KC', opponent: 'OPP', pass_attempts: 0, rush_attempts: 18, completions: 0 });
});
// BUF: 3 real weeks
[1, 2, 3].forEach(week => {
  insNfl.run({ season: 2025, week, player_id: 'qb2', player_name: 'QB Two', position: 'QB', team: 'BUF', opponent: 'OPP', pass_attempts: 28, rush_attempts: 5, completions: 19 });
  insNfl.run({ season: 2025, week, player_id: 'rb2', player_name: 'RB Two', position: 'RB', team: 'BUF', opponent: 'OPP', pass_attempts: 0, rush_attempts: 22, completions: 0 });
});
// LEGACY: unpopulated 2022 rows for a third team -- zeros throughout, must
// never be counted as real "0-play" games (matches the real 2022-2024 data
// quality gap this module's header documents).
[1, 2, 3, 4, 5].forEach(week => {
  insNfl.run({ season: 2022, week, player_id: 'qb3', player_name: 'QB Legacy', position: 'QB', team: 'LEG', opponent: 'OPP', pass_attempts: 0, rush_attempts: 0, completions: 0 });
});
// A future week that must never leak into an earlier (season, week)
insNfl.run({ season: 2025, week: 99, player_id: 'qb1', player_name: 'QB One', position: 'QB', team: 'KC', opponent: 'OPP', pass_attempts: 999, rush_attempts: 999, completions: 999 });

(function nflTests() {
  const win = computeTeamPlayVolumeAsOf(nflFixtureDb, 'KC', 2025, 5, { games: 5 });
  ok(win.sufficient && win.playVolume === 56 && Math.abs(win.passRate - 35 / 56) < 0.001,
    'KC trailing play volume/pass-rate computed from real weeks 1-4', win);

  const futureCheck = computeTeamPlayVolumeAsOf(nflFixtureDb, 'KC', 2025, 5, { games: 100 });
  ok(!JSON.stringify(futureCheck).includes('999'), 'week 99 (future, pass_attempts=999) never leaks into an earlier (season,week) lookup', futureCheck);

  const legacy = computeTeamPlayVolumeAsOf(nflFixtureDb, 'LEG', 2022, 6, { games: 5, minGames: 1 });
  ok(legacy.sufficient === false && legacy.playVolume === null,
    'unpopulated legacy rows (all-zero pass/rush attempts) are never counted as real 0-play games', legacy);

  const signal = buildNflGameEnvironmentSignal({ db: nflFixtureDb, team: 'KC', opponent: 'BUF', season: 2025, week: 4, games: 5 });
  ok(signal.teamPlayVolume === 56, 'KC signal carries the real trailing play volume (weeks 1-3)', signal.teamPlayVolume);
  ok(signal.opponentPlayVolume === 55, 'BUF signal carries its own real trailing play volume (weeks 1-2)', signal.opponentPlayVolume);
  ok(signal.expectedPlayVolume === Math.round(((56 + 55) / 2) * 10) / 10, 'expectedPlayVolume is the real average of both teams', signal.expectedPlayVolume);
  ok(signal.dataSource && signal.dataSource.includes('nfl_player_game_stats'), 'signal names its real data source and the 2025+ caveat');

  const insufficientOpp = buildNflGameEnvironmentSignal({ db: nflFixtureDb, team: 'KC', opponent: 'LEG', season: 2022, week: 6, games: 5 });
  ok(insufficientOpp.expectedPlayVolume === null, 'insufficient opponent data (legacy zeros) -> composite field null, never guessed', insufficientOpp);
})();

nflFixtureDb.close();
fs.unlinkSync(nflPath);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
