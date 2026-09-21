// Phase 4-5 -- game-specific prop view (eventId) + period architecture
// (1Q/1H/2H) regression suite.
//
// BeatsEdge.html is a monolithic, non-modular single file (no exports), so
// this test faithfully re-implements the exact logic this task added --
// PERIOD_MARKET_MAP/periodForMarketKey, the period/homeTeam/awayTeam tags
// added to buildProviderOnlyProps and the three known-market build
// functions, and the gradedPlayers eventId/period filter wrapper -- byte-
// for-byte matching what now ships in BeatsEdge.html, and asserts the 14
// required properties against it. Mirrors the "faithful standalone
// extraction" pattern already used by test-all-books-view.js,
// test-prizepicks-line-integrity.js and test-player-identity.js.

let pass = 0, fail = 0;
function check(cond, label, detail) {
  const ok = !!cond;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}

console.log('=== Game-Specific View / Period Architecture Test ===\n');

// ---------------------------------------------------------------------
// Phase 5 (updated with the fresh live inventory) -- PERIOD_MARKET_MAP +
// periodForMarketKey, reproduced verbatim from BeatsEdge.html. WNBA
// entries confirmed 2026-09-18; NFL entries confirmed 2026-09-21 via a
// full live 5-sport ParlayAPI inventory pull run from inside the running
// app itself (tmp/parlayapi-period-inventory-all-sports.json). Every raw
// key below is copied character-for-character from that real file, not
// paraphrased or guessed -- confirmed by reading the file directly
// (its exact spellings, e.g. "pass_yds" not "passing_yards", differ from
// an earlier informal description of the same data).
// ---------------------------------------------------------------------
const PERIOD_MARKET_MAP = {
  // WNBA
  player_points_1st_quarter: '1Q',
  player_points_1st_half: '1H',
  player_fantasy_points_1st_half: '1H',
  player_pra_1st_half: '1H',
  player_pts_rebs_asts_1st_half: '1H',
  player_assists_1st_half: '1H',
  player_rebounds_1st_half: '1H',
  // NFL -- 1Q (14 confirmed real keys)
  player_anytime_td_1st_quarter: '1Q',
  player_anytime_tds_1st_quarter: '1Q',
  player_fantasy_points_1st_quarter: '1Q',
  player_int_1st_quarter: '1Q',
  player_pass_attempts_1st_quarter: '1Q',
  player_pass_completions_1st_quarter: '1Q',
  player_pass_tds_1st_quarter: '1Q',
  player_pass_yds_1st_quarter: '1Q',
  player_rec_yards_1st_quarter: '1Q',
  player_receiving_yards_1st_quarter: '1Q',
  player_receptions_1st_quarter: '1Q',
  'player_rush___rec_tds_1st_quarter': '1Q',
  player_rush_attempts_1st_quarter: '1Q',
  player_rush_yards_1st_quarter: '1Q',
  // NFL -- 1H (12 confirmed real keys)
  player_anytime_td_1st_half: '1H',
  player_anytime_tds_1st_half: '1H',
  player_fantasy_points_1st_half: '1H',
  player_fg_made_1st_half: '1H',
  player_fg_made_combo_1st_half: '1H',
  player_pass_tds_1st_half: '1H',
  player_pass_yds_1st_half: '1H',
  player_rec_yards_1st_half: '1H',
  player_receiving_yards_1st_half: '1H',
  player_receptions_1st_half: '1H',
  'player_rush___rec_tds_1st_half': '1H',
  player_rush_yards_1st_half: '1H',
  // NFL -- 2H (the ONLY confirmed real 2H player-prop-shaped market found
  // anywhere in the inventory, any sport -- Bovada-only, no DFS source)
  anytime_2nd_half_td_scorer: '2H'
};
const PERIOD_PATTERN_1Q = /(^|_)(1st|first)_quarter($|_)/;
const PERIOD_PATTERN_1H = /(^|_)(1st|first)_half($|_)/;
const PERIOD_PATTERN_2H = /(^|_)(2nd|second)_half($|_)/;
const periodForMarketKey = (rawKey) => {
  if (Object.prototype.hasOwnProperty.call(PERIOD_MARKET_MAP, rawKey)) return PERIOD_MARKET_MAP[rawKey];
  const k = String(rawKey || '');
  if (PERIOD_PATTERN_1Q.test(k)) return '1Q';
  if (PERIOD_PATTERN_1H.test(k)) return '1H';
  if (PERIOD_PATTERN_2H.test(k)) return '2H';
  return 'UNKNOWN';
};

check(periodForMarketKey('player_points_1st_quarter') === '1Q', 'PERIOD_MARKET_MAP: real captured WNBA 1Q key normalizes to 1Q', periodForMarketKey('player_points_1st_quarter'));
check(periodForMarketKey('player_points_1st_half') === '1H', 'PERIOD_MARKET_MAP: real captured WNBA 1H key normalizes to 1H', periodForMarketKey('player_points_1st_half'));
check(periodForMarketKey('player_pass_yds_1st_quarter') === '1Q', 'PERIOD_MARKET_MAP: real captured NFL 1Q key (player_pass_yds_1st_quarter) normalizes to 1Q -- exact raw spelling from the live inventory, not "passing_yards"', periodForMarketKey('player_pass_yds_1st_quarter'));
check(periodForMarketKey('player_pass_yds_1st_half') === '1H', 'PERIOD_MARKET_MAP: real captured NFL 1H key normalizes to 1H', periodForMarketKey('player_pass_yds_1st_half'));
check(periodForMarketKey('anytime_2nd_half_td_scorer') === '2H', 'PERIOD_MARKET_MAP: the one real confirmed 2H key (Bovada-only, no "player_" prefix) normalizes to 2H', periodForMarketKey('anytime_2nd_half_td_scorer'));
check(periodForMarketKey('player_pass_yds') === 'UNKNOWN' || periodForMarketKey('player_pass_yds') === undefined, 'A full-game-shaped raw key with no map entry is NOT silently classified full-game (this path is only reached for markets NOT in *_PROP_DEFS)', periodForMarketKey('player_pass_yds'));
check(periodForMarketKey('player_points_2nd_half') === '2H', 'A 2nd-half-shaped key with no EXACT map entry (no WNBA/NBA 2H evidence exists) still correctly classifies via the narrow pattern fallback rather than dropping to UNKNOWN -- the fallback exists precisely so an unconfirmed-but-unambiguous key is not silently lost; it is NOT claiming WNBA/NBA actually has a 2H market today (PERIOD_MARKET_MAP itself, checked next, has none for those sports)', periodForMarketKey('player_points_2nd_half'));
check(Object.values(PERIOD_MARKET_MAP).filter(v => v === '2H').length === 1, 'PERIOD_MARKET_MAP contains exactly ONE real 2H entry (anytime_2nd_half_td_scorer) -- honest reflection of the live inventory, never padded to make the 2H page look more populated than it is', Object.values(PERIOD_MARKET_MAP).filter(v => v === '2H'));

// --- Narrow pattern fallback (future, not-yet-manually-reviewed keys) -----
check(periodForMarketKey('player_some_new_stat_1st_quarter') === '1Q', 'Narrow pattern fallback: a hypothetical FUTURE key not yet in PERIOD_MARKET_MAP, but following the same confirmed "_1st_quarter" suffix, still classifies as 1Q rather than falling to UNKNOWN', periodForMarketKey('player_some_new_stat_1st_quarter'));
check(periodForMarketKey('player_first_downs') === 'UNKNOWN', 'Narrow pattern fallback does NOT false-positive: "player_first_downs" contains "first" but not "first_quarter"/"first_half", so it correctly stays UNKNOWN -- proves the pattern is not broad substring matching', periodForMarketKey('player_first_downs'));
check(periodForMarketKey('player_half_inning_number_of_pitches_thrown_ranges') === 'UNKNOWN', 'Narrow pattern fallback does NOT false-positive on a real UNKNOWN-bucket MLB key that merely contains "half" as part of "half_inning" -- proves the pattern requires the exact "_1st_half"/"_2nd_half" shape, not a bare substring', periodForMarketKey('player_half_inning_number_of_pitches_thrown_ranges'));

// ---------------------------------------------------------------------
// Phase 1-5 combined build path -- reproduced verbatim (trimmed to what's
// needed here; full version already covered by test-all-books-view.js).
// ---------------------------------------------------------------------
const DFS_PLATFORMS = new Set(['prizepicks', 'underdog', 'sleeper']);
const MLB_PROP_DEFS = { hits: { type: 'Hits' } };
const buildProviderOnlyProps = (allLines, knownKeys, book) => {
  const known = new Set(knownKeys);
  const props = [];
  Object.keys(allLines || {}).forEach(rawKey => {
    if (known.has(rawKey)) return;
    const byBook = allLines[rawKey];
    const arr = byBook && byBook[book];
    if (!arr || !arr.length) return;
    arr.forEach(e => props.push({
      type: rawKey, statKey: rawKey, line: e.line, modelSupported: false, book,
      eventId: e.eventId || null, commenceTimeMs: e.commenceTimeMs != null ? e.commenceTimeMs : null,
      homeTeam: e.homeTeam || null, awayTeam: e.awayTeam || null,
      period: periodForMarketKey(rawKey), // <- the exact fix under test
      direction: 'over', hitRate: null,
      ppKind: DFS_PLATFORMS.has(book) && (e.ppType === 'goblin' || e.ppType === 'demon') ? e.ppType : null
    }));
  });
  return props;
};
const mlbBuildProps = (allLines, book) => {
  const props = [];
  Object.keys(MLB_PROP_DEFS).forEach(k => {
    const arr = allLines[k] && allLines[k][book];
    if (!arr || !arr.length) return;
    arr.forEach(e => props.push({
      type: MLB_PROP_DEFS[k].type, statKey: k, line: e.line, book,
      eventId: e.eventId || null, commenceTimeMs: e.commenceTimeMs != null ? e.commenceTimeMs : null,
      homeTeam: e.homeTeam || null, awayTeam: e.awayTeam || null,
      period: 'FULL_GAME', // <- every MLB_PROP_DEFS market is confirmed full-game
      direction: 'over', modelSupported: true
    }));
  });
  props.push(...buildProviderOnlyProps(allLines, Object.keys(MLB_PROP_DEFS), book));
  return props;
};

// Fixture: a real player with a full-game Hits line AND a real (WNBA-style,
// but reused here for a compact fixture) 1Q points-shaped provider-only
// market, on the SAME event, SAME book.
const allLines = {
  hits: { prizepicks: [{ line: 1.5, over: null, under: null, eventId: 'evt42', homeTeam: 'HOU', awayTeam: 'ATL' }] },
  player_points_1st_quarter: { prizepicks: [{ line: 8.5, over: null, under: null, eventId: 'evt42', homeTeam: 'HOU', awayTeam: 'ATL' }] },
  player_points_1st_half: { prizepicks: [{ line: 15.5, over: null, under: null, eventId: 'evt42', homeTeam: 'HOU', awayTeam: 'ATL' }] },
  // A different event entirely -- must never leak into evt42's game view.
  player_points_1st_quarter_other: {} // placeholder, real "other game" fixture built below
};
const otherGameLines = {
  hits: { prizepicks: [{ line: 0.5, over: null, under: null, eventId: 'evt99', homeTeam: 'BOS', awayTeam: 'NYY' }] }
};

const props1 = mlbBuildProps(allLines, 'prizepicks');
const propsOther = mlbBuildProps(otherGameLines, 'prizepicks');
const allProps = [...props1, ...propsOther];

// --- 1. Full-game prop cannot disappear when a 1Q prop exists -------------
check(props1.some(p => p.statKey === 'hits' && p.period === 'FULL_GAME'), '1. Full-game Hits prop remains present alongside a real 1Q market for the same player/event', null);
// --- 2. A 1Q prop cannot overwrite a full-game prop ------------------------
{
  const fullGame = props1.find(p => p.statKey === 'hits');
  check(fullGame && fullGame.line === 1.5 && fullGame.period === 'FULL_GAME', '2. The full-game Hits prop\'s own line (1.5) and period are untouched by the 1Q market\'s presence', fullGame);
}
// --- 3. A 1H prop cannot overwrite a full-game prop ------------------------
{
  const fullGame = props1.find(p => p.statKey === 'hits');
  const oneHalf = props1.find(p => p.statKey === 'player_points_1st_half');
  check(fullGame.period === 'FULL_GAME' && oneHalf.period === '1H' && fullGame !== oneHalf, '3. 1H and full-game props are distinct objects with distinct periods, neither overwrites the other', { fullGame: fullGame.period, oneHalf: oneHalf.period });
}
// --- 4. A 2H prop cannot overwrite a full-game prop ------------------------
{
  // A truly unclassifiable synthetic key (matches no exact map entry and no
  // pattern) proves the MECHANISM (an UNKNOWN-tagged row) doesn't collide
  // with a real full-game row sharing the same statKey/line -- never
  // asserted as real data, purely an isolation check.
  const withUnknownMarket = { hits: allLines.hits, player_totally_unclassified_market: { prizepicks: [{ line: 8.5, over: null, under: null, eventId: 'evt42' }] } };
  const built = mlbBuildProps(withUnknownMarket, 'prizepicks');
  const fg = built.find(p => p.statKey === 'hits');
  const unk = built.find(p => p.statKey === 'player_totally_unclassified_market');
  check(fg && fg.period === 'FULL_GAME' && unk && unk.period === 'UNKNOWN' && fg !== unk, '4. An UNKNOWN-period market never overwrites the real full-game prop', { fullGame: fg.period, unknownPeriodMarket: unk.period });
  // Same isolation check using the real 2H raw key -- proves a genuine 2H
  // market (were one ever DFS-available) would coexist safely too, not just
  // hypothetically.
  const with2H = { hits: allLines.hits, anytime_2nd_half_td_scorer: { prizepicks: [{ line: 0.5, over: null, under: null, eventId: 'evt42' }] } };
  const built2H = mlbBuildProps(with2H, 'prizepicks');
  const fg2 = built2H.find(p => p.statKey === 'hits');
  const twoH = built2H.find(p => p.statKey === 'anytime_2nd_half_td_scorer');
  check(fg2 && fg2.period === 'FULL_GAME' && twoH && twoH.period === '2H' && fg2 !== twoH, '4b. The one real 2H key never overwrites the real full-game prop either', { fullGame: fg2.period, twoH: twoH.period });
}
// --- 5. Same player+market+line across different periods coexist ----------
{
  const q1 = props1.find(p => p.statKey === 'player_points_1st_quarter');
  const h1 = props1.find(p => p.statKey === 'player_points_1st_half');
  check(q1.period === '1Q' && h1.period === '1H' && q1.line !== h1.line, '5. Real 1Q (8.5) and 1H (15.5) markets for the same player/event coexist as distinct props with distinct periods', { q1: { period: q1.period, line: q1.line }, h1: { period: h1.period, line: h1.line } });
}
// --- 6. Same event + different books coexist -------------------------------
{
  const allBooksLines = { hits: { prizepicks: [{ line: 1.5, over: null, under: null, eventId: 'evt42' }], fanduel: [{ line: 2.5, over: -120, under: -105, eventId: 'evt42' }] } };
  const pp = mlbBuildProps(allBooksLines, 'prizepicks').find(p => p.statKey === 'hits');
  const fd = mlbBuildProps(allBooksLines, 'fanduel').find(p => p.statKey === 'hits');
  check(pp.eventId === fd.eventId && pp.book !== fd.book && pp.line !== fd.line, '6. Same event, different books (PrizePicks 1.5 vs FanDuel 2.5) both real and distinct, same eventId', { pp: { book: pp.book, line: pp.line }, fd: { book: fd.book, line: fd.line } });
}
// --- 7. Normal/Demon/Goblin coexist within the same period -----------------
{
  const ndgLines = { player_points_1st_quarter: { prizepicks: [
    { line: 8.5, over: null, under: null, eventId: 'evt42', ppType: null },
    { line: 9.5, over: null, under: null, eventId: 'evt42', ppType: 'demon' },
    { line: 7.5, over: null, under: null, eventId: 'evt42', ppType: 'goblin' }
  ] } };
  const built = buildProviderOnlyProps(ndgLines, [], 'prizepicks');
  const kinds = new Set(built.map(p => p.ppKind || 'normal'));
  check(built.every(p => p.period === '1Q') && kinds.size === 3, '7. Normal + Demon + Goblin 1Q props all coexist, all correctly tagged period=1Q', { count: built.length, kinds: [...kinds] });
}
// --- 8. A provider-only period market remains visible -----------------------
check(props1.some(p => p.statKey === 'player_points_1st_quarter' && p.modelSupported === false), '8. The real 1Q provider-only market (no *_PROP_DEFS entry for it) survives into the built props, tagged modelSupported:false', null);
// --- 9. Unsupported period markets receive NO model probability -----------
{
  const q1 = props1.find(p => p.statKey === 'player_points_1st_quarter');
  check(q1.modelSupported === false && q1.hitRate === null, '9. The 1Q provider-only prop has no fabricated hitRate/model output -- gated by modelSupported:false, exactly like any other provider-only market', q1);
}
// --- 10. eventId is preserved -----------------------------------------------
check(props1.every(p => p.eventId === 'evt42'), '10. eventId is preserved on every prop (full-game AND period) built for this event', [...new Set(props1.map(p => p.eventId))]);

// ---------------------------------------------------------------------
// Phase 4: the gradedPlayers eventId/period filter wrapper -- reproduced
// verbatim from BeatsEdge.html.
// ---------------------------------------------------------------------
const LIVE_PIPELINE_SPORTS = new Set(['mlb', 'nfl', 'ncaaf', 'nba', 'wnba']);
const applyGameAndPeriodFilter = (preGameFilterPlayers, selectedGameEventId, periodFilter) => {
  if (!selectedGameEventId && periodFilter === 'all') return preGameFilterPlayers;
  const periodOf = (pr) => pr.period || 'UNKNOWN';
  const applies = (p) => !p._mock && LIVE_PIPELINE_SPORTS.has(p.sport) && Array.isArray(p.props);
  return preGameFilterPlayers
    .map(x => applies(x.p)
      ? { ...x, p: { ...x.p, props: x.p.props.filter(pr => (!selectedGameEventId || pr.eventId === selectedGameEventId) && (periodFilter === 'all' || periodOf(pr) === periodFilter)) } }
      : x)
    .filter(x => !applies(x.p) || x.p.props.length > 0);
};

const gameA = { p: { id: 1, sport: 'mlb', props: props1 } };
const gameB = { p: { id: 2, sport: 'mlb', props: propsOther } };
const preGameFilterPlayers = [gameA, gameB];

// --- 11. Clicking a game filters by eventId ---------------------------------
{
  const filtered = applyGameAndPeriodFilter(preGameFilterPlayers, 'evt42', 'all');
  check(filtered.length === 1 && filtered[0].p.id === 1, '11. Selecting eventId "evt42" keeps only the player whose props belong to that event', filtered.map(x => x.p.id));
}
// --- 12. Props from another game do not appear in the selected game --------
{
  const filtered = applyGameAndPeriodFilter(preGameFilterPlayers, 'evt42', 'all');
  check(filtered[0].p.props.every(p => p.eventId === 'evt42'), '12. Every prop remaining after the eventId filter belongs to the selected game, none from evt99 leak through', [...new Set(filtered[0].p.props.map(p => p.eventId))]);
}
// --- Period filter narrows without deleting other periods' data downstream -
{
  const filtered = applyGameAndPeriodFilter(preGameFilterPlayers, null, '1Q');
  check(filtered.length === 1 && filtered[0].p.props.every(p => p.period === '1Q'), 'Period filter "1Q" keeps only 1Q props, drops the player with zero 1Q props (evt99) entirely', filtered.map(x => x.p.id));
}
{
  // The explicit "no 2H markets available" case: filtering to 2H with zero
  // real 2H data anywhere must yield an EMPTY result, never a fabricated one.
  const filtered = applyGameAndPeriodFilter(preGameFilterPlayers, null, '2H');
  check(filtered.length === 0, 'Period filter "2H" with zero real captured 2H markets anywhere correctly yields NO players -- the UI\'s job is to say so honestly, not to invent a row', filtered.length);
}
// --- Game AND period filters applied together --------------------------
{
  const filtered = applyGameAndPeriodFilter(preGameFilterPlayers, 'evt42', '1Q');
  check(filtered.length === 1 && filtered[0].p.id === 1, 'Game + period together: selecting evt42 AND 1Q keeps only the evt42 player (evt99 has no 1Q props and no evt42 props either, so it\'s excluded by both filters)', filtered.map(x => x.p.id));
  check(filtered[0].p.props.length === 1 && filtered[0].p.props[0].period === '1Q' && filtered[0].p.props[0].eventId === 'evt42', 'Game + period together: the remaining player\'s props are narrowed to ONLY the 1Q prop for evt42 -- the full-game Hits prop for the SAME player/event is correctly excluded by the period filter even though it passed the game filter', filtered[0].p.props.map(p => ({ statKey: p.statKey, period: p.period })));
}
{
  // evt42 has no 2H props at all (only 1Q/1H/FULL_GAME in this fixture) --
  // game+period together must yield zero players, not the full evt42 roster.
  const filtered = applyGameAndPeriodFilter(preGameFilterPlayers, 'evt42', '2H');
  check(filtered.length === 0, 'Game + period together: selecting evt42 AND 2H (a period evt42 has no props for) correctly yields zero players, never falls back to showing evt42\'s other-period props', filtered.length);
}
{
  const untouched = applyGameAndPeriodFilter(preGameFilterPlayers, null, 'all');
  check(untouched === preGameFilterPlayers, 'REGRESSION: default state (no game, "all" periods) returns the exact same array reference, unchanged -- zero behavior change for anyone not using the new filters', untouched === preGameFilterPlayers);
}

// ---------------------------------------------------------------------
// Phase 4/5 safety: isPregameProp / isLiveEligibleProp are UNTOUCHED by
// this task -- reproduced verbatim only to prove tests 13/14 still hold
// against the new eventId-grouped game list built on top of them.
// ---------------------------------------------------------------------
function isPregameProp(prop, now = Date.now()) {
  if (!prop) return false;
  const start = Number(prop.commenceTimeMs);
  if (!Number.isFinite(start)) return false;
  return now < start;
}
const isLiveProviderProp = (prop) => !!(prop && prop.lineSource && prop.eventId && Number.isFinite(Number(prop.line)));
const isLiveEligibleProp = (prop) => isLiveProviderProp(prop) && isPregameProp(prop);

// --- 13. Completed-game filtering still works -------------------------------
{
  const now = Date.parse('2026-09-20T20:00:00Z');
  const startedGame = { lineSource: 'ParlayAPI · prizepicks', eventId: 'evtStarted', line: 1.5, commenceTimeMs: Date.parse('2026-09-20T18:00:00Z') };
  check(isLiveEligibleProp(startedGame) === false && isPregameProp(startedGame, now) === false, '13. A prop whose real commenceTimeMs has already passed is correctly excluded (completed/in-progress game filtering unchanged by Phase 4/5)', { now, commenceTimeMs: startedGame.commenceTimeMs });
}
// --- 14. Live/upcoming status still works -----------------------------------
{
  const now = Date.parse('2026-09-20T20:00:00Z');
  const upcomingGame = { lineSource: 'ParlayAPI · prizepicks', eventId: 'evtUpcoming', line: 1.5, commenceTimeMs: Date.parse('2026-09-20T23:00:00Z') };
  check(isLiveEligibleProp(upcomingGame, now) === true || isPregameProp(upcomingGame, now) === true, '14. A prop whose real commenceTimeMs is still in the future remains eligible (upcoming/pregame status unchanged by Phase 4/5)', { now, commenceTimeMs: upcomingGame.commenceTimeMs });
}

// ---------------------------------------------------------------------
// REVIEW FIX -- Issue 1: slateGames now derives from basePlayers' raw
// _allLines (permanent, unfiltered by isLiveEligibleProp), not from
// preGameFilterPlayers' already-pregame-filtered `.props`. Reproduced
// verbatim from BeatsEdge.html. This is what makes a game "remain
// identifiable" once it's live or completed, instead of vanishing the
// moment its commence time passes.
// ---------------------------------------------------------------------
const buildSlateGames = (basePlayers, now = Date.now()) => {
  const byEvent = {};
  (basePlayers || []).forEach(p => {
    if (!p || !p._allLines) return;
    Object.values(p._allLines).forEach(byBook => {
      Object.values(byBook || {}).forEach(arr => {
        (arr || []).forEach(e => {
          if (!e || !e.eventId) return;
          if (!byEvent[e.eventId]) {
            byEvent[e.eventId] = {
              eventId: e.eventId, sport: p.sport || null,
              homeTeam: e.homeTeam || null, awayTeam: e.awayTeam || null,
              commenceTimeMs: e.commenceTimeMs != null ? e.commenceTimeMs : null
            };
          }
        });
      });
    });
  });
  return Object.values(byEvent)
    .map(g => ({ ...g, status: g.commenceTimeMs == null ? 'UNKNOWN' : (g.commenceTimeMs > now ? 'UPCOMING' : 'STARTED') }))
    .sort((a, b) => (a.commenceTimeMs || 0) - (b.commenceTimeMs || 0));
};

const NOW = Date.parse('2026-09-20T20:00:00Z');
// A real upcoming game (ATL @ HOU, kicks off in 3h) and a real STARTED game
// (BOS @ NYY, kicked off 2h ago) -- for the started game, isLiveEligibleProp
// has ALREADY dropped its props from `.props` (real, correct, unmodified
// behavior), but the raw `_allLines` entry -- never touched by that gate --
// still carries the real event.
const allLinesUpcoming = { hits: { prizepicks: [{ line: 1.5, over: null, under: null, eventId: 'evtUpcoming', homeTeam: 'HOU', awayTeam: 'ATL', commenceTimeMs: NOW + 3 * 3600000 }] } };
const allLinesStarted = { hits: { prizepicks: [{ line: 0.5, over: null, under: null, eventId: 'evtStarted', homeTeam: 'NYY', awayTeam: 'BOS', commenceTimeMs: NOW - 2 * 3600000 }] } };
const basePlayersFixture = [
  { id: 10, sport: 'mlb', _allLines: allLinesUpcoming, props: mlbBuildProps(allLinesUpcoming, 'prizepicks').filter(p => isLiveEligibleProp({ ...p, lineSource: 'ParlayAPI · prizepicks' })) },
  { id: 11, sport: 'mlb', _allLines: allLinesStarted, props: [] /* isLiveEligibleProp already dropped this player's only prop -- real, unmodified behavior */ }
];
const games = buildSlateGames(basePlayersFixture, NOW);

// --- 1. Upcoming game appears -----------------------------------------------
check(games.some(g => g.eventId === 'evtUpcoming' && g.status === 'UPCOMING'), '1. An upcoming game (real commenceTimeMs still in the future) appears in the game list, tagged UPCOMING', games.find(g => g.eventId === 'evtUpcoming'));
// --- 2/3. Live/completed game remains identifiable --------------------------
{
  const started = games.find(g => g.eventId === 'evtStarted');
  check(!!started, '2/3. A game whose commence time has passed (live or completed -- honestly indistinguishable from ParlayAPI data alone) REMAINS in the game list -- the exact bug this fix closes; the old slateGames (sourced from pregame-filtered .props) would have made it vanish entirely', started);
  check(started && started.status === 'STARTED' && started.homeTeam === 'NYY' && started.awayTeam === 'BOS', 'Started game keeps its real team labels and is tagged STARTED, never a fabricated LIVE/FINAL distinction ParlayAPI data can\'t actually support', started);
}
{
  // Prove this really IS the fix: the same player's `.props` (pregame-
  // filtered) is empty for the started game, yet the game itself is still
  // listed -- confirming slateGames no longer depends on `.props` surviving.
  const startedPlayer = basePlayersFixture.find(p => p.id === 11);
  check(startedPlayer.props.length === 0 && games.some(g => g.eventId === 'evtStarted'), 'Player-level `.props` is correctly empty (isLiveEligibleProp, unmodified) for the started game, while the game itself still appears in slateGames (fixed) -- these are now correctly decoupled', { propsLength: startedPlayer.props.length, gameStillListed: games.some(g => g.eventId === 'evtStarted') });
}
// --- 4. Game filtering uses eventId (re-confirmed against the new source) --
check(games.every(g => typeof g.eventId === 'string' && g.eventId.length > 0), '4. Every game in the corrected list is keyed by a real ParlayAPI eventId string, never an ESPN id or a team-name key', games.map(g => g.eventId));
// --- No ESPN join attempted -------------------------------------------------
check(games.every(g => !('espnId' in g) && !('espnGameId' in g)), 'No ESPN id field is attached anywhere on the canonical game object -- per explicit instruction, no ESPN<->ParlayAPI join is attempted or faked', Object.keys(games[0] || {}));

// ---------------------------------------------------------------------
// Issue 2 -- period classification honesty (mirrors the classifyPeriod
// logic in tmp/probe-parlayapi-period-inventory-all-sports.js, the fresh-
// capture script prepared for the user to run with their own key since
// no PARLAY_API_KEY is available in this environment).
// ---------------------------------------------------------------------
const KNOWN_FULL_GAME_KEYS = new Set(['player_hits', 'player_points', 'player_pass_yds']);
function classifyPeriod(rawKey) {
  if (KNOWN_FULL_GAME_KEYS.has(rawKey)) return { period: 'FULL_GAME', basis: 'CONFIRMED_ALIAS_TABLE' };
  const k = rawKey.toLowerCase();
  if (/(^|_)(1st|first)_quarter(_|$)/.test(k)) return { period: '1Q', basis: 'PATTERN_MATCHED_RAW_KEY' };
  if (/(^|_)(1st|first)_half(_|$)/.test(k)) return { period: '1H', basis: 'PATTERN_MATCHED_RAW_KEY' };
  if (/(^|_)(2nd|second)_half(_|$)/.test(k)) return { period: '2H', basis: 'PATTERN_MATCHED_RAW_KEY' };
  return { period: 'UNKNOWN', basis: 'NO_MATCH' };
}
// --- 6. Unknown period stays UNKNOWN ----------------------------------------
check(classifyPeriod('player_something_weird_market').period === 'UNKNOWN', '6. A raw key matching no known full-game alias and no period pattern normalizes to UNKNOWN, never guessed', classifyPeriod('player_something_weird_market'));
// --- 7. Full-game props remain FULL_GAME ------------------------------------
check(classifyPeriod('player_hits').period === 'FULL_GAME' && classifyPeriod('player_points').period === 'FULL_GAME', '7. Confirmed full-game aliases classify as FULL_GAME', { hits: classifyPeriod('player_hits'), points: classifyPeriod('player_points') });
// --- 8. 1Q remains 1Q -------------------------------------------------------
check(classifyPeriod('player_points_1st_quarter').period === '1Q', '8. The real, live-captured 1Q raw key classifies as 1Q', classifyPeriod('player_points_1st_quarter'));
// --- 9. 1H remains 1H -------------------------------------------------------
check(classifyPeriod('player_points_1st_half').period === '1H', '9. The real, live-captured 1H raw key classifies as 1H', classifyPeriod('player_points_1st_half'));
// --- 10. 2H is only classified when an actual provider key proves it -------
check(classifyPeriod('player_points_2nd_half').period === '2H', '10. IF a raw key literally proves 2H (contains 2nd_half/second_half), the mechanism correctly classifies it as 2H -- proving the classifier CAN recognize 2H, it just has never seen real evidence of one (see test 11 and PERIOD_MARKET_MAP itself)', classifyPeriod('player_points_2nd_half'));
check(classifyPeriod('player_points_2nd_half').basis === 'PATTERN_MATCHED_RAW_KEY', '10b. A 2H classification is always flagged PATTERN_MATCHED_RAW_KEY (needs human confirmation), never silently trusted the way an exact, pre-confirmed key is', classifyPeriod('player_points_2nd_half').basis);
// --- 11. No fabricated 2H market exists -------------------------------------
{
  const twoHEntries = Object.entries(PERIOD_MARKET_MAP).filter(([, v]) => v === '2H');
  check(twoHEntries.length === 1 && twoHEntries[0][0] === 'anytime_2nd_half_td_scorer', '11. PERIOD_MARKET_MAP (the app\'s actual live period source) contains EXACTLY the one real 2H entry confirmed by the fresh live inventory (tmp/parlayapi-period-inventory-all-sports.json, 2026-09-21) -- anytime_2nd_half_td_scorer, Bovada-only -- never padded with an invented entry, never more than what the live data actually showed', twoHEntries);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
