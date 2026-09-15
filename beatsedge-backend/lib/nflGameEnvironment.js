// NFL Game Environment -- real, but limited. See lib/gameEnvironment.js's
// header for the full audit: nfl_player_game_stats' pass_attempts/
// rush_attempts columns are only populated for season 2025 onward (0 of
// 5,489/5,537/5,480 rows for 2022/2023/2024 have any pass_attempts>0, vs
// 570/570 team-weeks fully covered for season 2025 and 30/30 so far for
// 2026 -- confirmed by direct query). game_date is NULL on every row, so
// ordering uses (season, week) instead of a real date.
//
// This is enough for a real, leak-safe LIVE computation (strictly prior
// weeks only, within season 2025+) but NOT enough for a robust train/
// holdout backtest -- one real season has no room for a genuine temporal
// split. See scripts/backtest-game-environment.js's NFL section, which
// reports this as INSUFFICIENT EVIDENCE rather than forcing a split.

// A team's own trailing play volume / pass-rush split, from real
// team-weeks strictly before (season, week). "Strictly before" = an
// earlier season, or the same season at an earlier week -- the entire
// leakage defense for this module.
function computeTeamPlayVolumeAsOf(db, team, season, week, { games = 5, minGames = 2 } = {}) {
  const rows = db.prepare(`
    SELECT season, week, SUM(pass_attempts) passAtt, SUM(rush_attempts) rushAtt
    FROM nfl_player_game_stats
    WHERE team = ? AND (season < ? OR (season = ? AND week < ?))
    GROUP BY season, week
    ORDER BY season DESC, week DESC
    LIMIT ?
  `).all(team, season, season, week, games);

  // Only count a team-week as real evidence if it actually has non-zero
  // play data -- rows from seasons 2022-2024 exist but carry zeros for
  // these columns (unpopulated, not a real 0-play game), so they must
  // never be silently counted as "the team ran 0 plays that week."
  const real = rows.filter(r => (r.passAtt || 0) + (r.rushAtt || 0) > 0);
  if (real.length < minGames) {
    return { games: real.length, sufficient: false, playVolume: null, passRate: null, rushRate: null };
  }
  const totalPass = real.reduce((s, r) => s + (r.passAtt || 0), 0);
  const totalRush = real.reduce((s, r) => s + (r.rushAtt || 0), 0);
  const totalPlays = totalPass + totalRush;
  return {
    games: real.length, sufficient: true,
    playVolume: Math.round((totalPlays / real.length) * 10) / 10,
    passRate: totalPlays ? Math.round((totalPass / totalPlays) * 1000) / 1000 : null,
    rushRate: totalPlays ? Math.round((totalRush / totalPlays) * 1000) / 1000 : null
  };
}

function buildNflGameEnvironmentSignal({ db, team, opponent, season, week, games = 5 }) {
  const empty = {
    teamPlayVolume: null, teamPassRate: null, teamRushRate: null,
    opponentPlayVolume: null, opponentPassRate: null, opponentRushRate: null,
    expectedPlayVolume: null,
    sampleSize: { team: 0, opponent: 0 },
    dataSource: 'nfl_player_game_stats (real pass_attempts/rush_attempts, season 2025+ only -- 2022-2024 rows carry unpopulated zeros; game_date unavailable, ordered by season/week)'
  };
  if (!db || !team || !opponent || season == null || week == null) return empty;

  const teamEnv = computeTeamPlayVolumeAsOf(db, team, season, week, { games });
  const oppEnv = computeTeamPlayVolumeAsOf(db, opponent, season, week, { games });

  const out = {
    ...empty,
    teamPlayVolume: teamEnv.playVolume, teamPassRate: teamEnv.passRate, teamRushRate: teamEnv.rushRate,
    opponentPlayVolume: oppEnv.playVolume, opponentPassRate: oppEnv.passRate, opponentRushRate: oppEnv.rushRate,
    sampleSize: { team: teamEnv.games, opponent: oppEnv.games }
  };
  if (!teamEnv.sufficient || !oppEnv.sufficient) return out;

  out.expectedPlayVolume = Math.round(((teamEnv.playVolume + oppEnv.playVolume) / 2) * 10) / 10;
  return out;
}

module.exports = { computeTeamPlayVolumeAsOf, buildNflGameEnvironmentSignal };
