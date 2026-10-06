// How does the LIVE displayed grade differ from the RAW/backtest-convention grade, and why?   (measurement only; nothing is changed)
// Same real engine, same live-shaped inputs; each side is scored twice: lineSource 'backtest' (raw grade) and a real-line-like lineSource (served grade).
// Attribution replays the three live post-rules in their engine order and is VERIFIED against the engine's own served grade (mismatch count printed):
//   1. Prime promotion:   prime && grade in {C,D}            -> A
//   2. (real-price cap:   A/B and modelProb <= implied       -> C   -- needs a real price: DATA GAP, not exercisable here)
//   3. reconciliation:    (A|B) && p < 50% -> C ;  grade != D && p < 44% -> D ;  D && p >= 58% -> C     (p = sport-calibrated probability)
// Synthetic pseudo-line => PLAYER-STAT PREDICTION VALIDATION only.
//   node scripts/model-integrity/nba-live-vs-raw-grade-decomposition.js [--per-season 8000]
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadModel } = require('../lib/loadBeatsEdgeModel');
const { buildLiveShapedNbaPlayer } = require('../lib/nbaHistoricalInputs');
const argv = process.argv.slice(2); const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const PER = Number(arg('per-season', 8000)); const SEASONS = [2021, 2022, 2023, 2024, 2025];
const OUT = path.resolve(__dirname, '..', '..', 'tmp/model-integrity/nba-grade-decomposition');
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(20261006);
const m = loadModel({ liveNba: true }); m.__setGradeCutoffs({}); m.__setProbCalib({});
const FAMS = { points: r => r.points, rebounds: r => r.rebounds, assists: r => r.assists, threes: r => r.threes, steals: r => r.steals, blocks: r => r.blocks, turnovers: r => r.turnovers, pra: r => r.points + r.rebounds + r.assists, pr: r => r.points + r.rebounds, pa: r => r.points + r.assists, ra: r => r.rebounds + r.assists, blocksSteals: r => r.blocks + r.steals };
const LAB = { points: 'PTS', rebounds: 'REB', assists: 'AST', threes: '3PM', steals: 'STL', blocks: 'BLK', turnovers: 'TOV', pra: 'PRA', pr: 'PR', pa: 'PA', ra: 'RA', blocksSteals: 'BLK+STL' };
const db = new DatabaseSync(path.resolve(__dirname, '..', '..', 'data', 'beatsedge.db'), { readOnly: true });
const allRaw = db.prepare(`SELECT game_id, athlete_id, season, season_type, game_date, team, opponent, home_away, pos_group, minutes, points, rebounds, assists, threes, steals, blocks, turnovers FROM nba_player_box
  WHERE season_type IN (2,3) AND played = 1 AND minutes > 0 AND season >= 2019 AND pos_group IN ('G','F','C') AND points IS NOT NULL AND rebounds IS NOT NULL AND assists IS NOT NULL AND threes IS NOT NULL AND steals IS NOT NULL AND blocks IS NOT NULL AND turnovers IS NOT NULL ORDER BY game_date, game_id`).all();
const ts = new Map(); allRaw.forEach(r => { let s = ts.get(r.team); if (!s) ts.set(r.team, s = new Set()); s.add(r.season); }); const real = new Set([...ts].filter(([, s]) => s.size >= 5).map(([t]) => t));
const tdG = new Map(); allRaw.forEach(r => { const k = r.team + '|' + r.game_date; let s = tdG.get(k); if (!s) tdG.set(k, s = new Set()); s.add(r.game_id); }); const bad = new Set([...tdG].filter(([, s]) => s.size > 1).map(([k]) => k));
const all = allRaw.filter(r => real.has(r.team) && real.has(r.opponent) && !bad.has(r.team + '|' + r.game_date) && !bad.has(r.opponent + '|' + r.game_date));
const td = new Map(); all.forEach(r => { let s = td.get(r.team); if (!s) td.set(r.team, s = new Set()); s.add(r.game_date); }); const tds = new Map([...td].map(([t, s]) => [t, [...s].sort()]));
const prevTD = (t, d) => { const a = tds.get(t); let lo = 0, hi = a.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < d) lo = mid + 1; else hi = mid; } return lo ? a[lo - 1] : null; };
const byP = new Map(); all.forEach(r => { let a = byP.get(r.athlete_id); if (!a) byP.set(r.athlete_id, a = []); a.push(r); });
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const pl = hv => { const avg = mean(hv); let line = null, best = 99; for (let c = 0.5; c <= avg * 2.2 + 1; c += 1) { const o = hv.filter(v => v > c).length / hv.length; const g = Math.abs(o - 0.48); if (g < best) { best = g; line = c; } } return line; };
const GR = { A: 0, B: 1, C: 2, D: 3 }, GL = ['A', 'B', 'C', 'D'];
const mat = GL.map(() => GL.map(() => ({ n: 0, hit: 0 }))), why = {}, byFam = {}; let N = 0, mism = 0, hitAll = 0;
const bump = (k, hit) => { const o = why[k] || (why[k] = { n: 0, hit: 0 }); o.n++; o.hit += hit; };
for (const season of SEASONS) {
  const elig = [];
  for (const [, rows] of byP) { const start = rows.findIndex(r => r.season >= season - 1); if (start < 0) continue; for (let i = start; i < rows.length; i++) { const r = rows[i]; if (r.season !== season || r.season_type !== 2 || i - start < 10) continue; const m10 = rows.slice(Math.max(start, i - 10), i); if (mean(m10.map(x => x.minutes)) < 15) continue; elig.push({ rows, start, i }); } }
  for (let k = elig.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [elig[k], elig[j]] = [elig[j], elig[k]]; }
  for (const s of elig.slice(0, PER)) {
    const target = s.rows[s.i], hist = s.rows.slice(s.start, s.i), lf = {};
    for (const k of Object.keys(FAMS)) { const hv = hist.map(FAMS[k]); if (mean(hv) <= 0) continue; const l = pl(hv); if (l > 0) lf[k] = l; }
    const p = buildLiveShapedNbaPlayer(m, { target, hist, lineFor: lf, prevTeamDate: prevTD(target.team, target.game_date) });
    for (const k of Object.keys(lf)) { const actual = FAMS[k](target), line = lf[k]; if (actual === line) continue;
      for (const dir of ['over', 'under']) {
        const hit = (dir === 'over' ? actual > line : actual < line) ? 1 : 0;
        const eR = m.calculateEdgeScore(p, { statKey: k, type: k, line, direction: dir, lineSource: 'backtest' }), eS = m.calculateEdgeScore(p, { statKey: k, type: k, line, direction: dir, lineSource: 'validation-synthetic-line' });
        if (eR.insufficientData) continue; N++; hitAll += hit;
        const g0 = GR[eR.grade], gS = GR[eS.grade], pr = Math.max(0.03, Math.min(0.97, Math.max(0.22, Math.min(0.78, eR.preFloorRaw))));   // exact modelProbSport under the identity curve (default config)
        let g = g0, step = [];
        if (eR.prime && (g === 2 || g === 3)) { g = 0; step.push('prime_promote'); }
        const a = g; if ((g === 0 || g === 1) && pr < 0.50) { g = 2; step.push('recon_AB_to_C(p<50)'); }
        if (g !== 3 && pr < 0.44) { g = 3; step.push('recon_to_D(p<44)'); }
        if (g === 3 && pr >= 0.58) { g = 2; step.push('recon_D_to_C(p>=58)'); }
        if (g !== gS) mism++;
        mat[g0][gS].n++; mat[g0][gS].hit += hit;
        if (g0 !== gS) { bump('CHANGED total', hit); bump('reason: ' + (step.join(' + ') || '(unattributed)'), hit); const f = byFam[k] || (byFam[k] = { n: 0, changed: 0 }); f.changed++; }
        const f2 = byFam[k] || (byFam[k] = { n: 0, changed: 0 }); f2.n++;
      } }
  }
  console.log('season', season, 'sides so far', N);
}
fs.mkdirSync(OUT, { recursive: true });
const pc = (x, d = 2) => (100 * x).toFixed(d) + '%';
let md = `# Live displayed grade vs raw (backtest-convention) grade — NBA vNext\n\nSides scored twice by the real engine (synthetic pseudo-line; player-stat validation only). N = ${N.toLocaleString()} sides (per-season sample ${PER}, all families, both sides). Attribution replay vs the engine's served grade: **${mism} mismatches of ${N}** (rounding of the 50/44/58 thresholds).\n\n`;
md += `Real-price cap (A/B → C when the model does not beat the de-vigged price): DATA GAP — needs genuine prices.\n\n## Transition matrix (raw → live displayed): count (hit rate)\n\n| raw \\ live | A | B | C | D |\n|---|---|---|---|---|\n`;
GL.forEach((G, i) => { md += `| ${G} | ${mat[i].map(c => `${c.n} (${c.n ? pc(c.hit / c.n, 1) : '--'})`).join(' | ')} |\n`; });
const changed = why['CHANGED total'] || { n: 0, hit: 0 };
md += `\n**Sides whose displayed grade differs from the raw grade: ${changed.n} of ${N} (${pc(changed.n / N, 3)}).**\n\n| Reason (rule sequence) | sides | share of all sides | hit rate |\n|---|---|---|---|\n`;
Object.entries(why).filter(([k]) => k !== 'CHANGED total').sort((a, b) => b[1].n - a[1].n).forEach(([k, v]) => { md += `| ${k} | ${v.n} | ${pc(v.n / N, 3)} | ${pc(v.hit / v.n, 1)} |\n`; });
md += `\n| Family | sides | changed | share |\n|---|---|---|---|\n`; Object.entries(byFam).forEach(([k, v]) => { md += `| ${LAB[k]} | ${v.n} | ${v.changed} | ${pc(v.changed / v.n, 2)} |\n`; });
fs.writeFileSync(path.join(OUT, 'report.md'), md); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ N, mism, mat, why, byFam }, null, 1)); console.log(md);
