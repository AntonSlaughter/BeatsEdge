// Real test: exercises the actual settlement engine (lib/snapshotDb.js +
// lib/snapshotStore.js + cron/settleSnapshots.js) against the real
// snapshot storage (local SQLite by default, or Turso if TURSO_DATABASE_URL
// / TURSO_AUTH_TOKEN are set), using isolated synthetic fixtures (clearly-
// tagged player names / far-future or already-real dates) that are
// inserted, asserted on, and deleted again so this never leaves anything
// behind in real data. Mirrors the fixture-insert-assert-cleanup style of
// scripts/test-dvp-engine.js. Backend-agnostic on purpose -- run it once
// locally (default) and once with Turso env vars set to validate both.

const store = require('../lib/snapshotStore');
const { saveSnapshots } = require('../lib/snapshotDb');
const { runSettleSnapshots, settleSlate, flagInvalidFutureDates } = require('../cron/settleSnapshots');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? ' -- ' + detail : ''}`);
  if (cond) pass++; else fail++;
}

const FIXTURE_TAG = 'ZZ-TEST-FIXTURE';

(async () => {
  console.log(`=== Settlement engine test (backend=${store.backend}) ===\n`);

  // ---------------------------------------------------------------
  // 1 & 2. Idempotency: running settlement twice must not change an
  // already-settled row, and must not produce duplicate rows.
  // ---------------------------------------------------------------
  console.log('--- 1/2: idempotency + already-settled rows unchanged ---');
  const before = await store.query(`
    SELECT * FROM prop_snapshots WHERE settlement_status='settled' ORDER BY id LIMIT 25
  `);
  ok(before.length > 0, 'found real settled rows to check against', `${before.length} rows`);
  const beforeSnapshot = JSON.stringify(before);
  const totalBefore = (await store.queryOne(`SELECT COUNT(*) c FROM prop_snapshots`)).c;

  await runSettleSnapshots(); // real run #1
  await runSettleSnapshots(); // real run #2 -- must be a no-op for already-settled rows

  const after = before.length
    ? await store.query(`SELECT * FROM prop_snapshots WHERE id IN (${before.map(r => r.id).join(',')}) ORDER BY id`)
    : [];
  ok(JSON.stringify(after) === beforeSnapshot, 'already-settled rows byte-identical after two more settlement runs');
  const totalAfter = (await store.queryOne(`SELECT COUNT(*) c FROM prop_snapshots`)).c;
  ok(totalAfter === totalBefore, 'no rows created or lost by re-running settlement', `${totalBefore} -> ${totalAfter}`);
  const dupes = (await store.queryOne(`
    SELECT COUNT(*) c FROM (
      SELECT snap_date, sport, player, stat, line, dir, model_variant, COUNT(*) n
      FROM prop_snapshots GROUP BY snap_date, sport, player, stat, line, dir, model_variant HAVING n > 1
    )
  `)).c;
  ok(dupes === 0, 'no duplicate (date, sport, player, stat, line, dir, model_variant) groups exist');

  // ---------------------------------------------------------------
  // 3. Invalid future date cannot produce a fabricated result.
  // ---------------------------------------------------------------
  console.log('\n--- 3: future snap_date never gets a fabricated result ---');
  await saveSnapshots('2099-01-01', 'mlb', [{
    player: `${FIXTURE_TAG} Future Player`, stat: 'hits', line: 1.5, dir: 'over',
    modelVariant: 'A', ts: Date.now()
  }]);
  const { flagged } = await flagInvalidFutureDates();
  ok(flagged >= 1, 'flagInvalidFutureDates flagged the fixture row', `flagged=${flagged}`);
  const futureRow = await store.queryOne(`SELECT * FROM prop_snapshots WHERE player=? AND snap_date='2099-01-01'`, [`${FIXTURE_TAG} Future Player`]);
  ok(futureRow.result === null && futureRow.actual === null, 'no result/actual was fabricated for the future row');
  ok(futureRow.settlement_status === 'invalid', 'future row marked invalid', futureRow.settlement_status);
  // Re-running the full driver must never pick it up as a normal pending slate.
  const pendingCheck = (await store.queryOne(`SELECT COUNT(*) c FROM prop_snapshots WHERE player=? AND result IS NULL AND settlement_status IS NULL`, [`${FIXTURE_TAG} Future Player`])).c;
  ok(pendingCheck === 0, 'future row no longer appears as an untouched pending row');
  await store.run(`DELETE FROM prop_snapshots WHERE player=?`, [`${FIXTURE_TAG} Future Player`]);

  // ---------------------------------------------------------------
  // 4. Model A and Model B remain isolated.
  // ---------------------------------------------------------------
  console.log('\n--- 4: Model A / Model B isolation ---');
  const a = await store.queryOne(`SELECT * FROM prop_snapshots WHERE model_variant='A' AND settlement_status='settled' AND sport='mlb' ORDER BY id LIMIT 1`);
  ok(!!a, 'found a real settled Model A row to twin');
  if (a) {
    const aBefore = JSON.stringify(a);
    await saveSnapshots(a.snap_date, a.sport, [{
      player: a.player, team: a.team, opp: a.opp, pos: a.pos, stat: a.stat, type: a.type,
      line: a.line, dir: a.dir, book: a.book, lineSource: a.line_source,
      modelVariant: 'B', modelProjection: 999.9, probability: 0.42, grade: 'TEST-B', prime: 0, ts: Date.now()
    }]);
    const aAfterInsert = await store.queryOne(`SELECT * FROM prop_snapshots WHERE id=?`, [a.id]);
    ok(JSON.stringify(aAfterInsert) === aBefore, 'Model A row unchanged by inserting a Model B twin');
    const b = await store.queryOne(`
      SELECT * FROM prop_snapshots WHERE snap_date=? AND sport=? AND player=? AND stat=? AND line=? AND dir=? AND model_variant='B'
    `, [a.snap_date, a.sport, a.player, a.stat, a.line, a.dir]);
    ok(!!b, 'Model B row exists as a separate row');
    ok(b && b.model_projection === 999.9 && b.grade === 'TEST-B', 'Model B kept its own distinct model fields');

    await settleSlate(a.snap_date, a.sport);
    const bAfter = await store.queryOne(`SELECT * FROM prop_snapshots WHERE id=?`, [b.id]);
    const aAfterSettle = await store.queryOne(`SELECT * FROM prop_snapshots WHERE id=?`, [a.id]);
    ok(JSON.stringify(aAfterSettle) === aBefore, 'Model A row still unchanged after re-settling the slate');
    ok(bAfter.actual === a.actual && bAfter.result === a.result, 'Model B settled to the SAME real outcome as Model A', `A=${a.actual}/${a.result} B=${bAfter.actual}/${bAfter.result}`);
    await store.run(`DELETE FROM prop_snapshots WHERE id=?`, [b.id]);
    ok((await store.queryOne(`SELECT COUNT(*) c FROM prop_snapshots WHERE id=?`, [b.id])).c === 0, 'test Model B row cleaned up');
  }

  // ---------------------------------------------------------------
  // 5. No unresolved kicker row gets guessed.
  // ---------------------------------------------------------------
  console.log('\n--- 5: NFL kicker rows stay unresolved, never guessed ---');
  const kicker = await store.queryOne(`SELECT * FROM prop_snapshots WHERE stat IN ('fgMade','kickingPts') AND settlement_status='unresolved' LIMIT 1`);
  ok(!!kicker, 'a real unresolved kicker row exists from the last settlement pass');
  if (kicker) {
    await settleSlate(kicker.snap_date, kicker.sport); // re-attempt; must not start guessing
    const kAfter = await store.queryOne(`SELECT * FROM prop_snapshots WHERE id=?`, [kicker.id]);
    ok(kAfter.result === null && kAfter.actual === null, 'kicker row still has no fabricated result');
    ok(kAfter.settlement_status === 'unresolved', 'kicker row still unresolved');
    ok(kAfter.settlement_reason === 'Unresolved because ESPN kicker field mapping has not been empirically verified.', 'kicker row carries the exact required reason', kAfter.settlement_reason);
  }

  // ---------------------------------------------------------------
  // 6. WNBA remains untouched (no resolver, never guessed).
  // ---------------------------------------------------------------
  console.log('\n--- 6: WNBA settlement stays unimplemented, never guessed ---');
  const wnbaDate = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10); // a few days old
  await saveSnapshots(wnbaDate, 'wnba', [{
    player: `${FIXTURE_TAG} WNBA Player`, stat: 'points', line: 15.5, dir: 'over',
    modelVariant: 'A', ts: Date.now()
  }]);
  const wnbaResult = await settleSlate(wnbaDate, 'wnba');
  ok(wnbaResult.unresolved === 1 && wnbaResult.settled === 0, 'WNBA slate produced zero settled rows', JSON.stringify(wnbaResult));
  const wnbaRow = await store.queryOne(`SELECT * FROM prop_snapshots WHERE player=?`, [`${FIXTURE_TAG} WNBA Player`]);
  ok(wnbaRow.result === null && wnbaRow.actual === null, 'no result was fabricated for the WNBA row');
  ok(wnbaRow.settlement_status === 'unresolved' && /wnba/.test(wnbaRow.settlement_reason || ''), 'WNBA row marked unresolved with a sport-not-supported reason', wnbaRow.settlement_reason);
  await store.run(`DELETE FROM prop_snapshots WHERE player=?`, [`${FIXTURE_TAG} WNBA Player`]);

  // ---------------------------------------------------------------
  console.log('\n--- final sanity: no fixture rows left behind ---');
  const leftover = (await store.queryOne(`SELECT COUNT(*) c FROM prop_snapshots WHERE player LIKE ?`, [`${FIXTURE_TAG}%`])).c;
  ok(leftover === 0, 'zero fixture rows remain in the real table');

  console.log(`\n=== RESULT (backend=${store.backend}): ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
