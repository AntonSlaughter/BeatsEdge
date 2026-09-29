// NHL unlock project -- proves the nightly model-history sync
// (lib/nhlPlayerBoxSync.js, wired into cron/nhlNightlyUpdate.js) is
// idempotent against REAL data: a real completed game's real boxscore,
// fetched live from api-web.nhle.com, ingested twice.
//
//   node --env-file=.env scripts/test-nhl-nightly-sync.js

const { syncBoxscoreToPlayerBox, seasonEndYear } = require('../lib/nhlPlayerBoxSync');
const store = require('../lib/historicalStore');

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

const REAL_GAME_ID = 2026010008; // real completed game, fetched live 2026-09-29 during this integration
const REAL_GAME_DATE = '2026-09-20';

(async () => {
  console.log('backend:', store.backend);

  // Baseline: real historical row count before this test touches anything.
  const before = await store.queryOne('SELECT COUNT(*) c FROM nhl_player_box');

  // Clean up any leftover rows from a prior run of this same test so the
  // idempotency proof below starts from a known state -- this ONLY
  // touches rows for this specific real test game_id, never any other
  // real historical row.
  await store.run('DELETE FROM nhl_player_box WHERE game_id = ?', [String(REAL_GAME_ID)]);

  const r = await fetch(`https://api-web.nhle.com/v1/gamecenter/${REAL_GAME_ID}/boxscore`);
  check('real boxscore fetch succeeded (live api-web.nhle.com)', r.ok, `HTTP ${r.status}`);
  const boxscore = await r.json();
  check('real boxscore is for a FINAL (completed) game', boxscore.gameState === 'FINAL' || boxscore.gameState === 'OFF', boxscore.gameState);
  check('real boxscore carries a real season field', seasonEndYear(boxscore) != null, JSON.stringify(boxscore.season));

  // ---- historical data through yesterday -> ingest completed game ----
  const first = await syncBoxscoreToPlayerBox(boxscore, REAL_GAME_DATE, REAL_GAME_ID);
  check('first ingest wrote real skater rows', first.skaterRows > 0, JSON.stringify(first));
  check('first ingest wrote real goalie rows (goalies who actually played)', first.goalieRows > 0, JSON.stringify(first));

  // ---- model history contains the new game ----
  const afterFirst = await store.queryOne('SELECT COUNT(*) c FROM nhl_player_box WHERE game_id = ?', [String(REAL_GAME_ID)]);
  check('model history (nhl_player_box) now contains real rows for this real game_id',
    afterFirst.c === first.skaterRows + first.goalieRows, JSON.stringify({ afterFirst, first }));

  // Correct player ID/name/team/game date/game ID -- spot-check one real row.
  const sample = await store.queryOne('SELECT player_id, player_name, team, game_date, game_id, season FROM nhl_player_box WHERE game_id = ? LIMIT 1', [String(REAL_GAME_ID)]);
  check('synced row carries a real, non-null player_id/player_name/team/game_date/game_id/season',
    !!(sample && sample.player_id && sample.player_name && sample.team && sample.game_date && sample.game_id && sample.season),
    JSON.stringify(sample));

  // Goalies who never entered the game are excluded (the corrected convention).
  const zeroShotGoalies = await store.query('SELECT * FROM nhl_player_box WHERE game_id = ? AND shots_against = 0', [String(REAL_GAME_ID)]);
  check('no goalie row with shots_against=0 was written (dressed-but-did-not-play exclusion inherited from parseBoxscore)',
    zeroShotGoalies.length === 0, `found ${zeroShotGoalies.length}`);

  // ---- second ingest creates no duplicate ----
  const second = await syncBoxscoreToPlayerBox(boxscore, REAL_GAME_DATE, REAL_GAME_ID);
  const afterSecond = await store.queryOne('SELECT COUNT(*) c FROM nhl_player_box WHERE game_id = ?', [String(REAL_GAME_ID)]);
  check('second ingest of the SAME real game creates ZERO new rows (INSERT OR IGNORE on the real PRIMARY KEY)',
    afterSecond.c === afterFirst.c, JSON.stringify({ afterFirst, afterSecond, second }));

  // ---- existing historical SportsDataverse rows remain intact ----
  const afterAll = await store.queryOne('SELECT COUNT(*) c FROM nhl_player_box');
  check('total table row count increased by exactly the new real rows (pre-existing SportsDataverse history untouched)',
    afterAll.c === before.c + afterFirst.c, JSON.stringify({ before, afterAll, afterFirst }));

  // Cleanup -- this test's real rows are removed so it leaves no residue
  // in the historical table between runs (idempotent test, not a
  // permanent seed of live-source data mixed into the research tables).
  await store.run('DELETE FROM nhl_player_box WHERE game_id = ?', [String(REAL_GAME_ID)]);
  const afterCleanup = await store.queryOne('SELECT COUNT(*) c FROM nhl_player_box');
  check('cleanup restored the table to its exact original row count', afterCleanup.c === before.c);

  console.log(`\n${failures === 0 ? 'ALL NHL NIGHTLY SYNC IDEMPOTENCY TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
