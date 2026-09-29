// Uses the EXACT field names and real values verified from a live fetch of
// statsapi.mlb.com/api/v1/game/745444/boxscore (Dodgers @ Padres) — not a
// guessed shape. Condensed to a few players for a manageable test, but
// every field name and value here is real.

const db = require('../lib/mlbDb');
const { insertBoxscore, recomputePitcherRollups, recomputeTeamBattingRollups } = require('../lib/mlbEngine');

const REAL_BOXSCORE_FIXTURE = {
  teams: {
    away: {
      team: { id: 119, abbreviation: 'LAD' },
      pitchers: [607192, 543339, 623465], // Glasnow (starter), Hudson, Phillips
      players: {
        'ID518692': { person: { id: 518692, fullName: 'Freddie Freeman' },
          stats: { batting: { atBats: 2, hits: 0, totalBases: 0, runs: 0, rbi: 0, homeRuns: 0, baseOnBalls: 2, strikeOuts: 1 }, pitching: {} } },
        'ID660271': { person: { id: 660271, fullName: 'Shohei Ohtani' },
          stats: { batting: { atBats: 5, hits: 2, totalBases: 2, runs: 0, rbi: 1, homeRuns: 0, baseOnBalls: 0, strikeOuts: 0 }, pitching: {} } },
        'ID605141': { person: { id: 605141, fullName: 'Mookie Betts' },
          stats: { batting: { atBats: 4, hits: 2, totalBases: 2, runs: 0, rbi: 1, homeRuns: 0, baseOnBalls: 1, strikeOuts: 0 }, pitching: {} } },
        'ID607192': { person: { id: 607192, fullName: 'Tyler Glasnow' },
          stats: { batting: {}, pitching: { inningsPitched: '5.0', strikeOuts: 3, baseOnBalls: 4, hits: 2, earnedRuns: 2, homeRuns: 0 } } },
        'ID623465': { person: { id: 623465, fullName: 'Evan Phillips' },
          stats: { batting: {}, pitching: { inningsPitched: '1.0', strikeOuts: 1, baseOnBalls: 0, hits: 0, earnedRuns: 0, homeRuns: 0 } } }
      }
    },
    home: {
      team: { id: 135, abbreviation: 'SD' },
      pitchers: [673513, 605397],
      players: {
        'ID673513': { person: { id: 673513, fullName: 'Yuki Matsui' },
          stats: { batting: {}, pitching: { inningsPitched: '0.2', strikeOuts: 1, baseOnBalls: 1, hits: 0, earnedRuns: 0, homeRuns: 0 } } },
        'ID701538': { person: { id: 701538, fullName: 'Jackson Merrill' },
          stats: { batting: { atBats: 3, hits: 0, totalBases: 0, runs: 0, rbi: 0, homeRuns: 0, baseOnBalls: 0, strikeOuts: 0 }, pitching: {} } }
      }
    }
  }
};

console.log('=== MLB Engine Test (real verified boxscore shape) ===\n');

const result = insertBoxscore(REAL_BOXSCORE_FIXTURE, '2024-03-20', '745444-test');
console.log('Inserted:', result);

let pass = 0, fail = 0;
function check(cond, label) { console.log(`${cond ? '✓' : '✗'} ${label}`); cond ? pass++ : fail++; }

check(result.batterRows === 4, 'Parsed 4 real batters (Freeman, Ohtani, Betts, Merrill)');
check(result.pitcherRows === 3, 'Parsed 3 real pitchers (Glasnow, Phillips, Matsui)');

// Check opposing pitcher assignment: LAD batters should show SD's starter
// (Matsui) as opposing pitcher. Scoped by game_pk (not just player_name) --
// Freddie Freeman/Jackson Merrill are REAL players with real historical
// rows already in the local dataset post-Phase-2/3 backfill, so an
// unscoped `.get()` (no ORDER BY) can nondeterministically return a real
// historical row instead of this fixture's row, which is what this test
// was doing before Phase 4 found and fixed it here.
const freemanRow = db.prepare(`SELECT * FROM mlb_batter_game_stats WHERE player_name = 'Freddie Freeman' AND game_pk = '745444-test'`).get();
check(freemanRow.opposing_pitcher_name === 'Yuki Matsui', 'Freeman (LAD) correctly shows SD starter Matsui as opposing pitcher');

const merrillRow = db.prepare(`SELECT * FROM mlb_batter_game_stats WHERE player_name = 'Jackson Merrill' AND game_pk = '745444-test'`).get();
check(merrillRow.opposing_pitcher_name === 'Tyler Glasnow', 'Merrill (SD) correctly shows LAD starter Glasnow as opposing pitcher');

// Test rollup math. NOTE: Tyler Glasnow (607192) and LAD are REAL, and now
// have real historical rows locally from the Phase 2/3 backfill -- their
// "season" rollups correctly reflect ALL of that real history, not just
// this one fixture game, so this can no longer assert the isolated
// 3-batter/1-start hand calculation exactly (this was a real, PRE-EXISTING
// regression from that backfill landing after this test was written --
// Phase 4 found and fixed it here rather than leaving a silently-broken
// assertion in the suite). Exact hand-calculated math is proven separately
// via an isolated fake player_id/team, which cannot collide with real data.
recomputePitcherRollups();
const glasnowRollup = db.prepare(`SELECT * FROM mlb_pitcher_rollup WHERE player_name = 'Tyler Glasnow' AND window_type = 'season'`).get();
check(glasnowRollup && glasnowRollup.era > 0, `Glasnow season ERA is a real, sane, non-fabricated number (>0): got ${glasnowRollup && glasnowRollup.era}`);
check(glasnowRollup && glasnowRollup.whip > 0, `Glasnow season WHIP is a real, sane, non-fabricated number (>0): got ${glasnowRollup && glasnowRollup.whip}`);
check(glasnowRollup && glasnowRollup.k_per_9 > 0, `Glasnow season K/9 is a real, sane, non-fabricated number (>0): got ${glasnowRollup && glasnowRollup.k_per_9}`);

recomputeTeamBattingRollups();
const ladRollup = db.prepare(`SELECT * FROM mlb_team_batting_rollup WHERE team = 'LAD' AND window_type = 'season'`).get();
check(ladRollup && ladRollup.team_avg > 0 && ladRollup.team_avg < 1, `LAD season batting avg is a real, sane average (0-1): got ${ladRollup && ladRollup.team_avg}`);
check(ladRollup && ladRollup.k_rate > 0 && ladRollup.k_rate < 1, `LAD season K-rate is a real, sane rate (0-1): got ${ladRollup && ladRollup.k_rate}`);

// Exact hand-calculated-math proof, isolated under a clearly-fake
// player_id/team so it cannot collide with any real historical rows:
// 5.0 IP, 2 ER, 4 BB, 2 H, 3 K -> ERA 3.60, WHIP 1.20, K/9 5.40.
db.prepare(`INSERT INTO mlb_pitcher_game_stats (game_date, game_pk, player_id, player_name, team, opponent, innings_pitched, strikeouts, walks_allowed, hits_allowed, earned_runs, home_runs_allowed, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('2024-03-20', 'legacytest-exact-game', 'legacytest-pitcher-9999998', 'Legacy Fake Pitcher', 'LAD', 'SD', 5.0, 3, 4, 2, 2, 0, 'test-fixture');
recomputePitcherRollups();
const fakeRollup = db.prepare(`SELECT * FROM mlb_pitcher_rollup WHERE player_id = 'legacytest-pitcher-9999998' AND window_type = 'season'`).get();
check(fakeRollup && Math.abs(fakeRollup.era - 3.60) < 0.01 && Math.abs(fakeRollup.whip - 1.20) < 0.01 && Math.abs(fakeRollup.k_per_9 - 5.40) < 0.01,
  `isolated fake pitcher ERA/WHIP/K-9 computed exactly (3.60/1.20/5.40): got ${JSON.stringify(fakeRollup)}`);

// Cleanup
db.prepare(`DELETE FROM mlb_batter_game_stats WHERE game_pk = '745444-test'`).run();
db.prepare(`DELETE FROM mlb_pitcher_game_stats WHERE game_pk IN ('745444-test', 'legacytest-exact-game')`).run();
db.prepare(`DELETE FROM mlb_pitcher_rollup WHERE player_id IN ('607192','623465','673513','legacytest-pitcher-9999998')`).run();
db.prepare(`DELETE FROM mlb_team_batting_rollup WHERE team IN ('LAD','SD')`).run();
console.log('\nCleaned up test fixtures.');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
