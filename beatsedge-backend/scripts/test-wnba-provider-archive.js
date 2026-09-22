// Phase 2I-H -- WNBA provider-line archive test. Uses ONLY synthetic
// records, all tagged under a distinct TEST- event_id namespace so they
// can never be mistaken for real observations, and deletes every row it
// inserts at the end (self-cleaning -- never leaves synthetic data in the
// archive). Does not touch prop_snapshots, does not touch any model/
// grading/settlement code.

const store = require('../lib/snapshotStore');
const archive = require('../lib/wnbaProviderLineArchive');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}

const TEST_NS = 'TEST-2I-H-' + Date.now();
const baseObs = (over = {}) => ({
  capturedAt: Date.now(),
  sport: 'wnba',
  eventId: TEST_NS + '-EVT1',
  homeTeam: 'NY', awayTeam: 'MIN', commenceTime: '2099-01-01T00:00:00Z',
  playerRaw: 'Test Player', playerId: '9999999',
  marketKeyRaw: 'player_points', marketLabel: 'Points',
  period: 'full_game',
  source: 'prizepicks', sourceType: 'dfs',
  projectionType: 'STANDARD', oddsType: 'standard', side: null,
  line: 19.5, overPrice: null, underPrice: null,
  providerLastUpdate: '2099-01-01T00:00:00Z',
  raw: { note: 'synthetic test row, never real provider data' },
  ...over,
});

(async () => {
  console.log('=== WNBA provider-line archive test (Phase 2I-H) ===\n');

  // 1. Insert -- basic insert works.
  const r1 = await archive.recordObservation(baseObs());
  ok(r1.inserted === true, '1. A new observation inserts successfully', r1);

  // 2. Multiple lines for the same player/market/event remain separate.
  const r2a = await archive.recordObservation(baseObs({ line: 19.5 }));
  const r2b = await archive.recordObservation(baseObs({ line: 20.5 }));
  ok(r2a.inserted === false && r2b.inserted === true, '2. Same line as last capture is deduped; a genuinely different line inserts', { r2a, r2b });

  // 3. Returning to an old line does NOT overwrite the prior observation -- it's a new row.
  const r3 = await archive.recordObservation(baseObs({ line: 19.5 }));
  ok(r3.inserted === true && r3.id !== r1.id, '3. Returning to a prior line (19.5 -> 20.5 -> 19.5) creates a NEW row, not an overwrite of row 1', { row1Id: r1.id, row3Id: r3.id });
  const historyAfter3 = await archive.lineHistory({ eventId: TEST_NS + '-EVT1', playerRaw: 'Test Player', marketKeyRaw: 'player_points', source: 'prizepicks', projectionType: 'STANDARD', period: 'full_game', side: null });
  const lineSeq = historyAfter3.map(r => r.line);
  ok(JSON.stringify(lineSeq) === JSON.stringify([19.5, 20.5, 19.5]), '3b. Line history preserves the full real sequence 19.5 -> 20.5 -> 19.5 (three rows)', lineSeq);
  const row1Untouched = await store.queryOne(`SELECT line, captured_at FROM wnba_provider_line_archive WHERE id = ?`, [r1.id]);
  ok(row1Untouched.line === 19.5, '3c. The original row 1 itself is untouched (still line=19.5, not overwritten)', row1Untouched);

  // 4. Different providers remain separate.
  const r4 = await archive.recordObservation(baseObs({ line: 19.5, source: 'underdog', sourceType: 'dfs' }));
  ok(r4.inserted === true, '4. Same player/market/line but a different source (underdog vs prizepicks) is a separate observation', r4);

  // 5. Standard/Demon/Goblin remain separate.
  const r5a = await archive.recordObservation(baseObs({ line: 19.5, projectionType: 'DEMON' }));
  const r5b = await archive.recordObservation(baseObs({ line: 19.5, projectionType: 'GOBLIN' }));
  ok(r5a.inserted === true && r5b.inserted === true, '5. STANDARD/DEMON/GOBLIN projection types are stored as distinct observations, never collapsed', { r5a, r5b });

  // 6. Different periods remain separate.
  const r6 = await archive.recordObservation(baseObs({ line: 19.5, period: '1H' }));
  ok(r6.inserted === true, '6. Same player/market/line but a different period (1H vs full_game) is a separate observation', r6);

  // 7. Different events remain separate.
  const r7 = await archive.recordObservation(baseObs({ line: 19.5, eventId: TEST_NS + '-EVT2' }));
  ok(r7.inserted === true, '7. Same player/market/line but a different event_id is a separate observation', r7);

  // 8. Raw provider market key is preserved exactly.
  const unknownKeyObs = baseObs({ line: 3, marketKeyRaw: 'player_some_never_seen_before_key', marketLabel: null, eventId: TEST_NS + '-EVT3' });
  const r8 = await archive.recordObservation(unknownKeyObs);
  const stored8 = await store.queryOne(`SELECT market_key_raw, market_label FROM wnba_provider_line_archive WHERE id = ?`, [r8.id]);
  ok(stored8.market_key_raw === 'player_some_never_seen_before_key', '8. An unknown/unrecognized raw market key is preserved verbatim, not dropped or rewritten', stored8);

  // 9. Exact provider line is preserved (including a fractional real-world value).
  const r9 = await archive.recordObservation(baseObs({ line: 27.5, marketKeyRaw: 'player_points', eventId: TEST_NS + '-EVT4' }));
  const stored9 = await store.queryOne(`SELECT line FROM wnba_provider_line_archive WHERE id = ?`, [r9.id]);
  ok(stored9.line === 27.5, '9. Exact provider line value is preserved with no rounding', stored9);

  // 10. Capture timestamp is preserved.
  const fixedTs = 1234567890123;
  const r10 = await archive.recordObservation(baseObs({ capturedAt: fixedTs, eventId: TEST_NS + '-EVT5' }));
  const stored10 = await store.queryOne(`SELECT captured_at FROM wnba_provider_line_archive WHERE id = ?`, [r10.id]);
  ok(stored10.captured_at === fixedTs, '10. captured_at timestamp is preserved exactly as supplied', stored10);

  // 11. provider last_update is preserved when available.
  const r11 = await archive.recordObservation(baseObs({ providerLastUpdate: '2099-06-01T12:34:56Z', eventId: TEST_NS + '-EVT6' }));
  const stored11 = await store.queryOne(`SELECT provider_last_update FROM wnba_provider_line_archive WHERE id = ?`, [r11.id]);
  ok(stored11.provider_last_update === '2099-06-01T12:34:56Z', '11. provider_last_update is preserved when the provider supplies it', stored11);

  // 12. Unknown markets are preserved (same as #8, different angle -- confirm semantics_status default).
  const stored12 = await store.queryOne(`SELECT semantics_status FROM wnba_provider_line_archive WHERE id = ?`, [r8.id]);
  ok(stored12.semantics_status === 'CONFIRMED', '12. Default semantics_status is CONFIRMED; SEMANTICS_UNRESOLVED must be set explicitly, never guessed', stored12);
  const r12b = await archive.recordObservation(baseObs({ line: 1, marketKeyRaw: 'player_three_pointers', semanticsStatus: 'SEMANTICS_UNRESOLVED', eventId: TEST_NS + '-EVT7' }));
  const stored12b = await store.queryOne(`SELECT semantics_status FROM wnba_provider_line_archive WHERE id = ?`, [r12b.id]);
  ok(stored12b.semantics_status === 'SEMANTICS_UNRESOLVED', '12b. An explicitly ambiguous market can be tagged SEMANTICS_UNRESOLVED without being mapped to another market', stored12b);

  // 13. Duplicate identical observations are deduplicated ONLY when truly identical (re-check of #2 with explicit reason).
  const r13 = await archive.recordObservation(baseObs({ line: 19.5, eventId: TEST_NS + '-EVT1', period: '1H' })); // matches r6's identity+value exactly
  ok(r13.inserted === false && r13.reason === 'unchanged', '13. A truly identical repeat observation is deduped with an explicit reason, not silently inserted again', r13);

  // 14. Line movement remains queryable via lineHistory, ordered chronologically.
  const fullHistory = await archive.lineHistory({ eventId: TEST_NS + '-EVT1' });
  ok(fullHistory.length >= 6, '14. lineHistory() returns the full queryable set of observations for an event', fullHistory.length);
  const chronological = fullHistory.every((r, i) => i === 0 || r.captured_at >= fullHistory[i - 1].captured_at);
  ok(chronological, '14b. lineHistory() results are chronologically ordered (oldest first)', chronological);

  // 15. summary() reflects the test rows without error (sanity check the read helper works at all).
  const s = await archive.summary();
  ok(s.total >= fullHistory.length, '15. summary() runs and reports a sane total row count', { total: s.total });

  console.log('\n=== Phase 2I-I: live-capture integration function (archiveFromRawParlayResponse) ===\n');
  // These exercise the SAME function routes/api.js now calls on a real
  // ParlayAPI response, using a synthetic response body shaped exactly like
  // the real row fields fetchParlayProps (BeatsEdge.html) already parses
  // (market_key, player, line, bookmaker, event_id, home_team, away_team,
  // commence_time, odds_type, projection_type, over_price, under_price,
  // last_update). No network call is made; this is pure parsing/mapping
  // logic against a hand-built body string.

  const TEST_EVT = TEST_NS + '-LIVEPATH';
  const rawRow = (over = {}) => ({
    market_key: 'player_points', player: 'Synthetic Player Jr.', line: 19.5,
    bookmaker: 'prizepicks', event_id: TEST_EVT,
    home_team: 'New York Liberty', away_team: 'Minnesota Lynx',
    commence_time: '2099-01-01T00:00:00Z', odds_type: 'standard', projection_type: 'STANDARD',
    over_price: null, under_price: null, last_update: '2099-01-01T00:00:00Z',
    ...over,
  });

  // 17. Non-WNBA paths are a complete no-op (this must never touch NBA/MLB/NFL data).
  const nonWnba = await archive.archiveFromRawParlayResponse('v1/sports/basketball_nba/props', JSON.stringify([rawRow()]));
  ok(nonWnba.applicable === false && nonWnba.archived === 0, '17. A non-WNBA upstream path is a complete no-op', nonWnba);

  // 18. A real-shaped WNBA response body is parsed and archived correctly.
  const wnbaPath = 'v1/sports/basketball_wnba/props';
  const r18 = await archive.archiveFromRawParlayResponse(wnbaPath, JSON.stringify([rawRow()]));
  ok(r18.applicable === true && r18.archived === 1, '18. A real-shaped WNBA response body archives the one row it contains', r18);

  // 19. player_raw is preserved EXACTLY, including a suffix, with no stripping.
  const stored18 = await store.queryOne(`SELECT player_raw, market_key_raw, source, source_type, projection_type, odds_type, semantics_status FROM wnba_provider_line_archive WHERE event_id = ? ORDER BY id DESC LIMIT 1`, [TEST_EVT]);
  ok(stored18.player_raw === 'Synthetic Player Jr.', '19. player_raw preserved exactly, including the "Jr." suffix -- never stripped', stored18.player_raw);

  // 20. source_type is classified using the established DFS/sportsbook lists, not guessed.
  ok(stored18.source_type === 'dfs', '20. prizepicks correctly classified as source_type=dfs via the established provider list', stored18.source_type);

  // 21. projection_type/odds_type preserved verbatim, never inferred from line size.
  ok(stored18.projection_type === 'STANDARD' && stored18.odds_type === 'standard', '21. projection_type/odds_type preserved verbatim from the raw row', { projection_type: stored18.projection_type, odds_type: stored18.odds_type });

  // 22. A known-ambiguous market key is auto-tagged SEMANTICS_UNRESOLVED at capture time (reusing, not re-guessing, the Phase 2I-G/H finding).
  const r22 = await archive.archiveFromRawParlayResponse(wnbaPath, JSON.stringify([rawRow({ market_key: 'player_three_pointers', event_id: TEST_EVT + '-2' })]));
  const stored22 = await store.queryOne(`SELECT semantics_status, market_key_raw FROM wnba_provider_line_archive WHERE event_id = ?`, [TEST_EVT + '-2']);
  ok(r22.archived === 1 && stored22.semantics_status === 'SEMANTICS_UNRESOLVED' && stored22.market_key_raw === 'player_three_pointers', '22. player_three_pointers is auto-tagged SEMANTICS_UNRESOLVED, market_key_raw preserved exactly, never remapped', stored22);

  // 23. A genuinely unknown/never-seen market key is preserved verbatim and defaults to CONFIRMED.
  const r23 = await archive.archiveFromRawParlayResponse(wnbaPath, JSON.stringify([rawRow({ market_key: 'player_never_seen_before_xyz', event_id: TEST_EVT + '-3' })]));
  const stored23 = await store.queryOne(`SELECT semantics_status, market_key_raw FROM wnba_provider_line_archive WHERE event_id = ?`, [TEST_EVT + '-3']);
  ok(r23.archived === 1 && stored23.market_key_raw === 'player_never_seen_before_xyz' && stored23.semantics_status === 'CONFIRMED', '23. A never-before-seen market key is preserved verbatim, not dropped, not remapped', stored23);

  // 24. Re-archiving the identical response body a second time is fully deduped (0 new rows), simulating an unchanged next poll.
  const r24 = await archive.archiveFromRawParlayResponse(wnbaPath, JSON.stringify([rawRow()]));
  ok(r24.archived === 0 && r24.unchanged === 1, '24. Re-archiving an identical response (simulating an unchanged next poll) inserts 0 new rows', r24);

  // 25. A real line CHANGE in the next poll is archived as a new row (not an overwrite).
  const r25 = await archive.archiveFromRawParlayResponse(wnbaPath, JSON.stringify([rawRow({ line: 20.5 })]));
  ok(r25.archived === 1, '25. A genuine line change (19.5 -> 20.5) in the next simulated poll archives as a new row', r25);
  const historyLive = await archive.lineHistory({ eventId: TEST_EVT, playerRaw: 'Synthetic Player Jr.', marketKeyRaw: 'player_points', source: 'prizepicks', projectionType: 'STANDARD', period: null, side: null });
  ok(JSON.stringify(historyLive.map(r => r.line)) === JSON.stringify([19.5, 20.5]), '25b. Line history through the live-path function shows the real 19.5 -> 20.5 movement', historyLive.map(r => r.line));

  // 26. Malformed body is handled gracefully (never throws, never crashes the passthrough response).
  const r26 = await archive.archiveFromRawParlayResponse(wnbaPath, 'not valid json{{{');
  ok(r26.applicable === true && r26.archived === 0 && !!r26.error, '26. A malformed/unparseable body is handled gracefully with an error field, never throws', r26);

  // 27. rows missing required fields (no event_id/player/market_key/bookmaker/line) are skipped, not inserted with nulls.
  const r27 = await archive.archiveFromRawParlayResponse(wnbaPath, JSON.stringify([{ market_key: 'player_points' /* missing everything else */ }]));
  ok(r27.archived === 0 && r27.skipped === 1, '27. A row missing required fields is skipped, never inserted with fabricated nulls', r27);

  // Cleanup -- delete every synthetic row this test created (both the direct
  // recordObservation tests and the archiveFromRawParlayResponse tests).
  // Never leave test data in the archive.
  const del = await store.run(`DELETE FROM wnba_provider_line_archive WHERE event_id LIKE ?`, [TEST_NS + '%']);
  ok(del.changes >= 13, '28. Cleanup: all synthetic test rows removed from the archive', del);
  const leftover = await store.queryOne(`SELECT COUNT(*) c FROM wnba_provider_line_archive WHERE event_id LIKE ?`, [TEST_NS + '%']);
  ok(leftover.c === 0, '28b. Zero synthetic rows remain in the archive after cleanup', leftover);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
