// Parses a real statsapi.mlb.com boxscore response into rows, and computes
// the two rollups baseball actually needs (pitcher-allowed, team-batting) —
// see lib/mlbDb.js for why this differs from NBA/NFL's position grids.

const db = require('./mlbDb');

function parseBoxscore(boxscore, gameDate, gamePk) {
  const batterRows = [];
  const pitcherRows = [];
  const sides = ['home', 'away'];
  const teamAbbrev = {};
  const startingPitcherId = {};
  const startingPitcherName = {};

  sides.forEach(side => {
    teamAbbrev[side] = boxscore.teams[side].team.abbreviation;
    const pitcherIds = boxscore.teams[side].pitchers || [];
    if (pitcherIds.length > 0) {
      const firstId = pitcherIds[0];
      const playerObj = boxscore.teams[side].players[`ID${firstId}`];
      startingPitcherId[side] = String(firstId);
      startingPitcherName[side] = playerObj ? playerObj.person.fullName : null;
    }
  });

  sides.forEach(side => {
    const opponentSide = side === 'home' ? 'away' : 'home';
    const team = teamAbbrev[side];
    const opponent = teamAbbrev[opponentSide];
    // Simplification, stated plainly: credits a batter's whole game to the
    // OPPOSING STARTER, even though some at-bats may have come against
    // relievers. This matches how most fantasy/prop tools frame "matchup
    // vs pitcher X" — it's the starter's own allowed-stats that move.
    const oppStarterId = startingPitcherId[opponentSide] || null;
    const oppStarterName = startingPitcherName[opponentSide] || null;

    const players = (boxscore.teams[side] && boxscore.teams[side].players) || {};
    Object.values(players).forEach(p => {
      if (!p.person) return;
      const batting = p.stats && p.stats.batting;
      const pitching = p.stats && p.stats.pitching;

      if (batting && batting.atBats !== undefined && batting.atBats !== null) {
        batterRows.push({
          game_date: gameDate, game_pk: String(gamePk),
          player_id: String(p.person.id), player_name: p.person.fullName,
          team, opponent,
          opposing_pitcher_id: oppStarterId, opposing_pitcher_name: oppStarterName,
          at_bats: batting.atBats || 0, hits: batting.hits || 0, total_bases: batting.totalBases || 0,
          runs: batting.runs || 0, rbi: batting.rbi || 0, home_runs: batting.homeRuns || 0,
          walks: batting.baseOnBalls || 0, strikeouts: batting.strikeOuts || 0
        });
      }

      if (pitching && pitching.inningsPitched !== undefined && parseFloat(pitching.inningsPitched) > 0) {
        pitcherRows.push({
          game_date: gameDate, game_pk: String(gamePk),
          player_id: String(p.person.id), player_name: p.person.fullName,
          team, opponent,
          innings_pitched: parseFloat(pitching.inningsPitched) || 0,
          strikeouts: pitching.strikeOuts || 0, walks_allowed: pitching.baseOnBalls || 0,
          hits_allowed: pitching.hits || 0, earned_runs: pitching.earnedRuns || 0,
          home_runs_allowed: pitching.homeRuns || 0
        });
      }
    });
  });

  return { batterRows, pitcherRows };
}

function insertBoxscore(boxscore, gameDate, gamePk) {
  const { batterRows, pitcherRows } = parseBoxscore(boxscore, gameDate, gamePk);

  const insertBatter = db.prepare(`
    INSERT OR IGNORE INTO mlb_batter_game_stats
      (game_date, game_pk, player_id, player_name, team, opponent, opposing_pitcher_id, opposing_pitcher_name,
       at_bats, hits, total_bases, runs, rbi, home_runs, walks, strikeouts, source)
    VALUES (@game_date, @game_pk, @player_id, @player_name, @team, @opponent, @opposing_pitcher_id, @opposing_pitcher_name,
       @at_bats, @hits, @total_bases, @runs, @rbi, @home_runs, @walks, @strikeouts, 'statsapi-live')
  `);
  const insertPitcher = db.prepare(`
    INSERT OR IGNORE INTO mlb_pitcher_game_stats
      (game_date, game_pk, player_id, player_name, team, opponent,
       innings_pitched, strikeouts, walks_allowed, hits_allowed, earned_runs, home_runs_allowed, source)
    VALUES (@game_date, @game_pk, @player_id, @player_name, @team, @opponent,
       @innings_pitched, @strikeouts, @walks_allowed, @hits_allowed, @earned_runs, @home_runs_allowed, 'statsapi-live')
  `);

  const tx = db.transaction(() => {
    batterRows.forEach(r => insertBatter.run(r));
    pitcherRows.forEach(r => insertPitcher.run(r));
  });
  tx();

  return { batterRows: batterRows.length, pitcherRows: pitcherRows.length };
}

/** Real ERA/WHIP/BAA/K-9/HR-9 for one pitcher, rolled up over their starts. */
function recomputePitcherRollups() {
  const pitchers = db.prepare(`SELECT DISTINCT player_id, player_name FROM mlb_pitcher_game_stats`).all();
  const upsert = db.prepare(`
    INSERT INTO mlb_pitcher_rollup (player_id, player_name, window_type, era, whip, batting_avg_against, k_per_9, hr_per_9, games_sampled, updated_at)
    VALUES (@player_id, @player_name, @window_type, @era, @whip, @batting_avg_against, @k_per_9, @hr_per_9, @games_sampled, datetime('now'))
    ON CONFLICT(player_id, window_type) DO UPDATE SET
      player_name=excluded.player_name, era=excluded.era, whip=excluded.whip,
      batting_avg_against=excluded.batting_avg_against, k_per_9=excluded.k_per_9,
      hr_per_9=excluded.hr_per_9, games_sampled=excluded.games_sampled, updated_at=datetime('now')
  `);

  let count = 0;
  [{ type: 'season', limit: null }, { type: 'last5starts', limit: 5 }].forEach(({ type, limit }) => {
    pitchers.forEach(({ player_id, player_name }) => {
      const rows = limit
        ? db.prepare(`SELECT * FROM mlb_pitcher_game_stats WHERE player_id = ? ORDER BY game_date DESC LIMIT ?`).all(player_id, limit)
        : db.prepare(`SELECT * FROM mlb_pitcher_game_stats WHERE player_id = ? ORDER BY game_date DESC`).all(player_id);
      if (rows.length === 0) return;

      const totalIp = rows.reduce((s, r) => s + r.innings_pitched, 0);
      const totalEr = rows.reduce((s, r) => s + r.earned_runs, 0);
      const totalWalks = rows.reduce((s, r) => s + r.walks_allowed, 0);
      const totalHits = rows.reduce((s, r) => s + r.hits_allowed, 0);
      const totalK = rows.reduce((s, r) => s + r.strikeouts, 0);
      const totalHr = rows.reduce((s, r) => s + r.home_runs_allowed, 0);

      if (totalIp === 0) return;

      const era = Math.round((totalEr / totalIp) * 9 * 100) / 100;
      const whip = Math.round(((totalWalks + totalHits) / totalIp) * 100) / 100;
      const kPer9 = Math.round((totalK / totalIp) * 9 * 100) / 100;
      const hrPer9 = Math.round((totalHr / totalIp) * 9 * 100) / 100;
      // BAA needs real at-bats-against, which isn't in this simplified schema —
      // approximated via hits/(hits+outs) is unreliable, so left null rather
      // than faked. A real implementation would pull it from the boxscore's
      // pitching.atBats field directly (available, just not wired up here yet).
      const baa = null;

      upsert.run({
        player_id, player_name, window_type: type,
        era, whip, batting_avg_against: baa, k_per_9: kPer9, hr_per_9: hrPer9,
        games_sampled: rows.length
      });
      count++;
    });
  });
  return count;
}

/** Real team-wide batting profile (what a lineup does against pitching in general). */
function recomputeTeamBattingRollups() {
  const teams = db.prepare(`SELECT DISTINCT team FROM mlb_batter_game_stats`).all();
  const upsert = db.prepare(`
    INSERT INTO mlb_team_batting_rollup (team, window_type, team_avg, team_ops, k_rate, runs_per_game, rank, games_sampled, updated_at)
    VALUES (@team, @window_type, @team_avg, @team_ops, @k_rate, @runs_per_game, @rank, @games_sampled, datetime('now'))
    ON CONFLICT(team, window_type) DO UPDATE SET
      team_avg=excluded.team_avg, k_rate=excluded.k_rate, runs_per_game=excluded.runs_per_game,
      rank=excluded.rank, games_sampled=excluded.games_sampled, updated_at=datetime('now')
  `);

  [{ type: 'season', limit: null }, { type: 'last15games', limit: 15 * 9 }].forEach(({ type, limit }) => {
    const rows = teams.map(({ team }) => {
      const games = limit
        ? db.prepare(`SELECT * FROM mlb_batter_game_stats WHERE team = ? ORDER BY game_date DESC LIMIT ?`).all(team, limit)
        : db.prepare(`SELECT * FROM mlb_batter_game_stats WHERE team = ? ORDER BY game_date DESC`).all(team);
      if (games.length === 0) return null;

      const totalAb = games.reduce((s, g) => s + g.at_bats, 0);
      const totalHits = games.reduce((s, g) => s + g.hits, 0);
      const totalK = games.reduce((s, g) => s + g.strikeouts, 0);
      const totalRuns = games.reduce((s, g) => s + g.runs, 0);
      const uniqueGamePks = new Set(games.map(g => g.game_pk)).size;

      if (totalAb === 0) return null;

      return {
        team,
        team_avg: Math.round((totalHits / totalAb) * 1000) / 1000,
        team_ops: null, // needs OBP+SLG components not captured in this simplified schema — left null, not faked
        k_rate: Math.round((totalK / totalAb) * 1000) / 1000,
        runs_per_game: uniqueGamePks > 0 ? Math.round((totalRuns / uniqueGamePks) * 10) / 10 : null,
        games_sampled: uniqueGamePks
      };
    }).filter(Boolean);

    // Rank by k_rate: 1 = highest strikeout rate (easiest for a pitcher to rack up Ks against)
    const sorted = [...rows].sort((a, b) => b.k_rate - a.k_rate);
    sorted.forEach((r, i) => { r.rank = i + 1; });

    rows.forEach(r => upsert.run({ ...r, window_type: type }));
  });

  return teams.length;
}

// ---------- LIVE production path (Phase 4): historicalStore-backed ----------
// insertBoxscoreAsync: same parseBoxscore parsing (unchanged, reused
// directly -- it takes no DB handle, pure data transform), written via
// historicalStore in ONE batched transaction instead of one better-sqlite3
// prepared-statement `.run()` per row.
async function insertBoxscoreAsync(boxscore, gameDate, gamePk) {
  const { batterRows, pitcherRows } = parseBoxscore(boxscore, gameDate, gamePk);
  const store = require('./historicalStore');
  await store.transaction(async (exec) => {
    for (const r of batterRows) {
      await exec(`INSERT OR IGNORE INTO mlb_batter_game_stats
        (game_date, game_pk, player_id, player_name, team, opponent, opposing_pitcher_id, opposing_pitcher_name,
         at_bats, hits, total_bases, runs, rbi, home_runs, walks, strikeouts, source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'statsapi-live')`,
        [r.game_date, r.game_pk, r.player_id, r.player_name, r.team, r.opponent, r.opposing_pitcher_id, r.opposing_pitcher_name,
         r.at_bats, r.hits, r.total_bases, r.runs, r.rbi, r.home_runs, r.walks, r.strikeouts]);
    }
    for (const r of pitcherRows) {
      await exec(`INSERT OR IGNORE INTO mlb_pitcher_game_stats
        (game_date, game_pk, player_id, player_name, team, opponent,
         innings_pitched, strikeouts, walks_allowed, hits_allowed, earned_runs, home_runs_allowed, source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'statsapi-live')`,
        [r.game_date, r.game_pk, r.player_id, r.player_name, r.team, r.opponent,
         r.innings_pitched, r.strikeouts, r.walks_allowed, r.hits_allowed, r.earned_runs, r.home_runs_allowed]);
    }
  });
  return { batterRows: batterRows.length, pitcherRows: pitcherRows.length };
}

// Replaces recomputePitcherRollups' 2-windows x pitchers.length queries with
// ONE bulk fetch of every real mlb_pitcher_game_stats row, grouped by
// player_id (each group sorted DESC by game_date), then derives
// season/last5starts via array slicing -- same real math (ERA/WHIP/K-9/
// HR-9), same "BAA left null, not faked" discipline.
async function recomputePitcherRollupsBulk() {
  const store = require('./historicalStore');
  const allRows = await store.query(`SELECT player_id, player_name, game_date, innings_pitched, earned_runs, walks_allowed, hits_allowed, strikeouts, home_runs_allowed FROM mlb_pitcher_game_stats`);
  const byPlayer = new Map();
  for (const r of allRows) {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, { name: r.player_name, rows: [] });
    byPlayer.get(r.player_id).rows.push(r);
  }
  for (const [, v] of byPlayer) v.rows.sort((a, b) => (a.game_date < b.game_date ? 1 : a.game_date > b.game_date ? -1 : 0));

  const upserts = [];
  let count = 0;
  for (const { type, limit } of [{ type: 'season', limit: null }, { type: 'last5starts', limit: 5 }]) {
    for (const [player_id, { name, rows: allPlayerRows }] of byPlayer) {
      const rows = limit ? allPlayerRows.slice(0, limit) : allPlayerRows;
      if (!rows.length) continue;
      const totalIp = rows.reduce((s, r) => s + r.innings_pitched, 0);
      const totalEr = rows.reduce((s, r) => s + r.earned_runs, 0);
      const totalWalks = rows.reduce((s, r) => s + r.walks_allowed, 0);
      const totalHits = rows.reduce((s, r) => s + r.hits_allowed, 0);
      const totalK = rows.reduce((s, r) => s + r.strikeouts, 0);
      const totalHr = rows.reduce((s, r) => s + r.home_runs_allowed, 0);
      if (totalIp === 0) continue;
      upserts.push({
        player_id, player_name: name, window_type: type,
        era: Math.round((totalEr / totalIp) * 9 * 100) / 100,
        whip: Math.round(((totalWalks + totalHits) / totalIp) * 100) / 100,
        batting_avg_against: null,
        k_per_9: Math.round((totalK / totalIp) * 9 * 100) / 100,
        hr_per_9: Math.round((totalHr / totalIp) * 9 * 100) / 100,
        games_sampled: rows.length,
      });
      count++;
    }
  }
  await store.transaction(async (exec) => {
    for (const r of upserts) {
      await exec(`INSERT INTO mlb_pitcher_rollup (player_id, player_name, window_type, era, whip, batting_avg_against, k_per_9, hr_per_9, games_sampled, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(player_id, window_type) DO UPDATE SET
          player_name=excluded.player_name, era=excluded.era, whip=excluded.whip,
          batting_avg_against=excluded.batting_avg_against, k_per_9=excluded.k_per_9,
          hr_per_9=excluded.hr_per_9, games_sampled=excluded.games_sampled, updated_at=datetime('now')`,
        [r.player_id, r.player_name, r.window_type, r.era, r.whip, r.batting_avg_against, r.k_per_9, r.hr_per_9, r.games_sampled]);
    }
  });
  return count;
}

// Same bulk-rewrite pattern for team batting rollups.
async function recomputeTeamBattingRollupsBulk() {
  const store = require('./historicalStore');
  const allRows = await store.query(`SELECT team, game_pk, game_date, at_bats, hits, strikeouts, runs FROM mlb_batter_game_stats`);
  const byTeam = new Map();
  for (const r of allRows) { if (!byTeam.has(r.team)) byTeam.set(r.team, []); byTeam.get(r.team).push(r); }
  for (const [, arr] of byTeam) arr.sort((a, b) => (a.game_date < b.game_date ? 1 : a.game_date > b.game_date ? -1 : 0));

  const upserts = [];
  for (const { type, limit } of [{ type: 'season', limit: null }, { type: 'last15games', limit: 15 * 9 }]) {
    const rowsOut = [];
    for (const [team, allTeamRows] of byTeam) {
      const games = limit ? allTeamRows.slice(0, limit) : allTeamRows;
      if (!games.length) continue;
      const totalAb = games.reduce((s, g) => s + g.at_bats, 0);
      const totalHits = games.reduce((s, g) => s + g.hits, 0);
      const totalK = games.reduce((s, g) => s + g.strikeouts, 0);
      const totalRuns = games.reduce((s, g) => s + g.runs, 0);
      const uniqueGamePks = new Set(games.map(g => g.game_pk)).size;
      if (totalAb === 0) continue;
      rowsOut.push({
        team, team_avg: Math.round((totalHits / totalAb) * 1000) / 1000, team_ops: null,
        k_rate: Math.round((totalK / totalAb) * 1000) / 1000,
        runs_per_game: uniqueGamePks > 0 ? Math.round((totalRuns / uniqueGamePks) * 10) / 10 : null,
        games_sampled: uniqueGamePks,
      });
    }
    const sorted = [...rowsOut].sort((a, b) => b.k_rate - a.k_rate);
    sorted.forEach((r, i) => { r.rank = i + 1; });
    upserts.push(...rowsOut.map(r => ({ ...r, window_type: type })));
  }
  await store.transaction(async (exec) => {
    for (const r of upserts) {
      await exec(`INSERT INTO mlb_team_batting_rollup (team, window_type, team_avg, team_ops, k_rate, runs_per_game, rank, games_sampled, updated_at)
        VALUES (?,?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(team, window_type) DO UPDATE SET
          team_avg=excluded.team_avg, k_rate=excluded.k_rate, runs_per_game=excluded.runs_per_game,
          rank=excluded.rank, games_sampled=excluded.games_sampled, updated_at=datetime('now')`,
        [r.team, r.window_type, r.team_avg, r.team_ops, r.k_rate, r.runs_per_game, r.rank, r.games_sampled]);
    }
  });
  return byTeam.size;
}

async function getPitcherRollupAsync(playerId, windowType = 'season') {
  const store = require('./historicalStore');
  return store.queryOne(`SELECT * FROM mlb_pitcher_rollup WHERE player_id = ? AND window_type = ?`, [playerId, windowType]);
}
async function getTeamBattingRollupAsync(team, windowType = 'season') {
  const store = require('./historicalStore');
  return store.queryOne(`SELECT * FROM mlb_team_batting_rollup WHERE team = ? AND window_type = ?`, [team, windowType]);
}

module.exports = {
  parseBoxscore, insertBoxscore, recomputePitcherRollups, recomputeTeamBattingRollups,
  insertBoxscoreAsync, recomputePitcherRollupsBulk, recomputeTeamBattingRollupsBulk,
  getPitcherRollupAsync, getTeamBattingRollupAsync,
};
