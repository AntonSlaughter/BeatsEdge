// NHL unlock project -- tests for lib/nhlProviderLineArchive.js and
// lib/nhlMarketMapping.js. Mirrors the conventions in
// scripts/test-archive-hardening.js (checks K/L/M/O) scoped to NHL, kept
// as its own file so the existing, already-passing archive-hardening
// suite for other sports is never touched.
//
//   node --env-file=.env scripts/test-nhl-market-archive.js

const store = require('../lib/snapshotStore');
const nhlArchive = require('../lib/nhlProviderLineArchive');
const { classifyNhlMarket } = require('../lib/nhlMarketMapping');

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

(async () => {
  // ---------- archive: props-path matcher only matches icehockey_nhl ----------
  check('archive path matcher matches icehockey_nhl and rejects other sports',
    nhlArchive.isNhlPropsPath('v1/sports/icehockey_nhl/props') === true && nhlArchive.isNhlPropsPath('v1/sports/basketball_nba/props') === false);

  // ---------- archive: identity/change-field contract matches the shared factory ----------
  check('nhl archive IDENTITY_COLS matches the shared factory contract',
    JSON.stringify(nhlArchive.IDENTITY_COLS) === JSON.stringify(['sport', 'event_id', 'player_raw', 'market_key_raw', 'source', 'projection_type', 'period', 'side']));
  check('nhl archive CHANGE_FIELDS matches the shared factory contract',
    JSON.stringify(nhlArchive.CHANGE_FIELDS) === JSON.stringify(['line', 'over_price', 'under_price', 'provider_last_update', 'game_status', 'market_label']));

  // ---------- archive: cross-sport isolation ----------
  {
    await nhlArchive.recordObservation({
      capturedAt: Date.now(), sport: 'nhl', eventId: 'TEST_EVENT_NHL_HARDENING', homeTeam: 'TEST_HOME', awayTeam: 'TEST_AWAY',
      commenceTime: new Date(Date.now() + 3600000).toISOString(), playerRaw: 'Test Player NHL', marketKeyRaw: 'player_shots_on_goal',
      source: 'draftkings', sourceType: 'sportsbook', line: 2.5, overPrice: -110, underPrice: -110, raw: { test: true },
    });
    const inNhl = await store.queryOne(`SELECT COUNT(*) c FROM nhl_provider_line_archive WHERE event_id IS 'TEST_EVENT_NHL_HARDENING'`);
    const inNba = await store.queryOne(`SELECT COUNT(*) c FROM nba_provider_line_archive WHERE event_id IS 'TEST_EVENT_NHL_HARDENING'`);
    check('a synthetic NHL test row never appears in the NBA table', inNhl.c === 1 && inNba.c === 0);
    await store.run(`DELETE FROM nhl_provider_line_archive WHERE event_id IS 'TEST_EVENT_NHL_HARDENING'`);
  }

  // ---------- archive: unsupported/unmapped market still archives verbatim ----------
  {
    const body = JSON.stringify([
      { event_id: 'TEST_NHL_UNMAPPED', player: 'Obscure NHL Player', market_key: 'player_first_goal_scorer', bookmaker: 'fanduel', line: 0, over_price: 450 },
    ]);
    const r = await nhlArchive.archiveFromRawParlayResponse('v1/sports/icehockey_nhl/props', body);
    const row = await store.queryOne(`SELECT market_key_raw FROM nhl_provider_line_archive WHERE event_id IS 'TEST_NHL_UNMAPPED'`);
    check('an unmapped real NHL market_key (first_goal_scorer) is still archived verbatim, not dropped',
      r.archived === 1 && row && row.market_key_raw === 'player_first_goal_scorer');
    await store.run(`DELETE FROM nhl_provider_line_archive WHERE event_id IS 'TEST_NHL_UNMAPPED'`);
  }

  // ---------- classification: MODEL_CANDIDATE only for validated FULL-game families ----------
  check('player_shots_on_goal (FULL) classifies MODEL_CANDIDATE / shots_on_goal',
    classifyNhlMarket('player_shots_on_goal', 2.5, 'FULL').bucket === 'MODEL_CANDIDATE'
    && classifyNhlMarket('player_shots_on_goal', 2.5, 'FULL').statKey === 'shots_on_goal');
  check('player_saves (FULL) classifies MODEL_CANDIDATE / goalie_saves',
    classifyNhlMarket('player_saves', 24.5, 'FULL').bucket === 'MODEL_CANDIDATE'
    && classifyNhlMarket('player_saves', 24.5, 'FULL').statKey === 'goalie_saves');

  // ---------- classification: P1 variant of a validated stat is NOT promoted ----------
  check('player_shots_on_goal_1st_period (P1) does NOT reuse the FULL-game model',
    classifyNhlMarket('player_shots_on_goal_1st_period', 0.5, 'P1').bucket === 'UNMAPPED');
  check('player_shots_on_goal itself under period=P1 falls back to UNMAPPED (validated model is FULL-game only)',
    classifyNhlMarket('player_shots_on_goal', 2.5, 'P1').bucket === 'UNMAPPED');

  // ---------- classification: binary-threshold families are conditional on each market's OWN real line convention ----------
  // Real discovery data (2026-09-29) confirmed anytime_goal_scorer-style
  // Yes/No markets use line=0 in real provider rows, NOT 0.5 -- a real
  // finding that corrected an earlier wrong assumption (caught before
  // any smoke test).
  check('player_anytime_goal_scorer at its real line=0 classifies BINARY_THRESHOLD_CONDITIONAL',
    classifyNhlMarket('player_anytime_goal_scorer', 0, 'FULL').bucket === 'BINARY_THRESHOLD_CONDITIONAL');
  check('player_anytime_goal_scorer at line=0.5 (NOT the real convention for this market) does NOT classify as supported',
    classifyNhlMarket('player_anytime_goal_scorer', 0.5, 'FULL').bucket === 'UNMAPPED');
  check('player_anytime_goal_scorer at line=1.5 (never validated) does NOT classify as supported',
    classifyNhlMarket('player_anytime_goal_scorer', 1.5, 'FULL').bucket === 'UNMAPPED');
  check('player_goals (the base O/U market, real line=0.5) classifies BINARY_THRESHOLD_CONDITIONAL / goals_at_least_1',
    classifyNhlMarket('player_goals', 0.5, 'FULL').statKey === 'goals_at_least_1');
  check('player_goals at line=0 (wrong convention for THIS market_key) does NOT classify as supported',
    classifyNhlMarket('player_goals', 0, 'FULL').bucket === 'UNMAPPED');
  check('player_points at line=0.5 classifies BINARY_THRESHOLD_CONDITIONAL / points_at_least_1',
    classifyNhlMarket('player_points', 0.5, 'FULL').statKey === 'points_at_least_1');
  check('player_points_alt (untested higher lines) is never classified as supported',
    classifyNhlMarket('player_points_alt', 1.5, 'FULL').bucket === 'UNMAPPED');

  // ---------- classification: first/last goal scorer is never conflated with anytime-goal-scorer ----------
  // Deliberately tested at line=0 too -- first_goal_scorer's real rows
  // ALSO use line:0 (same Yes/No provider convention as anytime-scorer),
  // so this proves the exclusion is about the market_key itself, not
  // just an easy-to-pass line mismatch.
  check('player_first_goal_scorer at its real line=0 is still NOT classified as a supported binary-threshold market (different, unvalidated problem)',
    classifyNhlMarket('player_first_goal_scorer', 0, 'FULL').bucket === 'UNMAPPED');
  check('player_last_goal_scorer is NOT classified as a supported binary-threshold market',
    classifyNhlMarket('player_last_goal_scorer', 0, 'FULL').bucket === 'UNMAPPED');

  // ---------- classification: team/game-level markets never fabricated as player props ----------
  check('alternate_totals (a team/game market, not a player stat) is UNMAPPED',
    classifyNhlMarket('alternate_totals', 6.5, 'FULL').bucket === 'UNMAPPED');
  check('player_correct_score (a team/game market despite "player" prefix) is UNMAPPED',
    classifyNhlMarket('player_correct_score', null, 'FULL').bucket === 'UNMAPPED');

  console.log(`\n${failures === 0 ? 'ALL NHL MARKET ARCHIVE / MAPPING TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
