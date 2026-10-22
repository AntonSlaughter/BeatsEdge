'use strict';
// Turso "quota exceeded" resilience (production incident 2026-10-22): the account's rows-written quota ran out, Turso answered every WRITING statement with
// BLOCKED (reads still worked), and GET /api/health -- an async Express 4 handler with no try/catch that awaited the historical store -- turned that into an
// unhandled promise rejection, which Node 22 treats as fatal (exit 1). Ten other routes crashed the same way. This test boots the REAL server.js against two Turso
// test doubles that refuse writes, hits every GET route plus the write routes, and requires the process to stay alive.
//   scenario "schema-present": the historical double has its schema and one ingest_log row, then refuses writes from the start (as in production: the schema exists,
//                              the quota ran out). Reads must keep working.
//   scenario "schema-absent" : the historical double is EMPTY and refuses writes, so every historical query fails. Nothing may crash; /api/health must still answer 200.
//   snapshots double (both)  : writes allowed while the server boots (its schema is created), then refused (the quota ran out later).
// Nothing here touches the network, a real Turso database or production data. Run: node scripts/test-turso-blocked-resilience.js
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), { spawn } = require('child_process');
const { startHranaDouble } = require('./lib/hranaDouble');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'turso-blocked-'));
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };

const PARAMS = { sport: 'nba', season: '2026', team: 'BOS', playerName: 'Test Player', gameId: '1', playerId: '1' };
function getRoutes() {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'api.js'), 'utf8'); const out = [];
  for (const m of src.matchAll(/^router\.get\('([^']+)'/gm)) { const p = m[1]; if (/propline|parlayapi|\*/.test(p)) continue; out.push('/api' + p.replace(/:(\w+)/g, (_, k) => encodeURIComponent(PARAMS[k] || '1'))); }
  return out;
}
function request(port, method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 15000, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', (e) => resolve({ error: e.code || e.message })); req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    if (data) req.write(data); req.end();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function scenario(name, seeded) {
  console.log('\n=== scenario: ' + name);
  const hist = await startHranaDouble({ file: path.join(TMP, name + '-hist.db') }); const snap = await startHranaDouble({ file: path.join(TMP, name + '-snap.db') });
  if (seeded) {   // seed the historical schema through the real store, then refuse writes for good
    process.env.TURSO_HISTORICAL_DATABASE_URL = hist.url; process.env.TURSO_HISTORICAL_AUTH_TOKEN = 'test';
    const hs = require('../lib/historicalStore'); const h0 = await hs.healthStatus(); if (!h0.ok) throw new Error('could not seed the historical double: ' + h0.error);
    await hs.run(`INSERT INTO ingest_log (run_type, rows_added, notes) VALUES ('seed', 1, 'seeded-before-block')`);
  }
  hist.setBlockWrites(true);
  const env = Object.assign({}, process.env, { PORT: String(40000 + Math.floor(Math.random() * 2000)), SKIP_STARTUP_JOBS: '1', BEATSEDGE_DATA_DIR: path.join(TMP, name + '-data'), TURSO_DATABASE_URL: snap.url, TURSO_AUTH_TOKEN: 'test',
    TURSO_HISTORICAL_DATABASE_URL: hist.url, TURSO_HISTORICAL_AUTH_TOKEN: 'test', NODE_ENV: 'production' });
  fs.mkdirSync(env.BEATSEDGE_DATA_DIR, { recursive: true });
  let child = null, log = [], boots = 0;
  const boot = async () => {
    log = []; boots++; child = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: ROOT, env }); const push = (d) => { String(d).split('\n').forEach(l => { if (l.trim()) { log.push(l); if (log.length > 60) log.shift(); } }); }; child.stdout.on('data', push); child.stderr.on('data', push);
    for (let i = 0; i < 120; i++) { if (child.exitCode !== null) return false; if (log.some(l => /listening on port/.test(l))) return true; await sleep(250); } return false;
  };
  ok(await boot(), name + ': server boots against the doubles');
  snap.setBlockWrites(true);   // the snapshots quota runs out after the server is up
  const crashes = []; const results = [];
  const hit = async (method, p, body) => {
    const r = await request(env.PORT, method, p, body); await sleep(250);
    const dead = child.exitCode !== null; results.push({ method, p, status: r.status || r.error, dead });
    if (dead) { crashes.push(method + ' ' + p); await boot(); snap.setBlockWrites(true); }
    return r;
  };
  const health = await hit('GET', '/api/health');   // the route the page's connection test uses
  for (const p of getRoutes()) { if (p !== '/api/health') await hit('GET', p); }
  await hit('POST', '/api/snapshots', { date: '2026-10-22', sport: 'nba', rows: [{ player: 'Test Player', stat: 'points', line: 20.5, dir: 'over', book: 'prizepicks', lineSource: 'test' }] });
  await hit('POST', '/api/snapshots/settle');
  const health2 = await hit('GET', '/api/health');
  console.log('route results (' + results.length + '): ' + results.map(r => (r.dead ? 'CRASH ' : '') + r.p.replace('/api', '') + '=' + r.status).join('  '));
  ok(crashes.length === 0, name + ': no route crashed the server while Turso refuses writes' + (crashes.length ? ' -- crashed on: ' + crashes.join(' ; ') : ''));
  ok(health.status === 200 && /"ok"\s*:\s*true/.test(health.body || ''), name + ': GET /api/health answers 200 {ok:true} (got ' + (health.status || health.error) + ')');
  ok(health2.status === 200, name + ': GET /api/health still answers 200 after all the other requests');
  if (seeded) ok(/seeded-before-block/.test(health.body || ''), name + ': the historical database is still READ while writes are blocked');
  else ok(/"historical"\s*:\s*"unavailable"/.test(health.body || ''), name + ': health reports the historical database as unavailable instead of failing');
  const dhRes = await request(env.PORT, 'GET', '/api/data-health'); let dhj = null; try { dhj = JSON.parse(dhRes.body); } catch (e) { /* ignore */ }
  ok(dhRes.status === 200 && dhj && dhj.historical, name + ': GET /api/data-health answers 200');
  // /api/health answering 200 must NOT hide the dependency problem: data-health still reports the Turso write restriction honestly
  ok(dhj && dhj.historical && dhj.historical.connected === false && /BLOCKED/.test(String(dhj.historical.error)), name + ': /api/data-health reports historical connected=false with the BLOCKED error (' + (dhj && dhj.historical ? dhj.historical.connected + ' / ' + String(dhj.historical.error).slice(0, 40) : 'n/a') + ')');
  ok(boots === 1 + crashes.length, name + ': the server restarted only because of crashes (' + boots + ' boot(s))');
  try { child.kill(); } catch (e) { /* ignore */ } await hist.close(); await snap.close();
}

// A failed schema check must not be cached for the life of the process: once Turso accepts writes again (quota reset / plan upgraded) the NEXT call must work without a restart.
async function retryScenario() {
  console.log('\n=== scenario: recovery without restart');
  const d = await startHranaDouble({ file: path.join(TMP, 'retry-hist.db'), blockWrites: true });
  process.env.TURSO_HISTORICAL_DATABASE_URL = d.url; process.env.TURSO_HISTORICAL_AUTH_TOKEN = 'test';
  for (const k of Object.keys(require.cache)) if (/lib[\\/](historicalStore|schemaCatalog)\.js$/.test(k)) delete require.cache[k];
  const hs = require('../lib/historicalStore');
  const a = await hs.healthStatus(); ok(a.ok === false && /BLOCKED/.test(a.error || ''), 'recovery: while blocked, healthStatus reports the failure (not a throw): ' + String(a.error).slice(0, 50));
  d.setBlockWrites(false);
  const b = await hs.healthStatus(); ok(b.ok === true, 'recovery: after Turso accepts writes again, the very next call succeeds without a restart (ok=' + b.ok + ')');
  await d.close();
}

(async () => {
  await scenario('schema-present', true);
  await scenario('schema-absent', false);
  await retryScenario();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test harness error:', e); process.exit(2); });
