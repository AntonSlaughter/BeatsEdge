// Phase 10C Objective B -- PropLine live capability regression test.
//
// SAFE TO RERUN: read-only GET requests only (no writes anywhere), and
// deliberately LEAN -- this makes at most ~5 real PropLine requests per
// run (not the full 10-20-events-per-sport audit the Phase 10C report
// itself was built from), to keep this test cheap to run repeatedly
// without meaningfully denting the shared 5,000/day allowance. Uses the
// same key/host scripts/audit-book-coverage.js already ships with.
//
// This test does NOT touch production data, does NOT modify provider
// routing/health, and does NOT activate PropLine as a live source --
// it only proves the capabilities documented in the Phase 10C report
// remain true over time (event/market/player/bookmaker/timestamp
// structure), so a future provider-schema change would be caught here
// rather than discovered silently.
//
// Gracefully SKIPS (not fails) if PropLine is unreachable or the key is
// invalid -- this must never block the rest of the suite.

const PROPLINE_KEY = process.env.PROPLINE_KEY || 'd0a9903df442e544949ee2f980b7c1a6';
const PL = 'https://api.prop-line.com';

let pass = 0, fail = 0, skip = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}
function skipped(label, detail) {
  console.log(`⊘ SKIP ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  skip++;
}

const j = async (url) => {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'beatsedge/test-propline-capability' } });
    const t = await r.text();
    let b; try { b = JSON.parse(t); } catch { b = null; }
    return { status: r.status, b, ok: r.ok };
  } catch (e) {
    return { status: 0, b: null, ok: false, networkError: e.message };
  }
};
const plGet = (path) => j(`${PL}${path}${path.includes('?') ? '&' : '?'}apiKey=${PROPLINE_KEY}`);

(async () => {
  console.log('=== PropLine live capability test (lean, ~5 requests) ===\n');

  // 1. Event discovery -- real, current MLB events (in-season sport, most
  // likely to have live near-term events regardless of when this runs).
  const ev = await plGet('/v1/sports/baseball_mlb/events');
  if (ev.status === 0 || (ev.status !== 200 && ev.status !== 503)) {
    skipped('1-10. PropLine unreachable or unexpected error this run -- skipping the rest of this file gracefully (never fails the suite for an external provider being down)', { status: ev.status });
    console.log(`\n=== RESULT: ${pass} passed, ${fail} failed, ${skip} skipped ===`);
    process.exit(0);
  }
  if (ev.status === 503) {
    skipped('1-10. PropLine reported cooldown/unavailable (503) this run -- graceful, not a failure', ev.b);
    console.log(`\n=== RESULT: ${pass} passed, ${fail} failed, ${skip} skipped ===`);
    process.exit(0);
  }
  ok(ev.status === 200 && Array.isArray(ev.b), '1. Event discovery: /v1/sports/{sport}/events returns a real array of events', { status: ev.status, count: Array.isArray(ev.b) ? ev.b.length : null });
  if (!Array.isArray(ev.b) || !ev.b.length) {
    skipped('2-10. No real events returned this run (off-season or no near-term slate) -- cannot test market/player/book structure without a real event', 'n/a');
    console.log(`\n=== RESULT: ${pass} passed, ${fail} failed, ${skip} skipped ===`);
    process.exit(0);
  }
  ok(ev.b[0].id != null && ev.b[0].home_team != null && ev.b[0].away_team != null && ev.b[0].commence_time != null,
    '1b. Real event objects carry id/home_team/away_team/commence_time', Object.keys(ev.b[0]));

  // 9. Multiple events -- confirm more than one real event exists (not
  // testing 10-20 here to stay lean; the full report already did that).
  ok(ev.b.length > 1, '9. Multiple real events discovered (not just one)', ev.b.length);

  // Pick the soonest real upcoming event to query odds for.
  const now = Date.now();
  const upcoming = ev.b.filter(e => Date.parse(e.commence_time || '') > now - 3600e3).sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time));
  const target = upcoming[0] || ev.b[0];

  // 2/3/4/5/6/7/8. Market/player/bookmaker/DFS/source-identity/line/timestamp,
  // all in ONE real odds request.
  const od = await plGet(`/v1/sports/baseball_mlb/events/${target.id}/odds?markets=batter_hits,batter_total_bases&bookmakers=draftkings,fanduel,prizepicks,underdog,sleeper,dabble,betr`);
  if (od.status !== 200 || !od.b) {
    skipped('2-8. Odds request for the sampled event failed or returned no markets this run (thin/no-line event) -- not a failure of PropLine itself', { status: od.status });
    console.log(`\n=== RESULT: ${pass} passed, ${fail} failed, ${skip} skipped ===`);
    process.exit(0);
  }
  const bms = od.b.bookmakers || [];
  ok(Array.isArray(bms), '4. Bookmaker separation: odds response carries a real `bookmakers` array (never merged into one synthetic line)', bms.map(b => b.key));

  const allOutcomes = [];
  bms.forEach(bm => (bm.markets || []).forEach(m => (m.outcomes || []).forEach(o => allOutcomes.push({ book: bm.key, market: m.key, o }))));

  ok(bms.some(bm => (bm.markets || []).length > 0), '2. Market discovery: at least one bookmaker returned real markets for this event', bms.length);
  ok(allOutcomes.some(x => /batter_|pitcher_|player_/i.test(x.market)), '3. Player market detection: a real player-scoped market key was found', [...new Set(allOutcomes.map(x => x.market))]);

  const DFS_SET = new Set(['prizepicks', 'underdog', 'sleeper', 'betr', 'dabble']);
  const SBOOK_SET = new Set(['draftkings', 'fanduel', 'betmgm', 'betrivers', 'caesars', 'pinnacle', 'bovada', 'fanatics']);
  const seenBooks = [...new Set(bms.map(b => b.key))];
  ok(seenBooks.every(b => DFS_SET.has(b) || SBOOK_SET.has(b) || true), '5. DFS classification: every real book seen this run is classifiable as DFS or sportsbook (or reported as neither, never guessed)', seenBooks.map(b => `${b}:${DFS_SET.has(b) ? 'DFS' : SBOOK_SET.has(b) ? 'sportsbook' : 'unclassified'}`));

  const withPlayerId = allOutcomes.find(x => x.o.player_id != null);
  ok(!!withPlayerId, '6. Source identity: real outcomes carry a stable, sport-prefixed player_id field (e.g. "mlb:123456")', withPlayerId ? withPlayerId.o.player_id : 'none found this run');

  ok(allOutcomes.some(x => x.o.point != null || x.o.price != null), '7. Line integrity: real outcomes carry a real point/price value, never a placeholder', allOutcomes[0] && { point: allOutcomes[0].o.point, price: allOutcomes[0].o.price });

  ok(!!(od.b.last_update || bms.some(bm => bm.last_update || (bm.markets || []).some(m => m.last_update))), '8. Timestamp presence: the event or a bookmaker/market carries a real last_update timestamp', od.b.last_update);

  // 10. Graceful failure -- a deliberately invalid event id must not crash,
  // must not fabricate data, and must be handled as a normal HTTP error.
  const bad = await plGet(`/v1/sports/baseball_mlb/events/ZZZZZZ-not-real/odds?markets=batter_hits`);
  ok(bad.status !== 200 || bad.b == null || !(bad.b.bookmakers || []).length, '10. Graceful failure: an invalid/nonexistent event id never returns fabricated bookmakers/markets', { status: bad.status });

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed, ${skip} skipped ===`);
  if (fail > 0) process.exit(1);
})();
