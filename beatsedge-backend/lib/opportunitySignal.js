// Opportunity / Usage / Workload research signal -- Phase 7.
//
// AUDIT FINDING that motivated this file (see Phase 7 final report for the
// full audit): _calculateEdgeScoreImpl's projection is a direct empirical-
// Bayes blend of the player's OWN raw stat-VALUE windows (recentAvg,
// seasonAvg, last10Avg, vsOppAvg -- e.g. points/game, receiving yards/game)
// -- it never models opportunity (shots attempted, targets, touches) as an
// intermediate step. The ONLY opportunity-adjacent input already in Model A
// is the "Minutes Trend" factor (NBA/WNBA only, a single min/game delta --
// see Factor 3 in _calculateEdgeScoreImpl). Shot volume (FGA/3PA/FTA) and
// NFL targets are confirmed NOT read anywhere in Model A -- genuinely new,
// non-redundant information, distinct from minutes (Phase 5 already
// validated a minutes-level signal; this file's whole job per Step 6 of
// the Phase 7 spec is to test whether shot volume/targets predict anything
// BEYOND minutes, not to re-test minutes itself).
//
// SCOPE: NBA (nba_player_box has real fgm/fga/ftm/fta/threes/threes_att
// columns, 573k+ rows, full 2009-2026 depth -- same table Next Man Up and
// Projection Stability already use) and NFL (nfl_player_game_stats has real
// targets/receptions columns with full 2022-2026 depth, confirmed by
// Phase 6's audit -- NOT the pass_attempts/rush_attempts columns Phase 4/6
// found are only populated for season 2025+). MLB/WNBA/CFB: see the Phase 7
// report for why they are not implemented here (MLB's real historical depth
// is 9 days; WNBA/CFB have no backend historical table at all -- same
// findings every prior phase already established).
//
// This module NEVER writes to any field _calculateEdgeScoreImpl reads
// (projection, the factors array, minutesTrend, paceRating, etc.) -- it
// only computes a SEPARATE, additive `opportunity` signal for the caller to
// bucket the model's own EXISTING output by, observationally.

const { SEASON_TYPE_REGULAR, EXHIBITION_OPP, computeRoleWindow } = require('./nextManUpSignal');

const NOT_EXHIB_CLAUSE = `opponent NOT IN (${EXHIBITION_OPP.map(() => '?').join(',')})`;

// A player's own trailing REAL shot-volume window (FGA, 3PA, FTA, and a
// combined "attempts" count = fga + 0.44*fta, the standard true-shooting-
// attempts proxy), from games strictly before asOfDate. Same leak-safety
// discipline as lib/nextManUpSignal.js's computeRoleWindow (which this
// function deliberately does NOT duplicate -- it reads different columns
// for a different question).
function computeShotVolumeWindow(db, athleteId, asOfDate, { games, minGames = 1, seasonOnly = null } = {}) {
  const seasonClause = seasonOnly != null ? 'AND season = ?' : '';
  const params = [athleteId, asOfDate, ...EXHIBITION_OPP];
  if (seasonOnly != null) params.push(seasonOnly);
  params.push(games);
  const rows = db.prepare(`
    SELECT game_date, fga, fta, threes_att, minutes
    FROM nba_player_box
    WHERE athlete_id = ? AND game_date < ? AND season_type = ${SEASON_TYPE_REGULAR}
      AND played = 1 AND ${NOT_EXHIB_CLAUSE} ${seasonClause}
    ORDER BY game_date DESC
    LIMIT ?
  `).all(...params);

  if (rows.length < minGames) {
    return { games: rows.length, sufficient: false, avgFga: null, avgFta: null, avg3pa: null, avgAttempts: null, avgAttemptsPerMin: null };
  }
  const mean = (key) => rows.reduce((s, r) => s + (r[key] || 0), 0) / rows.length;
  const avgFga = mean('fga'), avgFta = mean('fta'), avg3pa = mean('threes_att'), avgMin = mean('minutes');
  const avgAttempts = avgFga + 0.44 * avgFta;
  return {
    games: rows.length, sufficient: true,
    avgFga: Math.round(avgFga * 10) / 10, avgFta: Math.round(avgFta * 10) / 10, avg3pa: Math.round(avg3pa * 10) / 10,
    avgAttempts: Math.round(avgAttempts * 10) / 10,
    // attempts per minute -- isolates whether a player is getting MORE
    // shots for the SAME playing time (a workload-density signal distinct
    // from simply playing more minutes).
    avgAttemptsPerMin: avgMin > 0 ? Math.round((avgAttempts / avgMin) * 1000) / 1000 : null,
    mostRecentGameDate: rows[0].game_date,
  };
}

// NFL: a player's own trailing real targets/receptions window (the
// opportunity side of a receiving prop, distinct from receiving_yards, the
// outcome side). Strictly (season, week) before the target -- same
// leak-safety pattern lib/nflMatchupSignal.js and lib/nflGameEnvironment.js
// already established for this table.
function computeTargetShareWindow(db, playerId, season, week, { games = 5, minGames = 2 } = {}) {
  const rows = db.prepare(`
    SELECT season, week, targets, receptions
    FROM nfl_player_game_stats
    WHERE player_id = ? AND (season < ? OR (season = ? AND week < ?))
    ORDER BY season DESC, week DESC
    LIMIT ?
  `).all(playerId, season, season, week, games);
  const real = rows.filter(r => (r.targets || 0) > 0 || (r.receptions || 0) > 0);
  if (real.length < minGames) return { games: real.length, sufficient: false, avgTargets: null, avgReceptions: null };
  const avgTargets = real.reduce((s, r) => s + (r.targets || 0), 0) / real.length;
  const avgReceptions = real.reduce((s, r) => s + (r.receptions || 0), 0) / real.length;
  return { games: real.length, sufficient: true, avgTargets: Math.round(avgTargets * 10) / 10, avgReceptions: Math.round(avgReceptions * 10) / 10 };
}

// Combines a short (recent) window against a longer (baseline) window into
// an "opportunity trend" -- continuous values, per Step 5's explicit
// instruction not to invent thresholds up front. The CALLER (the backtest)
// decides whether/how to bucket this for reporting; this function never
// classifies "increased"/"decreased" itself (that categorical judgment
// belongs to Phase 5's already-locked classifyRoleChange for MINUTES --
// this is deliberately just the raw numbers for ATTEMPTS/TARGETS).
function computeOpportunityTrend(recentWindow, baselineWindow, field) {
  if (!recentWindow || !baselineWindow || !recentWindow.sufficient || !baselineWindow.sufficient) return null;
  const recentVal = recentWindow[field], baseVal = baselineWindow[field];
  if (recentVal == null || baseVal == null) return null;
  const delta = recentVal - baseVal;
  const deltaPct = baseVal > 0 ? delta / baseVal : null;
  return { recentVal, baseVal, delta: Math.round(delta * 100) / 100, deltaPct: deltaPct != null ? Math.round(deltaPct * 1000) / 1000 : null };
}

module.exports = { computeShotVolumeWindow, computeTargetShareWindow, computeOpportunityTrend };
