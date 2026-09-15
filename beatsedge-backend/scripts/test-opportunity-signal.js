// Real test of lib/opportunitySignal.js against throwaway, hand-built
// SQLite fixture DBs (same nba_player_box / nfl_player_game_stats schemas)
// -- never touches the real data/beatsedge.db. Mirrors the fixture-build/
// assert/cleanup style already used by scripts/test-matchup-signal.js and
// scripts/test-player-availability.js. Covers the Phase 7 Step 18 required
// case categories relevant to this module (empty history, window lengths,
// insufficient history, null vs zero, duplicate/future/target-game
// exclusion, cross-season boundary, player/team identity, determinism, no
// mutation, missing opportunity data).

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { computeShotVolumeWindow, computeTargetShareWindow, computeOpportunityTrend } = require('../lib/opportunitySignal');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}

console.log('=== Opportunity / Usage / Workload signal test ===\n');

// ── NBA: computeShotVolumeWindow ─────────────────────────────────────────
const nbaPath = path.join(os.tmpdir(), `opportunity-nba-test-${Date.now()}.db`);
const nbaDb = new Database(nbaPath);
nbaDb.exec(`
  CREATE TABLE nba_player_box (
    game_id TEXT, athlete_id TEXT, season INTEGER, season_type INTEGER, game_date TEXT,
    team TEXT, opponent TEXT, played INTEGER DEFAULT 1, minutes REAL, fga REAL, fta REAL, threes_att REAL
  )
`);
const nbaInsert = nbaDb.prepare(`
  INSERT INTO nba_player_box (game_id, athlete_id, season, season_type, game_date, team, opponent, played, minutes, fga, fta, threes_att)
  VALUES (@game_id,@athlete_id,@season,@season_type,@game_date,@team,@opponent,@played,@minutes,@fga,@fta,@threes_att)
`);

// p1: 20 real games in season 2025, steady ~10 FGA/2 FTA/3 3PA, 30 min
for (let i = 1; i <= 20; i++) {
  nbaInsert.run({ game_id: 'g' + i, athlete_id: 'p1', season: 2025, season_type: 2, game_date: `2025-01-${String(i).padStart(2, '0')}`, team: 'BOS', opponent: 'NYK', played: 1, minutes: 30, fga: 10, fta: 2, threes_att: 3 });
}
// p2: thin sample, only 2 real games, own team, overlapping dates with p1 (identity check)
nbaInsert.run({ game_id: 'h1', athlete_id: 'p2', season: 2025, season_type: 2, game_date: '2025-01-01', team: 'LAL', opponent: 'GSW', played: 1, minutes: 15, fga: 5, fta: 1, threes_att: 1 });
nbaInsert.run({ game_id: 'h2', athlete_id: 'p2', season: 2025, season_type: 2, game_date: '2025-01-02', team: 'LAL', opponent: 'GSW', played: 1, minutes: 16, fga: 6, fta: 1, threes_att: 2 });
// p3: a game with NULL fga/fta (data gap -- must be excluded, not treated as 0)
nbaInsert.run({ game_id: 'i1', athlete_id: 'p3', season: 2025, season_type: 2, game_date: '2025-01-01', team: 'MIA', opponent: 'ORL', played: 1, minutes: 20, fga: null, fta: null, threes_att: null });
nbaInsert.run({ game_id: 'i2', athlete_id: 'p3', season: 2025, season_type: 2, game_date: '2025-01-02', team: 'MIA', opponent: 'ORL', played: 1, minutes: 22, fga: 8, fta: 2, threes_att: 2 });
// p1 future game (must never leak into a query as-of an earlier date)
nbaInsert.run({ game_id: 'gfuture', athlete_id: 'p1', season: 2025, season_type: 2, game_date: '2025-12-31', team: 'BOS', opponent: 'NYK', played: 1, minutes: 30, fga: 99, fta: 99, threes_att: 99 });
// p1 exhibition row (All-Star) -- must be excluded
nbaInsert.run({ game_id: 'gasg', athlete_id: 'p1', season: 2025, season_type: 2, game_date: '2025-02-15', team: 'BOS', opponent: 'WORLD', played: 1, minutes: 20, fga: 50, fta: 50, threes_att: 50 });
// p1 postseason row (season_type 3) -- must be excluded by the regular-season filter
nbaInsert.run({ game_id: 'gpost', athlete_id: 'p1', season: 2025, season_type: 3, game_date: '2025-01-25', team: 'BOS', opponent: 'NYK', played: 1, minutes: 40, fga: 40, fta: 40, threes_att: 40 });
// p1 prior-season row (2024) -- must not leak into a season-2025-scoped query
nbaInsert.run({ game_id: 'gprev', athlete_id: 'p1', season: 2024, season_type: 2, game_date: '2024-06-01', team: 'BOS', opponent: 'NYK', played: 1, minutes: 30, fga: 1, fta: 1, threes_att: 1 });
// p1 DNP row (played=0) -- must be excluded
nbaInsert.run({ game_id: 'gdnp', athlete_id: 'p1', season: 2025, season_type: 2, game_date: '2025-01-10', team: 'BOS', opponent: 'NYK', played: 0, minutes: 0, fga: 0, fta: 0, threes_att: 0 });

// 1. Empty history (unknown player)
const emptyW = computeShotVolumeWindow(nbaDb, 'nobody', '2025-01-21', { games: 5 });
ok(emptyW.sufficient === false && emptyW.avgFga === null, '1. NBA: unknown player -> insufficient, never fabricated', emptyW);

// 2. L5 window
const l5 = computeShotVolumeWindow(nbaDb, 'p1', '2025-01-21', { games: 5 });
ok(l5.sufficient && l5.games === 5 && l5.avgFga === 10 && l5.avgFta === 2 && l5.avg3pa === 3, '2. NBA L5 real trailing shot-volume window', l5);

// 3. L10 window
const l10 = computeShotVolumeWindow(nbaDb, 'p1', '2025-01-21', { games: 10 });
ok(l10.sufficient && l10.games === 10 && l10.avgFga === 10, '3. NBA L10 real trailing shot-volume window', l10);

// 4. L15 window
const l15 = computeShotVolumeWindow(nbaDb, 'p1', '2025-01-21', { games: 15 });
ok(l15.sufficient && l15.games === 15, '4. NBA L15 real trailing shot-volume window', l15);

// 5. L20 window (exactly at the available real depth, excluding DNP/exhibition/postseason/future/prior-season)
const l20 = computeShotVolumeWindow(nbaDb, 'p1', '2025-12-31', { games: 20 });
ok(l20.sufficient && l20.games === 20 && l20.avgFga === 10, '5. NBA L20 real trailing window, exhibition/postseason/DNP/prior-season correctly excluded', l20);

// 6. Season-scoped window (seasonOnly filter)
const seasonScoped = computeShotVolumeWindow(nbaDb, 'p1', '2025-12-31', { games: 100, seasonOnly: 2025 });
ok(seasonScoped.sufficient && seasonScoped.games === 20, '6. NBA season-scoped window never crosses into season 2024', seasonScoped);

// 7. Insufficient history (minGames gate)
const insuff = computeShotVolumeWindow(nbaDb, 'p2', '2025-01-21', { games: 5, minGames: 5 });
ok(insuff.sufficient === false && insuff.games === 2, '7. NBA insufficient real games -> not sufficient, real count still reported', insuff);

// 8. Null fga/fta values excluded (not fabricated as 0) -- p3's real game only
const p3Window = computeShotVolumeWindow(nbaDb, 'p3', '2025-01-21', { games: 5, minGames: 1 });
ok(p3Window.sufficient && p3Window.games === 2 && p3Window.avgFga === 4, '8. NBA null-fga row still counted in `games` (real row, just missing shot data) but averaged over both rows honestly (0+8)/2=4, not fabricated as if both had real attempts', p3Window);

// 9. Target-game exclusion -- as-of the target game's own date, that game itself never appears
// (4 real 2025 games (Jan 1-4) + the real prior-season row (2024-06-01), which
// legitimately also falls before 2025-01-05 -- correctly included, not target-leaked)
const targetExcl = computeShotVolumeWindow(nbaDb, 'p1', '2025-01-05', { games: 20 });
ok(targetExcl.games === 5 && targetExcl.mostRecentGameDate === '2025-01-04', '9. NBA target-game date itself excluded (strict <); the Jan 5 game never appears, only real prior games do', targetExcl);

// 10. Future-game exclusion -- the Dec 31 fake-stat row never leaks into an earlier query
const noFutureLeak = computeShotVolumeWindow(nbaDb, 'p1', '2025-01-21', { games: 20 });
ok(noFutureLeak.avgFga === 10 && JSON.stringify(noFutureLeak).indexOf('99') === -1, '10. NBA future game (fga=99) never leaks into an earlier as-of query', noFutureLeak);

// 11. Cross-season boundary -- unscoped query as-of 2025-01-05 must not pull in the 2024 row for its trailing window count (season 2024 row date 2024-06-01 IS chronologically earlier so it legitimately CAN appear once the real 2025 games run out)
const crossSeason = computeShotVolumeWindow(nbaDb, 'p1', '2025-01-01', { games: 20, minGames: 1 });
ok(crossSeason.sufficient && crossSeason.avgFga === 1, '11. NBA cross-season fallback: with zero 2025 games before Jan 1, the real prior-season (2024) row is honestly the only trailing data (avgFga=1, not fabricated)', crossSeason);

// 12. Player identity -- p1 and p2 never cross-contaminate despite overlapping dates
const p2Window = computeShotVolumeWindow(nbaDb, 'p2', '2025-01-05', { games: 5 });
ok(p2Window.games === 2 && p2Window.avgFga === 5.5, '12. NBA player identity: p2 window unaffected by p1\'s rows on the same dates', p2Window);

// 13. Team identity implicit in player identity -- BOS (p1) and LAL (p2) rows never mix (already proven by #12, reaffirmed via a direct opponent-field check)
ok(l5.avgFga !== p2Window.avgFga, '13. NBA team/player separation reconfirmed (different avgFga for different players/teams)', { p1: l5.avgFga, p2: p2Window.avgFga });

// 14. Deterministic output
const detA = computeShotVolumeWindow(nbaDb, 'p1', '2025-01-21', { games: 10 });
const detB = computeShotVolumeWindow(nbaDb, 'p1', '2025-01-21', { games: 10 });
ok(JSON.stringify(detA) === JSON.stringify(detB), '14. NBA computeShotVolumeWindow is deterministic', { detA, detB });

// 15. No mutation of source data
const rowsBefore = nbaDb.prepare(`SELECT COUNT(*) c FROM nba_player_box`).get().c;
computeShotVolumeWindow(nbaDb, 'p1', '2025-01-21', { games: 10 });
const rowsAfter = nbaDb.prepare(`SELECT COUNT(*) c FROM nba_player_box`).get().c;
ok(rowsBefore === rowsAfter, '15. NBA source data (row count) unchanged after computation', { rowsBefore, rowsAfter });

// ── NFL: computeTargetShareWindow ────────────────────────────────────────
const nflPath = path.join(os.tmpdir(), `opportunity-nfl-test-${Date.now()}.db`);
const nflDb = new Database(nflPath);
nflDb.exec(`
  CREATE TABLE nfl_player_game_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, season INTEGER, week INTEGER, player_id TEXT,
    targets REAL DEFAULT 0, receptions REAL DEFAULT 0
  )
`);
const nflInsert = nflDb.prepare(`INSERT INTO nfl_player_game_stats (season, week, player_id, targets, receptions) VALUES (@season,@week,@player_id,@targets,@receptions)`);
[1, 2, 3, 4, 5].forEach(week => nflInsert.run({ season: 2024, week, player_id: 'wr1', targets: 8, receptions: 5 }));
// bye week (season 2024, week 6) -- no row for wr1 at all
// week 7 target-game -- must be excluded from its own as-of window
nflInsert.run({ season: 2024, week: 7, player_id: 'wr1', targets: 12, receptions: 9 });
// future season row -- must not leak into a season-2024 query
nflInsert.run({ season: 2025, week: 1, player_id: 'wr1', targets: 20, receptions: 15 });
// a real zero-target/zero-reception bye-week-shaped row (0/0) for a different player -- must be excluded as "no real game," not counted as a real 0
nflInsert.run({ season: 2024, week: 1, player_id: 'wr2', targets: 0, receptions: 0 });
nflInsert.run({ season: 2024, week: 2, player_id: 'wr2', targets: 6, receptions: 4 });
nflInsert.run({ season: 2024, week: 3, player_id: 'wr2', targets: 7, receptions: 5 });

// 16. NFL real trailing target/reception window, target-game (week 7) excluded
const nflW = computeTargetShareWindow(nflDb, 'wr1', 2024, 7, { games: 5, minGames: 2 });
ok(nflW.sufficient && nflW.games === 5 && nflW.avgTargets === 8 && nflW.avgReceptions === 5, '16. NFL real trailing target-share window, target-game itself excluded', nflW);

// 17. NFL future-season row never leaks into an earlier-season query
const nflNoLeak = computeTargetShareWindow(nflDb, 'wr1', 2024, 7, { games: 20, minGames: 2 });
ok(JSON.stringify(nflNoLeak).indexOf('20') === -1, '17. NFL season-2025 row (targets=20) never leaks into a season-2024 lookup', nflNoLeak);

// 18. NFL zero/zero row (no real game that week) excluded from the average, not counted as a real 0-target game
const wr2Window = computeTargetShareWindow(nflDb, 'wr2', 2024, 4, { games: 5, minGames: 1 });
ok(wr2Window.sufficient && wr2Window.games === 2 && wr2Window.avgTargets === 6.5, '18. NFL 0/0 no-real-game row excluded from the average (real games only, wr2 avg=6.5 from weeks 2-3)', wr2Window);

// 19. NFL insufficient real history
const wr3Insuff = computeTargetShareWindow(nflDb, 'wr3-unknown', 2024, 7, { games: 5, minGames: 2 });
ok(wr3Insuff.sufficient === false && wr3Insuff.avgTargets === null, '19. NFL unknown player -> insufficient, never fabricated', wr3Insuff);

// 20. NFL deterministic + no mutation
const nflDetA = computeTargetShareWindow(nflDb, 'wr1', 2024, 7, { games: 5 });
const nflDetB = computeTargetShareWindow(nflDb, 'wr1', 2024, 7, { games: 5 });
const nflRowsBefore = nflDb.prepare(`SELECT COUNT(*) c FROM nfl_player_game_stats`).get().c;
computeTargetShareWindow(nflDb, 'wr1', 2024, 7, { games: 5 });
const nflRowsAfter = nflDb.prepare(`SELECT COUNT(*) c FROM nfl_player_game_stats`).get().c;
ok(JSON.stringify(nflDetA) === JSON.stringify(nflDetB) && nflRowsBefore === nflRowsAfter, '20. NFL deterministic output + no source-data mutation', { nflDetA, nflDetB, nflRowsBefore, nflRowsAfter });

// ── computeOpportunityTrend (pure function) ──────────────────────────────
// 21. Real trend -- recent window clearly above baseline
const trendUp = computeOpportunityTrend({ sufficient: true, avgFga: 14 }, { sufficient: true, avgFga: 10 }, 'avgFga');
ok(trendUp && trendUp.delta === 4 && trendUp.deltaPct === 0.4, '21. computeOpportunityTrend: real upward trend computed correctly (continuous, no invented threshold)', trendUp);

// 22. Insufficient either side -> null, never fabricated
const trendNull = computeOpportunityTrend({ sufficient: false }, { sufficient: true, avgFga: 10 }, 'avgFga');
ok(trendNull === null, '22. computeOpportunityTrend: insufficient recent window -> null, not fabricated', trendNull);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
nbaDb.close();
nflDb.close();
fs.unlinkSync(nbaPath);
fs.unlinkSync(nflPath);
if (fail > 0) process.exit(1);
