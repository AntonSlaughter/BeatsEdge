const db = require('../lib/nflDb');
const { recomputeNflDefenseByPosition, getNflDefenseByPosition } = require('../lib/nflDvpEngine');

// Use fake team codes so this never touches real ingested data
function insertGame(opponent, position, receivingYards, receptions, seasonWeekOffset) {
  db.prepare(`
    INSERT INTO nfl_player_game_stats
      (season, week, season_type, player_id, player_name, position, team, opponent,
       passing_yards, passing_tds, interceptions, rushing_yards, rushing_tds,
       receptions, targets, receiving_yards, receiving_tds, fantasy_points_ppr, source)
    VALUES (2024, ?, 'REG', ?, ?, ?, 'OPP', ?, 0, 0, 0, 0, 0, ?, ?, ?, 0, ?, 'test-fixture')
  `).run(18 - seasonWeekOffset, `TESTID-${Math.random()}`, `Fixture ${Math.random()}`, position, opponent,
         receptions, receptions + 2, receivingYards, receivingYards * 0.1);
}

console.log('=== NFL DvP Engine Test ===\n');

// Team "ZZZ" allows to WR across 3 games: 60, 80, 100 receiving yards -> avg 80.0
insertGame('ZZZ', 'WR', 60, 4, 1);
insertGame('ZZZ', 'WR', 80, 5, 2);
insertGame('ZZZ', 'WR', 100, 7, 3);

// Team "YYY" allows to WR across 3 games: 30, 40, 50 -> avg 40.0 (tougher defense)
insertGame('YYY', 'WR', 30, 2, 1);
insertGame('YYY', 'WR', 40, 3, 2);
insertGame('YYY', 'WR', 50, 4, 3);

const inserted = db.prepare(`SELECT COUNT(*) as c FROM nfl_player_game_stats WHERE source='test-fixture'`).get().c;
console.log(`Inserted ${inserted} fixture rows (expected 6)`);

recomputeNflDefenseByPosition();

const zzz = getNflDefenseByPosition('ZZZ', 'season');
const yyy = getNflDefenseByPosition('YYY', 'season');

let pass = 0, fail = 0;
function check(actual, expected, label) {
  const ok = Math.abs(actual - expected) < 0.01;
  console.log(`${ok ? '✓' : '✗'} ${label}: expected ${expected}, got ${actual}`);
  ok ? pass++ : fail++;
}

check(zzz.WR.receivingYardsAllowed, 80.0, 'ZZZ allows to WR (avg receiving yards)');
check(yyy.WR.receivingYardsAllowed, 40.0, 'YYY allows to WR (avg receiving yards)');
check(yyy.WR.rank, 1, 'YYY WR rank (should be #1 overall — its 40yd avg is tougher than every real team too)');
check(yyy.WR.rank < zzz.WR.rank ? 1 : 0, 1, 'YYY ranks ahead of ZZZ (relative ordering correct, regardless of real teams mixed in)');
check(zzz.WR.gamesSampled, 3, 'ZZZ games sampled');

// Cleanup
db.prepare(`DELETE FROM nfl_player_game_stats WHERE source='test-fixture'`).run();
db.prepare(`DELETE FROM nfl_defense_by_position WHERE team IN ('ZZZ','YYY')`).run();
console.log('\nCleaned up test fixtures.');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
