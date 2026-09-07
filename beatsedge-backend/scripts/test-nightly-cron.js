// Tests the box-score parsing/insertion logic in cron/nightlyUpdate.js
// against mocked stats.nba.com response shapes (matching their real,
// documented resultSets format), without touching the real network.

const Module = require('module');
const path = require('path');

// Mock lib/statsProxy before nightlyUpdate.js requires it
const statsProxyPath = path.join(__dirname, '..', 'lib', 'statsProxy.js');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (this.filename && this.filename.endsWith('nightlyUpdate.js') && id === '../lib/statsProxy') {
    return {
      fetchScoreboardForDate: async () => ({
        resultSets: [{
          name: 'GameHeader',
          headers: ['GAME_ID'],
          rowSet: [['0022500001']]
        }]
      }),
      fetchBoxScoreTraditional: async () => ({
        resultSets: [{
          name: 'PlayerStats',
          headers: ['TEAM_ABBREVIATION', 'PLAYER_NAME', 'START_POSITION', 'PTS', 'REB', 'AST', 'MIN'],
          rowSet: [
            ['LAL', 'Starter Guard', 'G', 20, 4, 8, 32],   // coarse 'G' -> should be SKIPPED (too coarse)
            ['LAL', 'Starter Center', 'C', 12, 10, 1, 28], // 'C' -> should be KEPT
            ['LAL', 'Bench Player', '', 8, 2, 1, 15],      // bench, blank position -> SKIPPED
            ['BOS', 'Opp Center', 'C', 18, 9, 2, 30]       // 'C' -> should be KEPT, opponent = LAL
          ]
        }]
      })
    };
  }
  return originalRequire.apply(this, arguments);
};

const db = require('../lib/db');
const { pullBoxScoresForDate } = require('../cron/nightlyUpdate');

async function main() {
  console.log('=== Nightly Cron Parsing Test ===\n');

  const { gamesFound, rowsInserted } = await pullBoxScoresForDate('nba', '2026-01-15');

  console.log(`Games found: ${gamesFound} (expected 1)`);
  console.log(`Rows inserted: ${rowsInserted} (expected 2 — only the two 'C' rows, coarse 'G' and blank bench skipped)`);

  const rows = db.prepare(`SELECT player_name, position, team, opponent, points FROM box_scores WHERE source = 'nba-stats-nightly'`).all();
  console.log('\nActual inserted rows:', JSON.stringify(rows, null, 2));

  let pass = 0, fail = 0;
  const check = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); cond ? pass++ : fail++; };

  check(gamesFound === 1, 'Found 1 game');
  check(rowsInserted === 2, 'Inserted exactly 2 rows (skipped coarse G and blank bench)');
  check(rows.some(r => r.player_name === 'Starter Center' && r.opponent === 'BOS'), 'LAL center correctly credited opponent = BOS');
  check(rows.some(r => r.player_name === 'Opp Center' && r.opponent === 'LAL'), 'BOS center correctly credited opponent = LAL');
  check(!rows.some(r => r.player_name === 'Starter Guard'), 'Coarse "G" position correctly excluded (not guessed)');
  check(!rows.some(r => r.player_name === 'Bench Player'), 'Blank bench position correctly excluded');

  db.prepare(`DELETE FROM box_scores WHERE source = 'nba-stats-nightly'`).run();
  console.log('\nCleaned up test rows.');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main();
