// Read helpers over nba_player_box (historical NBA box scores from hoopR —
// see scripts/ingest-hoopr-nba.js). Read-only.
//
// 2026-09-28 historical-persistence cutover: converted from a direct
// synchronous better-sqlite3 read (require('./db')) to
// lib/historicalStore.js's async, Turso-capable query() -- this is one of
// the ~15 live production historical readers identified in the caller-
// migration audit as needing conversion before a Turso cutover can be
// safe. Every query string and every returned row shape is UNCHANGED --
// only the access mechanism (sync .prepare().all() -> async store.query())
// differs. Callers (routes/api.js) were updated to await these.

const store = require('./historicalStore');

const POS_GROUP = raw => /^(PG|SG|G)$/i.test(raw || '') ? 'G' : /^(SF|PF|F)$/i.test(raw || '') ? 'F' : 'C';

// All-Star weekend / exhibition rows sneak in under season_type 2 in the
// hoopR feed (opponent = WORLD / STRIPES / EAST / WEST / ...). Drop them —
// they're not real competitive games and would pollute a walk-forward.
const EXHIBITION_OPP = ['WORLD', 'STRIPES', 'EAST', 'WEST', 'STARS', 'USA', 'GLOBAL', 'DURANT', 'LEBRON', 'GIANNIS', 'SHAQ', 'CHUCK', 'KENNY'];
const NOT_EXHIB = `opponent NOT IN (${EXHIBITION_OPP.map(() => '?').join(',')})`;

async function hasData() {
  try { const row = await store.queryOne(`SELECT 1 x FROM nba_player_box LIMIT 1`); return row != null; }
  catch (e) { return false; }
}

// Per-game rows for a set of ESPN athlete ids, oldest first. Compact keys —
// the frontend reshapes them into its gamelog format. ONE bulk query
// regardless of how many ids are requested (unchanged from before -- this
// function was already a single IN(...) query, never a per-player loop).
async function gamelogs(ids, { since = null, playedOnly = true } = {}) {
  const list = [...new Set((ids || []).map(String))].filter(Boolean);
  if (!list.length) return {};
  const out = {};
  const ph = list.map(() => '?').join(',');
  const clauses = [`athlete_id IN (${ph})`, NOT_EXHIB];
  const args = [...list, ...EXHIBITION_OPP];
  if (playedOnly) clauses.push(`played = 1`);
  if (since) { clauses.push(`game_date >= ?`); args.push(since); }
  const rows = await store.query(`
    SELECT athlete_id, game_date, opponent, home_away, minutes, points, rebounds, assists,
           threes, steals, blocks, turnovers, plus_minus, starter, fga, fta, threes_att,
           off_reb, def_reb
    FROM nba_player_box
    WHERE ${clauses.join(' AND ')}
    ORDER BY athlete_id, game_date
  `, args);
  for (const r of rows) {
    (out[r.athlete_id] || (out[r.athlete_id] = [])).push({
      d: r.game_date, o: r.opponent, h: r.home_away === 'home',
      m: r.minutes, pts: r.points, reb: r.rebounds, ast: r.assists,
      tpm: r.threes, stl: r.steals, blk: r.blocks, tov: r.turnovers, pm: r.plus_minus,
      st: r.starter,
      fga: r.fga, fta: r.fta, tpa: r.threes_att,
      oreb: r.off_reb, dreb: r.def_reb,
    });
  }
  return out;
}

// A roster to walk-forward when there is no live slate (offseason). Most-played
// players in `season` (end year), with their latest team + modal position.
async function backtestPool({ season = null, minGames = 25, limit = 220 } = {}) {
  if (!season) {
    const mx = await store.queryOne(`SELECT MAX(season) s FROM nba_player_box`);
    season = mx && mx.s;
  }
  if (!season) return [];
  const rows = await store.query(`
    SELECT athlete_id, athlete_name, COUNT(*) g
    FROM nba_player_box
    WHERE season = ? AND season_type = 2 AND played = 1 AND ${NOT_EXHIB}
    GROUP BY athlete_id
    HAVING g >= ?
    ORDER BY g DESC
    LIMIT ?
  `, [season, ...EXHIBITION_OPP, minGames, limit]);
  // Bulk-fetch each returned player's latest (team,pos) in ONE query instead
  // of one query per player (the original sync version re-prepared a
  // statement and called .get() once per row in a .map() -- a real N+1 that
  // was fine for an in-process file but would be up-to-220 remote Turso
  // round trips otherwise).
  const ids = rows.map(r => r.athlete_id);
  let lastMetaByAthlete = new Map();
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const metaRows = await store.query(`
      SELECT athlete_id, team, pos, game_date FROM nba_player_box
      WHERE athlete_id IN (${ph}) AND season = ?
      ORDER BY athlete_id, game_date DESC
    `, [...ids, season]);
    for (const m of metaRows) if (!lastMetaByAthlete.has(m.athlete_id)) lastMetaByAthlete.set(m.athlete_id, m); // first row per athlete = latest (query is ORDER BY game_date DESC)
  }
  return rows.map(r => {
    const m = lastMetaByAthlete.get(r.athlete_id) || {};
    return { id: r.athlete_id, name: r.athlete_name, games: r.g, team: m.team || null, position: POS_GROUP(m.pos) };
  });
}

// Defense-vs-position: how much each team allows to G / F / C, per game,
// over a trailing window, with a 1-30 rank per stat (1 = stingiest).
// Computed by crediting every player-game to the OPPONENT that allowed it.
async function dvpGrid({ since = null, minTeamGames = 8 } = {}) {
  const clauses = [`played = 1`, `opponent IS NOT NULL`, `pos_group IS NOT NULL`, NOT_EXHIB];
  const args = [...EXHIBITION_OPP];
  if (since) { clauses.push(`game_date >= ?`); args.push(since); }
  const rows = await store.query(`
    SELECT opponent AS team, pos_group AS grp,
           COUNT(DISTINCT game_id) AS team_games,
           SUM(points) sp, SUM(rebounds) sr, SUM(assists) sa,
           SUM(threes) s3, SUM(steals) ss, SUM(blocks) sb, SUM(turnovers) st
    FROM nba_player_box
    WHERE ${clauses.join(' AND ')}
    GROUP BY opponent, pos_group
  `, args);

  const grid = {};
  const perStat = { G: [], F: [], C: [] };
  for (const r of rows) {
    if (r.team_games < minTeamGames) continue;
    const g = r.team_games;
    const rec = {
      teamGames: g,
      pointsAllowed: +(r.sp / g).toFixed(1), reboundsAllowed: +(r.sr / g).toFixed(1),
      assistsAllowed: +(r.sa / g).toFixed(1), threesAllowed: +(r.s3 / g).toFixed(1),
      stealsAllowed: +(r.ss / g).toFixed(1), blocksAllowed: +(r.sb / g).toFixed(1),
      turnoversAllowed: +(r.st / g).toFixed(1),
    };
    (grid[r.team] || (grid[r.team] = {}))[r.grp] = rec;
    perStat[r.grp].push({ team: r.team, rec });
  }
  const RANKF = {
    pointsAllowed: 'rank', reboundsAllowed: 'rebRank', assistsAllowed: 'astRank',
    threesAllowed: 'tpmRank', stealsAllowed: 'stlRank', blocksAllowed: 'blkRank',
    turnoversAllowed: 'toRank',
  };
  for (const grp of ['G', 'F', 'C']) {
    for (const [stat, rankKey] of Object.entries(RANKF)) {
      const sorted = perStat[grp].slice().sort((a, b) => a.rec[stat] - b.rec[stat]);
      sorted.forEach((x, i) => { x.rec[rankKey] = i + 1; });
    }
  }
  return grid;
}

module.exports = { hasData, gamelogs, backtestPool, dvpGrid, POS_GROUP };
