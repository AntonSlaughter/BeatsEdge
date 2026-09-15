// Real test of lib/gameEnvironment.js and lib/nflGameEnvironment.js against
// throwaway, hand-built SQLite fixture DBs -- never touches the real
// data/beatsedge.db. Mirrors the fixture-build/assert/cleanup style already
// used by scripts/test-next-man-up.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { computeTeamEnvironmentAsOf, buildGameEnvironmentSignal, bulkTeamHistory } = require('../lib/gameEnvironment');
const { computeTeamPlayVolumeAsOf, buildNflGameEnvironmentSignal } = require('../lib/nflGameEnvironment');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}

console.log('=== game-environment signal test ===\n');

// ---------------- NBA (lib/gameEnvironment.js) ----------------
const nbaPath = path.join(os.tmpdir(), `gameenv-nba-${Date.now()}.db`);
const nbaDb = new Database(nbaPath);
nbaDb.exec(`
  CREATE TABLE team_game_advanced (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sport TEXT, game_date TEXT, game_id TEXT,
    team TEXT, opponent TEXT, defensive_rating REAL, offensive_rating REAL, pace REAL, source TEXT
  )
`);
const insNba = nbaDb.prepare(`INSERT INTO team_game_advanced (sport, game_date, game_id, team, opponent, defensive_rating, offensive_rating, pace) VALUES (?,?,?,?,?,?,?,?)`);

// BOS: 10 real games at pace ~100, off 115, def 108
for (let i = 0; i < 10; i++) {
  insNba.run('nba', `2025-01-${String(i + 1).padStart(2, '0')}`, `g${i}`, 'BOS', 'OPP', 108, 115, 100);
}
// LAL: 5 real games at pace ~103, off 112, def 111
for (let i = 0; i < 5; i++) {
  insNba.run('nba', `2025-01-0${i + 1}`, `l${i}`, 'LAL', 'OPP2', 111, 112, 103);
}
// A future row that must NEVER leak into an earlier asOfDate
insNba.run('nba', '2025-06-01', 'future1', 'BOS', 'OPP', 999, 999, 999);
// A thin team with only 1 real game -- insufficient
insNba.run('nba', '2025-01-01', 'thin0', 'THN', 'OPP', 100, 100, 95);

(function nbaTests() {
  const win = computeTeamEnvironmentAsOf(nbaDb, 'BOS', '2025-01-11', { games: 10 });
  ok(win.sufficient && win.pace === 100 && win.offensiveRating === 115 && win.defensiveRating === 108,
    'BOS trailing window picks up the real 10-game averages', win);
  ok(win.mostRecentGameDate < '2025-01-11', 'no row on/after asOfDate leaked into the window', win.mostRecentGameDate);

  const futureCheck = computeTeamEnvironmentAsOf(nbaDb, 'BOS', '2025-01-11', { games: 100 });
  ok(!JSON.stringify(futureCheck).includes('999'), 'the 2025-06-01 future row (pace 999) never appears for an earlier asOfDate', futureCheck);

  const thin = computeTeamEnvironmentAsOf(nbaDb, 'THN', '2025-01-15', { games: 10, minGames: 3 });
  ok(thin.sufficient === false && thin.pace === null, 'a team with only 1 real game is insufficient, not padded/guessed', thin);

  const unknown = computeTeamEnvironmentAsOf(nbaDb, 'ZZZ', '2025-01-15', {});
  ok(unknown.sufficient === false && unknown.pace === null, 'an unknown team returns insufficient, never a fabricated number', unknown);

  const signal = buildGameEnvironmentSignal({ db: nbaDb, team: 'BOS', opponent: 'LAL', asOfDate: '2025-01-11', games: 10 });
  ok(signal.teamPace === 100 && signal.opponentPace === 103, 'signal carries both real team paces', signal);
  ok(signal.expectedPace === 101.5, 'expectedPace is the real average of both teams own pace', signal.expectedPace);
  const expectedGap = Math.abs((115 - 108) - (112 - 111));
  ok(signal.netRatingGap === Math.round(expectedGap * 10) / 10, 'netRatingGap is a real, non-fabricated function of both teams own net ratings', signal.netRatingGap);
  ok(signal.dataSource && signal.dataSource.includes('team_game_advanced'), 'signal names its real data source');

  const noOpp = buildGameEnvironmentSignal({ db: nbaDb, team: 'BOS', opponent: 'THN', asOfDate: '2025-01-15', games: 10 });
  ok(noOpp.teamPace === 100 && noOpp.expectedPace === null && noOpp.netRatingGap === null,
    'insufficient opponent data -> composite fields null, but the real team side is still reported (never fabricated to fill the gap)', noOpp);

  const missing = buildGameEnvironmentSignal({ db: nbaDb, team: null, opponent: 'LAL', asOfDate: '2025-01-15' });
  ok(missing.teamPace === null && missing.expectedPace === null, 'missing team -> everything null, never guessed', missing);

  const bulk = bulkTeamHistory(nbaDb, ['BOS', 'LAL', 'ZZZ']);
  ok(bulk.BOS && bulk.BOS.length === 11 && bulk.LAL && bulk.LAL.length === 5 && !bulk.ZZZ,
    'bulkTeamHistory returns real per-game rows grouped by team, nothing for an unknown team', { bosLen: bulk.BOS && bulk.BOS.length, lalLen: bulk.LAL && bulk.LAL.length });
  const bosSorted = bulk.BOS.every((r, i) => i === 0 || r.game_date >= bulk.BOS[i - 1].game_date);
  ok(bosSorted, 'bulkTeamHistory rows are chronologically ordered oldest-first');
})();

nbaDb.close();
fs.unlinkSync(nbaPath);

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
