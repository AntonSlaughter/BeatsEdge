// This is the entire reason this backend exists.
//
// stats.nba.com and stats.wnba.com publish real team defensive data for
// free, but require a Referer + User-Agent header that BROWSERS REFUSE
// TO LET JAVASCRIPT SET. That's a hard browser security rule — no amount
// of clever client-side code works around it. A server has no such
// restriction, so this tiny proxy is the entire fix.

const HOSTS = {
  nba: 'https://stats.nba.com',
  wnba: 'https://stats.wnba.com'
};

// These are the specific headers stats.nba.com's edge checks for.
// (Widely known/documented pattern — see e.g. the nba_api and hoopR
// project source for the same header set.)
const REQUIRED_HEADERS = {
  'Host': 'stats.nba.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nba.com/',
  'Origin': 'https://www.nba.com',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
  'Connection': 'keep-alive'
};

// Simple in-memory cache. These stats update at most once a day (games
// finish, box scores post) so a short TTL is plenty and keeps us well
// under any informal rate limits — good etiquette on an unofficial API.
const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function setCached(key, data) {
  cache.set(key, { data, time: Date.now() });
}

/**
 * Fetch real opponent defensive stats (points/rebounds/assists allowed,
 * per game) from stats.nba.com or stats.wnba.com.
 * @param {'nba'|'wnba'} sport
 * @param {string} season - e.g. '2025-26'
 */
async function fetchLeagueDefenseStats(sport, season) {
  const cacheKey = `${sport}:${season}:opponent-stats`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const host = HOSTS[sport];
  if (!host) throw new Error(`Unsupported sport: ${sport}`);

  const url = `${host}/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&LastNGames=0&LeagueID=00&Location=&MeasureType=Opponent&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${encodeURIComponent(season)}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`;

  const headers = { ...REQUIRED_HEADERS, Host: host.replace('https://', '') };

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${sport} stats API returned HTTP ${res.status}`);
  const json = await res.json();

  const resultSet = json.resultSets && json.resultSets[0];
  if (!resultSet) throw new Error('Unexpected response shape from stats API');

  const headers_ = resultSet.headers;
  const abbrevIdx = headers_.indexOf('TEAM_ABBREVIATION');
  const oppPtsIdx = headers_.indexOf('OPP_PTS');
  const oppRebIdx = headers_.indexOf('OPP_REB');
  const oppAstIdx = headers_.indexOf('OPP_AST');
  const gpIdx = headers_.indexOf('GP');

  const teams = resultSet.rowSet.map(row => ({
    team: row[abbrevIdx],
    oppPointsAllowed: row[oppPtsIdx],
    oppReboundsAllowed: oppRebIdx >= 0 ? row[oppRebIdx] : null,
    oppAssistsAllowed: oppAstIdx >= 0 ? row[oppAstIdx] : null,
    gamesPlayed: row[gpIdx]
  }));

  // Rank teams by points allowed (1 = fewest allowed = toughest defense)
  const sorted = [...teams].sort((a, b) => a.oppPointsAllowed - b.oppPointsAllowed);
  sorted.forEach((t, i) => { t.rank = i + 1; });

  const byTeam = {};
  teams.forEach(t => {
    const ranked = sorted.find(s => s.team === t.team);
    byTeam[t.team] = { ...t, rank: ranked.rank };
  });

  setCached(cacheKey, byTeam);
  return byTeam;
}

/**
 * Fetch box scores for a specific completed game date (used by the
 * nightly cron to grow our own historical dataset for free, going
 * forward, without depending on the one-time Kaggle seed).
 */
async function fetchScoreboardForDate(sport, dateStr /* YYYY-MM-DD */) {
  const host = HOSTS[sport];
  const url = `${host}/stats/scoreboardv2?DayOffset=0&LeagueID=00&gameDate=${dateStr}`;
  const headers = { ...REQUIRED_HEADERS, Host: host.replace('https://', '') };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Scoreboard fetch failed: HTTP ${res.status}`);
  return res.json();
}

async function fetchBoxScoreTraditional(sport, gameId) {
  const host = HOSTS[sport];
  const url = `${host}/stats/boxscoretraditionalv2?GameID=${gameId}&StartPeriod=0&EndPeriod=10&RangeType=0&StartRange=0&EndRange=28800`;
  const headers = { ...REQUIRED_HEADERS, Host: host.replace('https://', '') };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Box score fetch failed: HTTP ${res.status}`);
  return res.json();
}

module.exports = {
  fetchLeagueDefenseStats,
  fetchScoreboardForDate,
  fetchBoxScoreTraditional
};
