// Real test of lib/nextManUpSignal.js against a throwaway, hand-built
// SQLite fixture DB (same nba_player_box schema) -- never touches the
// real data/beatsedge.db. Mirrors the fixture-build/assert/cleanup style
// already used by scripts/test-dvp-engine.js and scripts/test-data-paths.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const {
  computeRoleWindow, detectRoleChange, findAbsentRotationPlayers, buildNextManUpSignal,
} = require('../lib/nextManUpSignal');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? ' -- ' + detail : ''}`);
  if (cond) pass++; else fail++;
}

const fixturePath = path.join(os.tmpdir(), `nmu-test-${Date.now()}.db`);
const db = new Database(fixturePath);
db.exec(`
  CREATE TABLE nba_player_box (
    game_id TEXT, athlete_id TEXT, athlete_name TEXT, season INTEGER, season_type INTEGER,
    game_date TEXT, team TEXT, opponent TEXT, home_away TEXT, pos TEXT, pos_group TEXT,
    minutes REAL, points REAL, rebounds REAL, assists REAL, starter INTEGER, played INTEGER
  )
`);

const insert = db.prepare(`
  INSERT INTO nba_player_box (game_id, athlete_id, athlete_name, season, season_type, game_date, team, opponent, home_away, pos, pos_group, minutes, points, rebounds, assists, starter, played)
  VALUES (@game_id, @athlete_id, @athlete_name, @season, @season_type, @game_date, @team, @opponent, @home_away, @pos, @pos_group, @minutes, @points, @rebounds, @assists, @starter, @played)
`);

function row(overrides) {
  return {
    game_id: 'g1', athlete_id: 'p1', athlete_name: 'Test Player', season: 2025, season_type: 2,
    game_date: '2025-01-01', team: 'TST', opponent: 'OPP', home_away: 'home', pos: 'PG', pos_group: 'G',
    minutes: 20, points: 10, rebounds: 3, assists: 2, starter: 0, played: 1,
    ...overrides,
  };
}

// --- Build a real baseline: 10 games at ~18 min bench role for BACKUP (p1) ---
for (let i = 0; i < 10; i++) {
  insert.run(row({ game_id: `base${i}`, athlete_id: 'p1', athlete_name: 'Backup Guard', game_date: `2024-11-${String(i + 1).padStart(2, '0')}`, minutes: 18, starter: 0 }));
}
// --- Then a real recent bump: 4 games at ~30 min, now starting ---
for (let i = 0; i < 4; i++) {
  insert.run(row({ game_id: `rec${i}`, athlete_id: 'p1', athlete_name: 'Backup Guard', game_date: `2024-12-2${i}`, minutes: 30, starter: 1 }));
}
// --- The starter who got hurt (p2): real trailing history, then MISSING from game gX ---
for (let i = 0; i < 6; i++) {
  insert.run(row({ game_id: `p2g${i}`, athlete_id: 'p2', athlete_name: 'Injured Starter', game_date: `2024-12-1${i}`, minutes: 34, starter: 1, pos_group: 'G' }));
}
// p2 has NO row for game_date 2024-12-24 (the "predicted" game) -- absent.
// p1 also has no row yet for 2024-12-24 -- we predict INTO that date.

// A player with insufficient history (only 2 games ever)
for (let i = 0; i < 2; i++) {
  insert.run(row({ game_id: `thin${i}`, athlete_id: 'p3', athlete_name: 'Thin Sample', game_date: `2024-12-1${i}`, minutes: 25, starter: 0 }));
}

// A future row that must NEVER be visible to an asOfDate before it (leakage check)
insert.run(row({ game_id: 'future1', athlete_id: 'p1', athlete_name: 'Backup Guard', game_date: '2025-06-01', minutes: 40, starter: 1 }));

(async () => {
  console.log('=== next-man-up signal test ===\n');

  // 1. computeRoleWindow: leakage -- a future row must never appear
  const win = computeRoleWindow(db, 'p1', '2024-12-24', { games: 4, minGames: 1 });
  ok(win.sufficient && win.avgMinutes === 30, 'recent window picks up the real 4-game bump (30 min avg)', JSON.stringify(win));
  ok(win.mostRecentGameDate < '2024-12-24', 'no row on/after asOfDate leaked into the window', win.mostRecentGameDate);
  const futureCheck = computeRoleWindow(db, 'p1', '2024-12-24', { games: 100, minGames: 1 });
  ok(!JSON.stringify(futureCheck).includes('2025-06-01'), 'the 2025-06-01 future row never appears for an earlier asOfDate');

  // 2. detectRoleChange: real detected bump
  const baseline = computeRoleWindow(db, 'p1', '2024-12-24', { games: 10, minGames: 8 });
  const recent = computeRoleWindow(db, 'p1', '2024-12-24', { games: 4, minGames: 3 });
  const change = detectRoleChange(baseline, recent);
  ok(change.roleChangeDetected === true, 'real 12-min/game bump (18->30) is detected as a role change', JSON.stringify(change));

  // 3. insufficient history -> inactive, not fabricated
  const thinBaseline = computeRoleWindow(db, 'p3', '2024-12-24', { games: 15, minGames: 8 });
  const thinRecent = computeRoleWindow(db, 'p3', '2024-12-24', { games: 4, minGames: 3 });
  const thinChange = detectRoleChange(thinBaseline, thinRecent);
  ok(thinChange.roleChangeDetected === false && /insufficient/.test(thinChange.reason), 'insufficient baseline history -> explicitly inactive, not guessed', JSON.stringify(thinChange));

  // 4. findAbsentRotationPlayers: p2 (real recent starter) missing from the target game -> found
  const absent = findAbsentRotationPlayers(db, 'TST', 'target-game-2024-12-24', '2024-12-24', { trailingGames: 6, minMinutes: 15 });
  ok(absent.some(a => a.athleteId === 'p2'), 'a real rotation player missing from the target game is detected as absent', JSON.stringify(absent));
  ok(!absent.some(a => a.athleteId === 'p3'), 'a thin-sample player is NOT flagged as a rotation absence (insufficient games)');

  // 5. no injury/no absence -> inactive
  const noInjurySignal = buildNextManUpSignal({ db, athleteId: 'p1', athleteName: 'Backup Guard', team: 'TST', posGroup: 'G', asOfDate: '2024-12-24', unavailableTeammates: [] });
  ok(noInjurySignal.active === false && noInjurySignal.unavailableTeammate === null, 'zero unavailable teammates -> signal inactive, all fields null (never fabricated)', JSON.stringify(noInjurySignal));

  // 6. valid teammate absence + real role change -> active, with real numbers
  const activeSignal = buildNextManUpSignal({
    db, athleteId: 'p1', athleteName: 'Backup Guard', team: 'TST', posGroup: 'G', asOfDate: '2024-12-24',
    unavailableTeammates: [{ athleteId: 'p2', athleteName: 'Injured Starter', posGroup: 'G' }],
    dataFreshness: '2024-12-24T10:00:00Z',
  });
  ok(activeSignal.active === true, 'real absence + real role change -> signal active', JSON.stringify(activeSignal));
  ok(activeSignal.minutesImpact > 0 && activeSignal.opportunityImpact > 0, 'active signal carries real, non-fabricated minutes/opportunity numbers', JSON.stringify(activeSignal));
  ok(activeSignal.confidence > 0 && activeSignal.confidence <= 0.85, 'confidence is bounded and sample-size-derived, not a guess', activeSignal.confidence);
  ok(activeSignal.unavailableTeammate === 'Injured Starter', 'unavailable teammate name is the real supplied player, not fabricated');

  // 7. wrong position group -> no match, inactive
  const wrongPosSignal = buildNextManUpSignal({
    db, athleteId: 'p1', athleteName: 'Backup Guard', team: 'TST', posGroup: 'G', asOfDate: '2024-12-24',
    unavailableTeammates: [{ athleteId: 'p9', athleteName: 'Center Out', posGroup: 'C' }],
  });
  ok(wrongPosSignal.active === false, 'unavailable teammate in a different position group -> no match, inactive');

  // 8. missing/insufficient data -> null fields, never fabricated
  const missingDataSignal = buildNextManUpSignal({ db, athleteId: 'nonexistent-player', team: 'TST', posGroup: 'G', asOfDate: '2024-12-24', unavailableTeammates: [{ athleteId: 'p2', athleteName: 'Injured Starter', posGroup: 'G' }] });
  ok(missingDataSignal.active === false && missingDataSignal.minutesImpact === null, 'unknown player -> inactive with null impact fields, never a fabricated number', JSON.stringify(missingDataSignal));

  // 9. duplicate unavailable-teammate records -> handled without double-counting or crashing
  const dupSignal = buildNextManUpSignal({
    db, athleteId: 'p1', athleteName: 'Backup Guard', team: 'TST', posGroup: 'G', asOfDate: '2024-12-24',
    unavailableTeammates: [
      { athleteId: 'p2', athleteName: 'Injured Starter', posGroup: 'G' },
      { athleteId: 'p2', athleteName: 'Injured Starter', posGroup: 'G' },
    ],
  });
  ok(dupSignal.active === true && dupSignal.unavailableTeammate === 'Injured Starter', 'duplicate unavailable-teammate entries do not break or double-count the signal', JSON.stringify(dupSignal));

  // 10. cross-season handling: computeRoleWindow with seasonOnly set must not blend prior season's games in
  insert.run(row({ game_id: 'prevseason1', athlete_id: 'p4', athlete_name: 'Cross Season', season: 2024, season_type: 2, game_date: '2024-04-01', minutes: 5, starter: 0 }));
  insert.run(row({ game_id: 'thisseason1', athlete_id: 'p4', athlete_name: 'Cross Season', season: 2025, season_type: 2, game_date: '2024-11-05', minutes: 25, starter: 1 }));
  const crossSeasonWindow = computeRoleWindow(db, 'p4', '2025-01-01', { games: 10, minGames: 1, seasonOnly: 2025 });
  ok(crossSeasonWindow.games === 1 && crossSeasonWindow.avgMinutes === 25, 'seasonOnly filter excludes the prior season\'s row from the baseline', JSON.stringify(crossSeasonWindow));

  // 11. player identity: two different athlete_ids with the same display name must not be conflated
  insert.run(row({ game_id: 'namesake1', athlete_id: 'p5', athlete_name: 'Backup Guard', game_date: '2024-12-20', minutes: 2, starter: 0 }));
  const p1WindowAgain = computeRoleWindow(db, 'p1', '2024-12-24', { games: 4, minGames: 3 });
  ok(p1WindowAgain.avgMinutes === 30, 'a namesake with a different athlete_id does not contaminate p1\'s own window (identity is by athlete_id, not name)', JSON.stringify(p1WindowAgain));

  // 12. DNP/inactive rows (played=0) must not count as "present" for absence
  // detection, and must not dilute a trailing-minutes average -- real
  // nba_player_box has 75,842 such rows (14.2% of regular-season data),
  // always minutes=0, and a naive "row exists for this game_id" check would
  // wrongly treat a genuinely-absent rotation player as having played.
  for (let i = 0; i < 6; i++) {
    insert.run(row({ game_id: `p6g${i}`, athlete_id: 'p6', athlete_name: 'DNP Test', game_date: `2025-01-0${i + 1}`, minutes: 28, starter: 1, played: 1 }));
  }
  // p6 has a ROW for the target game, but played=0, minutes=0 -- a real inactive/DNP entry.
  insert.run(row({ game_id: 'dnp-target', athlete_id: 'p6', athlete_name: 'DNP Test', game_date: '2025-01-10', minutes: 0, starter: 0, played: 0 }));
  const dnpWindow = computeRoleWindow(db, 'p6', '2025-01-11', { games: 5, minGames: 3 });
  ok(dnpWindow.avgMinutes === 28, 'a played=0 DNP row is excluded from the trailing-minutes average, not counted as a 0-minute game', JSON.stringify(dnpWindow));
  const dnpAbsent = findAbsentRotationPlayers(db, 'TST', 'dnp-target', '2025-01-10', { trailingGames: 6, minMinutes: 15 });
  ok(dnpAbsent.some(a => a.athleteId === 'p6'), 'a player with a played=0 row for the target game is still correctly detected as absent (the row exists, but they did not play)', JSON.stringify(dnpAbsent));

  // 13. All-Star weekend / exhibition rows (opponent in the known exhibition
  // list) must be excluded from trailing windows, same as lib/nbaHistDb.js
  // already does for the live gamelog path -- these are not real competitive
  // games and would distort a rotation-role baseline.
  for (let i = 0; i < 5; i++) {
    insert.run(row({ game_id: `p7g${i}`, athlete_id: 'p7', athlete_name: 'ASG Test', game_date: `2025-01-0${i + 1}`, minutes: 20, starter: 1 }));
  }
  insert.run(row({ game_id: 'p7-asg', athlete_id: 'p7', athlete_name: 'ASG Test', game_date: '2025-01-06', minutes: 40, starter: 1, opponent: 'WORLD' }));
  const asgWindow = computeRoleWindow(db, 'p7', '2025-01-10', { games: 5, minGames: 3 });
  ok(asgWindow.avgMinutes === 20 && !JSON.stringify(asgWindow).includes('01-06'), 'an All-Star-weekend exhibition row (opponent=WORLD) is excluded from the trailing window', JSON.stringify(asgWindow));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  db.close();
  fs.unlinkSync(fixturePath);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); try { db.close(); fs.unlinkSync(fixturePath); } catch (_) {} process.exit(1); });
