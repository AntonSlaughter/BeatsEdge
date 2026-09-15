// NFL Matchup (stat-specific defense-vs-position) research signal -- Phase 6.
//
// AUDIT FINDING that motivated this file (see Phase 6 final report for the
// full audit): BeatsEdge.html already fetches real, rich, stat-specific
// defense-vs-position data for NFL (GET /api/nfl/defense/by-position/:team,
// backed by nfl_defense_by_position -- pass/rush/target/reception/yards
// ALLOWED per position, computed by lib/nflDvpEngine.js) and attaches it to
// player.opponentDefense.byPosition[pos] for every live NFL player
// (BeatsEdge.html, the NFL slate builder, `opponentDefense: dvpByTeam[...]`).
// But _calculateEdgeScoreImpl explicitly EXCLUDES NFL/CFB from the generic
// posDefense-based factor (`sport !== 'nfl' && sport !== 'ncaaf'`), and the
// file's own comment says why: "Real NFL opponentDefense data is now
// populated... but this pass only exposes it as research/UI data -- it must
// not silently start voting on the model... Any future NFL-specific numeric
// adjustment needs its own temporal holdout validation first." This file
// and its backtest are that validation.
//
// nfl_defense_by_position itself is a CURRENT ROLLUP (L3/L5/L10/season/
// multiseason as of now), not point-in-time -- using it directly for a
// historical backtest date would leak the future. So this module recomputes
// the same idea (real stat allowed to a position, per opponent) directly
// from nfl_player_game_stats with a strict leak-safe (season, week) cutoff,
// mirroring the exact pattern lib/nflGameEnvironment.js already established
// for play-volume (computeTeamPlayVolumeAsOf) -- same leakage discipline,
// different question (defense allowed to a position vs. offensive pace).
//
// Real historical depth: nfl_player_game_stats' core stat columns
// (receiving_yards, targets, receptions, rushing_yards) are populated for
// EVERY season 2022-2026 (confirmed by direct query -- unlike the
// pass_attempts/rush_attempts columns Phase 4 found were only populated for
// season 2025+). passing_yards is naturally sparse (QB-only, ~650 rows/
// season out of 5,500+) -- not a data-quality gap, just position sparsity.
// This module is scoped to WR/RB receiving+rushing stats, where the real
// historical sample is deepest.

const STAT_FIELD = {
  receivingYards: 'receiving_yards',
  targets: 'targets',
  receptions: 'receptions',
  rushingYards: 'rushing_yards',
};

// Real, leak-safe trailing "how much of this stat has this DEFENSE allowed
// to this POSITION," strictly before (season, week). Same leakage pattern
// as lib/nflGameEnvironment.js's computeTeamPlayVolumeAsOf: season < target,
// OR same season at an earlier week.
function computeDefenseAllowedAsOf(db, defenseTeam, position, statKey, season, week, { games = 5, minGames = 2 } = {}) {
  const field = STAT_FIELD[statKey];
  if (!field) return { games: 0, sufficient: false, avgAllowed: null };

  const rows = db.prepare(`
    SELECT season, week, SUM(${field}) total, COUNT(*) players
    FROM nfl_player_game_stats
    WHERE opponent = ? AND position = ? AND (season < ? OR (season = ? AND week < ?))
    GROUP BY season, week
    ORDER BY season DESC, week DESC
    LIMIT ?
  `).all(defenseTeam, position, season, season, week, games);

  // A team-week with zero total AND zero players simply means no game that
  // week (bye) -- exclude it, don't count it as "allowed nothing."
  const real = rows.filter(r => r.players > 0);
  if (real.length < minGames) return { games: real.length, sufficient: false, avgAllowed: null };

  const avgAllowed = real.reduce((s, r) => s + (r.total || 0), 0) / real.length;
  return { games: real.length, sufficient: true, avgAllowed: Math.round(avgAllowed * 10) / 10 };
}

// Bulk fetch: every real nfl_player_game_stats row broken down by
// (opponent, position, season, week) for a set of defenses -- lets a
// caller (the backtest) build its own as-of trailing windows in memory
// instead of one request per prediction point.
function bulkDefenseAllowedHistory(db, teams, positions) {
  const teamList = [...new Set((teams || []).map(String))].filter(Boolean);
  const posList = [...new Set((positions || ['WR', 'RB']).map(String))].filter(Boolean);
  if (!teamList.length || !posList.length) return {};
  const tph = teamList.map(() => '?').join(',');
  const pph = posList.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT opponent, position, season, week,
      SUM(receiving_yards) receivingYards, SUM(targets) targets,
      SUM(receptions) receptions, SUM(rushing_yards) rushingYards,
      COUNT(*) players
    FROM nfl_player_game_stats
    WHERE opponent IN (${tph}) AND position IN (${pph})
    GROUP BY opponent, position, season, week
    ORDER BY opponent, position, season, week
  `).all(...teamList, ...posList);
  const out = {};
  rows.forEach(r => {
    if (!r.players) return; // bye/no real game that week
    const key = r.opponent + '|' + r.position;
    (out[key] = out[key] || []).push(r);
  });
  return out;
}

// Bulk real per-player-per-game rows from the SAME backend table
// (nfl_player_game_stats) the matchup signal above reads -- so the
// backtest sources a player's own series and the opponent's real
// defense-allowed data from one consistent pipeline, rather than mixing
// this backend table with BeatsEdge.html's separate live-ESPN gamelog
// fetch (a different data source with its own player-id space).
function bulkPlayerHistory(db, playerIds) {
  const list = [...new Set((playerIds || []).map(String))].filter(Boolean);
  if (!list.length) return {};
  const ph = list.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT player_id, season, week, position, team, opponent,
      receiving_yards, targets, receptions, rushing_yards, passing_yards,
      passing_tds, rushing_tds, receiving_tds, interceptions, fantasy_points_ppr
    FROM nfl_player_game_stats
    WHERE player_id IN (${ph})
    ORDER BY player_id, season, week
  `).all(...list);
  const out = {};
  rows.forEach(r => { (out[r.player_id] = out[r.player_id] || []).push(r); });
  return out;
}

// A real pool of NFL skill-position players with enough historical games to
// walk forward -- mirrors nbaHistDb.js's backtestPool for NFL.
function backtestPool(db, { minGames = 15, limit = 300 } = {}) {
  const rows = db.prepare(`
    SELECT player_id, player_name, position, COUNT(*) g
    FROM nfl_player_game_stats
    WHERE player_id IS NOT NULL AND player_id != ''
    GROUP BY player_id
    HAVING g >= ?
    ORDER BY g DESC
    LIMIT ?
  `).all(minGames, limit);
  const lastTeam = db.prepare(`SELECT team FROM nfl_player_game_stats WHERE player_id = ? ORDER BY season DESC, week DESC LIMIT 1`);
  return rows.map(r => ({ id: r.player_id, name: r.player_name, position: r.position, games: r.g, team: (lastTeam.get(r.player_id) || {}).team || null }));
}

module.exports = { STAT_FIELD, computeDefenseAllowedAsOf, bulkDefenseAllowedHistory, bulkPlayerHistory, backtestPool };
