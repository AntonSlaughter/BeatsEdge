// Real situational splits: how does THIS player actually perform on
// back-to-backs vs rested, and at home vs on the road? Computed by
// joining real box scores to the real schedule (game_id + team), not
// estimated. This is what feeds the Edge Score engine's rest/schedule
// and home/away factors with real data instead of a placeholder.

const db = require('./db');

/**
 * Real situational split for one player: back-to-back vs rested,
 * and home vs away, using their actual game log joined to the real
 * schedule table.
 */
function getPlayerSituationalSplits(playerName) {
  const rows = db.prepare(`
    SELECT bs.points, bs.rebounds, bs.assists, ts.is_back_to_back, ts.is_home, bs.game_date
    FROM box_scores bs
    JOIN team_schedule ts
      ON bs.sport = ts.sport AND bs.game_id = ts.game_id AND bs.team = ts.team
    WHERE bs.sport = 'nba' AND bs.player_name = ?
  `).all(playerName);

  if (rows.length === 0) return null;

  const avg = (arr, key) => arr.length ? Math.round((arr.reduce((s, r) => s + r[key], 0) / arr.length) * 10) / 10 : null;

  const b2b = rows.filter(r => r.is_back_to_back === 1);
  const rested = rows.filter(r => r.is_back_to_back === 0);
  const home = rows.filter(r => r.is_home === 1);
  const away = rows.filter(r => r.is_home === 0);

  return {
    totalGames: rows.length,
    backToBack: {
      games: b2b.length,
      pointsAvg: avg(b2b, 'points'),
      reboundsAvg: avg(b2b, 'rebounds'),
      assistsAvg: avg(b2b, 'assists')
    },
    rested: {
      games: rested.length,
      pointsAvg: avg(rested, 'points'),
      reboundsAvg: avg(rested, 'rebounds'),
      assistsAvg: avg(rested, 'assists')
    },
    home: {
      games: home.length,
      pointsAvg: avg(home, 'points'),
      reboundsAvg: avg(home, 'rebounds'),
      assistsAvg: avg(home, 'assists')
    },
    away: {
      games: away.length,
      pointsAvg: avg(away, 'points'),
      reboundsAvg: avg(away, 'rebounds'),
      assistsAvg: avg(away, 'assists')
    }
  };
}

/**
 * Real schedule context for a team on/around a given date: are they on
 * a back-to-back, how many rest days, home or away. Used to know which
 * side of a player's split actually applies to today's game.
 */
function getTeamScheduleContext(sport, team, gameId) {
  const row = db.prepare(`
    SELECT opponent, game_date, is_home, rest_days, is_back_to_back
    FROM team_schedule WHERE sport = ? AND team = ? AND game_id = ?
  `).get(sport, team, gameId);
  return row || null;
}

module.exports = { getPlayerSituationalSplits, getTeamScheduleContext };
