// NHL Phase 3A runner. RESEARCH ONLY. TRAIN = 2024, VALIDATION = 2025. The 2026 holdout is unreachable (see ./guard).
//   node run.js baseline   -> production baseline, TRAIN + VALIDATION (item 1)
//   node run.js tune       -> choose every tunable parameter on TRAIN ONLY; writes tmp/nhl-phase3a/tuned.json (+ sha256)
//   node run.js validate   -> evaluate the FROZEN candidate set on VALIDATION with the TRAIN-chosen parameters
//
// CANDIDATE SET (declared before any validation number was produced; 22 variants incl. 5 baselines):
//   SOG    : S0 baseline | S1 opp shots-allowed env | S2 EB position prior | S3 EB + opp env
//   Saves  : V0 baseline | V1 EB league prior | V2 team-saves pooling | V3 opp offence env | V4 pooling x opp offence | V5 EB + best-of(V2,V3,V4) [best picked on TRAIN]
//   Goal/Assist/Point (each): B0 baseline | B1 EB position prior | B2 opp env on lambda | B3 EB + opp env
// TUNABLES (TRAIN only): EB strength K in {0,10,20,40,80,160,320}; opp-env strength g in {0.5,1.0} (factor = 1+g(r-1));
//   saves pooling weight w in {0.25,0.5,0.75}. Windows are fixed a priori: team L15 (shots), team L10 (saves), player L5 in shrinkageFive.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const L = require('./lib');
const { mean, shrinkageFive, poissonPOver1 } = L;
const OUT = path.join(__dirname, '..', '..', '..', 'tmp', 'nhl-phase3a'); fs.mkdirSync(OUT, { recursive: true });
const MODE = process.argv[2] || 'baseline';
const KS = [0, 10, 20, 40, 80, 160, 320], GS = [0.5, 1.0], WS = [0.25, 0.5, 0.75];

const eb = (lam, n, mu, K) => (mu == null || K === 0) ? lam : (n * lam + K * mu) / (n + K);
const opp = (lam, r, g) => (r == null || g === 0) ? lam : lam * (1 + g * (r - 1));

async function loadRaw() {
  const [sog, g, a, p, gl, tg] = await Promise.all([L.loadSkater('shots_on_goal'), L.loadSkater('goals'), L.loadSkater('assists'), L.loadSkater('points'), L.loadGoalie(), L.loadTeamGames()]);
  return { sog, g, a, p, gl, tg };
}
function prepare(raw, cutExclusive) {
  const cut = (rows) => cutExclusive ? rows.filter(r => r.d < cutExclusive) : rows;
  const sog = cut(raw.sog), g = cut(raw.g), a = cut(raw.a), p = cut(raw.p), gl = cut(raw.gl), tg = cut(raw.tg);
  const { ctx, leagueBefore } = L.buildTeamCtx(tg);
  if (sog.some(r => r.pos == null)) throw new Error('skater row with null position');
  const fam = {
    sog: { name: 'Shots on Goal', kind: 'point', minPrior: 10, by: L.groupBy(sog, 'pid'), muFn: L.buildPrior(sog, 'pos', 2000), side: 'skater' },
    saves: { name: 'Goalie Saves', kind: 'point', minPrior: 8, by: L.groupBy(gl, 'pid'), muFn: L.buildPrior(gl, 'all', 200), side: 'goalie' },
    goal: { name: 'Goal >=1', kind: 'bin', minPrior: 15, by: L.groupBy(g, 'pid'), muFn: L.buildPrior(g, 'pos', 2000), side: 'skater' },
    assist: { name: 'Assist >=1', kind: 'bin', minPrior: 15, by: L.groupBy(a, 'pid'), muFn: L.buildPrior(a, 'pos', 2000), side: 'skater' },
    point: { name: 'Point >=1', kind: 'bin', minPrior: 15, by: L.groupBy(p, 'pid'), muFn: L.buildPrior(p, 'pos', 2000), side: 'skater' },
  };
  return { fam, ctx, leagueBefore };
}

// per-row features, ALL as-of (see lib.buildTeamCtx / buildPrior)
function feats(F, e) {
  const r = e.row, oc = F.ctx.get(r.gid + '|' + r.opp), lg = F.leagueBefore.get(r.d), own = F.ctx.get(r.gid + '|' + r.team);
  return {
    allowed: (oc && oc.sa15 != null && lg) ? oc.sa15 / lg : null,   // opponent shots-ALLOWED L15 / league avg (as-of)
    offense: (oc && oc.sf15 != null && lg) ? oc.sf15 / lg : null,   // opponent shots-FOR L15 / league avg (as-of)
    teamSv: own ? own.sv10 : null,                                  // goalie's own team saves/game, last 10 prior team games
  };
}

// ---- variant predictors: (e, base, f, mu, P) -> prediction (lambda for point families, lambda for binary before the Poisson transform)
function predictors(famKey) {
  if (famKey === 'sog' || famKey === 'goal' || famKey === 'assist' || famKey === 'point') {
    const b = famKey === 'sog' ? 'S' : 'B';
    return [
      { id: b + '0', desc: 'production baseline: shrinkageFive(all prior)', f: (e, base) => base, uses: [] },
      { id: b + '1', desc: 'opponent shots-allowed environment', f: (e, base, f, mu, P) => opp(base, f.allowed, P.g), uses: ['g'], dep: 'allowed' },
      { id: b + '2', desc: 'sample-size-aware shrinkage toward as-of position prior', f: (e, base, f, mu, P) => eb(base, e.n, mu, P.K), uses: ['K'], dep: 'mu' },
      { id: b + '3', desc: 'EB shrinkage + opponent environment', f: (e, base, f, mu, P) => opp(eb(base, e.n, mu, P.K), f.allowed, P.g), uses: ['K', 'g'], dep: 'both' },
    ];
  }
  const pool = (base, f, w) => (f.teamSv == null ? base : (1 - w) * base + w * f.teamSv);
  const poolOpp = (base, f, w, g) => ((f.teamSv == null || f.offense == null) ? base : (1 - w) * base + w * f.teamSv * (1 + g * (f.offense - 1)));
  return [
    { id: 'V0', desc: 'production baseline', f: (e, base) => base, uses: [] },
    { id: 'V1', desc: 'EB shrinkage toward as-of league goalie prior', f: (e, base, f, mu, P) => eb(base, e.n, mu, P.K1), uses: ['K1'], dep: 'mu' },
    { id: 'V2', desc: 'team-saves pooling: (1-w)*base + w*teamSavesL10', f: (e, base, f, mu, P) => pool(base, f, P.w2), uses: ['w2'], dep: 'teamSv' },
    { id: 'V3', desc: 'opponent offence environment (shots-for L15 / league)', f: (e, base, f, mu, P) => opp(base, f.offense, P.g3), uses: ['g3'], dep: 'offense' },
    { id: 'V4', desc: 'pooling x opponent offence: (1-w)*base + w*teamSavesL10*(1+g(offense-1))', f: (e, base, f, mu, P) => poolOpp(base, f, P.w4, P.g4), uses: ['w4', 'g4'], dep: 'teamSv+offense' },
    { id: 'V5', desc: 'EB shrinkage + best-of(V2,V3,V4) chosen on TRAIN', f: (e, base, f, mu, P) => {
        const b2 = eb(base, e.n, mu, P.K1);
        return P.best === 'V2' ? pool(b2, f, P.w2) : P.best === 'V3' ? opp(b2, f.offense, P.g3) : poolOpp(b2, f, P.w4, P.g4); }, uses: ['K1', 'best'], dep: 'mu+best' },
  ];
}
const transform = (kind, lam) => kind === 'bin' ? poissonPOver1(Math.max(0, lam)) : lam;
const target = (kind, y) => kind === 'bin' ? (y >= 1 ? 1 : 0) : y;
const lossOf = (kind, pred, y) => kind === 'bin' ? (pred - y) ** 2 : Math.abs(y - pred);

// collect eligible rows for a season set with features and the baseline lambda
function collect(F, famKey, seasons) {
  const fm = F.fam[famKey]; const out = [];
  for (const e of L.evals(fm.by, fm.minPrior, seasons)) {
    const base = shrinkageFive(e.prior); out.push({ e, base, f: feats(F, e), mu: fm.muFn(e.row), y: target(fm.kind, e.row.v), d: e.row.d, pos: e.row.pos === 'D' ? 'D' : 'F', n: e.n });
  }
  return out;
}
const evalLoss = (fm, rows, pr, P) => mean(rows.map(r => lossOf(fm.kind, transform(fm.kind, pr.f(r.e, r.base, r.f, r.mu, P)), r.y)));

// ===================== TUNE (TRAIN = 2024 only) =====================
function tuneFamily(F, famKey) {
  const fm = F.fam[famKey]; const rows = collect(F, famKey, [2024]); const prs = Object.fromEntries(predictors(famKey).map(p => [p.id, p]));
  const log = { n_train_rows: rows.length, grids: {} }; const P = {};
  const pick = (label, grid, mk, id, key) => { // strictly-better-than-previous (ascending order), ties keep the simpler/smaller
    const res = grid.map(v => ({ v, loss: evalLoss(fm, rows, prs[id], mk(v)) })); let best = res[0];
    for (const r of res) if (r.loss < best.loss - 1e-9) best = r;
    log.grids[label] = res.map(r => ({ v: r.v, train_loss: +r.loss.toFixed(5) })); return best.v; };
  if (famKey !== 'saves') {
    const id1 = famKey === 'sog' ? 'S1' : 'B1', id2 = famKey === 'sog' ? 'S2' : 'B2';
    P.g = pick('opp_env_strength_g', [0, ...GS], v => ({ g: v }), id1, 'g');
    P.K = pick('EB_K', KS, v => ({ K: v }), id2, 'K');
    log.train_baseline_loss = +evalLoss(fm, rows, prs[famKey === 'sog' ? 'S0' : 'B0'], {}).toFixed(5);
  } else {
    P.K1 = pick('EB_K_league_goalie', KS, v => ({ K1: v }), 'V1', 'K1');
    P.w2 = pick('pool_weight_w (V2 alone)', [0, ...WS], v => ({ w2: v }), 'V2', 'w2');
    P.g3 = pick('opp_offence_strength_g (V3 alone)', [0, ...GS], v => ({ g3: v }), 'V3', 'g3');
    // V4 joint grid
    let best = { w: 0, g: 0, loss: evalLoss(fm, rows, prs.V0, {}) }; const jg = [];
    for (const w of WS) for (const g of GS) { const l = evalLoss(fm, rows, prs.V4, { w4: w, g4: g }); jg.push({ w, g, train_loss: +l.toFixed(5) }); if (l < best.loss - 1e-9) best = { w, g, loss: l }; }
    log.grids['V4_joint_w_g'] = jg; P.w4 = best.w; P.g4 = best.g;
    // best-of structure for V5, by TRAIN loss of each structure applied to the EB base
    const cand = ['V2', 'V3', 'V4'].map(id => ({ id, loss: evalLoss(fm, rows, prs.V5, { ...P, best: id }) }));
    log.grids['V5_structure_choice'] = cand.map(c => ({ structure: c.id, train_loss: +c.loss.toFixed(5) }));
    let bs = cand[0]; for (const c of cand) if (c.loss < bs.loss - 1e-9) bs = c; P.best = bs.id;
    log.train_baseline_loss = +evalLoss(fm, rows, prs.V0, {}).toFixed(5);
  }
  return { params: P, log };
}

// ===================== VALIDATE (VALIDATION = 2025, frozen params) =====================
const BLOCKS = [['2024-10..2024-12', r => r.d < '2025-01-01'], ['2025-01..2025-02', r => r.d >= '2025-01-01' && r.d < '2025-03-01'], ['2025-03..2025-06', r => r.d >= '2025-03-01']];
const histStrata = (side) => side === 'goalie' ? [['n<30', r => r.n < 30], ['30-79', r => r.n >= 30 && r.n < 80], ['n>=80', r => r.n >= 80]] : [['n<40', r => r.n < 40], ['40-99', r => r.n >= 40 && r.n < 100], ['n>=100', r => r.n >= 100]];
function pairedStats(l0, l1, rows, side) {
  const diffs = l1.map((x, i) => x - l0[i]), dates = rows.map(r => r.d); const { mean: md, se } = L.clusterSE(diffs, dates); const b0 = mean(l0);
  const relOf = (f) => { const ix = rows.map((r, i) => f(r) ? i : -1).filter(i => i >= 0); if (!ix.length) return null; return { n: ix.length, rel_pct: +(((mean(ix.map(i => l1[i])) - mean(ix.map(i => l0[i]))) / mean(ix.map(i => l0[i]))) * 100).toFixed(2) }; };
  return { rel_pct: +(md / b0 * 100).toFixed(3), ci95_pct: [+((md - 1.96 * se) / b0 * 100).toFixed(3), +((md + 1.96 * se) / b0 * 100).toFixed(3)], blocks: BLOCKS.map(([nme, f]) => ({ block: nme, ...relOf(f) })),
    positions: side === 'skater' ? ['F', 'D'].map(p => ({ pos: p, ...relOf(r => r.pos === p) })) : null, history_strata: histStrata(side).map(([nme, f]) => ({ stratum: nme, ...relOf(f) })) };
}
function classify(name, st, coverage, n, isBaseline) {
  if (isBaseline) return 'BASELINE';
  const allBlocks = st.blocks.every(b => b.rel_pct < 0), posOK = !st.positions || st.positions.every(p => p.rel_pct < 0), noHarm = st.history_strata.every(s => s.rel_pct == null || s.rel_pct <= 0.25);
  if (st.ci95_pct[1] < 0) { if (st.rel_pct <= -0.5 && allBlocks && posOK && noHarm && coverage >= 0.9 && n >= 2000) return 'HOLDOUT CANDIDATE (pre-tiebreak)'; return 'CONTEXT ONLY'; }
  return 'DROP';
}

async function validateFamily(F, famKey, P, trainRate) {
  const fm = F.fam[famKey]; const rows = collect(F, famKey, [2025]); const prs = predictors(famKey);
  const preds = {}; const losses = {};
  for (const pr of prs) { preds[pr.id] = rows.map(r => transform(fm.kind, pr.f(r.e, r.base, r.f, r.mu, P))); losses[pr.id] = rows.map((r, i) => lossOf(fm.kind, preds[pr.id][i], r.y)); }
  const ys = rows.map(r => r.y); const out = { family: fm.name, n_eligible_validation_rows: rows.length, frozen_params: P, variants: {} };
  const base = prs[0];
  for (const pr of prs) {
    const m = fm.kind === 'bin' ? L.binaryMetrics(preds[pr.id], ys, trainRate) : L.pointMetrics(preds[pr.id], ys);
    const changed = rows.filter((r, i) => Math.abs(preds[pr.id][i] - preds[base.id][i]) > 1e-12).length / rows.length;
    const featAvail = pr.dep === 'allowed' ? rows.filter(r => r.f.allowed != null).length / rows.length : pr.dep === 'offense' ? rows.filter(r => r.f.offense != null).length / rows.length : pr.dep === 'teamSv' ? rows.filter(r => r.f.teamSv != null).length / rows.length
      : pr.dep === 'teamSv+offense' ? rows.filter(r => r.f.teamSv != null && r.f.offense != null).length / rows.length : pr.dep === 'mu' ? rows.filter(r => r.mu != null).length / rows.length : pr.dep === 'both' ? rows.filter(r => r.mu != null && r.f.allowed != null).length / rows.length : pr.dep ? 1 : 1;
    const isBase = pr === base; const st = isBase ? null : pairedStats(losses[base.id], losses[pr.id], rows, fm.side);
    out.variants[pr.id] = { desc: pr.desc, metrics: m, share_rows_prediction_changed: +changed.toFixed(3), feature_coverage: +featAvail.toFixed(3), vs_baseline: st, class: st ? classify(pr.id, st, featAvail, rows.length, false) : 'BASELINE' };
  }
  // simplicity tie-break (pre-declared): a combined variant must beat each simpler constituent it contains by >=0.25% with CI excluding 0, else the simpler one is preferred
  const contains = famKey === 'saves' ? { V4: ['V2', 'V3'], V5: ['V1', P.best] } : { [famKey === 'sog' ? 'S3' : 'B3']: [famKey === 'sog' ? 'S1' : 'B1', famKey === 'sog' ? 'S2' : 'B2'] };
  out.tiebreak = {};
  for (const [big, smalls] of Object.entries(contains)) for (const sm of smalls) {
    const st = pairedStats(losses[sm], losses[big], rows, fm.side);
    out.tiebreak[`${big}_vs_${sm}`] = { rel_pct: st.rel_pct, ci95_pct: st.ci95_pct, big_clearly_better: st.ci95_pct[1] < 0 && st.rel_pct <= -0.25 };
  }
  // apply the tie-break: a combined variant that is not clearly better than a simpler passing constituent is superseded by it
  for (const [big, smalls] of Object.entries(contains)) {
    if (!/^HOLDOUT CANDIDATE/.test(out.variants[big].class)) continue;
    const sup = smalls.filter(sm => /^HOLDOUT CANDIDATE/.test(out.variants[sm].class) && !out.tiebreak[`${big}_vs_${sm}`].big_clearly_better);
    out.variants[big].class = sup.length ? `SUPERSEDED BY SIMPLER (${sup.join(',')})` : 'HOLDOUT CANDIDATE';
  }
  for (const v of Object.values(out.variants)) if (v.class === 'HOLDOUT CANDIDATE (pre-tiebreak)') v.class = 'HOLDOUT CANDIDATE';
  return out;
}

module.exports = { loadRaw, prepare, feats, predictors, collect, transform, target, shrinkageFive, eb, opp };
if (require.main === module) (async () => {
  const G = require('./guard'); const raw = await loadRaw(); const F = prepare(raw);
  if (MODE === 'baseline') {
    const out = {};
    for (const k of Object.keys(F.fam)) {
      const fm = F.fam[k]; out[fm.name] = {};
      const trainRows = collect(F, k, [2024]); const ys24 = trainRows.map(r => r.y); const trainRate = mean(ys24);
      for (const [label, seasons, ref] of [['TRAIN(2024)', [2024], mean(ys24)], ['VALIDATION(2025)', [2025], trainRate]]) {
        const rows = collect(F, k, seasons); const preds = rows.map(r => transform(fm.kind, r.base)); const ys = rows.map(r => r.y);
        out[fm.name][label] = fm.kind === 'bin' ? L.binaryMetrics(preds, ys, ref) : L.pointMetrics(preds, ys);
        if (fm.kind === 'point' && label.startsWith('VALID')) { // directional by position (SOG) is part of the diagnostics
          if (fm.side === 'skater') out[fm.name][label].by_position = ['F', 'D'].map(p => { const ix = rows.map((r, i) => r.pos === p ? i : -1).filter(i => i >= 0); return { pos: p, n: ix.length, MAE: +mean(ix.map(i => Math.abs(ys[i] - preds[i]))).toFixed(4), bias_actual_minus_pred: +mean(ix.map(i => ys[i] - preds[i])).toFixed(4) }; });
        }
      }
    }
    fs.writeFileSync(path.join(OUT, 'baseline.json'), JSON.stringify(out, null, 2)); console.log(JSON.stringify(out, null, 1));
  } else if (MODE === 'tune') {
    const tuned = {}; const logs = {};
    for (const k of Object.keys(F.fam)) { const r = tuneFamily(F, k); tuned[k] = r.params; logs[k] = r.log; }
    const body = JSON.stringify({ stage: 'tuned on TRAIN(2024) only', candidate_grid: { KS, GS, WS }, params: tuned }, null, 2);
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    fs.writeFileSync(path.join(OUT, 'tuned.json'), body); fs.writeFileSync(path.join(OUT, 'tuned.sha256'), sha); fs.writeFileSync(path.join(OUT, 'tune-log.json'), JSON.stringify(logs, null, 2));
    console.log(JSON.stringify({ tuned, sha256: sha }, null, 1)); for (const [k, l] of Object.entries(logs)) console.log(k, 'TRAIN rows', l.n_train_rows, 'baseline train loss', l.train_baseline_loss);
  } else if (MODE === 'validate') {
    const tunedPath = path.join(OUT, 'tuned.json'); if (!fs.existsSync(tunedPath)) throw new Error('run `tune` first (parameters must be frozen on TRAIN before VALIDATION is evaluated)');
    const body = fs.readFileSync(tunedPath, 'utf8'); const sha = crypto.createHash('sha256').update(body).digest('hex'); if (sha !== fs.readFileSync(path.join(OUT, 'tuned.sha256'), 'utf8').trim()) throw new Error('tuned.json changed since tuning');
    const tuned = JSON.parse(body).params; const res = { tuned_sha256: sha, families: {} };
    for (const k of Object.keys(F.fam)) {
      const fm = F.fam[k]; const trainRate = fm.kind === 'bin' ? mean(collect(F, k, [2024]).map(r => r.y)) : null;
      res.families[k] = await validateFamily(F, k, tuned[k], trainRate);
    }
    res.guard = G.stats(); fs.writeFileSync(path.join(OUT, 'validation.json'), JSON.stringify(res, null, 2));
    for (const [k, fr] of Object.entries(res.families)) {
      console.log(`\n== ${fr.family}  (n=${fr.n_eligible_validation_rows})  params=${JSON.stringify(fr.frozen_params)}`);
      for (const [id, v] of Object.entries(fr.variants)) {
        const m = v.metrics, loss = m.MAE !== undefined ? `MAE ${m.MAE}` : `Brier ${m.Brier} ECE ${m.ECE10}`; const s = v.vs_baseline;
        console.log(`${id.padEnd(3)} ${loss.padEnd(24)} ${s ? `rel ${String(s.rel_pct).padStart(7)}% CI[${s.ci95_pct}] blocks ${s.blocks.map(b => b.rel_pct).join('/')} ${s.positions ? 'F/D ' + s.positions.map(p => p.rel_pct).join('/') : ''} strata ${s.history_strata.map(x => x.rel_pct).join('/')} cov ${v.feature_coverage} chg ${v.share_rows_prediction_changed}` : ''} => ${v.class}   ${v.desc}`);
      }
      console.log('tiebreak:', JSON.stringify(fr.tiebreak));
    }
    console.log('\nguard:', JSON.stringify(res.guard));
  }
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message, e.stack && e.stack.split('\n')[1]); process.exit(1); });
