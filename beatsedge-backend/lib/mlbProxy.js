// MLB's stats API is genuinely open — no key, no CORS restriction (verified:
// "The API does not enforce CORS, so browser requests work without a proxy").
// This module still exists because computing rollups (pitcher ERA/WHIP over
// a window, team batting profiles) benefits from server-side storage and
// caching — not because MLB itself requires a proxy the way NBA did.

const BASE = 'https://statsapi.mlb.com/api/v1';

async function fetchSchedule(dateStr /* YYYY-MM-DD */) {
  const url = `${BASE}/schedule?sportId=1&date=${dateStr}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB schedule fetch failed: HTTP ${res.status}`);
  return res.json();
}

async function fetchBoxscore(gamePk) {
  const url = `${BASE}/game/${gamePk}/boxscore`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB boxscore fetch failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * Real probable starting pitchers for a given date, keyed by team
 * abbreviation on both sides of each game. This is what closes the
 * "who's actually pitching tonight" gap for batter matchup context —
 * without it, a batter's opposing-pitcher stats can't be looked up for
 * real, only guessed at or left on sample data.
 */
async function fetchProbablePitchers(dateStr /* YYYY-MM-DD */) {
  const url = `${BASE}/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher,team`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB probable pitcher fetch failed: HTTP ${res.status}`);
  const data = await res.json();

  const byTeam = {}; // team abbrev -> { pitcherId, pitcherName, opponent }
  const games = (data.dates && data.dates[0] && data.dates[0].games) || [];

  games.forEach(game => {
    const home = game.teams.home;
    const away = game.teams.away;
    const homeAbbrev = home.team && home.team.abbreviation;
    const awayAbbrev = away.team && away.team.abbreviation;

    // The opposing team's probable pitcher is what THIS team's batters face.
    if (homeAbbrev && away.probablePitcher) {
      byTeam[homeAbbrev] = {
        pitcherId: String(away.probablePitcher.id),
        pitcherName: away.probablePitcher.fullName,
        opponent: awayAbbrev
      };
    }
    if (awayAbbrev && home.probablePitcher) {
      byTeam[awayAbbrev] = {
        pitcherId: String(home.probablePitcher.id),
        pitcherName: home.probablePitcher.fullName,
        opponent: homeAbbrev
      };
    }
  });

  return byTeam;
}

module.exports = { fetchSchedule, fetchBoxscore, fetchProbablePitchers };
