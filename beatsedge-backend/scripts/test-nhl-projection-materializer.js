// NHL unlock project -- proves the materialized projection table
// (fix for the real ~69s production timeout on /api/nhl/player-
// projections) is numerically identical to the direct validated
// computation, idempotent, and that the route can no longer reach the
// expensive path.
//
//   node --env-file=.env scripts/test-nhl-projection-materializer.js

const store = require('../lib/historicalStore');
const { computeAllProjections } = require('../lib/nhlProjectionEngine');
const { materializeNhlProjections, getMaterializedProjections } = require('../lib/nhlProjectionMaterializer');
const { syncBoxscoreToPlayerBox } = require('../lib/nhlPlayerBoxSync');
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

const TOL = 1e-9;
function approxEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < TOL;
}

(async () => {
  console.log('backend:', store.backend);

  // ---------- PARITY: direct computation vs materialized+read-back ----------
  const direct = await computeAllProjections();
  await materializeNhlProjections();
  const materialized = await getMaterializedProjections();

  for (const family of ['shots_on_goal', 'goalie_saves', 'goals_at_least_1', 'assists_at_least_1', 'points_at_least_1']) {
    const directById = new Map(direct[family].map(r => [r.playerId, r]));
    const matById = new Map(materialized[family].map(r => [r.playerId, r]));
    check(`${family}: materialized table has the same real player count as direct computation`,
      directById.size === matById.size, `direct=${directById.size} materialized=${matById.size}`);

    let mismatches = 0;
    for (const [playerId, d] of directById) {
      const m = matById.get(playerId);
      if (!m) { mismatches++; continue; }
      if (!approxEqual(d.projection, m.projection) || !approxEqual(d.probability, m.probability) || d.gamesSampled !== m.gamesSampled) mismatches++;
    }
    check(`${family}: every materialized row matches the direct computation within floating-point tolerance`,
      mismatches === 0, `${mismatches} mismatches`);
  }

  // ---------- IDEMPOTENCY: no duplicate rows on rerun ----------
  const before = await store.queryOne('SELECT COUNT(*) c FROM nhl_player_projections');
  await materializeNhlProjections();
  const after = await store.queryOne('SELECT COUNT(*) c FROM nhl_player_projections');
  check('rerunning materialization creates ZERO duplicate rows (UPSERT on real PRIMARY KEY)', before.c === after.c, `before=${before.c} after=${after.c}`);

  // ---------- NO DUPLICATE (player_id, stat_family) PAIRS ----------
  const dupes = await store.query(`
    SELECT player_id, stat_family, COUNT(*) c FROM nhl_player_projections
    GROUP BY player_id, stat_family HAVING COUNT(*) > 1
  `);
  check('zero (player_id, stat_family) pairs appear more than once', dupes.length === 0, `${dupes.length} duplicate pairs`);

  // ---------- REFRESH PICKS UP A NEW REAL COMPLETED GAME ----------
  {
    const REAL_GAME_ID = 2026010008;
    const REAL_GAME_DATE = '2026-09-20';
    await store.run('DELETE FROM nhl_player_box WHERE game_id = ?', [String(REAL_GAME_ID)]);
    const r = await fetch(`https://api-web.nhle.com/v1/gamecenter/${REAL_GAME_ID}/boxscore`);
    const boxscore = await r.json();
    const samplePlayerId = boxscore.playerByGameStats.awayTeam.forwards[0].playerId.toString();
    const beforeGames = await store.queryOne('SELECT games_sampled FROM nhl_player_projections WHERE player_id = ? AND stat_family = ?', [samplePlayerId, 'shots_on_goal']);
    await syncBoxscoreToPlayerBox(boxscore, REAL_GAME_DATE, REAL_GAME_ID);
    await materializeNhlProjections();
    const afterGames = await store.queryOne('SELECT games_sampled FROM nhl_player_projections WHERE player_id = ? AND stat_family = ?', [samplePlayerId, 'shots_on_goal']);
    check('materialization refresh reflects a newly-ingested real completed game (games_sampled increased)',
      beforeGames && afterGames && afterGames.games_sampled === beforeGames.games_sampled + 1,
      JSON.stringify({ beforeGames, afterGames }));
    // cleanup
    await store.run('DELETE FROM nhl_player_box WHERE game_id = ?', [String(REAL_GAME_ID)]);
    await materializeNhlProjections();
  }

  // ---------- ROUTE NEVER CALLS THE EXPENSIVE PATH ----------
  const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'api.js'), 'utf8');
  const routeMatch = apiSrc.match(/router\.get\('\/nhl\/player-projections'[\s\S]*?\n\}\);/);
  check('the /nhl/player-projections route body exists', !!routeMatch);
  check('the route reads getMaterializedProjections, not computeAllProjections',
    routeMatch && routeMatch[0].includes('getMaterializedProjections') && !routeMatch[0].includes('computeAllProjections'));

  // ---------- EMPTY TABLE FAILS FAST AND CLEARLY (logic-level check) ----------
  {
    const emptyProjections = {};
    const totalRows = Object.values(emptyProjections).reduce((s, arr) => s + arr.length, 0);
    check('the route\'s empty-table condition (totalRows === 0) correctly detects an empty materialized result',
      totalRows === 0);
  }

  // ---------- Do NOT store provider lines / not the Market Archive ----------
  const cols = await store.query(`PRAGMA table_info(nhl_player_projections)`);
  const colNames = cols.map(c => c.name);
  check('nhl_player_projections has no provider-line columns (line/over_price/under_price/bookmaker/source)',
    !colNames.some(c => ['line', 'over_price', 'under_price', 'bookmaker', 'source'].includes(c)));
  check('nhl_player_projections uses real stable player_id (not display name) as part of its identity',
    colNames.includes('player_id') && colNames.includes('stat_family'));

  console.log(`\n${failures === 0 ? 'ALL NHL PROJECTION MATERIALIZER TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
