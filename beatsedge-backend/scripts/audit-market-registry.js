// Phase 11/14 market-registry coverage audit -- reads REAL, already-saved
// ParlayAPI diagnostic JSON (tmp/parlayapi-nba-wnba-market-keys.json,
// tmp/parlayapi-bulk-test.json), never makes a live provider request itself.
//
// Reports, per sport: how many raw provider market_keys were observed, how
// many are registered, and the model_supported / derived / data_required /
// formula_unknown breakdown -- plus the exact reason for every unresolved
// market. This is a standalone Node reproduction of the registry classification
// (see BeatsEdge.html's MARKET_REGISTRY/REGISTRY_UNRESOLVED, right after
// nbaAllKeys) -- Node can't `require()` a browser-only single-file app, so
// the DATA (not logic) below is kept in sync by hand with that block. If
// they diverge, BeatsEdge.html is authoritative; update this file to match.
//
//   node scripts/audit-market-registry.js

const fs = require('fs');
const path = require('path');

const MARKET_STATE = { SUPPORTED: 'model_supported', DERIVED: 'derived', DATA_REQUIRED: 'data_required', FORMULA_UNKNOWN: 'formula_unknown' };

// Mirrors NBA_PROP_DEFS (shared nba/wnba) -- modelKey -> providerKeys, kept
// in sync by hand with PARLAY_BB_MKT + NBA_PROP_DEFS in BeatsEdge.html.
const NBA_WNBA_SUPPORTED = {
  points: ['player_points', 'player_pts'], rebounds: ['player_rebounds', 'player_reb', 'player_total_rebounds'],
  assists: ['player_assists', 'player_ast'],
  threes: ['player_3-pt_made', 'player_threes', 'player_three_pointers_made', 'player_3pt_made'],
  pra: ['player_points_rebounds_assists', 'player_pts_rebs_asts', 'player_pts+rebs+asts'],
  pr: ['player_points_rebounds', 'player_pts_rebs', 'player_pts+rebs'],
  pa: ['player_points_assists', 'player_pts_asts', 'player_pts+asts'],
  ra: ['player_rebounds_assists', 'player_rebs_asts', 'player_rebs+asts'],
  steals: ['player_steals', 'player_stl'], blocks: ['player_blocks', 'player_blk', 'player_blocked_shots'],
  turnovers: ['player_turnovers', 'player_to'],
  blocksSteals: ['player_blocks_steals', 'player_steals_blocks', 'player_blks+stls'],
  fgMade: ['player_fg_made'], ftMade: ['player_free_throws_made'],
  twoPtMade: ['player_two_pointers_made'], fgAttempted: ['player_fg_attempted'],
  ftAttempted: ['player_free_throws_attempted'], twoPtAttempted: ['player_two_pointers_attempted'],
  fantasyPoints: ['player_fantasy_points'],
  // Phase 2A -- registered, but historical-data availability is genuinely
  // sport-conditional (see the sport-aware override in buildByProviderKey
  // below, mirroring BeatsEdge.html's buildMarketRegistry override).
  offensiveRebounds: ['player_offensive_rebounds'], defensiveRebounds: ['player_defensive_rebounds'],
};
const NBA_WNBA_DERIVED_KEYS = new Set(['pra', 'pr', 'pa', 'ra', 'twoPtMade', 'twoPtAttempted', 'blocksSteals']);
// Phase 2A -- OREB/DREB is the one pair of markets whose real state differs
// by sport even though they share one modelKey/def. NBA: SUPPORTED, but
// conditional on the optional hoopR backend being connected (falls back to
// provider-only per player otherwise -- runtime behavior, not visible to
// this static audit). WNBA: no historical source exists at all, so it
// never becomes model-supported regardless of live ESPN data.
const SPORT_CONDITIONAL_MODEL_KEYS = {
  offensiveRebounds: {
    nba: { state: MARKET_STATE.SUPPORTED, conditional: 'Requires the optional hoopR backend (nba_player_box) to be connected; falls back to provider-only per player when unavailable or that player has no historical record.' },
    wnba: { state: MARKET_STATE.DATA_REQUIRED, reason: 'No historical WNBA OREB source exists in this application. Live-only per-game data (confirmed available via ESPN\'s summary endpoint) cannot safely produce a hit-rate-based probability on its own.' },
  },
  defensiveRebounds: {
    nba: { state: MARKET_STATE.SUPPORTED, conditional: 'Requires the optional hoopR backend (nba_player_box) to be connected; falls back to provider-only per player when unavailable or that player has no historical record.' },
    wnba: { state: MARKET_STATE.DATA_REQUIRED, reason: 'No historical WNBA DREB source exists in this application. Live-only per-game data (confirmed available via ESPN\'s summary endpoint) cannot safely produce a hit-rate-based probability on its own.' },
  },
};

const NBA_WNBA_UNRESOLVED = [
  { providerKey: 'player_points_1st_quarter', displayName: 'Points 1st Quarter', state: MARKET_STATE.DATA_REQUIRED, reason: 'No period-level player statistics exist in any current data source.' },
  { providerKey: 'player_points_1st_half', displayName: 'Points 1st Half', state: MARKET_STATE.DATA_REQUIRED, reason: 'Same as Points 1st Quarter.' },
  { providerKey: 'player_fantasy_points_1st_half', displayName: 'Fantasy Points 1st Half', state: MARKET_STATE.DATA_REQUIRED, reason: 'Same as Points 1st Quarter; also source-specific formula.' },
  { providerKey: 'player_three_pointers', displayName: '3PT Made (PrizePicks demon/goblin variant)', state: MARKET_STATE.FORMULA_UNKNOWN, reason: 'Distinct raw key from player_threes, non-overlapping bookmaker set, not assumed equivalent.' },
  { providerKey: 'player_threes_made', displayName: '3PT Made (Pinnacle variant)', state: MARKET_STATE.FORMULA_UNKNOWN, reason: 'Distinct raw key from player_threes, not assumed equivalent.' },
  { providerKey: 'player_3_pt_made_combo', displayName: '3PT Made (combo variant)', state: MARKET_STATE.FORMULA_UNKNOWN, reason: '"Combo" semantics unconfirmed.' },
  { providerKey: 'player_pra', displayName: 'Pts+Reb+Ast (Underdog variant)', state: MARKET_STATE.FORMULA_UNKNOWN, reason: 'Distinct raw key from player_pts_rebs_asts, not assumed equivalent.' },
  { providerKey: 'player_pra_1st_half', displayName: 'Pts+Reb+Ast 1st Half (Underdog)', state: MARKET_STATE.DATA_REQUIRED, reason: 'Period market -- no period-level data available.' },
  { providerKey: 'player_pts_rebs_asts_1st_half', displayName: 'Pts+Reb+Ast 1st Half (PrizePicks)', state: MARKET_STATE.DATA_REQUIRED, reason: 'Period market -- no period-level data available.' },
];

function buildByProviderKey(sport) {
  const map = {};
  Object.entries(NBA_WNBA_SUPPORTED).forEach(([modelKey, keys]) => {
    const isDerived = NBA_WNBA_DERIVED_KEYS.has(modelKey);
    const override = SPORT_CONDITIONAL_MODEL_KEYS[modelKey] && SPORT_CONDITIONAL_MODEL_KEYS[modelKey][sport];
    const state = override ? override.state : (isDerived ? MARKET_STATE.DERIVED : MARKET_STATE.SUPPORTED);
    const reason = override ? (override.reason || null) : null;
    const conditional = override ? (override.conditional || null) : null;
    keys.forEach(k => { map[k] = { modelKey, state, reason, conditional }; });
  });
  NBA_WNBA_UNRESOLVED.forEach(e => { map[e.providerKey] = { modelKey: null, state: e.state, reason: e.reason, conditional: null }; });
  return map;
}

function auditSportFile(sport, marketsArray) {
  const registry = buildByProviderKey(sport);
  const results = marketsArray.map(m => {
    const entry = registry[m.market_key];
    return {
      providerKey: m.market_key, rowCount: m.rowCount, registered: !!entry,
      state: entry ? entry.state : MARKET_STATE.DATA_REQUIRED, modelKey: entry ? entry.modelKey : null,
      reason: entry ? entry.reason : 'Not yet in the registry -- newly observed raw market_key with no classification on record.',
      conditional: entry ? entry.conditional : null,
    };
  });
  const counts = { total: results.length, registered: results.filter(r => r.registered).length };
  [MARKET_STATE.SUPPORTED, MARKET_STATE.DERIVED, MARKET_STATE.DATA_REQUIRED, MARKET_STATE.FORMULA_UNKNOWN].forEach(s => {
    counts[s] = results.filter(r => r.state === s).length;
  });

  console.log(`\nSPORT: ${sport.toUpperCase()}`);
  console.log(`Provider markets observed: ${counts.total}`);
  console.log(`Registered: ${counts.registered} (${counts.total - counts.registered} unregistered)`);
  console.log(`Model supported: ${counts[MARKET_STATE.SUPPORTED]}`);
  console.log(`Derived: ${counts[MARKET_STATE.DERIVED]}`);
  console.log(`Provider-only (data required): ${counts[MARKET_STATE.DATA_REQUIRED]}`);
  console.log(`Provider-only (formula unknown): ${counts[MARKET_STATE.FORMULA_UNKNOWN]}`);
  const conditional = results.filter(r => r.conditional);
  if (conditional.length) {
    console.log('Conditionally supported (depends on optional data source, not guaranteed for every deployment/player):');
    conditional.forEach(r => console.log(`  - ${r.providerKey} (${r.rowCount} rows) [${r.state}]: ${r.conditional}`));
  }
  const unresolved = results.filter(r => r.state !== MARKET_STATE.SUPPORTED && r.state !== MARKET_STATE.DERIVED);
  if (unresolved.length) {
    console.log('Provider-only markets and why:');
    unresolved.forEach(r => console.log(`  - ${r.providerKey} (${r.rowCount} rows) [${r.state}]: ${r.reason}`));
  }
  return { sport, counts };
}

const TMP = path.join(__dirname, '..', 'tmp');
const nbaWnbaFile = path.join(TMP, 'parlayapi-nba-wnba-market-keys.json');

console.log('=== Market Registry Coverage Audit ===');

if (fs.existsSync(nbaWnbaFile)) {
  const data = JSON.parse(fs.readFileSync(nbaWnbaFile, 'utf8'));
  if (data.nba && Array.isArray(data.nba.markets)) auditSportFile('nba', data.nba.markets);
  else console.log('\nSPORT: NBA -- no markets array in the saved diagnostic (last run was HTTP ' + (data.nba && data.nba.httpStatus) + ')');
  if (data.wnba && Array.isArray(data.wnba.markets)) auditSportFile('wnba', data.wnba.markets);
  else console.log('\nSPORT: WNBA -- no markets array in the saved diagnostic (last run was HTTP ' + (data.wnba && data.wnba.httpStatus) + ')');
} else {
  console.log(`\nNo saved diagnostic found at ${nbaWnbaFile} -- run tmp/probe-parlayapi-nba-wnba.js first.`);
}

console.log('\nNote: MLB/NFL/NCAAF are not audited here -- this session only has a thin, sample-only MLB raw-market capture (tmp/parlayapi-bulk-test.json, no NBA/WNBA-depth board) and no fresh NFL/NCAAF raw-market diagnostic at all. Their existing *_PROP_DEFS/PARLAY_*_MKT tables are registered in BeatsEdge.html\'s MARKET_REGISTRY (built directly from those real objects), but auditing them against a live board the way NBA/WNBA are here would need its own fresh diagnostic run, not fabricated data.');
console.log('\nNote: NCAAB, NHL, soccer, tennis, and every esport named in the original task do not exist in this application at all yet -- confirmed via repo-wide search, zero ingestion/PROP_DEFS/UI for any of them.');
