// Sport/domain-level BULK read/write operations on top of
// lib/historicalStore.js, built specifically so a single production
// request or recompute job issues a SMALL, FIXED number of remote Turso
// queries -- never one query per player/team/position in a loop (the
// pattern audited in the caller-migration report as the highest
// performance risk: nflDvpEngine.js's recomputeNflDefenseByPosition alone
// issued ~640 individual queries per recompute; POST /nba/next-man-up and
// /nba/player-availability can fan out to 500+ per-player queries in one
// HTTP request).
//
// Every function here does exactly ONE bulk fetch (a single SELECT,
// optionally with a WHERE ... IN (...) list) and does all grouping/
// windowing/aggregation in application memory afterward -- matching
// exactly what the equivalent sync code already computed, just restructured
// so the network-round-trip count is O(1) instead of O(teams x positions x
// windows) or O(players).

const store = require('./historicalStore');

// ---------- generic bulk helpers ----------

// Chunks an IN (...) list to stay under SQLite's/Turso's parameter-count
// limits (SQLite's default is 999 bound parameters; Turso's Hrana protocol
// has its own practical limits) -- still O(1) round trips for any
// realistic caller (up to ~500 players fits in 1 chunk).
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
const IN_CHUNK_SIZE = 400;

async function bulkSelectIn(table, column, values, extraCols = '*', extraWhere = '') {
  if (!values.length) return [];
  let rows = [];
  for (const part of chunk([...new Set(values)], IN_CHUNK_SIZE)) {
    const placeholders = part.map(() => '?').join(',');
    const sql = `SELECT ${extraCols} FROM "${table}" WHERE ${column} IN (${placeholders})${extraWhere ? ' AND ' + extraWhere : ''}`;
    const r = await store.query(sql, part);
    // .concat, NOT push(...r) -- a large IN-chunk (e.g. 400 players' FULL
    // career histories) can return well over V8's ~65k-argument spread
    // limit in one result set ("Maximum call stack size exceeded"),
    // confirmed live in scripts/test-query-budget.js's 400-player NBA
    // case. concat has no such limit.
    rows = rows.concat(r);
  }
  return rows; // 1 query per 400-item chunk, NEVER 1 per value
}

// ---------- NBA / WNBA: bulk player game history ----------

// Replaces N calls to "get this one player's game log" with ONE query for
// however many playerIds are requested, then groups in memory. This is the
// function lib/opportunitySignal.js / lib/nextManUpSignal.js / live prop-
// card population should call instead of looping per player.
async function getPlayerGameHistories(sport, playerIds, { sinceDate = null, limit = null } = {}) {
  const isWnba = sport === 'wnba';
  const table = isWnba ? 'wnba_player_box' : 'nba_player_box';
  if (!playerIds.length) return new Map();
  const extraWhere = sinceDate ? `game_date >= '${sinceDate.replace(/[^0-9-]/g, '')}'` : ''; // date is validated YYYY-MM-DD only, never raw user input interpolated as SQL
  // wnba_player_box has NO plain `team`/`opponent` columns (it carries
  // team_abbreviation/opponent_team_abbreviation instead) -- aliased back
  // to team/opponent so callers get one uniform row shape regardless of sport.
  const cols = isWnba
    ? 'game_id, athlete_id, athlete_name, season, season_type, game_date, team_abbreviation AS team, opponent_team_abbreviation AS opponent, home_away, pos_group, minutes, points, rebounds, assists, threes, turnovers, fga, fta, starter, played, fantasy_points'
    : 'game_id, athlete_id, athlete_name, season, season_type, game_date, team, opponent, home_away, pos_group, minutes, points, rebounds, assists, threes, turnovers, fga, fta, starter, played, fantasy_points';
  const rows = await bulkSelectIn(table, 'athlete_id', playerIds, cols, extraWhere);
  const byPlayer = new Map();
  for (const r of rows) {
    if (!byPlayer.has(r.athlete_id)) byPlayer.set(r.athlete_id, []);
    byPlayer.get(r.athlete_id).push(r);
  }
  for (const [, games] of byPlayer) {
    games.sort((a, b) => (a.game_date < b.game_date ? -1 : a.game_date > b.game_date ? 1 : 0));
    if (limit) byPlayer.set(games[0] && games[0].athlete_id, games.slice(-limit));
  }
  if (limit) {
    for (const [pid, games] of byPlayer) byPlayer.set(pid, games.slice(-limit));
  }
  return byPlayer; // Map<athleteId, games[]> -- ONE query issued regardless of playerIds.length (up to the 400-chunk boundary)
}

// ---------- NBA: teammate/roster lookups for next-man-up / availability ----------

// Both lib/nextManUpSignal.js and lib/playerAvailabilitySignal.js need,
// for up to 500 players in one request, "this player's rolling L10
// minutes" and "who else played on their team that game." Both are now a
// single bulk fetch keyed on the full playerId list (or gameId list) the
// caller already has, instead of one query per player inside a loop.
async function getTeammateContextBulk(sport, gameIds) {
  const isWnba = sport === 'wnba';
  const table = isWnba ? 'wnba_player_box' : 'nba_player_box';
  if (!gameIds.length) return new Map();
  const cols = isWnba
    ? 'game_id, athlete_id, athlete_name, team_abbreviation AS team, played, minutes, points, rebounds, assists'
    : 'game_id, athlete_id, athlete_name, team, played, minutes, points, rebounds, assists';
  const rows = await bulkSelectIn(table, 'game_id', gameIds, cols);
  const byGame = new Map();
  for (const r of rows) {
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, []);
    byGame.get(r.game_id).push(r);
  }
  return byGame; // Map<gameId, rows[]> -- ONE query for up to 400 gameIds
}

// ---------- NFL: bulk player window history (replaces per-player fetches) ----------

async function getNflPlayerHistories(playerIds, { seasons = null } = {}) {
  if (!playerIds.length) return new Map();
  const extraWhere = seasons && seasons.length ? `season IN (${seasons.map(() => '?').join(',')})` : '';
  // bulkSelectIn doesn't support extra bound params beyond the IN list, so
  // build this one directly when a season filter is needed (still ONE
  // query per 400-id chunk, not one per player).
  const cols = 'season, week, season_type, game_date, player_id, player_name, position, team, opponent, passing_yards, passing_tds, interceptions, rushing_yards, rushing_tds, receptions, targets, receiving_yards, receiving_tds, fantasy_points_ppr, pass_attempts, completions, rush_attempts';
  const rows = [];
  for (const part of chunk([...new Set(playerIds)], IN_CHUNK_SIZE)) {
    const placeholders = part.map(() => '?').join(',');
    const sql = seasons && seasons.length
      ? `SELECT ${cols} FROM nfl_player_game_stats WHERE player_id IN (${placeholders}) AND season IN (${seasons.map(() => '?').join(',')})`
      : `SELECT ${cols} FROM nfl_player_game_stats WHERE player_id IN (${placeholders})`;
    const params = seasons && seasons.length ? [...part, ...seasons] : part;
    rows.push(...await store.query(sql, params));
  }
  const byPlayer = new Map();
  for (const r of rows) {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []);
    byPlayer.get(r.player_id).push(r);
  }
  for (const [, games] of byPlayer) games.sort((a, b) => a.season - b.season || a.week - b.week);
  return byPlayer;
}

// ---------- NFL DvP: bulk recompute (replaces ~640 per-team-position queries) ----------

// This is the direct bulk-safe replacement for
// lib/nflDvpEngine.js's recomputeNflDefenseByPosition, which issued
// windowDefs.length(5) x POSITIONS.length(4) x teams.length(~32) = ~640
// individual `SELECT ... WHERE opponent=? AND position=?` calls (one raw
// row-set fetch PER WINDOW, even though the underlying rows for a given
// (team, position) never change across windows -- only which games are
// included does). Fetches the ENTIRE nfl_player_game_stats table ONCE
// (23,543 rows locally -- small enough for a single query), groups by
// (opponent, position, season, week) in memory, then derives all 5 windows
// from that one in-memory structure. Preserves the EXACT same
// team-game-first summing discipline (sumByTeamGame) and the same
// games_sampled/player_games_sampled distinction as the original.
const SUM_FIELDS = ['pass_attempts', 'completions', 'passing_yards', 'passing_tds', 'rush_attempts', 'rushing_yards', 'rushing_tds', 'targets', 'receptions', 'receiving_yards', 'receiving_tds', 'fantasy_points_ppr'];
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const ROLLING_WINDOWS = [{ type: 'L3', limitGames: 3 }, { type: 'L5', limitGames: 5 }, { type: 'L10', limitGames: 10 }];
function round1(n) { return n == null ? null : Math.round(n * 10) / 10; }
function round2(n) { return n == null ? null : Math.round(n * 100) / 100; }

async function computeNflDefenseByPositionBulk() {
  const queryLog = [];
  const trackedQuery = async (sql, params) => { queryLog.push(sql); return store.query(sql, params); };

  // Query 1 of 3: every row this recompute could ever need, ONE shot.
  const allRows = await trackedQuery(`SELECT opponent, position, season, week, pass_attempts, completions, passing_yards, passing_tds, rush_attempts, rushing_yards, rushing_tds, targets, receptions, receiving_yards, receiving_tds, fantasy_points_ppr FROM nfl_player_game_stats WHERE position IN ('QB','RB','WR','TE')`);
  // Query 2 of 3: current/complete season resolution (was 1 query before too).
  const maxSeasonRow = await trackedQuery(`SELECT MAX(season) mx FROM nfl_player_game_stats`);
  const current = maxSeasonRow[0] && maxSeasonRow[0].mx != null ? maxSeasonRow[0].mx : null;
  const complete = current == null ? [] : [current - 3, current - 2, current - 1];
  // Query 3 of 3: team list, in the EXACT SAME query/order as the original
  // sync recompute (`SELECT DISTINCT opponent AS team FROM
  // nfl_player_game_stats`, no position filter) -- deriving the team list
  // from allRows' iteration order instead produced a DIFFERENT row order,
  // which silently changed tie-breaking in the rank sort below (confirmed:
  // 55/640 rows differed, 100% of them rank-only, 0% any statistic --
  // fixed by matching the original's exact team-ordering query rather than
  // re-deriving it).
  const teamsRows = await trackedQuery(`SELECT DISTINCT opponent AS team FROM nfl_player_game_stats`);
  const teams = teamsRows.map(r => r.team);

  // Group ALL rows by (opponent, position) once, then by team-game within that.
  const byTeamPos = new Map(); // "team|pos" -> Map("season-week" -> {season,week,sums})
  for (const r of allRows) {
    const tpKey = `${r.opponent}|${r.position}`;
    if (!byTeamPos.has(tpKey)) byTeamPos.set(tpKey, new Map());
    const byGame = byTeamPos.get(tpKey);
    const gKey = `${r.season}-${r.week}`;
    if (!byGame.has(gKey)) byGame.set(gKey, { season: r.season, week: r.week, sums: Object.fromEntries(SUM_FIELDS.map(f => [f, 0])), playerRows: 0 });
    const g = byGame.get(gKey);
    for (const f of SUM_FIELDS) g.sums[f] += (r[f] || 0);
    g.playerRows++;
  }

  const windowDefs = [
    ...ROLLING_WINDOWS.map(w => ({ type: w.type, seasonYear: null, mode: 'limit', limitGames: w.limitGames })),
    { type: 'season', seasonYear: current, mode: 'seasons', seasons: current == null ? null : [current] },
    { type: 'multiseason', seasonYear: null, mode: 'seasons', seasons: complete.length < 3 ? null : complete },
  ];

  const upserts = []; // batched, applied via ONE transaction at the end
  const resultCounts = {};
  for (const { type, mode, limitGames, seasons, seasonYear } of windowDefs) {
    for (const position of POSITIONS) {
      const rowsOut = [];
      for (const team of teams) {
        if (mode === 'seasons' && seasons === null) continue;
        const byGame = byTeamPos.get(`${team}|${position}`);
        if (!byGame) continue;
        let gameKeys = [...byGame.keys()].sort((a, b) => { const ga = byGame.get(a), gb = byGame.get(b); return gb.season - ga.season || gb.week - ga.week; });
        gameKeys = mode === 'seasons' ? gameKeys.filter(k => seasons.includes(byGame.get(k).season)) : gameKeys.slice(0, limitGames);
        if (!gameKeys.length) continue;
        const gameSums = gameKeys.map(k => byGame.get(k));
        const playerRowCount = gameKeys.reduce((s, k) => s + byGame.get(k).playerRows, 0);
        const avg = key => gameSums.reduce((s, g) => s + (g.sums[key] || 0), 0) / gameSums.length;
        rowsOut.push({
          team, position, window_type: type, season_year: seasonYear,
          pass_attempts_allowed: round1(avg('pass_attempts')), completions_allowed: round1(avg('completions')),
          passing_yards_allowed: round1(avg('passing_yards')), passing_tds_allowed: round2(avg('passing_tds')),
          rush_attempts_allowed: round1(avg('rush_attempts')), rushing_yards_allowed: round1(avg('rushing_yards')),
          rushing_tds_allowed: round2(avg('rushing_tds')), targets_allowed: round1(avg('targets')),
          receptions_allowed: round1(avg('receptions')), receiving_yards_allowed: round1(avg('receiving_yards')),
          receiving_tds_allowed: round2(avg('receiving_tds')), fantasy_points_allowed: round1(avg('fantasy_points_ppr')),
          games_sampled: gameSums.length, player_games_sampled: playerRowCount,
        });
      }
      const sorted = [...rowsOut].sort((a, b) => a.fantasy_points_allowed - b.fantasy_points_allowed);
      sorted.forEach((r, i) => { r.rank = i + 1; });
      upserts.push(...rowsOut);
      resultCounts[`${position}:${type}`] = rowsOut.length;
    }
  }

  // Query 3: ONE batched transaction for every upsert (still O(1) ROUND
  // TRIPS in the sense that it's one transaction, not one-await-per-row;
  // Turso's transaction() still issues one statement per row inside it,
  // which is unavoidable for a write of this shape, but it's a single
  // network SESSION rather than N independent request/response cycles).
  await store.transaction(async (exec) => {
    for (const r of upserts) {
      await exec(`INSERT INTO nfl_defense_by_position
          (team, position, window_type, season_year, pass_attempts_allowed, completions_allowed, passing_yards_allowed, passing_tds_allowed, rush_attempts_allowed, rushing_yards_allowed, rushing_tds_allowed, targets_allowed, receptions_allowed, receiving_yards_allowed, receiving_tds_allowed, fantasy_points_allowed, rank, games_sampled, player_games_sampled, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(team, position, window_type) DO UPDATE SET
          season_year=excluded.season_year, pass_attempts_allowed=excluded.pass_attempts_allowed, completions_allowed=excluded.completions_allowed,
          passing_yards_allowed=excluded.passing_yards_allowed, passing_tds_allowed=excluded.passing_tds_allowed,
          rush_attempts_allowed=excluded.rush_attempts_allowed, rushing_yards_allowed=excluded.rushing_yards_allowed,
          rushing_tds_allowed=excluded.rushing_tds_allowed, targets_allowed=excluded.targets_allowed,
          receptions_allowed=excluded.receptions_allowed, receiving_yards_allowed=excluded.receiving_yards_allowed,
          receiving_tds_allowed=excluded.receiving_tds_allowed, fantasy_points_allowed=excluded.fantasy_points_allowed,
          rank=excluded.rank, games_sampled=excluded.games_sampled, player_games_sampled=excluded.player_games_sampled, updated_at=datetime('now')`,
        [r.team, r.position, r.window_type, r.season_year, r.pass_attempts_allowed, r.completions_allowed, r.passing_yards_allowed, r.passing_tds_allowed, r.rush_attempts_allowed, r.rushing_yards_allowed, r.rushing_tds_allowed, r.targets_allowed, r.receptions_allowed, r.receiving_yards_allowed, r.receiving_tds_allowed, r.fantasy_points_allowed, r.rank, r.games_sampled, r.player_games_sampled]);
    }
  });

  return { current, completeSeasons: complete, ...resultCounts, _queryCount: queryLog.length + 1 /* +1 for the transaction session */, _upsertRowCount: upserts.length };
}

// ---------- MLB: bulk batter/pitcher rollup windows ----------

async function getMlbBatterWindows(playerIds) {
  if (!playerIds.length) return new Map();
  const rows = await bulkSelectIn('mlb_batter_game_stats', 'player_id', playerIds,
    'game_pk, game_date, player_id, player_name, team, opponent, opposing_pitcher_id, at_bats, hits, total_bases, runs, rbi, home_runs, walks, strikeouts');
  const byPlayer = new Map();
  for (const r of rows) { if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []); byPlayer.get(r.player_id).push(r); }
  for (const [, games] of byPlayer) games.sort((a, b) => (a.game_date < b.game_date ? -1 : 1));
  return byPlayer;
}

async function getMlbPitcherWindows(playerIds) {
  if (!playerIds.length) return new Map();
  const rows = await bulkSelectIn('mlb_pitcher_game_stats', 'player_id', playerIds,
    'game_pk, game_date, player_id, player_name, team, opponent, innings_pitched, strikeouts, walks_allowed, hits_allowed, earned_runs');
  const byPlayer = new Map();
  for (const r of rows) { if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []); byPlayer.get(r.player_id).push(r); }
  for (const [, games] of byPlayer) games.sort((a, b) => (a.game_date < b.game_date ? -1 : 1));
  return byPlayer;
}

// ---------- NFL DvP: live read (replaces lib/nflDvpEngine.js's
// getNflDefenseByPosition's better-sqlite3-prepared-statement-cache read
// path, which existed specifically to work around a better-sqlite3
// concurrent-read crash -- historicalStore's node:sqlite/Turso backends
// don't share that failure mode, so no equivalent cache is needed here). ---
const { resolveWindow, POSITIONS: NFL_POSITIONS } = require('./nflDvpEngine');
async function getNflDefenseByPositionAsync(team) {
  const windowTypes = ['L3', 'L5', 'L10', 'season', 'multiseason'];
  const rows = await store.query(`
    SELECT position, window_type, season_year, pass_attempts_allowed, completions_allowed,
           passing_yards_allowed, passing_tds_allowed, rush_attempts_allowed, rushing_yards_allowed,
           rushing_tds_allowed, targets_allowed, receptions_allowed, receiving_yards_allowed,
           receiving_tds_allowed, fantasy_points_allowed, rank, games_sampled, player_games_sampled
    FROM nfl_defense_by_position WHERE team = ?
  `, [team]);

  const byPosition = {};
  NFL_POSITIONS.forEach(pos => { byPosition[pos] = { windows: {} }; });
  rows.forEach(r => {
    if (!byPosition[r.position]) return;
    byPosition[r.position].windows[r.window_type] = {
      seasonYear: r.season_year,
      passAttemptsAllowed: r.pass_attempts_allowed, completionsAllowed: r.completions_allowed,
      passingYardsAllowed: r.passing_yards_allowed, passingTdsAllowed: r.passing_tds_allowed,
      rushAttemptsAllowed: r.rush_attempts_allowed, rushingYardsAllowed: r.rushing_yards_allowed,
      rushingTdsAllowed: r.rushing_tds_allowed, targetsAllowed: r.targets_allowed,
      receptionsAllowed: r.receptions_allowed, receivingYardsAllowed: r.receiving_yards_allowed,
      receivingTdsAllowed: r.receiving_tds_allowed, fantasyPointsAllowed: r.fantasy_points_allowed,
      rank: r.rank, games: r.games_sampled, playerGames: r.player_games_sampled,
    };
  });
  NFL_POSITIONS.forEach(pos => {
    windowTypes.forEach(w => { if (!byPosition[pos].windows[w]) byPosition[pos].windows[w] = null; });
    byPosition[pos].recommended = resolveWindow(byPosition[pos].windows);
  });

  const intRows = await store.query(`
    SELECT window_type, season_year, interceptions_generated, interceptions_per_game,
           interception_rate, pass_attempts_faced, games_sampled
    FROM nfl_defense_interceptions WHERE team = ?
  `, [team]);
  const intWindows = {};
  windowTypes.forEach(w => { intWindows[w] = null; });
  intRows.forEach(r => {
    intWindows[r.window_type] = {
      seasonYear: r.season_year, interceptionsGenerated: r.interceptions_generated,
      interceptionsPerGame: r.interceptions_per_game, interceptionRate: r.interception_rate,
      passAttemptsFaced: r.pass_attempts_faced, games: r.games_sampled,
    };
  });
  const interceptions = { windows: intWindows, recommended: resolveWindow(intWindows) };
  return { byPosition, interceptions }; // 2 queries total, regardless of position/window count
}

// ---------- NBA DvP (lib/dvpEngine.js): bulk recompute (Phase 4) ----------
//
// Replaces recomputeDefenseByPosition's ~450-query behavior (3 windows x 5
// positions x ~30 teams, each re-querying box_scores from scratch even
// though the underlying per-team-position row set never changes across
// windows -- only how many of its most-recent rows are included does) with
// ONE bulk fetch of every real box_scores row for the sport, grouped by
// (opponent, position) in memory (each group's rows sorted DESC by
// game_date, matching the original's per-window `ORDER BY game_date DESC
// [LIMIT n]`), then derives season/last20/last10 from that one grouped
// structure via array slicing. Team iteration order is taken from the
// SAME `SELECT DISTINCT opponent AS team` query the original used (not
// re-derived from the bulk fetch's own row order), matching the exact
// precaution already applied for the NFL DvP bulk rewrite above (a
// different team-ordering source changed tie-breaking there).
const DVP_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];
function round1x(n) { return Math.round(n * 10) / 10; }

async function computeDefenseByPositionBulk(sport) {
  const queryLog = [];
  const trackedQuery = async (sql, params) => { queryLog.push(sql); return store.query(sql, params); };

  const teamsRows = await trackedQuery(`SELECT DISTINCT opponent AS team FROM box_scores WHERE sport = ?`, [sport]);
  const teams = teamsRows.map(r => r.team);
  const allRows = await trackedQuery(`SELECT opponent, position, game_date, points, rebounds, assists FROM box_scores WHERE sport = ?`, [sport]);

  const byTeamPos = new Map(); // "team|pos" -> rows[] (will be sorted DESC by game_date)
  for (const r of allRows) {
    const key = `${r.opponent}|${r.position}`;
    if (!byTeamPos.has(key)) byTeamPos.set(key, []);
    byTeamPos.get(key).push(r);
  }
  for (const [, arr] of byTeamPos) arr.sort((a, b) => (a.game_date < b.game_date ? 1 : a.game_date > b.game_date ? -1 : 0));

  const windows = [{ type: 'season', limitGames: null }, { type: 'last20', limitGames: 20 }, { type: 'last10', limitGames: 10 }];
  const upserts = [];
  const results = {};

  for (const { type, limitGames } of windows) {
    for (const position of DVP_POSITIONS) {
      const rowsOut = [];
      for (const team of teams) {
        const all = byTeamPos.get(`${team}|${position}`);
        if (!all || !all.length) continue;
        const games = limitGames ? all.slice(0, limitGames) : all;
        const avg = key => games.reduce((s, g) => s + (g[key] || 0), 0) / games.length;
        rowsOut.push({ team, points_allowed: round1x(avg('points')), rebounds_allowed: round1x(avg('rebounds')), assists_allowed: round1x(avg('assists')), games_sampled: games.length });
      }
      const sorted = [...rowsOut].sort((a, b) => a.points_allowed - b.points_allowed);
      sorted.forEach((r, i) => { r.rank_points = i + 1; });
      upserts.push(...rowsOut.map(r => ({ ...r, position, window_type: type })));
      results[`${position}:${type}`] = rowsOut.length;
    }
  }

  await store.transaction(async (exec) => {
    for (const r of upserts) {
      await exec(`INSERT INTO defense_by_position (sport, team, position, window_type, points_allowed, rebounds_allowed, assists_allowed, rank_points, games_sampled, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(sport, team, position, window_type) DO UPDATE SET
          points_allowed=excluded.points_allowed, rebounds_allowed=excluded.rebounds_allowed, assists_allowed=excluded.assists_allowed,
          rank_points=excluded.rank_points, games_sampled=excluded.games_sampled, updated_at=datetime('now')`,
        [sport, r.team, r.position, r.window_type, r.points_allowed, r.rebounds_allowed, r.assists_allowed, r.rank_points, r.games_sampled]);
    }
  });

  return { ...results, _queryCount: queryLog.length + 1, _upsertRowCount: upserts.length };
}

async function getDefenseByPositionAsync(sport, team, windowType = 'season') {
  const rows = await store.query(`
    SELECT position, points_allowed, rebounds_allowed, assists_allowed, rank_points, games_sampled, updated_at
    FROM defense_by_position WHERE sport = ? AND team = ? AND window_type = ?
  `, [sport, team, windowType]);
  const byPosition = {};
  rows.forEach(r => {
    byPosition[r.position] = { pointsAllowed: r.points_allowed, reboundsAllowed: r.rebounds_allowed, assistsAllowed: r.assists_allowed, rank: r.rank_points, gamesSampled: r.games_sampled };
  });
  return byPosition;
}

async function getTeamAdvancedStatsAsync(sport, team, windowType = 'season') {
  const row = await store.queryOne(`
    SELECT defensive_rating, offensive_rating, pace, def_rating_rank, games_sampled, updated_at
    FROM team_advanced_rollup WHERE sport = ? AND team = ? AND window_type = ?
  `, [sport, team, windowType]);
  if (!row) return null;
  return { defensiveRating: row.defensive_rating, offensiveRating: row.offensive_rating, pace: row.pace, rank: row.def_rating_rank, gamesSampled: row.games_sampled, updatedAt: row.updated_at };
}

module.exports = {
  getPlayerGameHistories, getTeammateContextBulk, getNflPlayerHistories, getNflDefenseByPositionAsync,
  computeNflDefenseByPositionBulk, getMlbBatterWindows, getMlbPitcherWindows,
  computeDefenseByPositionBulk, getDefenseByPositionAsync, getTeamAdvancedStatsAsync,
  bulkSelectIn, chunk, IN_CHUNK_SIZE,
};
