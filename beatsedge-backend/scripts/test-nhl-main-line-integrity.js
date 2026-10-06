// NHL sportsbook / main-line integrity (model-integrity containment).
//
// Defects fixed (BeatsEdge.html, fetchNhlPropLines):
//   1. `byBook[wantBook] || Object.values(byBook)[0]` then `book: wantBook` -> ANOTHER book's line was shown under the requested book's name.
//   2. `arr.find(e => e.primary) || arr[0]` -> nothing sets `primary` for NHL, so provider array order picked the main line (alternates
//      could silently become THE line).
//   3. No game filter: rows from different games for the same player merged into one array.
//
// This test runs the REAL shipped helpers (nhlPickPlayerEvent / nhlSelectMainLine / nhlResolveBookLine) extracted from BeatsEdge.html
// and asserts source-level guards on the loader. It does NOT call the live provider (not verified here).
//
//   node scripts/test-nhl-main-line-integrity.js

const fs = require('fs');
const { loadModel, HTML_PATH } = require('./lib/loadBeatsEdgeModel');

let failures = 0;
function check(name, cond, detail) { if (cond) console.log(`PASS  ${name}`); else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); } }

const m = loadModel();
const PRIORITY = ['draftkings', 'fanduel', 'betmgm', 'betrivers', 'caesars', 'pinnacle', 'prizepicks', 'underdog', 'sleeper', 'bovada'];
const NOW = Date.parse('2026-10-06T12:00:00Z');
const G1 = Date.parse('2026-10-06T23:00:00Z'), G2 = Date.parse('2026-10-08T23:00:00Z');

function e(o) {
  return Object.assign({ line: 2.5, over: -115, under: -105, ppType: null, eventId: 'E1', homeTeam: 'TOR', awayTeam: 'MTL', commenceTimeMs: G1, playerRaw: 'Auston Matthews', primary: false }, o);
}
const resolve = (byBook, wantBook, eventKey) => m.nhlResolveBookLine(byBook, { wantBook, allBooksId: m.ALL_BOOKS, priority: PRIORITY, dfsBooks: m.DFS_PLATFORMS, eventKey: eventKey || 'id:E1' });

// ── 1. requested book can never receive another book's line ────────────────
{
  const byBook = { draftkings: [e({ line: 3.5 })] };
  const r = resolve(byBook, 'prizepicks');
  check('requested PrizePicks, only DraftKings has a row -> FAIL CLOSED (no entry)', r.entry === null && r.book === null);
  const r2 = resolve({ draftkings: [e({ line: 3.5 })], prizepicks: [e({ line: 2.5, ppType: 'standard' })] }, 'prizepicks');
  check('requested PrizePicks with both books present -> the PrizePicks row', r2.entry && r2.entry.line === 2.5 && r2.book === 'prizepicks');
  const r3 = resolve({ draftkings: [e({ line: 3.5 })], fanduel: [e({ line: 2.5 })] }, 'fanduel');
  check('requested FanDuel returns FanDuel line, stamped fanduel (not draftkings)', r3.entry.line === 2.5 && r3.book === 'fanduel');
}

// ── 2. ALL_BOOKS stamps the REAL book, deterministically, by priority ───────
{
  const byBook = { bovada: [e({ line: 9.5 })], fanduel: [e({ line: 2.5 })], draftkings: [e({ line: 3.5 })] };
  const r = resolve(byBook, m.ALL_BOOKS);
  check('ALL_BOOKS picks by fixed priority (draftkings first), regardless of object insertion order', r.book === 'draftkings' && r.entry.line === 3.5);
  const reordered = { draftkings: byBook.draftkings, fanduel: byBook.fanduel, bovada: byBook.bovada };
  check('ALL_BOOKS result identical under a different key order', resolve(reordered, m.ALL_BOOKS).book === 'draftkings');
  const r2 = resolve({ bovada: [e({ line: 9.5 })] }, m.ALL_BOOKS);
  check('ALL_BOOKS with only Bovada -> stamped bovada, never the sentinel "all"', r2.book === 'bovada' && r2.book !== m.ALL_BOOKS);
  const r3 = resolve({ draftkings: [e({ line: 2.5, over: -300, under: null }), e({ line: 3.5, over: 150, under: null })], fanduel: [e({ line: 2.5 })] }, m.ALL_BOOKS);
  check('ALL_BOOKS skips a book whose main line is unidentifiable and uses the next book (stamped honestly)', r3.book === 'fanduel');
}

// ── 3. provider order must not decide the main line (sportsbook ladder) ─────
{
  const rungs = [
    e({ line: 0.5, over: -450, under: 330 }),
    e({ line: 1.5, over: -150, under: 125 }),
    e({ line: 2.5, over: -110, under: -110 }),
    e({ line: 3.5, over: 240, under: -310 }),
  ];
  const fwd = m.nhlSelectMainLine(rungs, { isDfs: false, eventKey: 'id:E1' });
  const rev = m.nhlSelectMainLine(rungs.slice().reverse(), { isDfs: false, eventKey: 'id:E1' });
  const shuf = m.nhlSelectMainLine([rungs[2], rungs[0], rungs[3], rungs[1]], { isDfs: false, eventKey: 'id:E1' });
  check('main line = pair closest to even money (2.5 @ -110/-110)', fwd.entry && fwd.entry.line === 2.5 && fwd.reason === 'two_sided_closest_to_even');
  check('main line identical regardless of provider array order (forward/reverse/shuffled)', rev.entry.line === 2.5 && shuf.entry.line === 2.5);
  const withOneSidedAlts = [e({ line: 1.5, over: -300, under: null }), e({ line: 2.5, over: -120, under: 100 }), e({ line: 3.5, over: 200, under: null })];
  const r = m.nhlSelectMainLine(withOneSidedAlts, { isDfs: false, eventKey: 'id:E1' });
  check('one-sided alternate rungs never replace the two-sided main line', r.entry.line === 2.5);
  const r2 = m.nhlSelectMainLine(withOneSidedAlts.filter(x => x.under == null), { isDfs: false, eventKey: 'id:E1' });
  check('one-sided-only ladder (several rungs) -> FAIL CLOSED, no invented main line', r2.entry === null && r2.reason === 'ladder_no_two_sided');
  const tie = m.nhlSelectMainLine([e({ line: 2.5, over: -110, under: -110 }), e({ line: 3.5, over: -110, under: -110 })], { isDfs: false, eventKey: 'id:E1' });
  check('exact tie between two different two-sided lines -> FAIL CLOSED (ambiguous)', tie.entry === null && tie.reason === 'ladder_tie');
  const sole = m.nhlSelectMainLine([e({ line: 0.5, over: -200, under: null })], { isDfs: false, eventKey: 'id:E1' });
  check('a sole one-sided line (e.g. anytime-scorer market) is the only line posted -> accepted, under stays null (never mirrored)', sole.entry && sole.entry.under === null && sole.reason === 'sole_line');
  const bad = m.nhlSelectMainLine([e({ line: 2.5, over: 1.9, under: 1.9 }), e({ line: 3.5, over: 2.1, under: 1.7 })], { isDfs: false, eventKey: 'id:E1' });
  check('decimal/malformed prices are not treated as American odds -> FAIL CLOSED', bad.entry === null);
}

// ── 4. DFS: goblin/demon are alternates, standard is the main line ──────────
{
  const arr = [e({ line: 1.5, ppType: 'goblin' }), e({ line: 3.5, ppType: 'demon' }), e({ line: 2.5, ppType: 'standard' })];
  const r = m.nhlSelectMainLine(arr, { isDfs: true, eventKey: 'id:E1' });
  check('DFS main line = the single standard row (goblin/demon never the main line)', r.entry.line === 2.5 && r.reason === 'dfs_standard');
  const r2 = m.nhlSelectMainLine(arr.slice().reverse(), { isDfs: true, eventKey: 'id:E1' });
  check('DFS main line independent of array order', r2.entry.line === 2.5);
  const r3 = m.nhlSelectMainLine([e({ line: 1.5, ppType: 'goblin' }), e({ line: 3.5, ppType: 'demon' })], { isDfs: true, eventKey: 'id:E1' });
  check('DFS with only goblin/demon -> FAIL CLOSED (alternates cannot stand in for the main line)', r3.entry === null && r3.reason === 'dfs_no_standard');
  const r4 = m.nhlSelectMainLine([e({ line: 2.5, ppType: 'standard' }), e({ line: 3.5, ppType: 'standard' })], { isDfs: true, eventKey: 'id:E1' });
  check('DFS with two "standard" rows -> FAIL CLOSED (ambiguous)', r4.entry === null && r4.reason === 'dfs_multiple_standard');
  const r5 = m.nhlSelectMainLine([e({ line: 2.5, ppType: null }), e({ line: 3.5, ppType: null })], { isDfs: true, eventKey: 'id:E1' });
  check('DFS with several untagged lines -> FAIL CLOSED', r5.entry === null);
  const r6 = m.nhlSelectMainLine([e({ line: 2.5, ppType: 'goblin' })], { isDfs: true, eventKey: 'id:E1' });
  check('DFS with a lone GOBLIN row -> FAIL CLOSED (not a main line)', r6.entry === null);
  const r7 = resolve({ prizepicks: arr }, 'prizepicks');
  check('PrizePicks resolution through nhlResolveBookLine uses the DFS rule', r7.entry.line === 2.5 && r7.book === 'prizepicks');
}

// ── 5. Over and Under belong to the same row / game; one game per player ────
{
  const g1 = e({ eventId: 'E1', commenceTimeMs: G1, line: 2.5, over: -110, under: -110 });
  const g2 = e({ eventId: 'E2', commenceTimeMs: G2, line: 3.5, over: -140, under: 115, homeTeam: 'BOS', awayTeam: 'TOR' });
  const byStat = { shots_on_goal: { draftkings: [g2, g1] } };
  const ev = m.nhlPickPlayerEvent(byStat, NOW);
  check('player event = earliest UPCOMING game, independent of row order', ev.key === 'id:E1' && ev.commenceMs === G1 && ev.homeTeam === 'TOR');
  const r = resolve({ draftkings: [g2, g1] }, 'draftkings', ev.key);
  check('line is read ONLY from the chosen game (E1 -> 2.5, never E2\'s 3.5)', r.entry === g1 && r.entry.over === -110 && r.entry.under === -110);
  const r2 = resolve({ draftkings: [g2] }, 'draftkings', 'id:E1');
  check('no row for the chosen game -> FAIL CLOSED (does not fall to the other game)', r2.entry === null);
  const past = e({ eventId: 'E0', commenceTimeMs: NOW - 3600e3 });
  const ev2 = m.nhlPickPlayerEvent({ shots_on_goal: { draftkings: [past, g2] } }, NOW);
  check('an already-started game is not preferred over an upcoming one', ev2.key === 'id:E2');
  const ev3 = m.nhlPickPlayerEvent({ shots_on_goal: { draftkings: [past] } }, NOW);
  check('if every game has started the earliest is still returned deterministically (render-time start filter hides it)', ev3.key === 'id:E0');
  const evSame = m.nhlPickPlayerEvent({ a: { draftkings: [g1, g2] }, b: { fanduel: [g2, g1] } }, NOW);
  check('event pick stable across stats/books ordering', evSame.key === 'id:E1');
  const anon = m.nhlEntryEventKey(e({ eventId: null }));
  check('rows without event_id key on teams+start time (never collapse distinct games)', anon.startsWith('anon:TOR') || anon.startsWith('anon:'));
  check('over/under are carried together on the single selected row object', (() => { const x = resolve({ draftkings: [g1] }, 'draftkings').entry; return x.over === g1.over && x.under === g1.under; })());
}

// ── 6. Source-level guards on the real loader ──────────────────────────────
{
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const a = html.indexOf('const fetchNhlPropLines = async (isStale) => {');
  const b = html.indexOf('const fetchNflPropLines', a);
  const body = a > -1 ? html.slice(a, b > a ? b : a + 40000) : '';
  check('fetchNhlPropLines found', a > -1);
  check('loader no longer falls back to another book (`Object.values(byBook)[0]`)', !/Object\.values\(byBook\)\[0\]/.test(body));
  check('loader no longer picks `arr[0]` as the main line', !/\|\|\s*arr\[0\]/.test(body));
  check('loader no longer stamps `book: wantBook` on the row', !/book:\s*wantBook\b/.test(body));
  check('loader stamps the book the row actually came from (sel.book)', /book:\s*sel\.book/.test(body));
  check('loader resolves lines only through nhlResolveBookLine with the chosen game key', /nhlResolveBookLine\(byBook,[^)]*eventKey:\s*nhlEvent\.key/.test(body));
  check('loader derives player/game metadata from the chosen event (nhlPickPlayerEvent)', /nhlPickPlayerEvent\(byStat,\s*Date\.now\(\)\)/.test(body));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
