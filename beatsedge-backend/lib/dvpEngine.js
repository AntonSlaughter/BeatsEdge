// The actual "defense vs position" computation.
//
// Nobody (not NBA.com, not WNBA.com, not ESPN) publishes this as a raw
// stat. It's always derived by walking box scores: for every game,
// look at what an opposing player at a given position did against a
// given team, and average that over a window. This file does exactly
// that, from data already in box_scores.

const db = require('./db');

const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];

/**
 * Recompute defense_by_position for every team/position/window in a sport.
 * Safe to run repeatedly — it fully replaces prior rows for each key.
 */
function recomputeDefenseByPosition(sport) {
  const teams = db.prepare(
    `SELECT DISTINCT opponent AS team FROM box_scores WHERE sport = ?`
  ).all(sport);

  const upsert = db.prepare(`
    INSERT INTO defense_by_position
      (sport, team, position, window_type, points_allowed, rebounds_allowed, assists_allowed, rank_points, games_sampled, updated_at)
    VALUES (@sport, @team, @position, @window_type, @points_allowed, @rebounds_allowed, @assists_allowed, @rank_points, @games_sampled, datetime('now'))
    ON CONFLICT(sport, team, position, window_type) DO UPDATE SET
      points_allowed = excluded.points_allowed,
      rebounds_allowed = excluded.rebounds_allowed,
      assists_allowed = excluded.assists_allowed,
      rank_points = excluded.rank_points,
      games_sampled = excluded.games_sampled,
      updated_at = datetime('now')
  `);

  const windows = [
    { type: 'season', limitGames: null },
    { type: 'last20', limitGames: 20 },
    { type: 'last10', limitGames: 10 }
  ];

  const results = {};

  windows.forEach(({ type, limitGames }) => {
    POSITIONS.forEach(position => {
      // For each team, average what THIS position scored against them,
      // most recent games first if a window is limited.
      const rows = teams.map(({ team }) => {
        const games = limitGames
          ? db.prepare(`
              SELECT points, rebounds, assists FROM box_scores
              WHERE sport = ? AND opponent = ? AND position = ?
              ORDER BY game_date DESC LIMIT ?
            `).all(sport, team, position, limitGames)
          : db.prepare(`
              SELECT points, rebounds, assists FROM box_scores
              WHERE sport = ? AND opponent = ? AND position = ?
              ORDER BY game_date DESC
            `).all(sport, team, position);

        if (games.length === 0) return null;

        const avg = (key) => games.reduce((s, g) => s + (g[key] || 0), 0) / games.length;
        return {
          team,
          points_allowed: Math.round(avg('points') * 10) / 10,
          rebounds_allowed: Math.round(avg('rebounds') * 10) / 10,
          assists_allowed: Math.round(avg('assists') * 10) / 10,
          games_sampled: games.length
        };
      }).filter(Boolean);

      // Rank by points allowed to this position: 1 = fewest allowed (toughest D)
      const sorted = [...rows].sort((a, b) => a.points_allowed - b.points_allowed);
      sorted.forEach((r, i) => { r.rank_points = i + 1; });

      rows.forEach(r => {
        upsert.run({
          sport,
          team: r.team,
          position,
          window_type: type,
          points_allowed: r.points_allowed,
          rebounds_allowed: r.rebounds_allowed,
          assists_allowed: r.assists_allowed,
          rank_points: r.rank_points,
          games_sampled: r.games_sampled
        });
      });

      results[`${position}:${type}`] = rows.length;
    });
  });

  return results;
}

/**
 * Read the precomputed DvP numbers for one team, all positions, a given window.
 */
function getDefenseByPosition(sport, team, windowType = 'season') {
  const rows = db.prepare(`
    SELECT position, points_allowed, rebounds_allowed, assists_allowed, rank_points, games_sampled, updated_at
    FROM defense_by_position
    WHERE sport = ? AND team = ? AND window_type = ?
  `).all(sport, team, windowType);

  const byPosition = {};
  rows.forEach(r => {
    byPosition[r.position] = {
      pointsAllowed: r.points_allowed,
      reboundsAllowed: r.rebounds_allowed,
      assistsAllowed: r.assists_allowed,
      rank: r.rank_points,
      gamesSampled: r.games_sampled
    };
  });
  return byPosition;
}

/**
 * Real defensive rating, offensive rating, and pace, computed from your own
 * historical CSV ingest (TeamStatisticsExtended.csv) — no live dependency,
 * so it works even when stats.nba.com blocks the live request.
 */
function getTeamAdvancedStats(sport, team, windowType = 'season') {
  const row = db.prepare(`
    SELECT defensive_rating, offensive_rating, pace, def_rating_rank, games_sampled, updated_at
    FROM team_advanced_rollup
    WHERE sport = ? AND team = ? AND window_type = ?
  `).get(sport, team, windowType);

  if (!row) return null;
  return {
    defensiveRating: row.defensive_rating,
    offensiveRating: row.offensive_rating,
    pace: row.pace,
    rank: row.def_rating_rank,
    gamesSampled: row.games_sampled,
    updatedAt: row.updated_at
  };
}

module.exports = { recomputeDefenseByPosition, getDefenseByPosition, getTeamAdvancedStats, POSITIONS };
