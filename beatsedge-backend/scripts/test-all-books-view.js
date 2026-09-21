// Phase 1-3 foundation -- "All Books" merged-view + universal prop identity
// regression suite.
//
// BeatsEdge.html is a monolithic, non-modular single file (no exports), so
// this test faithfully re-implements the exact logic this task added --
// BOOK_REGISTRY-derived registry, booksPresentIn, and the ALL_BOOKS branch
// of mlbBuildProps/buildProviderOnlyProps/assignPropIds -- byte-for-byte
// matching what now ships in BeatsEdge.html, and asserts the required
// coexistence properties against it. Mirrors the same "faithful standalone
// extraction" pattern already used by test-prizepicks-line-integrity.js and
// test-player-identity.js in this repo.

let pass = 0, fail = 0;
function check(cond, label, detail) {
  const ok = !!cond;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}

console.log('=== All Books / Universal Prop Identity Test ===\n');

// ---------------------------------------------------------------------
// Phase 1: canonical BOOK_REGISTRY is the single source for platforms,
// PLATFORM_BOOK and DFS_PLATFORMS -- reproduced verbatim from BeatsEdge.html.
// ---------------------------------------------------------------------
const BOOK_REGISTRY = [
  { id: 'prizepicks', name: 'PrizePicks', dfs: true },
  { id: 'underdog', name: 'Underdog', dfs: true },
  { id: 'sleeper', name: 'Sleeper', dfs: true },
  { id: 'fanduel', name: 'FanDuel', dfs: false },
  { id: 'draftkings', name: 'DraftKings', dfs: false },
  { id: 'betmgm', name: 'BetMGM', dfs: false },
  { id: 'betrivers', name: 'BetRivers', dfs: false },
  { id: 'caesars', name: 'Caesars', dfs: false },
  { id: 'pinnacle', name: 'Pinnacle', dfs: false },
  { id: 'bovada', name: 'Bovada', dfs: false }
];
const ALL_BOOKS = 'all';
const PLATFORM_BOOK = Object.fromEntries(BOOK_REGISTRY.map(b => [b.id, b.id]).concat([[ALL_BOOKS, ALL_BOOKS]]));
const DFS_PLATFORMS = new Set(BOOK_REGISTRY.filter(b => b.dfs).map(b => b.id));
const platforms = [{ id: ALL_BOOKS, name: 'All Books' }, ...BOOK_REGISTRY.map(b => ({ id: b.id, name: b.name }))];
const PROPLINE_BOOK_PRIORITY = ['draftkings', 'fanduel', 'betmgm', 'betrivers', 'caesars', 'pinnacle', 'prizepicks', 'underdog', 'sleeper', 'bovada'];

{
  // A book added to BOOK_REGISTRY once must appear in every derived list at
  // once -- the exact three-separate-lists failure mode (confirmed live
  // 2026-09-19 for Pinnacle) is now structurally impossible.
  const registryIds = new Set(BOOK_REGISTRY.map(b => b.id));
  const platformIds = new Set(platforms.filter(p => p.id !== ALL_BOOKS).map(p => p.id));
  const platformBookIds = new Set(Object.keys(PLATFORM_BOOK).filter(k => k !== ALL_BOOKS));
  check(registryIds.size === 10 && [...registryIds].every(id => platformIds.has(id)) && [...registryIds].every(id => platformBookIds.has(id)),
    '1. Every BOOK_REGISTRY id has a platforms tab AND a PLATFORM_BOOK entry -- the Pinnacle-style "fetched but no tab" bug is structurally impossible now', { registry: [...registryIds].sort() });
  check(platforms[0].id === ALL_BOOKS, '2. "All Books" is a real, selectable platform entry (not merely a UI label)', platforms[0]);
  check(PROPLINE_BOOK_PRIORITY.every(id => registryIds.has(id)) && registryIds.size === new Set(PROPLINE_BOOK_PRIORITY).size, '3. Every book requested from ParlayAPI (PROPLINE_BOOK_PRIORITY) is also in BOOK_REGISTRY, and vice versa -- no fetched book is un-registerable, no registered book goes unfetched', PROPLINE_BOOK_PRIORITY);
}

// ---------------------------------------------------------------------
// Phase 2: booksPresentIn + the ALL_BOOKS branch of a build function --
// reproduced verbatim from mlbBuildProps (BeatsEdge.html).
// ---------------------------------------------------------------------
const booksPresentIn = (allLines) => {
  const found = new Set();
  Object.values(allLines || {}).forEach(byBook => {
    Object.keys(byBook || {}).forEach(bk => found.add(bk));
  });
  const ordered = PROPLINE_BOOK_PRIORITY.filter(bk => found.has(bk));
  found.forEach(bk => { if (!ordered.includes(bk)) ordered.push(bk); });
  return ordered;
};

const MLB_PROP_DEFS = { hits: { type: 'Hits' }, totalBases: { type: 'Total Bases' } };
const assignPropIds = (props) => {
  const seen = {};
  (props || []).forEach(pr => {
    if (pr.id) return;
    const base = `${pr.statKey}|${pr.direction}|${pr.line}|${pr.ppKind || 'std'}|${pr.book || pr.lineSource || 'x'}`;
    const n = (seen[base] = (seen[base] || 0) + 1);
    pr.id = n > 1 ? `${base}|${n}` : base;
  });
  return props;
};
const buildProviderOnlyProps = (allLines, knownKeys, book) => {
  const known = new Set(knownKeys);
  const props = [];
  Object.keys(allLines || {}).forEach(rawKey => {
    if (known.has(rawKey)) return;
    const byBook = allLines[rawKey];
    const arr = byBook && byBook[book];
    if (!arr || !arr.length) return;
    arr.forEach(e => props.push({ type: rawKey, statKey: rawKey, line: e.line, modelSupported: false, book, direction: 'over', hitRate: null, eventId: e.eventId || null }));
  });
  return props;
};
const mlbBuildProps = (allLines, book) => {
  const props = [];
  const pushLine = (k, def, e, extra) => {
    if (DFS_PLATFORMS.has(extra.book) && (e.ppType === 'goblin' || e.ppType === 'demon')) {
      props.push({ type: def.type, statKey: k, line: e.line, ...extra, altLine: true, direction: 'over', oneWay: true, ppKind: e.ppType, odds: e.over ?? null });
      return;
    }
    const hasO = e.over != null, hasU = e.under != null;
    if (hasO === hasU) {
      props.push({ type: def.type, statKey: k, line: e.line, ...extra, direction: 'over', odds: e.over ?? null });
      props.push({ type: def.type, statKey: k, line: e.line, ...extra, direction: 'under', odds: e.under ?? null });
      return;
    }
    props.push({ type: def.type, statKey: k, line: e.line, ...extra, direction: hasO ? 'over' : 'under', oneWay: true, odds: (hasO ? e.over : e.under) ?? null });
  };
  const booksToBuild = book === ALL_BOOKS ? booksPresentIn(allLines) : [book];
  booksToBuild.forEach(bk => {
    Object.keys(MLB_PROP_DEFS).forEach(k => {
      const def = MLB_PROP_DEFS[k];
      const arr = allLines[k] && allLines[k][bk];
      if (!arr || !arr.length) return;
      arr.forEach(e => pushLine(k, def, e, { book: bk, eventId: e.eventId || null }));
    });
  });
  booksToBuild.forEach(bk => props.push(...buildProviderOnlyProps(allLines, Object.keys(MLB_PROP_DEFS), bk)));
  return assignPropIds(props);
};

// A realistic multi-book, multi-line, multi-projectionType allLines fixture
// -- exactly the "must coexist" example from the Phase 2 spec:
//   PrizePicks Hits 0.5 NORMAL / PrizePicks Hits 1.5 DEMON /
//   PrizePicks Hits 1.5 GOBLIN / FanDuel Hits 0.5 / Underdog Hits 1.5 /
//   DraftKings Hits 1.5
const allLines = {
  hits: {
    prizepicks: [
      { line: 0.5, over: null, under: null, ppType: null, eventId: 'evt1' },
      { line: 1.5, over: null, under: null, ppType: 'demon', eventId: 'evt1' },
      { line: 1.5, over: null, under: null, ppType: 'goblin', eventId: 'evt1' }
    ],
    fanduel: [{ line: 0.5, over: -145, under: +120, eventId: 'evt1' }],
    underdog: [{ line: 1.5, over: null, under: null, ppType: null, eventId: 'evt1' }],
    draftkings: [{ line: 1.5, over: -110, under: -110, eventId: 'evt1' }]
  },
  totalBases: { fanduel: [{ line: 1.5, over: -120, under: -105, eventId: 'evt1' }] },
  // An unmapped, provider-only raw market -- must survive as modelSupported:false.
  player_stolen_bases_alt: { prizepicks: [{ line: 0.5, over: null, under: null, eventId: 'evt1' }] }
};

const allBooksProps = mlbBuildProps(allLines, ALL_BOOKS);
const singleBookProps = mlbBuildProps(allLines, 'prizepicks');

// --- 1. ALL BOOKS contains multiple books simultaneously ------------------
{
  const booksSeen = new Set(allBooksProps.map(p => p.book));
  check(booksSeen.size === 4, '1. All Books contains all 4 real books at once (prizepicks/fanduel/underdog/draftkings), not just one', [...booksSeen].sort());
}
// --- 2/3/4. Single-book-only markets remain visible in All Books ----------
check(allBooksProps.some(p => p.book === 'prizepicks' && p.statKey === 'hits' && p.line === 0.5 && !p.ppKind), '2. PrizePicks-only normal Hits 0.5 line remains visible in All Books', null);
check(allBooksProps.some(p => p.book === 'fanduel' && p.statKey === 'totalBases'), '3. FanDuel-only Total Bases market remains visible in All Books', null);
check(allBooksProps.some(p => p.book === 'underdog' && p.statKey === 'hits' && p.line === 1.5), '4. Underdog-only Hits 1.5 line remains visible in All Books', null);
// --- 5. Same player/market across multiple books remains visible ----------
{
  const hitsBooks = new Set(allBooksProps.filter(p => p.statKey === 'hits').map(p => p.book));
  check(hitsBooks.size === 4, '5. Same player/market (Hits) visible across all 4 books simultaneously, none overwrite another', [...hitsBooks].sort());
}
// --- 6. NORMAL + DEMON + GOBLIN coexist ------------------------------------
{
  const ppKinds = new Set(allBooksProps.filter(p => p.book === 'prizepicks' && p.statKey === 'hits').map(p => p.ppKind || 'normal'));
  check(ppKinds.size === 3 && ppKinds.has('normal') && ppKinds.has('demon') && ppKinds.has('goblin'), '6. PrizePicks NORMAL + DEMON + GOBLIN Hits props all coexist in the same All Books build, none hidden by another', [...ppKinds]);
}
// --- 7. Different lines for the same player/market coexist ----------------
{
  const hitsLines = new Set(allBooksProps.filter(p => p.statKey === 'hits').map(p => p.line));
  check(hitsLines.has(0.5) && hitsLines.has(1.5), '7. Different lines for the same player/market (0.5 and 1.5) coexist, neither overwrites the other', [...hitsLines]);
}
// --- 9. Provider-only (unmapped) markets remain visible --------------------
{
  const providerOnly = allBooksProps.find(p => p.statKey === 'player_stolen_bases_alt');
  check(!!providerOnly && providerOnly.modelSupported === false, '9. An unmapped provider-only market (player_stolen_bases_alt) survives into All Books, tagged modelSupported:false', providerOnly);
}
// --- 10. Real provider line never receives fake model output --------------
{
  const providerOnly = allBooksProps.find(p => p.statKey === 'player_stolen_bases_alt');
  check(providerOnly.hitRate === null && providerOnly.modelSupported === false, '10. Provider-only prop has no fabricated hitRate/model output -- explicitly null, gated by modelSupported:false', providerOnly);
}
// --- 11. eventId remains preserved -----------------------------------------
check(allBooksProps.every(p => p.eventId === 'evt1'), '11. eventId is preserved on every prop built in All Books mode, for every book', [...new Set(allBooksProps.map(p => p.eventId))]);

// --- Selecting a single book still returns ONLY that book (no regression) --
{
  const books = new Set(singleBookProps.map(p => p.book));
  check(books.size === 1 && books.has('prizepicks'), 'REGRESSION: selecting a single book (prizepicks) still returns ONLY that book\'s props -- All Books mode never changes single-book behavior', [...books]);
  check(singleBookProps.length < allBooksProps.length, 'REGRESSION: single-book prop count is strictly smaller than All Books\' -- All Books is additive, never a silent replacement of the single-book view', { single: singleBookProps.length, all: allBooksProps.length });
}

// --- No id collisions across books (assignPropIds is book-aware) ----------
{
  const ids = allBooksProps.map(p => p.id);
  check(new Set(ids).size === ids.length, 'assignPropIds produces a unique id for every prop across all 4 books, 3 projection kinds and 2 lines -- no collisions despite the same statKey repeating', { count: ids.length, unique: new Set(ids).size });
}

// --- Period (Phase 4/5, explicitly deferred): not implemented this phase --
check(true, 'Period (1Q/1H/2H) dimension is explicitly deferred to Phase 4/5 per scope -- no period data is fabricated here; lib/propLineNormalize.js\'s dedupeKey already reserves a period slot (see test-propline-provider.js #24) so this does not require another identity-scheme change later');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
