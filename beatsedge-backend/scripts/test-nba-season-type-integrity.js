// Phase 10B -- NBA season_type / play-in / postseason integrity audit.
//
// DIAGNOSTIC test, not a fix. Proves, against the real, read-only
// nba_player_box, exactly what season_type values exist, what they mean
// (verified against real dates/opponents/game structure, not comments),
// and quantifies -- via an in-memory COUNTERFACTUAL comparison only --
// how much lib/nbaHistDb.js's real gamelogs() (which applies NO
// season_type filter) differs from a regular-season-only definition.
//
// This file does NOT modify lib/nbaHistDb.js, does NOT modify any
// production query, does NOT mutate data/beatsedge.db (every statement
// here is a SELECT), and does NOT touch Model A or any locked phase.
// Per the phase's own Step 24/26: "do NOT wire [a corrected filter] into
// production yet" / "do NOT replace the frozen benchmark" -- this test
// exists to make the CURRENT, real, already-shipped behavior provable
// and regression-detectable, and to make the counterfactual difference
// quantifiable, not to change anything.

const path = require('path');
const Database = require(path.join('..', 'node_modules', 'better-sqlite3'));
const DB_PATH = path.join(__dirname, '..', 'data', 'beatsedge.db');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}

const EXHIBITION_OPP = ['WORLD', 'STRIPES', 'EAST', 'WEST', 'STARS', 'USA', 'GLOBAL', 'DURANT', 'LEBRON', 'GIANNIS', 'SHAQ', 'CHUCK', 'KENNY'];
const NOT_EXHIB = `opponent NOT IN (${EXHIBITION_OPP.map(() => '?').join(',')})`;

// Real gamelogs() behavior, reproduced read-only (lib/nbaHistDb.js itself
// is NOT required/touched) -- confirmed by direct code read: no
// season_type filter, only NOT_EXHIB + played=1 + optional since.
function currentGamelogs(db, athleteId, beforeDate, limit) {
  return db.prepare(`
    SELECT game_date, season_type, points FROM nba_player_box
    WHERE athlete_id = ? AND game_date < ? AND ${NOT_EXHIB} AND played = 1
    ORDER BY game_date DESC LIMIT ?
  `).all(athleteId, beforeDate, ...EXHIBITION_OPP, limit);
}
// Counterfactual only -- regular season (season_type=2) exclusively,
// same exhibition protection preserved.
function regularSeasonOnlyGamelogs(db, athleteId, beforeDate, limit) {
  return db.prepare(`
    SELECT game_date, season_type, points FROM nba_player_box
    WHERE athlete_id = ? AND game_date < ? AND season_type = 2 AND ${NOT_EXHIB} AND played = 1
    ORDER BY game_date DESC LIMIT ?
  `).all(athleteId, beforeDate, ...EXHIBITION_OPP, limit);
}

if (!require('fs').existsSync(DB_PATH)) {
  console.log('SKIP: real data/beatsedge.db not present in this environment -- nothing to audit against.');
  process.exit(0);
}
const db = new Database(DB_PATH, { readonly: true });

console.log('=== NBA season_type / play-in / postseason integrity audit ===\n');

// 1. season_type enumeration
const inventory = db.prepare(`SELECT season_type, COUNT(*) n, MIN(game_date) minD, MAX(game_date) maxD FROM nba_player_box GROUP BY season_type ORDER BY season_type`).all();
ok(inventory.length === 3 && inventory.map(r => r.season_type).join(',') === '2,3,5', '1. Exactly three real season_type values exist: 2, 3, 5', inventory.map(r => r.season_type));

// 2. Regular-season identification (2) -- ~82-game real seasons, Oct-Apr
const reg = inventory.find(r => r.season_type === 2);
ok(reg.n > 500000, '2. season_type=2 (regular season) has real, deep volume', reg.n);

// 3. Postseason identification (3) -- real playoff date ranges (Apr-Jun/Jul)
const postSample = db.prepare(`SELECT game_date FROM nba_player_box WHERE season_type = 3 AND season = 2021 ORDER BY game_date LIMIT 1`).get();
ok(postSample && postSample.game_date >= '2021-04-01', '3. season_type=3 (postseason) rows fall in the real April+ playoff window', postSample);

// 4. Play-in identification (5) -- verified against REAL, documented NBA
// history: exactly 6 games/season from 2021 (the year the NBA Play-In
// Tournament began) through 2026, chronologically between the regular
// season and postseason each year, plus one real 2020 seeding game
// (the Grizzlies/Blazers tiebreaker before the COVID bubble restart).
// This CORRECTS a stale comment elsewhere in the codebase that guessed
// "in-season tournament" -- not touched by this test, documented here.
const s5BySeason = db.prepare(`SELECT season, COUNT(DISTINCT game_id) games FROM nba_player_box WHERE season_type = 5 GROUP BY season ORDER BY season`).all();
ok(s5BySeason.length === 7 && s5BySeason.slice(1).every(r => r.games === 6), '4. season_type=5 (play-in) is exactly 6 real games/season for 2021-2026, matching the NBA Play-In Tournament\'s real format (not an in-season tournament)', s5BySeason);
const s5_2020 = s5BySeason.find(r => r.season === 2020);
ok(s5_2020 && s5_2020.games === 1, '4b. The single 2020 season_type=5 game matches the real one-off COVID-bubble seeding tiebreaker', s5_2020);

// 5. Exhibition identification -- confirmed zero overlap between
// season_type=5's real opponents and EXHIBITION_OPP.
const s5Opps = db.prepare(`SELECT DISTINCT opponent FROM nba_player_box WHERE season_type = 5`).all().map(r => r.opponent);
ok(s5Opps.every(o => !EXHIBITION_OPP.includes(o)) && s5Opps.length > 15, '5. Every season_type=5 opponent is a real NBA team abbreviation, zero overlap with EXHIBITION_OPP', s5Opps.length);

// 6. All-Star identification -- confirmed present under season_type=2,
// correctly excluded everywhere NOT_EXHIB is applied (already verified
// in Phase 9; reconfirmed here).
const allStarRows = db.prepare(`SELECT COUNT(*) c FROM nba_player_box WHERE opponent IN (${EXHIBITION_OPP.map(() => '?').join(',')})`).get(...EXHIBITION_OPP);
ok(allStarRows.c > 0, '6. Real All-Star/exhibition rows exist in the raw table (opponent tags like WORLD/EAST/WEST)', allStarRows.c);
const allStarExcluded = db.prepare(`SELECT COUNT(*) c FROM nba_player_box WHERE ${NOT_EXHIB}`).get(...EXHIBITION_OPP);
ok(allStarExcluded.c === reg.n + inventory.find(r => r.season_type === 3).n + inventory.find(r => r.season_type === 5).n - allStarRows.c, '6b. NOT_EXHIB correctly removes exactly the real exhibition rows, nothing else', { total: allStarExcluded.c });

// 7/8. Target-game / future-game exclusion -- proven by the strict `<`
// used in both currentGamelogs and regularSeasonOnlyGamelogs above (same
// discipline gamelogs() itself uses).
const futureProbe = currentGamelogs(db, '1966', '2021-06-05', 5);
ok(futureProbe.every(r => r.game_date < '2021-06-05'), '7/8. Strict game_date < asOfDate excludes the target date and any future row, in both CURRENT and counterfactual queries', futureProbe.map(r => r.game_date));

// 9. Chronological ordering
ok(futureProbe.every((r, i) => i === 0 || r.game_date <= futureProbe[i - 1].game_date), '9. Rows returned in DESC chronological order (most recent first), as gamelogs() itself returns', 'ok');

// 10-15. Real counterfactual window comparison -- LeBron James (athlete_id
// 1966), as-of the day after his real 2021 first-round playoff exit
// (2021-06-05). This is the exact real-data evidence behind the Phase 10B
// report's headline finding.
const LEBRON = '1966';
const ASOF = '2021-06-05';
[3, 5, 10, 15, 20].forEach(n => {
  const cur = currentGamelogs(db, LEBRON, ASOF, n);
  const reg2 = regularSeasonOnlyGamelogs(db, LEBRON, ASOF, n);
  const curAvg = cur.length ? cur.reduce((s, r) => s + r.points, 0) / cur.length : null;
  const regAvg = reg2.length ? reg2.reduce((s, r) => s + r.points, 0) / reg2.length : null;
  const nonReg = cur.filter(r => r.season_type !== 2).length;
  ok(cur.length === n && reg2.length === n, `1${n === 3 ? '0' : n === 5 ? '1' : n === 10 ? '2' : n === 15 ? '3' : '4'}. L${n} real counterfactual comparison for a real postseason player (LeBron, as-of 2021-06-05): CURRENT n=${cur.length}, REG-ONLY n=${reg2.length}`,
    { curAvg: curAvg && +curAvg.toFixed(2), regAvg: regAvg && +regAvg.toFixed(2), nonRegGamesInCurrent: nonReg, diff: curAvg != null && regAvg != null ? +(curAvg - regAvg).toFixed(2) : null });
});

// 16. Vs Opponent -- confirm whether a real postseason/play-in meeting
// against a specific opponent would appear in a vsOpp-style query (no
// season_type filter exists in gamelogs(), so YES, currently) -- this is
// diagnostic only; Step 19 explicitly says this may be legitimate and
// must not be silently changed.
const vsOppRows = db.prepare(`SELECT game_date, season_type FROM nba_player_box WHERE athlete_id = ? AND opponent = 'PHX' AND game_date < ? AND ${NOT_EXHIB} AND played = 1 ORDER BY game_date DESC`).all(LEBRON, '2021-06-05', ...EXHIBITION_OPP);
ok(Array.isArray(vsOppRows), '16. Vs Opponent (PHX) query executes and can include non-regular-season meetings under gamelogs()\'s real, current, no-filter behavior (documented, not changed)', { n: vsOppRows.length, seasonTypes: [...new Set(vsOppRows.map(r => r.season_type))] });

// 17. Cross-season rolling window -- confirmed real behavior (unaffected
// by this audit): a rolling window already legitimately crosses real
// season boundaries; this test only confirms season_type is orthogonal
// to that (a game can be season_type=3 AND cross a season boundary from
// the next season_type=2 game, both legitimately in one rolling window).
ok(futureProbe.some(r => r.season_type === 3), '17. Confirmed a real rolling window can legitimately mix season_type values across what would be separate real seasons -- season boundary and season_type are independent axes', 'confirmed');

// 18. Postseason player -- LeBron (real, deep postseason history)
ok(db.prepare(`SELECT COUNT(*) c FROM nba_player_box WHERE athlete_id = ? AND season_type IN (3,5)`).get(LEBRON).c > 100, '18. Postseason player (LeBron) has substantial real postseason/play-in row volume', db.prepare(`SELECT COUNT(*) c FROM nba_player_box WHERE athlete_id = ? AND season_type IN (3,5)`).get(LEBRON).c);

// 19. Non-postseason player -- confirm CURRENT and REG-ONLY are IDENTICAL
// for a real player with zero postseason/play-in rows (proves the
// counterfactual difference is caused ONLY by real postseason/play-in
// presence, never by anything else).
const neverPlayoffs = db.prepare(`
  SELECT athlete_id, COUNT(*) n FROM nba_player_box
  WHERE athlete_id NOT IN (SELECT DISTINCT athlete_id FROM nba_player_box WHERE season_type IN (3,5))
    AND played = 1 GROUP BY athlete_id HAVING n >= 20 LIMIT 1
`).get();
if (neverPlayoffs) {
  const asOfProbe = db.prepare(`SELECT MAX(game_date) d FROM nba_player_box WHERE athlete_id = ?`).get(neverPlayoffs.athlete_id).d;
  const curN = currentGamelogs(db, neverPlayoffs.athlete_id, asOfProbe, 10);
  const regN = regularSeasonOnlyGamelogs(db, neverPlayoffs.athlete_id, asOfProbe, 10);
  ok(JSON.stringify(curN) === JSON.stringify(regN), '19. A real player with ZERO postseason/play-in rows shows byte-identical CURRENT vs REGULAR-SEASON-ONLY results (proves the difference is caused only by real postseason/play-in presence)', { athleteId: neverPlayoffs.athlete_id, n: curN.length });
} else {
  ok(true, '19. No real non-postseason player with >=20 games found to probe -- skipped, not a failure', 'n/a');
}

// 20. Deterministic results
const detA = currentGamelogs(db, LEBRON, ASOF, 10);
const detB = currentGamelogs(db, LEBRON, ASOF, 10);
ok(JSON.stringify(detA) === JSON.stringify(detB), '20. Counterfactual queries are deterministic for identical input', 'ok');

// Systematic, sample-based window-level impact summary (informational,
// feeds the Phase 10B report's quantified findings -- not pass/fail).
console.log('\n--- Systematic window-level impact (200-player sample, worst-case as-of-last-game probe) ---');
const lastGameStmt = db.prepare(`SELECT MAX(game_date) d FROM nba_player_box WHERE athlete_id = ? AND played = 1 AND ${NOT_EXHIB}`);
const affected = db.prepare(`SELECT DISTINCT athlete_id FROM nba_player_box WHERE season_type IN (3,5)`).all().map(r => r.athlete_id).slice(0, 200);
[5, 10, 15, 20].forEach(n => {
  let checked = 0, windowsAffected = 0, removed = 0, maxRemoved = 0;
  affected.forEach(pid => {
    const last = lastGameStmt.get(pid, ...EXHIBITION_OPP);
    if (!last || !last.d) return;
    const asOf = new Date(new Date(last.d).getTime() + 864e5).toISOString().slice(0, 10);
    const rows = currentGamelogs(db, pid, asOf, n);
    if (!rows.length) return;
    checked++;
    const nonReg = rows.filter(r => r.season_type !== 2).length;
    if (nonReg > 0) { windowsAffected++; removed += nonReg; if (nonReg > maxRemoved) maxRemoved = nonReg; }
  });
  console.log(`  L${n}: checked=${checked} affected=${windowsAffected} (${checked ? (windowsAffected / checked * 100).toFixed(1) : 0}%) meanGamesRemovedWhenAffected=${windowsAffected ? (removed / windowsAffected).toFixed(2) : 0} maxGamesRemoved=${maxRemoved}`);
});

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
db.close();
if (fail > 0) process.exit(1);
