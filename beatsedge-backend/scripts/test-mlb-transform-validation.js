// Validates the transformed mlb_batter_game_stats/mlb_pitcher_game_stats
// rows (scripts/transform-mlb-pa-to-game-stats.js) by INDEPENDENTLY
// recomputing real totals directly from the raw plate-appearance rows for
// real sampled games, and comparing against what's now stored in
// beatsedge.db. This is a from-scratch recomputation, not a re-run of the
// transform script's own logic -- if the transform has a bug, this
// wouldn't share it.
//
//   node scripts/test-mlb-transform-validation.js

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

(async () => {
  const { DatabaseSync } = require('node:sqlite');
  const path = require('path');
  const { BEATSEDGE_DB_PATH, DATA_DIR } = require('../lib/dataPaths');
  const flameDb = new DatabaseSync(path.join(DATA_DIR, 'flame-mlb.db'));
  const destDb = new DatabaseSync(BEATSEDGE_DB_PATH);

  // ---------- aggregate counts ----------
  const batterCount = destDb.prepare(`SELECT COUNT(*) c FROM mlb_batter_game_stats WHERE source='flame-mlb-pa-transform'`).get().c;
  const pitcherCount = destDb.prepare(`SELECT COUNT(*) c FROM mlb_pitcher_game_stats WHERE source='flame-mlb-pa-transform'`).get().c;
  console.log('transformed rows in production tables:', batterCount, 'batter,', pitcherCount, 'pitcher');
  check('1: transformed batter rows present', batterCount === 145889, `actual: ${batterCount}`);
  check('2: transformed pitcher rows present', pitcherCount === 62193, `actual: ${pitcherCount}`);

  const dateRange = destDb.prepare(`SELECT MIN(game_date) mn, MAX(game_date) mx, COUNT(DISTINCT game_pk) games, COUNT(DISTINCT player_id) players FROM mlb_batter_game_stats WHERE source='flame-mlb-pa-transform'`).get();
  console.log('date range:', JSON.stringify(dateRange));
  check('3: date range spans 2022-2024 real seasons', dateRange.mn && dateRange.mn.startsWith('2022') && dateRange.mx && dateRange.mx.startsWith('2024'), JSON.stringify(dateRange));

  // ---------- duplicate identity check ----------
  const dupBatter = destDb.prepare(`SELECT game_pk, player_id, COUNT(*) c FROM mlb_batter_game_stats WHERE source='flame-mlb-pa-transform' GROUP BY game_pk, player_id HAVING c > 1`).all();
  const dupPitcher = destDb.prepare(`SELECT game_pk, player_id, COUNT(*) c FROM mlb_pitcher_game_stats WHERE source='flame-mlb-pa-transform' GROUP BY game_pk, player_id HAVING c > 1`).all();
  check('4: zero duplicate (game_pk, player_id) batter identities', dupBatter.length === 0, `${dupBatter.length} duplicates`);
  check('5: zero duplicate (game_pk, player_id) pitcher identities', dupPitcher.length === 0, `${dupPitcher.length} duplicates`);

  // ---------- real spot-checks: recompute directly from raw PA rows for 20 random real games ----------
  const sampleGames = flameDb.prepare(`SELECT DISTINCT game_pk FROM flame_mlb_plate_appearances ORDER BY RANDOM() LIMIT 20`).all().map(r => r.game_pk);
  let hitsOk = 0, tbOk = 0, rbiOk = 0, walksOk = 0, pitcherKsOk = 0, pitcherOutsOk = 0, totalChecked = 0;
  const mismatches = [];

  for (const gamePk of sampleGames) {
    const pas = flameDb.prepare(`SELECT batter_id, pitcher_id, event_type, rbi, outs_before, outs_after, is_hit, is_at_bat FROM flame_mlb_plate_appearances WHERE game_pk = ?`).all(gamePk);
    const batterIds = [...new Set(pas.map(p => p.batter_id).filter(Boolean))];
    for (const batterId of batterIds.slice(0, 2)) { // 2 real batters per sampled game
      const batterPas = pas.filter(p => p.batter_id === batterId);
      const realHits = batterPas.filter(p => p.is_hit).length;
      const realTB = batterPas.reduce((s, p) => s + ({ single: 1, double: 2, triple: 3, home_run: 4 }[p.event_type] || 0), 0);
      const realRBI = batterPas.reduce((s, p) => s + (p.rbi || 0), 0);
      const realWalks = batterPas.filter(p => p.event_type === 'walk' || p.event_type === 'intent_walk').length;

      const stored = destDb.prepare(`SELECT hits, total_bases, rbi, walks FROM mlb_batter_game_stats WHERE game_pk = ? AND player_id = ? AND source='flame-mlb-pa-transform'`).get(String(gamePk), String(batterId));
      if (!stored) continue;
      totalChecked++;
      if (stored.hits === realHits) hitsOk++; else mismatches.push({ type: 'hits', gamePk, batterId, real: realHits, stored: stored.hits });
      if (stored.total_bases === realTB) tbOk++; else mismatches.push({ type: 'total_bases', gamePk, batterId, real: realTB, stored: stored.total_bases });
      if (stored.rbi === realRBI) rbiOk++; else mismatches.push({ type: 'rbi', gamePk, batterId, real: realRBI, stored: stored.rbi });
      if (stored.walks === realWalks) walksOk++; else mismatches.push({ type: 'walks', gamePk, batterId, real: realWalks, stored: stored.walks });
    }

    const pitcherIds = [...new Set(pas.map(p => p.pitcher_id).filter(Boolean))];
    for (const pitcherId of pitcherIds.slice(0, 1)) { // 1 real pitcher per sampled game
      const pitcherPas = pas.filter(p => p.pitcher_id === pitcherId);
      const realKs = pitcherPas.filter(p => typeof p.event_type === 'string' && p.event_type.startsWith('strikeout')).length;
      const realOuts = pitcherPas.reduce((s, p) => s + Math.max(0, (p.outs_after || 0) - (p.outs_before || 0)), 0);

      const stored = destDb.prepare(`SELECT strikeouts, innings_pitched FROM mlb_pitcher_game_stats WHERE game_pk = ? AND player_id = ? AND source='flame-mlb-pa-transform'`).get(String(gamePk), String(pitcherId));
      if (!stored) continue;
      const storedOuts = Math.round(stored.innings_pitched) * 3 + Math.round((stored.innings_pitched % 1) * 10); // reverse the display formula for comparison only
      if (stored.strikeouts === realKs) pitcherKsOk++; else mismatches.push({ type: 'pitcherKs', gamePk, pitcherId, real: realKs, stored: stored.strikeouts });
      if (storedOuts === realOuts) pitcherOutsOk++; else mismatches.push({ type: 'pitcherOuts', gamePk, pitcherId, real: realOuts, stored: storedOuts, storedInningsPitched: stored.innings_pitched });
    }
  }

  console.log(`\nSpot-checked ${totalChecked} real batter-games (2 batters x 20 games) + ${sampleGames.length} pitcher samples, from-scratch recomputation vs stored values:`);
  check('6: Hits match from-scratch recomputation', hitsOk === totalChecked, `${hitsOk}/${totalChecked}`);
  check('7: Total Bases match from-scratch recomputation', tbOk === totalChecked, `${tbOk}/${totalChecked}`);
  check('8: RBIs match from-scratch recomputation', rbiOk === totalChecked, `${rbiOk}/${totalChecked}`);
  check('9: Batter Walks match from-scratch recomputation', walksOk === totalChecked, `${walksOk}/${totalChecked}`);
  check('10: Pitcher Ks match from-scratch recomputation', pitcherKsOk === sampleGames.length, `${pitcherKsOk}/${sampleGames.length}`);
  check('11: Pitcher Outs (derived from real outs_after-outs_before, NOT decimal-innings inference) match from-scratch recomputation', pitcherOutsOk === sampleGames.length, `${pitcherOutsOk}/${sampleGames.length}`);
  if (mismatches.length) console.log('mismatches:', JSON.stringify(mismatches.slice(0, 10), null, 2));

  // ---------- confirm runs/earned_runs were correctly left as gaps, not fabricated ----------
  const fabricatedRuns = destDb.prepare(`SELECT COUNT(*) c FROM mlb_batter_game_stats WHERE source='flame-mlb-pa-transform' AND runs IS NOT NULL`).get().c;
  const fabricatedER = destDb.prepare(`SELECT COUNT(*) c FROM mlb_pitcher_game_stats WHERE source='flame-mlb-pa-transform' AND earned_runs IS NOT NULL`).get().c;
  check('12: runs left NULL (documented data gap, never fabricated)', fabricatedRuns === 0, `${fabricatedRuns} non-null`);
  check('13: earned_runs left NULL (documented data gap, never fabricated)', fabricatedER === 0, `${fabricatedER} non-null`);

  console.log(`\n${failures === 0 ? 'ALL MLB TRANSFORM VALIDATION TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
