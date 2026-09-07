const Module = require('module');
const path = require('path');

const proxyPath = path.join(__dirname, '..', 'lib', 'mlbProxy.js');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (this.filename && this.filename.endsWith('mlbNightlyUpdate.js') && id === '../lib/mlbProxy') {
    return {
      fetchSchedule: async () => ({
        dates: [{
          games: [
            { gamePk: 900001, status: { abstractGameState: 'Final' } },
            { gamePk: 900002, status: { abstractGameState: 'Postponed' } }, // should be SKIPPED
            { gamePk: 900003, status: { abstractGameState: 'Final' } }
          ]
        }]
      }),
      fetchBoxscore: async (gamePk) => ({
        teams: {
          away: {
            team: { abbreviation: 'AWY' }, pitchers: [111],
            players: { 'ID111': { person: { id: 111, fullName: 'Test Pitcher' }, stats: { batting: {}, pitching: { inningsPitched: '6.0', strikeOuts: 7, baseOnBalls: 2, hits: 4, earnedRuns: 3, homeRuns: 1 } } } }
          },
          home: {
            team: { abbreviation: 'HOM' }, pitchers: [222],
            players: { 'ID333': { person: { id: 333, fullName: 'Test Batter' }, stats: { batting: { atBats: 4, hits: 2, totalBases: 3, runs: 1, rbi: 1, homeRuns: 0, baseOnBalls: 0, strikeOuts: 1 }, pitching: {} } } }
          }
        }
      })
    };
  }
  return originalRequire.apply(this, arguments);
};

const db = require('../lib/mlbDb');
const { runMlbNightlyUpdate } = require('../cron/mlbNightlyUpdate');

async function main() {
  console.log('=== MLB Nightly Cron Test ===\n');
  await runMlbNightlyUpdate();

  const pitcherCount = db.prepare(`SELECT COUNT(*) as c FROM mlb_pitcher_game_stats WHERE player_name = 'Test Pitcher'`).get().c;
  const batterCount = db.prepare(`SELECT COUNT(*) as c FROM mlb_batter_game_stats WHERE player_name = 'Test Batter'`).get().c;

  let pass = 0, fail = 0;
  function check(cond, label) { console.log(`${cond ? '✓' : '✗'} ${label}`); cond ? pass++ : fail++; }

  // 2 Final games processed (900001, 900003), each contributes 1 pitcher + 1 batter row = 2 of each
  check(pitcherCount === 2, `Postponed game correctly skipped, only Final games processed (pitcher rows: ${pitcherCount}, expected 2)`);
  check(batterCount === 2, `Batter rows from Final games only: ${batterCount}, expected 2`);

  db.prepare(`DELETE FROM mlb_pitcher_game_stats WHERE player_name = 'Test Pitcher'`).run();
  db.prepare(`DELETE FROM mlb_batter_game_stats WHERE player_name = 'Test Batter'`).run();
  db.prepare(`DELETE FROM mlb_pitcher_rollup WHERE player_id = '111'`).run();
  db.prepare(`DELETE FROM mlb_team_batting_rollup WHERE team IN ('AWY','HOM')`).run();
  console.log('\nCleaned up.');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main();
