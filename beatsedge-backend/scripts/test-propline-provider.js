// Phase 10D -- PropLine provider-#2 real-line integrity regression test.
//
// Tests lib/propLineNormalize.js (NOT wired into the live app -- see that
// file's own header). Makes a SMALL number of live, read-only PropLine
// requests (2-3, mirroring test-propline-capability.js's lean philosophy)
// to prove normalization against real current data, plus deterministic
// fixtures for the failure/collision/staleness scenarios that need
// controlled, reproducible inputs. Safe to rerun. No writes anywhere.
// Gracefully skips the live-data tests if PropLine is unreachable this
// run -- never fails the suite for an external provider being down.

const { parsePropLinePlayerId, classifyPlayerIdentity, normalizePropLineOutcome, dedupeKey, resolveDuplicate, mergeProps } = require('../lib/propLineNormalize');

let pass = 0, fail = 0, skip = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}
function skipped(label) { console.log(`⊘ SKIP ${label}`); skip++; }

console.log('=== PropLine provider integrity test ===\n');

// ---- Fixture-based tests (deterministic, no network) ----

// 1/2/3/4/5. Field preservation through normalization.
const rawOutcome = { description: 'Jonah Heim', player_id: 'mlb:641680', name: 'Over', point: 0.5, price: -125, last_change_at: '2026-09-15T16:00:00Z' };
const normalized = normalizePropLineOutcome({ sport: 'mlb', eventId: '210408', homeTeam: 'Tampa Bay Rays', awayTeam: 'Athletics', bookmakerKey: 'draftkings', marketKey: 'batter_hits', outcome: rawOutcome, marketLastUpdate: null, eventLastUpdate: null });
ok(normalized.playerId === 'mlb:641680', '1. PropLine player_id preserved exactly through normalization', normalized.playerId);
ok(normalized.eventId === '210408', '2. PropLine event_id preserved exactly', normalized.eventId);
ok(normalized.source === 'draftkings', '3. PropLine source/bookmaker preserved exactly', normalized.source);
ok(normalized.line === 0.5, '4. PropLine line preserved exactly (never rounded/estimated)', normalized.line);
ok(normalized.odds === -125, '5. PropLine odds preserved exactly', normalized.odds);

// 6/7. DFS vs sportsbook identity preserved as distinct `source` values,
// never merged into one label.
const dfsNorm = normalizePropLineOutcome({ sport: 'mlb', eventId: 'e1', homeTeam: 'A', awayTeam: 'B', bookmakerKey: 'prizepicks', marketKey: 'batter_hits', outcome: rawOutcome });
const sbNorm = normalizePropLineOutcome({ sport: 'mlb', eventId: 'e1', homeTeam: 'A', awayTeam: 'B', bookmakerKey: 'draftkings', marketKey: 'batter_hits', outcome: rawOutcome });
ok(dfsNorm.source === 'prizepicks' && sbNorm.source === 'draftkings' && dfsNorm.source !== sbNorm.source, '6/7. DFS (prizepicks) and sportsbook (draftkings) identity both preserved distinctly, never collapsed', { dfs: dfsNorm.source, sb: sbNorm.source });

// 8. Multiple books do not average -- different dedupeKey (different
// source) means both survive mergeProps untouched.
const bookA = { sport: 'mlb', eventId: 'e1', playerId: 'mlb:1', market: 'batter_hits', source: 'draftkings', line: 0.5, provider: 'propline', timestamp: '2026-09-15T10:00:00Z' };
const bookB = { sport: 'mlb', eventId: 'e1', playerId: 'mlb:1', market: 'batter_hits', source: 'fanduel', line: 1.5, provider: 'propline', timestamp: '2026-09-15T10:00:00Z' };
const mergedBooks = mergeProps([bookA, bookB]);
ok(mergedBooks.length === 2 && mergedBooks.some(p => p.line === 0.5) && mergedBooks.some(p => p.line === 1.5), '8. Multiple real books (different lines) never averaged -- both survive distinctly', mergedBooks.map(p => ({ source: p.source, line: p.line })));

// 9. Multiple providers quoting the SAME book at the SAME real value do not
// average -- picked by policy (timestamp/priority), never math-averaged.
// (Both providers observing the identical real posted line, 0.5 -- the
// realistic "two feeds, one real market" case; a genuine VALUE disagreement
// between providers is a different scenario, covered separately in 9c/9d
// below, per the Phase 1-3 fix: dedupeKey now includes `line`, so two
// providers reporting DIFFERENT values for the same book no longer silently
// collapse to one via policy -- both real observations survive.)
const parlayVersion = { sport: 'mlb', eventId: 'e1', playerId: 'mlb:1', market: 'batter_hits', source: 'prizepicks', line: 0.5, provider: 'parlayapi', timestamp: '2026-09-15T10:00:00Z' };
const proplineVersion = { sport: 'mlb', eventId: 'e1', playerId: 'mlb:1', market: 'batter_hits', source: 'prizepicks', line: 0.5, provider: 'propline', timestamp: '2026-09-15T10:00:00Z' };
const mergedProviders = mergeProps([parlayVersion, proplineVersion]);
ok(mergedProviders.length === 1 && mergedProviders[0].line === 0.5, '9. Two providers quoting the same real book at the same real value (0.5): merge to one row via policy, never averaged', mergedProviders[0].line);
ok(mergedProviders[0].provider === 'parlayapi', '9b. Policy correctly prefers ParlayAPI (primary, per resolveDuplicate\'s default providerPriority) when both providers report the identical value with equal timestamps', mergedProviders[0].provider);

// 9c/9d. Two providers DISAGREEING on the real value for the same book/
// market (e.g. one feed hasn't picked up a line move yet) is a genuinely
// different case from 9 above -- both real observations must now survive
// distinctly rather than one being silently discarded, since a stale
// disagreement is data, not noise. This is the exact bug the Phase 1-3
// dedupeKey fix closes (the old key ignored `line` entirely).
const parlayDisagree = { sport: 'mlb', eventId: 'e1', playerId: 'mlb:1', market: 'batter_hits', source: 'prizepicks', line: 0.5, provider: 'parlayapi', timestamp: '2026-09-15T10:00:00Z' };
const proplineDisagree = { sport: 'mlb', eventId: 'e1', playerId: 'mlb:1', market: 'batter_hits', source: 'prizepicks', line: 1.5, provider: 'propline', timestamp: '2026-09-15T10:00:00Z' };
const mergedDisagreement = mergeProps([parlayDisagree, proplineDisagree]);
ok(mergedDisagreement.length === 2, '9c. Two providers reporting DIFFERENT real values (0.5 vs 1.5) for the same book/market now both survive as distinct rows -- never silently discarded as if duplicates', mergedDisagreement.map(p => ({ provider: p.provider, line: p.line })));
ok(!mergedDisagreement.some(p => p.line === 1.0), '9d. Explicit non-average check: neither surviving row is the mathematical average (1.0) of the two inputs', mergedDisagreement.map(p => p.line));

// 10. Model projection never replaces source line -- structural: the
// normalized object has no modelProjection/modelEdge field at all.
ok(!('modelProjection' in normalized) && !('modelEdge' in normalized), '10. Normalized PropLine object has no modelProjection/modelEdge field -- source line and model output can never collide in this object', Object.keys(normalized));

// 11. Fantasy-score absence handled honestly -- normalizing a real
// non-fantasy market never fabricates a fantasy field.
ok(!('fantasyScore' in normalized) && normalized.market === 'batter_hits', '11. No fantasy-score field is ever fabricated; the real market key is preserved as-is (batter_hits, not upgraded/invented into a fantasy market)', normalized.market);

// 12. Unresolved player collision fails closed -- two BeatsEdge roster
// candidates share a name, PropLine gives an id in a DIFFERENT id space
// (NBA-style), team context doesn't disambiguate.
const collisionCandidates = [{ id: 'espn:100', name: 'John Smith', team: 'BOS' }, { id: 'espn:200', name: 'John Smith', team: 'LAL' }];
const nameTeamResolveAmbiguous = () => ({ chosen: null, reason: 'collision', candidates: collisionCandidates });
const collisionResult = classifyPlayerIdentity('nba', { player_id: 'nba:999', description: 'John Smith' }, () => null, nameTeamResolveAmbiguous);
ok(collisionResult.method === 'COLLISION' && collisionResult.beatsEdgeId === null, '12. Ambiguous player collision fails closed -- COLLISION, no beatsEdgeId assigned, never guessed', collisionResult);

// 13. Event mismatch fails closed -- team context contradicts the only candidate.
const nameTeamResolveMismatch = () => ({ chosen: null, reason: 'teamMismatch' });
const mismatchResult = classifyPlayerIdentity('nba', { player_id: 'nba:999', description: 'Some Player' }, () => null, nameTeamResolveMismatch);
ok(mismatchResult.method === 'TEAM_MISMATCH' && mismatchResult.beatsEdgeId === null, '13. Team/event mismatch fails closed -- rejected, never force-attached', mismatchResult);

// 14. Stale provider cannot overwrite fresh provider -- real timestamp
// comparison, not arrival order.
const fresh = { sport: 'nfl', eventId: 'e2', playerId: 'espn:1', market: 'player_pass_yds', source: 'draftkings', line: 250.5, provider: 'parlayapi', timestamp: '2026-09-15T18:00:00Z' };
const stale = { sport: 'nfl', eventId: 'e2', playerId: 'espn:1', market: 'player_pass_yds', source: 'draftkings', line: 245.5, provider: 'propline', timestamp: '2026-09-15T12:00:00Z' };
// stale ARRIVES SECOND (later call) but has an EARLIER real timestamp.
const afterStaleArrives = resolveDuplicate(fresh, stale);
ok(afterStaleArrives.line === 250.5, '14. A stale response (older real timestamp) arriving LATER never overwrites a fresher one -- fresh line (250.5) wins, not arrival order', afterStaleArrives);

// 15/16/17. Provider failure / mock data cannot overwrite valid live data.
const existingReal = [{ sport: 'mlb', eventId: 'e3', playerId: 'mlb:1', market: 'batter_hits', source: 'draftkings', line: 0.5, provider: 'parlayapi', timestamp: '2026-09-15T10:00:00Z' }];
const propLineFailedThisRun = []; // provider failure = empty array, never nulls/invalidates
const afterFailure = mergeProps([...existingReal, ...propLineFailedThisRun]);
ok(afterFailure.length === 1 && afterFailure[0].line === 0.5, '15/16/17. PropLine failing (empty result) never overwrites or removes ParlayAPI\'s valid existing data -- mergeProps only ever acts on rows it is actually given, never invalidates by omission', afterFailure);

// 18. PropLine can represent a source ParlayAPI lacks -- different
// `source` (dabble), same event/player/market -- distinct dedupeKey,
// coexists without collision.
const parlayOnly = { sport: 'mlb', eventId: 'e3', playerId: 'mlb:1', market: 'batter_hits', source: 'draftkings', line: 0.5, provider: 'parlayapi', timestamp: '2026-09-15T10:00:00Z' };
const proplineOnlyDabble = { sport: 'mlb', eventId: 'e3', playerId: 'mlb:1', market: 'batter_hits', source: 'dabble', line: 0.5, provider: 'propline', timestamp: '2026-09-15T10:00:00Z' };
const mergedWithNewSource = mergeProps([parlayOnly, proplineOnlyDabble]);
ok(mergedWithNewSource.length === 2, '18. PropLine-only source (dabble, which ParlayAPI does not carry) represented alongside ParlayAPI\'s draftkings line without collision', mergedWithNewSource.map(p => p.source));

// 19/20. Same dedupeKey merges (same source identity); different real
// source lines remain distinct (different dedupeKey).
ok(dedupeKey(parlayVersion) === dedupeKey(proplineVersion), '19. Two providers quoting the identical real market (same sport/event/player/market/source) share one dedupeKey -- eligible to merge', dedupeKey(parlayVersion));
ok(dedupeKey(bookA) !== dedupeKey(bookB), '20. Two different real books (different source) have different dedupeKeys -- never accidentally collapsed', [dedupeKey(bookA), dedupeKey(bookB)]);

// ---- Player-ID space classification (Section 5), fixture-based on real
// findings (MLB/NFL/CFB exact match; NBA/WNBA different space) ----
const mlbRoster = (rawId) => rawId === '641680' ? { id: '641680', name: 'Jonah Heim' } : null;
const mlbClassification = classifyPlayerIdentity('mlb', { player_id: 'mlb:641680' }, mlbRoster, null);
ok(mlbClassification.method === 'EXACT_ID' && mlbClassification.beatsEdgeId === '641680', 'MLB: real player_id (mlb:641680) classifies as EXACT_ID, matches BeatsEdge\'s own MLB Stats API person.id directly (verified live: person 641680 is really Jonah Heim)', mlbClassification);

const nflRoster = (rawId) => rawId === '5123663' ? { id: '5123663', name: 'Isaac TeSlaa' } : null;
const nflClassification = classifyPlayerIdentity('nfl', { player_id: 'espn:5123663' }, nflRoster, null);
ok(nflClassification.method === 'EXACT_ID' && nflClassification.beatsEdgeId === '5123663', 'NFL: real player_id (espn:5123663) classifies as EXACT_ID, matches BeatsEdge\'s own ESPN athlete id directly (verified live: ESPN athlete 5123663 is really Isaac TeSlaa)', nflClassification);

const nbaNameTeamResolve = () => ({ chosen: { id: 'espn:3136195', name: 'Jayson Tatum', team: 'BOS' }, reason: 'nameOnlyNoTeamData', candidates: [{ id: 'espn:3136195' }] });
const nbaClassification = classifyPlayerIdentity('nba', { player_id: 'nba:1628369', description: 'Jayson Tatum' }, () => null, nbaNameTeamResolve);
ok(nbaClassification.method !== 'EXACT_ID' && nbaClassification.propLineIdRequiresMapping === true, 'NBA: real player_id (nba:1628369) is NOT BeatsEdge\'s own ESPN athlete id (verified live: Jayson Tatum\'s real ESPN id is 3136195, a different number) -- correctly falls back to name+team resolution, never mis-trusted as EXACT_ID', nbaClassification);

// ---- Phase 1-3 foundation: dedupeKey fix regression tests ----------------
// dedupeKey used to be sport+event+player+market+source ONLY. That meant a
// normal PrizePicks 0.5 line and a PrizePicks 1.5 DEMON line for the SAME
// player/market/book shared one key (nothing else was checked) and
// resolveDuplicate() would silently discard one as if it were a stale
// re-poll of the other. These tests prove the FIXED key (adds
// period/line/projectionType/direction) keeps every case Phase 2/3
// explicitly requires distinct, and still merges genuine duplicates.

// 21. Same book, DIFFERENT real lines (e.g. a line move captured as two
// rows, or two simultaneous alt-ladder rungs) -- must never collapse.
const lineA = { sport: 'mlb', eventId: 'e4', playerId: 'mlb:9', market: 'batter_hits', source: 'prizepicks', line: 0.5, projectionType: 'standard', provider: 'parlayapi', timestamp: '2026-09-20T10:00:00Z' };
const lineB = { sport: 'mlb', eventId: 'e4', playerId: 'mlb:9', market: 'batter_hits', source: 'prizepicks', line: 1.5, projectionType: 'standard', provider: 'parlayapi', timestamp: '2026-09-20T10:00:00Z' };
ok(dedupeKey(lineA) !== dedupeKey(lineB), '21. Same book, different real lines (0.5 vs 1.5) now produce DIFFERENT dedupeKeys -- the exact bug this fix closes (old key ignored `line` entirely)', [dedupeKey(lineA), dedupeKey(lineB)]);
ok(mergeProps([lineA, lineB]).length === 2, '21b. mergeProps keeps both real lines distinct, never collapses one into the other', mergeProps([lineA, lineB]).map(p => p.line));

// 22. Same book, same line, NORMAL vs DEMON projectionType -- must coexist.
const normalLine = { sport: 'mlb', eventId: 'e4', playerId: 'mlb:9', market: 'batter_hits', source: 'prizepicks', line: 1.5, projectionType: 'standard', provider: 'parlayapi', timestamp: '2026-09-20T10:00:00Z' };
const demonLine = { sport: 'mlb', eventId: 'e4', playerId: 'mlb:9', market: 'batter_hits', source: 'prizepicks', line: 1.5, projectionType: 'demon', provider: 'parlayapi', timestamp: '2026-09-20T10:00:00Z' };
const goblinLine = { sport: 'mlb', eventId: 'e4', playerId: 'mlb:9', market: 'batter_hits', source: 'prizepicks', line: 1.5, projectionType: 'goblin', provider: 'parlayapi', timestamp: '2026-09-20T10:00:00Z' };
ok(new Set([dedupeKey(normalLine), dedupeKey(demonLine), dedupeKey(goblinLine)]).size === 3, '22. Same player/market/book/line: NORMAL, DEMON and GOBLIN all produce distinct dedupeKeys -- all three coexist', [dedupeKey(normalLine), dedupeKey(demonLine), dedupeKey(goblinLine)]);
ok(mergeProps([normalLine, demonLine, goblinLine]).length === 3, '22b. mergeProps keeps NORMAL + DEMON + GOBLIN as three distinct rows, never collapses to one', mergeProps([normalLine, demonLine, goblinLine]).length);

// 23. Same everything except direction/side (a two-sided line's over vs
// under) -- must be two distinct rows, never one row silently picking a side.
const overSide = { sport: 'nfl', eventId: 'e5', playerId: 'espn:2', market: 'player_pass_yds', source: 'draftkings', line: 250.5, direction: 'over', provider: 'parlayapi', timestamp: '2026-09-20T10:00:00Z' };
const underSide = { sport: 'nfl', eventId: 'e5', playerId: 'espn:2', market: 'player_pass_yds', source: 'draftkings', line: 250.5, direction: 'under', provider: 'parlayapi', timestamp: '2026-09-20T10:00:00Z' };
ok(dedupeKey(overSide) !== dedupeKey(underSide), '23. Same line, opposite sides (over/under) produce different dedupeKeys', [dedupeKey(overSide), dedupeKey(underSide)]);

// 24. `period` defaults consistently to FULL_GAME when absent (today's
// reality -- no period-level provider integration exists yet) so two rows
// that both omit it still correctly merge as genuine duplicates, while an
// explicit future period value is kept distinct from full-game -- forward-
// compatible with a later period phase without another identity-scheme
// change.
const noPeriodA = { sport: 'nba', eventId: 'e6', playerId: 'espn:3', market: 'player_points', source: 'fanduel', line: 20.5, provider: 'parlayapi', timestamp: '2026-09-20T10:00:00Z' };
const noPeriodB = { sport: 'nba', eventId: 'e6', playerId: 'espn:3', market: 'player_points', source: 'fanduel', line: 20.5, provider: 'propline', timestamp: '2026-09-20T09:00:00Z' };
const explicitFullGame = { ...noPeriodA, period: 'FULL_GAME' };
const firstQuarter = { ...noPeriodA, period: '1Q' };
ok(dedupeKey(noPeriodA) === dedupeKey(explicitFullGame), '24. Omitted period and explicit period:"FULL_GAME" hash identically (both mean the same real full-game market)', [dedupeKey(noPeriodA), dedupeKey(explicitFullGame)]);
ok(dedupeKey(noPeriodA) !== dedupeKey(firstQuarter), '24b. A future period:"1Q" row is kept distinct from the full-game row for the same player/market/book -- ready for a later period phase without a further key change', [dedupeKey(noPeriodA), dedupeKey(firstQuarter)]);
ok(mergeProps([noPeriodA, noPeriodB]).length === 1, '24c. Two providers quoting the identical full-game market (both omitting period) still correctly merge to one row', mergeProps([noPeriodA, noPeriodB]).length);

// ---- Live spot-check (lean, 1-2 real PropLine requests, gracefully skips) ----
(async () => {
  const PROPLINE_KEY = process.env.PROPLINE_KEY;
  const PL = 'https://api.prop-line.com';
  if (!PROPLINE_KEY) {
    skipped('live spot-check: no PROPLINE_KEY environment variable configured this run -- skipping gracefully (never substitutes a hardcoded credential)');
    return finish();
  }
  try {
    const evR = await fetch(`${PL}/v1/sports/baseball_mlb/events?apiKey=${PROPLINE_KEY}`);
    if (!evR.ok) throw new Error('HTTP ' + evR.status);
    const events = await evR.json();
    const now = Date.now();
    const upcoming = (events || []).filter(e => Date.parse(e.commence_time || '') > now).sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time));
    if (!upcoming.length) { skipped('live spot-check: no real upcoming MLB events this run'); return finish(); }
    const target = upcoming[0];
    const odR = await fetch(`${PL}/v1/sports/baseball_mlb/events/${target.id}/odds?markets=batter_hits&bookmakers=draftkings&apiKey=${PROPLINE_KEY}`);
    if (!odR.ok) throw new Error('HTTP ' + odR.status);
    const od = await odR.json();
    const bm = (od.bookmakers || [])[0];
    const mkt = bm && (bm.markets || [])[0];
    const oc = mkt && (mkt.outcomes || [])[0];
    if (!oc) { skipped('live spot-check: no real outcome rows returned this run'); return finish(); }
    const liveNormalized = normalizePropLineOutcome({ sport: 'mlb', eventId: target.id, homeTeam: target.home_team, awayTeam: target.away_team, bookmakerKey: bm.key, marketKey: mkt.key, outcome: oc });
    ok(liveNormalized.eventId === target.id && liveNormalized.playerId === oc.player_id && liveNormalized.line === oc.point,
      'LIVE: real current PropLine MLB event normalizes correctly end-to-end (event/player/line all preserved exactly)', { player: liveNormalized.player, line: liveNormalized.line, source: liveNormalized.source });
  } catch (e) {
    skipped(`live spot-check unreachable this run (${e.message}) -- never fails the suite for an external provider being down`);
  }
  finish();
})();

function finish() {
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed, ${skip} skipped ===`);
  if (fail > 0) process.exit(1);
}
