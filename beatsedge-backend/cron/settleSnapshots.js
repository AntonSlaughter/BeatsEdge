// Results-join — settle every stored prop snapshot against what actually
// happened, so `prop_snapshots` becomes a calibration dataset (stated
// grade/probability/edge  ↔  real outcome).
//
// For each ungraded row whose slate date is at least a day old, fetch that
// day's box scores from the free keyless feeds (statsapi.mlb.com for MLB,
// site.api.espn.com for NBA/NFL), look up the player's real number for that
// stat, and write `actual` / `result` ('over'|'under'|'push'|'dnp') /
// `graded_at`.

const store = require('../lib/snapshotStore');

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
//
// Fantasy Score resolvers below are copied VERBATIM from mlbFantasyHit /
// mlbFantasyPitch in BeatsEdge.html (the exact scoring the live prediction
// used) -- not re-derived, so settlement never grades a prop against a
// different formula than the one that produced its projection/probability.
// PrizePicks Hitter Fantasy Score: 3/5/8/10 per single/double/triple/HR,
// +2 RBI/run/BB/HBP, +5 SB.
const mlbFantasyHit = (s) => {
  const h = s.hits || 0, d = s.doubles || 0, t = s.triples || 0, hr = s.homeRuns || 0;
  const singles = Math.max(0, h - d - t - hr);
  return Math.round((3 * singles + 5 * d + 8 * t + 10 * hr + 2 * (s.rbi || 0) + 2 * (s.runs || 0) + 2 * (s.baseOnBalls || 0) + 2 * (s.hitByPitch || 0) + 5 * (s.stolenBases || 0)) * 10) / 10;
};
// PrizePicks Pitcher Fantasy Score: out +1, K +3, ER -3, Win +6, QS +4.
const mlbFantasyPitch = (s) => {
  const ipStr = String(s.inningsPitched != null ? s.inningsPitched : '0');
  const [whole, frac] = ipStr.split('.');
  const outs = s.outs != null ? s.outs : ((parseInt(whole, 10) || 0) * 3 + (parseInt(frac, 10) || 0));
  const er = s.earnedRuns || 0;
  const qs = s.qualityStarts != null ? s.qualityStarts : ((outs >= 18 && er <= 3) ? 1 : 0);
  return Math.round((outs + 3 * (s.strikeOuts || 0) - 3 * er + 6 * (s.wins || 0) + 4 * qs) * 10) / 10;
};
// MLB's boxscore API omits a field entirely for a low-activity player
// (e.g. a pinch runner with 0 plate appearances) rather than sending an
// explicit 0 -- every getter needs `|| 0`, matching MLB_PROP_DEFS in
// BeatsEdge.html (which already does this on every stat). Without it,
// `b.hits` on such a player is `undefined`, not 0, and settlement wrongly
// treats a real, resolvable 0-stat game as "value extraction failed".
const MLB_RESOLVE = {
  hits: b => b.hits || 0, totalBases: b => b.totalBases || 0, homeRuns: b => b.homeRuns || 0,
  rbis: b => b.rbi || 0, runs: b => b.runs || 0, doubles: b => b.doubles || 0, triples: b => b.triples || 0,
  singles: b => Math.max(0, (b.hits || 0) - (b.doubles || 0) - (b.triples || 0) - (b.homeRuns || 0)),
  batterWalks: b => b.baseOnBalls || 0, batterStrikeouts: b => b.strikeOuts || 0, stolenBases: b => b.stolenBases || 0,
  hitsRunsRbis: b => (b.hits || 0) + (b.runs || 0) + (b.rbi || 0),
  fantasy: b => mlbFantasyHit(b),
  strikeouts: p => p.strikeOuts || 0, earnedRuns: p => p.earnedRuns || 0, hitsAllowed: p => p.hits || 0,
  pitcherOuts: p => (p.outs != null ? p.outs : Math.round((parseFloat(p.inningsPitched) || 0) * 3)),
  pitcherWalks: p => p.baseOnBalls || 0,
  pitcherFantasy: p => mlbFantasyPitch(p)
};
const MLB_PITCH_STATS = new Set(['strikeouts', 'earnedRuns', 'hitsAllowed', 'pitcherOuts', 'pitcherWalks', 'pitcherFantasy']);

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

// ── NBA / NFL / CFB via ESPN box scores ────────────────────────────────
// CFB (ncaaf) reuses NFL_RESOLVE below -- live-verified before adding this:
// ESPN's college-football summary endpoint returns the exact same
// boxscore.players[].statistics[] shape (same category names "passing"/
// "rushing"/"receiving", same labels "C/ATT"/"YDS"/"TD"/"CAR"/"REC"/"LONG")
// as NFL's, which matches BeatsEdge.html reusing NFL_PROP_DEFS verbatim for
// CFB props in the first place. WNBA is NOT added here: its ESPN scoreboard
// is live (confirmed -- games actively scheduled), but no completed WNBA
// game was available in the lookback window to verify its boxscore shape
// against NBA's before writing a resolver, so it's left unimplemented
// rather than guessed. There are also 0 WNBA snapshot rows stored today,
// so this has no effect on the current settlement run either way.
const ESPN_BASE = {
  nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba',
  nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl',
  ncaaf: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football'
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
        if (sport === 'nfl' || sport === 'ncaaf') {
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
// A snap_date in the future (relative to right now) can never correspond to
// a completed game -- no source will ever return a result for it, so it
// must never be treated as a normal "pending, try again later" slate (that
// would leave it silently retried forever). Flag it invalid once instead.
// This is sport-agnostic and date-only: it doesn't guess about any sport's
// actual season calendar, just that "the future hasn't happened yet."
const SET_INVALID_SQL = `
  UPDATE prop_snapshots
  SET settlement_status='invalid', settlement_reason=?, settlement_source=NULL, graded_at=datetime('now')
  WHERE id=?
`;
async function flagInvalidFutureDates() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await store.query(`
    SELECT id, sport, snap_date FROM prop_snapshots
    WHERE result IS NULL AND settlement_status IS NULL AND snap_date > ?
  `, [today]);
  if (!rows.length) return { flagged: 0 };
  await store.transaction(async (exec) => {
    for (const r of rows) {
      await exec(SET_INVALID_SQL, [
        `snap_date (${r.snap_date}) is after today (${today}) -- no completed game can ever exist for it; never fabricated, never retried as pending`,
        r.id
      ]);
    }
  });
  return { flagged: rows.length };
}

async function pending(minAgeDays = 1) {
  const cutoff = new Date(Date.now() - minAgeDays * 864e5).toISOString().slice(0, 10);
  return store.query(`
    SELECT DISTINCT snap_date, sport FROM prop_snapshots
    WHERE result IS NULL AND settlement_status IS NULL AND snap_date <= ?
    ORDER BY snap_date DESC
  `, [cutoff]);
}

const SETTLEMENT_SOURCE = { mlb: 'statsapi.mlb.com boxscore', nba: 'espn boxscore', nfl: 'espn boxscore', ncaaf: 'espn boxscore' };
const SUPPORTED_SPORTS = new Set(['mlb', 'nba', 'nfl', 'ncaaf']);
// Deliberately NOT in NFL_RESOLVE. ESPN's "kicking" boxscore category shape
// (FG "makes/attempts" format, PTS field semantics) has not been checked
// against a real completed game, so these stay unresolved rather than
// guessed -- do not add resolvers for these without that verification first.
const UNMAPPED_KICKER_STATS = new Set(['fgMade', 'kickingPts']);

// `result` stays the objective over/under/push/dnp outcome used for grading.
// settlement_status/reason/source are bookkeeping ONLY: did we actually
// attempt this row, and if it didn't resolve, why not -- so a later pass (or
// a human) can tell "genuinely tried and the source has no answer" apart
// from "never attempted yet" without re-deriving anything.
const SET_RESULT_SQL = `
  UPDATE prop_snapshots
  SET actual=?, result=?, graded_at=datetime('now'),
      settlement_status=?, settlement_reason=?, settlement_source=?
  WHERE id=?
`;
const SET_UNRESOLVED_SQL = `
  UPDATE prop_snapshots
  SET settlement_status='unresolved', settlement_reason=?, settlement_source=?, graded_at=datetime('now')
  WHERE id=?
`;

async function settleSlate(date, sport) {
  const rows = await store.query(`SELECT id, player, stat, line, dir FROM prop_snapshots WHERE snap_date=? AND sport=? AND result IS NULL`, [date, sport]);
  if (!rows.length) return { date, sport, settled: 0, dnp: 0, unresolved: 0, skipped: 0 };

  if (!SUPPORTED_SPORTS.has(sport)) {
    // A permanent block, not a "try again later" one -- stamp it now so it's
    // distinguishable from a slate that just hasn't had its games finish yet.
    await store.transaction(async (exec) => {
      for (const r of rows) await exec(SET_UNRESOLVED_SQL, [`sport not supported for settlement: ${sport}`, null, r.id]);
    });
    return { date, sport, settled: 0, dnp: 0, unresolved: rows.length, skipped: 0, note: 'sport not supported' };
  }

  let actuals, pick;
  if (sport === 'mlb') {
    actuals = await mlbActualsForDate(date);
    pick = (entry, stat) => {
      const f = MLB_RESOLVE[stat]; if (!f) return undefined;
      const src = MLB_PITCH_STATS.has(stat) ? entry.pitching : entry.batting;
      return src ? f(src) : undefined;
    };
  } else {
    actuals = await espnActualsForDate(sport, date);
    pick = (entry, stat) => {
      if (sport === 'nba') { const f = NBA_RESOLVE[stat]; return (f && entry._nba) ? f(entry._nba) : undefined; }
      const f = NFL_RESOLVE[stat]; return (f && entry._nflGroups) ? f(nflPlayerLine(entry._nflGroups)) : undefined;
    };
  }

  // No completed games for this slate yet (still in progress, or the feed is
  // lagging) — leave every row FULLY untouched (no status stamp either) for
  // a later pass to retry naturally. NEVER mass-DNP, never stamp "tried".
  if (!actuals || !actuals._final) {
    return { date, sport, settled: 0, dnp: 0, unresolved: 0, skipped: rows.length, note: 'no finals yet' };
  }

  const source = SETTLEMENT_SOURCE[sport];
  let settled = 0, dnp = 0, unresolved = 0;
  await store.transaction(async (exec) => {
    for (const r of rows) {
      const entry = actuals[norm(r.player)];
      if (!entry) {
        await exec(SET_RESULT_SQL, [null, 'dnp', 'dnp', 'player not found in completed-game box score', source, r.id]);
        dnp++; continue;
      }
      let v;
      try { v = pick(entry, r.stat); } catch (e) { v = undefined; }
      if (v == null || Number.isNaN(v)) {
        // Genuinely attempted (the player WAS found) but this stat couldn't
        // be extracted -- record why instead of leaving it silently null.
        const unmapped = sport === 'mlb' ? !MLB_RESOLVE[r.stat] : (sport === 'nba' ? !NBA_RESOLVE[r.stat] : !NFL_RESOLVE[r.stat]);
        // NFL/CFB kicker stats (fgMade, kickingPts) hit this path -- ESPN's
        // boxscore "kicking" category shape has never been empirically
        // verified against a completed game, so this is deliberately NOT
        // guessed at. See UNMAPPED_KICKER_STATS below.
        const reason = UNMAPPED_KICKER_STATS.has(r.stat)
          ? 'Unresolved because ESPN kicker field mapping has not been empirically verified.'
          : unmapped ? `unmapped stat key: ${r.stat}` : `value extraction failed for stat: ${r.stat}`;
        await exec(SET_UNRESOLVED_SQL, [reason, source, r.id]);
        unresolved++; continue;
      }
      const res = v > r.line ? 'over' : v < r.line ? 'under' : 'push';
      await exec(SET_RESULT_SQL, [v, res, 'settled', null, source, r.id]);
      settled++;
    }
  });
  return { date, sport, settled, dnp, unresolved, skipped: 0 };
}

async function runSettleSnapshots({ minAgeDays = 1 } = {}) {
  const { flagged } = await flagInvalidFutureDates();
  if (flagged) console.log(`[settle] flagged ${flagged} row(s) with an impossible future snap_date as invalid`);
  const slates = await pending(minAgeDays);
  const results = [];
  for (const { snap_date, sport } of slates) {
    try { results.push(await settleSlate(snap_date, sport)); }
    catch (e) { results.push({ date: snap_date, sport, error: e.message }); }
  }
  const tot = results.reduce((a, r) => ({
    settled: a.settled + (r.settled || 0), dnp: a.dnp + (r.dnp || 0), unresolved: a.unresolved + (r.unresolved || 0)
  }), { settled: 0, dnp: 0, unresolved: 0 });
  console.log(`[settle] ${slates.length} slate(s) → ${tot.settled} settled, ${tot.dnp} DNP, ${tot.unresolved} unresolved`);
  return { slates: results, invalidFlagged: flagged, ...tot };
}

module.exports = { runSettleSnapshots, settleSlate, pending, flagInvalidFutureDates };

if (require.main === module) {
  runSettleSnapshots().then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
