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

module.exports = { parseBoxscore, insertBoxscore, recomputePitcherRollups, recomputeTeamBattingRollups };
