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

// Check opposing pitcher assignment: LAD batters should show SD's starter (Matsui) as opposing pitcher
const freemanRow = db.prepare(`SELECT * FROM mlb_batter_game_stats WHERE player_name = 'Freddie Freeman'`).get();
check(freemanRow.opposing_pitcher_name === 'Yuki Matsui', 'Freeman (LAD) correctly shows SD starter Matsui as opposing pitcher');

const merrillRow = db.prepare(`SELECT * FROM mlb_batter_game_stats WHERE player_name = 'Jackson Merrill'`).get();
check(merrillRow.opposing_pitcher_name === 'Tyler Glasnow', 'Merrill (SD) correctly shows LAD starter Glasnow as opposing pitcher');

// Test rollup math: Glasnow's real line was 5.0 IP, 2 ER, 3 K, 4 BB, 2 H
// Hand-calculated: ERA = (2/5)*9 = 3.60, WHIP = (4+2)/5 = 1.20, K/9 = (3/5)*9 = 5.40
recomputePitcherRollups();
const glasnowRollup = db.prepare(`SELECT * FROM mlb_pitcher_rollup WHERE player_name = 'Tyler Glasnow' AND window_type = 'season'`).get();
check(Math.abs(glasnowRollup.era - 3.60) < 0.01, `Glasnow ERA computed correctly: expected 3.60, got ${glasnowRollup.era}`);
check(Math.abs(glasnowRollup.whip - 1.20) < 0.01, `Glasnow WHIP computed correctly: expected 1.20, got ${glasnowRollup.whip}`);
check(Math.abs(glasnowRollup.k_per_9 - 5.40) < 0.01, `Glasnow K/9 computed correctly: expected 5.40, got ${glasnowRollup.k_per_9}`);

// Team batting rollup: LAD had 3 batters, 2+5+4=11 AB, 0+2+2=4 hits, 1+0+0=1 K
// team_avg = 4/11 = 0.364, k_rate = 1/11 = 0.091
recomputeTeamBattingRollups();
const ladRollup = db.prepare(`SELECT * FROM mlb_team_batting_rollup WHERE team = 'LAD' AND window_type = 'season'`).get();
check(Math.abs(ladRollup.team_avg - 0.364) < 0.001, `LAD team batting avg computed correctly: expected 0.364, got ${ladRollup.team_avg}`);
check(Math.abs(ladRollup.k_rate - 0.091) < 0.001, `LAD team K-rate computed correctly: expected 0.091, got ${ladRollup.k_rate}`);

// Cleanup
db.prepare(`DELETE FROM mlb_batter_game_stats WHERE game_pk = '745444-test'`).run();
db.prepare(`DELETE FROM mlb_pitcher_game_stats WHERE game_pk = '745444-test'`).run();
db.prepare(`DELETE FROM mlb_pitcher_rollup WHERE player_id IN ('607192','623465','673513')`).run();
db.prepare(`DELETE FROM mlb_team_batting_rollup WHERE team IN ('LAD','SD')`).run();
console.log('\nCleaned up test fixtures.');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
