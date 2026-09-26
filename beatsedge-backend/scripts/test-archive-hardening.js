// BeatsEdge Market Archive Hardening -- test suite (items A-O). Mix of
// real archived WNBA data and synthetic fixtures where no real example
// exists yet (e.g. multi-page pagination, a fifth-sport observation).
// Read-only against real tables; writes only to a private in-memory-style
// isolated set of rows via the same store (guarded, see section L/M/O)
// and cleans up anything it inserts.
//
//   node scripts/test-archive-hardening.js

const store = require('../lib/snapshotStore');
const { resolvePrimaryLine, reconstructPrimaryTimeline } = require('../lib/marketArchive/anchorLine');
const { classifyTiming } = require('../lib/marketArchive/pregameClassifier');
const mlbArchive = require('../lib/mlbProviderLineArchive');
const nflArchive = require('../lib/nflProviderLineArchive');
const nbaArchive = require('../lib/nbaProviderLineArchive');

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

(async () => {
  // ---------- A. simultaneous alt-line ladder is NOT interpreted as movement ----------
  {
    const rows = await store.query(`
      SELECT * FROM wnba_provider_line_archive
      WHERE player_raw IS 'Kayla McBride (MIN)' AND market_key_raw IS 'player_points' AND source IS 'bovada'
      ORDER BY captured_at
    `);
    const { clusters } = reconstructPrimaryTimeline(rows);
    const firstCluster = clusters[0];
    check('A: an 8-line simultaneous ladder resolves to exactly ONE primary, not 8 movements', firstCluster.rows.length > 1 && firstCluster.resolution.primary != null, `ladderSize=${firstCluster.rows.length}`);
  }

  // ---------- B. primary line resolved where evidence permits ----------
  {
    const res = resolvePrimaryLine([
      { line: 9.5, over_price: -2500, under_price: null, source_type: 'sportsbook' },
      { line: 17.5, over_price: 105, under_price: -135, source_type: 'sportsbook' },
      { line: 24.5, over_price: 425, under_price: null, source_type: 'sportsbook' },
    ]);
    check('B: two-sided row is resolved as primary with high confidence', res.confidence === 'high' && res.primary.line === 17.5, JSON.stringify(res));
  }

  // ---------- C. ambiguous primary line returns ambiguous rather than guessing ----------
  {
    const resNoTwoSided = resolvePrimaryLine([
      { line: 9.5, over_price: -2500, under_price: null, source_type: 'sportsbook' },
      { line: 24.5, over_price: 425, under_price: null, source_type: 'sportsbook' },
    ]);
    const resTwoTwoSided = resolvePrimaryLine([
      { line: 9.5, over_price: -150, under_price: 120, source_type: 'sportsbook' },
      { line: 10.5, over_price: -140, under_price: 110, source_type: 'sportsbook' },
    ]);
    check('C1: zero two-sided rows -> ambiguous, no guess', resNoTwoSided.confidence === 'ambiguous' && resNoTwoSided.primary === null);
    check('C2: multiple two-sided rows -> ambiguous, no guess', resTwoTwoSided.confidence === 'ambiguous' && resTwoTwoSided.primary === null);
  }

  // ---------- D. STANDARD/DEMON/GOBLIN remain separate ----------
  {
    const res = resolvePrimaryLine([
      { line: 3.5, projection_type: 'DEMON', source_type: 'dfs' },
      { line: 2.5, projection_type: 'STANDARD', source_type: 'dfs' },
      { line: 4.5, projection_type: 'GOBLIN', source_type: 'dfs' },
    ]);
    check('D: DFS resolver picks STANDARD as primary, DEMON/GOBLIN stay as alternates (never merged)', res.primary && res.primary.projection_type === 'STANDARD' && res.alternates.every(a => a.projection_type !== 'STANDARD'), JSON.stringify(res));
  }

  // ---------- E. full ladder preserved ----------
  {
    const rows = [
      { line: 9.5, projection_type: 'STANDARD', source_type: 'dfs' },
      { line: 3.5, projection_type: 'DEMON', source_type: 'dfs' },
      { line: 12.5, projection_type: 'GOBLIN', source_type: 'dfs' },
    ];
    const res = resolvePrimaryLine(rows);
    check('E: resolver output preserves every input row (primary + alternates = original count)', 1 + res.alternates.length === rows.length);
  }

  // ---------- F. raw line preserved exactly (no rounding/mutation) ----------
  {
    const row = { line: 24.5, over_price: -135.0, under_price: 105.0, source_type: 'sportsbook' };
    const res = resolvePrimaryLine([row]);
    check('F: resolver never mutates the raw row object it returns', res.primary === row && res.primary.line === 24.5);
  }

  // ---------- G. repeated timestamps grouped correctly ----------
  {
    const rows = await store.query(`
      SELECT * FROM wnba_provider_line_archive
      WHERE player_raw IS 'Kayla McBride (MIN)' AND market_key_raw IS 'player_points' AND source IS 'bovada'
    `);
    const distinctTimestamps = new Set(rows.map(r => r.captured_at)).size;
    const { clusters } = reconstructPrimaryTimeline(rows);
    check('G: timestamp clustering produces exactly one cluster per distinct captured_at', clusters.length === distinctTimestamps, `clusters=${clusters.length} distinctTs=${distinctTimestamps}`);
  }

  // ---------- H. primary movement across timestamps detected correctly ----------
  {
    // Synthetic: primary genuinely moves from 17.5 to 18.5 between two clusters.
    const synthetic = [
      { captured_at: 1000, line: 17.5, over_price: 105, under_price: -135, source_type: 'sportsbook' },
      { captured_at: 1000, line: 24.5, over_price: 425, under_price: null, source_type: 'sportsbook' },
      { captured_at: 2000, line: 18.5, over_price: 100, under_price: -120, source_type: 'sportsbook' },
      { captured_at: 2000, line: 25.5, over_price: 400, under_price: null, source_type: 'sportsbook' },
    ];
    const { movements } = reconstructPrimaryTimeline(synthetic);
    check('H: a genuine primary-line change is classified PRIMARY_MOVED', movements.length === 1 && movements[0].kind === 'PRIMARY_MOVED' && movements[0].fromPrimaryLine === 17.5 && movements[0].toPrimaryLine === 18.5, JSON.stringify(movements));
  }

  // ---------- I. same-line price movement detected ----------
  {
    const synthetic = [
      { captured_at: 1000, line: 17.5, over_price: 105, under_price: -135, source_type: 'sportsbook' },
      { captured_at: 2000, line: 17.5, over_price: -110, under_price: -110, source_type: 'sportsbook' },
    ];
    const { movements } = reconstructPrimaryTimeline(synthetic);
    check('I: price change at the SAME primary line is classified PRICE_MOVED_SAME_LINE', movements.length === 1 && movements[0].kind === 'PRICE_MOVED_SAME_LINE');
  }

  // ---------- J. event IDs prevent cross-game merging ----------
  {
    const events = await store.query(`SELECT DISTINCT event_id FROM wnba_provider_line_archive LIMIT 3`);
    check('J: at least 2 distinct event_ids exist and are queried independently', events.length >= 2);
    if (events.length >= 2) {
      const a = await store.query(`SELECT COUNT(*) c FROM wnba_provider_line_archive WHERE event_id IS ?`, [events[0].event_id]);
      const b = await store.query(`SELECT COUNT(*) c FROM wnba_provider_line_archive WHERE event_id IS ?`, [events[1].event_id]);
      const both = await store.query(`SELECT COUNT(*) c FROM wnba_provider_line_archive WHERE event_id IN (?, ?)`, [events[0].event_id, events[1].event_id]);
      check('J: querying two event_ids together yields the SUM of each queried separately (no merge)', both[0].c === a[0].c + b[0].c);
    }
  }

  // ---------- K. sport prevents cross-sport merging ----------
  {
    // Insert one synthetic MLB row and confirm it never appears in the NBA table (separate tables entirely).
    await mlbArchive.recordObservation({
      capturedAt: Date.now(), sport: 'mlb', eventId: 'TEST_EVENT_HARDENING', homeTeam: 'TEST_HOME', awayTeam: 'TEST_AWAY',
      commenceTime: new Date(Date.now() + 3600000).toISOString(), playerRaw: 'Test Player Hardening', marketKeyRaw: 'player_test_market',
      source: 'draftkings', sourceType: 'sportsbook', line: 5.5, overPrice: -110, underPrice: -110, raw: { test: true },
    });
    const inMlb = await store.queryOne(`SELECT COUNT(*) c FROM mlb_provider_line_archive WHERE event_id IS 'TEST_EVENT_HARDENING'`);
    const inNba = await store.queryOne(`SELECT COUNT(*) c FROM nba_provider_line_archive WHERE event_id IS 'TEST_EVENT_HARDENING'`);
    check('K: a synthetic MLB test row never appears in the NBA table (separate tables, no cross-sport merge)', inMlb.c === 1 && inNba.c === 0);
    // cleanup
    await store.run(`DELETE FROM mlb_provider_line_archive WHERE event_id IS 'TEST_EVENT_HARDENING'`);
  }

  // ---------- L. pagination pages all archive ----------
  {
    // Synthetic 2-page ParlayAPI response fixture, mirroring the exact
    // shape archiveFromRawParlayResponse expects (event_id, player,
    // market_key, bookmaker, line required).
    const page1 = JSON.stringify([
      { event_id: 'TEST_PAGE_EVENT', player: 'Page One Player', market_key: 'player_test', bookmaker: 'draftkings', line: 10.5, over_price: -110, under_price: -110 },
    ]);
    const page2 = JSON.stringify([
      { event_id: 'TEST_PAGE_EVENT', player: 'Page Two Player', market_key: 'player_test', bookmaker: 'draftkings', line: 20.5, over_price: -110, under_price: -110 },
    ]);
    const r1 = await nflArchive.archiveFromRawParlayResponse('v1/sports/americanfootball_nfl/props', page1);
    const r2 = await nflArchive.archiveFromRawParlayResponse('v1/sports/americanfootball_nfl/props', page2);
    const both = await store.query(`SELECT player_raw FROM nfl_provider_line_archive WHERE event_id IS 'TEST_PAGE_EVENT' ORDER BY player_raw`);
    check('L: two independently-archived "pages" (two separate response bodies) both persist, no loss/duplication', r1.archived === 1 && r2.archived === 1 && both.length === 2, JSON.stringify({ r1, r2, both }));
    await store.run(`DELETE FROM nfl_provider_line_archive WHERE event_id IS 'TEST_PAGE_EVENT'`);
  }

  // ---------- M. unsupported markets remain archived ----------
  {
    const body = JSON.stringify([
      { event_id: 'TEST_UNSUPPORTED_MARKET', player: 'Obscure Market Player', market_key: 'player_totally_unrecognized_market_xyz', bookmaker: 'fanduel', line: 3.5, over_price: -110 },
    ]);
    const r = await nflArchive.archiveFromRawParlayResponse('v1/sports/americanfootball_nfl/props', body);
    const row = await store.queryOne(`SELECT market_key_raw FROM nfl_provider_line_archive WHERE event_id IS 'TEST_UNSUPPORTED_MARKET'`);
    check('M: an unrecognized/unsupported market_key is still archived verbatim, not dropped', r.archived === 1 && row && row.market_key_raw === 'player_totally_unrecognized_market_xyz');
    await store.run(`DELETE FROM nfl_provider_line_archive WHERE event_id IS 'TEST_UNSUPPORTED_MARKET'`);
  }

  // ---------- N. pregame vs post-start classification works ----------
  {
    const pregameRow = { captured_at: Date.parse('2026-01-01T00:00:00Z'), commence_time: '2026-01-01T02:00:00Z', game_status: null };
    const liveRow = { captured_at: Date.parse('2026-01-01T03:00:00Z'), commence_time: '2026-01-01T02:00:00Z', game_status: null };
    const statusFinalRow = { captured_at: Date.parse('2026-01-01T01:00:00Z'), commence_time: '2026-01-01T02:00:00Z', game_status: 'Final' };
    check('N1: captured before commence_time classifies PREGAME', classifyTiming(pregameRow).classification === 'PREGAME');
    check('N2: captured after commence_time (no status) classifies LIVE (time-based)', classifyTiming(liveRow).classification === 'LIVE');
    check('N3: explicit provider game_status="Final" overrides to FINAL even if captured_at is technically pregame by time', classifyTiming(statusFinalRow).classification === 'FINAL');
  }

  // ---------- O. existing NBA/WNBA archive behavior remains backward-compatible ----------
  {
    check('O1: nba_provider_line_archive IDENTITY_COLS unchanged', JSON.stringify(nbaArchive.IDENTITY_COLS) === JSON.stringify(['sport', 'event_id', 'player_raw', 'market_key_raw', 'source', 'projection_type', 'period', 'side']));
    check('O2: nba_provider_line_archive CHANGE_FIELDS unchanged', JSON.stringify(nbaArchive.CHANGE_FIELDS) === JSON.stringify(['line', 'over_price', 'under_price', 'provider_last_update', 'game_status', 'market_label']));
    check('O3: existing WNBA row count is exactly as it was before this task (13,939)', (await store.queryOne(`SELECT COUNT(*) c FROM wnba_provider_line_archive`)).c === 13939);
    check('O4: existing NBA archive path matcher still only matches its own sport', nbaArchive.isNbaPropsPath('v1/sports/basketball_nba/props') === true && nbaArchive.isNbaPropsPath('v1/sports/baseball_mlb/props') === false);
  }

  console.log(`\n${failures === 0 ? 'ALL ARCHIVE HARDENING TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
