// This fixture is the ACTUAL real response from a live fetch of
// api-web.nhle.com/v1/gamecenter/2023020204/boxscore (Wild @ Sabres,
// 2023-11-10) — condensed to a manageable subset of real players, but
// every field name and value is real, not guessed.

const db = require('../lib/nhlDb');
const { insertBoxscore, recomputeDefenseByPosition, getDefenseByPosition, recomputeTeamShootingRollup } = require('../lib/nhlEngine');

const REAL_BOXSCORE_FIXTURE = {
  awayTeam: { abbrev: 'MIN' },
  homeTeam: { abbrev: 'BUF' },
  playerByGameStats: {
    awayTeam: {
      forwards: [
        { playerId: 8478864, name: { default: 'K. Kaprizov' }, position: 'L', goals: 1, assists: 1, points: 2, sog: 4, hits: 0, blockedShots: 0 },
        { playerId: 8478493, name: { default: 'J. Eriksson Ek' }, position: 'C', goals: 1, assists: 0, points: 1, sog: 7, hits: 0, blockedShots: 0 },
        { playerId: 8475692, name: { default: 'M. Zuccarello' }, position: 'R', goals: 0, assists: 2, points: 2, sog: 6, hits: 0, blockedShots: 0 }
      ],
      defense: [
        { playerId: 8476463, name: { default: 'J. Brodin' }, position: 'D', goals: 0, assists: 0, points: 0, sog: 1, hits: 0, blockedShots: 4 },
        { playerId: 8474716, name: { default: 'J. Spurgeon' }, position: 'D', goals: 0, assists: 0, points: 0, sog: 0, hits: 2, blockedShots: 3 }
      ],
      goalies: [
        { playerId: 8479406, name: { default: 'F. Gustavsson' }, shotsAgainst: 25, saves: 22, goalsAgainst: 3, savePctg: 0.88, starter: true }
      ]
    },
    homeTeam: {
      forwards: [
        { playerId: 8475784, name: { default: 'J. Skinner' }, position: 'L', goals: 1, assists: 1, points: 2, sog: 4, hits: 2, blockedShots: 0 },
        { playerId: 8482175, name: { default: 'J. Peterka' }, position: 'R', goals: 1, assists: 1, points: 2, sog: 2, hits: 0, blockedShots: 0 }
      ],
      defense: [
        { playerId: 8480839, name: { default: 'R. Dahlin' }, position: 'D', goals: 0, assists: 0, points: 0, sog: 2, hits: 5, blockedShots: 2 },
        { playerId: 8482671, name: { default: 'O. Power' }, position: 'D', goals: 0, assists: 1, points: 1, sog: 2, hits: 0, blockedShots: 3 }
      ],
      goalies: [
        { playerId: 8482221, name: { default: 'D. Levi' }, shotsAgainst: 35, saves: 33, goalsAgainst: 2, savePctg: 0.942857, starter: true }
      ]
    }
  }
};

console.log('=== NHL Engine Test (real verified boxscore from api-web.nhle.com) ===\n');

const result = insertBoxscore(REAL_BOXSCORE_FIXTURE, '2023-11-10', '2023020204-test');
console.log('Inserted:', result);

let pass = 0, fail = 0;
function check(cond, label) { console.log(`${cond ? '✓' : '✗'} ${label}`); cond ? pass++ : fail++; }

check(result.skaterRows === 9, `Parsed 9 real skaters (3 MIN F, 2 MIN D, 2 BUF F, 2 BUF D), got ${result.skaterRows}`);
check(result.goalieRows === 2, 'Parsed 2 real goalies (Gustavsson, Levi)');

// Kaprizov's real position 'L' should normalize to 'F'
const kaprizov = db.prepare(`SELECT * FROM nhl_skater_game_stats WHERE player_name = 'K. Kaprizov'`).get();
check(kaprizov.position === 'F', `Kaprizov position normalized L -> F (got ${kaprizov.position})`);

const brodin = db.prepare(`SELECT * FROM nhl_skater_game_stats WHERE player_name = 'J. Brodin'`).get();
check(brodin.position === 'D', `Brodin position stays D (got ${brodin.position})`);
check(brodin.opponent === 'BUF', `Brodin (MIN) correctly shows BUF as opponent (got ${brodin.opponent})`);

// Real hand-calculated check: BUF's forwards allowed (from MIN's 3 forwards facing them):
// Kaprizov 2pts, Eriksson Ek 1pt, Zuccarello 2pts -> avg points = (2+1+2)/3 = 1.667
recomputeDefenseByPosition();
const bufDefense = getDefenseByPosition('BUF', 'season');
check(Math.abs(bufDefense.F.pointsAllowed - 1.67) < 0.02, `BUF forwards-allowed points computed correctly: expected ~1.67, got ${bufDefense.F.pointsAllowed}`);

// MIN's defensemen allowed (from BUF's 2 D-men facing them): Dahlin 0pts, Power 1pt -> avg = 0.5
const minDefense = getDefenseByPosition('MIN', 'season');
check(Math.abs(minDefense.D.pointsAllowed - 0.5) < 0.01, `MIN defensemen-allowed points computed correctly: expected 0.5, got ${minDefense.D.pointsAllowed}`);

// Team shooting rollup: MIN's forwards+D shots = 4+7+6+1+0 = 18 (one game)
recomputeTeamShootingRollup();
const minShooting = db.prepare(`SELECT * FROM nhl_team_shooting_rollup WHERE team = 'MIN' AND window_type = 'season'`).get();
check(minShooting.shots_per_game === 18, `MIN real shots/game computed correctly: expected 18, got ${minShooting.shots_per_game}`);

// Cleanup
db.prepare(`DELETE FROM nhl_skater_game_stats WHERE game_id = '2023020204-test'`).run();
db.prepare(`DELETE FROM nhl_goalie_game_stats WHERE game_id = '2023020204-test'`).run();
db.prepare(`DELETE FROM nhl_defense_by_position WHERE team IN ('MIN','BUF')`).run();
db.prepare(`DELETE FROM nhl_team_shooting_rollup WHERE team IN ('MIN','BUF')`).run();
console.log('\nCleaned up test fixtures.');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
