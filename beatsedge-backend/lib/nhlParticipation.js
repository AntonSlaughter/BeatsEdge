'use strict';
// NHL participation FACTS per final team game for ONE resolved player (read-only; no write, no migration).
//   rowPresent       the player has a stored box-score row for that game (a goalie row exists only for a goalie who entered the game)
//   teamBoxComplete  the stored box scores of HIS TEAM for that game are a full dressed roster (>= MIN_TEAM_ROWS rows): his absence is then a real absence, not missing data
//   bracketed        he has stored rows for the SAME team before AND after that game in that season (so he was on the team)
// The facts are returned, not a verdict: the page classifies them with histClassifyGame (a DNP needs an absent row + a complete team box + bracketing; anything else stays UNRESOLVED).
// The team's FINAL games come from the free NHL club schedule (api-web.nhle.com, gameType 2 = regular season, 3 = playoffs; preseason is never returned); a schedule failure is reported, never guessed.
const store = require('./historicalStore');
const MIN_TEAM_ROWS = 18;
const FINAL_STATES = new Set(['FINAL', 'OFF']);
const TTL = 10 * 60 * 1000; const cache = new Map();
async function clubSchedule(team, seasonEnd, fetchImpl) {
  const key = team + '|' + seasonEnd, hit = cache.get(key); if (hit && Date.now() - hit.at < TTL) return hit.games;
  const f = fetchImpl || fetch; const r = await f('https://api-web.nhle.com/v1/club-schedule-season/' + encodeURIComponent(team) + '/' + (seasonEnd - 1) + seasonEnd);
  if (!r.ok) throw new Error('schedule http ' + r.status); const j = await r.json(); const games = Array.isArray(j.games) ? j.games : null; if (!games) throw new Error('schedule has no games');
  cache.set(key, { at: Date.now(), games }); return games;
}
// pure: playerRows [{game_id, team, game_date, season}], schedules { 'TEAM|season': [api-web games] | null }, teamRowCounts { 'TEAM|gameId': n }
function participationFacts({ playerRows, schedules, teamRowCounts }) {
  const rows = (playerRows || []).filter(r => r && r.game_id != null && r.team && r.game_date && r.season != null), games = [], failures = [];
  const seasons = [...new Set(rows.map(r => r.season))].sort((a, b) => b - a).slice(0, 2);
  seasons.forEach(season => {
    const inSeason = rows.filter(r => r.season === season), teams = [...new Set(inSeason.map(r => r.team))], multi = teams.length > 1;
    teams.forEach(team => {
      const sched = schedules && schedules[team + '|' + season]; if (!sched) { failures.push({ season, team }); return; }
      const mine = inSeason.filter(r => r.team === team), ids = new Set(mine.map(r => String(r.game_id))), dates = mine.map(r => r.game_date).sort(), first = dates[0], last = dates[dates.length - 1];
      sched.filter(g => g && (g.gameType === 2 || g.gameType === 3) && FINAL_STATES.has(g.gameState)).forEach(g => {
        const gid = String(g.id), gd = g.gameDate; if (multi && (gd < first || gd > last)) return;   // a traded player: games outside his stint with this team are not his team's games
        const home = g.homeTeam && g.homeTeam.abbrev === team;
        games.push({ gameId: gid, gameDate: gd, startTimeUTC: g.startTimeUTC || null, season, gameType: g.gameType, opponent: home ? (g.awayTeam && g.awayTeam.abbrev) : (g.homeTeam && g.homeTeam.abbrev), homeAway: home ? 'home' : 'away', final: true,
          rowPresent: ids.has(gid), teamBoxComplete: ((teamRowCounts && teamRowCounts[team + '|' + gid]) || 0) >= MIN_TEAM_ROWS, bracketed: dates.some(d => d < gd) && dates.some(d => d > gd) });
      });
    });
  });
  return { games: games.sort((a, b) => String(a.startTimeUTC || a.gameDate).localeCompare(String(b.startTimeUTC || b.gameDate))), failures };
}
async function getPlayerParticipation(playerId, deps) {
  deps = deps || {}; const q = deps.query || ((sql, p) => store.query(sql, p));
  const rows = await q('SELECT game_id, team, game_date, season FROM nhl_player_box WHERE player_id = ? ORDER BY game_date ASC', [playerId]); if (!rows.length) return { games: [], failures: [], noHistory: true };
  const seasons = [...new Set(rows.map(r => r.season))].sort((a, b) => b - a).slice(0, 2), pairs = [...new Set(rows.filter(r => seasons.indexOf(r.season) >= 0).map(r => r.team + '|' + r.season))];
  const schedules = {}, teamRowCounts = {};
  for (const pair of pairs) {
    const [team, season] = pair.split('|');
    try { schedules[pair] = await clubSchedule(team, +season, deps.fetchImpl); } catch (e) { schedules[pair] = null; continue; }
    (await q('SELECT game_id, COUNT(*) AS c FROM nhl_player_box WHERE team = ? AND season = ? GROUP BY game_id', [team, +season])).forEach(r => { teamRowCounts[team + '|' + r.game_id] = r.c; });
  }
  return participationFacts({ playerRows: rows, schedules, teamRowCounts });
}
module.exports = { participationFacts, getPlayerParticipation, clubSchedule, MIN_TEAM_ROWS };
