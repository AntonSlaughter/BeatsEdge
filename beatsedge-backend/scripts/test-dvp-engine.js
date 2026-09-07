// Real test: insert synthetic box scores with KNOWN, hand-calculated
// averages, run the actual aggregation engine, and assert the output
// matches what a human doing the math by hand would get. Cleans up
// after itself so it doesn't pollute real seeded data.

const db = require('../lib/db');
const { recomputeDefenseByPosition, getDefenseByPosition } = require('../lib/dvpEngine');

const SPORT = 'test_nba'; // isolated namespace so this never touches real 'nba' rows

function insertGame(opponent, position, points, rebounds, assists, daysAgo) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const gameId = `TEST-${opponent}-${position}-${daysAgo}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO box_scores (sport, game_date, game_id, player_name, position, team, opponent, points, rebounds, assists, minutes, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test-fixture')
  `).run(SPORT, date.toISOString().slice(0, 10), gameId, `Fixture Player ${Math.random()}`, position, 'OPP', opponent, points, rebounds, assists, 30);
}

console.log('=== DvP Engine Test ===\n');

// --- Fixture: Team "SAC" allows to PG across 3 games: 20, 30, 40 points ---
// Hand-calculated season average: (20+30+40)/3 = 30.0
insertGame('SAC', 'PG', 20, 5, 8, 10);
insertGame('SAC', 'PG', 30, 6, 7, 5);
insertGame('SAC', 'PG', 40, 4, 9, 1);

// --- Fixture: Team "BOS" allows to PG across 3 games: 10, 12, 14 points ---
// Hand-calculated season average: (10+12+14)/3 = 12.0
// BOS should rank #1 (toughest) since 12.0 < 30.0
insertGame('BOS', 'PG', 10, 3, 4, 10);
insertGame('BOS', 'PG', 12, 4, 5, 5);
insertGame('BOS', 'PG', 14, 5, 6, 1);

// --- Fixture: last10 window test — 15 games for SAC vs SG, only last 10 should count ---
// Games 1-5 (oldest, days 15-11 ago): 50 points each (should be EXCLUDED from last10)
// Games 6-15 (most recent, days 10-1 ago): 10 points each (should be INCLUDED)
// Expected last10 avg = 10.0, season avg = (5*50 + 10*10) / 15 = (250+100)/15 = 23.33
for (let i = 0; i < 5; i++) insertGame('SAC', 'SG', 50, 5, 5, 15 - i);
for (let i = 0; i < 10; i++) insertGame('SAC', 'SG', 10, 5, 5, 10 - i);

const insertedCount = db.prepare(`SELECT COUNT(*) as c FROM box_scores WHERE sport = ?`).get(SPORT).c;
console.log(`Inserted ${insertedCount} synthetic box score rows (expected 21)`);

console.log('\nRunning recomputeDefenseByPosition...');
const summary = recomputeDefenseByPosition(SPORT);
console.log('Recompute summary (rows written per position:window):', JSON.stringify(summary, null, 2));

// --- Assertions ---
let pass = 0, fail = 0;
function assertEqual(actual, expected, label) {
  const ok = Math.abs(actual - expected) < 0.01;
  console.log(`${ok ? '✓' : '✗'} ${label}: expected ${expected}, got ${actual}`);
  if (ok) pass++; else fail++;
}

const sacSeason = getDefenseByPosition(SPORT, 'SAC', 'season');
const bosSeason = getDefenseByPosition(SPORT, 'BOS', 'season');
const sacLast10 = getDefenseByPosition(SPORT, 'SAC', 'last10');

console.log('\n--- Season averages (PG) ---');
assertEqual(sacSeason.PG.pointsAllowed, 30.0, 'SAC allows to PG (season avg)');
assertEqual(bosSeason.PG.pointsAllowed, 12.0, 'BOS allows to PG (season avg)');

console.log('\n--- Ranking (1 = toughest defense = fewest allowed) ---');
assertEqual(bosSeason.PG.rank, 1, 'BOS PG rank (should be #1, tougher than SAC)');
assertEqual(sacSeason.PG.rank, 2, 'SAC PG rank (should be #2, allows more than BOS)');

console.log('\n--- Rolling window correctness (last10 vs season) ---');
assertEqual(sacLast10.SG.pointsAllowed, 10.0, 'SAC allows to SG (last10 — should exclude the 5 old 50-pt games)');
assertEqual(sacSeason.SG.pointsAllowed, 23.3, 'SAC allows to SG (season — should include all 15 games, rounded to 1 decimal)');
assertEqual(sacLast10.SG.gamesSampled, 10, 'SAC SG last10 games_sampled count');
assertEqual(sacSeason.SG.gamesSampled, 15, 'SAC SG season games_sampled count');

// --- Cleanup: remove test fixtures so they never leak into real data ---
db.prepare(`DELETE FROM box_scores WHERE sport = ?`).run(SPORT);
db.prepare(`DELETE FROM defense_by_position WHERE sport = ?`).run(SPORT);
console.log('\nCleaned up test fixtures.');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
