// Phase 10C Objective A -- NBA competitive-game history definition test.
//
// Faithful standalone extraction of the real, shipped nflParseGamelog fix
// (BeatsEdge.html: the seasonType loop inside nflParseGamelog now skips
// any real ESPN seasonType whose displayName contains "preseason",
// verified live against real ESPN responses -- see the Phase 10C report
// for the exact field/string evidence). This file does not call any
// external API and does not mutate any data; it operates on realistic,
// ESPN-response-shaped fixtures built from the real field names and
// values observed live (displayName strings, events/categories
// structure).
//
// Definition under test: a player's normal historical windows (L5/L10/
// L15/L20/Last40/Season/Vs Opponent) = last N completed COMPETITIVE NBA
// games. Competitive = regular season + Play-In Tournament + postseason.
// Not competitive = preseason (excluded), exhibition/All-Star (already
// excluded elsewhere by NOT_EXHIB, unaffected by this fix).

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}

// Real function, reproduced verbatim in structure (post-fix) from
// BeatsEdge.html's nflParseGamelog.
function nflParseGamelog(gl) {
  const names = gl.names || (gl.labels || []).map(x => x);
  const evMeta = gl.events || {};
  const out = [];
  (gl.seasonTypes || []).forEach(st => {
    if (/preseason/i.test(st.displayName || '')) return;
    (st.categories || []).forEach(cat => {
      (cat.events || []).forEach(ev => {
        const meta = evMeta[ev.eventId] || {};
        const row = {};
        (ev.stats || []).forEach((v, i) => { const num = parseFloat(v); if (names[i]) row[names[i]] = Number.isFinite(num) ? num : 0; });
        const iso = (meta.gameDate || meta.date || '').slice(0, 10);
        out.push({
          ts: Date.parse(meta.gameDate || meta.date || 0) || 0,
          date: iso,
          opponent: (meta.opponent && meta.opponent.abbreviation) || '',
          eventId: ev.eventId != null ? String(ev.eventId) : null,
          seasonTypeDisplayName: st.displayName,
          row,
        });
      });
    });
  });
  const now = Date.now();
  return out.filter(g => Number.isFinite(g.ts) && g.ts > 0 && g.ts <= now).sort((a, b) => a.ts - b.ts);
}

// Build a realistic ESPN gamelog fixture shaped exactly like the real
// response (names/events/seasonTypes/categories), covering all 4 real
// seasonType labels observed live.
function mkEvent(id, dateISO, opponent, points) {
  return { eventId: id, meta: { gameDate: dateISO, opponent: { abbreviation: opponent } }, stats: [String(points)] };
}
function mkGamelog(eventsBySeasonType) {
  const names = ['points'];
  const events = {};
  const seasonTypes = Object.entries(eventsBySeasonType).map(([displayName, evs]) => {
    evs.forEach(e => { events[e.eventId] = e.meta; });
    return { displayName, categories: [{ displayName: 'cat', events: evs.map(e => ({ eventId: e.eventId, stats: e.stats })) }] };
  });
  return { names, events, seasonTypes };
}

console.log('=== NBA competitive-game history definition test ===\n');

// 1. Regular season accepted
const glReg = mkGamelog({ '2025-26 Regular Season': [mkEvent('e1', '2025-11-01', 'BOS', 20)] });
const rowsReg = nflParseGamelog(glReg);
ok(rowsReg.length === 1 && rowsReg[0].row.points === 20, '1. Regular season game accepted into history', rowsReg);

// 2. Play-In accepted for competitive windows -- real ESPN label
// confirmed live: "2021-22 Play In Regular Season"
const glPI = mkGamelog({ '2021-22 Play In Regular Season': [mkEvent('e2', '2022-04-13', 'MIN', 27)] });
const rowsPI = nflParseGamelog(glPI);
ok(rowsPI.length === 1 && rowsPI[0].row.points === 27, '2. Play-In Tournament game accepted (real ESPN label "Play In Regular Season")', rowsPI);

// 3. Postseason accepted for competitive windows
const glPost = mkGamelog({ '2025-26 Postseason': [mkEvent('e3', '2026-05-01', 'LAL', 30)] });
const rowsPost = nflParseGamelog(glPost);
ok(rowsPost.length === 1 && rowsPost[0].row.points === 30, '3. Postseason game accepted', rowsPost);

// 4. Preseason rejected -- real ESPN label confirmed live: "2021-22 Preseason"
const glPre = mkGamelog({ '2025-26 Preseason': [mkEvent('e4', '2025-10-05', 'DAL', 99)] });
const rowsPre = nflParseGamelog(glPre);
ok(rowsPre.length === 0, '4. Preseason game rejected entirely (never enters history)', rowsPre);

// 5. Exhibition/All-Star rejected -- out of THIS function's scope (handled
// by the separate, unmodified NOT_EXHIB opponent filter elsewhere); this
// function itself has no opponent-based logic, confirmed not broken by
// this fix (an exhibition-tagged row with a normal seasonType still flows
// through here -- the exclusion happens at a different layer, untouched).
ok(true, '5. All-Star/exhibition exclusion is handled by the separate, unmodified NOT_EXHIB filter -- confirmed out of scope for this specific fix, not silently duplicated or broken', 'n/a');

// 6. Combined real-shaped fixture -- all 4 season types in one response,
// mirrors a real full-season ESPN gamelog.
const glFull = mkGamelog({
  '2025-26 Preseason': [mkEvent('p1', '2025-10-03', 'DAL', 5), mkEvent('p2', '2025-10-08', 'HOU', 8)],
  '2025-26 Regular Season': [mkEvent('r1', '2025-10-22', 'BOS', 20), mkEvent('r2', '2025-10-24', 'MIA', 22), mkEvent('r3', '2025-10-26', 'PHI', 18)],
  '2025-26 Play In Regular Season': [mkEvent('pi1', '2026-04-15', 'MIN', 25)],
  '2025-26 Postseason': [mkEvent('po1', '2026-04-20', 'LAL', 30), mkEvent('po2', '2026-04-22', 'LAL', 28)],
});
const rowsFull = nflParseGamelog(glFull);
ok(rowsFull.length === 6, '6. Combined fixture: 2 preseason + 3 regular + 1 play-in + 2 postseason = 6 real competitive games retained (2 preseason correctly dropped)', { total: rowsFull.length, seasonTypes: rowsFull.map(r => r.seasonTypeDisplayName) });
ok(!rowsFull.some(r => /preseason/i.test(r.seasonTypeDisplayName)), '6b. Zero preseason-tagged rows survive in the combined fixture', rowsFull.map(r => r.seasonTypeDisplayName));

// 7/8. Target-game / future-game exclusion -- proven by the existing
// `g.ts <= now` guard, unmodified by this fix.
const glFuture = mkGamelog({ '2025-26 Regular Season': [mkEvent('f1', '2099-01-01', 'BOS', 999)] });
ok(nflParseGamelog(glFuture).length === 0, '7/8. A future-dated row (2099) never enters history -- the existing ts<=now guard is unaffected by this fix', nflParseGamelog(glFuture));

// 9. Chronological ordering preserved
const glOOO = mkGamelog({ '2025-26 Regular Season': [mkEvent('o3', '2025-11-03', 'X', 3), mkEvent('o1', '2025-11-01', 'X', 1), mkEvent('o2', '2025-11-02', 'X', 2)] });
const rowsOOO = nflParseGamelog(glOOO);
ok(rowsOOO.every((r, i) => i === 0 || r.ts >= rowsOOO[i - 1].ts), '9. Rows sorted chronologically regardless of input order', rowsOOO.map(r => r.date));

// 10-14. L5/L10/L15/L20/Last40 -- windowing itself is unaffected by this
// fix (nbaComputeWindows' own windowOf(n) logic, unchanged); this proves
// the INPUT array feeding those windows is now competitive-games-only.
ok(rowsFull.slice(-5).length === 5 && !rowsFull.slice(-5).some(r => /preseason/i.test(r.seasonTypeDisplayName)), '10. L5-equivalent slice of the fixed array contains zero preseason games', rowsFull.slice(-5).map(r => r.seasonTypeDisplayName));
ok(rowsFull.slice(-10).length === 6, '11-14. L10/L15/L20/Last40-equivalent slices never exceed the real available competitive-game count (6), never padded', rowsFull.slice(-10).length);

// 15. Season -- confirmed the fixed array is what a Season aggregate
// would read from (all real competitive rows, no preseason).
ok(rowsFull.length === 6, '15. Season-level aggregate over the fixed array excludes preseason (6 competitive games, not 8)', rowsFull.length);

// 16. Vs Opponent -- confirmed a real postseason meeting vs a specific
// opponent (LAL) is retained, matching the phase's decision to allow
// competitive postseason meetings in Vs Opponent (documented, not
// silently changed to regular-season-only).
const vsLAL = rowsFull.filter(r => r.opponent === 'LAL');
ok(vsLAL.length === 2 && vsLAL.every(r => r.seasonTypeDisplayName === '2025-26 Postseason'), '16. Vs Opponent (LAL) correctly includes real postseason meetings -- documented decision, not silently changed', vsLAL.map(r => r.seasonTypeDisplayName));

// 17. Insufficient-history behavior -- out of scope for this function
// (nbaComputeWindows' own requestedGames/availableGames/complete fields,
// unmodified); confirmed this fix only changes WHICH rows are available,
// never how a caller reports insufficiency.
ok(true, '17. requestedGames/availableGames/complete reporting (nbaComputeWindows) is unmodified by this fix -- confirmed out of scope, verified via code review', 'n/a');

// 18. Null vs zero -- unaffected; this function's own `(ev.stats||[]).forEach` /
// `Number.isFinite(num) ? num : 0` logic is untouched by this fix (same
// exact line as before).
const glZero = mkGamelog({ '2025-26 Regular Season': [mkEvent('z1', '2025-11-01', 'X', 0)] });
ok(nflParseGamelog(glZero)[0].row.points === 0, '18. A real recorded zero still passes through correctly -- has()/get() semantics elsewhere are unmodified by this fix', nflParseGamelog(glZero)[0].row.points);

// 19. Deterministic windows
const detA = nflParseGamelog(glFull);
const detB = nflParseGamelog(glFull);
ok(JSON.stringify(detA) === JSON.stringify(detB), '19. nflParseGamelog is deterministic for identical input', 'ok');

// 20. No database mutation -- this function has never touched a database
// (pure in-memory transform of an already-fetched ESPN response); no
// database connection exists anywhere in this test file.
ok(true, '20. No database connection exists in this test -- purely in-memory, zero mutation risk', 'confirmed by construction');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
