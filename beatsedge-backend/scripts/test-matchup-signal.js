// Real test of lib/nflMatchupSignal.js against a throwaway, hand-built
// SQLite fixture DB (same nfl_player_game_stats schema) -- never touches
// the real data/beatsedge.db. Mirrors the fixture-build/assert/cleanup
// style already used by scripts/test-game-environment.js. Covers the
// Phase 6 Step 14 required cases relevant to this module.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { computeDefenseAllowedAsOf, bulkDefenseAllowedHistory } = require('../lib/nflMatchupSignal');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}

const fixturePath = path.join(os.tmpdir(), `matchup-test-${Date.now()}.db`);
const db = new Database(fixturePath);
db.exec(`
  CREATE TABLE nfl_player_game_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, season INTEGER, week INTEGER, season_type TEXT, game_date TEXT,
    player_id TEXT, player_name TEXT, position TEXT, team TEXT, opponent TEXT,
    receiving_yards REAL DEFAULT 0, targets REAL DEFAULT 0, receptions REAL DEFAULT 0, rushing_yards REAL DEFAULT 0
  )
`);
const insert = db.prepare(`
  INSERT INTO nfl_player_game_stats (season, week, season_type, player_id, player_name, position, team, opponent, receiving_yards, targets, receptions, rushing_yards)
  VALUES (@season,@week,'REG',@player_id,@player_name,@position,@team,@opponent,@receiving_yards,@targets,@receptions,@rushing_yards)
`);

console.log('=== NFL matchup (stat-specific defense-allowed) signal test ===\n');

// --- DAL defense allows real, elevated receiving production to WRs over weeks 1-4 ---
[1, 2, 3, 4].forEach(week => {
  insert.run({ season: 2024, week, player_id: 'wr1', player_name: 'WR One', position: 'WR', team: 'PHI', opponent: 'DAL', receiving_yards: 90, targets: 9, receptions: 6, rushing_yards: 0 });
  insert.run({ season: 2024, week, player_id: 'wr2', player_name: 'WR Two', position: 'WR', team: 'PHI', opponent: 'DAL', receiving_yards: 40, targets: 5, receptions: 3, rushing_yards: 0 });
});
// --- SF defense is stingy vs WRs ---
[1, 2, 3, 4].forEach(week => {
  insert.run({ season: 2024, week, player_id: 'wr3', player_name: 'WR Three', position: 'WR', team: 'SEA', opponent: 'SF', receiving_yards: 30, targets: 4, receptions: 2, rushing_yards: 0 });
});
// --- Bye week for DAL in week 5 (no rows at all) -- must not be counted as "allowed 0" ---
// (simply no insert for DAL week 5)
// --- A future week (week 99) that must never leak into an earlier lookup ---
insert.run({ season: 2024, week: 99, player_id: 'wr1', player_name: 'WR One', position: 'WR', team: 'PHI', opponent: 'DAL', receiving_yards: 999, targets: 99, receptions: 9, rushing_yards: 0 });
// --- A different season (2025) row for DAL, must not leak into a 2024 lookup ---
insert.run({ season: 2025, week: 1, player_id: 'wr4', player_name: 'WR Four', position: 'WR', team: 'NYG', opponent: 'DAL', receiving_yards: 500, targets: 50, receptions: 5, rushing_yards: 0 });
// --- Cross-season: DAL week 1 of season 2025 should be real, distinct data from 2024 ---
insert.run({ season: 2025, week: 1, player_id: 'wr5', player_name: 'WR Five', position: 'WR', team: 'WAS', opponent: 'DAL', receiving_yards: 60, targets: 7, receptions: 4, rushing_yards: 0 });

// 1. Real matchup computation -- DAL allows real elevated receiving yards to WRs
const dalWindow = computeDefenseAllowedAsOf(db, 'DAL', 'WR', 'receivingYards', 2024, 5, { games: 5 });
ok(dalWindow.sufficient && dalWindow.avgAllowed === 130, '1. DAL real trailing receiving-yards-allowed to WR (90+40 per week x4 weeks)', dalWindow);

// 2. Stingy defense computed correctly (SF)
const sfWindow = computeDefenseAllowedAsOf(db, 'SF', 'WR', 'receivingYards', 2024, 5, { games: 5 });
ok(sfWindow.sufficient && sfWindow.avgAllowed === 30, '2. SF real trailing receiving-yards-allowed to WR (30/week)', sfWindow);

// 3. Insufficient matchup history (unknown/thin defense)
const unknownWindow = computeDefenseAllowedAsOf(db, 'ZZZ', 'WR', 'receivingYards', 2024, 5, { games: 5, minGames: 2 });
ok(unknownWindow.sufficient === false && unknownWindow.avgAllowed === null, '3. unknown defense -> insufficient, never fabricated', unknownWindow);

// 4. Bye week (no rows) does not get counted as "allowed 0" -- confirmed by
// DAL's real average staying at 130 (not diluted by a phantom 0-yard week).
ok(dalWindow.games === 4, '4. bye week never counted as a real 0-allowed game (DAL games=4, not 5)', dalWindow.games);

// 5. Future week (99) never leaks into an earlier (season, week) lookup
const dalNoLeak = computeDefenseAllowedAsOf(db, 'DAL', 'WR', 'receivingYards', 2024, 5, { games: 20 });
ok(!JSON.stringify(dalNoLeak).includes('999') && dalNoLeak.avgAllowed === 130, '5. future week 99 (999 yards) never leaks into an earlier lookup', dalNoLeak);

// 6. Cross-season boundary -- a 2024 lookup must never include 2025 rows
const dalCrossSeason = computeDefenseAllowedAsOf(db, 'DAL', 'WR', 'receivingYards', 2024, 5, { games: 20 });
ok(!JSON.stringify(dalCrossSeason).includes('500'), '6. season-2025 row (500 yards) never leaks into a season-2024 lookup', dalCrossSeason);

// 7. A later season's own lookup correctly sees its own real week-1 data as
// the MOST RECENT entry -- SUM(receiving_yards) for that real team-week
// correctly combines BOTH real players who faced DAL that week (wr4: 500,
// wr5: 60 -- two separate fixture rows for the same real opponent+week,
// correctly aggregated by GROUP BY season, week, not double-counted as
// two separate games).
const dalSeason2025Narrow = computeDefenseAllowedAsOf(db, 'DAL', 'WR', 'receivingYards', 2025, 2, { games: 1, minGames: 1 });
ok(dalSeason2025Narrow.sufficient && dalSeason2025Narrow.games === 1 && dalSeason2025Narrow.avgAllowed === 560, '7. season-2025 lookup sees its own real week-1 data as one team-week, correctly summed across both real players (500+60)', dalSeason2025Narrow);

// 8. player/opponent identity -- position filter correctly excludes a
// different position at the same defense (no RB rows inserted for DAL, so
// a WR-scoped lookup must not accidentally pick up unrelated rows)
const dalRbWindow = computeDefenseAllowedAsOf(db, 'DAL', 'RB', 'rushingYards', 2024, 5, { games: 5, minGames: 2 });
ok(dalRbWindow.sufficient === false, '8. position-specific lookup (RB) correctly finds no data when only WR rows exist for this defense', dalRbWindow);

// 9. missing stat key -> safe, never crashes, never fabricated
const badStat = computeDefenseAllowedAsOf(db, 'DAL', 'WR', 'notARealStat', 2024, 5, {});
ok(badStat.sufficient === false && badStat.avgAllowed === null, '9. unknown statKey -> insufficient, never crashes or guesses', badStat);

// 10. deterministic output
const detA = computeDefenseAllowedAsOf(db, 'DAL', 'WR', 'receivingYards', 2024, 5, { games: 5 });
const detB = computeDefenseAllowedAsOf(db, 'DAL', 'WR', 'receivingYards', 2024, 5, { games: 5 });
ok(JSON.stringify(detA) === JSON.stringify(detB), '10. computeDefenseAllowedAsOf is deterministic', { detA, detB });

// 11. source data not mutated
const rowCountBefore = db.prepare(`SELECT COUNT(*) c FROM nfl_player_game_stats`).get().c;
computeDefenseAllowedAsOf(db, 'DAL', 'WR', 'receivingYards', 2024, 5, { games: 5 });
const rowCountAfter = db.prepare(`SELECT COUNT(*) c FROM nfl_player_game_stats`).get().c;
ok(rowCountBefore === rowCountAfter, '11. source data (row count) unchanged after running the signal computation', { rowCountBefore, rowCountAfter });

// 12. bulk history -- real, grouped, no duplicate/missing team-weeks
const bulk = bulkDefenseAllowedHistory(db, ['DAL', 'SF'], ['WR']);
ok(bulk['DAL|WR'] && bulk['DAL|WR'].length === 6, '12a. bulk history returns real per-team-week rows for DAL|WR (4 weeks 2024 + 1 week 2025 + week 99 = 6, bye week 5 correctly absent)', bulk['DAL|WR'] && bulk['DAL|WR'].length);
ok(bulk['SF|WR'] && bulk['SF|WR'].length === 4, '12b. bulk history returns real per-team-week rows for SF|WR', bulk['SF|WR'] && bulk['SF|WR'].length);
ok(!bulk['ZZZ|WR'], '12c. bulk history returns nothing for an unknown team', bulk['ZZZ|WR']);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
db.close();
fs.unlinkSync(fixturePath);
if (fail > 0) process.exit(1);
