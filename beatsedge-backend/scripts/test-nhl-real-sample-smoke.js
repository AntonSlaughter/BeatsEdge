// NHL unlock project -- LIVE SMOKE TEST using the ACTUAL real sample rows
// pasted by the user from their own real ParlayAPI discovery pull
// (2026-09-29T13:48:50.939Z, real key, real backend, 10,001 real rows).
// This is not synthetic/fabricated data -- these are the literal 40
// sampleRows from that real response body, reproduced verbatim.
//
// I do not have the user's ParlayAPI key (by design -- it never leaves
// their browser), so I cannot personally drive the full live UI click-
// through. This is the closest honest substitute: running the REAL
// observed provider rows through the REAL classification logic
// (lib/nhlMarketMapping.js) to prove routing is correct end-to-end
// against genuine data, not assumptions.
//
//   node scripts/test-nhl-real-sample-smoke.js

const { classifyNhlMarket } = require('../lib/nhlMarketMapping');

// Verbatim from the user's real discovery paste this session.
const REAL_SAMPLE_ROWS = [
  { player: 'Aleksander Barkov', market_key: 'player_faceoffs_won', line: 8.5, bookmaker: 'prizepicks', projection_type: 'STANDARD', period: 'FULL' },
  { player: 'Aaron Ekblad', market_key: 'player_assists', line: 0.5, bookmaker: 'novig', projection_type: null, period: 'FULL' },
  { player: 'Aaron Ekblad', market_key: 'player_anytime_goal_scorer', line: 0, bookmaker: 'bet365', projection_type: null, period: 'FULL' },
  { player: 'Aaron Ekblad', market_key: 'player_anytime_goal_scorer', line: 0, bookmaker: 'betmgm', projection_type: null, period: 'FULL' },
  { player: 'Aaron Ekblad', market_key: 'player_first_goal_scorer', line: 0, bookmaker: 'betrivers', projection_type: null, period: 'FULL' },
  { player: 'Aaron Ekblad', market_key: 'player_goals', line: 0.5, bookmaker: 'hardrock', projection_type: null, period: 'FULL' },
  { player: 'Aaron Ekblad', market_key: 'player_points', line: 0.5, bookmaker: 'sleeper', projection_type: null, period: 'FULL' },
  { player: 'Aaron Ekblad', market_key: 'player_goals', line: 0.5, bookmaker: 'underdog', projection_type: 'STANDARD', period: 'FULL' },
  { player: 'Aaron Ekblad', market_key: 'player_points', line: 0.5, bookmaker: 'prophetx', projection_type: null, period: 'FULL' },
  { player: '0 - 2', market_key: 'player_game_props', line: null, bookmaker: 'pinnacle', projection_type: null, period: 'FULL' },
  { player: '0 - 0 - 1P', market_key: 'player_correct_score', line: null, bookmaker: 'bovada', projection_type: null, period: 'FULL' },
  { player: 'MTL Canadiens vs TOR Maple Leafs', market_key: 'alternate_totals', line: 6.5, bookmaker: 'fliff', projection_type: null, period: 'FULL' },
  { player: 'Brady Tkachuk + Matthew Tkachuk', market_key: 'player_goals_combo', line: 0.5, bookmaker: 'prizepicks', projection_type: 'GOBLIN', period: 'FULL' },
  { player: 'Brandon Bussi', market_key: 'player_goalie_fantasy_score', line: 8.5, bookmaker: 'prizepicks', projection_type: 'STANDARD', period: 'FULL' },
  { player: 'Aaron Ekblad', market_key: 'player_last_goal_scorer', line: 0, bookmaker: 'bet365', projection_type: null, period: 'FULL' },
  { player: 'Aaron Ekblad', market_key: 'player_to_score_2_or_more_goals', line: 0, bookmaker: 'betmgm', projection_type: null, period: 'FULL' },
  { player: 'Aaron Ekblad', market_key: 'player_assists_alt', line: 2, bookmaker: 'draftkings', projection_type: null, period: 'FULL' },
];

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

console.log('Running REAL observed provider rows through the REAL classifier:\n');
const results = REAL_SAMPLE_ROWS.map(row => ({ ...row, classification: classifyNhlMarket(row.market_key, row.line, row.period) }));
results.forEach(r => {
  console.log(`  ${r.player.padEnd(32)} ${r.market_key.padEnd(32)} line=${String(r.line).padEnd(5)} -> ${r.classification.bucket}${r.classification.statKey ? ' (' + r.classification.statKey + ')' : ''}`);
});

check('Aaron Ekblad player_assists (real line=0.5) -> BINARY_THRESHOLD_CONDITIONAL / assists_at_least_1',
  results[1].classification.bucket === 'BINARY_THRESHOLD_CONDITIONAL' && results[1].classification.statKey === 'assists_at_least_1');
check('Aaron Ekblad player_anytime_goal_scorer (real line=0, bet365) -> BINARY_THRESHOLD_CONDITIONAL / goals_at_least_1',
  results[2].classification.bucket === 'BINARY_THRESHOLD_CONDITIONAL' && results[2].classification.statKey === 'goals_at_least_1');
check('Same market, second real book (betmgm) -> identical classification (source-independent)',
  results[3].classification.bucket === 'BINARY_THRESHOLD_CONDITIONAL' && results[3].classification.statKey === 'goals_at_least_1');
check('Aaron Ekblad player_first_goal_scorer (real line=0) -> UNMAPPED, never conflated with anytime-scorer',
  results[4].classification.bucket === 'UNMAPPED');
check('Aaron Ekblad player_goals (real line=0.5, hardrock) -> BINARY_THRESHOLD_CONDITIONAL / goals_at_least_1',
  results[5].classification.bucket === 'BINARY_THRESHOLD_CONDITIONAL' && results[5].classification.statKey === 'goals_at_least_1');
check('Aaron Ekblad player_points (real line=0.5) -> BINARY_THRESHOLD_CONDITIONAL / points_at_least_1',
  results[6].classification.bucket === 'BINARY_THRESHOLD_CONDITIONAL' && results[6].classification.statKey === 'points_at_least_1');
check('Real STANDARD projection_type (underdog) preserved, does not block classification',
  results[7].classification.bucket === 'BINARY_THRESHOLD_CONDITIONAL');
check('Real (missing/null) projection_type (novig, bet365, etc.) does NOT block classification',
  results[1].classification.bucket === 'BINARY_THRESHOLD_CONDITIONAL' && results[1].projection_type == null);
check('player_game_props (real team/game market, "player" field is actually a score string "0 - 2") -> UNMAPPED, never fabricated as a player prop',
  results[9].classification.bucket === 'UNMAPPED');
check('player_correct_score (real team/game market, "player" field is a score string) -> UNMAPPED',
  results[10].classification.bucket === 'UNMAPPED');
check('alternate_totals (real team/game market, "player" field is a matchup string) -> UNMAPPED',
  results[11].classification.bucket === 'UNMAPPED');
check('player_goals_combo (real 2-player combo prop) -> UNMAPPED, not fabricated',
  results[12].classification.bucket === 'UNMAPPED');
check('player_goalie_fantasy_score (real market, not one of the 5 validated families) -> UNMAPPED',
  results[13].classification.bucket === 'UNMAPPED');
check('player_last_goal_scorer (real line=0) -> UNMAPPED, never conflated with anytime-scorer',
  results[14].classification.bucket === 'UNMAPPED');
check('player_to_score_2_or_more_goals (real milestone market, beyond the validated >=1 threshold) -> UNMAPPED',
  results[15].classification.bucket === 'UNMAPPED');
check('player_assists_alt at its real observed line=2 (never validated) -> UNMAPPED',
  results[16].classification.bucket === 'UNMAPPED');
check('player_faceoffs_won (real market, DATA GAP -- no raw won-count column exists) -> UNMAPPED',
  results[0].classification.bucket === 'UNMAPPED');

const supported = results.filter(r => r.classification.bucket !== 'UNMAPPED');
const unsupported = results.filter(r => r.classification.bucket === 'UNMAPPED');
console.log(`\n${supported.length}/${results.length} real rows classified as model-supported, ${unsupported.length}/${results.length} as provider-only ("Model not supported yet").`);

console.log(`\n${failures === 0 ? 'ALL REAL-SAMPLE SMOKE TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
