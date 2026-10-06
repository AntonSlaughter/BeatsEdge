// NHL projection engine.
//
// v1 (2026-09-29): shrinkage-5 / Poisson, exact formulas from scripts/research-nhl-*.js.
// v2 (NHL_MODEL_VERSION, see lib/nhlModel.js): the FROZEN, 2026-confirmed model -- shrinkage-5 lambda0 (UNCHANGED, below) plus
//   sample-size-aware shrinkage toward as-of league priors (Saves, Goal, Assist, Point) and an opponent shot-environment factor
//   (SOG, Saves, Point). All v2 arithmetic lives in lib/nhlModel.js as pure functions; this file only loads rows and feeds them in.
//
// shrinkageFive / poissonPOver1 / savesProjection below are the production building blocks and are deliberately UNCHANGED:
// they are the "lambda0" the frozen specification builds on.

const store = require('./historicalStore');
const M = require('./nhlModel');

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }

// Shrinkage-5, k=8 -- exact formula from research-nhl-baselines.js's
// shrink()/research-nhl-distributions.js's shrunkMu, validated as the
// winning Shots on Goal point projection on the 2026 holdout.
function shrinkageFive(values, k = 8) {
  if (!values.length) return null;
  const seasonMean = mean(values);
  const l5 = values.slice(-5);
  const l5Mean = mean(l5);
  return ((l5.length * l5Mean) + (k * seasonMean)) / (l5.length + k);
}

// Trailing-10 mean -- exact formula validated as the Goalie Saves
// baseline point estimate in research-nhl-baselines.js.
function trailingMean(values, n = 10) {
  const w = values.slice(-n);
  return w.length ? mean(w) : null;
}

// Poisson pmf(0)/(1) -- exact formula from research-nhl-distributions.js,
// used only for the validated P(stat>=1) binary-threshold families.
function poissonPZero(lambda) { return Math.exp(-lambda); }
function poissonPOver1(lambda) { return 1 - poissonPZero(lambda); }

// The nightly refresh makes ~130 small sequential reads. All are idempotent, so a transient connection error ("terminated", reset, timeout) is retried
// a couple of times before the run is failed -- one flaky response must not discard an otherwise complete refresh. After the last attempt the error is
// rethrown unchanged, so the materializer still fails safe (previous snapshot untouched).
const READ_ATTEMPTS = 3;
async function readQuery(sql, params) {
  let lastErr;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    try { return await store.query(sql, params); }
    catch (e) { lastErr = e; if (attempt < READ_ATTEMPTS) await new Promise(r => setTimeout(r, 400 * attempt * attempt)); }
  }
  throw lastErr;
}
// `position` is read for the F/D league prior (v2). Goalies carry a null position.
async function getPlayerGames(statColumn, extraWhere = '') {
  return readQuery(`
    SELECT player_id, player_name, team, game_date, season, position, ${statColumn} AS val
    FROM nhl_player_box
    WHERE ${statColumn} IS NOT NULL ${extraWhere}
    ORDER BY player_id, game_date ASC
  `);
}

// Team-game totals DERIVED FROM PLAYER ROWS (Σ skater shots_on_goal, Σ goalie saves) -- the live nightly sync writes no nhl_team_box,
// so the opponent shot environment is built from the same table the player model already reads.
async function getTeamGames() {
  return readQuery(`
    SELECT game_id, team, opponent, game_date, SUM(shots_on_goal) AS sf, SUM(saves) AS sv
    FROM nhl_player_box
    GROUP BY game_id, team, opponent, game_date
  `);
}

function groupByPlayer(rows) {
  const byPlayer = new Map();
  for (const r of rows) {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, { player_id: r.player_id, player_name: r.player_name, team: r.team, games: [] });
    const rec = byPlayer.get(r.player_id);
    rec.team = r.team; // most recent team wins
    rec.games.push(r);
  }
  return byPlayer;
}

// CORRECTED during integration: research-nhl-features.js's original
// rest/back-to-back test was run on data polluted by goalies dressed but
// never entering the game (saves=0/shots_against=0 rows for backups who
// sat the whole game). With that filtered out (shots_against > 0), the
// rest/back-to-back improvement all but disappears, so it is DROPPED;
// shrinkage-5 is the Saves lambda0. `restAdjusted` is vestigial (always false).
function savesProjection(games) {
  return { projection: shrinkageFive(games.map(g => g.val)), restAdjusted: false };
}

// Skater stat columns behind each skater family. Each family takes the rows where its own column is non-null -- exactly the population the former
// per-family `WHERE <col> IS NOT NULL` queries returned, in the same order.
const SKATER_FAMILY_COLUMNS = { shots_on_goal: 'shots_on_goal', goals_at_least_1: 'goals', assists_at_least_1: 'assists', points_at_least_1: 'points' };
const SKATER_ANY_STAT = `(shots_on_goal IS NOT NULL OR goals IS NOT NULL OR assists IS NOT NULL OR points IS NOT NULL)`;
const SKATER_BATCH_PLAYERS = 10;    // ~1.5k rows per response. Measured against production: peak RSS 251 MB at 100/batch, 202 at 25, 141 at 10 (wall time ~flat); the batched query is an index SEEK per id (idx_nhl_pbox_player), so more batches cost round trips, not rows read

// Family view of loaded skater rows: {player_id, player_name, team, game_date, position, val} where `col` is non-null (strings are shared with the
// source rows; only a small object shell per row is added, and the view is dropped right after its family has been consumed).
function skaterFamilyRows(skaterRows, col) {
  const out = [];
  for (const r of skaterRows) { const v = r[col]; if (v != null) out.push({ player_id: r.player_id, player_name: r.player_name, team: r.team, game_date: r.game_date, position: r.position, val: v }); }
  return out;
}

// STEP 1 of a family (needs only that player's own rows): the opponent-independent summary of each player who has enough history.
//   lambda0 = production shrinkageFive (Saves: savesProjection, the same value); `pos` = position group of the player's latest game.
function summarizePlayers(family, rows) {
  const spec = M.FAMILY_SPEC[family]; const out = [];
  for (const [, rec] of groupByPlayer(rows)) {
    const n = rec.games.length; if (n < spec.minGames) continue;
    const last = rec.games[n - 1];
    const lambda0 = family === 'goalie_saves' ? savesProjection(rec.games).projection : shrinkageFive(rec.games.map(g => g.val));
    out.push({ playerId: rec.player_id, playerName: rec.player_name, team: rec.team, n, lambda0, pos: last.position, latestGameDate: last.game_date });
  }
  return out;
}

// STEP 2 of a family (needs the league prior over ALL of the family's rows): shrinkage + output row. `prior` is null when the family has no shrinkage.
function finalizeSummaries(family, summaries, prior, kind) {
  return summaries.map(s => {
    const mu = prior ? (kind === 'goalie' ? prior.ALL : prior[M.positionGroup(s.pos)]) : null;
    const o = M.familyOutput(family, { lambda0: s.lambda0, n: s.n, mu });
    return { playerId: s.playerId, playerName: s.playerName, team: s.team, statKey: family, projection: o.projection, probability: o.probability, baseLambda: o.baseLambda,
      restAdjusted: false, gamesSampled: s.n, latestGameDate: s.latestGameDate, modelVersion: M.NHL_MODEL_VERSION };
  });
}

// PURE (no DB): one family from ALL of its in-memory rows. `asOfExclusive` (parity test) restricts to rows strictly before that date.
//   rows = {player_id, player_name, team, game_date, position, val}, ordered by player then game_date
function computeFamilyRows(family, rowsIn, kind, asOfExclusive) {
  const rows = asOfExclusive ? rowsIn.filter(r => r.game_date < asOfExclusive) : rowsIn; const spec = M.FAMILY_SPEC[family];
  return finalizeSummaries(family, summarizePlayers(family, rows), spec.eb ? M.buildPrior(rows, kind) : null, kind);
}

// PURE (no DB): the v2 model from in-memory rows. Used by the parity test (`asOfExclusive` = a historical target date => ONLY rows dated strictly before it).
//   data = { skater: { shots_on_goal: rows, goals_at_least_1: rows, ... }, goalie: rows, teamGames: rows }
// Returns { projections, opponentContext }. Per-player rows are opponent-INDEPENDENT; opponentContext.teams[abbr] holds the factors
// that M.applyOpponent() multiplies in once the upcoming opponent is known.
function computeModelFromRows(data, { asOfExclusive } = {}) {
  const projections = {};
  projections.shots_on_goal = computeFamilyRows('shots_on_goal', data.skater.shots_on_goal, 'position', asOfExclusive);
  projections.goalie_saves = computeFamilyRows('goalie_saves', data.goalie, 'goalie', asOfExclusive);
  for (const f of ['goals_at_least_1', 'assists_at_least_1', 'points_at_least_1']) projections[f] = computeFamilyRows(f, data.skater[f], 'position', asOfExclusive);
  return { projections, opponentContext: M.buildOpponentContext(data.teamGames, { asOfExclusive }) };
}

// LIVE skaters, bounded memory. The old code fetched the same ~150k skater rows FOUR times (once per stat) alongside the goalie/team queries, all
// concurrently: ~700 MB RSS and multi-second event-loop stalls, far beyond a 512 MiB / ~0.1 vCPU Render instance (OOM kills, V8 heap-limit crashes, Turso
// streams dropped as "terminated"). Now: list the player ids once, then process them in batches of SKATER_BATCH_PLAYERS. Per batch, each family's rows feed
//   (a) the family's running league-prior sums (added in the SAME global order as the one-shot buildPrior => bit-identical means), and
//   (b) compact per-player summaries; the batch's rows are then dropped. Finalization (shrinkage with the full-pool prior) happens once at the end.
// Output is identical to computeModelFromRows on the same rows (scripts/test-nhl-model-parity.js, section D).
async function computeSkaterFamilies() {
  const ids = (await readQuery(`SELECT DISTINCT player_id FROM nhl_player_box WHERE ${SKATER_ANY_STAT} ORDER BY player_id`)).map(r => r.player_id);
  const acc = {}, sums = {};
  for (const f of Object.keys(SKATER_FAMILY_COLUMNS)) { acc[f] = M.newPriorAccumulator('position'); sums[f] = []; }
  for (let i = 0; i < ids.length; i += SKATER_BATCH_PLAYERS) {
    const batch = ids.slice(i, i + SKATER_BATCH_PLAYERS);
    const rows = await readQuery(`
      SELECT player_id, player_name, team, game_date, position, shots_on_goal, goals, assists, points
      FROM nhl_player_box
      WHERE ${SKATER_ANY_STAT} AND player_id IN (${batch.map(() => '?').join(',')})
      ORDER BY player_id, game_date ASC
    `, batch);
    for (const [family, col] of Object.entries(SKATER_FAMILY_COLUMNS)) {
      const fr = skaterFamilyRows(rows, col);
      M.accumulatePrior(acc[family], fr, 'position');
      for (const s of summarizePlayers(family, fr)) sums[family].push(s);
    }
  }
  const out = {};
  for (const family of Object.keys(SKATER_FAMILY_COLUMNS)) out[family] = finalizeSummaries(family, sums[family], M.FAMILY_SPEC[family].eb ? M.priorFromAccumulator(acc[family], 'position') : null, 'position');
  return out;
}

// Live ("as of now"): sequential, bounded-memory loads (skaters in batches, then the small goalie and team-game queries), then the same pure steps.
async function computeAllModelOutputs() {
  const skaters = await computeSkaterFamilies();
  const goalieRows = await getPlayerGames('saves', 'AND shots_against > 0');              // excludes goalies dressed but never entering the game
  const goalies = computeFamilyRows('goalie_saves', goalieRows, 'goalie');
  const opponentContext = M.buildOpponentContext(await getTeamGames());
  // canonical family order (unchanged: SOG, Saves, Goal, Assist, Point)
  return { projections: { shots_on_goal: skaters.shots_on_goal, goalie_saves: goalies, goals_at_least_1: skaters.goals_at_least_1, assists_at_least_1: skaters.assists_at_least_1, points_at_least_1: skaters.points_at_least_1 }, opponentContext };
}

// Backwards-compatible entry point: per-family player rows (v2 opponent-independent values; see lib/nhlModel.js).
async function computeAllProjections() { return (await computeAllModelOutputs()).projections; }

// Real, chronological, full per-game history for ONE resolved player --
// powers the frontend's historical detail modal (L5/L10/L15/L20/Season/
// Vs Opponent). A sibling read next to getPlayerGames() above, not a
// modification of it: getPlayerGames() stays bulk-scanned-across-all-
// players for projection computation, untouched; this is a single-player,
// all-columns read for display only. A skater row always has null
// saves/shots_against and a goalie row always has null
// goals/assists/points/shots_on_goal (separate INSERT statements in
// lib/nhlPlayerBoxSync.js, never mixed for the same player_id) -- the
// caller picks the right column per stat family.
async function getPlayerGameHistory(playerId) {
  return store.query(`
    SELECT game_id, player_id, player_name, team, opponent, game_date, season,
           goals, assists, points, shots_on_goal, saves, shots_against
    FROM nhl_player_box
    WHERE player_id = ?
    ORDER BY game_date ASC
  `, [playerId]);
}

module.exports = {
  shrinkageFive, trailingMean, poissonPOver1, savesProjection,
  computeModelFromRows, computeAllModelOutputs, computeAllProjections, getPlayerGameHistory,
  _readQuery: readQuery, // exported for tests only
};
