// Pre-release audit: for every sport BeatsEdge covers, hit PropLine (and
// ParlayAPI) live and report which sportsbooks actually have prop lines
// posted for the current slate, how many, and how fresh.
//
//   node scripts/audit-book-coverage.js
//   node scripts/audit-book-coverage.js --sport baseball_mlb --events 6
//
// Uses the same keys the app ships with (the user's own PropLine / ParlayAPI
// keys). No writes, no DB — pure read.

const PROPLINE_KEY = process.env.PROPLINE_KEY || 'd0a9903df442e544949ee2f980b7c1a6';
const PARLAY_KEY = process.env.PARLAY_API_KEY || '053117e00add4a84457034fd9c58d1d5';

const args = process.argv.slice(2);
const argVal = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const ONLY_SPORT = argVal('sport', null);
const MAX_EVENTS = Number(argVal('events', 8));

const SPORTS = [
  { key: 'baseball_mlb', label: 'MLB', markets: ['batter_hits', 'batter_total_bases', 'batter_home_runs', 'batter_rbis', 'batter_runs', 'batter_hits_runs_rbis', 'batter_strikeouts', 'batter_walks', 'batter_stolen_bases', 'pitcher_strikeouts', 'pitcher_earned_runs', 'pitcher_hits_allowed', 'pitcher_outs'] },
  { key: 'basketball_nba', label: 'NBA', markets: ['player_points', 'player_rebounds', 'player_assists', 'player_threes', 'player_points_rebounds_assists', 'player_points_rebounds', 'player_points_assists', 'player_rebounds_assists', 'player_steals', 'player_blocks', 'player_turnovers', 'player_blocks_steals'] },
  { key: 'football_nfl', label: 'NFL', markets: ['player_pass_yds', 'player_pass_tds', 'player_pass_attempts', 'player_pass_completions', 'player_pass_interceptions', 'player_rush_yds', 'player_rush_attempts', 'player_reception_yds', 'player_receptions', 'player_reception_targets', 'player_rush_reception_yds', 'player_anytime_td'] },
  { key: 'football_ncaaf', label: 'CFB', markets: ['player_pass_yds', 'player_pass_tds', 'player_rush_yds', 'player_reception_yds', 'player_receptions', 'player_pass_attempts', 'player_rush_attempts'] },
  { key: 'icehockey_nhl', label: 'NHL', markets: ['player_points', 'player_goals', 'player_assists', 'player_shots_on_goal', 'player_blocked_shots', 'player_power_play_points', 'player_total_saves'] }
];

const DFS = new Set(['prizepicks', 'underdog', 'sleeper', 'parlayplay', 'betr', 'pick6']);
const SBOOK = new Set(['draftkings', 'fanduel', 'betmgm', 'betrivers', 'caesars', 'pinnacle', 'bovada']);
const ALL_BOOKS = [...DFS, ...SBOOK].join(',');

const PL = 'https://api.prop-line.com';
const j = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': 'beatsedge/audit' } });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t.slice(0, 200); }
  return { status: r.status, b };
};
const plGet = (path) => j(`${PL}${path}${path.includes('?') ? '&' : '?'}apiKey=${PROPLINE_KEY}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ago = (iso) => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '?';
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : m < 1440 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`;
};

async function auditSport(s) {
  const line = (msg) => console.log('  ' + msg);
  console.log(`\n━━ ${s.label} (${s.key}) ${'━'.repeat(Math.max(0, 46 - s.label.length - s.key.length))}`);

  const ev = await plGet(`/v1/sports/${s.key}/events`);
  if (ev.status !== 200 || !Array.isArray(ev.b)) {
    line(`✗ PropLine /events → HTTP ${ev.status} ${JSON.stringify(ev.b).slice(0, 120)}`);
    return { sport: s.label, ok: false };
  }
  const events = ev.b;
  const now = Date.now();
  const soon = events.filter(e => {
    const t = Date.parse(e.commence_time || ''); return Number.isFinite(t) && t > now - 6 * 3600e3 && t < now + 30 * 3600e3;
  });
  const times = events.map(e => Date.parse(e.commence_time || '')).filter(Number.isFinite).sort((a, b) => a - b);
  line(`Events: ${events.length} total · ${events.filter(e => e.live).length} live · window ${times.length ? new Date(times[0]).toISOString().slice(0, 16) + 'Z → ' + new Date(times[times.length - 1]).toISOString().slice(0, 16) + 'Z' : '—'}`);
  line(`In the next ~30h: ${soon.length} game(s)`);

  const sample = (soon.length ? soon : events).slice(0, MAX_EVENTS);
  if (!sample.length) { line('No games to probe.'); return { sport: s.label, ok: false, reason: 'no games' }; }

  // book -> { events:Set, mkts:Set, rows, oldest, newest }
  const byBook = {};
  const bump = (bk) => byBook[bk] || (byBook[bk] = { events: new Set(), mkts: new Set(), rows: 0, oldest: Infinity, newest: 0 });

  for (const e of sample) {
    let od;
    try { od = await plGet(`/v1/sports/${s.key}/events/${e.id}/odds?markets=${s.markets.join(',')}&bookmakers=${ALL_BOOKS}`); }
    catch (err) { continue; }
    const bms = (od.b && od.b.bookmakers) || [];
    for (const bm of bms) {
      const b = bump(bm.key);
      b.events.add(e.id);
      for (const m of (bm.markets || [])) {
        b.mkts.add(m.key);
        b.rows += (m.outcomes || []).length;
        const t = Date.parse(m.last_update || bm.last_update || '');
        if (Number.isFinite(t)) { b.oldest = Math.min(b.oldest, t); b.newest = Math.max(b.newest, t); }
      }
    }
    await sleep(150);
  }

  const books = Object.keys(byBook).sort((a, b) => byBook[b].rows - byBook[a].rows);
  if (!books.length) { line('⚠ No book returned any prop line for the sampled games.'); return { sport: s.label, ok: false, reason: 'no lines' }; }

  line('');
  line('book           kind   games  markets  prop-rows  freshest  stalest');
  line('─'.repeat(70));
  for (const bk of books) {
    const b = byBook[bk];
    const kind = DFS.has(bk) ? 'DFS' : SBOOK.has(bk) ? 'book' : '?';
    line(
      `${bk.padEnd(14)} ${kind.padEnd(5)} ${String(b.events.size).padStart(5)} ${String(b.mkts.size).padStart(8)} ${String(b.rows).padStart(10)}` +
      `  ${(b.newest ? ago(new Date(b.newest).toISOString()) : '—').padStart(8)}  ${(b.oldest !== Infinity ? ago(new Date(b.oldest).toISOString()) : '—').padStart(7)}`
    );
  }

  // ParlayAPI second opinion
  try {
    const pr = await j(`https://parlay-api.com/v1/sports/${s.key}/props?apiKey=${PARLAY_KEY}`);
    if (Array.isArray(pr.b)) {
      const pbooks = {};
      pr.b.forEach(row => { const bk = row.book || row.bookmaker || row.sportsbook; if (bk) pbooks[bk] = (pbooks[bk] || 0) + 1; });
      line('');
      line('ParlayAPI: ' + (Object.keys(pbooks).length ? Object.entries(pbooks).map(([k, v]) => `${k} ${v}`).join(' · ') : `${pr.b.length} rows, no book field`));
    } else {
      line(`ParlayAPI: HTTP ${pr.status}`);
    }
  } catch (e) { line('ParlayAPI: unreachable (' + e.message + ')'); }

  // verdict
  const dfsWithLines = books.filter(bk => DFS.has(bk) && byBook[bk].rows > 0);
  const freshest = Math.max(...books.map(bk => byBook[bk].newest || 0));
  const fresh = freshest && (Date.now() - freshest) < 12 * 3600e3;
  const pass = dfsWithLines.includes('prizepicks') && fresh;
  line('');
  line(`${pass ? '✅ PASS' : '⚠️  CHECK'} — ${dfsWithLines.length} DFS book(s) with lines${dfsWithLines.length ? ' (' + dfsWithLines.join(', ') + ')' : ''}; ${fresh ? 'lines updated within 12h' : 'newest line is stale / missing'}.`);
  return { sport: s.label, ok: pass, dfsBooks: dfsWithLines, fresh };
}

(async () => {
  console.log(`BeatsEdge — sportsbook prop-line coverage audit  ·  ${new Date().toISOString()}`);
  console.log(`PropLine key …${PROPLINE_KEY.slice(-6)}  ·  sampling up to ${MAX_EVENTS} games/sport`);
  const list = ONLY_SPORT ? SPORTS.filter(s => s.key === ONLY_SPORT || s.label.toLowerCase() === ONLY_SPORT.toLowerCase()) : SPORTS;
  const results = [];
  for (const s of list) {
    try { results.push(await auditSport(s)); }
    catch (e) { console.log(`\n━━ ${s.label} — ERROR: ${e.message}`); results.push({ sport: s.label, ok: false, error: e.message }); }
  }
  console.log('\n\n════════ SUMMARY ════════');
  for (const r of results) {
    console.log(`${(r.ok ? '✅' : '⚠️ ')} ${String(r.sport).padEnd(5)} ${r.ok ? 'ready — ' + (r.dfsBooks || []).join(', ') : (r.reason || r.error || 'needs a look')}`);
  }
  const bad = results.filter(r => !r.ok);
  console.log(bad.length ? `\n${bad.length} sport(s) need a look before release.` : `\nAll sports have fresh DFS prop lines. 🚀`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
