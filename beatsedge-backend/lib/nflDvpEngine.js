// NFL's version of dvpEngine.js. Same honest-aggregation approach, adapted
// to NFL's stat categories. Unlike NBA, positions here are real from
// ingestion — no compiled-positions.js equivalent needed for NFL, since
// nflverse publishes QB/RB/WR/TE cleanly for every row.
//
// Rewritten as part of the NFL DvP live-wiring pass to: (1) expand the
// field list (opportunity volume — attempts/completions/targets — plus
// TDs split by type instead of one combined number), (2) replace the old
// ambiguous 'season' window (which actually meant "every season ever
// ingested, no filter") with an explicit L3/L5/L10/season/multiseason set,
// each carrying its own real games_sampled, and (3) add a real defensive-
// interceptions rollup from nfl_team_defense_game.
//
// Every exported function takes `db` as an explicit argument instead of
// requiring lib/nflDb.js itself. Reads (getNflDefenseByPosition, called
// live from routes/api.js) use the server's existing better-sqlite3 handle.
// The recompute functions do hundreds of sequential writes and are
// deliberately run from scripts/recompute-nfl-dvp.js through node:sqlite's
// DatabaseSync instead — this codebase has a reproducible native crash
// (Assertion failed: (env) != nullptr) when better-sqlite3 is used for
// write-heavy work under this Node/Windows build (see the header comment
// on scripts/ingest-nflverse-stats.js for the full story; confirmed again
// this session when recomputeNflDefenseByPosition crashed the same way
// under better-sqlite3). Not taking a dependency on either module here
// keeps this file correct against both.

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

// Caches prepared statements per `db` handle so the live read path
// (getNflDefenseByPosition, called on every /api/nfl/defense/by-position
// request) doesn't construct fresh native Statement objects on every call.
// Confirmed live this session: a full slate's worth of concurrent requests
// (one per opponent, ~30 at once) reproducibly crashed better-sqlite3's
// native binding on this box even though each request only reads — the
// crash isn't limited to heavy writes, it's Statement churn under load.
// Reusing one Statement per (db, sql) for the process lifetime removes that
// churn; the frontend also throttles its batch fetch as a second layer.
const _preparedCache = new WeakMap();
function prepared(db, sql) {
  let m = _preparedCache.get(db);
  if (!m) { m = new Map(); _preparedCache.set(db, m); }
  let stmt = m.get(sql);
  if (!stmt) { stmt = db.prepare(sql); m.set(sql, stmt); }
  return stmt;
}

// Eligibility gate, NOT a stability claim: below this many current-season
// games, `season` is not even considered as a standalone answer and
// `recommended` names the historical `multiseason` window instead. At or
// above it, `season` MAY become recommended — but L3/L5/L10/season/
// multiseason and every one of their games_sampled counts are still always
// returned; resolving one as "recommended" never hides the other four.
const MIN_GAMES_FOR_CURRENT_SEASON = 3;

// Rolling windows cross season boundaries by design (that's what "rolling"
// means) — they don't need the eligibility gate above, only the strictly-
// current-season window does.
const ROLLING_WINDOWS = [
  { type: 'L3', limitGames: 3 },
  { type: 'L5', limitGames: 5 },
  { type: 'L10', limitGames: 10 }
];

const ALLOWED_FIELDS = [
  'pass_attempts_allowed', 'completions_allowed', 'passing_yards_allowed', 'passing_tds_allowed',
  'rush_attempts_allowed', 'rushing_yards_allowed', 'rushing_tds_allowed',
  'targets_allowed', 'receptions_allowed', 'receiving_yards_allowed', 'receiving_tds_allowed',
  'fantasy_points_allowed'
];

const round1 = n => n == null ? null : Math.round(n * 10) / 10;
const round2 = n => n == null ? null : Math.round(n * 100) / 100;

function currentAndCompleteSeasons(db) {
  const row = db.prepare(`SELECT MAX(season) mx FROM nfl_player_game_stats`).get();
  const current = row && row.mx != null ? row.mx : null;
  const complete = current == null ? [] : [current - 3, current - 2, current - 1];
  return { current, complete };
}

const SUM_FIELDS = ['pass_attempts', 'completions', 'passing_yards', 'passing_tds', 'rush_attempts', 'rushing_yards', 'rushing_tds', 'targets', 'receptions', 'receiving_yards', 'receiving_tds', 'fantasy_points_ppr'];

// 2026-09-26 defense sample-size audit fix: a single defensive team-game
// can involve MULTIPLE players at one position (e.g. 3 WRs who all saw
// targets against this defense in the same game) -- these must be SUMMED
// into one team-game total FIRST, and only THEN averaged across actual
// team games. The previous version averaged directly over player-position
// ROWS, silently treating "3 WRs in 1 game" as 3 separate "games" both in
// the displayed averages and in games_sampled. rows here are already
// filtered to one (team, position); grouping key is (season, week) = one
// real defensive team-game.
function sumByTeamGame(rows) {
  const byGame = new Map();
  for (const r of rows) {
    const key = `${r.season}-${r.week}`;
    if (!byGame.has(key)) byGame.set(key, { season: r.season, week: r.week, sums: Object.fromEntries(SUM_FIELDS.map(f => [f, 0])) });
    const g = byGame.get(key);
    for (const f of SUM_FIELDS) g.sums[f] += (r[f] || 0);
  }
  return byGame;
}

// One (team, position) -> averaged "allowed" stat line, computed PER
// ACTUAL DEFENSIVE TEAM GAME (gameSums = one entry per team-game, each
// already summed across every player at this position in that game).
// playerRowCount is preserved separately (section: "preserve player
// observation count") purely as an honest secondary diagnostic -- never
// used for the averages, rank, or the primary games_sampled meaning.
function averageAllowed(gameSums, playerRowCount) {
  if (!gameSums.length) return null;
  const avg = key => gameSums.reduce((s, g) => s + (g.sums[key] || 0), 0) / gameSums.length;
  return {
    pass_attempts_allowed: round1(avg('pass_attempts')),
    completions_allowed: round1(avg('completions')),
    passing_yards_allowed: round1(avg('passing_yards')),
    passing_tds_allowed: round2(avg('passing_tds')),
    rush_attempts_allowed: round1(avg('rush_attempts')),
    rushing_yards_allowed: round1(avg('rushing_yards')),
    rushing_tds_allowed: round2(avg('rushing_tds')),
    targets_allowed: round1(avg('targets')),
    receptions_allowed: round1(avg('receptions')),
    receiving_yards_allowed: round1(avg('receiving_yards')),
    receiving_tds_allowed: round2(avg('receiving_tds')),
    fantasy_points_allowed: round1(avg('fantasy_points_ppr')),
    games_sampled: gameSums.length,           // ACTUAL DEFENSIVE TEAM GAMES (the fix)
    player_games_sampled: playerRowCount      // raw player-position rows (old meaning, kept as diagnostic)
  };
}

function recomputeNflDefenseByPosition(db) {
  const teams = db.prepare(`SELECT DISTINCT opponent AS team FROM nfl_player_game_stats`).all().map(r => r.team);
  const { current, complete } = currentAndCompleteSeasons(db);

  const upsertPos = db.prepare(`
    INSERT INTO nfl_defense_by_position
      (team, position, window_type, season_year, pass_attempts_allowed, completions_allowed,
       passing_yards_allowed, passing_tds_allowed, rush_attempts_allowed, rushing_yards_allowed,
       rushing_tds_allowed, targets_allowed, receptions_allowed, receiving_yards_allowed,
       receiving_tds_allowed, fantasy_points_allowed, rank, games_sampled, player_games_sampled, updated_at)
    VALUES (@team, @position, @window_type, @season_year, @pass_attempts_allowed, @completions_allowed,
       @passing_yards_allowed, @passing_tds_allowed, @rush_attempts_allowed, @rushing_yards_allowed,
       @rushing_tds_allowed, @targets_allowed, @receptions_allowed, @receiving_yards_allowed,
       @receiving_tds_allowed, @fantasy_points_allowed, @rank, @games_sampled, @player_games_sampled, datetime('now'))
    ON CONFLICT(team, position, window_type) DO UPDATE SET
      season_year=excluded.season_year,
      pass_attempts_allowed=excluded.pass_attempts_allowed, completions_allowed=excluded.completions_allowed,
      passing_yards_allowed=excluded.passing_yards_allowed, passing_tds_allowed=excluded.passing_tds_allowed,
      rush_attempts_allowed=excluded.rush_attempts_allowed, rushing_yards_allowed=excluded.rushing_yards_allowed,
      rushing_tds_allowed=excluded.rushing_tds_allowed, targets_allowed=excluded.targets_allowed,
      receptions_allowed=excluded.receptions_allowed, receiving_yards_allowed=excluded.receiving_yards_allowed,
      receiving_tds_allowed=excluded.receiving_tds_allowed, fantasy_points_allowed=excluded.fantasy_points_allowed,
      rank=excluded.rank, games_sampled=excluded.games_sampled, player_games_sampled=excluded.player_games_sampled, updated_at=datetime('now')
  `);

  // Fetch ALL rows for (team, position) once -- every window (L3/L5/L10/
  // season/multiseason) is derived from grouping THIS set by team-game
  // (season, week), never from a raw player-row LIMIT/date filter, so a
  // "last 3" window means 3 actual team-games, not 3 player-position rows.
  const qAllForTeamPos = db.prepare(`
    SELECT season, week, pass_attempts, completions, passing_yards, passing_tds,
           rush_attempts, rushing_yards, rushing_tds,
           targets, receptions, receiving_yards, receiving_tds, fantasy_points_ppr
    FROM nfl_player_game_stats WHERE opponent = ? AND position = ?
  `);

  const results = {};
  const windowDefs = [
    ...ROLLING_WINDOWS.map(w => ({ type: w.type, seasonYear: null, mode: 'limit', limitGames: w.limitGames })),
    { type: 'season', seasonYear: current, mode: 'seasons', seasons: current == null ? null : [current] },
    { type: 'multiseason', seasonYear: null, mode: 'seasons', seasons: complete.length < 3 ? null : complete }
  ];

  windowDefs.forEach(({ type, mode, limitGames, seasons, seasonYear }) => {
    POSITIONS.forEach(position => {
      const rows = teams.map(team => {
        if (mode === 'seasons' && seasons === null) return null; // matches prior "no result" behavior (no current season yet / <3 complete seasons)
        const allRows = qAllForTeamPos.all(team, position);
        const byGame = sumByTeamGame(allRows);
        let gameKeys = [...byGame.keys()].sort((a, b) => {
          const ga = byGame.get(a), gb = byGame.get(b);
          return gb.season - ga.season || gb.week - ga.week;
        });
        gameKeys = mode === 'seasons' ? gameKeys.filter(k => seasons.includes(byGame.get(k).season)) : gameKeys.slice(0, limitGames);
        if (!gameKeys.length) return null;
        const gameSums = gameKeys.map(k => byGame.get(k));
        const playerRowCount = allRows.filter(r => gameKeys.includes(`${r.season}-${r.week}`)).length;
        const avgd = averageAllowed(gameSums, playerRowCount);
        return avgd ? { team, ...avgd } : null;
      }).filter(Boolean);

      // Rank by fantasy points allowed within this exact (position, window):
      // 1 = fewest allowed (toughest defense against this position).
      const sorted = [...rows].sort((a, b) => a.fantasy_points_allowed - b.fantasy_points_allowed);
      sorted.forEach((r, i) => { r.rank = i + 1; });

      rows.forEach(r => upsertPos.run({ ...r, position, window_type: type, season_year: seasonYear }));
      results[`${position}:${type}`] = rows.length;
    });
  });

  recomputeNflDefenseInterceptions(db, current, complete);

  return { current, completeSeasons: complete, ...results };
}

function recomputeNflDefenseInterceptions(db, current, complete) {
  const teams = db.prepare(`SELECT DISTINCT team FROM nfl_team_defense_game`).all().map(r => r.team);

  const upsert = db.prepare(`
    INSERT INTO nfl_defense_interceptions
      (team, window_type, season_year, interceptions_generated, interceptions_per_game,
       interception_rate, pass_attempts_faced, games_sampled, updated_at)
    VALUES (@team, @window_type, @season_year, @interceptions_generated, @interceptions_per_game,
       @interception_rate, @pass_attempts_faced, @games_sampled, datetime('now'))
    ON CONFLICT(team, window_type) DO UPDATE SET
      season_year=excluded.season_year, interceptions_generated=excluded.interceptions_generated,
      interceptions_per_game=excluded.interceptions_per_game, interception_rate=excluded.interception_rate,
      pass_attempts_faced=excluded.pass_attempts_faced, games_sampled=excluded.games_sampled,
      updated_at=datetime('now')
  `);

  const qByLimit = db.prepare(`
    SELECT interceptions_generated, pass_attempts_faced FROM nfl_team_defense_game
    WHERE team = ? ORDER BY season DESC, week DESC LIMIT ?
  `);
  const qBySeason = db.prepare(`
    SELECT interceptions_generated, pass_attempts_faced FROM nfl_team_defense_game
    WHERE team = ? AND season = ?
  `);
  const qBySeasonSet = db.prepare(`
    SELECT interceptions_generated, pass_attempts_faced FROM nfl_team_defense_game
    WHERE team = ? AND season IN (?, ?, ?)
  `);

  const windowDefs = [
    ...ROLLING_WINDOWS.map(w => ({ type: w.type, seasonYear: null, fetch: team => qByLimit.all(team, w.limitGames) })),
    { type: 'season', seasonYear: current, fetch: team => current == null ? [] : qBySeason.all(team, current) },
    { type: 'multiseason', seasonYear: null, fetch: team => complete.length < 3 ? [] : qBySeasonSet.all(team, ...complete) }
  ];

  windowDefs.forEach(({ type, seasonYear, fetch }) => {
    teams.forEach(team => {
      const games = fetch(team);
      if (!games.length) return;
      const totalInt = games.reduce((s, g) => s + (g.interceptions_generated || 0), 0);
      const totalAtt = games.reduce((s, g) => s + (g.pass_attempts_faced || 0), 0);
      upsert.run({
        team, window_type: type, season_year: seasonYear,
        interceptions_generated: round2(totalInt),
        interceptions_per_game: round2(totalInt / games.length),
        interception_rate: totalAtt > 0 ? round2(totalInt / totalAtt) : null,
        pass_attempts_faced: round1(totalAtt),
        games_sampled: games.length
      });
    });
  });
}

// Resolves which window to recommend for one already-fetched `windows`
// object (as produced by getNflDefenseByPosition below): `season` if it
// meets the eligibility gate, otherwise the named historical `multiseason`
// window — never a blend of the two. Returns null (not a guess) if neither
// window has any games at all.
function resolveWindow(windows) {
  const season = windows.season;
  if (season && season.games >= MIN_GAMES_FOR_CURRENT_SEASON) {
    return { window: 'season', games: season.games };
  }
  const multi = windows.multiseason;
  if (multi && multi.games > 0) return { window: 'multiseason', games: multi.games };
  // Neither current season nor the 3-season baseline has data (e.g. a very
  // early expansion team, or a brand-new position gap) — fall further to
  // whichever rolling window has the most games rather than claim a
  // resolution that doesn't exist.
  const rolling = ['L10', 'L5', 'L3'].map(w => windows[w]).find(w => w && w.games > 0);
  return rolling ? { window: ['L10', 'L5', 'L3'].find(w => windows[w] === rolling), games: rolling.games } : null;
}

function getNflDefenseByPosition(db, team) {
  const windowTypes = ['L3', 'L5', 'L10', 'season', 'multiseason'];
  const rows = prepared(db, `
    SELECT position, window_type, season_year, pass_attempts_allowed, completions_allowed,
           passing_yards_allowed, passing_tds_allowed, rush_attempts_allowed, rushing_yards_allowed,
           rushing_tds_allowed, targets_allowed, receptions_allowed, receiving_yards_allowed,
           receiving_tds_allowed, fantasy_points_allowed, rank, games_sampled, player_games_sampled
    FROM nfl_defense_by_position WHERE team = ?
  `).all(team);

  const byPosition = {};
  POSITIONS.forEach(pos => { byPosition[pos] = { windows: {} }; });

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
      rank: r.rank,
      games: r.games_sampled,             // ACTUAL DEFENSIVE TEAM GAMES (fixed 2026-09-26)
      playerGames: r.player_games_sampled  // raw player-position-observation rows (new, additive diagnostic)
    };
  });

  POSITIONS.forEach(pos => {
    windowTypes.forEach(w => { if (!byPosition[pos].windows[w]) byPosition[pos].windows[w] = null; });
    byPosition[pos].recommended = resolveWindow(byPosition[pos].windows);
  });

  // Team-level defensive interceptions — same window set, same resolution rule.
  const intRows = prepared(db, `
    SELECT window_type, season_year, interceptions_generated, interceptions_per_game,
           interception_rate, pass_attempts_faced, games_sampled
    FROM nfl_defense_interceptions WHERE team = ?
  `).all(team);
  const intWindows = {};
  windowTypes.forEach(w => { intWindows[w] = null; });
  intRows.forEach(r => {
    intWindows[r.window_type] = {
      seasonYear: r.season_year,
      interceptionsGenerated: r.interceptions_generated,
      interceptionsPerGame: r.interceptions_per_game,
      interceptionRate: r.interception_rate,
      passAttemptsFaced: r.pass_attempts_faced,
      games: r.games_sampled
    };
  });
  const interceptions = { windows: intWindows, recommended: resolveWindow(intWindows) };

  return { byPosition, interceptions };
}

module.exports = {
  recomputeNflDefenseByPosition,
  getNflDefenseByPosition,
  POSITIONS,
  MIN_GAMES_FOR_CURRENT_SEASON
};
