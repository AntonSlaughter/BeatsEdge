// MLB Phase 1 diagnostic data helpers (shared by the Phase 1 scripts). Loads the cached REAL statsapi.mlb.com game logs and builds as-of live-shaped
// inputs for the page's real builders. Read-only; no model logic here.
const fs = require('fs'), path = require('path');
const GL = path.resolve(__dirname, '../../tmp/model-integrity/mlb-phase1/gamelogs');
function loadPlayers() {
  const players = {};
  for (const f of fs.readdirSync(GL).filter(f => /^(hitting|pitching)-/.test(f))) { const g = f.split('-')[0]; for (const p of JSON.parse(fs.readFileSync(path.join(GL, f), 'utf8'))) { const k = g + ':' + p.id; const o = players[k] || (players[k] = { id: String(p.id), name: p.name, pos: p.pos || (g === 'pitching' ? 'P' : '-'), group: g, bat: p.bat, hand: p.hand, splits: [] }); for (const sp of p.splits) o.splits.push(sp); } }
  for (const p of Object.values(players)) { p.splits.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.gamePk - b.gamePk); p.ts = p.splits.map(s => Date.parse(s.date + 'T00:00:00Z')); }
  return players;
}
const sum = (a) => a.reduce((s, v) => s + v, 0);
const ipStr = (outs) => `${Math.floor(outs / 3)}.${outs % 3}`;
const COUNT_FIELDS = ['runs', 'doubles', 'triples', 'homeRuns', 'strikeOuts', 'baseOnBalls', 'intentionalWalks', 'hits', 'hitByPitch', 'atBats', 'caughtStealing', 'stolenBases', 'plateAppearances', 'totalBases', 'rbi', 'sacBunts', 'sacFlies', 'earnedRuns', 'wins', 'losses', 'saves', 'battersFaced', 'outs', 'gamesStarted', 'numberOfPitches', 'strikes'];
const aggStat = (arr, isPitcher) => { const o = { gamesPlayed: arr.length }; for (const f of COUNT_FIELDS) o[f] = sum(arr.map(s => +s.stat[f] || 0)); if (isPitcher) o.inningsPitched = ipStr(o.outs); return o; };
const apiSplit = (sp) => ({ date: sp.date, season: sp.season, isHome: sp.isHome, game: { gamePk: sp.gamePk }, opponent: { id: sp.opp && sp.opp.id, name: sp.opp && sp.opp.name }, stat: sp.stat });
// Build the live-shaped player (+ props from the page's real mlbBuildProps) for target index i of player p, with `lines` {statKey: line}. Returns { pc (seeded board player), prior, seasonStat }.
function buildLive(m, p, i, lines, opts) {
  opts = opts || {}; const isP = p.group === 'pitching', role = isP ? 'pitcher' : 'batter'; const tgt = p.splits[i], tTs = p.ts[i], yr = +tgt.season;
  const prior = p.splits.filter((s, j) => j < i && p.ts[j] < tTs); const cur = prior.filter(s => +s.season === yr);
  const seasonStat = opts.seasonStat || aggStat(cur, isP); const opp = (m.MLB_TEAM_ABBR_BY_NAME[tgt.opp && tgt.opp.name]) || (tgt.opp && tgt.opp.name);
  const allLines = {}; for (const [k, line] of Object.entries(lines)) allLines[k] = { prizepicks: [{ line, over: null, under: null, setAt: null, move: null, primary: true, eventId: 'E' + tgt.gamePk, commenceTimeMs: tTs + 3.6e7, _src: 'parlayapi', ppType: 'standard' }] };
  const statsByKey = {}; const props = m.mlbBuildProps(seasonStat, isP, statsByKey, allLines, 'prizepicks');
  const pc = { id: p.id, sport: 'mlb', role, name: p.name, team: '', opponent: opp, position: p.pos, isHomeTonight: !!tgt.isHome, paceRating: 'neutral', paceDetail: '', minutesTrend: 0, gameLog: [], gameLogByKey: {}, _seasonStat: seasonStat, _isPitcher: isP, props, statsByKey, stats: null, opponentContext: {}, opponentDefense: null, situational: null };
  const fetchCard = async (url) => { const mm = /stats=gameLog&group=(\w+)&season=(\d+)/.exec(url); return mm ? { stats: [{ splits: (opts.log || p.splits).filter((s, j) => (opts.noAsOf ? true : p.ts[j] < tTs) && +s.season === +mm[2]).map(apiSplit) }] } : null; };
  return { pc, prior, cur, seasonStat, yr, tgt, tTs, opp, isP, fetchCard };
}
module.exports = { loadPlayers, aggStat, apiSplit, buildLive, sum, GL };
