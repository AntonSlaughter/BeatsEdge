const Module = require('module');
const path = require('path');

const proxyPath = path.join(__dirname, '..', 'lib', 'nhlProxy.js');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (this.filename && this.filename.endsWith('nhlNightlyUpdate.js') && id === '../lib/nhlProxy') {
    return {
      fetchSchedule: async () => ({
        gameWeek: [{
          games: [
            { id: 800001, gameState: 'OFF' },
            { id: 800002, gameState: 'FUT' }, // should be SKIPPED — not played yet
            { id: 800003, gameState: 'FINAL' }
          ]
        }]
      }),
      fetchBoxscore: async () => ({
        awayTeam: { abbrev: 'AWY' },
        homeTeam: { abbrev: 'HOM' },
        playerByGameStats: {
          awayTeam: {
            forwards: [{ playerId: 1, name: { default: 'Test Forward' }, position: 'C', goals: 1, assists: 1, points: 2, sog: 3, hits: 1, blockedShots: 0 }],
            defense: [],
            goalies: []
          },
          homeTeam: {
            forwards: [],
            defense: [{ playerId: 2, name: { default: 'Test Defenseman' }, position: 'D', goals: 0, assists: 1, points: 1, sog: 1, hits: 2, blockedShots: 3 }],
            goalies: [{ playerId: 3, name: { default: 'Test Goalie' }, shotsAgainst: 30, saves: 28, goalsAgainst: 2, savePctg: 0.933, starter: true }]
          }
        }
      })
    };
  }
  return originalRequire.apply(this, arguments);
};

const db = require('../lib/nhlDb');
const { runNhlNightlyUpdate } = require('../cron/nhlNightlyUpdate');

async function main() {
  console.log('=== NHL Nightly Cron Test ===\n');
  await runNhlNightlyUpdate();

  const skaterCount = db.prepare(`SELECT COUNT(*) as c FROM nhl_skater_game_stats WHERE player_name IN ('Test Forward', 'Test Defenseman')`).get().c;
  const goalieCount = db.prepare(`SELECT COUNT(*) as c FROM nhl_goalie_game_stats WHERE player_name = 'Test Goalie'`).get().c;

  let pass = 0, fail = 0;
  function check(cond, label) { console.log(`${cond ? '✓' : '✗'} ${label}`); cond ? pass++ : fail++; }

  // 2 games processed (800001 OFF, 800003 FINAL), each contributes 2 skaters = 4 total
  check(skaterCount === 4, `FUT game correctly skipped, only OFF/FINAL processed (skater rows: ${skaterCount}, expected 4)`);
  check(goalieCount === 2, `Goalie rows from processed games only: ${goalieCount}, expected 2`);

  db.prepare(`DELETE FROM nhl_skater_game_stats WHERE player_name IN ('Test Forward', 'Test Defenseman')`).run();
  db.prepare(`DELETE FROM nhl_goalie_game_stats WHERE player_name = 'Test Goalie'`).run();
  db.prepare(`DELETE FROM nhl_defense_by_position WHERE team IN ('AWY','HOM')`).run();
  db.prepare(`DELETE FROM nhl_team_shooting_rollup WHERE team IN ('AWY','HOM')`).run();
  console.log('\nCleaned up.');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main();
