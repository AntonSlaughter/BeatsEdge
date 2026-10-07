// NFL diagnostics: database rows -> the LIVE gamelog row shape, and a STRICTLY AS-OF team-defense rank PROXY.
// Nothing here is part of the app. The database has NO team scores, so ESPN's live points-allowed rank (standings) cannot be reproduced exactly:
// the proxy is "offensive-TD-equivalent points allowed" = 7 x (opponent passing TDs + opponent rushing TDs) in each REGULAR-season game strictly BEFORE
// the target date (receiving TDs are the receiving side of passing TDs and are not double counted), ranked 1 (stingiest) .. 32 (leakiest), exactly like the
// live rank. Same fallback as live: current season when >= 20 teams have played, else the previous season's final ranking, else none.
const DAY = 864e5;
const UNTESTABLE = ['longRush', 'longRec', 'kickingPts', 'fgMade'];   // no such columns in nfl_player_game_stats -> never testable, never invented
const toGlRow = (r) => ({ eventId: `${r.season}-${r.season_type}-${r.week}-${r.team}`, ts: Date.parse(r.game_date + 'T12:00:00Z'), date: r.game_date, dateShort: r.game_date, opponent: r.opponent, vsLabel: 'vs ' + r.opponent, season: r.season,
  row: { passingYards: r.passing_yards, passingTouchdowns: r.passing_tds, passingAttempts: r.pass_attempts, completions: r.completions, interceptions: r.interceptions, rushingYards: r.rushing_yards, rushingAttempts: r.rush_attempts,
    rushingTouchdowns: r.rushing_tds, receivingYards: r.receiving_yards, receptions: r.receptions, receivingTouchdowns: r.receiving_tds, receivingTargets: r.targets } });
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function buildDefenseProxy(rows) {
  const g = new Map();
  for (const r of rows) { if (r.season_type !== 'REG' || !r.game_date) continue; const k = `${r.season}|${r.week}|${r.team}`; let o = g.get(k); if (!o) g.set(k, o = { season: r.season, week: r.week, team: r.team, opp: r.opponent, date: r.game_date, tds: 0 }); o.tds += (r.passing_tds || 0) + (r.rushing_tds || 0); }
  const games = []; g.forEach(o => { const opp = g.get(`${o.season}|${o.week}|${o.opp}`); if (opp) games.push({ season: o.season, date: o.date, team: o.team, pa: 7 * opp.tds }); });
  const bySeason = new Map(); games.forEach(x => { let a = bySeason.get(x.season); if (!a) bySeason.set(x.season, a = []); a.push(x); });
  const cache = new Map();
  const rankOf = (arr) => { const per = new Map(); arr.forEach(x => { const o = per.get(x.team) || { s: 0, n: 0 }; o.s += x.pa; o.n++; per.set(x.team, o); }); const t = [...per].map(([team, o]) => ({ team, pg: o.s / o.n })).filter(x => x.pg > 0); t.sort((a, b) => a.pg - b.pg || (a.team < b.team ? -1 : 1)); return { teams: per.size, map: new Map(t.map((x, i) => [x.team, { rank: i + 1, paPerGame: Math.round(x.pg * 10) / 10 }])) }; };
  // as-of table for (season, date): strictly earlier games only
  function table(season, date) {
    const key = season + '|' + date; if (cache.has(key)) return cache.get(key);
    const cur = rankOf((bySeason.get(season) || []).filter(x => x.date < date)); let out;
    if (cur.teams >= 20) out = { src: 'current', map: cur.map }; else { const prev = bySeason.get(season - 1); out = prev ? { src: 'prior-season', map: rankOf(prev).map } : { src: 'none', map: new Map() }; }
    cache.set(key, out); return out;
  }
  const lookup = (season, date, team) => { const t = table(season, date); const x = t.map.get(team); return x ? { rank: x.rank, paPerGame: x.paPerGame, src: t.src } : null; };
  // placebo: the SAME rank set, permuted across teams, deterministically per (season, date)
  const pcache = new Map();
  const placebo = (season, date, team) => { const key = season + '|' + date; let m = pcache.get(key); if (!m) { const t = table(season, date); const teams = [...t.map.keys()].sort(), ranks = [...t.map.values()].sort((a, b) => a.rank - b.rank); const rr = rng(season * 100003 + Number(date.replace(/-/g, '')) % 99991); const idx = ranks.map((_, i) => i); for (let k = idx.length - 1; k > 0; k--) { const j = Math.floor(rr() * (k + 1)); [idx[k], idx[j]] = [idx[j], idx[k]]; } m = new Map(teams.map((tm, i) => [tm, ranks[idx[i]]])); pcache.set(key, m); } const x = m.get(team); return x ? { rank: x.rank, paPerGame: x.paPerGame, src: 'placebo' } : null; };
  return { lookup, placebo, table, games, seasons: [...bySeason.keys()].sort() };
}
module.exports = { toGlRow, buildDefenseProxy, UNTESTABLE, DAY, rng };
