// Focused test for the NHL historical-detail feature (GET
// /api/nhl/player-history/:playerId + lib/nhlProjectionEngine.js's
// getPlayerGameHistory + BeatsEdge.html's nhlComputeWindows adapter +
// NhlPlayerCard's click-gating). Mirrors two existing conventions rather
// than inventing new ones: tagged-fixture insert/cleanup against the real
// historicalStore (scripts/test-nhl-engine-bulk-fixture.js), and
// balanced-brace source extraction + eval of a pure in-file function
// (scripts/test-projection-stability.js) since BeatsEdge.html has no
// module system to require() nhlComputeWindows from directly.

const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, condition, detail) { if (condition) console.log(`PASS  ${name}`); else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? '  -- ' + JSON.stringify(detail) : ''}`); } }

const HTML_PATH = path.join(__dirname, '..', 'BeatsEdge.html');
const src = fs.readFileSync(HTML_PATH, 'utf8');

function extractConst(source, name) {
  const startMarker = `const ${name} = `;
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`${name} not found in BeatsEdge.html`);
  const braceStart = source.indexOf('{', start);
  if (braceStart === -1) throw new Error(`${name}: no opening brace found`);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error(`${name}: unbalanced braces`);
  // `const`/`let` bindings created by a direct eval() stay scoped to the
  // eval call itself and never leak into the surrounding function scope
  // (true even in non-strict mode, unlike `var`/function declarations) --
  // swap only the leading `const` keyword for `var` so the extracted,
  // otherwise byte-for-byte-unmodified declaration is usable afterward.
  const body = source.slice(start, i + 1);
  return 'var ' + body.slice('const '.length) + ';';
}

// eslint-disable-next-line no-eval
eval(extractConst(src, 'NHL_STAT_FIELD'));
// eslint-disable-next-line no-eval
eval(extractConst(src, 'nhlComputeWindows'));

(async () => {
  // ── Part A: nhlComputeWindows (pure, extracted straight from the real
  // shipped file -- not a hand-copied duplicate that could drift). ──────
  // 23 synthetic, chronological skater games (goals/assists/points/SOG),
  // real-shaped rows. game_date ascending, as the real backend route
  // guarantees via ORDER BY game_date ASC.
  const skaterGames = [];
  for (let i = 1; i <= 23; i++) {
    skaterGames.push({
      game_date: `2026-01-${String(i).padStart(2, '0')}`,
      opponent: i % 3 === 0 ? 'TOR' : 'BOS',
      season: i <= 18 ? 2026 : 2027, // last 5 games roll into a new "season"
      goals: i % 4 === 0 ? 2 : (i % 2 === 0 ? 1 : 0),
      assists: i % 3 === 0 ? 1 : 0,
      points: null, shots_on_goal: 3 + (i % 5),
      saves: null, shots_against: null,
    });
  }
  skaterGames.forEach(g => { g.points = g.goals + g.assists; });

  const lineFor = { shots_on_goal: 3.5, goals_at_least_1: 0.5, assists_at_least_1: 0.5, points_at_least_1: 0.5 };
  const { statsByKey, gameLogByKey } = nhlComputeWindows(skaterGames, lineFor, 'TOR');

  // 1-4: window slicing is exactly the last N games in chronological order (leak-free).
  check('1: last5 window = exactly the final 5 chronological games', statsByKey.shots_on_goal.last5.games === 5);
  check('2: last10 window = exactly the final 10 chronological games', statsByKey.shots_on_goal.last10.games === 10);
  const expectedLast5Sog = skaterGames.slice(-5).map(g => g.shots_on_goal);
  const expectedLast5Avg = Math.round((expectedLast5Sog.reduce((s, v) => s + v, 0) / 5) * 10) / 10;
  check('3: last5 SOG average matches hand-calculated value from the real last 5 rows', statsByKey.shots_on_goal.last5.avg === expectedLast5Avg, { got: statsByKey.shots_on_goal.last5.avg, expected: expectedLast5Avg });
  check('4: last20 marked complete (23 games available >= 20 requested)', statsByKey.shots_on_goal.last20.complete === true && statsByKey.shots_on_goal.last20.availableGames === 23);

  // 5: Season = the most recent real season present (2027, the last 5 games), not a hardcoded year.
  check('5: trueSeason uses the most recent real season in the data (2027), not a hardcoded year', statsByKey.shots_on_goal.trueSeason.games === 5);

  // 6: Vs Opponent filters by the real opponent field.
  const expectedTorGames = skaterGames.filter(g => g.opponent === 'TOR').length;
  check('7: vsOpp filters strictly by the real opponent column', statsByKey.shots_on_goal.vsOpp.games === expectedTorGames && expectedTorGames > 0 && expectedTorGames < 23, { got: statsByKey.shots_on_goal.vsOpp.games, expected: expectedTorGames });

  // 8-11: binary families (Goal >=1 / Assist >=1 / Point >=1) evaluate the real count correctly
  // at BOTH real provider line conventions (0.5 here; 0 checked separately below) -- same
  // generic `v > line` formula, no special-casing, per the real adapter's own design. Checked
  // against the last20 window (a real, implemented field) over the real last 20 rows.
  const last20 = skaterGames.slice(-20);
  const expectedGoalHits = last20.filter(g => g.goals > 0.5).length; // i.e. goals >= 1
  const actualGoalHitRate = statsByKey.goals_at_least_1.last20.hitRate;
  const expectedGoalHitRate = Math.round((expectedGoalHits / 20) * 100);
  check('8: Goal >=1 (line=0.5 convention) hit rate matches hand-counted real goals>=1 games', actualGoalHitRate === expectedGoalHitRate, { got: actualGoalHitRate, expected: expectedGoalHitRate });

  const { statsByKey: statsLineZero } = nhlComputeWindows(skaterGames, { goals_at_least_1: 0 }, 'TOR');
  check('9: Goal >=1 at the REAL anytime-scorer line=0 convention produces the identical hit rate as line=0.5 (same real stat>=1 semantics, no special-casing)', statsLineZero.goals_at_least_1.last20.hitRate === expectedGoalHitRate, { got: statsLineZero.goals_at_least_1.last20.hitRate, expected: expectedGoalHitRate });

  const expectedAssistHits = last20.filter(g => g.assists > 0.5).length;
  check('10: Assist >=1 hit rate matches hand-counted real assists>=1 games', statsByKey.assists_at_least_1.last20.hitRate === Math.round((expectedAssistHits / 20) * 100));

  const expectedPointHits = last20.filter(g => g.points > 0.5).length;
  check('11: Point >=1 hit rate matches hand-counted real points>=1 games', statsByKey.points_at_least_1.last20.hitRate === Math.round((expectedPointHits / 20) * 100));

  // 12: the REAL preserved provider line (not a recomputed/invented one) rides on every game-log row.
  check('12: gameLogByKey preserves the real provider line on every row', gameLogByKey.shots_on_goal.every(g => g.line === 3.5));

  // 13: a goalie-shaped row set (goals/assists/points/shots_on_goal all null) only ever
  // produces a goalie_saves entry -- never fabricates skater stats for a goalie.
  const goalieGames = [];
  for (let i = 1; i <= 12; i++) {
    goalieGames.push({ game_date: `2026-02-${String(i).padStart(2, '0')}`, opponent: 'MTL', season: 2026, goals: null, assists: null, points: null, shots_on_goal: null, saves: 20 + i, shots_against: 24 + i });
  }
  const goalieResult = nhlComputeWindows(goalieGames, { goalie_saves: 28.5 }, 'MTL');
  check('13: goalie rows produce ONLY a goalie_saves entry, no fabricated skater families', !!goalieResult.statsByKey.goalie_saves && !goalieResult.statsByKey.shots_on_goal && !goalieResult.statsByKey.goals_at_least_1);

  // 14: an unsupported statKey is simply never invented -- only the 5 real NHL_STAT_FIELD keys ever appear.
  const allKeys = Object.keys(statsByKey);
  check('14: only the 5 validated families ever appear in statsByKey, nothing invented', allKeys.every(k => Object.prototype.hasOwnProperty.call(NHL_STAT_FIELD, k)), allKeys);

  // ── Part B: getPlayerGameHistory against the real historicalStore. ──
  const store = require('../lib/historicalStore');
  const { getPlayerGameHistory } = require('../lib/nhlProjectionEngine');
  const TAG = 9000000 + (Date.now() % 900000); // fake numeric player_id, tagged to avoid colliding with real data
  try {
    await store.batchInsert(
      `INSERT INTO nhl_player_box (game_id, player_id, player_name, season, game_date, team, opponent, position, goals, assists, points, hits, shots_on_goal, blocked_shots) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        [`${TAG}-g1`, String(TAG), 'Fixture Skater', 2026, '2026-01-10', 'BOS', 'TOR', 'C', 1, 0, 1, 1, 4, 0],
        [`${TAG}-g2`, String(TAG), 'Fixture Skater', 2026, '2026-01-05', 'BOS', 'MTL', 'C', 0, 1, 1, 0, 2, 1],
        [`${TAG}-g3`, String(TAG), 'Fixture Skater', 2026, '2026-01-20', 'BOS', 'TOR', 'C', 2, 1, 3, 2, 6, 0],
      ]
    );
    const rows = await getPlayerGameHistory(String(TAG));
    check('15: getPlayerGameHistory returns exactly the real inserted rows', rows.length === 3, rows.length);
    check('16: rows come back chronological (game_date ASC), not insertion order', rows.map(r => r.game_date).join(',') === '2026-01-05,2026-01-10,2026-01-20', rows.map(r => r.game_date));
    check('17: real skater columns round-trip exactly (goals/assists/points/shots_on_goal)', rows[1].goals === 1 && rows[1].assists === 0 && rows[1].points === 1 && rows[1].shots_on_goal === 4, rows[1]);
    check('18: a skater row never carries fabricated goalie columns', rows.every(r => r.saves == null && r.shots_against == null));
  } finally {
    await store.run(`DELETE FROM nhl_player_box WHERE player_id = ?`, [String(TAG)]);
  }

  // ── Part C: the route's own numeric playerId guard (same regex as routes/api.js). ──
  const guardRe = /^\d+$/;
  check('19: a real numeric playerId passes the route guard', guardRe.test('8478402'));
  check('20: a non-numeric / injection-shaped playerId is rejected by the route guard', !guardRe.test('8478402; DROP TABLE') && !guardRe.test('abc') && !guardRe.test(''));

  // ── Part D: static source checks -- fail-closed click-gating and no NHL grade, by construction. ──
  check('21: nhlPlayerId is sourced from the SAME fail-closed resolvedPlayerId the real headshot already uses (null for unresolved/ambiguous/combo)', src.includes('nhlPlayerId: resolvedPlayerId'));
  check('22: NhlPlayerCard only ever wires a click for a validated family on a resolved player', src.includes('const clickable = !!pr.modelSupported && !!player.nhlPlayerId;'));
  const cardStart = src.indexOf('const NhlPlayerCard = ({ player }) => {');
  const cardEnd = src.indexOf('const PlayerCard = ({ player }) => {');
  const cardSrc = src.slice(cardStart, cardEnd);
  check('23: NhlPlayerCard never references GRADE_META anywhere -- no NHL grade can render, by construction', cardStart !== -1 && cardEnd !== -1 && !cardSrc.includes('GRADE_META'));
  check('24: NhlPlayerCard never calls calculateEdgeScore -- the real prop.projection/probability/edge are shown, never a recomputed one', !cardSrc.includes('calculateEdgeScore('));
  check('25: an unsupported prop pill still shows the real, honest inline "Model not supported yet" message', cardSrc.includes("{pr.note}") && src.includes("note: isSupported ? null : 'Model not supported yet'"));

  // ── Part E: the structural render gate (closes the "Blocked Shots opened
  // the modal" bug regardless of root cause -- click-gating, stale/drifted
  // detailModal state after a background refresh, or anything else that
  // might otherwise set detailModal to point at this player). ──────────────
  check('26: a stable id is assigned to every NHL prop at push time (openDetail can now correctly capture propId, not just propIdx)', src.includes('id: `${idKey}${evSfx}:${statKey}`'));
  check('27: the active prop is resolved by stable id FIRST, index only as a fallback -- same pattern PlayerCard itself uses to avoid a background refresh silently swapping the displayed prop', cardSrc.includes('player.props.find(p => p.id === (detailModal && detailModal.propId))'));
  check('28: the modal can only become eligible to render when the resolved prop is model-supported AND the player is resolved', cardSrc.includes('const modalEligible = activeInModal && !!activeProp && activeProp.modelSupported === true && !!player.nhlPlayerId;'));
  check('29: the modal overlay itself is gated on modalEligible, not merely on "a detail modal is open for this player"', /\{modalEligible && \(\s*<DetailModalShell/.test(cardSrc) && !cardSrc.includes('className="modal-overlay"'));
  check('30: the modal body no longer contains a second, reachable "unsupported" branch -- ineligible props render no modal at all, per the real requirement', !cardSrc.includes('activeProp.modelSupported === false ?'));

  // Behavioral proof of the actual bug class, run against the real extracted
  // adapter + a hand-built mimic of NhlPlayerCard's own gate expression:
  // an unsupported prop (modelSupported:false) must never satisfy the gate,
  // even if detailModal still happens to reference this player (e.g. because
  // the user had a DIFFERENT, valid prop open a moment earlier).
  const fakePlayer = { id: 'p1', nhlPlayerId: 8478402, props: [
    { id: 'p1:shots_on_goal', statKey: 'shots_on_goal', modelSupported: true },
    { id: 'p1:player_blocked_shots', statKey: 'player_blocked_shots', modelSupported: false, note: 'Model not supported yet' },
  ] };
  const evalGate = (detailModal) => {
    const activeInModal = !!(detailModal && detailModal.playerId === fakePlayer.id);
    const activeProp = fakePlayer.props.find(p => p.id === (detailModal && detailModal.propId)) || fakePlayer.props[(detailModal && detailModal.propIdx) || 0] || fakePlayer.props[0];
    return activeInModal && !!activeProp && activeProp.modelSupported === true && !!fakePlayer.nhlPlayerId;
  };
  check('31: clicking the real supported prop (Shots on Goal) makes the gate eligible', evalGate({ playerId: 'p1', propId: 'p1:shots_on_goal', propIdx: 0 }) === true);
  check('32: Blocked Shots (unsupported) by its OWN id never makes the gate eligible', evalGate({ playerId: 'p1', propId: 'p1:player_blocked_shots', propIdx: 1 }) === false);
  check('33: even stale/drifted state (same player, an index that now resolves to Blocked Shots, no matching id) stays ineligible -- the exact class of bug this fix closes', evalGate({ playerId: 'p1', propId: 'does-not-exist', propIdx: 1 }) === false);

  // ── Part F (Phase 1): history request states. Replaces the old static checks 34-36, which
  // asserted the previous fetchNhlPlayerDetail's "any 404 = final, mark loaded" behavior --
  // exactly the behavior that rendered "No stored NHL game history" when the route was
  // missing (Express HTML 404). The extracted, pure fetchNhlHistory is exercised with a mocked fetch.
  // eslint-disable-next-line no-eval
  eval(extractConst(src, 'fetchNhlHistory'));
  const realFetch = global.fetch;
  const resp = (status, ct, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => (/content-type/i.test(k) ? ct : null) }, json: async () => { if (body === undefined) throw new Error('not json'); return body; } });
  const J = 'application/json; charset=utf-8', H = 'text/html; charset=utf-8';
  const run = async (mock, pid = '8477488', backend = 'http://b') => { global.fetch = typeof mock === 'function' ? mock : async () => mock; try { return await fetchNhlHistory(backend, pid); } finally { global.fetch = realFetch; } };
  const g1 = [{ player_id: '8477488', game_date: '2026-01-01', shots_on_goal: 2 }];
  let r;
  r = await run(resp(200, J, { playerId: '8477488', games: g1 }));
  check('34: 200 + JSON games[] => loaded (with the games)', r.status === 'loaded' && r.games.length === 1, r);
  r = await run(resp(404, J, { error: 'No stored game history for NHL player_id 8477488.', playerId: '8477488', games: [] }));
  check('35: JSON 404 with games: [] (the route\'s explicit contract) => the ONLY genuine empty', r.status === 'empty', r);
  r = await run(resp(404, H, undefined));
  check('36: Express HTML 404 ("Cannot GET /api/nhl/player-history/...", i.e. route not deployed) => ERROR route-unavailable, NEVER empty', r.status === 'error' && r.reason === 'route-unavailable', r);
  r = await run(resp(404, J, { message: 'Not Found' }));
  check('37: a JSON 404 WITHOUT the games contract (proxy/other service) => error, not empty', r.status === 'error', r);
  r = await run(resp(503, J, { status: 'unavailable', reason: 'cooldown' }));
  check('38: 503 (JSON, no games) => error http-503', r.status === 'error' && r.reason === 'http-503', r);
  r = await run(resp(500, J, { error: 'boom', games: [] }));
  check('39: a 500 is an error even if it carries games: [] -- only 200/404 can mean loaded/empty', r.status === 'error' && r.reason === 'http-500', r);
  r = await run(resp(200, H, undefined));
  check('40: 200 with a non-JSON body (captive portal / HTML shell) => error', r.status === 'error', r);
  r = await run(resp(200, J, { playerId: '8477488' }));
  check('41: 200 JSON without a games array (malformed contract) => error', r.status === 'error', r);
  r = await run(async () => { throw new TypeError('Failed to fetch'); });
  check('42: a thrown fetch (network failure) => error network', r.status === 'error' && r.reason === 'network', r);
  r = await run(resp(200, J, { playerId: '9999999', games: g1 }));
  check('43: a response for a DIFFERENT playerId is rejected (cannot inherit another player\'s history)', r.status === 'error' && r.reason === 'wrong-player', r);
  r = await run(resp(200, J, { playerId: '8477488', games: [{ player_id: '1234567', shots_on_goal: 1 }] }));
  check('44: a game row belonging to a different player_id is rejected', r.status === 'error' && r.reason === 'wrong-player', r);
  r = await run(resp(200, J, { playerId: '8477488', games: g1 }), null);
  check('45: no playerId (combo/unresolved) => error no-player, and NO request is made', r.status === 'error' && r.reason === 'no-player', r);
  let called = 0; r = await run(async () => { called++; return resp(200, J, { games: g1 }); }, '8477488', '');
  check('46: no backend URL configured => error no-backend, and NO request is made', r.status === 'error' && r.reason === 'no-backend' && called === 0, { r, called });
  let seenUrl = ''; await run(async (u) => { seenUrl = u; return resp(200, J, { games: g1 }); });
  check('47: requests exactly GET {backend}/api/nhl/player-history/{playerId}', seenUrl === 'http://b/api/nhl/player-history/8477488', seenUrl);

  // ── Part G (Phase 1): NHL explicitly excluded from the grade engine; history state separated. ──
  check('48: _calculateEdgeScoreImpl excludes NHL by IDENTITY (player._isNhl => no stats), not by "happens to have none"', /const s = player\._isNhl\s*\?\s*null/.test(src));
  check('49: the old fetchNhlPlayerDetail (which wrote statsByKey/gameLogByKey onto NHL players) is gone', !src.includes('fetchNhlPlayerDetail'));
  check('50: NHL history is component-local: NhlPlayerCard never calls setPlayersData and never reads player.statsByKey / gameLogByKey / _detailLoaded', !/setPlayersData/.test(cardSrc) && !/player\.statsByKey|player\.gameLogByKey|_detailLoaded/.test(cardSrc));
  check('51: nothing anywhere attaches statsByKey/gameLogByKey to an NHL player object', !/sport === 'nhl'\)\s*\?\s*\{\s*\.\.\.p,\s*statsByKey/.test(src));
  check('50b: NHL history/tab state is App-level (survives the card being re-created on App re-render) and keyed by resolved NHL player id -- not on the player object', src.includes('const [nhlHistoryById, setNhlHistoryById] = useState({});') && src.includes('const hist = nhlHistoryById[player.nhlPlayerId] || { status: \'idle\' };'));
  check('52: history is only requested when the modal is eligible (supported family + resolved player)', cardSrc.includes('if (modalEligible && hist.status === \'idle\') loadNhlHistory(player);'));
  check('52b: loading is idempotent per player (an in-flight request is never repeated)', src.includes('nhlHistoryInflight.current.has(id)') && src.includes('nhlHistoryInflight.current.add(id)'));
  check('53: loading / error(with Retry) / empty / loaded each render their own state', ['data-nhl-history="loading"', 'data-nhl-history="error"', 'data-nhl-history-retry="1"', 'data-nhl-history="empty"', 'data-nhl-history="loaded"'].every(s => cardSrc.includes(s)));
  check('54: "No NHL game history for this player" appears ONLY in the genuine-empty state', (cardSrc.match(/No NHL game history/g) || []).length === 1 && /hist\.status === 'empty'[\s\S]{0,260}No NHL game history/.test(cardSrc));
  check('55: a failed load is retried when the modal is next opened', cardSrc.includes("if (!activeInModal && hist.status === 'error') setHistStatus('idle');"));

  // ── Part H (Phase 1): the real route's JSON contract over real HTTP, and the real classifier against it. ──
  {
    const BS3 = require('better-sqlite3'); const _prep = BS3.prototype.prepare; const _keep = []; // Node 24 finalizer abort workaround (see scripts/nhlRender/harness.js)
    BS3.prototype.prepare = function (...a) { const s = _prep.apply(this, a); _keep.push(s); return s; };
    BS3.prototype.pragma = function (source, options) { const st = this.prepare(`PRAGMA ${source}`); if (!st.reader) return st.run(); return options && options.simple ? st.pluck().get() : st.all(); };
    const express = require('express'), http = require('http');
    const app = express(); app.use('/api', require('../routes/api'));
    const bare = express(); // a backend WITHOUT the route (Express default HTML 404)
    const srv = await new Promise(res => { const s = app.listen(0, () => res(s)); });
    const srv2 = await new Promise(res => { const s = bare.listen(0, () => res(s)); });
    const base = (s) => `http://127.0.0.1:${s.address().port}`;
    const getRaw = (b, p) => new Promise(res => http.get(b + p, rr => { let t = ''; rr.on('data', d => t += d); rr.on('end', () => res({ status: rr.statusCode, ct: rr.headers['content-type'] || '', body: t })); }));
    const FIX = 9100000 + (Date.now() % 800000);
    try {
      await store.batchInsert(`INSERT INTO nhl_player_box (game_id, player_id, player_name, season, game_date, team, opponent, position, goals, assists, points, hits, shots_on_goal, blocked_shots) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        [`${FIX}-a`, String(FIX), 'Fixture Skater', 2026, '2026-02-02', 'BOS', 'TOR', 'C', 1, 0, 1, 0, 3, 0],
        [`${FIX}-b`, String(FIX), 'Fixture Skater', 2026, '2026-02-01', 'BOS', 'MTL', 'C', 0, 1, 1, 0, 2, 0]]);
      const ok = await getRaw(base(srv), `/api/nhl/player-history/${FIX}`); const okJ = JSON.parse(ok.body);
      check('56: route 200 => application/json { playerId, source, games[] } with only the documented columns, chronological', ok.status === 200 && /application\/json/.test(ok.ct) && okJ.playerId === String(FIX) && typeof okJ.source === 'string' && okJ.games.length === 2 && okJ.games[0].game_date < okJ.games[1].game_date && Object.keys(okJ.games[0]).sort().join() === ['assists', 'game_date', 'game_id', 'goals', 'opponent', 'player_id', 'player_name', 'points', 'saves', 'season', 'shots_against', 'shots_on_goal', 'team'].join(), { status: ok.status, keys: okJ.games && Object.keys(okJ.games[0]) });
      const none = await getRaw(base(srv), '/api/nhl/player-history/1'); const noneJ = JSON.parse(none.body);
      check('57: route unknown id => 404 application/json { error, playerId, games: [] } (explicit genuine-empty contract)', none.status === 404 && /application\/json/.test(none.ct) && typeof noneJ.error === 'string' && noneJ.playerId === '1' && Array.isArray(noneJ.games) && noneJ.games.length === 0, none);
      const bad = await getRaw(base(srv), '/api/nhl/player-history/abc');
      check('58: route malformed id => 400 JSON { error } with NO games array (so the frontend treats it as an error)', bad.status === 400 && /application\/json/.test(bad.ct) && !('games' in JSON.parse(bad.body)), bad);
      const miss = await getRaw(base(srv2), `/api/nhl/player-history/${FIX}`);
      check('59: a backend without the route answers Express HTML 404 (what production did)', miss.status === 404 && /text\/html/.test(miss.ct) && /Cannot GET/.test(miss.body), miss);
      const c1 = await fetchNhlHistory(base(srv), String(FIX)), c2 = await fetchNhlHistory(base(srv), '1'), c3 = await fetchNhlHistory(base(srv2), String(FIX)), c4 = await fetchNhlHistory(base(srv), 'abc');
      check('60: real classifier vs real route: loaded / empty / ERROR (route missing) / ERROR (400)', c1.status === 'loaded' && c1.games.length === 2 && c2.status === 'empty' && c3.status === 'error' && c3.reason === 'route-unavailable' && c4.status === 'error', { c1: c1.status, c2: c2.status, c3, c4 });
    } finally {
      await store.run(`DELETE FROM nhl_player_box WHERE player_id = ?`, [String(FIX)]);
      srv.close(); srv2.close();
    }
  }
})().then(() => {
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}).catch(e => {
  console.error('ERROR', e);
  process.exit(1);
});
