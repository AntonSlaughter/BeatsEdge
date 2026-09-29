// Phase 4: proves the NEW bulk, historicalStore-backed production paths
// (buildNextManUpSignalsBulk / buildAvailabilityRoleSignalsBulk) reproduce
// the SAME documented behaviors the existing legacy fixture tests already
// prove (scripts/test-next-man-up.js / scripts/test-player-availability.js)
// -- leakage safety, DNP exclusion, exhibition-game exclusion, role-change
// detection, returning-from-absence detection -- using ONLY historicalStore
// (node:sqlite), never better-sqlite3.
//
// This runs against the REAL local data/beatsedge.db (historicalStore's
// local backend), using clearly-tagged fake rows (athlete_id/game_id/team
// all prefixed "bulktest-"/"BLKT") that cannot collide with real data, and
// is cleaned up (deleted) in a `finally` block even on failure.
//
// WHY NOT a live cross-process legacy-vs-bulk diff (like
// scripts/test-bulk-nfl-dvp-parity.js did for NFL DvP): while building this
// test, requiring lib/db.js (better-sqlite3) and lib/playerAvailabilitySignal.js
// together and executing more than a handful of db.prepare() calls in one
// process reproducibly crashed the native addon on this machine (Node
// v24.20.0) during isolate teardown, even after 6 retries with identical
// failures every time -- not the usual intermittent pattern documented
// elsewhere in this project. Rather than accept an unreliable test, this
// file proves bulk-path correctness directly against known expected
// outcomes (the same style scripts/test-next-man-up.js already uses),
// which is fully reliable since it never touches better-sqlite3. Legacy-
// path correctness is separately, already proven by the EXISTING
// scripts/test-next-man-up.js / scripts/test-player-availability.js fixture
// suites, which still pass unmodified against the refactored
// computeRoleWindow/buildNextManUpSignal/buildAvailabilityRoleSignal (now
// thin wrappers around the exact same computeRoleWindowFromRows/
// computeReturnStatusFromRows/*Core functions the bulk path calls) -- see
// this repo's Phase 4 report for how the two paths share their core math.

let failures = 0;
function check(name, condition, detail) { if (condition) console.log(`PASS  ${name}`); else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? '  -- ' + JSON.stringify(detail) : ''}`); } }

(async () => {
  const store = require('../lib/historicalStore');
  const nextManUp = require('../lib/nextManUpSignal');
  const availability = require('../lib/playerAvailabilitySignal');

  const TAG = 'bulktest-' + Date.now();
  const rows = [];
  function row(o) {
    return {
      game_id: `${TAG}-${o.game_id}`, athlete_id: `${TAG}-${o.athlete_id}`, athlete_name: o.athlete_name || 'Test Player',
      season: o.season ?? 2025, season_type: o.season_type ?? 2, game_date: o.game_date,
      team: o.team || 'BLKT', opponent: o.opponent || 'BLKOPP', home_away: 'home', pos: 'PG', pos_group: o.pos_group || 'G',
      minutes: o.minutes ?? 20, points: 10, off_reb: 0, def_reb: 0, rebounds: 3, assists: 2, threes: 0, threes_att: 0,
      steals: 0, blocks: 0, turnovers: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, plus_minus: 0,
      starter: o.starter ?? 0, played: o.played ?? 1, fantasy_points: 0, source: 'bulktest',
    };
  }

  // --- p1: baseline 10 games @ 18 min, then real 4-game bump to 30 min ---
  for (let i = 0; i < 10; i++) rows.push(row({ game_id: `base${i}`, athlete_id: 'p1', game_date: `2024-11-${String(i + 1).padStart(2, '0')}`, minutes: 18, starter: 0 }));
  for (let i = 0; i < 4; i++) rows.push(row({ game_id: `rec${i}`, athlete_id: 'p1', game_date: `2024-12-2${i}`, minutes: 30, starter: 1 }));
  // --- p2: real starter history, then absent from the target game (no row for 2024-12-24) ---
  for (let i = 0; i < 6; i++) rows.push(row({ game_id: `p2g${i}`, athlete_id: 'p2', athlete_name: 'Injured Starter', game_date: `2024-12-1${i}`, minutes: 34, starter: 1 }));
  // --- p3: thin sample (2 games) ---
  for (let i = 0; i < 2; i++) rows.push(row({ game_id: `thin${i}`, athlete_id: 'p3', game_date: `2024-12-1${i}`, minutes: 25 }));
  // --- future row that must never leak ---
  rows.push(row({ game_id: 'future1', athlete_id: 'p1', game_date: '2025-06-01', minutes: 40, starter: 1 }));
  // --- p6: DNP row for the target game (played=0) must not count as present/absent-ambiguous ---
  for (let i = 0; i < 6; i++) rows.push(row({ game_id: `p6g${i}`, athlete_id: 'p6', game_date: `2025-01-0${i + 1}`, minutes: 28, starter: 1 }));
  rows.push(row({ game_id: 'dnp-target', athlete_id: 'p6', game_date: '2025-01-10', minutes: 0, starter: 0, played: 0 }));
  // --- p7: exhibition row (opponent=WORLD) must be excluded from windows ---
  for (let i = 0; i < 5; i++) rows.push(row({ game_id: `p7g${i}`, athlete_id: 'p7', game_date: `2025-01-0${i + 1}`, minutes: 20, starter: 1 }));
  rows.push(row({ game_id: 'p7-asg', athlete_id: 'p7', game_date: '2025-01-06', minutes: 40, starter: 1, opponent: 'WORLD' }));
  // --- p8/p9: role DECREASE scenario (32 -> 12 min) ---
  for (let i = 0; i < 10; i++) rows.push(row({ game_id: `p8base${i}`, athlete_id: 'p8', game_date: `2024-11-${String(i + 1).padStart(2, '0')}`, minutes: 32, starter: 1 }));
  for (let i = 0; i < 4; i++) rows.push(row({ game_id: `p8dec${i}`, athlete_id: 'p8', game_date: `2024-12-2${i}`, minutes: 12, starter: 0 }));
  // --- p10 (+filler): returning-after-absence scenario on team BLKRET ---
  const retDates = []; for (let i = 1; i <= 14; i++) retDates.push(`2024-12-${String(i).padStart(2, '0')}`);
  retDates.forEach((d, i) => rows.push(row({ game_id: `ret${i}`, athlete_id: 'filler', team: 'BLKRET', game_date: d, minutes: 15 })));
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].forEach(i => rows.push(row({ game_id: `ret${i}`, athlete_id: 'p10', team: 'BLKRET', game_date: retDates[i], minutes: 28, starter: 1 })));
  rows.push(row({ game_id: 'ret10', athlete_id: 'p10', team: 'BLKRET', game_date: retDates[10], minutes: 0, starter: 0, played: 0 }));
  rows.push(row({ game_id: 'ret11', athlete_id: 'p10', team: 'BLKRET', game_date: retDates[11], minutes: 0, starter: 0, played: 0 }));
  rows.push(row({ game_id: 'ret12', athlete_id: 'p10', team: 'BLKRET', game_date: retDates[12], minutes: 22, starter: 0, played: 1 }));

  try {
    await store.transaction(async (exec) => {
      for (const r of rows) {
        await exec(`INSERT INTO nba_player_box (game_id, athlete_id, athlete_name, season, season_type, game_date, team, opponent, home_away, pos, pos_group, minutes, points, off_reb, def_reb, rebounds, assists, threes, threes_att, steals, blocks, turnovers, fgm, fga, ftm, fta, plus_minus, starter, played, fantasy_points, source)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [r.game_id, r.athlete_id, r.athlete_name, r.season, r.season_type, r.game_date, r.team, r.opponent, r.home_away, r.pos, r.pos_group, r.minutes, r.points, r.off_reb, r.def_reb, r.rebounds, r.assists, r.threes, r.threes_att, r.steals, r.blocks, r.turnovers, r.fgm, r.fga, r.ftm, r.fta, r.plus_minus, r.starter, r.played, r.fantasy_points, r.source]);
      }
    });

    const asOfDate = '2024-12-24';
    const p = id => `${TAG}-${id}`;

    // ---------------- Next Man Up ----------------
    // Separate calls (not one shared batch) where each scenario keys a
    // DIFFERENT athleteId -- signals is a plain object keyed by athleteId,
    // same as the real POST /nba/next-man-up route, so two requests for the
    // SAME athleteId in one batch would legitimately overwrite each other
    // (matches the real route's existing, pre-existing behavior).
    const nmuActive = await nextManUp.buildNextManUpSignalsBulk([
      { athleteId: p('p1'), athleteName: 'Backup Guard', team: 'BLKT', posGroup: 'G', unavailableTeammates: [{ athleteId: p('p2'), athleteName: 'Injured Starter', posGroup: 'G' }] },
      { athleteId: p('p3'), athleteName: 'Thin Sample', team: 'BLKT', posGroup: 'G', unavailableTeammates: [{ athleteId: p('p2'), athleteName: 'Injured Starter', posGroup: 'G' }] },
    ], asOfDate);
    check('1: real teammate absence + real role change -> active, real numbers', nmuActive[p('p1')].active === true && nmuActive[p('p1')].minutesImpact > 0, nmuActive[p('p1')]);
    check('2: no future-row leakage (2025-06-01, 40min, never appears)', !JSON.stringify(nmuActive[p('p1')]).includes('40'));

    const nmuInactive = await nextManUp.buildNextManUpSignalsBulk([
      { athleteId: p('p1'), athleteName: 'Backup Guard', team: 'BLKT', posGroup: 'G', unavailableTeammates: [] },
    ], asOfDate);
    check('2b: zero unavailable teammates -> inactive, never fabricated', nmuInactive[p('p1')].active === false && nmuInactive[p('p1')].unavailableTeammate === null);

    // ---------------- Player Availability ----------------
    const availSignals = await availability.buildAvailabilityRoleSignalsBulk([
      { athleteId: p('p1'), team: 'BLKT', targetGameStarter: 1 },
      { athleteId: p('p8'), team: 'BLKT' },
    ], asOfDate);
    check('3: real 18->30 min bump classified "increased"', availSignals[p('p1')].roleChange === 'increased', availSignals[p('p1')]);
    check('4: real 32->12 min drop classified "decreased"', availSignals[p('p8')].roleChange === 'decreased', availSignals[p('p8')]);
    check('5: targetGameStarter=1 -> starterStatus "starter"', availSignals[p('p1')].starterStatus === 'starter');

    // p6/p7's fixture rows live in January 2025 -- evaluate them as-of a
    // date in that same window (asOfDate is shared across a whole batch,
    // matching the real POST /nba/player-availability request shape, so
    // each era needs its own batch/asOfDate, exactly like the legacy
    // fixture test uses different asOfDates per scenario).
    const availDnp = await availability.buildAvailabilityRoleSignalsBulk([{ athleteId: p('p6'), team: 'BLKT' }], '2025-01-11');
    check('6: a played=0 DNP row is excluded from the trailing-minutes average (28, not diluted by the 0)', availDnp[p('p6')].minutesTrend.l3 === 28, availDnp[p('p6')].minutesTrend);

    const availExhib = await availability.buildAvailabilityRoleSignalsBulk([{ athleteId: p('p7'), team: 'BLKT' }], '2025-01-10');
    check('7: an exhibition row (opponent=WORLD) is excluded from the trailing window (20, not diluted by the 40)', availExhib[p('p7')].minutesTrend.l3 === 20, availExhib[p('p7')].minutesTrend);

    const availSignalsReturn = await availability.buildAvailabilityRoleSignalsBulk([{ athleteId: p('p10'), team: 'BLKRET', targetGameStarter: null }], retDates[13]);
    check('8: real 2-game absence then 1 game played -> returning_after_absence, gamesSinceReturn=1', availSignalsReturn[p('p10')].returnStatus === 'returning_after_absence' && availSignalsReturn[p('p10')].gamesSinceReturn === 1, availSignalsReturn[p('p10')]);

    // ---------------- query-count budgets (1/15/100/500 fake players, all sharing the same fetched history) ----------------
    const origQuery = store.query.bind(store);
    async function countQueries(fn) {
      let n = 0;
      store.query = async (...args) => { n++; return origQuery(...args); };
      try { await fn(); } finally { store.query = origQuery; }
      return n;
    }
    for (const size of [1, 15, 100, 500]) {
      const req = Array.from({ length: size }, (_, i) => ({ athleteId: p('p1'), athleteName: 'X', team: 'BLKT', posGroup: 'G', unavailableTeammates: [{ athleteId: p('p2'), athleteName: 'Y', posGroup: 'G' }] }));
      const n = await countQueries(() => nextManUp.buildNextManUpSignalsBulk(req, asOfDate));
      check(`9.${size}: next-man-up bulk query count for ${size} (fake) players stays O(1) (${n} queries)`, n <= 2, `${n} queries`);
    }
  } finally {
    await store.run(`DELETE FROM nba_player_box WHERE athlete_id LIKE ?`, [`${TAG}-%`]);
  }

  console.log(`\n${failures === 0 ? 'ALL NBA SIGNAL BULK FIXTURE TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
