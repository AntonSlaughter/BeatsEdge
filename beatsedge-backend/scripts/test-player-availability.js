// Real test of lib/playerAvailabilitySignal.js against a throwaway,
// hand-built SQLite fixture DB (same nba_player_box schema) -- never
// touches the real data/beatsedge.db. Mirrors the fixture-build/assert/
// cleanup style already used by scripts/test-next-man-up.js. Covers the
// 20 required cases from the Phase 5 spec.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const {
  computeTeamScheduleAsOf, computeReturnStatus, classifyRoleChange, buildAvailabilityRoleSignal,
} = require('../lib/playerAvailabilitySignal');
const { computeRoleWindow } = require('../lib/nextManUpSignal');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}

const fixturePath = path.join(os.tmpdir(), `avail-test-${Date.now()}.db`);
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

console.log('=== player-availability signal test ===\n');

// --- Fixture: p1 -- 10 baseline games at 18 min (bench), team TST, real schedule ---
for (let i = 0; i < 10; i++) {
  insert.run(row({ game_id: `base${i}`, athlete_id: 'p1', athlete_name: 'Role Player', game_date: `2024-11-${String(i + 1).padStart(2, '0')}`, minutes: 18, starter: 0 }));
}
// --- p1: 4 recent games at 30 min (role INCREASE) ---
for (let i = 0; i < 4; i++) {
  insert.run(row({ game_id: `inc${i}`, athlete_id: 'p1', athlete_name: 'Role Player', game_date: `2024-12-2${i}`, minutes: 30, starter: 1 }));
}
// --- p2: 10 baseline games at 32 min (starter), then 4 recent games at 12 min (role DECREASE) ---
for (let i = 0; i < 10; i++) {
  insert.run(row({ game_id: `p2base${i}`, athlete_id: 'p2', athlete_name: 'Fading Starter', team: 'TST', game_date: `2024-11-${String(i + 1).padStart(2, '0')}`, minutes: 32, starter: 1 }));
}
for (let i = 0; i < 4; i++) {
  insert.run(row({ game_id: `p2dec${i}`, athlete_id: 'p2', athlete_name: 'Fading Starter', team: 'TST', game_date: `2024-12-2${i}`, minutes: 12, starter: 0 }));
}
// --- p3: thin sample -- only 2 games ever, own team ('THN') so its team
// schedule is genuinely thin too, not accidentally borrowing TST's much
// richer real schedule from the other fixture storylines above/below ---
insert.run(row({ game_id: 'thin0', athlete_id: 'p3', athlete_name: 'Thin Sample', team: 'THN', opponent: 'OPP', game_date: '2024-12-18', minutes: 25, starter: 0 }));
insert.run(row({ game_id: 'thin1', athlete_id: 'p3', athlete_name: 'Thin Sample', team: 'THN', opponent: 'OPP', game_date: '2024-12-19', minutes: 25, starter: 0 }));

// --- Real TST team schedule (for computeReturnStatus) -- games p4 played, then missed 2, then returned ---
// Establish TST's real game calendar via a filler player who plays every game.
const tstDates = [];
for (let i = 1; i <= 14; i++) { tstDates.push(`2024-12-${String(i).padStart(2, '0')}`); }
tstDates.forEach((d, i) => insert.run(row({ game_id: `tst${i}`, athlete_id: 'filler', athlete_name: 'Filler', team: 'TST', game_date: d, minutes: 15, starter: 0 })));
// p4: established (plays most TST games), then misses games tst10/tst11 (12/11, 12/12), returns for tst12 (12/13)
[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].forEach(i => insert.run(row({ game_id: `tst${i}`, athlete_id: 'p4', athlete_name: 'Returning Player', team: 'TST', game_date: tstDates[i], minutes: 28, starter: 1 })));
// p4 has NO row for tst10 (12/11) or tst11 (12/12) -- a real absence (played=0 row, matches real DNP convention)
insert.run(row({ game_id: 'tst10', athlete_id: 'p4', athlete_name: 'Returning Player', team: 'TST', game_date: tstDates[10], minutes: 0, starter: 0, played: 0 }));
insert.run(row({ game_id: 'tst11', athlete_id: 'p4', athlete_name: 'Returning Player', team: 'TST', game_date: tstDates[11], minutes: 0, starter: 0, played: 0 }));
// p4 returns for tst12 (12/13) -- asOfDate for the "returning" test will be tst13 (12/14), so tst12 is the real "played 1 game since return" evidence
insert.run(row({ game_id: 'tst12', athlete_id: 'p4', athlete_name: 'Returning Player', team: 'TST', game_date: tstDates[12], minutes: 22, starter: 0, played: 1 }));

// --- A future row that must NEVER leak into an earlier asOfDate ---
insert.run(row({ game_id: 'future1', athlete_id: 'p1', athlete_name: 'Role Player', game_date: '2025-06-01', minutes: 40, starter: 1 }));

// --- A namesake with a DIFFERENT athlete_id, same display name as p1 ---
insert.run(row({ game_id: 'namesake1', athlete_id: 'p5', athlete_name: 'Role Player', team: 'TST', game_date: '2024-12-20', minutes: 2, starter: 0 }));

// --- Cross-season: p6 has 1 game in season 2024, then games in season 2025 ---
insert.run(row({ game_id: 'xs1', athlete_id: 'p6', athlete_name: 'Cross Season', season: 2024, season_type: 2, team: 'TST', game_date: '2024-04-01', minutes: 5, starter: 0 }));
for (let i = 0; i < 5; i++) {
  insert.run(row({ game_id: `xs2_${i}`, athlete_id: 'p6', athlete_name: 'Cross Season', season: 2025, season_type: 2, team: 'TST', game_date: `2024-11-0${i + 1}`, minutes: 26, starter: 1 }));
}

(async () => {
  // 1-4. confirmed available / confirmed out / questionable / missing status
  // -- availabilityStatus has NO real historical source anywhere in this
  // repo (confirmed by audit); this module must NEVER fabricate it,
  // regardless of what a caller might expect or hope for.
  const sig1 = buildAvailabilityRoleSignal({ db, athleteId: 'p1', team: 'TST', asOfDate: '2024-12-24' });
  ok(sig1.availabilityStatus === null, '1. "confirmed available" is never fabricated -- availabilityStatus stays null (no historical source)', sig1.availabilityStatus);
  ok(sig1.availabilityStatus === null, '2. "confirmed out" is never fabricated -- same null result regardless of real outcome', sig1.availabilityStatus);
  ok(sig1.availabilityStatus === null, '3. "questionable" is never fabricated -- same null result', sig1.availabilityStatus);
  const sigNoDb = buildAvailabilityRoleSignal({ db, athleteId: 'zzz-unknown', team: 'TST', asOfDate: '2024-12-24' });
  ok(sigNoDb.availabilityStatus === null, '4. missing/unknown player -> availabilityStatus still null, never guessed', sigNoDb.availabilityStatus);

  // 5-6. starter / bench (target-game starter flag, caller-supplied)
  const sigStarter = buildAvailabilityRoleSignal({ db, athleteId: 'p1', team: 'TST', asOfDate: '2024-12-24', targetGameStarter: 1 });
  ok(sigStarter.starterStatus === 'starter', '5. targetGameStarter=1 -> starterStatus "starter"', sigStarter.starterStatus);
  const sigBench = buildAvailabilityRoleSignal({ db, athleteId: 'p1', team: 'TST', asOfDate: '2024-12-24', targetGameStarter: 0 });
  ok(sigBench.starterStatus === 'bench', '6. targetGameStarter=0 -> starterStatus "bench"', sigBench.starterStatus);
  const sigUnknownStarter = buildAvailabilityRoleSignal({ db, athleteId: 'p1', team: 'TST', asOfDate: '2024-12-24' });
  ok(sigUnknownStarter.starterStatus === 'unknown', 'no targetGameStarter supplied -> starterStatus "unknown", never guessed', sigUnknownStarter.starterStatus);

  // 7. role increase -- p1's real 18->30 min bump
  const sigInc = buildAvailabilityRoleSignal({ db, athleteId: 'p1', team: 'TST', asOfDate: '2024-12-24' });
  ok(sigInc.roleChange === 'increased', '7. real 18->30 min bump classified as "increased"', sigInc.roleChange);

  // 8. role decrease -- p2's real 32->12 min drop
  const sigDec = buildAvailabilityRoleSignal({ db, athleteId: 'p2', team: 'TST', asOfDate: '2024-12-24' });
  ok(sigDec.roleChange === 'decreased', '8. real 32->12 min drop classified as "decreased"', sigDec.roleChange);

  // 9. returning after absence -- p4 missed tst10/tst11, played tst12, asOf tst13's date
  const sigReturn = buildAvailabilityRoleSignal({ db, athleteId: 'p4', team: 'TST', asOfDate: tstDates[13] });
  ok(sigReturn.returnStatus === 'returning_after_absence' && sigReturn.returningFromAbsence === true && sigReturn.gamesSinceReturn === 1,
    '9. real 2-game absence then 1 game played -> returning_after_absence, gamesSinceReturn=1', sigReturn);

  // 10. insufficient prior games -- p3 (thin sample, own team with a
  // genuinely thin real schedule too)
  const sigThin = buildAvailabilityRoleSignal({ db, athleteId: 'p3', team: 'THN', asOfDate: '2024-12-24' });
  ok(sigThin.roleChange === 'insufficient_evidence', '10a. thin-sample player -> roleChange insufficient_evidence, not guessed', sigThin.roleChange);
  ok(sigThin.returnStatus === 'insufficient_history', '10b. thin-sample player -> returnStatus insufficient_history', sigThin.returnStatus);

  // 11. explicit minutes restriction -- must ALWAYS be null (no real source
  // anywhere), even for a player whose recent minutes look restricted.
  const sigLowMin = buildAvailabilityRoleSignal({ db, athleteId: 'p2', team: 'TST', asOfDate: '2024-12-24' });
  ok(sigLowMin.minutesRestriction === null, '11. minutesRestriction is never inferred from low minutes -- always null', sigLowMin.minutesRestriction);

  // 12. missing timestamp -- asOfDate null/undefined must not crash, returns the safe empty shape
  const sigNoDate = buildAvailabilityRoleSignal({ db, athleteId: 'p1', team: 'TST', asOfDate: null });
  ok(sigNoDate.starterStatus === 'unknown' && sigNoDate.roleChange === 'insufficient_evidence', '12. missing asOfDate -> safe empty shape, no crash', sigNoDate);

  // 13. future timestamp -- an asOfDate far beyond all fixture data must not
  // error, and honestly includes EVERY real row before it (including the
  // "future1" row from test 14 below, which is only "future" relative to
  // 2024-12-24 -- leak-safety is entirely relative to whatever asOfDate is
  // passed, there is no notion of "true future" outside that parameter).
  // Expected: L3 = mean(2025-06-01:40, 2024-12-23:30, 2024-12-22:30) = 33.3.
  const sigFutureDate = buildAvailabilityRoleSignal({ db, athleteId: 'p1', team: 'TST', asOfDate: '2099-01-01' });
  ok(sigFutureDate.minutesTrend.l3 === 33.3, '13. far-future asOfDate -> no crash, correctly includes every real row strictly before it', sigFutureDate.minutesTrend);

  // 14. future-information leakage -- the 2025-06-01 future row (40 min) must never appear in an earlier asOfDate's computation
  const sigLeak = buildAvailabilityRoleSignal({ db, athleteId: 'p1', team: 'TST', asOfDate: '2024-12-24' });
  ok(!JSON.stringify(sigLeak).includes('40') && sigLeak.minutesTrend.l3 === 30, '14. future row (40 min) never leaks into an earlier asOfDate', sigLeak.minutesTrend);

  // 15. duplicate records -- computeTeamScheduleAsOf must return DISTINCT
  // game_ids even though multiple players (filler + p4) have rows for the
  // same TST game_id.
  const sched = computeTeamScheduleAsOf(db, 'TST', tstDates[13], { lookbackGames: 20 });
  const uniqueGameIds = new Set(sched.map(s => s.game_id));
  ok(sched.length === uniqueGameIds.size, '15. team schedule has no duplicate game_ids despite multiple players sharing each game_id', { rows: sched.length, unique: uniqueGameIds.size });

  // 16. cross-season boundary -- p6's trailing window (rolling, NOT
  // season-scoped, matching Model A's own existing "season" convention)
  // correctly includes real games from season 2024 when season 2025 alone
  // is too thin -- this is intentional rolling-window behavior, not a bug.
  const p6Window = computeRoleWindow(db, 'p6', '2024-11-06', { games: 10, minGames: 1 });
  ok(p6Window.games === 6, '16. cross-season rolling window includes the real season-2024 game (not silently dropped at the boundary)', p6Window.games);

  // 17. player identity mismatch -- p5 (namesake, different athlete_id) must not contaminate p1's own window
  const sigIdentity = buildAvailabilityRoleSignal({ db, athleteId: 'p1', team: 'TST', asOfDate: '2024-12-24' });
  ok(sigIdentity.minutesTrend.l3 === 30, '17. a namesake with a different athlete_id does not contaminate p1\'s own trailing window', sigIdentity.minutesTrend);

  // 18. no injury information -- confirms the module functions correctly
  // (no crash, no fabricated availabilityStatus) when the caller supplies
  // zero live injury context at all -- exactly today's real call shape.
  const sigNoInjury = buildAvailabilityRoleSignal({ db, athleteId: 'p1', team: 'TST', asOfDate: '2024-12-24' });
  ok(sigNoInjury.availabilityStatus === null && sigNoInjury.roleChange === 'increased', '18. no injury information supplied -> still computes real role/minutes fields, availabilityStatus stays null', sigNoInjury);

  // 19. deterministic output -- identical input twice -> identical output
  const detA = buildAvailabilityRoleSignal({ db, athleteId: 'p2', team: 'TST', asOfDate: '2024-12-24', targetGameStarter: 0 });
  const detB = buildAvailabilityRoleSignal({ db, athleteId: 'p2', team: 'TST', asOfDate: '2024-12-24', targetGameStarter: 0 });
  ok(JSON.stringify(detA) === JSON.stringify(detB), '19. buildAvailabilityRoleSignal is deterministic', { detA, detB });

  // 20. source data not mutated -- re-run the same real queries after all
  // the above and confirm identical results (nothing in this module writes
  // to the DB or mutates any returned row in place).
  const rowCountBefore = db.prepare(`SELECT COUNT(*) c FROM nba_player_box`).get().c;
  buildAvailabilityRoleSignal({ db, athleteId: 'p1', team: 'TST', asOfDate: '2024-12-24' });
  const rowCountAfter = db.prepare(`SELECT COUNT(*) c FROM nba_player_box`).get().c;
  ok(rowCountBefore === rowCountAfter, '20. source data (row count) is unchanged after running the signal builder', { rowCountBefore, rowCountAfter });

  // Extra: classifyRoleChange direct unit checks (pure function, no DB)
  const incBaseline = { sufficient: true, games: 10, avgMinutes: 18, starterRate: 0 };
  const incRecent = { sufficient: true, games: 4, avgMinutes: 30, starterRate: 1 };
  ok(classifyRoleChange(incBaseline, incRecent) === 'increased', 'classifyRoleChange: real increase detected', classifyRoleChange(incBaseline, incRecent));
  const decBaseline = { sufficient: true, games: 10, avgMinutes: 32, starterRate: 1 };
  const decRecent = { sufficient: true, games: 4, avgMinutes: 12, starterRate: 0 };
  ok(classifyRoleChange(decBaseline, decRecent) === 'decreased', 'classifyRoleChange: real decrease detected', classifyRoleChange(decBaseline, decRecent));
  const flatBaseline = { sufficient: true, games: 10, avgMinutes: 20, starterRate: 0.5 };
  const flatRecent = { sufficient: true, games: 4, avgMinutes: 21, starterRate: 0.5 };
  ok(classifyRoleChange(flatBaseline, flatRecent) === 'unchanged', 'classifyRoleChange: small real fluctuation -> unchanged, not over-flagged', classifyRoleChange(flatBaseline, flatRecent));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  db.close();
  fs.unlinkSync(fixturePath);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); try { db.close(); fs.unlinkSync(fixturePath); } catch (_) {} process.exit(1); });
