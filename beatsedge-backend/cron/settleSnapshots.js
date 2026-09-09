// Results-join — settle every stored prop snapshot against what actually
// happened, so `prop_snapshots` becomes a calibration dataset (stated
// grade/probability/edge  ↔  real outcome).
//
// For each ungraded row whose slate date is at least a day old, fetch that
// day's box scores from the free keyless feeds (statsapi.mlb.com for MLB,
// site.api.espn.com for NBA/NFL), look up the player's real number for that
// stat, and write `actual` / `result` ('over'|'under'|'push'|'dnp') /
// `graded_at`.

const { db } = require('../lib/snapshotDb');

const RE_DIACRITICS = /[̀-ͯ]/g;
const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(RE_DIACRITICS, '')
  .replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

const j = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': 'beatsedge/settle' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── MLB ────────────────────────────────────────────────────────────────
// statsapi boxscore batting / pitching field → snapshot stat key.
const MLB_RESOLVE = {
  hits: b => b.hits, totalBases: b => b.totalBases, homeRuns: b => b.homeRuns,
  rbis: b => b.rbi, runs: b => b.runs, doubles: b => b.doubles, triples: b => b.triples,
  singles: b => Math.max(0, (b.hits || 0) - (b.doubles || 0) - (b.triples || 0) - (b.homeRuns || 0)),
  batterWalks: b => b.baseOnBalls, batterStrikeouts: b => b.strikeOuts, stolenBases: b => b.stolenBases,
  hitsRunsRbis: b => (b.hits || 0) + (b.runs || 0) + (b.rbi || 0),
  strikeouts: p => p.strikeOuts, earnedRuns: p => p.earnedRuns, hitsAllowed: p => p.hits,
  pitcherOuts: p => (p.outs != null ? p.outs : Math.round((parseFloat(p.inningsPitched) || 0) * 3)),
  pitcherWalks: p => p.baseOnBalls
};

async function mlbActualsForDate(date) {
  // name -> { batting, pitching };  _final = # of completed games found
  const map = { _final: 0 };
  const sched = await j(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`);
  const games = ((sched.dates && sched.dates[0] && sched.dates[0].games) || [])
    .filter(g => /final|completed|game over/i.test(g.status && g.status.detailedState || ''));
  map._final = games.length;
  for (const g of games) {
    try {
      const box = await j(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`);
      for (const side of ['home', 'away']) {
        const players = (box.teams && box.teams[side] && box.teams[side].players) || {};
        for (const pid of Object.keys(players)) {
          const pl = players[pid];
          const name = norm(pl.person && pl.person.fullName);
          if (!name) continue;
          map[name] = { batting: (pl.stats && pl.stats.batting) || null, pitching: (pl.stats && pl.stats.pitching) || null };
        }
      }
    } catch (e) { /* skip a game we can't read */ }
    await sleep(120);
  }
  return map;
}

// ── NBA / NFL via ESPN box scores ──────────────────────────────────────
const ESPN_BASE = {
  nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba',
  nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl'
};
// ESPN box-score stat labels are positional; these index maps are stable.
const NBA_LABELS = ['MIN', 'FG', '3PT', 'FT', 'OREB', 'DREB', 'REB', 'AST', 'STL', 'BLK', 'TO', 'PF', '+/-', 'PTS'];
const nbaVal = (stats, label) => {
  const i = NBA_LABELS.indexOf(label); if (i < 0) return 0;
  const raw = stats[i]; if (raw == null) return 0;
  return parseFloat(String(raw).split('-')[0]) || 0;
};
const NBA_RESOLVE = {
  points: s => nbaVal(s, 'PTS'), rebounds: s => nbaVal(s, 'REB'), assists: s => nbaVal(s, 'AST'),
  threes: s => nbaVal(s, '3PT'), steals: s => nbaVal(s, 'STL'), blocks: s => nbaVal(s, 'BLK'),
  turnovers: s => nbaVal(s, 'TO'),
  pra: s => nbaVal(s, 'PTS') + nbaVal(s, 'REB') + nbaVal(s, 'AST'),
  pr: s => nbaVal(s, 'PTS') + nbaVal(s, 'REB'),
  pa: s => nbaVal(s, 'PTS') + nbaVal(s, 'AST'),
  ra: s => nbaVal(s, 'REB') + nbaVal(s, 'AST'),
  blocksSteals: s => nbaVal(s, 'BLK') + nbaVal(s, 'STL')
};

// NFL: ESPN groups box stats by category; pull the ones our markets use.
function nflPlayerLine(groups) {
  // groups: [{ name:'passing', labels:[...], athletes:[{athlete, stats:[...]}] }]
  const out = {};
  const grab = (gname, label) => {
    const g = groups.find(x => (x.name || '').toLowerCase() === gname);
    if (!g) return 0;
    const i = (g.labels || []).indexOf(label);
    return i >= 0 ? (parseFloat(String(g.stats[i]).split('-')[0]) || 0) : 0;
  };
  out.passingYards = grab('passing', 'YDS');
  out.passingTouchdowns = grab('passing', 'TD');
  out.completions = grab('passing', 'C/ATT'); // "C/ATT" split
  out.passingAttempts = (() => { const g = groups.find(x => (x.name || '').toLowerCase() === 'passing'); if (!g) return 0; const i = (g.labels || []).indexOf('C/ATT'); if (i < 0) return 0; const p = String(g.stats[i]).split('/'); return parseFloat(p[1]) || 0; })();
  out.interceptions = grab('passing', 'INT');
  out.rushingYards = grab('rushing', 'YDS');
  out.rushingAttempts = grab('rushing', 'CAR');
  out.rushingTouchdowns = grab('rushing', 'TD');
  out.longRushing = grab('rushing', 'LONG');
  out.receivingYards = grab('receiving', 'YDS');
  out.receptions = grab('receiving', 'REC');
  out.receivingTouchdowns = grab('receiving', 'TD');
  out.receivingTargets = grab('receiving', 'TGTS');
  out.longReception = grab('receiving', 'LONG');
  return out;
}
const NFL_RESOLVE = {
  passYds: r => r.passingYards, passTds: r => r.passingTouchdowns, passAttempts: r => r.passingAttempts,
  passCompletions: r => { const c = String(r.completions).split('/')[0]; return parseFloat(c) || 0; },
  interceptions: r => r.interceptions,
  passRushYds: r => (r.passingYards || 0) + (r.rushingYards || 0),
  rushYds: r => r.rushingYards, rushAttempts: r => r.rushingAttempts, rushTds: r => r.rushingTouchdowns,
  longRush: r => r.longRushing,
  recYds: r => r.receivingYards, receptions: r => r.receptions, recTds: r => r.receivingTouchdowns,
  targets: r => r.receivingTargets, longRec: r => r.longReception,
  rushRecYds: r => (r.rushingYards || 0) + (r.receivingYards || 0)
};

async function espnActualsForDate(sport, date) {
  const base = ESPN_BASE[sport];
  const ymd = date.replace(/-/g, '');
  const map = { _final: 0 };
  let sb;
  try { sb = await j(`${base}/scoreboard?dates=${ymd}`); } catch (e) { return map; }
  const events = (sb.events || []).filter(e => {
    const st = e.status && e.status.type; return st && (st.completed || /final/i.test(st.description || ''));
  });
  map._final = events.length;
  for (const ev of events) {
    try {
      const sum = await j(`${base}/summary?event=${ev.id}`);
      const teams = (sum.boxscore && sum.boxscore.players) || [];
      for (const t of teams) {
        for (const cat of (t.statistics || [])) {
          if (sport === 'nba') {
            for (const a of (cat.athletes || [])) {
              const name = norm(a.athlete && a.athlete.displayName);
              if (name) map[name] = { _nba: a.stats || [] };
            }
          }
        }
        if (sport === 'nfl') {
          // regroup: t.statistics is [{name, labels, athletes:[{athlete, stats}]}]
          const byAthlete = {};
          for (const cat of (t.statistics || [])) {
            for (const a of (cat.athletes || [])) {
              const name = norm(a.athlete && a.athlete.displayName);
              if (!name) continue;
              (byAthlete[name] = byAthlete[name] || []).push({ name: cat.name, labels: cat.labels, stats: a.stats });
            }
          }
          for (const name of Object.keys(byAthlete)) map[name] = { _nflGroups: byAthlete[name] };
        }
      }
    } catch (e) { /* skip */ }
    await sleep(150);
  }
  return map;
}

// ── driver ─────────────────────────────────────────────────────────────
function pending(minAgeDays = 1) {
  const cutoff = new Date(Date.now() - minAgeDays * 864e5).toISOString().slice(0, 10);
  return db.prepare(`
    SELECT DISTINCT snap_date, sport FROM prop_snapshots
    WHERE result IS NULL AND snap_date <= @cutoff
    ORDER BY snap_date DESC
  `).all({ cutoff });
}

const setResult = db.prepare(`
  UPDATE prop_snapshots SET actual=@actual, result=@result, graded_at=datetime('now')
  WHERE id=@id
`);

async function settleSlate(date, sport) {
  const rows = db.prepare(`SELECT id, player, stat, line, dir FROM prop_snapshots WHERE snap_date=? AND sport=? AND result IS NULL`).all(date, sport);
  if (!rows.length) return { date, sport, settled: 0, dnp: 0, skipped: 0 };

  let actuals, resolvers, pick;
  if (sport === 'mlb') {
    actuals = await mlbActualsForDate(date);
    resolvers = MLB_RESOLVE;
    pick = (entry, stat) => {
      const f = MLB_RESOLVE[stat]; if (!f) return undefined;
      const isPitch = ['strikeouts', 'earnedRuns', 'hitsAllowed', 'pitcherOuts', 'pitcherWalks'].includes(stat);
      const src = isPitch ? entry.pitching : entry.batting;
      return src ? f(src) : undefined;
    };
  } else if (sport === 'nba' || sport === 'nfl') {
    actuals = await espnActualsForDate(sport, date);
    pick = (entry, stat) => {
      if (sport === 'nba') { const f = NBA_RESOLVE[stat]; return (f && entry._nba) ? f(entry._nba) : undefined; }
      const f = NFL_RESOLVE[stat]; return (f && entry._nflGroups) ? f(nflPlayerLine(entry._nflGroups)) : undefined;
    };
  } else {
    return { date, sport, settled: 0, dnp: 0, skipped: rows.length };
  }

  // No completed games for this slate yet (still in progress, or the feed is
  // lagging) — leave every row untouched for a later pass. NEVER mass-DNP.
  if (!actuals || !actuals._final) {
    return { date, sport, settled: 0, dnp: 0, skipped: rows.length, note: 'no finals yet' };
  }

  let settled = 0, dnp = 0, skipped = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const entry = actuals[norm(r.player)];
      if (!entry) { setResult.run({ id: r.id, actual: null, result: 'dnp' }); dnp++; continue; }
      let v;
      try { v = pick(entry, r.stat); } catch (e) { v = undefined; }
      if (v == null || Number.isNaN(v)) { skipped++; continue; }   // unknown stat key — leave for a later pass
      const res = v > r.line ? 'over' : v < r.line ? 'under' : 'push';
      setResult.run({ id: r.id, actual: v, result: res });
      settled++;
    }
  });
  tx();
  return { date, sport, settled, dnp, skipped };
}

async function runSettleSnapshots({ minAgeDays = 1 } = {}) {
  const slates = pending(minAgeDays);
  const results = [];
  for (const { snap_date, sport } of slates) {
    try { results.push(await settleSlate(snap_date, sport)); }
    catch (e) { results.push({ date: snap_date, sport, error: e.message }); }
  }
  const tot = results.reduce((a, r) => ({ settled: a.settled + (r.settled || 0), dnp: a.dnp + (r.dnp || 0) }), { settled: 0, dnp: 0 });
  console.log(`[settle] ${slates.length} slate(s) → ${tot.settled} settled, ${tot.dnp} DNP`);
  return { slates: results, ...tot };
}

module.exports = { runSettleSnapshots };

if (require.main === module) {
  runSettleSnapshots().then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
