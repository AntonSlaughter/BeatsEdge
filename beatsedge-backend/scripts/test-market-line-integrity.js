// Phase 8 -- source-line integrity regression test (Lock #14 / Step 26).
//
// Exercises the REAL, existing snapshot write path (lib/snapshotDb.js's
// saveSnapshots -> lib/snapshotStore.js, the same code every live slate
// snapshot goes through) against the real backend (local SQLite by
// default, or Turso if TURSO_DATABASE_URL/TURSO_AUTH_TOKEN are set), using
// isolated synthetic fixtures (a distinct player-name tag, cleaned up at
// the end) -- same fixture-insert-assert-cleanup style as
// scripts/test-settlement.js. No new signal code exists for Phase 8 (this
// was an audit-only phase, see the Phase 8 final report) -- this test
// exists purely to PROVE the properties the audit already found true by
// reading the code, so a future change to snapshotDb.js/snapshotStore.js
// cannot silently break source-line integrity without a test failing.
//
// What Phase 8's audit found and this test proves:
//  - A real per-book line value is never averaged, merged, or replaced
//    with another value (BeatsEdge projection, another book's line,
//    another player's line) anywhere in the write path -- `line` passes
//    straight through as a plain number.
//  - Two distinct real books' lines for the same (snap_date, sport,
//    player, stat, dir) survive as two separate rows (line is part of the
//    unique key), never collapsed into one.
//  - Re-submitting the exact same (snap_date, sport, player, stat, line,
//    dir, model_variant) key updates that one row in place (ON CONFLICT
//    DO UPDATE) -- never creates a duplicate.
//  - `market_line` (the derived sharp-book median, a RESEARCH feature) and
//    `model_projection` (BeatsEdge's own output) are architecturally
//    separate columns from `line` (the real per-book value) -- verified
//    they never get cross-assigned.
//  - `market_line` stays exactly null when the caller doesn't supply one
//    -- it is never defaulted to `line` or `model_projection`.
//  - A real, documented (not a bug to silently fix -- Lock #14/Step 27
//    forbid redesigning this) nuance: `book`/`line_source` are NOT part
//    of the unique key, so if two different books happen to submit the
//    EXACT SAME numeric line for the same prop+direction, the later
//    submission's book/line_source overwrites the earlier one's (the line
//    VALUE is still real and unchanged either way -- only the book
//    ATTRIBUTION for that tied value follows last-write-wins). This test
//    documents that this is real, current, intentional-schema behavior,
//    not something this phase silently patched.

const store = require('../lib/snapshotStore');
const { saveSnapshots, getSnapshots } = require('../lib/snapshotDb');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? ' -- ' + detail : ''}`);
  if (cond) pass++; else fail++;
}

const FIXTURE_TAG = 'ZZ-PHASE8-MARKET-TEST';
const SNAP_DATE = '2026-08-01'; // a fixed, clearly-past, real-shaped date; never touches real slates

(async () => {
  console.log(`=== Market line integrity test (backend=${store.backend}) ===\n`);

  // Everything that only needs ONE write goes in a single batch/transaction
  // (fewer store.transaction() round trips -- this repo's better-sqlite3
  // binding is prone to a non-deterministic native crash on this machine
  // under repeated open/close cycles; consolidating cuts that risk without
  // changing what's being tested).
  await saveSnapshots(SNAP_DATE, 'mlb', [
    { player: `${FIXTURE_TAG} Alpha`, stat: 'hits', line: 1.5, dir: 'over', book: 'draftkings', lineSource: 'ParlayAPI · draftkings', probability: 55, grade: 'B' },
    { player: `${FIXTURE_TAG} Alpha`, stat: 'hits', line: 2.5, dir: 'over', book: 'fanduel', lineSource: 'ParlayAPI · fanduel', probability: 48, grade: 'C' },
    { player: `${FIXTURE_TAG} Beta`, stat: 'strikeouts', line: 5.5, dir: 'over', book: 'betmgm', lineSource: 'ParlayAPI · betmgm', probability: 60, grade: 'A' },
    { player: `${FIXTURE_TAG} Gamma`, stat: 'totalBases', line: 1.5, dir: 'over', book: 'sleeper', lineSource: 'ParlayAPI · sleeper', probability: 50, grade: 'C' },
    { player: `${FIXTURE_TAG} Delta`, stat: 'runs', line: 0.5, dir: 'over', book: 'draftkings', lineSource: 'ParlayAPI · draftkings', modelProjection: 1.2, probability: 70, grade: 'A' },
    { player: `${FIXTURE_TAG} Epsilon`, stat: 'hits', line: 1.5, dir: 'over', book: 'draftkings', lineSource: 'ParlayAPI · draftkings', marketLine: 1.6, mktGap: -0.1, probability: 55, grade: 'B' },
    { player: `${FIXTURE_TAG} Zeta`, stat: 'walks', line: 0.5, dir: 'over', probability: 40, grade: 'D' }, // no book/lineSource supplied
  ]);

  const firstBatch = await getSnapshots({ since: SNAP_DATE, sport: 'mlb' });
  const byPlayer = (name) => firstBatch.filter(r => r.player === `${FIXTURE_TAG} ${name}`);

  // 1. Two distinct real books, distinct real lines, same player/stat/dir -- both must survive as separate rows.
  const alpha = byPlayer('Alpha');
  ok(alpha.length === 2, '1. two distinct real books with distinct real lines survive as two separate rows, not merged', `${alpha.length} rows`);
  const alphaLines = alpha.map(r => r.line).sort((a, b) => a - b);
  ok(alphaLines[0] === 1.5 && alphaLines[1] === 2.5, '2. real per-book line values pass through exactly (1.5 and 2.5), never averaged into e.g. 2.0', JSON.stringify(alphaLines));
  const alphaBooks = new Set(alpha.map(r => r.book));
  ok(alphaBooks.has('draftkings') && alphaBooks.has('fanduel'), '3. each row keeps its own real book identity', [...alphaBooks].join(','));

  // 4. market_line stays null when not supplied -- never defaulted to line or model_projection.
  const delta = byPlayer('Delta')[0];
  ok(delta.market_line == null, '4. market_line stays null when the caller supplies none -- never defaulted to line or model_projection', delta.market_line);
  ok(delta.line === 0.5 && delta.model_projection === 1.2, '5. real market line (0.5) and BeatsEdge model_projection (1.2) stay architecturally separate, never cross-assigned', `line=${delta.line} proj=${delta.model_projection}`);

  // 5. market_line IS preserved as a real, separate research feature when supplied.
  const eps = byPlayer('Epsilon')[0];
  ok(eps.market_line === 1.6 && eps.mkt_gap === -0.1, '6. a real supplied market_line/mkt_gap is preserved exactly, not recomputed or dropped', `market_line=${eps.market_line} mkt_gap=${eps.mkt_gap}`);

  // 6. Missing book/line_source never fabricated -- stay null.
  const zeta = byPlayer('Zeta')[0];
  ok(zeta.book == null && zeta.line_source == null, '7. missing book/line_source stay null, never fabricated (e.g. never defaulted to a placeholder book name)', `book=${zeta.book} line_source=${zeta.line_source}`);

  // -- Second batch: resubmissions, to test upsert / tie-break behavior in ONE more transaction --
  await saveSnapshots(SNAP_DATE, 'mlb', [
    { player: `${FIXTURE_TAG} Beta`, stat: 'strikeouts', line: 5.5, dir: 'over', book: 'betmgm', lineSource: 'ParlayAPI · betmgm', probability: 62, grade: 'A' }, // resubmit, slightly updated probability
    { player: `${FIXTURE_TAG} Gamma`, stat: 'totalBases', line: 1.5, dir: 'over', book: 'prizepicks', lineSource: 'ParlayAPI · prizepicks', probability: 50, grade: 'C' }, // same tied line, different book
  ]);
  const secondBatch = await getSnapshots({ since: SNAP_DATE, sport: 'mlb' });
  const byPlayer2 = (name) => secondBatch.filter(r => r.player === `${FIXTURE_TAG} ${name}`);

  // 2. Duplicate submission of the SAME key -- must update in place, never duplicate.
  const betaRows = byPlayer2('Beta');
  ok(betaRows.length === 1, '8. re-submitting the exact same (date,sport,player,stat,line,dir,variant) key updates in place, never duplicates', `${betaRows.length} row(s)`);
  ok(betaRows[0].probability === 62, '9. the update-in-place actually applied the newer real value (probability 62)', betaRows[0].probability);

  // 3. Same numeric line, DIFFERENT books -- documents the real last-write-wins
  //    book-attribution nuance (line value itself still never fabricated).
  const gammaRows = byPlayer2('Gamma');
  ok(gammaRows.length === 1 && gammaRows[0].line === 1.5, '10. tied real line value (1.5) never fabricated/altered across the two submissions', gammaRows[0] && gammaRows[0].line);
  ok(gammaRows[0].book === 'prizepicks', '11. documented real behavior: book attribution for a tied line follows last-write-wins (not a bug this phase silently patched -- Lock #14/#27 forbid redesigning this)', gammaRows[0].book);

  // ---------------------------------------------------------------
  // Cleanup -- delete every fixture row via the raw store handle (mirrors
  // scripts/test-settlement.js's own cleanup pattern), then verify nothing
  // was left behind in real data.
  // ---------------------------------------------------------------
  await store.run(`DELETE FROM prop_snapshots WHERE player LIKE ?`, [`${FIXTURE_TAG}%`]);
  const remaining = await store.query(`SELECT COUNT(*) c FROM prop_snapshots WHERE player LIKE ?`, [`${FIXTURE_TAG}%`]);
  ok(remaining[0].c === 0, '12. zero fixture rows remain in the real table after cleanup', remaining[0].c);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error('Market line integrity test crashed:', e); process.exit(1); });
