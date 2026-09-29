// Model-parity check: proves lib/historicalStore.js's new async adapter
// returns rows IDENTICAL to the existing sync lib/db.js / lib/mlbDb.js /
// lib/nflDb.js modules for the same real data.
//
// Two modes, auto-detected via store.backend:
//   - SQLITE backend (no TURSO_HISTORICAL_* set): old and new point at the
//     literal same physical file, so every check expects BYTE-IDENTICAL
//     full-table results -- the original Phase 1 design.
//   - TURSO backend (Phase 5 production migration complete): new/Turso
//     deliberately holds only the APPROVED RETENTION WINDOW (current +
//     N prior seasons per sport -- see scripts/migrate-historical-to-
//     turso.js's RETENTION_SEASONS_BACK), while old/local still holds full
//     history. A naive full-table comparison would show them "different"
//     forever by DESIGN, not by defect -- so in this mode every check
//     restricts the OLD (local) query to the exact same season range
//     actually present in NEW (Turso) before comparing, which is the
//     correct definition of parity once retention is a deliberate,
//     approved design decision rather than an accident.
//
//   node scripts/test-historical-store-parity.js                (sqlite mode)
//   node --env-file=.env scripts/test-historical-store-parity.js (turso mode)

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

(async () => {
  const oldNflDb = require('../lib/nflDb');
  const oldNbaDb = require('../lib/db');
  const oldMlbDb = require('../lib/mlbDb');
  const store = require('../lib/historicalStore');

  const TURSO_MODE = store.backend === 'turso';
  console.log('historicalStore backend:', store.backend, TURSO_MODE ? '(retention-aware parity mode)' : '(expected: sqlite, byte-identical mode)');

  // ---------- 1. NFL: Christian McCaffrey, all weeks within the retained window ----------
  {
    const seasonFilter = TURSO_MODE ? `AND season IN (${(await store.query(`SELECT DISTINCT season FROM nfl_player_game_stats`)).map(r => r.season).join(',')})` : '';
    const oldRows = oldNflDb.prepare(`SELECT season, week, player_name, rush_attempts, pass_attempts, completions, rushing_yards FROM nfl_player_game_stats WHERE player_name LIKE '%McCaffrey%' ${seasonFilter} ORDER BY season, week`).all();
    const newRows = await store.query(`SELECT season, week, player_name, rush_attempts, pass_attempts, completions, rushing_yards FROM nfl_player_game_stats WHERE player_name LIKE '%McCaffrey%' ORDER BY season, week`);
    check('1: NFL McCaffrey rows identical within the retained season range (old sync vs new async)', JSON.stringify(oldRows) === JSON.stringify(newRows), `old n=${oldRows.length} new n=${newRows.length}`);
  }

  // ---------- 2. NFL: aggregate counts match within the retained season range ----------
  {
    const seasons = TURSO_MODE ? (await store.query(`SELECT DISTINCT season FROM nfl_player_game_stats`)).map(r => r.season) : [2022, 2023, 2024];
    const seasonList = seasons.join(',');
    const oldCount = oldNflDb.prepare(`SELECT COUNT(*) c, SUM(rush_attempts) sumRush FROM nfl_player_game_stats WHERE season IN (${seasonList})`).get();
    const newCount = TURSO_MODE
      ? await store.queryOne(`SELECT COUNT(*) c, SUM(rush_attempts) sumRush FROM nfl_player_game_stats`)
      : await store.queryOne(`SELECT COUNT(*) c, SUM(rush_attempts) sumRush FROM nfl_player_game_stats WHERE season IN (${seasonList})`);
    check('2: NFL row count + rush_attempts sum identical within the retained season range', oldCount.c === newCount.c && oldCount.sumRush === newCount.sumRush, `old=${JSON.stringify(oldCount)} new=${JSON.stringify(newCount)}`);
  }

  // ---------- 3. NBA: a real player's game log within the retained season range ----------
  {
    const newSeasons = TURSO_MODE ? (await store.query(`SELECT DISTINCT season FROM nba_player_box`)).map(r => r.season) : null;
    const samplePlayer = await store.queryOne(`SELECT athlete_id FROM nba_player_box WHERE played=1 LIMIT 1`);
    const seasonFilter = TURSO_MODE ? `AND season IN (${newSeasons.join(',')})` : '';
    const oldRows = oldNbaDb.prepare(`SELECT game_id, athlete_id, game_date, points, rebounds, assists, minutes FROM nba_player_box WHERE athlete_id=? ${seasonFilter} ORDER BY game_date`).all(samplePlayer.athlete_id);
    const newRows = await store.query(`SELECT game_id, athlete_id, game_date, points, rebounds, assists, minutes FROM nba_player_box WHERE athlete_id=? ORDER BY game_date`, [samplePlayer.athlete_id]);
    check('3: NBA sample player game log identical within the retained season range (old sync vs new async)', JSON.stringify(oldRows) === JSON.stringify(newRows), `old n=${oldRows.length} new n=${newRows.length}`);
  }

  // ---------- 4. MLB: real batter rows within the retained date range ----------
  {
    let oldRows, newRows;
    if (TURSO_MODE) {
      const minDate = (await store.queryOne(`SELECT MIN(game_date) d FROM mlb_batter_game_stats`)).d;
      oldRows = oldMlbDb.prepare(`SELECT game_pk, player_id, player_name, hits, total_bases, rbi FROM mlb_batter_game_stats WHERE game_date >= ? ORDER BY game_date, player_id LIMIT 200`).all(minDate);
      newRows = await store.query(`SELECT game_pk, player_id, player_name, hits, total_bases, rbi FROM mlb_batter_game_stats WHERE game_date >= ? ORDER BY game_date, player_id LIMIT 200`, [minDate]);
    } else {
      oldRows = oldMlbDb.prepare(`SELECT game_pk, player_id, player_name, hits, total_bases, rbi FROM mlb_batter_game_stats ORDER BY game_date, player_id LIMIT 200`).all();
      newRows = await store.query(`SELECT game_pk, player_id, player_name, hits, total_bases, rbi FROM mlb_batter_game_stats ORDER BY game_date, player_id LIMIT 200`);
    }
    check('4: MLB batter rows identical within the retained date range (old sync vs new async)', JSON.stringify(oldRows) === JSON.stringify(newRows), `old n=${oldRows.length} new n=${newRows.length}`);
  }

  // ---------- 5. Row counts match within the retained window, per table ----------
  {
    // Mirrors scripts/migrate-historical-to-turso.js's own RETENTION_SEASON_COL
    // map exactly -- the same real per-table season/date column used to
    // decide what was migrated, not a re-guessed one.
    const SEASON_COL = {
      nba_player_box: 'season', wnba_player_box: 'season', nfl_player_game_stats: 'season',
      nfl_defense_by_position: null, // rollup table, not season-scoped -- full parity always expected
      mlb_batter_game_stats: "CAST(substr(game_date,1,4) AS INTEGER)", mlb_pitcher_game_stats: "CAST(substr(game_date,1,4) AS INTEGER)",
    };
    const tables = ['nba_player_box', 'wnba_player_box', 'nfl_player_game_stats', 'nfl_defense_by_position', 'mlb_batter_game_stats', 'mlb_pitcher_game_stats'];
    let allMatch = true;
    const details = {};
    for (const t of tables) {
      const newC = (await store.queryOne(`SELECT COUNT(*) c FROM "${t}"`)).c;
      let oldC;
      const col = SEASON_COL[t];
      if (TURSO_MODE && col) {
        const newSeasons = (await store.query(`SELECT DISTINCT ${col} s FROM "${t}"`)).map(r => r.s);
        oldC = oldNbaDb.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE ${col} IN (${newSeasons.join(',')})`).get().c;
      } else {
        oldC = oldNbaDb.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
      }
      details[t] = { old: oldC, new: newC };
      if (oldC !== newC) allMatch = false;
    }
    check('5: row counts identical within the retained window, per table', allMatch, JSON.stringify(details));
  }

  if (!TURSO_MODE) {
    console.log('NOTE: this run only exercised the SQLite-backend half. Run with `node --env-file=.env scripts/test-historical-store-parity.js` (real Turso configured) for the retention-aware Turso-backend half.');
  }

  console.log(`\n${failures === 0 ? `ALL PARITY TESTS PASSED (${TURSO_MODE ? 'Turso' : 'SQLite'}-backend)` : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
