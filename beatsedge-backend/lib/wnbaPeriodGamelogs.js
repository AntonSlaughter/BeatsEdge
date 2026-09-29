// Phase 2I-L -- compact per-player WNBA period (1Q/1H) game history, for the
// NEW, SEPARATE WNBA period model (BeatsEdge.html). Read-only. Reuses
// lib/wnbaPbpDb.js's already-validated derivePeriodStats() unmodified --
// this module only adds the athlete_id/game_date join layer (via
// wnba_player_box, same join key wnbaHistDb.js already uses) and a compact
// response shape, mirroring lib/nbaHistDb.js's gamelogs() shape/spirit so
// the new /api/wnba/period-gamelogs route can follow the exact same pattern
// as the existing /api/nba/gamelogs route.
//
// Does NOT touch wnba_pbp, wnba_player_box, or wnbaPbpDb.js. Does not
// compute any projection/probability/grade -- purely historical period
// stat rows; the model math lives entirely in BeatsEdge.html, separate
// from the frozen full-game model (see WNBA_PERIOD_MODEL comment block
// there).

const db = require('./db');
const pbpDb = require('./wnbaPbpDb');

function hasData() {
  return pbpDb.hasData();
}

// { "<athleteId>": [ { d: gameDate, q1: {points,oreb,dreb,rebounds,assists}, h1: {...} }, ... ] }
// oldest first, per athlete. Only games with real PBP coverage are included
// (no zero-filled placeholder games) -- same "excluded, never zero-filled"
// rule as the Phase 2I-L backtest and wnbaPbpDb.js itself.
function periodGamelogs(athleteIds, { since = null } = {}) {
  const list = [...new Set((athleteIds || []).map(String))].filter(Boolean);
  if (!list.length) return {};

  const ph = list.map(() => '?').join(',');
  const clauses = [`athlete_id IN (${ph})`, `played = 1`];
  const args = [...list];
  if (since) { clauses.push(`game_date >= ?`); args.push(since); }
  const boxRows = db.prepare(`
    SELECT athlete_id, game_id, game_date
    FROM wnba_player_box
    WHERE ${clauses.join(' AND ')}
    ORDER BY athlete_id, game_date ASC
  `).all(...args);
  if (!boxRows.length) return {};

  const gameIds = [...new Set(boxRows.map(r => r.game_id))];
  const derivedByGame = {};
  for (const gid of gameIds) {
    const cnt = db.prepare(`SELECT COUNT(*) c FROM wnba_pbp WHERE game_id = ?`).get(gid).c;
    if (cnt === 0) continue; // no PBP for this game -- excluded, not zero-filled
    derivedByGame[gid] = pbpDb.derivePeriodStats(gid);
  }

  const out = {};
  const pick = b => ({ points: b.points, oreb: b.oreb, dreb: b.dreb, rebounds: b.rebounds, assists: b.assists });
  for (const row of boxRows) {
    const d = derivedByGame[row.game_id];
    const pd = d ? d[row.athlete_id] : null;
    if (!pd) continue;
    (out[row.athlete_id] || (out[row.athlete_id] = [])).push({
      d: row.game_date,
      q1: pick(pd.q1),
      h1: pick(pd.h1),
    });
  }
  return out;
}

// ---------- LIVE production path (Phase 4): historicalStore-backed ----------
//
// Replaces the original's per-distinct-game loop (one COUNT(*) query + one
// gamePlays() query PER game, up to hundreds of games in a real request)
// with 2 bulk queries total: one for the wnba_player_box rows (as before,
// already bulk), one for EVERY requested game's wnba_pbp rows in a single
// IN(...) fetch, grouped in memory before deriving each game's period stats
// via derivePeriodStatsFromPlays (no query inside that loop anymore).
async function periodGamelogsAsync(athleteIds, { since = null } = {}) {
  const list = [...new Set((athleteIds || []).map(String))].filter(Boolean);
  if (!list.length) return {};
  const store = require('./historicalStore');
  const { derivePeriodStatsFromPlays } = require('./wnbaPbpDb');
  const { bulkSelectIn } = require('./historicalQueries');

  const extraWhere = since ? `game_date >= '${since.replace(/[^0-9-]/g, '')}'` : ''; // validated YYYY-MM-DD only
  const boxRows = await bulkSelectIn('wnba_player_box', 'athlete_id', list, 'athlete_id, game_id, game_date', `played = 1${extraWhere ? ' AND ' + extraWhere : ''}`);
  if (!boxRows.length) return {};
  boxRows.sort((a, b) => (a.game_date < b.game_date ? -1 : a.game_date > b.game_date ? 1 : 0));

  const gameIds = [...new Set(boxRows.map(r => r.game_id))];
  // wnba_pbp is deliberately NOT part of historicalStore's migrated schema
  // (excluded as a "giant research-only PBP dataset" per the Phase 5
  // production migration's explicit retention decision) -- on a real Turso
  // backend that table simply does not exist yet. Found live while running
  // Phase 5's real empty-local-db/Turso-only test: this route must degrade
  // to "no period data available" (empty, matching the existing "no PBP for
  // this game" convention just below), never throw a 500, until/unless a
  // future phase deliberately migrates wnba_pbp.
  let playRows;
  try {
    playRows = await bulkSelectIn('wnba_pbp', 'game_id', gameIds, '*'); // ONE query for every requested game's plays
  } catch (e) {
    if (/no such table/i.test(e.message)) return {};
    throw e;
  }
  const playsByGame = new Map();
  for (const p of playRows) { if (!playsByGame.has(p.game_id)) playsByGame.set(p.game_id, []); playsByGame.get(p.game_id).push(p); }
  for (const [, arr] of playsByGame) arr.sort((a, b) => (a.sequence_number || 0) - (b.sequence_number || 0));

  const derivedByGame = new Map();
  for (const gid of gameIds) {
    const plays = playsByGame.get(gid);
    if (!plays || !plays.length) continue; // no PBP for this game -- excluded, not zero-filled
    derivedByGame.set(gid, derivePeriodStatsFromPlays(plays));
  }

  const out = {};
  const pick = b => ({ points: b.points, oreb: b.oreb, dreb: b.dreb, rebounds: b.rebounds, assists: b.assists });
  for (const row of boxRows) {
    const d = derivedByGame.get(row.game_id);
    const pd = d ? d[row.athlete_id] : null;
    if (!pd) continue;
    (out[row.athlete_id] || (out[row.athlete_id] = [])).push({ d: row.game_date, q1: pick(pd.q1), h1: pick(pd.h1) });
  }
  return out;
}

module.exports = { hasData, periodGamelogs, periodGamelogsAsync };
