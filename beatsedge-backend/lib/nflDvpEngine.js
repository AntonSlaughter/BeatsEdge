// NFL's version of dvpEngine.js. Same honest-aggregation approach, adapted
// to NFL's stat categories. Unlike NBA, positions here are real from
// ingestion — no compiled-positions.js equivalent needed for NFL, since
// nflverse publishes QB/RB/WR/TE cleanly for every row.

const db = require('./nflDb');

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

function recomputeNflDefenseByPosition() {
  const teams = db.prepare(`SELECT DISTINCT opponent AS team FROM nfl_player_game_stats`).all();

  const upsert = db.prepare(`
    INSERT INTO nfl_defense_by_position
      (team, position, window_type, passing_yards_allowed, rushing_yards_allowed,
       receiving_yards_allowed, receptions_allowed, tds_allowed, fantasy_points_allowed,
       rank, games_sampled, updated_at)
    VALUES (@team, @position, @window_type, @passing_yards_allowed, @rushing_yards_allowed,
       @receiving_yards_allowed, @receptions_allowed, @tds_allowed, @fantasy_points_allowed,
       @rank, @games_sampled, datetime('now'))
    ON CONFLICT(team, position, window_type) DO UPDATE SET
      passing_yards_allowed=excluded.passing_yards_allowed,
      rushing_yards_allowed=excluded.rushing_yards_allowed,
      receiving_yards_allowed=excluded.receiving_yards_allowed,
      receptions_allowed=excluded.receptions_allowed,
      tds_allowed=excluded.tds_allowed,
      fantasy_points_allowed=excluded.fantasy_points_allowed,
      rank=excluded.rank, games_sampled=excluded.games_sampled, updated_at=datetime('now')
  `);

  // "last8"/"last4" = most recent games by season+week ordering (a full NFL
  // season is 17-18 games, so 8/4 are meaningful recent-form windows —
  // NBA's last10/last20 don't translate directly given NFL's weekly schedule).
  const windows = [
    { type: 'season', limitGames: null },
    { type: 'last8', limitGames: 8 },
    { type: 'last4', limitGames: 4 }
  ];

  const results = {};

  windows.forEach(({ type, limitGames }) => {
    POSITIONS.forEach(position => {
      const rows = teams.map(({ team }) => {
        const games = limitGames
          ? db.prepare(`
              SELECT passing_yards, rushing_yards, receiving_yards, receptions,
                     (passing_tds + rushing_tds + receiving_tds) AS tds, fantasy_points_ppr
              FROM nfl_player_game_stats
              WHERE opponent = ? AND position = ?
              ORDER BY season DESC, week DESC LIMIT ?
            `).all(team, position, limitGames)
          : db.prepare(`
              SELECT passing_yards, rushing_yards, receiving_yards, receptions,
                     (passing_tds + rushing_tds + receiving_tds) AS tds, fantasy_points_ppr
              FROM nfl_player_game_stats
              WHERE opponent = ? AND position = ?
              ORDER BY season DESC, week DESC
            `).all(team, position);

        if (games.length === 0) return null;
        const avg = (key) => games.reduce((s, g) => s + (g[key] || 0), 0) / games.length;

        return {
          team,
          passing_yards_allowed: Math.round(avg('passing_yards') * 10) / 10,
          rushing_yards_allowed: Math.round(avg('rushing_yards') * 10) / 10,
          receiving_yards_allowed: Math.round(avg('receiving_yards') * 10) / 10,
          receptions_allowed: Math.round(avg('receptions') * 10) / 10,
          tds_allowed: Math.round(avg('tds') * 100) / 100,
          fantasy_points_allowed: Math.round(avg('fantasy_points_ppr') * 10) / 10,
          games_sampled: games.length
        };
      }).filter(Boolean);

      // Rank by fantasy points allowed to this position: 1 = fewest allowed (toughest)
      const sorted = [...rows].sort((a, b) => a.fantasy_points_allowed - b.fantasy_points_allowed);
      sorted.forEach((r, i) => { r.rank = i + 1; });

      rows.forEach(r => upsert.run({ ...r, position, window_type: type }));
      results[`${position}:${type}`] = rows.length;
    });
  });

  return results;
}

function getNflDefenseByPosition(team, windowType = 'season') {
  const rows = db.prepare(`
    SELECT position, passing_yards_allowed, rushing_yards_allowed, receiving_yards_allowed,
           receptions_allowed, tds_allowed, fantasy_points_allowed, rank, games_sampled
    FROM nfl_defense_by_position WHERE team = ? AND window_type = ?
  `).all(team, windowType);

  const byPosition = {};
  rows.forEach(r => {
    byPosition[r.position] = {
      passingYardsAllowed: r.passing_yards_allowed,
      rushingYardsAllowed: r.rushing_yards_allowed,
      receivingYardsAllowed: r.receiving_yards_allowed,
      receptionsAllowed: r.receptions_allowed,
      tdsAllowed: r.tds_allowed,
      fantasyPointsAllowed: r.fantasy_points_allowed,
      rank: r.rank,
      gamesSampled: r.games_sampled
    };
  });
  return byPosition;
}

module.exports = { recomputeNflDefenseByPosition, getNflDefenseByPosition, POSITIONS };
