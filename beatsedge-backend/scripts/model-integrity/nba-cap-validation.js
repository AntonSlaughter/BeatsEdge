// NBA WILD-GAP (thin-data) CAP VALIDATION.  PLAYER-STAT PREDICTION VALIDATION on a SYNTHETIC pseudo-line; not market validation (DATA GAP).
//
// ================= PREDECLARED (before any result was seen) =================
// The cap (`wildGap` -> `thinData`) demotes A/B to C and blocks Prime. Original rule: |edge| / line > 0.5, which divides by the line, so a 0.5 BLK
// line or a 1.5 3PM line is capped for any edge >= 0.25 / 0.75 units regardless of how large that is in the stat's OWN spread.
// Candidates (4, no search, no per-family values):
//   A  CURRENT        |edge| / line > 0.5
//   B  NONE           no wild-gap cap -- CONTROL ONLY, ineligible to win (the safety cap is not being removed)
//   C  SCALE-AWARE    |edge| > 1.0 x SD, SD = the engine's own predictive SD for the stat (projStdDev, the same spread the probability layer uses).
//                     1.0 is the natural unit; the original rule's implied gap is ~1.1 SD for PTS (line~15, SD~6.75 at cv .45) and ~0.83 SD for REB/AST
//                     (cap 0.5xline vs SD 0.6xmean) -- derived from engine constants, not from hit rates.
//   D  FLOORED RELATIVE  |edge| / max(line, SD) > 0.5  -- the minimal change to the original: identical wherever line >= SD (all high-count markets),
//                     only differs where the line is smaller than the stat's own spread (BLK, STL, 3PM). One extra candidate, justified a priori.
// ELIGIBILITY / WINNER (A, C, D only):
//   (1) every one of the 12 families has monotone final grades (A>=B>=C>=D hit rate, groups n>=200, tolerance 0.5 pt);
//   (2) no degradation outside the low-line stats: pooled A and B hit rates over PTS, REB, AST, PRA, PR, PA, RA within 1.0 pt of candidate A's, and Prime hit within 1.0 pt;
//   (3) season stability: overall grades monotone in each of the 5 seasons, and BLK B>=C in at least 4 of 5 seasons.
//   Among candidates passing (1)-(3) the winner has the smallest sum over families of the worst adjacent inversion; tie -> smaller change in capped share on the 7 high-count families.
//   If none passes, the CURRENT rule stays.
// Same grade pipeline as live (resolveFinalGrade): lineSource no longer switches NBA post-rules off.  Calibration = nba-defaults-2026-10-06.
//
//   node scripts/model-integrity/nba-cap-validation.js [--per-season 8000]
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadModel } = require('../lib/loadBeatsEdgeModel');
const { buildLiveShapedNbaPlayer } = require('../lib/nbaHistoricalInputs');
const argv = process.argv.slice(2); const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const PER = Number(arg('per-season', 8000)), SEASONS = [2021, 2022, 2023, 2024, 2025];
const OUT = path.resolve(__dirname, '..', '..', 'tmp/model-integrity/nba-cap-validation');
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(20261006);
const CANDS = { A: 'relative', B: 'none', C: 'sigma', D: 'floored' };
const MARK = /wildGapRule: '[a-z]+'/;   // config-agnostic anchor (the shipped value is now 'floored')
const models = {}; for (const [c, rule] of Object.entries(CANDS)) { models[c] = loadModel({ liveNba: true, transform: (src) => { if (!MARK.test(src)) throw new Error('config anchor missing'); return src.replace(MARK, `wildGapRule: '${rule}'`)   // NOTE: DECISION RECORDED 2026-10-06 -- candidate D ('floored') accepted; do not re-run to re-select; } }); models[c].__setGradeCutoffs({}); models[c].__setProbCalib({}); }
const FAMS = { points: r => r.points, rebounds: r => r.rebounds, assists: r => r.assists, threes: r => r.threes, steals: r => r.steals, blocks: r => r.blocks, turnovers: r => r.turnovers, pra: r => r.points + r.rebounds + r.assists, pr: r => r.points + r.rebounds, pa: r => r.points + r.assists, ra: r => r.rebounds + r.assists, blocksSteals: r => r.blocks + r.steals };
const FK = Object.keys(FAMS), LAB = { points: 'PTS', rebounds: 'REB', assists: 'AST', threes: '3PM', steals: 'STL', blocks: 'BLK', turnovers: 'TOV', pra: 'PRA', pr: 'PR', pa: 'PA', ra: 'RA', blocksSteals: 'BLK+STL' };
const HIGH = ['points', 'rebounds', 'assists', 'pra', 'pr', 'pa', 'ra'];
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
// ---- run: one flat record per (sample, family, side); per candidate: final grade, raw grade, capped flag, prime
const MAXN = PER * SEASONS.length * 12 * 2; let n = 0;
const season = new Int8Array(MAXN), fam = new Int8Array(MAXN), dir = new Int8Array(MAXN), hit = new Int8Array(MAXN);
const F = {}, R = {}, CAP = {}, PR = {}; for (const c of Object.keys(CANDS)) { F[c] = new Int8Array(MAXN); R[c] = new Int8Array(MAXN); CAP[c] = new Int8Array(MAXN); PR[c] = new Int8Array(MAXN); }
const t0 = Date.now();
for (const se of SEASONS) {
  const elig = [];
  for (const [, rows] of byP) { const start = rows.findIndex(r => r.season >= se - 1); if (start < 0) continue; for (let i = start; i < rows.length; i++) { const r = rows[i]; if (r.season !== se || r.season_type !== 2 || i - start < 10) continue; const m10 = rows.slice(Math.max(start, i - 10), i); if (mean(m10.map(x => x.minutes)) < 15) continue; elig.push({ rows, start, i }); } }
  for (let k = elig.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [elig[k], elig[j]] = [elig[j], elig[k]]; }
  for (const s of elig.slice(0, PER)) {
    const target = s.rows[s.i], hist = s.rows.slice(s.start, s.i), lf = {};
    for (const k of FK) { const hv = hist.map(FAMS[k]); if (mean(hv) <= 0) continue; const l = pl(hv); if (l > 0) lf[k] = l; }
    const ptd = prevTD(target.team, target.game_date);
    const players = {}; for (const c of Object.keys(CANDS)) players[c] = buildLiveShapedNbaPlayer(models[c], { target, hist, lineFor: lf, prevTeamDate: ptd });
    FK.forEach((k, fi) => { if (!lf[k]) return; const actual = FAMS[k](target), line = lf[k]; if (actual === line) return;
      ['over', 'under'].forEach((d, di) => {
        const prop = { statKey: k, type: k, line, direction: d, lineSource: 'backtest' }; const es = {};
        for (const c of Object.keys(CANDS)) { es[c] = models[c].calculateEdgeScore(players[c], prop); if (es[c].insufficientData) return; }
        season[n] = se - 2021; fam[n] = fi; dir[n] = di; hit[n] = (d === 'over' ? actual > line : actual < line) ? 1 : 0;
        for (const c of Object.keys(CANDS)) { F[c][n] = GR[es[c].finalGrade]; R[c][n] = GR[es[c].rawGrade]; CAP[c][n] = es[c].wildGap ? 1 : 0; PR[c][n] = es[c].prime ? 1 : 0; }
        n++; });
    });
  }
  console.log('season', se, 'sides', n, Math.round((Date.now() - t0) / 1000) + 's');
}
// ---- aggregation
const wil = (h, m) => { if (!m) return [NaN, NaN]; const z = 1.96, p = h / m, d = 1 + z * z / m, c = p + z * z / (2 * m), a = z * Math.sqrt(p * (1 - p) / m + z * z / (4 * m * m)); return [(c - a) / d, (c + a) / d]; };
function table(c, filt) { const t = GL.map(() => ({ n: 0, h: 0 })); let tot = 0; for (let i = 0; i < n; i++) { if (!filt(i)) continue; tot++; const g = F[c][i]; t[g].n++; t[g].h += hit[i]; } return t.map((x, g) => ({ grade: GL[g], n: x.n, cov: tot ? x.n / tot : 0, rate: x.n ? x.h / x.n : null })); }
const mono = (t, tol = 0.005) => { const r = t.filter(x => x.n >= 200).map(x => x.rate); return r.every((v, i) => i === 0 || v <= r[i - 1] + tol); };
const worst = (t) => { const r = t.filter(x => x.n >= 200); let w = 0; for (let i = 1; i < r.length; i++) w = Math.max(w, r[i].rate - r[i - 1].rate); return Math.max(0, w); };
const res = { per: PER, sides: n, cands: {} };
for (const c of Object.keys(CANDS)) {
  const o = { rule: CANDS[c], overall: table(c, () => true), byFam: {}, bySeason: {}, byDir: {}, cappedShare: {}, capped: {}, prime: {} };
  FK.forEach((k, fi) => { o.byFam[k] = table(c, i => fam[i] === fi); let capN = 0, tot = 0; for (let i = 0; i < n; i++) if (fam[i] === fi) { tot++; capN += CAP[c][i]; } o.cappedShare[k] = capN / tot;
    // capped sides: what they'd receive with NO cap (candidate B final grade), and what they actually did
    const cg = [0, 0, 0, 0], cgH = [0, 0, 0, 0]; let cn = 0, ch = 0; for (let i = 0; i < n; i++) if (fam[i] === fi && CAP[c][i]) { cn++; ch += hit[i]; cg[F.B[i]]++; cgH[F.B[i]] += hit[i]; }
    o.capped[k] = { n: cn, hit: cn ? ch / cn : null, otherwise: cg.map((x, g) => ({ grade: GL[g], n: x, hit: x ? cgH[g] / x : null })) };
    let pn = 0, ph = 0, pt = 0; for (let i = 0; i < n; i++) if (fam[i] === fi) { pt++; if (PR[c][i]) { pn++; ph += hit[i]; } } o.prime[k] = { n: pn, cov: pn / pt, hit: pn ? ph / pn : null }; });
  SEASONS.forEach((se, si) => { o.bySeason[se] = table(c, i => season[i] === si); o['blk' + se] = table(c, i => season[i] === si && fam[i] === FK.indexOf('blocks')); });
  [['over', 0], ['under', 1]].forEach(([nm, d]) => o.byDir[nm] = table(c, i => dir[i] === d));
  let pn = 0, ph = 0; for (let i = 0; i < n; i++) if (PR[c][i]) { pn++; ph += hit[i]; } o.primeAll = { n: pn, cov: pn / n, hit: ph / pn };
  let hn = 0, hh = 0; for (let i = 0; i < n; i++) if (HIGH.includes(FK[fam[i]]) && PR[c][i]) { hn++; hh += hit[i]; } o.primeHigh = { n: hn, hit: hh / hn };
  o.totalCapped = (() => { let x = 0; for (let i = 0; i < n; i++) x += CAP[c][i]; return x / n; })();
  o.highPooled = table(c, i => HIGH.includes(FK[fam[i]]));
  res.cands[c] = o;
}
// eligibility
const ref = res.cands.A; const rep = {};
for (const c of ['A', 'C', 'D']) { const o = res.cands[c];
  const c1 = FK.every(k => mono(o.byFam[k])); const wsum = FK.reduce((s, k) => s + worst(o.byFam[k]), 0);
  const dA = Math.abs(o.highPooled[0].rate - ref.highPooled[0].rate), dB = Math.abs(o.highPooled[1].rate - ref.highPooled[1].rate), dP = Math.abs(o.primeHigh.hit - ref.primeHigh.hit);
  const c2 = dA <= 0.01 && dB <= 0.01 && dP <= 0.01;
  const c3a = SEASONS.every(se => mono(o.bySeason[se])); const blkOk = SEASONS.filter(se => { const t = o['blk' + se]; return t[1].rate >= t[2].rate - 1e-9; }).length;
  const c3 = c3a && blkOk >= 4;
  const capShift = HIGH.reduce((s, k) => s + Math.abs(o.cappedShare[k] - ref.cappedShare[k]), 0);
  rep[c] = { c1, c2, c3, wsum, dA, dB, dP, blkOk, c3a, capShift, pass: c1 && c2 && c3 }; }
const passers = Object.entries(rep).filter(([, v]) => v.pass); passers.sort((a, b) => (a[1].wsum - b[1].wsum) || (a[1].capShift - b[1].capShift));
res.eligibility = rep; res.winner = passers.length ? passers[0][0] : 'A'; res.winnerNote = passers.length ? 'passes all three predeclared criteria' : 'no candidate passed; CURRENT rule stays';
fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(res, null, 1));
const pc = (x, d = 1) => (x == null || Number.isNaN(x)) ? '--' : (100 * x).toFixed(d) + '%';
let md = `# NBA wild-gap cap validation (synthetic pseudo-line; player-stat validation only)\n\n${n.toLocaleString()} sides (per-season sample ${PER}); final grades through the official pipeline; calibration \`nba-defaults-2026-10-06\`.\n\nCandidates: ${Object.entries(CANDS).map(([c, r]) => `**${c}** ${r}`).join(' · ')}.\n\n**Winner: ${res.winner}** (${res.winnerNote}).\n\n## Eligibility (A, C, D)\n\n| Cand | (1) all 12 families monotone | (2) high-count A/B/Prime within 1pt (ΔA, ΔB, ΔPrime) | (3) seasons monotone & BLK B≥C in ≥4/5 | worst-inversion sum | capped-share shift (high-count) | pass |\n|---|---|---|---|---|---|---|\n`;
for (const c of ['A', 'C', 'D']) { const v = rep[c]; md += `| ${c} | ${v.c1} | ${v.c2} (${pc(v.dA)}, ${pc(v.dB)}, ${pc(v.dP)}) | ${v.c3} (seasons ${v.c3a}, BLK ${v.blkOk}/5) | ${pc(v.wsum)} | ${pc(v.capShift)} | ${v.pass} |\n`; }
md += `\n## Overall final grades\n\n| Cand | A | B | C | D | capped (all sides) | Prime cov / hit |\n|---|---|---|---|---|---|---|\n`;
for (const c of Object.keys(CANDS)) { const o = res.cands[c]; md += `| ${c} ${o.rule} | ${o.overall.map(g => `${pc(g.rate)} (${g.n}, ${pc(g.cov, 2)})`).join(' | ')} | ${pc(o.totalCapped)} | ${pc(o.primeAll.cov, 2)} / ${pc(o.primeAll.hit)} |\n`; }
md += `\n## By family — hit (N) for A/B/C/D, capped share, ordering\n\n`;
for (const k of FK) { md += `**${LAB[k]}**\n\n| Cand | A | B | C | D | capped | ordering (worst inversion) | Prime N / cov / hit |\n|---|---|---|---|---|---|---|---|\n`; for (const c of Object.keys(CANDS)) { const o = res.cands[c], t = o.byFam[k]; md += `| ${c} | ${t.map(g => `${pc(g.rate)} (${g.n})`).join(' | ')} | ${pc(o.cappedShare[k])} | ${mono(t) ? 'ok' : 'BROKEN ' + pc(worst(t))} | ${o.prime[k].n} / ${pc(o.prime[k].cov, 2)} / ${pc(o.prime[k].hit)} |\n`; } md += '\n'; }
md += `## Capped sides: what they would otherwise receive (candidate B grade) and their actual hit rate\n\n| Family | Cand | capped N | hit rate | otherwise A (N, hit) | B | C | D |\n|---|---|---|---|---|---|---|---|\n`;
for (const k of ['blocks', 'threes', 'steals', 'points', 'rebounds']) for (const c of ['A', 'C', 'D']) { const x = res.cands[c].capped[k]; md += `| ${LAB[k]} | ${c} | ${x.n} | ${pc(x.hit)} | ${x.otherwise.map(o => `${o.n} (${pc(o.hit)})`).join(' | ')} |\n`; }
md += `\n## Season stability (overall final grades hit rate, A | B | C | D; BLK B vs C)\n\n| Season | ` + ['A', 'C', 'D'].map(c => `${c} overall`).join(' | ') + ` | BLK B/C: A | C | D |\n|---|---|---|---|---|---|---|\n`;
for (const se of SEASONS) md += `| ${se} | ${['A', 'C', 'D'].map(c => res.cands[c].bySeason[se].map(g => pc(g.rate)).join('/')).join(' | ')} | ${['A', 'C', 'D'].map(c => { const t = res.cands[c]['blk' + se]; return pc(t[1].rate) + '/' + pc(t[2].rate); }).join(' | ')} |\n`;
md += `\n## Over / Under (final grades, hit rate (N))\n\n| Cand | side | A | B | C | D |\n|---|---|---|---|---|---|\n`; for (const c of ['A', 'C', 'D']) for (const nm of ['over', 'under']) md += `| ${c} | ${nm} | ${res.cands[c].byDir[nm].map(g => `${pc(g.rate)} (${g.n})`).join(' | ')} |\n`;
fs.writeFileSync(path.join(OUT, 'report.md'), md); console.log('winner', res.winner, res.winnerNote, '-> report.md');
