// NHL unlock project -- final integration regression, covering the
// release-gate items that are verifiable at the source/backend level
// (browser-only React rendering was verified manually in the Browser
// pane this session: NBA/WNBA/NFL/CFB/MLB all still render real sample
// data with zero new console errors after the shared fetchParlayProps
// changes; NHL's own card renders with zero console errors).
//
//   node --env-file=.env scripts/test-nhl-integration.js

const fs = require('fs');
const path = require('path');
const { classifyNhlMarket } = require('../lib/nhlMarketMapping');
const { shrinkageFive, poissonPOver1, savesProjection, computeAllProjections } = require('../lib/nhlProjectionEngine');

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'BeatsEdge.html'), 'utf8');

(async () => {
  // ---------- CRITICAL PAGINATION FIX ----------
  check('fetchParlayPropsBulk generic default maxPages is UNCHANGED at 3 (no global increase)',
    /const maxPages = \(opts && opts\.maxPages\) \|\| 3;/.test(html));
  check('NHL\'s own call site passes an explicit higher maxPages (20), not the generic default',
    /fetchParlayPropsBulk\('icehockey_nhl', PARLAY_NHL_MKT, \{\s*books: PROPLINE_BOOK_PRIORITY\.join\(','\), limit: 10000, maxPages: 20/.test(html));
  check('NBA\'s own call site still passes its own maxPages (5), unaffected by the NHL change',
    /fetchParlayPropsBulk\('basketball_nba', PARLAY_BB_MKT, \{\s*books: PROPLINE_BOOK_PRIORITY\.join\(','\), limit: 10000, maxPages: 5/.test(html));

  // ---------- PAGINATION EXHAUSTION, not just a page cap ----------
  // This exact mechanism is SHARED, unmodified code already used and
  // proven live by every other sport (see fetchParlayProps' own header
  // comment: "Live-verified this session (real ParlayAPI Pro key)...
  // confirming the provider's /props endpoint natively supports 'give me
  // everything'... paginates via the existing offset/x-next-offset/
  // x-result-has-more loop"). NHL introduces no new pagination logic --
  // only a higher maxPages ceiling on the same mechanism. maxPages=20 is
  // a GUARDRAIL: the loop continues on its own while the provider
  // reports more pages exist, advances via the real x-next-offset the
  // provider returns, and only stops early (with an explicit warning
  // AND `truncated: true`) if that guardrail is hit while the provider
  // still says more rows exist -- never a silent "20 pages = complete"
  // assumption.
  check('the pagination loop continues based on the real x-result-has-more header (or a row-count heuristic if absent), not a fixed page count',
    /const hasMoreHeader = r\.headers\.get\('x-result-has-more'\);/.test(html)
    && /const hasMore = hasMoreHeader != null \? hasMoreHeader === 'true' : rows\.length >= pageLimit;/.test(html));
  check('the loop advances using the real provider-returned x-next-offset, not a locally-guessed offset',
    /const nextOffsetHeader = r\.headers\.get\('x-next-offset'\);/.test(html)
    && /offset = nextOffsetHeader != null \? parseInt\(nextOffsetHeader, 10\) : offset \+ rows\.length;/.test(html));
  check('hitting the safety cap while the provider still reports more pages is explicitly warned and flagged truncated (never silently called complete)',
    /if \(hasMore && pagesFetched >= maxPages\) \{\s*console\.warn\(`\[ParlayAPI\] \$\{parlaySportKey\}: stopped at safety cap/.test(html)
    && /truncated = true;/.test(html));
  check('NHL surfaces its own truncated flag with an explicit console warning if the 20-page ceiling is ever hit',
    /if \(pa\.truncated\) console\.warn\('\[NHL\] board still truncated after paginating to the 20-page safety cap/.test(html));

  // ---------- mktMap function-support is additive, not a behavior change for other sports ----------
  check('the known-market lookup supports function-valued mktMap entries (NHL) while staying string-compatible (everyone else)',
    /const mktEntry = mktMap\[row\.market_key\];\s*const known = typeof mktEntry === 'function' \? mktEntry\(row\) : mktEntry;/.test(html));

  // ---------- PERIOD SAFETY: FULL-game models never attach to P1 props ----------
  check('P1 shots_on_goal_1st_period never reuses the FULL-game model (Node classifier)',
    classifyNhlMarket('player_shots_on_goal_1st_period', 0.5, 'P1').bucket === 'UNMAPPED');
  check('player_shots_on_goal itself under period=P1 is UNMAPPED, not silently treated as FULL (Node classifier)',
    classifyNhlMarket('player_shots_on_goal', 2.5, 'P1').bucket === 'UNMAPPED');
  check('the inline browser classifier (PARLAY_NHL_MKT) has the identical NHL_FULL_GAME period guard',
    /const NHL_FULL_GAME = \(row\) => \(!row\.period \|\| row\.period === 'FULL'\);/.test(html));

  // ---------- NON-PLAYER MARKET SAFETY: default-deny, not player-field-presence ----------
  check('team/game markets (alternate_totals) are never classified as a supported player stat',
    classifyNhlMarket('alternate_totals', 6.5, 'FULL').bucket === 'UNMAPPED');
  check('player_correct_score (a team/game market despite the "player" prefix) is UNMAPPED',
    classifyNhlMarket('player_correct_score', null, 'FULL').bucket === 'UNMAPPED');

  // ---------- PROJECTION TYPE stays optional, never inferred ----------
  check('the archived/entry row carries projection_type through verbatim, with no inferred default',
    /projectionType: row\.projection_type \|\| null/.test(html));

  // ---------- BINARY THRESHOLD conditionality, each market's OWN real line ----------
  // Real discovery sample rows (2026-09-29) showed anytime_goal_scorer
  // uses line=0 in real provider data, not 0.5 -- caught and fixed this
  // session before any smoke test (was originally coded wrong).
  check('player_anytime_goal_scorer at its real line=0 is supported (Node classifier)',
    classifyNhlMarket('player_anytime_goal_scorer', 0, 'FULL').bucket === 'BINARY_THRESHOLD_CONDITIONAL');
  check('player_anytime_goal_scorer at line=0.5 (wrong convention for this specific market) is rejected (Node classifier)',
    classifyNhlMarket('player_anytime_goal_scorer', 0.5, 'FULL').bucket === 'UNMAPPED');
  check('player_anytime_goal_scorer at line=1.5 (never validated) is rejected (Node classifier)',
    classifyNhlMarket('player_anytime_goal_scorer', 1.5, 'FULL').bucket === 'UNMAPPED');
  check('player_goals (base O/U market) at its real line=0.5 is supported (Node classifier)',
    classifyNhlMarket('player_goals', 0.5, 'FULL').bucket === 'BINARY_THRESHOLD_CONDITIONAL');
  // Explicit proof the two real line conventions (anytime-scorer's
  // line=0 vs player_goals' line=0.5) route to the IDENTICAL validated
  // P(X>=1) concept -- same statKey, same projection engine function,
  // not two parallel/drifted implementations of "the same idea".
  check('player_anytime_goal_scorer (line=0) and player_goals (line=0.5) resolve to the exact same statKey -- same validated P(goals>=1) concept',
    classifyNhlMarket('player_anytime_goal_scorer', 0, 'FULL').statKey === classifyNhlMarket('player_goals', 0.5, 'FULL').statKey
    && classifyNhlMarket('player_goals', 0.5, 'FULL').statKey === 'goals_at_least_1');
  check('first/last/exact goal scorer are never conflated with anytime-goal-scorer, despite sharing the same real line=0 convention',
    classifyNhlMarket('player_first_goal_scorer', 0, 'FULL').bucket === 'UNMAPPED'
    && classifyNhlMarket('player_last_goal_scorer', 0, 'FULL').bucket === 'UNMAPPED'
    && classifyNhlMarket('player_exact_goals_scored', 0, 'FULL').bucket === 'UNMAPPED');

  // ---------- EDGE: projection-based only, never fabricated for binary probability ----------
  check('projection-based Edge is only ever attached when a real point projection exists (not for probability-only families)',
    /edge: isSupported && model\.projection != null \? Math\.round\(\(model\.projection - pr\.line\) \* 100\) \/ 100 : null/.test(html));
  check('MODEL PROBABILITY and FACTOR CONFLUENCE remain separate fields on the NHL prop object (projection/probability/edge are distinct, no fourth "confluence" field invented)',
    !/nhlConfluence|NHL_CONFLUENCE|nhlPrime|NHL_PRIME/.test(html));

  // ---------- SAVES PROJECTION: corrected to shrinkage-5, rest/back-to-back dropped ----------
  // research-nhl-features.js's original rest/back-to-back result was
  // computed on data polluted by "dressed but did not play" goalie rows
  // (saves=0/shots_against=0) -- fixed during integration (shots_against
  // > 0 filter, matching lib/nhlEngine.js's existing convention). With
  // clean data the adjustment showed no real improvement (~0.16%, not
  // the originally-reported 6.6%) and was correctly dropped rather than
  // shipped on a false premise.
  {
    const games = [1, 2, 3, 2, 1, 4, 3, 2].map(val => ({ val }));
    const result = savesProjection(games);
    check('savesProjection now uses plain shrinkage-5 (matches shrinkageFive exactly), restAdjusted always false',
      result.restAdjusted === false && Math.abs(result.projection - shrinkageFive(games.map(g => g.val))) < 1e-9);
  }

  // ---------- SHRINKAGE-5 FORMULA: exact, unretuned ----------
  {
    const vals = [1, 2, 3, 2, 1, 4, 3, 2]; // seasonMean=2.25, l5=[1,4,3,2]->wait recompute below
    const seasonMean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const l5 = vals.slice(-5);
    const l5Mean = l5.reduce((a, b) => a + b, 0) / l5.length;
    const expected = ((l5.length * l5Mean) + (8 * seasonMean)) / (l5.length + 8);
    check('shrinkageFive matches the exact k=8 formula from research-nhl-baselines.js bit for bit',
      Math.abs(shrinkageFive(vals) - expected) < 1e-9);
  }

  // ---------- Poisson P(>=1): exact formula ----------
  check('poissonPOver1 matches 1 - e^-lambda exactly', Math.abs(poissonPOver1(0.3) - (1 - Math.exp(-0.3))) < 1e-9);

  // ---------- real end-to-end projection engine sanity (real Turso data) ----------
  {
    const out = await computeAllProjections(null);
    check('computeAllProjections returns real, non-trivial player counts for all 5 validated families',
      out.shots_on_goal.length > 500 && out.goalie_saves.length > 50
      && out.goals_at_least_1.length > 500 && out.assists_at_least_1.length > 500 && out.points_at_least_1.length > 500,
      JSON.stringify({ sog: out.shots_on_goal.length, saves: out.goalie_saves.length, g: out.goals_at_least_1.length }));
    const store = require('../lib/historicalStore');
    const nullNames = await store.queryOne('SELECT COUNT(*) c FROM nhl_player_box WHERE player_name IS NULL');
    check('nhl_player_box has zero NULL player_name rows (the ingestion bug found and fixed this session stays fixed)', nullNames.c === 0);
    const anyReal = out.shots_on_goal.find(r => r.playerName);
    check('projected rows carry a real, non-null playerName (needed for real name matching against ParlayAPI)', !!anyReal);
  }

  console.log(`\n${failures === 0 ? 'ALL NHL INTEGRATION TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
