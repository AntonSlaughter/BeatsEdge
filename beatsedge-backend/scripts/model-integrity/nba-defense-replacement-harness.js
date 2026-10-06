// NBA DEFENSE -- FINAL REPLACEMENT VALIDATION.  PLAYER-STAT PREDICTION VALIDATION ONLY (no sportsbook lines exist locally; nothing here
// is betting-edge, EV or profitability evidence). Production is NOT modified: the real `calculateEdgeScore` is extracted from BeatsEdge.html
// and run in a Node vm; the candidate hook below is a TEST-ONLY source transform.
//
// ============================== PREDECLARED (fixed before any result was seen) ==============================
// Baseline  C : the otherwise-identical production NBA model with NO defense adjustment (opponentDefense = null).
// Existing  A : current production (generic points-rank nudge + stat-specific factor/multiplier).
// Existing  B : stat-specific only (generic nudge disabled).
// Candidates (the ONLY new constructions; no windows/weights are searched):
//   D1  PROP-SPECIFIC continuous allowance ratio, group G/F/C, pass-through fixed at 1.0:
//         proj_D1 = proj_C * R,  R = a*/L,  a* = (sum_T + k*L)/(n_T + k)   (opponent's as-of per-team-game allowance of the TARGET stat to
//         the player's position group, shrunk toward the league mean L with k = 20 pseudo team-games; NOT a rank).
//         Combos: R = sum_j a*_j / sum_j L_j over the component stats (derived from components -- no invented weights).
//   D2  (PRIMARY candidate) same R, pass-through beta fitted by closed-form OLS on STRICTLY EARLIER seasons only:
//         actual - proj_C = beta * proj_C * (R-1) + e ;  proj_D2 = proj_C * (1 + beta*(R-1)).
//   D3  RANK representation of the same stat (own-stat rank among team x group cells, 1-150, combos from the summed allowance), beta fitted the
//         same walk-forward way:  proj_D3 = proj_C * (1 + beta * (rank-75.5)/74.5).  Answers "continuous vs rank".
//   D2r (SECONDARY, position/role) D2 with role cells G/F/C x {starter, bench} (role predicted from the player's own prior-10 starter rate;
//         allowance cells use each historical game's actual starter flag).  Adopted over D2 only if it beats D2 (99% CI) -- never because it looks better.
//   Finer positions (PG/SG/SF/PF/C): NOT historically reliable across 2021-2025 (only ~5% of 2025 rows carry them) => not tested; counts are printed.
// Total variants per prop family: 7 (C, A, B, D1, D2, D3, D2r); k = 20 chosen a priori; beta closed-form (no search). No other variants were run.
// Multiplicative placement is scale-free: the adjustment is a fraction of the prop's OWN projection, so a 0.5 BLK projection can never receive
// a 25-PTS-sized shift (magnitudes in stat units are reported per family).
//
// DECISION RULES (predeclared; computed mechanically):  REPLACE needs D2 vs C: (1) MAE improvement with 99% date-block-bootstrap CI upper bound < 0
//   and >= 0.25% relative; (2) MSE improvement CI upper bound < 0; (3) improvement in >= 4 of 5 test seasons; (4) no position group (G/F/C) with
//   99% CI showing it significantly WORSE; (5) Brier not significantly worse. Else KEEP CURRENT if A or B passes the same tests vs C and is not
//   significantly worse than D2; else REMOVE DEFENSE; INSUFFICIENT EVIDENCE only if the test N < 20,000.
// 99% intervals are used for decisions because 12 families are judged (conservative multiplicity guard); 95% shown in tables.
//
// STRICT AS-OF: opponent allowance uses only games whose date < target date within the same regular season (snapshot is taken BEFORE a date's
// games are added); player windows use only earlier games; beta for test season s is fit on seasons < s. Proofs (brute-force recomputation and a
// future-perturbation test) run first and are written to the report.
//
//   node scripts/model-integrity/nba-defense-replacement-harness.js [--per-season 20000] [--boot 600] [--seed 20261006] [--out tmp/model-integrity/nba-defense-replacement]

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadModel } = require('../lib/loadBeatsEdgeModel');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const PER_SEASON = Number(arg('per-season', 20000)), BOOT = Number(arg('boot', 600)), SEED = Number(arg('seed', 20261006));
const OUT = path.resolve(__dirname, '..', '..', arg('out', 'tmp/model-integrity/nba-defense-replacement'));
const TRAIN_SEASONS = [2020], TEST_SEASONS = [2021, 2022, 2023, 2024, 2025], ALL_SEASONS = TRAIN_SEASONS.concat(TEST_SEASONS);
const K_SHRINK = 20, MIN_TEAM_GAMES = 10, MIN_PRIOR_GAMES = 10, HIST_N = 40, MIN_AVG_MIN = 15;
const MIN_REL_IMPROVEMENT = 0.0025, MIN_TEST_N = 20000;

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(SEED);

// ---------------------------------------------------------------- models
const GENERIC_BLOCK = "if (posDefense && posDefense.rank !== undefined && sport !== 'nfl' && sport !== 'ncaaf') {";
const HOOK_ANCHOR = '// MLB batter: nudge by the platoon';
const mA = loadModel();
const mB = loadModel({ transform: (src) => { if (!src.includes(GENERIC_BLOCK)) throw new Error('generic block anchor missing'); return src.replace(GENERIC_BLOCK, 'if (false) {'); } });
// TEST-ONLY hook: an external multiplier applied at the SAME place as production's stat-specific NBA multiplier (after it, before the MLB block).
const mD = loadModel({ transform: (src) => { if (!src.includes(HOOK_ANCHOR)) throw new Error('hook anchor missing'); return src.replace(HOOK_ANCHOR, 'if (player.__defMult) projection *= player.__defMult;\n            ' + HOOK_ANCHOR); } });

// ---------------------------------------------------------------- stats
const GET = [r => r.points, r => r.rebounds, r => r.assists, r => r.threes, r => r.steals, r => r.blocks, r => r.turnovers];
const NSTAT = 7;
const FAMILIES = {
  points: { label: 'PTS', idx: [0] }, rebounds: { label: 'REB', idx: [1] }, assists: { label: 'AST', idx: [2] }, threes: { label: '3PM', idx: [3] },
  steals: { label: 'STL', idx: [4] }, blocks: { label: 'BLK', idx: [5] }, turnovers: { label: 'TOV', idx: [6] },
  pra: { label: 'PRA', idx: [0, 1, 2], combo: true }, pr: { label: 'PR', idx: [0, 1], combo: true }, pa: { label: 'PA', idx: [0, 2], combo: true },
  ra: { label: 'RA', idx: [1, 2], combo: true }, blocksSteals: { label: 'BLK+STL', idx: [5, 4], combo: true },
};
const valueOf = (idx) => (r) => idx.reduce((s, j) => s + GET[j](r), 0);
const GROUPS = ['G', 'F', 'C'], NCELL = 9;
const cellG = (g) => GROUPS.indexOf(g), cellR = (g, starter) => 3 + 2 * GROUPS.indexOf(g) + (starter ? 0 : 1);

// ---------------------------------------------------------------- data
const db = new DatabaseSync(path.resolve(__dirname, '..', '..', 'data', 'beatsedge.db'), { readOnly: true });
const allRaw = db.prepare(`SELECT game_id, athlete_id, season, game_date, team, opponent, pos_group, starter, minutes, points, rebounds, assists, threes, steals, blocks, turnovers
  FROM nba_player_box WHERE season_type = 2 AND played = 1 AND minutes > 0 AND season >= ? AND pos_group IN ('G','F','C') AND points IS NOT NULL AND rebounds IS NOT NULL AND assists IS NOT NULL
  AND threes IS NOT NULL AND steals IS NOT NULL AND blocks IS NOT NULL AND turnovers IS NOT NULL ORDER BY game_date, game_id`).all(Math.min(...ALL_SEASONS) - 1);
// DATA HYGIENE (found by the as-of proof below, which flagged same-date history rows): the table contains (a) All-Star/exhibition pseudo-teams
// (STRIPES/STARS/WORLD/EAST/WEST/...) filed as regular season, and (b) team-dates with two different game_ids (corrupt/duplicated game rows).
// Both are dropped everywhere (allowances AND player histories) and counted in the report.
const teamSeasons = new Map(); allRaw.forEach(r => { let s = teamSeasons.get(r.team); if (!s) teamSeasons.set(r.team, s = new Set()); s.add(r.season); });
const realTeams = new Set([...teamSeasons].filter(([, s]) => s.size >= 5).map(([t]) => t));
const tdGames = new Map(); allRaw.forEach(r => { const k = r.team + '|' + r.game_date; let s = tdGames.get(k); if (!s) tdGames.set(k, s = new Set()); s.add(r.game_id); });
const badTeamDates = new Set([...tdGames].filter(([, s]) => s.size > 1).map(([k]) => k));
const hygiene = { rawRows: allRaw.length, nonNbaTeamRows: 0, duplicatedTeamDateRows: 0 };
const all = allRaw.filter(r => {
  if (!realTeams.has(r.team) || !realTeams.has(r.opponent)) { hygiene.nonNbaTeamRows++; return false; }
  if (badTeamDates.has(r.team + '|' + r.game_date) || badTeamDates.has(r.opponent + '|' + r.game_date)) { hygiene.duplicatedTeamDateRows++; return false; }
  return true;
});
console.log('hygiene', JSON.stringify(hygiene), 'real teams', realTeams.size);
const finePos = db.prepare(`SELECT season, COUNT(*) n, SUM(CASE WHEN pos IN ('PG','SG','SF','PF') THEN 1 ELSE 0 END) fine FROM nba_player_box WHERE season_type = 2 AND season >= 2021 GROUP BY season`).all();
const fingerprint = { rows: all.length, from: all[0].game_date, to: all[all.length - 1].game_date, sumPts: all.reduce((s, r) => s + r.points, 0) };
console.log('data', JSON.stringify(fingerprint));

// ---------------------------------------------------------------- as-of snapshots
// snapshot(season,date) = state of every team's allowance cells using ONLY games with date < `date` of that season.
function buildSnaps(rows) {
  const bySeason = new Map();
  rows.forEach(r => { let s = bySeason.get(r.season); if (!s) bySeason.set(r.season, s = new Map()); let d = s.get(r.game_date); if (!d) s.set(r.game_date, d = []); d.push(r); });
  const snaps = new Map();
  for (const [season, dates] of bySeason) {
    const teams = new Map(); const league = new Float64Array(NCELL * NSTAT); let leagueN = 0;
    for (const date of [...dates.keys()].sort()) {
      const snap = { teams: new Map(), league: Float64Array.from(league), leagueN };
      teams.forEach((o, t) => snap.teams.set(t, { n: o.games.size, a: Float64Array.from(o.a) }));
      snaps.set(season + '|' + date, snap);
      dates.get(date).forEach(r => {
        let o = teams.get(r.opponent); if (!o) teams.set(r.opponent, o = { games: new Set(), a: new Float64Array(NCELL * NSTAT) });
        if (!o.games.has(r.game_id)) { o.games.add(r.game_id); leagueN++; }
        const g = cellG(r.pos_group), rc = cellR(r.pos_group, r.starter === 1);
        for (let j = 0; j < NSTAT; j++) { const v = GET[j](r); o.a[g * NSTAT + j] += v; o.a[rc * NSTAT + j] += v; league[g * NSTAT + j] += v; league[rc * NSTAT + j] += v; }
      });
    }
  }
  return snaps;
}
const SNAPS = buildSnaps(all);
const snapOf = (season, date) => SNAPS.get(season + '|' + date) || null;
function eligibleSnap(snap) { if (!snap) return false; let c = 0; snap.teams.forEach(o => { if (o.n >= MIN_TEAM_GAMES) c++; }); return c >= 20; }

function ratio(snap, T, cell, idx, k) {
  const t = snap.teams.get(T); if (!t || t.n < MIN_TEAM_GAMES || !(snap.leagueN > 0)) return null;
  let sumT = 0, L = 0; idx.forEach(j => { sumT += t.a[cell * NSTAT + j]; L += snap.league[cell * NSTAT + j] / snap.leagueN; });
  if (!(L > 0)) return null;
  return ((sumT + k * L) / (t.n + k)) / L;
}
const rankCache = new Map();
function rank150(snap, snapKey, idx, T, group) {            // own-stat (or combined) rank among eligible team x group cells, scaled to the app's 1-150 range; 1 = lowest allowed
  const ck = snapKey + '|' + idx.join(','); let m = rankCache.get(ck);
  if (!m) {
    const cells = []; snap.teams.forEach((o, t) => { if (o.n < MIN_TEAM_GAMES) return; GROUPS.forEach((g, gi) => cells.push({ key: t + '|' + g, v: idx.reduce((s, j) => s + o.a[gi * NSTAT + j], 0) / o.n })); });
    cells.sort((a, b) => a.v - b.v || (a.key < b.key ? -1 : 1)); m = new Map(); const n = cells.length;
    cells.forEach((c, i) => m.set(c.key, n > 1 ? 1 + i * 149 / (n - 1) : 75.5)); rankCache.set(ck, m);
  }
  const v = m.get(T + '|' + group); return v == null ? null : v;
}
function oppDefenseObj(snap, snapKey, T) {                 // production-shaped object for variants A/B (ranks 1-150 per stat, G/F/C)
  const by = {};
  for (const g of GROUPS) {
    const r = (j) => rank150(snap, snapKey, [j], T, g); const rk = [0, 1, 2, 3, 4, 5, 6].map(r); if (rk.some(x => x == null)) return null;
    by[g] = { rank: Math.round(rk[0]), rebRank: Math.round(rk[1]), astRank: Math.round(rk[2]), tpmRank: Math.round(rk[3]), stlRank: Math.round(rk[4]), blkRank: Math.round(rk[5]), toRank: Math.round(rk[6]),
      pointsAllowed: 0, reboundsAllowed: 0, assistsAllowed: 0, threesAllowed: 0, stealsAllowed: 0, blocksAllowed: 0, turnoversAllowed: 0 };
  }
  return { byPosition: by };
}

// ---------------------------------------------------------------- LEAKAGE PROOFS
const proof = { lines: [] };
const P = (s) => { proof.lines.push(s); console.log(s); };
function bruteAllowance(season, date, T, group, idx) {       // independent recomputation straight from the raw rows with an explicit `date < target` filter
  let sumT = 0; const games = new Set(); let leagueSum = 0; const leagueGames = new Set();
  for (const r of all) {
    if (r.season !== season || !(r.game_date < date)) continue;
    const v = idx.reduce((s, j) => s + GET[j](r), 0);
    if (r.pos_group === group) leagueSum += v;
    leagueGames.add(r.opponent + '#' + r.game_id);
    if (r.opponent === T) { games.add(r.game_id); if (r.pos_group === group) sumT += v; }
  }
  return { sumT, n: games.size, L: leagueSum / leagueGames.size };
}
{
  P('## As-of proofs');
  const rr = rng(SEED ^ 0xabc), picks = [];
  for (let i = 0; i < 300; i++) { const r = all[Math.floor(rr() * all.length)]; if (!TEST_SEASONS.includes(r.season)) { i--; continue; } picks.push(r); }
  let maxDiff = 0, checked = 0;
  for (const r of picks) {
    const snap = snapOf(r.season, r.game_date); if (!snap) continue; const t = snap.teams.get(r.opponent); if (!t) continue;
    const idx = [[0], [1, 2], [5, 4]][checked % 3], g = cellG(r.pos_group);
    const b = bruteAllowance(r.season, r.game_date, r.opponent, r.pos_group, idx);
    const inc = idx.reduce((s, j) => s + t.a[g * NSTAT + j], 0), incL = idx.reduce((s, j) => s + snap.league[g * NSTAT + j] / snap.leagueN, 0);
    maxDiff = Math.max(maxDiff, Math.abs(inc - b.sumT), Math.abs(t.n - b.n), Math.abs(incL - b.L)); checked++;
  }
  P(`1. brute-force recomputation (explicit game_date < target filter) vs the incremental snapshot: ${checked} random target games x {sums, team-games, league mean}; max abs difference = ${maxDiff.toExponential(2)} ${maxDiff < 1e-9 ? '(IDENTICAL)' : '(MISMATCH!)'}`);
  if (maxDiff >= 1e-9) throw new Error('as-of proof 1 failed');
  // 2. future-perturbation: inflate every stat of every row on/after a cutoff date x1000, rebuild everything, snapshots up to the cutoff must be identical.
  let perturbOk = true;
  for (const cutoff of ['2022-12-01', '2023-12-01', '2024-12-01']) {
    const pert = all.map(r => r.game_date >= cutoff ? Object.assign({}, r, { points: r.points * 1000, rebounds: r.rebounds * 1000, assists: r.assists * 1000, threes: r.threes * 1000, steals: r.steals * 1000, blocks: r.blocks * 1000, turnovers: r.turnovers * 1000 }) : r);
    const S2 = buildSnaps(pert); let same = 0, diffAfter = 0, bad = 0;
    for (const [k, s1] of SNAPS) {
      const date = k.split('|')[1], s2 = S2.get(k); if (!s2) { bad++; continue; }
      const equal = s1.leagueN === s2.leagueN && s1.league.every((v, i) => v === s2.league[i]) && [...s1.teams].every(([t, o]) => { const o2 = s2.teams.get(t); return o2 && o2.n === o.n && o.a.every((v, i) => v === o2.a[i]); });
      if (date <= cutoff) { if (equal) same++; else bad++; } else if (!equal) diffAfter++;
    }
    P(`2. future-perturbation at ${cutoff}: ${same} snapshots dated <= cutoff unchanged after x1000 inflating all later games; mismatches=${bad}; later snapshots that DO change (sanity: perturbation is visible)=${diffAfter}`);
    if (bad) perturbOk = false;
  }
  if (!perturbOk) throw new Error('as-of proof 2 failed');
}

// ---------------------------------------------------------------- sample (as-of eligibility only; never conditioned on the target outcome)
const byPlayer = new Map(); all.forEach(r => { let a = byPlayer.get(r.athlete_id); if (!a) byPlayer.set(r.athlete_id, a = []); a.push(r); });
const samples = [];
for (const season of ALL_SEASONS) {
  const elig = [];
  for (const [pid, rows] of byPlayer) for (let i = MIN_PRIOR_GAMES; i < rows.length; i++) {
    const r = rows[i]; if (r.season !== season) continue;
    const prior = rows.slice(Math.max(0, i - HIST_N), i), m10 = prior.slice(-10);
    if (m10.reduce((s, x) => s + x.minutes, 0) / m10.length < MIN_AVG_MIN) continue;
    const snap = snapOf(season, r.game_date); if (!eligibleSnap(snap)) continue; const t = snap.teams.get(r.opponent); if (!t || t.n < MIN_TEAM_GAMES) continue;
    elig.push({ pid, i });
  }
  for (let k = elig.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [elig[k], elig[j]] = [elig[j], elig[k]]; }
  const take = elig.slice(0, PER_SEASON); console.log(`season ${season}: eligible ${elig.length}, sampled ${take.length}${TRAIN_SEASONS.includes(season) ? ' (TRAIN ONLY)' : ''}`);
  take.forEach(e => samples.push({ season, rows: byPlayer.get(e.pid), i: e.i }));
}
{ // 3. every player-history row used is strictly earlier than the target game
  let viol = 0; samples.forEach(s => { const r = s.rows[s.i]; s.rows.slice(Math.max(0, s.i - HIST_N), s.i).forEach(x => { if (!(x.game_date < r.game_date) || x.athlete_id !== r.athlete_id) viol++; }); });
  P(`3. player-history windows: ${samples.length} samples checked, rows with game_date >= target date or other athlete = ${viol} ${viol === 0 ? '(NONE)' : '(LEAK!)'}`);
  if (viol) throw new Error('history leak');
}

// ---------------------------------------------------------------- helpers
const mean = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const clip = (p) => Math.min(0.999, Math.max(0.001, p));
function pseudoLine(hv) { const avg = mean(hv); let line = null, best = 99; for (let c = 0.5; c <= avg * 2.2 + 1; c += 1) { const over = hv.filter(v => v > c).length / hv.length; const gap = Math.abs(over - 0.48); if (gap < best) { best = gap; line = c; } } return line; }
function bootDiff(recs, fn) {
  const byDate = new Map(); recs.forEach(r => { let o = byDate.get(r.date); if (!o) byDate.set(r.date, o = { s: 0, n: 0 }); o.s += fn(r); o.n++; });
  const blocks = [...byDate.values()], N = recs.length; const est = blocks.reduce((s, b) => s + b.s, 0) / N; const r2 = rng(SEED ^ 0x9e3779b1), ss = [];
  for (let b = 0; b < BOOT; b++) { let s = 0, n = 0; for (let k = 0; k < blocks.length; k++) { const bl = blocks[Math.floor(r2() * blocks.length)]; s += bl.s; n += bl.n; } ss.push(s / n); }
  ss.sort((a, c) => a - c); const q = (p) => ss[Math.min(BOOT - 1, Math.max(0, Math.floor(p * BOOT)))];
  return { est, lo95: q(0.025), hi95: q(0.975), lo99: q(0.005), hi99: q(0.995) };
}
const absd = (x, y) => (r) => Math.abs(r[x] - r.actual) - Math.abs(r[y] - r.actual);
const sqd = (x, y) => (r) => (r[x] - r.actual) ** 2 - (r[y] - r.actual) ** 2;
const brd = (x, y) => (r) => (clip(r[x]) - r.hit) ** 2 - (clip(r[y]) - r.hit) ** 2;
function metr(recs, k) { const e = recs.map(r => r[k] - r.actual); return { mae: mean(e.map(Math.abs)), rmse: Math.sqrt(mean(e.map(v => v * v))), bias: mean(e) }; }
function probM(recs, k) {
  const p = recs.map(r => clip(r[k])), y = recs.map(r => r.hit); const brier = mean(p.map((v, i) => (v - y[i]) ** 2));
  const bk = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 })); p.forEach((v, i) => { const b = bk[Math.min(9, Math.floor(v * 10))]; b.n++; b.p += v; b.y += y[i]; });
  const ece = bk.reduce((s, b) => s + (b.n ? (b.n / p.length) * Math.abs(b.p / b.n - b.y / b.n) : 0), 0);
  const x = p.map(v => Math.log(v / (1 - v))); let a = 0, b = 1;
  for (let it = 0; it < 25; it++) { let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0; for (let i = 0; i < x.length; i++) { const q = 1 / (1 + Math.exp(-(a + b * x[i]))), w = q * (1 - q); g0 += y[i] - q; g1 += (y[i] - q) * x[i]; h00 += w; h01 += w * x[i]; h11 += w * x[i] * x[i]; } const det = h00 * h11 - h01 * h01; if (Math.abs(det) < 1e-12) break; a += (h11 * g0 - h01 * g1) / det; b += (-h01 * g0 + h00 * g1) / det; }
  return { brier, ece, calSlope: b };
}
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };
const adjDist = (recs, k) => { const d = recs.map(r => r[k] - r.pC), ab = d.map(Math.abs); return { meanAbs: mean(ab), mean: mean(d), p05: pct(d, 0.05), p50: pct(d, 0.5), p95: pct(d, 0.95), maxAbs: Math.max(...ab), relMeanAbsPct: mean(ab) / mean(recs.map(r => r.pC)) * 100 }; };

// ---------------------------------------------------------------- run per family
const results = {}; const t0 = Date.now(); let variantsEvaluated = 0;
for (const [statKey, fam] of Object.entries(FAMILIES)) {
  const getV = valueOf(fam.idx); const recs = [];
  const build = (s) => {
    const r = s.rows[s.i], prior = s.rows.slice(Math.max(0, s.i - HIST_N), s.i), hv = prior.map(getV);
    if (mean(hv) <= 0) return null; const line = pseudoLine(hv); if (line == null || line <= 0) return null;
    const actual = getV(r); if (actual === line) return null;
    return { r, prior, hv, line, actual, w: mA.btWindowsAsOf(hv, prior.map(x => x.opponent), r.opponent, line) };
  };
  const call = (model, b, defense, mult) => model.calculateEdgeScore({ id: 'h', sport: 'nba', position: b.r.pos_group, opponent: b.r.opponent, statsByKey: { [statKey]: b.w }, opponentDefense: defense, oppDef: null, situational: null, props: [], __defMult: mult || null },
    { statKey, type: statKey, line: b.line, direction: 'over', lineSource: 'backtest' });
  // pass 1: baseline C, current A/B, and the as-of features
  const idxMap = [];
  samples.forEach((s, si) => {
    const b = build(s); if (!b) return;
    const season = s.season, date = b.r.game_date, T = b.r.opponent, g = b.r.pos_group, snap = snapOf(season, date), key = season + '|' + date;
    const eC = call(mD, b, null, null); if (eC.insufficientData) return;
    const od = oppDefenseObj(snap, key, T); if (!od) return;
    const eA = call(mA, b, od, null), eB = call(mB, b, od, null);
    const starterRate = mean(b.prior.slice(-10).map(x => x.starter === 1 ? 1 : 0)), role = starterRate >= 0.5;
    const R = ratio(snap, T, cellG(g), fam.idx, K_SHRINK), Rr = ratio(snap, T, cellR(g, role), fam.idx, K_SHRINK), rk = rank150(snap, key, fam.idx, T, g);
    if (R == null || Rr == null || rk == null) return;
    recs.push({ si, season, date, g, role: role ? 'S' : 'B', actual: b.actual, line: b.line, hit: b.actual > b.line ? 1 : 0, pC: eC.projection, probC: eC.modelProbPct / 100, pA: eA.projection, probA: eA.modelProbPct / 100, pB: eB.projection, probB: eB.modelProbPct / 100,
      R, Rr, xr: (rk - 75.5) / 74.5 });
  });
  // walk-forward beta (closed form, strictly earlier seasons)
  const fitBeta = (testSeason, zf) => { let num = 0, den = 0; recs.forEach(r => { if (r.season >= testSeason) return; const z = zf(r); num += (r.actual - r.pC) * z; den += z * z; }); return den > 0 ? num / den : 0; };
  const betas = {}; const zD2 = r => r.pC * (r.R - 1), zD3 = r => r.pC * r.xr, zD2r = r => r.pC * (r.Rr - 1);
  TEST_SEASONS.forEach(ts => { betas[ts] = { D2: fitBeta(ts, zD2), D3: fitBeta(ts, zD3), D2r: fitBeta(ts, zD2r) }; });
  { const trainMax = Math.max(...recs.filter(r => r.season < TEST_SEASONS[0]).map(r => r.season)); if (!(trainMax < TEST_SEASONS[0])) throw new Error('train/test season overlap'); }
  // pass 2: candidate projections through the real engine (hook multiplier), TEST seasons only
  const test = recs.filter(r => TEST_SEASONS.includes(r.season));
  test.forEach(rc => {
    const b = build(samples[rc.si]); const bt = betas[rc.season];
    const run = (m) => { const e = call(mD, b, null, Math.max(0.5, m)); return e; };
    const e1 = run(rc.R), e2 = run(1 + bt.D2 * (rc.R - 1)), e3 = run(1 + bt.D3 * rc.xr), e4 = run(1 + bt.D2r * (rc.Rr - 1));
    rc.pD1 = e1.projection; rc.probD1 = e1.modelProbPct / 100; rc.pD2 = e2.projection; rc.probD2 = e2.modelProbPct / 100; rc.pD3 = e3.projection; rc.probD3 = e3.modelProbPct / 100; rc.pD2r = e4.projection; rc.probD2r = e4.modelProbPct / 100;
  });
  variantsEvaluated += 7;
  const R = { label: fam.label, combo: !!fam.combo, n: test.length, trainN: recs.length - test.length, betas, variants: {}, diffs: {}, seasons: {}, groups: {}, roles: {}, adj: {}, prob: {} };
  ['pC', 'pA', 'pB', 'pD1', 'pD2', 'pD3', 'pD2r'].forEach(k => R.variants[k] = metr(test, k));
  ['A', 'B', 'D1', 'D2', 'D3', 'D2r'].forEach(v => { R.diffs[v] = { mae: bootDiff(test, absd('p' + v, 'pC')), mse: bootDiff(test, sqd('p' + v, 'pC')), brier: bootDiff(test, brd('prob' + v, 'probC')) }; });
  R.diffs['D2r-D2'] = { mae: bootDiff(test, absd('pD2r', 'pD2')) }; R.diffs['A-D2'] = { mae: bootDiff(test, absd('pA', 'pD2')) }; R.diffs['B-D2'] = { mae: bootDiff(test, absd('pB', 'pD2')) };
  ['pC', 'pD2'].forEach(k => R.prob[k] = probM(test, 'prob' + k.slice(1))); R.prob.pA = probM(test, 'probA');
  TEST_SEASONS.forEach(ts => { const sr = test.filter(r => r.season === ts); R.seasons[ts] = { n: sr.length, D2: mean(sr.map(absd('pD2', 'pC'))), D1: mean(sr.map(absd('pD1', 'pC'))), D3: mean(sr.map(absd('pD3', 'pC'))), A: mean(sr.map(absd('pA', 'pC'))), B: mean(sr.map(absd('pB', 'pC'))), maeC: metr(sr, 'pC').mae }; });
  GROUPS.forEach(g => { const sr = test.filter(r => r.g === g); R.groups[g] = { n: sr.length, D2: bootDiff(sr, absd('pD2', 'pC')), maeC: metr(sr, 'pC').mae }; });
  ['S', 'B'].forEach(ro => { const sr = test.filter(r => r.role === ro); R.roles[ro] = { n: sr.length, D2: bootDiff(sr, absd('pD2', 'pC')), maeC: metr(sr, 'pC').mae }; });
  ['pA', 'pB', 'pD1', 'pD2', 'pD3'].forEach(k => R.adj[k] = adjDist(test, k)); R.meanProj = mean(test.map(r => r.pC));
  // decision (mechanical)
  const passes = (v) => { const d = R.diffs[v]; const rel = -d.mae.est / R.variants.pC.mae;
    const c1 = d.mae.hi99 < 0 && rel >= MIN_REL_IMPROVEMENT, c2 = d.mse.hi99 < 0, wins = TEST_SEASONS.filter(ts => R.seasons[ts][v] != null && R.seasons[ts][v] < 0).length, c3 = wins >= 4;
    let c4 = true; if (v === 'D2') c4 = GROUPS.every(g => !(R.groups[g].D2.lo99 > 0)); const c5 = !(d.brier.lo99 > 0);
    return { pass: c1 && c2 && c3 && c4 && c5, c1, c2, c3, c4, c5, rel, wins }; };
  R.gate = { D2: passes('D2'), A: passes('A'), B: passes('B') };
  const currentBest = (R.gate.A.pass || R.gate.B.pass);
  const currentVsD2 = (v) => R.diffs[v + '-D2'].mae.hi99 < 0;
  R.decision = test.length < MIN_TEST_N ? 'INSUFFICIENT EVIDENCE'
    : R.gate.D2.pass ? ((R.gate.A.pass && currentVsD2('A')) || (R.gate.B.pass && currentVsD2('B')) ? 'KEEP CURRENT' : 'REPLACE WITH PROP-SPECIFIC DEFENSE')
      : currentBest ? 'KEEP CURRENT' : 'REMOVE DEFENSE';
  results[statKey] = R;
  console.log(`${fam.label.padEnd(8)} N=${test.length} MAE C ${R.variants.pC.mae.toFixed(4)} D2 ${R.variants.pD2.mae.toFixed(4)} dMAE(D2-C) ${R.diffs.D2.mae.est.toFixed(5)} [${R.diffs.D2.mae.lo99.toFixed(5)},${R.diffs.D2.mae.hi99.toFixed(5)}] -> ${R.decision}  (${Math.round((Date.now() - t0) / 1000)}s)`);
}

// ---------------------------------------------------------------- report
fs.mkdirSync(OUT, { recursive: true });
const meta = { generated: new Date().toISOString(), seasonsTest: TEST_SEASONS, trainOnlySeasons: TRAIN_SEASONS, perSeason: PER_SEASON, seed: SEED, bootstrap: BOOT, kShrink: K_SHRINK, variantsPerFamily: 7, familiesTested: Object.keys(FAMILIES).length, variantEvaluations: variantsEvaluated, fingerprint, hygiene, finePositionAvailability: finePos };
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ meta, proof: proof.lines, results }, null, 1));
const f = (x, d = 3) => (x == null || Number.isNaN(x)) ? '--' : x.toFixed(d);
const ci95 = (o, d = 4) => `${f(o.est, d)} [${f(o.lo95, d)}, ${f(o.hi95, d)}]`;
let md = `# NBA defense — final replacement validation (PLAYER-STAT PREDICTION ONLY)\n\n> Not sportsbook edge/EV/profitability evidence. No historical sportsbook lines exist locally; the "line" in probability metrics is the app's own synthetic pseudo-line.\n\n`;
md += `Test seasons 2021–2025 (walk-forward; 2020 used as training-only for the fitted pass-through). ${PER_SEASON.toLocaleString()} as-of-eligible player-games per season, seed ${SEED}, date-block bootstrap ×${BOOT}. Variants per family: **7** (C, A, B, D1, D2, D3, D2r); families: 12; k=${K_SHRINK} fixed a priori; no windows/weights searched.\n\n`;
md += `Data hygiene (caught by the as-of proof): dropped ${hygiene.nonNbaTeamRows} rows with non-NBA pseudo-teams (All-Star/exhibition filed as regular season) and ${hygiene.duplicatedTeamDateRows} rows on team-dates carrying two different game_ids (corrupt/duplicated game rows), of ${hygiene.rawRows.toLocaleString()} loaded; applied to allowances and player histories alike.\n\n`;
md += proof.lines.join('\n\n') + '\n\n';
md += `Finer positions (PG/SG/SF/PF) share of regular-season rows by season: ${finePos.map(r => `${r.season}: ${(100 * r.fine / r.n).toFixed(0)}%`).join(', ')} — not reliable across the window ⇒ not tested.\n\n`;
md += `## Decision per prop family (predeclared rules)\n\n| Family | N (test) | MAE C | MAE D2 | ΔMAE D2−C 95% CI | rel. | seasons D2 better | worst group (99% lo) | Brier D2−C | **Decision** |\n|---|---|---|---|---|---|---|---|---|---|\n`;
for (const R of Object.values(results)) md += `| ${R.label} | ${R.n} | ${f(R.variants.pC.mae)} | ${f(R.variants.pD2.mae)} | ${ci95(R.diffs.D2.mae)} | ${f(-100 * R.diffs.D2.mae.est / R.variants.pC.mae, 2)}% | ${R.gate.D2.wins}/5 | ${f(Math.max(...GROUPS.map(g => R.groups[g].D2.lo99)), 4)} | ${f(R.diffs.D2.brier.est, 5)} | **${R.decision}** |\n`;
md += `\n## Error metrics (test seasons; lower is better)\n\n| Family | MAE C | MAE A | MAE B | MAE D1 | MAE D2 | MAE D3 | MAE D2r | RMSE C | RMSE D2 | bias C | bias A | bias D2 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const R of Object.values(results)) { const v = R.variants; md += `| ${R.label} | ${f(v.pC.mae)} | ${f(v.pA.mae)} | ${f(v.pB.mae)} | ${f(v.pD1.mae)} | ${f(v.pD2.mae)} | ${f(v.pD3.mae)} | ${f(v.pD2r.mae)} | ${f(v.pC.rmse)} | ${f(v.pD2.rmse)} | ${f(v.pC.bias)} | ${f(v.pA.bias)} | ${f(v.pD2.bias)} |\n`; }
md += `\n## Paired ΔMAE vs the no-defense baseline C — 95% CI (negative = better than C)\n\n| Family | A | B | D1 | D2 | D3 | D2r | D2r−D2 |\n|---|---|---|---|---|---|---|---|\n`;
for (const R of Object.values(results)) md += `| ${R.label} | ${ci95(R.diffs.A.mae, 3)} | ${ci95(R.diffs.B.mae)} | ${ci95(R.diffs.D1.mae)} | ${ci95(R.diffs.D2.mae)} | ${ci95(R.diffs.D3.mae)} | ${ci95(R.diffs.D2r.mae)} | ${ci95(R.diffs['D2r-D2'].mae)} |\n`;
md += `\n## Paired ΔMSE vs C (95% CI) and walk-forward-fitted pass-through β (D2) by test season\n\n| Family | ΔMSE D2−C | β 2021 | β 2022 | β 2023 | β 2024 | β 2025 | train N (2020) |\n|---|---|---|---|---|---|---|---|\n`;
for (const R of Object.values(results)) md += `| ${R.label} | ${ci95(R.diffs.D2.mse, 4)} | ${TEST_SEASONS.map(s => f(R.betas[s].D2, 3)).join(' | ')} | ${R.trainN} |\n`;
md += `\nβ = fraction of the opponent-allowance ratio deviation that is actually passed through to the projection (1.0 would mean full pass-through, 0 none).\n\n## Season-by-season stability: mean ΔMAE vs C (negative = better)\n\n| Family | metric | 2021 | 2022 | 2023 | 2024 | 2025 |\n|---|---|---|---|---|---|---|\n`;
for (const R of Object.values(results)) { md += `| ${R.label} | D2 | ${TEST_SEASONS.map(s => f(R.seasons[s].D2, 4)).join(' | ')} |\n| ${R.label} | D3 (rank) | ${TEST_SEASONS.map(s => f(R.seasons[s].D3, 4)).join(' | ')} |\n| ${R.label} | A (current) | ${TEST_SEASONS.map(s => f(R.seasons[s].A, 3)).join(' | ')} |\n`; }
md += `\n## Position / role stability of D2 (ΔMAE vs C, 95% CI)\n\n| Family | G | F | C | starter | bench |\n|---|---|---|---|---|---|\n`;
for (const R of Object.values(results)) md += `| ${R.label} | ${GROUPS.map(g => `${ci95(R.groups[g].D2)} (n=${R.groups[g].n})`).join(' | ')} | ${['S', 'B'].map(r => `${ci95(R.roles[r].D2)} (n=${R.roles[r].n})`).join(' | ')} |\n`;
md += `\n## Probability impact (pseudo-line; calibration slope ≈1 and low ECE/Brier are better)\n\n| Family | Brier C | Brier A | Brier D2 | ΔBrier D2−C 95% CI | slope C | slope A | slope D2 | ECE C | ECE A | ECE D2 |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const R of Object.values(results)) md += `| ${R.label} | ${f(R.prob.pC.brier, 4)} | ${f(R.prob.pA.brier, 4)} | ${f(R.prob.pD2.brier, 4)} | ${ci95(R.diffs.D2.brier, 5)} | ${f(R.prob.pC.calSlope, 2)} | ${f(R.prob.pA.calSlope, 2)} | ${f(R.prob.pD2.calSlope, 2)} | ${f(R.prob.pC.ece, 3)} | ${f(R.prob.pA.ece, 3)} | ${f(R.prob.pD2.ece, 3)} |\n`;
md += `\n## Magnitude of the adjustment in the prop's own stat units (projection − baseline projection)\n\n| Family | mean C projection | A: mean | A: p5…p95 | A: max abs | D2: mean abs | D2: p5…p95 | D2: max abs | D2: mean abs % of projection |\n|---|---|---|---|---|---|---|---|---|\n`;
for (const R of Object.values(results)) { const a = R.adj.pA, d = R.adj.pD2; md += `| ${R.label} | ${f(R.meanProj, 2)} | ${f(a.mean, 2)} | ${f(a.p05, 2)} … ${f(a.p95, 2)} | ${f(a.maxAbs, 2)} | ${f(d.meanAbs, 3)} | ${f(d.p05, 3)} … ${f(d.p95, 3)} | ${f(d.maxAbs, 3)} | ${f(d.relMeanAbsPct, 2)}% |\n`; }
md += `\n## Gate detail (D2 / A / B vs C): c1 MAE 99%-CI & ≥0.25% rel · c2 MSE · c3 ≥4/5 seasons · c4 no group significantly worse (D2 only) · c5 Brier not significantly worse\n\n| Family | D2 c1 c2 c3 c4 c5 | A c1 c2 c3 c5 | B c1 c2 c3 c5 |\n|---|---|---|---|\n`;
const fl = (g, with4) => [g.c1, g.c2, g.c3, ...(with4 ? [g.c4] : []), g.c5].map(x => x ? '✓' : '✗').join(' ');
for (const R of Object.values(results)) md += `| ${R.label} | ${fl(R.gate.D2, true)} | ${fl(R.gate.A, false)} | ${fl(R.gate.B, false)} |\n`;
md += `\nNot tested: sportsbook-line baselines/edge/EV; the app's exact embedded DvP table (this reconstructs allowances from box scores); finer positions (data unreliable); prior-season carry-over / rolling-window constructions; pace/minutes interactions.\n`;
fs.writeFileSync(path.join(OUT, 'report.md'), md);
console.log('\nwrote', path.join(OUT, 'report.md'));
