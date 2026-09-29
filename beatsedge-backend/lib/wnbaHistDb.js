// Read helpers over wnba_player_box (historical WNBA box scores from
// sportsdataverse — see scripts/ingest-hoopr-wnba.js). Read-only, mirrors
// lib/nbaHistDb.js's shape exactly so future research code can treat NBA
// and WNBA history symmetrically. Entirely separate table/data — never
// reads or writes nba_player_box.

const db = require('./db');

const POS_GROUP = raw => /^(PG|SG|G)$/i.test(raw || '') ? 'G' : /^(SF|PF|F)$/i.test(raw || '') ? 'F' : 'C';

// Non-competitive team codes observed directly in the real sportsdataverse
// WNBA feed (Phase 2I-D audit: team_abbreviation values 'ALL'/'USA' in the
// 2010 file, 'USA'/'WNBASTARS' in the 2024 file — All-Star-weekend rosters,
// not real regular-/post-season opponents). Mirrors nba_player_box's own
// EXHIBITION_OPP handling in lib/nbaHistDb.js. Only codes actually observed
// are listed here — nothing invented.
const EXHIBITION_TEAM = ['ALL', 'USA', 'WNBASTARS'];
const NOT_EXHIB = `opponent_team_abbreviation NOT IN (${EXHIBITION_TEAM.map(() => '?').join(',')}) AND team_abbreviation NOT IN (${EXHIBITION_TEAM.map(() => '?').join(',')})`;
const EXHIB_ARGS = [...EXHIBITION_TEAM, ...EXHIBITION_TEAM];

function hasData() {
  try { return db.prepare(`SELECT 1 FROM wnba_player_box LIMIT 1`).get() != null; }
  catch (e) { return false; }
}

// Per-game rows for a set of ESPN athlete ids, oldest first. Same compact
// key shape as nbaHistDb.gamelogs so a caller can treat both the same way.
//   { "<athleteId>": [ { d, o, h, m, pts, reb, ast, tpm, stl, blk, tov, pm, st, fga, fta, tpa, oreb, dreb }, ... ] }
function gamelogs(ids, { since = null, playedOnly = true } = {}) {
  const list = [...new Set((ids || []).map(String))].filter(Boolean);
  if (!list.length) return {};
  const out = {};
  const ph = list.map(() => '?').join(',');
  const clauses = [`athlete_id IN (${ph})`, NOT_EXHIB];
  const args = [...list, ...EXHIB_ARGS];
  if (playedOnly) clauses.push(`played = 1`);
  if (since) { clauses.push(`game_date >= ?`); args.push(since); }
  const rows = db.prepare(`
    SELECT athlete_id, game_date, opponent_team_abbreviation AS opponent, home_away, minutes, points, rebounds, assists,
           threes, steals, blocks, turnovers, plus_minus, starter, fga, fta, threes_att,
           off_reb, def_reb
    FROM wnba_player_box
    WHERE ${clauses.join(' AND ')}
    ORDER BY athlete_id, game_date
  `).all(...args);
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

// A roster to walk-forward when there is no live slate (offseason). Most-
// played players in `season` (end year), with their latest team + modal
// position. Mirrors nbaHistDb.backtestPool exactly.
function backtestPool({ season = null, minGames = 15, limit = 220 } = {}) {
  if (!season) {
    const mx = db.prepare(`SELECT MAX(season) s FROM wnba_player_box`).get();
    season = mx && mx.s;
  }
  if (!season) return [];
  const rows = db.prepare(`
    SELECT athlete_id, athlete_name, COUNT(*) g
    FROM wnba_player_box
    WHERE season = ? AND season_type = 2 AND played = 1 AND ${NOT_EXHIB}
    GROUP BY athlete_id
    HAVING g >= ?
    ORDER BY g DESC
    LIMIT ?
  `).all(season, ...EXHIB_ARGS, minGames, limit);
  const lastMeta = db.prepare(`
    SELECT team_abbreviation AS team, pos FROM wnba_player_box
    WHERE athlete_id = ? AND season = ? ORDER BY game_date DESC LIMIT 1
  `);
  return rows.map(r => {
    const m = lastMeta.get(r.athlete_id, season) || {};
    return { id: r.athlete_id, name: r.athlete_name, games: r.g, team: m.team || null, position: POS_GROUP(m.pos) };
  });
}

// Defense-vs-position: how much each team allows to G / F / C, per game,
// over a trailing window, with a 1-N rank per stat (1 = stingiest). Mirrors
// nbaHistDb.dvpGrid exactly.
function dvpGrid({ since = null, minTeamGames = 5 } = {}) {
  const clauses = [`played = 1`, `opponent_team_abbreviation IS NOT NULL`, `pos_group IS NOT NULL`, NOT_EXHIB];
  const args = [...EXHIB_ARGS];
  if (since) { clauses.push(`game_date >= ?`); args.push(since); }
  const rows = db.prepare(`
    SELECT opponent_team_abbreviation AS team, pos_group AS grp,
           COUNT(DISTINCT game_id) AS team_games,
           SUM(points) sp, SUM(rebounds) sr, SUM(assists) sa,
           SUM(threes) s3, SUM(steals) ss, SUM(blocks) sb, SUM(turnovers) st
    FROM wnba_player_box
    WHERE ${clauses.join(' AND ')}
    GROUP BY opponent_team_abbreviation, pos_group
  `).all(...args);

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
