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

// ---------- LIVE production path (Phase 4): historicalStore-backed reads ----------
// NHL has real, if small (540 local skater rows), data and IS an active
// product path -- BeatsEdge.html's opponent-context panel calls both these
// routes for sport==='nhl'. No new NHL modeling; these are simple 1-query
// reads (no N+1 to fix), just moved off the legacy sync nhlDb handle.
async function getDefenseByPositionAsync(team, windowType = 'season') {
  const store = require('./historicalStore');
  const rows = await store.query(`
    SELECT position, goals_allowed, assists_allowed, points_allowed, shots_allowed, rank, games_sampled
    FROM nhl_defense_by_position WHERE team = ? AND window_type = ?
  `, [team, windowType]);
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
async function getTeamShootingRollupAsync(team, windowType = 'season') {
  const store = require('./historicalStore');
  return store.queryOne(`SELECT * FROM nhl_team_shooting_rollup WHERE team = ? AND window_type = ?`, [team, windowType]);
}

// ---------- LIVE production path (Phase 5): historicalStore-backed writes ----------
// Mechanical conversion only -- same math/output as the legacy sync
// functions above, restructured for bulk access the same way NBA DvP/MLB
// rollups were in Phase 4 (ONE bulk fetch instead of one query per team/
// window, ONE batched write instead of one .run() per row). No NHL
// calculation, threshold, or output shape changed.
async function insertBoxscoreAsync(boxscore, gameDate, gameId) {
  const { skaterRows, goalieRows } = parseBoxscore(boxscore, gameDate, gameId);
  const store = require('./historicalStore');
  await store.transaction(async (exec) => {
    for (const r of skaterRows) {
      await exec(`INSERT OR IGNORE INTO nhl_skater_game_stats
        (game_date, game_id, player_id, player_name, position, team, opponent, goals, assists, points, shots_on_goal, hits, blocked_shots, source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'nhle-live')`,
        [r.game_date, r.game_id, r.player_id, r.player_name, r.position, r.team, r.opponent, r.goals, r.assists, r.points, r.shots_on_goal, r.hits, r.blocked_shots]);
    }
    for (const r of goalieRows) {
      await exec(`INSERT OR IGNORE INTO nhl_goalie_game_stats
        (game_date, game_id, player_id, player_name, team, opponent, shots_against, saves, goals_against, save_pct, is_starter, source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'nhle-live')`,
        [r.game_date, r.game_id, r.player_id, r.player_name, r.team, r.opponent, r.shots_against, r.saves, r.goals_against, r.save_pct, r.is_starter]);
    }
  });
  return { skaterRows: skaterRows.length, goalieRows: goalieRows.length };
}

async function recomputeDefenseByPositionBulk() {
  const store = require('./historicalStore');
  const allRows = await store.query(`SELECT opponent, position, game_date, goals, assists, points, shots_on_goal FROM nhl_skater_game_stats`);
  const byTeamPos = new Map();
  for (const r of allRows) {
    const key = `${r.opponent}|${r.position}`;
    if (!byTeamPos.has(key)) byTeamPos.set(key, []);
    byTeamPos.get(key).push(r);
  }
  for (const [, arr] of byTeamPos) arr.sort((a, b) => (a.game_date < b.game_date ? 1 : a.game_date > b.game_date ? -1 : 0));
  const teams = [...new Set(allRows.map(r => r.opponent))];

  const windows = [{ type: 'season', limit: null }, { type: 'last10', limit: 10 }, { type: 'last5', limit: 5 }];
  const upserts = [];
  const results = {};
  for (const { type, limit } of windows) {
    for (const position of ['F', 'D']) {
      const rowsOut = [];
      for (const team of teams) {
        const all = byTeamPos.get(`${team}|${position}`);
        if (!all || !all.length) continue;
        const games = limit ? all.slice(0, limit) : all;
        const avg = key => games.reduce((s, g) => s + g[key], 0) / games.length;
        rowsOut.push({ team, goals_allowed: Math.round(avg('goals') * 100) / 100, assists_allowed: Math.round(avg('assists') * 100) / 100, points_allowed: Math.round(avg('points') * 100) / 100, shots_allowed: Math.round(avg('shots_on_goal') * 10) / 10, games_sampled: games.length });
      }
      const sorted = [...rowsOut].sort((a, b) => a.points_allowed - b.points_allowed);
      sorted.forEach((r, i) => { r.rank = i + 1; });
      upserts.push(...rowsOut.map(r => ({ ...r, position, window_type: type })));
      results[`${position}:${type}`] = rowsOut.length;
    }
  }
  await store.transaction(async (exec) => {
    for (const r of upserts) {
      await exec(`INSERT INTO nhl_defense_by_position (team, position, window_type, goals_allowed, assists_allowed, points_allowed, shots_allowed, rank, games_sampled, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(team, position, window_type) DO UPDATE SET
          goals_allowed=excluded.goals_allowed, assists_allowed=excluded.assists_allowed,
          points_allowed=excluded.points_allowed, shots_allowed=excluded.shots_allowed,
          rank=excluded.rank, games_sampled=excluded.games_sampled, updated_at=datetime('now')`,
        [r.team, r.position, r.window_type, r.goals_allowed, r.assists_allowed, r.points_allowed, r.shots_allowed, r.rank, r.games_sampled]);
    }
  });
  return results;
}

async function recomputeTeamShootingRollupBulk() {
  const store = require('./historicalStore');
  const allRows = await store.query(`SELECT team, game_id, shots_on_goal, goals FROM nhl_skater_game_stats`);
  const byTeamGame = new Map(); // team -> Map(game_id -> {shots, goals})
  for (const r of allRows) {
    if (!byTeamGame.has(r.team)) byTeamGame.set(r.team, new Map());
    const g = byTeamGame.get(r.team);
    if (!g.has(r.game_id)) g.set(r.game_id, { game_id: r.game_id, shots: 0, goals: 0 });
    const rec = g.get(r.game_id);
    rec.shots += r.shots_on_goal || 0;
    rec.goals += r.goals || 0;
  }
  const teams = [...byTeamGame.keys()];
  const upserts = [];
  for (const { type } of [{ type: 'season' }, { type: 'last10' }]) {
    const rowsOut = [];
    for (const team of teams) {
      let games = [...byTeamGame.get(team).values()].sort((a, b) => (a.game_id < b.game_id ? 1 : a.game_id > b.game_id ? -1 : 0));
      if (type === 'last10') games = games.slice(0, 10);
      if (!games.length) continue;
      const totalShots = games.reduce((s, g) => s + g.shots, 0);
      const totalGoals = games.reduce((s, g) => s + g.goals, 0);
      rowsOut.push({ team, shots_per_game: Math.round((totalShots / games.length) * 10) / 10, goals_per_game: Math.round((totalGoals / games.length) * 10) / 10, shooting_pct: totalShots > 0 ? Math.round((totalGoals / totalShots) * 1000) / 1000 : null, games_sampled: games.length });
    }
    const sorted = [...rowsOut].sort((a, b) => b.shots_per_game - a.shots_per_game);
    sorted.forEach((r, i) => { r.rank = i + 1; });
    upserts.push(...rowsOut.map(r => ({ ...r, window_type: type })));
  }
  await store.transaction(async (exec) => {
    for (const r of upserts) {
      await exec(`INSERT INTO nhl_team_shooting_rollup (team, window_type, shots_per_game, goals_per_game, shooting_pct, rank, games_sampled, updated_at)
        VALUES (?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(team, window_type) DO UPDATE SET
          shots_per_game=excluded.shots_per_game, goals_per_game=excluded.goals_per_game,
          shooting_pct=excluded.shooting_pct, rank=excluded.rank, games_sampled=excluded.games_sampled, updated_at=datetime('now')`,
        [r.team, r.window_type, r.shots_per_game, r.goals_per_game, r.shooting_pct, r.rank, r.games_sampled]);
    }
  });
  return teams.length;
}

module.exports = {
  parseBoxscore, insertBoxscore, recomputeDefenseByPosition, getDefenseByPosition, recomputeTeamShootingRollup,
  getDefenseByPositionAsync, getTeamShootingRollupAsync,
  insertBoxscoreAsync, recomputeDefenseByPositionBulk, recomputeTeamShootingRollupBulk,
};
