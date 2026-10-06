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

// `position` is read for the F/D league prior (v2). Goalies carry a null position.
async function getPlayerGames(statColumn, extraWhere = '') {
  return store.query(`
    SELECT player_id, player_name, team, game_date, season, position, ${statColumn} AS val
    FROM nhl_player_box
    WHERE ${statColumn} IS NOT NULL ${extraWhere}
    ORDER BY player_id, game_date ASC
  `);
}

// Team-game totals DERIVED FROM PLAYER ROWS (Σ skater shots_on_goal, Σ goalie saves) -- the live nightly sync writes no nhl_team_box,
// so the opponent shot environment is built from the same table the player model already reads.
async function getTeamGames() {
  return store.query(`
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

const SKATER_SOURCES = { shots_on_goal: 'shots_on_goal', goals_at_least_1: 'goals', assists_at_least_1: 'assists', points_at_least_1: 'points' };

// PURE (no DB): the v2 model from in-memory rows. Used by the nightly materializer (all stored rows, "as of now") and by the parity test
// (same function, `asOfExclusive` = a historical target date => uses ONLY rows dated strictly before it).
//   data = { skater: { shots_on_goal: rows, goals_at_least_1: rows, ... }, goalie: rows, teamGames: rows }
//   rows = getPlayerGames() shape: {player_id, player_name, team, game_date, season, position, val}
// Returns { projections, opponentContext }. Per-player rows are opponent-INDEPENDENT; opponentContext.teams[abbr] holds the factors
// that M.applyOpponent() multiplies in once the upcoming opponent is known.
function computeModelFromRows(data, { asOfExclusive } = {}) {
  const cut = (rows) => asOfExclusive ? rows.filter(r => r.game_date < asOfExclusive) : rows;
  const projections = {};
  const emit = (family, rowsIn, kind) => {
    const rows = cut(rowsIn); const spec = M.FAMILY_SPEC[family];
    const prior = spec.eb ? M.buildPrior(rows, kind) : null;
    const out = [];
    for (const [, rec] of groupByPlayer(rows)) {
      const n = rec.games.length; if (n < spec.minGames) continue;
      const vals = rec.games.map(g => g.val); const last = rec.games[n - 1];
      const lambda0 = family === 'goalie_saves' ? savesProjection(rec.games).projection : shrinkageFive(vals);
      const mu = prior ? (kind === 'goalie' ? prior.ALL : prior[M.positionGroup(last.position)]) : null;
      const o = M.familyOutput(family, { lambda0, n, mu });
      out.push({ playerId: rec.player_id, playerName: rec.player_name, team: rec.team, statKey: family, projection: o.projection, probability: o.probability, baseLambda: o.baseLambda,
        restAdjusted: false, gamesSampled: n, latestGameDate: last.game_date, modelVersion: M.NHL_MODEL_VERSION });
    }
    projections[family] = out;
  };
  emit('shots_on_goal', data.skater.shots_on_goal, 'position');
  emit('goalie_saves', data.goalie, 'goalie');
  for (const f of ['goals_at_least_1', 'assists_at_least_1', 'points_at_least_1']) emit(f, data.skater[f], 'position');
  return { projections, opponentContext: M.buildOpponentContext(data.teamGames, { asOfExclusive }) };
}

// Live: load once, compute everything (projections + opponent context).
async function computeAllModelOutputs() {
  const [sog, saves, goals, assists, points, teamGames] = await Promise.all([
    getPlayerGames('shots_on_goal'),
    getPlayerGames('saves', 'AND shots_against > 0'),   // excludes goalies dressed but never entering the game
    getPlayerGames('goals'), getPlayerGames('assists'), getPlayerGames('points'),
    getTeamGames(),
  ]);
  return computeModelFromRows({ skater: { shots_on_goal: sog, goals_at_least_1: goals, assists_at_least_1: assists, points_at_least_1: points }, goalie: saves, teamGames });
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
};
