// Parses a real api-web.nhle.com boxscore into rows, and computes both
// rollups NHL needs: defense-vs-position for skaters (real, since NHL
// boxscores already split forwards/defense), and team shooting profile
// for goalie props (the real matchup context there — see lib/nhlDb.js).

const db = require('./nhlDb');

function normalizePosition(rawPos) {
  if (rawPos === 'D') return 'D';
  if (rawPos === 'C' || rawPos === 'L' || rawPos === 'R') return 'F';
  return null; // unknown — skip rather than guess
}

function parseBoxscore(boxscore, gameDate, gameId) {
  const skaterRows = [];
  const goalieRows = [];
  const sides = ['awayTeam', 'homeTeam'];
  const teamAbbrev = {
    awayTeam: boxscore.awayTeam.abbrev,
    homeTeam: boxscore.homeTeam.abbrev
  };

  sides.forEach(side => {
    const opponentSide = side === 'awayTeam' ? 'homeTeam' : 'awayTeam';
    const team = teamAbbrev[side];
    const opponent = teamAbbrev[opponentSide];
    const stats = boxscore.playerByGameStats && boxscore.playerByGameStats[side];
    if (!stats) return;

    ['forwards', 'defense'].forEach(group => {
      (stats[group] || []).forEach(p => {
        const position = normalizePosition(p.position);
        if (!position) return;
        skaterRows.push({
          game_date: gameDate, game_id: String(gameId),
          player_id: String(p.playerId), player_name: p.name.default,
          position, team, opponent,
          goals: p.goals || 0, assists: p.assists || 0, points: p.points || 0,
          shots_on_goal: p.sog || 0, hits: p.hits || 0, blocked_shots: p.blockedShots || 0
        });
      });
    });

    (stats.goalies || []).forEach(g => {
      // Only credit goalies who actually played (some backups show 0:00 TOI)
      if (!g.shotsAgainst || g.shotsAgainst === 0) return;
      goalieRows.push({
        game_date: gameDate, game_id: String(gameId),
        player_id: String(g.playerId), player_name: g.name.default,
        team, opponent,
        shots_against: g.shotsAgainst || 0, saves: g.saves || 0,
        goals_against: g.goalsAgainst || 0, save_pct: g.savePctg || null,
        is_starter: g.starter ? 1 : 0
      });
    });
  });

  return { skaterRows, goalieRows };
}

function insertBoxscore(boxscore, gameDate, gameId) {
  const { skaterRows, goalieRows } = parseBoxscore(boxscore, gameDate, gameId);

  const insertSkater = db.prepare(`
    INSERT OR IGNORE INTO nhl_skater_game_stats
      (game_date, game_id, player_id, player_name, position, team, opponent, goals, assists, points, shots_on_goal, hits, blocked_shots, source)
    VALUES (@game_date, @game_id, @player_id, @player_name, @position, @team, @opponent, @goals, @assists, @points, @shots_on_goal, @hits, @blocked_shots, 'nhle-live')
  `);
  const insertGoalie = db.prepare(`
    INSERT OR IGNORE INTO nhl_goalie_game_stats
      (game_date, game_id, player_id, player_name, team, opponent, shots_against, saves, goals_against, save_pct, is_starter, source)
    VALUES (@game_date, @game_id, @player_id, @player_name, @team, @opponent, @shots_against, @saves, @goals_against, @save_pct, @is_starter, 'nhle-live')
  `);

  const tx = db.transaction(() => {
    skaterRows.forEach(r => insertSkater.run(r));
    goalieRows.forEach(r => insertGoalie.run(r));
  });
  tx();

  return { skaterRows: skaterRows.length, goalieRows: goalieRows.length };
}

function recomputeDefenseByPosition() {
  const teams = db.prepare(`SELECT DISTINCT opponent AS team FROM nhl_skater_game_stats`).all();
  const upsert = db.prepare(`
    INSERT INTO nhl_defense_by_position (team, position, window_type, goals_allowed, assists_allowed, points_allowed, shots_allowed, rank, games_sampled, updated_at)
    VALUES (@team, @position, @window_type, @goals_allowed, @assists_allowed, @points_allowed, @shots_allowed, @rank, @games_sampled, datetime('now'))
    ON CONFLICT(team, position, window_type) DO UPDATE SET
      goals_allowed=excluded.goals_allowed, assists_allowed=excluded.assists_allowed,
      points_allowed=excluded.points_allowed, shots_allowed=excluded.shots_allowed,
      rank=excluded.rank, games_sampled=excluded.games_sampled, updated_at=datetime('now')
  `);

  const windows = [{ type: 'season', limit: null }, { type: 'last10', limit: 10 }, { type: 'last5', limit: 5 }];
  const results = {};

  windows.forEach(({ type, limit }) => {
    ['F', 'D'].forEach(position => {
      const rows = teams.map(({ team }) => {
        const games = limit
          ? db.prepare(`SELECT goals, assists, points, shots_on_goal FROM nhl_skater_game_stats WHERE opponent = ? AND position = ? ORDER BY game_date DESC LIMIT ?`).all(team, position, limit)
          : db.prepare(`SELECT goals, assists, points, shots_on_goal FROM nhl_skater_game_stats WHERE opponent = ? AND position = ? ORDER BY game_date DESC`).all(team, position);
        if (games.length === 0) return null;
        const avg = (key) => games.reduce((s, g) => s + g[key], 0) / games.length;
        return {
          team,
          goals_allowed: Math.round(avg('goals') * 100) / 100,
          assists_allowed: Math.round(avg('assists') * 100) / 100,
          points_allowed: Math.round(avg('points') * 100) / 100,
          shots_allowed: Math.round(avg('shots_on_goal') * 10) / 10,
          games_sampled: games.length
        };
      }).filter(Boolean);

      const sorted = [...rows].sort((a, b) => a.points_allowed - b.points_allowed);
      sorted.forEach((r, i) => { r.rank = i + 1; });

      rows.forEach(r => upsert.run({ ...r, position, window_type: type }));
      results[`${position}:${type}`] = rows.length;
    });
  });

  return results;
}

function getDefenseByPosition(team, windowType = 'season') {
  const rows = db.prepare(`
    SELECT position, goals_allowed, assists_allowed, points_allowed, shots_allowed, rank, games_sampled
    FROM nhl_defense_by_position WHERE team = ? AND window_type = ?
  `).all(team, windowType);
  const byPosition = {};
  rows.forEach(r => {
    byPosition[r.position] = {
      goalsAllowed: r.goals_allowed, assistsAllowed: r.assists_allowed,
      pointsAllowed: r.points_allowed, shotsAllowed: r.shots_allowed,
      rank: r.rank, gamesSampled: r.games_sampled
    };
  });
  return byPosition;
}

function recomputeTeamShootingRollup() {
  // Shots/goals a team GENERATES (their own game rows as 'team', not 'opponent') —
  // this is what a goalie is actually facing when playing against them.
  const teams = db.prepare(`SELECT DISTINCT team FROM nhl_skater_game_stats`).all();
  const upsert = db.prepare(`
    INSERT INTO nhl_team_shooting_rollup (team, window_type, shots_per_game, goals_per_game, shooting_pct, rank, games_sampled, updated_at)
    VALUES (@team, @window_type, @shots_per_game, @goals_per_game, @shooting_pct, @rank, @games_sampled, datetime('now'))
    ON CONFLICT(team, window_type) DO UPDATE SET
      shots_per_game=excluded.shots_per_game, goals_per_game=excluded.goals_per_game,
      shooting_pct=excluded.shooting_pct, rank=excluded.rank, games_sampled=excluded.games_sampled, updated_at=datetime('now')
  `);

  [{ type: 'season', limit: null }, { type: 'last10', limit: null }].forEach(({ type }) => {
    // (last10 uses game-level grouping below regardless of the placeholder limit above)
    const rows = teams.map(({ team }) => {
      const games = db.prepare(`
        SELECT game_id, SUM(shots_on_goal) as shots, SUM(goals) as goals
        FROM nhl_skater_game_stats WHERE team = ? GROUP BY game_id ORDER BY game_id DESC ${type === 'last10' ? 'LIMIT 10' : ''}
      `).all(team);
      if (games.length === 0) return null;
      const totalShots = games.reduce((s, g) => s + g.shots, 0);
      const totalGoals = games.reduce((s, g) => s + g.goals, 0);
      return {
        team,
        shots_per_game: Math.round((totalShots / games.length) * 10) / 10,
        goals_per_game: Math.round((totalGoals / games.length) * 10) / 10,
        shooting_pct: totalShots > 0 ? Math.round((totalGoals / totalShots) * 1000) / 1000 : null,
        games_sampled: games.length
      };
    }).filter(Boolean);

    const sorted = [...rows].sort((a, b) => b.shots_per_game - a.shots_per_game);
    sorted.forEach((r, i) => { r.rank = i + 1; });

    rows.forEach(r => upsert.run({ ...r, window_type: type }));
  });

  return teams.length;
}

module.exports = { parseBoxscore, insertBoxscore, recomputeDefenseByPosition, getDefenseByPosition, recomputeTeamShootingRollup };
