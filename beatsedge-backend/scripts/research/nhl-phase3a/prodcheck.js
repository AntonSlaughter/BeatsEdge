// PRODUCTION-EQUIVALENCE CHECK. Runs the REAL production compute path (lib/nhlProjectionEngine.computeAllProjections, SQL and all)
// against a temp SQLite copy that contains ONLY seasons 2024-2025 rows dated <= CUT, then compares every player's output with this
// harness's as-of replay (same loaders/gates/formulas). Zero difference required. The temp DB never contains a 2026 row.
//   node scripts/research/nhl-phase3a/prodcheck.js
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const CUT = '2025-02-28';
if (process.argv[2] === 'child') { // fresh process: production module bound to the temp DB
  const eng = require('../../../lib/nhlProjectionEngine');
  eng.computeAllProjections().then(r => { fs.writeFileSync(process.argv[3], JSON.stringify(r)); process.exit(0); }).catch(e => { console.error('CHILD FATAL', e); process.exit(1); });
  return;
}
(async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { BEATSEDGE_DB_PATH } = require('../../../lib/dataPaths');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nhl-p3a-')); const dbp = path.join(tmp, 'beatsedge.db');
  const db = new DatabaseSync(dbp);
  db.exec(`ATTACH DATABASE '${BEATSEDGE_DB_PATH.replace(/'/g, "''")}' AS o`);
  db.exec(`CREATE TABLE nhl_player_box AS SELECT * FROM o.nhl_player_box WHERE season IN (2024,2025) AND game_date <= '${CUT}'`);
  const chk = db.prepare(`SELECT COUNT(*) n, MAX(game_date) mx, MAX(season) ms FROM nhl_player_box`).get();
  db.exec('DETACH DATABASE o'); db.close();
  if (!(chk.ms <= 2025 && chk.mx <= CUT)) throw new Error('temp DB contains out-of-range rows: ' + JSON.stringify(chk));
  console.log('temp DB rows:', chk.n, 'max date', chk.mx, 'max season', chk.ms);
  const out = path.join(tmp, 'prod.json');
  const r = spawnSync(process.execPath, [__filename, 'child', out], { env: { ...process.env, BEATSEDGE_DATA_DIR: tmp }, encoding: 'utf8', timeout: 600000 });
  if (r.status !== 0) throw new Error('child failed: ' + r.stderr + r.stdout);
  const prod = JSON.parse(fs.readFileSync(out, 'utf8'));

  const L = require('./lib');
  const fams = [
    ['shots_on_goal', () => L.loadSkater('shots_on_goal'), 10, 'projection', v => L.shrinkageFive(v)],
    ['goalie_saves', () => L.loadGoalie(), 8, 'projection', v => L.shrinkageFive(v)],
    ['goals_at_least_1', () => L.loadSkater('goals'), 15, 'probability', v => L.poissonPOver1(L.shrinkageFive(v))],
    ['assists_at_least_1', () => L.loadSkater('assists'), 15, 'probability', v => L.poissonPOver1(L.shrinkageFive(v))],
    ['points_at_least_1', () => L.loadSkater('points'), 15, 'probability', v => L.poissonPOver1(L.shrinkageFive(v))],
  ];
  let allOk = true; const report = {};
  for (const [key, load, minPrior, field, f] of fams) {
    const rows = (await load()).filter(x => x.d <= CUT); const by = L.groupBy(rows, 'pid'); const mine = new Map();
    for (const [pid, g] of by) if (g.length >= minPrior) mine.set(String(pid), { v: f(g.map(x => x.v)), n: g.length });
    const theirs = new Map(prod[key].map(p => [String(p.playerId), p]));
    let maxDiff = 0, nDiff = 0, missing = 0, extra = 0, gamesDiff = 0;
    for (const [pid, m] of mine) { const t = theirs.get(pid); if (!t) { missing++; continue; } const d = Math.abs(t[field] - m.v); if (d > maxDiff) maxDiff = d; if (d !== 0) nDiff++; if (t.gamesSampled !== m.n) gamesDiff++; }
    for (const pid of theirs.keys()) if (!mine.has(pid)) extra++;
    const ok = missing === 0 && extra === 0 && maxDiff === 0 && gamesDiff === 0 && mine.size > 0; allOk = allOk && ok;
    report[key] = { players_replay: mine.size, players_production: theirs.size, missing_in_production: missing, extra_in_production: extra, max_abs_diff: maxDiff, players_with_any_diff: nDiff, gamesSampled_mismatch: gamesDiff, EXACT_MATCH: ok };
    console.log(key.padEnd(20), JSON.stringify(report[key]));
  }
  fs.writeFileSync(path.join(__dirname, '..', '..', '..', 'tmp', 'nhl-phase3a', 'prodcheck.json'), JSON.stringify({ cutoff: CUT, report, allOk }, null, 2));
  console.log(allOk ? 'PRODUCTION PATH == RESEARCH REPLAY (exact, all 5 families)' : 'MISMATCH -- research replay does NOT match production');
  process.exit(allOk ? 0 : 2);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
