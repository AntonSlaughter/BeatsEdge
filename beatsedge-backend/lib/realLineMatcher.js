// Phase 2I-Q -- matches archived real provider period-line observations
// (nba_provider_line_archive / wnba_provider_line_archive) to actual
// historical period results (nba_player_period_stats / wnba_player_period_
// stats, built in Phase G), and scores each matched-and-graded observation
// with the exact leak-free Phase H model state (tmp/period-model-weights.
// json) that existed strictly before that game.
//
// IDENTITY RESOLUTION (explicit instruction: no fuzzy display-name
// matching, mark unresolved rather than guess):
//   EVENT:  archive row's (home_team, away_team, commence_time date) ->
//           exact team-name match (WNBA: box table's own team_name column;
//           NBA: lib/nbaTeamNames.js's fixed 30-team full-name->abbr map,
//           since nba_player_box only stores abbreviations) + exact
//           game_date match against the box table. commence_time's date
//           is tried as-is first, then the day before (a late-night ET tip
//           can cross the UTC date boundary the provider timestamp uses) --
//           both are honest date-normalization attempts, never a guess at
//           IDENTITY itself, and which one worked is recorded.
//   PLAYER: exact, case-insensitive, whitespace-trimmed match of
//           player_raw against athlete_name among the resolved game's own
//           box rows. No Levenshtein/soft matching. Ambiguous (>1 exact
//           match) or absent -> unmatched.
// A row that fails either resolution step is marked unmatched with the
// specific reason; it is never silently dropped or guessed.

const db = require('../lib/db');
const { NBA_TEAM_NAME_TO_ABBR } = require('./nbaTeamNames');
const { isCompleteCase } = require('./backtestCore');

// provider market_key_raw base (no period suffix) for each candidate stat --
// confirmed against real captured rows (Phase G/2I-Q live inspection), not
// guessed. Suffix -> period code is likewise confirmed for _1st_quarter/
// _1st_half; _2nd_half is the same naming convention extended by symmetry
// (no real _2nd_half observation has been captured yet to confirm against).
const STAT_BASE_KEY = {
  points: 'player_points',
  rebounds: 'player_rebounds',
  dreb: 'player_defensive_rebounds',
  pra: 'player_pra',
};
const PERIOD_SUFFIX = { Q1: '_1st_quarter', H1: '_1st_half', H2: '_2nd_half' };
const SUFFIX_TO_PERIOD = { '_1st_quarter': 'Q1', '_1st_half': 'H1', '_2nd_half': 'H2', '_2nd_quarter': 'Q2', '_3rd_quarter': 'Q3', '_4th_quarter': 'Q4' };

function derivePeriodFromMarketKey(marketKeyRaw) {
  for (const [suffix, period] of Object.entries(SUFFIX_TO_PERIOD)) {
    if (marketKeyRaw.endsWith(suffix)) return period;
  }
  return null;
}

function expectedMarketKey(stat, period) {
  return STAT_BASE_KEY[stat] + PERIOD_SUFFIX[period];
}

function dateOnly(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
function dayBefore(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Fallback used only when the archived row has no home_team/away_team at
// all (a genuine capture gap, confirmed against real rows -- some events
// were captured with those fields null while event_id/commence_time/
// player_raw were still present). Resolves via the player instead of the
// teams: still an EXACT, non-fuzzy name match, just anchored differently --
// a player can only be on one roster on a given date, so requiring the
// exact name to appear on exactly one game's combined roster that date is
// just as safe an identity signal as the team-name path, never a guess.
function resolveEventByPlayerFallback(sport, gameDate, playerRaw) {
  const boxTable = sport === 'nba' ? 'nba_player_box' : 'wnba_player_box';
  const nameCol = 'athlete_name';
  const target = norm(playerRaw);
  const rows = db.prepare(`SELECT DISTINCT game_id, ${nameCol} AS n FROM ${boxTable} WHERE game_date = ?`).all(gameDate);
  const matchingGames = [...new Set(rows.filter(r => norm(r.n) === target).map(r => r.game_id))];
  if (matchingGames.length === 1) return { resolved: true, gameId: matchingGames[0], gameDate, method: 'player-date-fallback' };
  if (matchingGames.length === 0) return { resolved: false, reason: `player-fallback: no game on ${gameDate} rosters "${playerRaw}"` };
  return { resolved: false, reason: `player-fallback: "${playerRaw}" appears in ${matchingGames.length} different games on ${gameDate} -- ambiguous, not resolved` };
}

function resolveEvent(sport, row) {
  try {
    return resolveEventUnsafe(sport, row);
  } catch (e) {
    // nba_player_box / wnba_player_box may not exist yet wherever this
    // runs (the historical data layer ships separately from the archive
    // infrastructure) -- report as unresolved with a clear, honest reason
    // rather than crashing the caller. Any other error still throws.
    if (/no such table/i.test(e.message)) return { resolved: false, reason: `historical box-score table not available in this environment (${e.message})` };
    throw e;
  }
}

function resolveEventUnsafe(sport, row) {
  const boxTable = sport === 'nba' ? 'nba_player_box' : 'wnba_player_box';
  const candidateDates = [dateOnly(row.commence_time)].filter(Boolean);
  if (candidateDates[0]) candidateDates.push(dayBefore(candidateDates[0]));

  if (!row.home_team || !row.away_team) {
    if (!row.player_raw || !candidateDates.length) return { resolved: false, reason: 'missing home/away team on archived row, and no player_raw/commence_time to fall back on' };
    for (const gameDate of candidateDates) {
      const fb = resolveEventByPlayerFallback(sport, gameDate, row.player_raw);
      if (fb.resolved) return { ...fb, dateAttempt: gameDate === candidateDates[0] ? 'exact' : 'day-before' };
    }
    return { resolved: false, reason: `missing home/away team on archived row; player-fallback also failed for "${row.player_raw}" on ${candidateDates.join(' or ')}` };
  }

  for (const gameDate of candidateDates) {
    if (sport === 'nba') {
      const homeAbbr = NBA_TEAM_NAME_TO_ABBR[row.home_team] || null;
      const awayAbbr = NBA_TEAM_NAME_TO_ABBR[row.away_team] || null;
      if (!homeAbbr || !awayAbbr) return { resolved: false, reason: `unrecognized NBA team name: ${!homeAbbr ? row.home_team : row.away_team}` };
      const rows = db.prepare(`SELECT DISTINCT game_id FROM ${boxTable} WHERE game_date = ? AND team IN (?, ?)`).all(gameDate, homeAbbr, awayAbbr);
      for (const { game_id } of rows) {
        const teams = db.prepare(`SELECT DISTINCT team AS t FROM ${boxTable} WHERE game_id = ?`).all(game_id).map(r => r.t);
        if (teams.includes(homeAbbr) && teams.includes(awayAbbr)) {
          return { resolved: true, gameId: game_id, gameDate, dateAttempt: gameDate === candidateDates[0] ? 'exact' : 'day-before' };
        }
      }
      continue;
    }
    // WNBA: wnba_player_box.team_name stores the NICKNAME only (e.g.
    // "Mystics"), while the provider sends the full franchise name (e.g.
    // "Washington Mystics") -- an exact suffix check (case-insensitive) is
    // a deterministic, non-fuzzy transform of a known city+nickname naming
    // convention, not a guess: nicknames don't collide within one league.
    const candidates = db.prepare(`SELECT DISTINCT game_id, team_name FROM ${boxTable} WHERE game_date = ?`).all(gameDate);
    const homeMatch = candidates.find(c => norm(row.home_team).endsWith(norm(c.team_name)));
    const awayMatch = candidates.find(c => norm(row.away_team).endsWith(norm(c.team_name)));
    if (homeMatch && awayMatch && homeMatch.game_id === awayMatch.game_id) {
      return { resolved: true, gameId: homeMatch.game_id, gameDate, dateAttempt: gameDate === candidateDates[0] ? 'exact' : 'day-before' };
    }
  }
  return { resolved: false, reason: `no ${sport} game found for ${row.home_team} vs ${row.away_team} on ${candidateDates.join(' or ')}` };
}

function resolvePlayer(sport, gameId, playerRaw) {
  const boxTable = sport === 'nba' ? 'nba_player_box' : 'wnba_player_box';
  try {
    const roster = db.prepare(`SELECT athlete_id, athlete_name FROM ${boxTable} WHERE game_id = ?`).all(gameId);
    const target = norm(playerRaw);
    const matches = roster.filter(r => norm(r.athlete_name) === target);
    if (matches.length === 1) return { resolved: true, athleteId: matches[0].athlete_id };
    if (matches.length === 0) return { resolved: false, reason: `no exact roster-name match for "${playerRaw}" in game ${gameId}` };
    return { resolved: false, reason: `ambiguous: ${matches.length} exact name matches for "${playerRaw}" in game ${gameId}` };
  } catch (e) {
    if (/no such table/i.test(e.message)) return { resolved: false, reason: `historical box-score table not available in this environment (${e.message})` };
    throw e;
  }
}

// Leak-free rolling state for one athlete/stat, as of strictly before
// beforeDate -- mirrors lib/backtestCore.js's buildFeatureRows rolling
// logic exactly, just queried for a single athlete on demand instead of
// scanning the whole table.
function playerStateAsOf(sport, period, stat, athleteId, beforeDate) {
  const table = sport === 'nba' ? 'nba_player_period_stats' : 'wnba_player_period_stats';
  const boxTable = sport === 'nba' ? 'nba_player_box' : 'wnba_player_box';
  const priorRows = db.prepare(`
    SELECT game_id, season, game_date, ${stat} AS val
    FROM ${table} WHERE athlete_id = ? AND period = ? AND game_date < ?
    ORDER BY game_date, game_id
  `).all(athleteId, period, beforeDate);
  if (!priorRows.length) return null;

  const priorMinutes = db.prepare(`
    SELECT game_id, game_date, minutes FROM ${boxTable} WHERE athlete_id = ? AND game_date < ? AND played = 1
    ORDER BY game_date
  `).all(athleteId, beforeDate);
  const minutesByGame = new Map(priorMinutes.map(r => [r.game_id, r.minutes]));

  const lastSeason = priorRows[priorRows.length - 1].season;
  const seasonRows = priorRows.filter(r => r.season === lastSeason);
  const career = priorRows.slice(-20).map(r => r.val);
  const n = career.length;
  const l5 = career.slice(Math.max(0, n - 5)), l10 = career.slice(Math.max(0, n - 10)), l15 = career.slice(Math.max(0, n - 15));
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const seasonAvg = seasonRows.length ? avg(seasonRows.map(r => r.val)) : null;
  const careerAvg = avg(career);
  const lineBasis = seasonAvg !== null ? seasonAvg : careerAvg;
  if (lineBasis === null) return null;
  const line = Math.floor(lineBasis) + 0.5;
  const hitRate = a => a.length ? a.filter(v => v > line).length / a.length : null;
  const minWin = priorMinutes.slice(-10).map(r => r.minutes);
  const rollingMinutes = minWin.length ? avg(minWin) : null;
  const prevVal = priorRows[priorRows.length - 1].val;

  return {
    careerLen: n, seasonGamesSoFar: seasonRows.length,
    line, seasonAvg, careerAvg,
    l5avg: avg(l5), l10avg: avg(l10), l15avg: avg(l15),
    l5hit: hitRate(l5), l10hit: hitRate(l10), l15hit: hitRate(l15),
    prevVal, rollingMinutes,
  };
}

function scoreWithModel(model, state, homeAway) {
  const x = [
    state.l5hit, state.l10hit, state.l15hit,
    state.l5avg - state.line, state.l10avg - state.line, state.seasonAvg - state.line,
    state.l5avg - state.seasonAvg, state.prevVal - state.line,
    state.rollingMinutes, homeAway === 'home' ? 1 : 0,
  ];
  const z = x.map((v, j) => (v - model.mean[j]) / model.std[j]);
  let s = model.bias;
  for (let j = 0; j < z.length; j++) s += model.weights[j] * z[j];
  const p = 1 / (1 + Math.exp(-s));
  const projection = 0.4 * state.l5avg + 0.35 * state.l10avg + 0.25 * state.seasonAvg;
  return { probability: p, projection };
}

function actualResult(sport, period, stat, gameId, athleteId) {
  const table = sport === 'nba' ? 'nba_player_period_stats' : 'wnba_player_period_stats';
  try {
    const row = db.prepare(`SELECT ${stat} AS val FROM ${table} WHERE game_id = ? AND athlete_id = ? AND period = ?`).get(gameId, athleteId, period);
    return row ? row.val : null;
  } catch (e) {
    // The {nba,wnba}_player_period_stats tables ship separately (the
    // historical data-layer work) and may not exist yet wherever this
    // module is running -- treat "table doesn't exist" the same as "no
    // result yet" rather than crashing the caller. Any other error still
    // throws, since that's a real bug worth surfacing.
    if (/no such table/i.test(e.message)) return null;
    throw e;
  }
}

module.exports = {
  STAT_BASE_KEY, PERIOD_SUFFIX, derivePeriodFromMarketKey, expectedMarketKey,
  resolveEvent, resolvePlayer, playerStateAsOf, scoreWithModel, actualResult, isCompleteCase,
};
