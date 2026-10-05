// Hermetic render harness for the NHL detail regression test (scripts/nhlRender/test-nhl-detail-render.js).
//
// What it is:
//   * the REAL routes/api.js router (so /api/nhl/player-history/:id is the real route) over a FRESH, TEMP, SEEDED SQLite
//     data dir -- BEATSEDGE_DATA_DIR points at a mkdtemp directory and every TURSO_* variable is deleted BEFORE any lib/
//     module loads, so the test can never read or write the real data/beatsedge.db or production Turso;
//   * the REAL BeatsEdge.html served from memory with ONE substitution: the ParlayAPI NHL board request is replaced by a
//     deterministic synthetic board (no network, no key). Nothing else in the page is altered unless a test option says so.
//
// Options (negative-control / robustness scenarios only):
//   injectContaminatedStats  attach a `statsByKey` to every NHL player (the exact contamination the NHL release audit found)
//   removeGuard              revert the `_isNhl` boundary in _calculateEdgeScoreImpl (proves the test detects the original crash)
const fs = require('fs'), os = require('os'), path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nhl-render-data-'));
process.env.BEATSEDGE_DATA_DIR = DATA_DIR;
for (const k of ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'TURSO_HISTORICAL_DATABASE_URL', 'TURSO_HISTORICAL_AUTH_TOKEN']) delete process.env[k];

// Environment workaround, not a product change: better-sqlite3@11 built for Node 24 aborts when a prepared Statement is
// finalized by GC ("Assertion failed: (env) != nullptr", exit 134). The repo pins Node 22.x; retaining statements avoids it.
// db.pragma() builds its Statement through the internal handle (not `prepare`), so it is re-implemented over the retained path.
const BS3 = require('better-sqlite3'); const _prep = BS3.prototype.prepare; const _keep = [];
BS3.prototype.prepare = function (...a) { const s = _prep.apply(this, a); _keep.push(s); return s; };
BS3.prototype.pragma = function (source, options) {
  const stmt = this.prepare(`PRAGMA ${source}`);
  if (!stmt.reader) return stmt.run();
  return options && options.simple ? stmt.pluck().get() : stmt.all();
};

const express = require('express');
const ROOT = path.join(__dirname, '..', '..');

const PL = {
  pesce: { id: '8477488', proj: 'B. Pesce', full: 'Brett Pesce', team: 'NJD', opp: 'PHI', pos: 'D', seed: 1 },
  kulak: { id: '8476967', proj: 'B. Kulak', full: 'Brett Kulak', team: 'COL', opp: 'BOS', pos: 'D', seed: 2 },
  bouchard: { id: '8480803', proj: 'E. Bouchard', full: 'Evan Bouchard', team: 'EDM', opp: 'TOR', pos: 'D', seed: 3 },
  ceci: { id: '8476879', proj: 'C. Ceci', full: 'Cody Ceci', team: 'LAK', opp: 'MTL', pos: 'D', seed: 4 },
  nurse: { id: '8477498', proj: 'D. Nurse', full: 'Darnell Nurse', team: 'SJS', opp: 'PHI', pos: 'D', seed: 5 },
  goalie: { id: '8475683', proj: 'S. Bobrovsky', full: 'Sergei Bobrovsky', team: 'TOR', opp: 'BOS', pos: 'G', seed: 6 },
  empty: { id: '9999991', proj: 'F. Emptyman', full: 'Frank Emptyman', team: 'NYR', opp: 'PHI', pos: 'C', seed: 7 }, // projection exists, NO stored games => genuine empty
};
const N_GAMES = 30;
const OPPS = ['PHI', 'BOS', 'TOR', 'MTL'];
const dateOf = (i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);

async function seed(store) {
  const sk = [], gl = [];
  for (const [k, p] of Object.entries(PL)) {
    if (k === 'empty') continue;
    for (let i = 0; i < N_GAMES; i++) {
      const opp = OPPS[(i + p.seed) % 4];
      if (p.pos === 'G') { const saves = 20 + ((i + p.seed) % 9); gl.push([`FX${p.id}-${i}`, p.id, p.full, 2026, dateOf(i), p.team, opp, saves, saves + 2]); }
      else {
        const goals = (i + p.seed) % 7 === 0 ? 1 : 0, assists = (i + p.seed) % 4 === 0 ? 1 : 0, sog = ((i * 3 + p.seed) % 5) + (p.seed % 2);
        sk.push([`FX${p.id}-${i}`, p.id, p.full, 2026, dateOf(i), p.team, opp, p.pos, goals, assists, goals + assists, 0, sog, 0]);
      }
    }
  }
  await store.batchInsert(`INSERT INTO nhl_player_box (game_id, player_id, player_name, season, game_date, team, opponent, position, goals, assists, points, hits, shots_on_goal, blocked_shots) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, sk);
  await store.batchInsert(`INSERT INTO nhl_player_box (game_id, player_id, player_name, season, game_date, team, opponent, saves, shots_against) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, gl);
}

function projectionsPayload() {
  const row = (p, extra) => ({ playerId: p.id, playerName: p.proj, team: p.team, projection: null, probability: null, gamesSampled: N_GAMES, restAdjusted: false, ...extra });
  const P = { shots_on_goal: [], goalie_saves: [], goals_at_least_1: [], assists_at_least_1: [], points_at_least_1: [] };
  P.shots_on_goal.push(row(PL.pesce, { projection: 1.16 }), row(PL.kulak, { projection: 1.07 }), row(PL.bouchard, { projection: 2.8 }), row(PL.ceci, { projection: 0.92 }), row(PL.nurse, { projection: 2.02 }), row(PL.empty, { projection: 2.0 }));
  P.goalie_saves.push(row(PL.goalie, { projection: 22.09 }));
  P.goals_at_least_1.push(row(PL.pesce, { probability: 0.023 }));
  P.assists_at_least_1.push(row(PL.pesce, { probability: 0.172 }));
  P.points_at_least_1.push(row(PL.pesce, { probability: 0.191 }), row(PL.kulak, { probability: 0.132 }), row(PL.bouchard, { probability: 0.807 }), row(PL.ceci, { probability: 0.196 }), row(PL.nurse, { probability: 0.195 }));
  return { date: '2026-10-05', source: 'render-test fixture', projections: P };
}

function mockBoard() {
  const ev = 'EV1', byNorm = {};
  const row = (name, home, away, line, extra = {}) => ({ playerRaw: name, homeTeam: home, awayTeam: away, commenceTimeMs: Date.now() + 3 * 3600e3, line, over: -115, under: -105, primary: true, period: 'FULL', projectionType: 'STANDARD', eventId: ev, ...extra });
  const add = (name, statKey, r) => { (((byNorm[name] = byNorm[name] || {})[statKey] = byNorm[name][statKey] || {}).prizepicks = [r]); };
  const home = (p) => [p.team, p.opp]; // home = player's team, away = opponent
  const pe = PL.pesce;
  add(pe.full, 'shots_on_goal', row(pe.full, ...home(pe), 1.5));
  add(pe.full, 'goals_at_least_1', row(pe.full, ...home(pe), 0, { rawMarket: 'player_anytime_goal_scorer' }));
  add(pe.full, 'assists_at_least_1', row(pe.full, ...home(pe), 0.5));
  add(pe.full, 'points_at_least_1', row(pe.full, ...home(pe), 0.5));
  add(pe.full, 'player_blocked_shots', row(pe.full, ...home(pe), 2.5, { rawMarket: 'player_blocked_shots' }));
  add(pe.full, 'player_first_goal_scorer', row(pe.full, ...home(pe), 0, { rawMarket: 'player_first_goal_scorer' }));
  for (const k of ['kulak', 'bouchard', 'ceci', 'nurse']) { const p = PL[k]; add(p.full, 'shots_on_goal', row(p.full, ...home(p), 2.5)); add(p.full, 'points_at_least_1', row(p.full, ...home(p), 0.5)); }
  add(PL.goalie.full, 'goalie_saves', row(PL.goalie.full, ...home(PL.goalie), 24.5));
  add(PL.empty.full, 'shots_on_goal', row(PL.empty.full, ...home(PL.empty), 2.5));
  const combo = `${PL.pesce.full} + ${PL.bouchard.full}`;
  add(combo, 'player_shots_on_goal', row(combo, 'NJD', 'EDM', 3.5, { rawMarket: 'player_shots_on_goal' }));
  add('Zzzz Unknownson', 'shots_on_goal', row('Zzzz Unknownson', 'NJD', 'PHI', 2.5));
  return { n: Object.keys(byNorm).length, truncated: false, byNorm };
}
const EXPECTED_CARDS = 9; // 7 resolvable players + 1 combo + 1 unresolvable name

function patchHtml(html, opts) {
  const re = /await fetchParlayPropsBulk\('icehockey_nhl'[\s\S]*?\},\s*isStale\);/;
  if (!re.test(html)) throw new Error('harness: NHL ParlayAPI call anchor not found in BeatsEdge.html (the file changed shape)');
  html = html.replace(re, '(window.__NHL_MOCK_PA);');
  html = html.replace('<head>', '<head><script>window.__NHL_MOCK_PA=' + JSON.stringify(mockBoard()) + ';</script>');
  if (opts.injectContaminatedStats) {
    const win = { avg: 1, hitRate: 50, games: 5, requestedGames: 5, availableGames: 30, complete: true };
    const one = { last5: win, last10: win, last15: win, last20: win, trueSeason: win, vsOpp: win }; // NB: no `season` / `recent`, like the audit's contaminated object
    const stats = {}; for (const k of ['shots_on_goal', 'goalie_saves', 'goals_at_least_1', 'assists_at_least_1', 'points_at_least_1']) stats[k] = one;
    const n = (html.match(/props, _isNhl: true,/g) || []).length;
    if (n !== 1) throw new Error(`harness: expected exactly 1 NHL player construction site, found ${n}`);
    html = html.replace('props, _isNhl: true,', 'props, _isNhl: true, statsByKey: ' + JSON.stringify(stats) + ',');
  }
  if (opts.removeGuard) {
    const g = /const s = player\._isNhl\s*\?\s*null\s*:\s*\(/;
    if (!g.test(html)) throw new Error('harness: _isNhl boundary anchor not found');
    html = html.replace(g, 'const s = (');
  }
  return html;
}

async function startHarness(opts = {}) {
  const store = require('../../lib/historicalStore');
  if (store.backend !== 'sqlite') throw new Error('harness safety: historicalStore is not local sqlite (' + store.backend + ') -- refusing to run');
  if (!seeded) { await seed(store); seeded = true; } // one temp DB per process, several page scenarios share it
  const state = { mode: 'normal', historyRequests: [] };
  const app = express();
  app.use(['/api/parlayapi', '/api/propline'], (req, res) => res.status(503).json({ status: 'unavailable', reason: 'render-test: third-party passthrough disabled' }));
  app.get('/__test/mode/:m', (req, res) => { state.mode = req.params.m; res.json({ mode: state.mode }); });
  app.get('/__test/history-requests', (req, res) => res.json(state.historyRequests));
  app.use('/api/nhl/player-history', (req, res, next) => {
    state.historyRequests.push(req.path.replace(/^\//, ''));
    if (state.mode === 'route-missing') return res.status(404).type('html').send(`<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot GET ${req.originalUrl}</pre>\n</body>\n</html>\n`);
    if (state.mode === 'http500') return res.status(500).json({ error: 'simulated server error' });
    next();
  });
  app.get('/api/nhl/player-projections', (req, res) => res.json(projectionsPayload()));
  app.use('/api', require(path.join(ROOT, 'routes', 'api')));
  app.get('/', (req, res) => {
    try { res.set('Content-Type', 'text/html; charset=utf-8').send(patchHtml(fs.readFileSync(path.join(ROOT, 'BeatsEdge.html'), 'utf8'), opts)); }
    catch (e) { res.status(500).send(String(e.message)); }
  });
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, state, PL, EXPECTED_CARDS,
    setMode: (m) => { state.mode = m; },
    historyRequests: () => state.historyRequests.slice(),
    async close() { await new Promise(r => { server.close(r); if (server.closeAllConnections) server.closeAllConnections(); }); },
  };
}
let seeded = false;
function cleanup() { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* sqlite handles may still be open on Windows; the dir is in the OS temp folder */ } }

module.exports = { startHarness, cleanup, PL, EXPECTED_CARDS, DATA_DIR };
