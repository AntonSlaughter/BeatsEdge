// NHL MODEL v2 PARITY TEST. Proves the PRODUCTION implementation (lib/nhlModel.js + lib/nhlProjectionEngine.js + the materializer/route +
// the frontend's one-line adjuster) reproduces the FROZEN Phase 3 research implementation (scripts/research/nhl-phase3a/*, hash-locked), so
// we cannot validate one formula and deploy another.
//
//   node scripts/test-nhl-model-parity.js          (read-only on the repo database; all writes go to temp copies)
//
// Numerical tolerance: |production - research| <= 1e-12 absolute. The only expected difference is floating-point SUMMATION ORDER in the
// league / prior means (research accumulates by date, production sums the filtered rows) -- the observed maximum is printed.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), http = require('http'), { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..'), A = path.join(__dirname, 'research', 'nhl-phase3a');
const TOL = 1e-12;
let failures = 0; const check = (name, ok, detail) => { if (ok) console.log('PASS  ' + name); else { failures++; console.log('FAIL  ' + name + (detail !== undefined ? '  -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); } };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ───────────────────────── child: runs the REAL live path (SQL + materializer + real router) against a temp DB ─────────────────────────
if (process.argv[2] === 'child') {
  const BS3 = require('better-sqlite3'); const _prep = BS3.prototype.prepare; const _keep = []; // Node 24 finalizer-abort workaround (see scripts/nhlRender/harness.js)
  BS3.prototype.prepare = function (...a) { const s = _prep.apply(this, a); _keep.push(s); return s; };
  BS3.prototype.pragma = function (source, options) { const st = this.prepare(`PRAGMA ${source}`); if (!st.reader) return st.run(); return options && options.simple ? st.pluck().get() : st.all(); };
  (async () => {
    const store = require('../lib/historicalStore'); const eng = require('../lib/nhlProjectionEngine'); const mat = require('../lib/nhlProjectionMaterializer');
    const express = require('express'); const app = express(); app.use('/api', require('../routes/api'));
    const srv = await new Promise(res => { const s = app.listen(0, () => res(s)); }); const base = `http://127.0.0.1:${srv.address().port}`;
    let phase = 'start'; const get = () => new Promise((res, rej) => { const t0 = process.hrtime.bigint(); http.get(base + '/api/nhl/player-projections', { agent: false }, r => { let t = ''; r.on('data', d => t += d); r.on('error', e => rej(new Error('response stream error in phase ' + phase + ': ' + e.message))); r.on('end', () => { try { res({ status: r.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6, bytes: t.length, body: JSON.parse(t) }); } catch (e) { rej(new Error('bad JSON in phase ' + phase + ' status ' + r.statusCode + ' len ' + t.length + ': ' + t.slice(0, 200))); } }); }).on('error', e => rej(new Error('request error in phase ' + phase + ': ' + e.message))); });
    const out = {};
    const colsBefore = (await store.query('PRAGMA table_info(nhl_player_projections)')).map(c => c.name);
    out.colsBefore = colsBefore;
    out.readOldSchema = await mat.getMaterializedProjections();                 // must NOT throw on a pre-v2 table
    out.ctxBeforeMaterialize = await mat.getOpponentContext();                  // empty table => null
    phase = 'api-before-materialize'; const r0 = await get(); out.apiBefore = { status: r0.status, hasModel: !!r0.body.model, opponentContext: r0.body.opponentContext, rows: Object.values(r0.body.projections || {}).reduce((s, a) => s + a.length, 0), versions: [...new Set(Object.values(r0.body.projections || {}).flat().map(x => x.modelVersion))] };
    const t0 = Date.now(); out.materialized = await mat.materializeNhlProjections(); out.materializeMs = Date.now() - t0;
    out.colsAfter = (await store.query('PRAGMA table_info(nhl_player_projections)')).map(c => c.name);
    out.direct = await eng.computeAllModelOutputs();                              // the SQL path, recomputed
    out.tables = { player: await store.queryOne('SELECT COUNT(*) c FROM nhl_player_projections'), team: await store.queryOne('SELECT COUNT(*) c FROM nhl_team_context') };
    await mat.materializeNhlProjections(); out.tablesAfterRerun = { player: await store.queryOne('SELECT COUNT(*) c FROM nhl_player_projections'), team: await store.queryOne('SELECT COUNT(*) c FROM nhl_team_context') };
    phase = 'api-after-materialize'; const timings = []; let last; for (let i = 0; i < 7; i++) { last = await get(); timings.push(last.ms); }
    out.apiAfter = { status: last.status, bytes: last.bytes, body: last.body }; out.apiTimingsMs = timings;
    await store.run('DELETE FROM nhl_team_context');                              // broken/empty context must not take the board down
    phase = 'api-no-context'; const r2 = await get(); out.apiNoContext = { status: r2.status, opponentContext: r2.body.opponentContext, rows: Object.values(r2.body.projections || {}).reduce((s, a) => s + a.length, 0) };
    fs.writeFileSync(process.argv[3], JSON.stringify(out)); srv.close(); process.exit(0);
  })().catch(e => { console.error('CHILD FATAL', e); process.exit(1); });
  return;
}

(async () => {
  const M = require('../lib/nhlModel'); const eng = require('../lib/nhlProjectionEngine');

  // ───────── A. the research reference is intact, and production constants equal the frozen config ─────────
  const vf = spawnSync(process.execPath, [path.join(A, 'verify-frozen.js')], { encoding: 'utf8' });
  check('A1: the frozen research reference is intact (verify-frozen.js: hashes match)', vf.status === 0, vf.stdout.split('\n').slice(-3).join(' | '));
  const cfgBytes = fs.readFileSync(path.join(A, 'frozen-config.json')); const cfg = JSON.parse(cfgBytes);
  check('A2: NHL_MODEL_SPEC_SHA256 === sha256(frozen-config.json) === the recorded freeze hash', M.NHL_MODEL_SPEC_SHA256 === sha(cfgBytes) && /frozen-config\.json sha256 (\S+)/.exec(fs.readFileSync(path.join(A, 'frozen-hash.txt'), 'utf8'))[1] === M.NHL_MODEL_SPEC_SHA256);
  const c = cfg.candidates, S = M.FAMILY_SPEC;
  check('A3: production K / strengths / structure == frozen-config.json for all five families',
    S.shots_on_goal.eb === null && S.shots_on_goal.opp.kind === 'allowed' && S.shots_on_goal.opp.strength === c.shots_on_goal.parameters.g
    && S.goalie_saves.eb.K === c.goalie_saves.parameters.K1 && S.goalie_saves.opp.kind === 'offense' && S.goalie_saves.opp.strength === c.goalie_saves.parameters.g3
    && S.goals_at_least_1.eb.K === c.goals_at_least_1.parameters.K && S.goals_at_least_1.opp === null
    && S.assists_at_least_1.eb.K === c.assists_at_least_1.parameters.K && S.assists_at_least_1.opp === null
    && S.points_at_least_1.eb.K === c.points_at_least_1.parameters.K && S.points_at_least_1.opp.kind === 'allowed' && S.points_at_least_1.opp.strength === c.points_at_least_1.parameters.g,
    { S, c: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.parameters])) });
  const mg = cfg.minimum_history_games;
  check('A4: minimum-history gates, prior pool minimums and team windows == frozen config / unchanged production gates',
    S.shots_on_goal.minGames === mg.shots_on_goal && S.goalie_saves.minGames === mg.goalie_saves && S.goals_at_least_1.minGames === mg.goals_at_least_1 && S.assists_at_least_1.minGames === mg.assists_at_least_1 && S.points_at_least_1.minGames === mg.points_at_least_1
    && M.PRIOR_MIN_ROWS.position === 2000 && M.PRIOR_MIN_ROWS.goalie === 200 && M.TEAM_CONTEXT.windowGames === 15 && M.TEAM_CONTEXT.minTeamGames === 10 && M.TEAM_CONTEXT.minLeagueTeamGames === 200
    && /2000/.test(cfg.common_definitions.mu_pos) && /200 such rows/.test(cfg.common_definitions.mu_goalie) && /fewer than 200 team-games/.test(cfg.common_definitions.league_avg) && /fewer than 10/.test(cfg.common_definitions.opponent_context) && /last <=15/.test(cfg.common_definitions.opponent_context));
  check('A5: model version is the explicit internal version', M.NHL_MODEL_VERSION === '2026.10-v2');

  // Sections B-D need the real 2024-2025 NHL history (data/beatsedge.db is git-ignored, so a fresh clone does not have it). Without it they
  // are SKIPPED and the run exits 3 ("environment, NOT a pass") -- never a false green. Sections A and E need no database and always run.
  const histRows = (await require('../lib/historicalStore').queryOne('SELECT COUNT(*) AS c FROM nhl_player_box WHERE season IN (2024,2025)')).c;
  const haveData = histRows >= 50000; let skippedBD = false;
  if (!haveData) { skippedBD = true; console.log(`SKIPPED B-D (environment): only ${histRows} NHL player-box rows for 2024-2025 in this database (need the real history, ~110k). This is NOT a pass.`); }
  if (haveData) {
  // ───────── B. large deterministic parity: production pure function vs the frozen research implementation ─────────
  const R = require('./research/nhl-phase3a/run'); const raw = await R.loadRaw(); const F = R.prepare(raw);     // research side (seasons 2024-2025 via its own guard)
  const tuned = JSON.parse(fs.readFileSync(path.join(A, 'evidence', 'tuned.json'), 'utf8')).params;           // hash-frozen, committed evidence (verified by A1)
  const PARAMS = { sog: { g: c.shots_on_goal.parameters.g, K: 0 }, saves: { ...c.goalie_saves.parameters, best: tuned.saves.best, w2: tuned.saves.w2, w4: tuned.saves.w4, g4: tuned.saves.g4 }, goal: { K: c.goals_at_least_1.parameters.K, g: 0 }, assist: { K: c.assists_at_least_1.parameters.K, g: 0 }, point: { ...c.points_at_least_1.parameters } };
  const FAMS = [['sog', 'shots_on_goal', 'S1'], ['saves', 'goalie_saves', 'V5'], ['goal', 'goals_at_least_1', 'B2'], ['assist', 'assists_at_least_1', 'B2'], ['point', 'points_at_least_1', 'B3']];
  const toProd = (rows) => rows.map(r => ({ player_id: r.pid, player_name: null, team: r.team, game_date: r.d, season: r.s, position: r.pos, val: r.v }));
  const data = { skater: { shots_on_goal: toProd(raw.sog), goals_at_least_1: toProd(raw.g), assists_at_least_1: toProd(raw.a), points_at_least_1: toProd(raw.p) }, goalie: toProd(raw.gl), teamGames: raw.tg.map(r => ({ game_id: r.gid, team: r.team, opponent: r.opp, game_date: r.d, sf: r.sf, sv: r.sv })) };
  // deterministic target dates: 14 from the thin-history 2023-24 start (Nov 2023 - Jan 2024) + 28 from the rest of 2024-25
  let seed = 4242; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const allDates = [...new Set(raw.tg.map(r => r.d))].sort(); const early = allDates.filter(d => d >= '2023-11-10' && d < '2024-02-01'), later = allDates.filter(d => d >= '2024-02-01');
  const pickN = (arr, n) => { const s = new Set(); while (s.size < Math.min(n, arr.length)) s.add(arr[Math.floor(rnd() * arr.length)]); return [...s].sort(); };
  const dates = [...pickN(early, 14), ...pickN(later, 28)];
  const researchRows = {}; for (const [fk] of FAMS) researchRows[fk] = R.collect(F, fk, [2024, 2025]);
  const final = (fam, row, ctx, oppAbbr) => { const spec = S[fam]; if (!spec.opp) return row.probability != null ? row.probability : row.projection;
    const a = M.applyOpponent(fam, row.baseLambda, ctx.teams[oppAbbr]); return M.BINARY_FAMILIES.has(fam) ? a.probability : a.projection; };
  const stats = {}; for (const [fk] of FAMS) stats[fk] = { compared: 0, maxDiff: 0, bad: 0, short: 0, long: 0, F: 0, D: 0, flips: 0, oppApplied: 0, oppMissing: 0, missingProd: 0 };
  const badEx = [];
  for (const D of dates) {
    const prod = eng.computeModelFromRows(data, { asOfExclusive: D });
    for (const [fk, fam, id] of FAMS) {
      const fm = F.fam[fk], pr = Object.fromEntries(R.predictors(fk).map(x => [x.id, x]))[id]; const byId = new Map(prod.projections[fam].map(r => [String(r.playerId), r])); const st = stats[fk];
      for (const r of researchRows[fk].filter(x => x.d === D)) {
        const row = byId.get(String(r.e.row.pid)); if (!row) { st.missingProd++; continue; }
        let mu = r.mu; const priorPos = fm.by.get(r.e.row.pid)[r.e.i - 1].pos;
        if (fm.side === 'skater' && (priorPos === 'D') !== (r.e.row.pos === 'D')) { st.flips++; mu = fm.muFn({ ...r.e.row, pos: priorPos }); }   // production = group of the player's latest PRIOR game (documented)
        const want = R.transform(fm.kind, pr.f(r.e, r.base, r.f, mu, PARAMS[fk]));
        const got = final(fam, row, prod.opponentContext, r.e.row.opp);
        const diff = Math.abs(want - got); st.compared++; if (diff > st.maxDiff) st.maxDiff = diff;
        if (!(diff <= TOL)) { st.bad++; if (badEx.length < 5) badEx.push({ fk, D, pid: r.e.row.pid, want, got }); }
        if (r.n < fm.minPrior + 20) st.short++; else st.long++; if (fm.side === 'skater') st[r.e.row.pos === 'D' ? 'D' : 'F']++;
        if (S[fam].opp) { const e = prod.opponentContext.teams[r.e.row.opp]; (e && e[S[fam].opp.kind] != null ? (st.oppApplied++) : (st.oppMissing++)); }
        if (!(row.gamesSampled === r.n) || row.modelVersion !== M.NHL_MODEL_VERSION) st.bad++;
      }
    }
  }
  for (const [fk, fam] of FAMS) { const st = stats[fk]; check(`B1[${fam}]: ${st.compared} (player, date) predictions: production == frozen research within ${TOL} (max |diff| ${st.maxDiff.toExponential(2)})`, st.compared > (fk === 'saves' ? 400 : 1500) && st.bad === 0 && st.missingProd === 0, { ...st, badEx }); }
  const tot = Object.values(stats).reduce((s, x) => s + x.compared, 0);
  check(`B2: total ${tot} deterministic comparisons across ${dates.length} target dates`, tot > 20000);
  check('B3: coverage of required strata -- goalies, forwards, defensemen, short-history and long-history players all present in volume',
    stats.saves.compared > 400 && stats.sog.F > 1000 && stats.sog.D > 500 && stats.point.F > 1000 && stats.point.D > 500 && Object.values(stats).every(x => x.short > 150 && x.long > 150), Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { short: v.short, long: v.long, F: v.F, D: v.D }])));
  check('B4: the opponent factor was exercised on real data for SOG, Saves and Point (applied > 90% of rows; the rest fall back, see C)', ['sog', 'saves', 'point'].every(k => stats[k].oppApplied > 0 && stats[k].oppApplied / (stats[k].oppApplied + stats[k].oppMissing) > 0.9), ['sog', 'saves', 'point'].map(k => [k, stats[k].oppApplied, stats[k].oppMissing]));
  check('B5: position-group convention difference vs research (group of the latest PRIOR game vs the target game) is rare and those rows still match production-convention research', Object.values(stats).every(x => x.compared === 0 || x.flips / x.compared < 0.005), Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, v.flips])));

  // ───────── C. missing opponent context / insufficient history: deterministic fail-closed fallback == frozen fallback ─────────
  {
    const cases = [undefined, null, {}, { allowed: null, offense: null }, { allowed: NaN, offense: NaN }, { allowed: Infinity, offense: Infinity }, { games: 3 }];
    let okFallback = true, okResearch = true;
    for (const [fk, fam, id] of FAMS) { const fm = F.fam[fk], pr = Object.fromEntries(R.predictors(fk).map(x => [x.id, x]))[id]; const sample = researchRows[fk].filter((x, i) => i % 997 === 0).slice(0, 40);
      for (const r of sample) { const row = { baseLambda: M.familyOutput(fam, { lambda0: r.base, n: r.n, mu: r.mu }).baseLambda };
        const want = R.transform(fm.kind, pr.f(r.e, r.base, { allowed: null, offense: null, teamSv: null }, r.mu, PARAMS[fk]));   // research with the opponent input unavailable
        const o = M.familyOutput(fam, { lambda0: r.base, n: r.n, mu: r.mu }); const unadjusted = o.probability != null ? o.probability : o.projection;
        if (Math.abs(want - unadjusted) > TOL) okResearch = false;
        if (S[fam].opp) for (const e of cases) { const a = M.applyOpponent(fam, row.baseLambda, e); const v = a.probability != null ? a.probability : a.projection; if (a.adjusted !== false || Math.abs(v - unadjusted) > TOL) okFallback = false; } } }
    check('C1: with the opponent input missing/NaN/Infinity/absent, applyOpponent returns the UNADJUSTED value (adjusted:false) for SOG, Saves, Point', okFallback);
    check('C2: that unadjusted fallback equals the frozen research implementation with its opponent input unavailable (all five families)', okResearch);
    check('C3: Goal and Assist have NO opponent factor: applyOpponent never adjusts them', ['goals_at_least_1', 'assists_at_least_1'].every(f => M.applyOpponent(f, 0.2, { allowed: 2, offense: 2 }).adjusted === false));
    const early0 = M.buildOpponentContext(data.teamGames, { asOfExclusive: '2023-10-15' });
    check('C4: too little league history (< 200 team-games) => context ratios are null (fail-closed), never fabricated', early0.league === null && Object.values(early0.teams).every(t => t.allowed === null && t.offense === null), { league: early0.league, leagueGames: early0.leagueGames });
    const noOpp = eng.computeModelFromRows({ skater: { shots_on_goal: [], goals_at_least_1: [], assists_at_least_1: [], points_at_least_1: [] }, goalie: [], teamGames: [] });
    check('C5: an empty database yields empty projections and an empty context, no crash', Object.values(noOpp.projections).every(a => a.length === 0) && noOpp.opponentContext.league === null && Object.keys(noOpp.opponentContext.teams).length === 0);
    const thin = eng.computeModelFromRows({ skater: { shots_on_goal: data.skater.shots_on_goal.filter(r => r.player_id === data.skater.shots_on_goal[0].player_id).slice(0, 9), goals_at_least_1: [], assists_at_least_1: [], points_at_least_1: [] }, goalie: [], teamGames: [] });
    check('C6: a player below the minimum-history gate (9 < 10 games) is not projected (gate unchanged)', thin.projections.shots_on_goal.length === 0);
    const pool = M.buildPrior(Array.from({ length: 1999 }, () => ({ position: 'C', val: 1 })), 'position');
    check('C7: a prior pool under its minimum (1999 < 2000 rows) gives no prior => no shrinkage, lambda unchanged', pool.F === null && M.eb(0.3, 50, pool.F, 40) === 0.3);
  }

  // ───────── D. the LIVE path: real SQL + materializer + real router, on a temp DB (pre-v2 schema => exercises the migration) ─────────
  {
    const { DatabaseSync } = require('node:sqlite'); const { BEATSEDGE_DB_PATH } = require('../lib/dataPaths');
    for (const CUT of ['2025-03-20', '2024-01-20']) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nhl-v2-parity-')); const db = new DatabaseSync(path.join(tmp, 'beatsedge.db'));
      db.exec(`ATTACH DATABASE '${BEATSEDGE_DB_PATH.replace(/'/g, "''")}' AS o`);
      db.exec(`CREATE TABLE nhl_player_box AS SELECT * FROM o.nhl_player_box WHERE season IN (2024,2025) AND game_date <= '${CUT}'`);
      const chk = db.prepare(`SELECT MAX(season) ms, MAX(game_date) mx FROM nhl_player_box`).get(); db.exec('DETACH DATABASE o');
      db.exec(`CREATE TABLE nhl_player_projections (player_id TEXT NOT NULL, stat_family TEXT NOT NULL, player_name TEXT, team TEXT, projection REAL, probability REAL, games_sampled INTEGER, rest_adjusted INTEGER DEFAULT 0, model_version TEXT, latest_game_date TEXT, calculated_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (player_id, stat_family))`);   // the PRE-v2 production schema
      // a pre-existing v1 row for a REAL player (so v2 materialization overwrites it, as in production)
      const nextDay = new Date(Date.parse(CUT + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
      const pure = eng.computeModelFromRows(data, { asOfExclusive: nextDay });            // same rows (<= CUT), pure path
      const oldPid = String(pure.projections.shots_on_goal[0].playerId);
      db.exec(`INSERT INTO nhl_player_projections (player_id, stat_family, player_name, team, projection, games_sampled, model_version) VALUES ('${oldPid}', 'shots_on_goal', 'Old Row', 'BOS', 1.5, 30, 'nhl-v1-shrinkage5-poisson')`);
      db.close(); check(`D0[${CUT}]: temp DB holds only 2024-2025 rows <= cutoff`, chk.ms <= 2025 && chk.mx <= CUT, chk);
      const outFile = path.join(tmp, 'child.json'); const r = spawnSync(process.execPath, [__filename, 'child', outFile], { env: { ...process.env, BEATSEDGE_DATA_DIR: tmp }, encoding: 'utf8', timeout: 600000 });
      if (r.status !== 0) { check(`D1[${CUT}]: child ran`, false, (r.stderr || r.stdout).slice(0, 1800)); continue; }
      const o = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      const eqFam = (a, b) => { const mb = new Map(b.map(x => [String(x.playerId), x])); let bad = 0; if (a.length !== b.length) return -1; for (const x of a) { const y = mb.get(String(x.playerId)); if (!y || x.projection !== y.projection || x.probability !== y.probability || x.baseLambda !== y.baseLambda || x.gamesSampled !== y.gamesSampled) bad++; } return bad; };
      const sqlVsPure = Object.keys(pure.projections).map(f => eqFam(o.direct.projections[f], pure.projections[f]));
      check(`D1[${CUT}]: live SQL path (computeAllModelOutputs) is BIT-IDENTICAL to the pure function for all 5 families`, sqlVsPure.every(x => x === 0), sqlVsPure);
      const ctxEq = JSON.stringify(Object.entries(o.direct.opponentContext.teams).sort()) === JSON.stringify(Object.entries(pure.opponentContext.teams).sort()) && o.direct.opponentContext.league === pure.opponentContext.league;
      check(`D2[${CUT}]: live SQL opponent context == pure function context (league avg ${pure.opponentContext.league && pure.opponentContext.league.toFixed(4)}, ${Object.keys(pure.opponentContext.teams).length} teams)`, ctxEq);
      check(`D3[${CUT}]: pre-v2 table (no base_lambda) is read without error before the first v2 materialization, serving old rows with baseLambda null`, !o.colsBefore.includes('base_lambda') && o.readOldSchema.shots_on_goal.length === 1 && o.readOldSchema.shots_on_goal[0].baseLambda === null && o.ctxBeforeMaterialize === null);
      check(`D4[${CUT}]: API before first materialization: 200, old rows labelled with their OLD model version, opponentContext null (clients apply no factor)`, o.apiBefore.status === 200 && o.apiBefore.rows === 1 && o.apiBefore.opponentContext === null && o.apiBefore.versions.join() === 'nhl-v1-shrinkage5-poisson');
      const oldRowAfter = (o.apiAfter.body.projections.shots_on_goal || []).find(x => String(x.playerId) === oldPid);
      check(`D5[${CUT}]: materialization migrates the table (adds base_lambda), OVERWRITES the pre-existing v1 row with the v2 value, and a rerun creates no duplicates`, !!oldRowAfter && oldRowAfter.modelVersion === '2026.10-v2' && oldRowAfter.baseLambda !== null && oldRowAfter.projection !== 1.5 && o.colsAfter.includes('base_lambda') &&o.tables.player.c === o.tablesAfterRerun.player.c && o.tables.team.c === o.tablesAfterRerun.team.c && o.tables.team.c === Object.keys(pure.opponentContext.teams).length, { before: o.tables, after: o.tablesAfterRerun });
      const api = o.apiAfter.body; const apiFlat = Object.fromEntries(Object.entries(api.projections));
      const apiVsPure = Object.keys(pure.projections).map(f => eqFam(apiFlat[f] || [], pure.projections[f].map(x => x))); // table round-trip + JSON must be bit-exact
      check(`D6[${CUT}]: values read back through the real API route (REAL storage + JSON) are bit-identical to the model output`, apiVsPure.every(x => x === 0), apiVsPure);
      check(`D7[${CUT}]: API metadata -- model version, spec hash, opponentAdjustment, per-row modelVersion, context teams`, api.model.version === '2026.10-v2' && api.model.specSha256 === M.NHL_MODEL_SPEC_SHA256 && JSON.stringify(api.model.opponentAdjustment) === JSON.stringify(M.opponentAdjustmentMeta()) && Object.values(api.projections).flat().every(x => x.modelVersion === '2026.10-v2') && Object.keys(api.opponentContext.teams).length === Object.keys(pure.opponentContext.teams).length);
      const med = [...o.apiTimingsMs].sort((a, b) => a - b)[3];
      check(`D8[${CUT}]: API stays fast -- median ${med.toFixed(1)} ms, max ${Math.max(...o.apiTimingsMs).toFixed(1)} ms, ${(o.apiAfter.bytes / 1024).toFixed(0)} KB (reads two materialized tables; never calls the engine); materialization ${o.materializeMs} ms off the request path`, med < 500 && Math.max(...o.apiTimingsMs) < 2000);
      check(`D9[${CUT}]: an emptied/broken context table does not break the route: 200, opponentContext null, all player rows still served`, o.apiNoContext.status === 200 && o.apiNoContext.opponentContext === null && o.apiNoContext.rows === o.tables.player.c);
    }
  }
  } // end if (haveData): sections B-D

  // ───────── E. the route never reaches the engine; frontend adjuster == server applyOpponent ─────────
  {
    const apiSrc = fs.readFileSync(path.join(ROOT, 'routes', 'api.js'), 'utf8'); const route = apiSrc.match(/router\.get\('\/nhl\/player-projections'[\s\S]*?\n\}\);/)[0];
    check('E1: /nhl/player-projections reads only materialized tables (no computeAllProjections / computeAllModelOutputs / computeModelFromRows)', /getMaterializedProjections/.test(route) && !/computeAll|computeModelFromRows/.test(route));
    const html = fs.readFileSync(path.join(ROOT, 'BeatsEdge.html'), 'utf8'); const i0 = html.indexOf('function nhlAdjustForOpponent('); let depth = 0, i = html.indexOf('{', i0), end = -1; for (let k = i; k < html.length; k++) { if (html[k] === '{') depth++; else if (html[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } } }
    const fe = new Function(html.slice(i0, end) + '; return nhlAdjustForOpponent;')();
    let bad = 0, n = 0; const meta = M.opponentAdjustmentMeta(); const vals = [undefined, null, NaN, Infinity, 0.6, 0.9, 1, 1.07, 1.4];
    for (const fam of Object.keys(meta)) for (const bl of [null, 0.05, 0.3, 1.7, 24.4]) for (const a of vals) for (const o of vals) for (const entry of [null, undefined, { allowed: a, offense: o }]) {
      const row = { projection: 9, probability: 0.9, baseLambda: bl }; const s = M.applyOpponent(fam, bl, entry); const f = fe(row, meta[fam], entry); n++;
      const sv = M.BINARY_FAMILIES.has(fam) ? s.probability : s.projection, fv = M.BINARY_FAMILIES.has(fam) ? f.probability : f.projection;
      if (bl == null) { if (f.adjusted !== false) bad++; continue; }       // server returns nulls when there is no base; the client keeps the row's own value (adjusted:false)
      if (f.adjusted !== s.adjusted) bad++; else if (s.adjusted && Math.abs(sv - fv) > TOL) bad++; else if (!s.adjusted && Math.abs(fv - (M.BINARY_FAMILIES.has(fam) ? row.probability : row.projection)) > TOL) bad++;
    }
    check(`E2: the frontend's nhlAdjustForOpponent == server applyOpponent over ${n} input combinations (incl. null/NaN/Infinity ratios and missing metadata)`, bad === 0, { bad });
    check('E3: frontend uses no hard-coded K / strength / ratio constants -- factor and strength come only from the API metadata', !/\b(40|20|0\.5)\b/.test(html.slice(i0, end)) && /meta\.strength/.test(html.slice(i0, end)) && /meta\.factor/.test(html.slice(i0, end)));
    check('E4: NHL props carry modelVersion + opponentAdjusted provenance; Edge is still projection - provider line', /modelVersion: baseModel \? \(baseModel\.modelVersion \|\| null\) : null/.test(html) && /opponentAdjusted: !!\(oppAdj && oppAdj\.adjusted\)/.test(html) && /edge: isSupported && model\.projection != null \? Math\.round\(\(model\.projection - pr\.line\) \* 100\) \/ 100 : null/.test(html));
    check('E5: product boundaries -- no NHL grade / Prime / confluence / DvP / injury / PP / TOI / rest factor in the model module', !/grade|prime|confluence|dvp|injur|powerplay|power_play|toi|restdays|back.?to.?back/i.test(fs.readFileSync(path.join(ROOT, 'lib', 'nhlModel.js'), 'utf8').replace(/\/\/.*$/gm, '')));
  }
  if (failures === 0 && skippedBD) { console.log('\nA and E passed; B-D were SKIPPED for lack of the local NHL history database -- the parity proof was NOT run. Exit 3.'); process.exit(3); }
  console.log(`\n${failures === 0 ? 'ALL NHL MODEL PARITY TESTS PASSED' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
