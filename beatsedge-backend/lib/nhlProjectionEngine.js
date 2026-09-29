// NHL unlock project -- the exact validated projection formulas from
// scripts/research-nhl-baselines.js / research-nhl-distributions.js /
// research-nhl-features.js, reused verbatim (not retuned) for live
// integration. Only the two MODEL_CANDIDATE stat families (Shots on
// Goal, Goalie Saves) and the three BINARY_THRESHOLD_CONDITIONAL
// families (Goals/Assists/Points, P(stat>=1) at line=0.5 only) are
// implemented here. Nothing else -- see lib/nhlMarketMapping.js for the
// full classification, which this module's outputs feed.

const store = require('./historicalStore');

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

async function getPlayerGames(statColumn, extraWhere = '') {
  return store.query(`
    SELECT player_id, player_name, team, game_date, season, ${statColumn} AS val
    FROM nhl_player_box
    WHERE ${statColumn} IS NOT NULL ${extraWhere}
    ORDER BY player_id, game_date ASC
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
// sat the whole game -- found via a live sanity-check on a suspiciously
// low real projection, e.g. a real player showing a 3.8-save trailing
// average despite games with 20-40 real saves in the same window). With
// that filtered out (shots_against > 0, see getPlayerGames callers
// below), the rest/back-to-back improvement all but disappears (real
// re-run: 6.1112 vs 6.1211 baseline MAE, ~0.16% -- not a real, validated
// signal, unlike the originally-reported 6.6%) while shrinkage-5 (the
// SAME formula already validated for Shots on Goal) ties or slightly
// beats plain trailing-10 on the corrected data. The rest/back-to-back
// adjustment is therefore DROPPED from the live projection -- this is a
// data-bug correction, not a retune of a fairly-validated result.
function savesProjection(games) {
  return { projection: shrinkageFive(games.map(g => g.val)), restAdjusted: false };
}

async function computeShotsOnGoalProjections(minPriorGames = 10) {
  const rows = await getPlayerGames('shots_on_goal', "AND season IN (2024,2025,2026)");
  const byPlayer = groupByPlayer(rows);
  const out = [];
  for (const [, rec] of byPlayer) {
    if (rec.games.length < minPriorGames) continue;
    const projection = shrinkageFive(rec.games.map(g => g.val));
    out.push({ playerId: rec.player_id, playerName: rec.player_name, team: rec.team, statKey: 'shots_on_goal', projection, gamesSampled: rec.games.length });
  }
  return out;
}

// STALE COMMENT REMOVED (2026-09-29): this function used to take an
// isUpcomingB2BByTeam schedule-lookup parameter for a rest/back-to-back
// adjustment. That adjustment is dropped -- see savesProjection's own
// comment for the corrected finding. `restAdjusted` is now always false;
// kept on the output shape only so existing callers don't need a shape
// change, not because a rest adjustment is still applied.
async function computeGoalieSavesProjections(minPriorGames = 8) {
  // shots_against > 0 excludes goalies dressed but never actually
  // entering the game (real data: saves=0/shots_against=0/goals_against=0
  // rows for backups who sat the whole game) -- same real convention
  // lib/nhlEngine.js already established for the OTHER NHL data source.
  const rows = await getPlayerGames('saves', "AND season IN (2024,2025,2026) AND shots_against > 0");
  const byPlayer = groupByPlayer(rows);
  const out = [];
  for (const [, rec] of byPlayer) {
    if (rec.games.length < minPriorGames) continue;
    const { projection, restAdjusted } = savesProjection(rec.games);
    out.push({ playerId: rec.player_id, playerName: rec.player_name, team: rec.team, statKey: 'goalie_saves', projection, restAdjusted, gamesSampled: rec.games.length });
  }
  return out;
}

async function computeBinaryThresholdProjections(statColumn, statKeyOut, minPriorGames = 15) {
  const rows = await getPlayerGames(statColumn, "AND season IN (2024,2025,2026)");
  const byPlayer = groupByPlayer(rows);
  const out = [];
  for (const [, rec] of byPlayer) {
    if (rec.games.length < minPriorGames) continue;
    const lambda = shrinkageFive(rec.games.map(g => g.val));
    const pOver1 = poissonPOver1(lambda);
    out.push({ playerId: rec.player_id, playerName: rec.player_name, team: rec.team, statKey: statKeyOut, probability: pOver1, gamesSampled: rec.games.length });
  }
  return out;
}

// Bulk: everything the live pipeline needs in one call, keyed by
// normalized player name (nflNormName-equivalent normalization is done
// by the CALLER/frontend -- this returns raw player_name so the caller
// controls its own normalization, consistent with how every other
// sport's roster join already works in BeatsEdge.html).
async function computeAllProjections() {
  const [sog, saves, goals, assists, points] = await Promise.all([
    computeShotsOnGoalProjections(),
    computeGoalieSavesProjections(),
    computeBinaryThresholdProjections('goals', 'goals_at_least_1'),
    computeBinaryThresholdProjections('assists', 'assists_at_least_1'),
    computeBinaryThresholdProjections('points', 'points_at_least_1'),
  ]);
  return { shots_on_goal: sog, goalie_saves: saves, goals_at_least_1: goals, assists_at_least_1: assists, points_at_least_1: points };
}

module.exports = {
  shrinkageFive, trailingMean, poissonPOver1, savesProjection,
  computeShotsOnGoalProjections, computeGoalieSavesProjections, computeBinaryThresholdProjections,
  computeAllProjections,
};
