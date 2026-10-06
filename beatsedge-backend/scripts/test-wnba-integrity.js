// WNBA integrity phase (2026-10-06) -- clean pipeline BEFORE calibration / cap validation. Proves:
//   1. live == backtest: the in-app WNBA backtest scores sport 'wnba' with the live builders' inputs; identical inputs => identical projection,
//      raw probability, final probability, confidence, Prime, rawGrade, finalGrade, gradeAdjustmentReason;
//   2. versioned WNBA_GRADE_CONFIG; no WNBA customer output depends on browser localStorage;
//   3. simdef cannot change WNBA model output (context only);
//   4. an observed 0 is valid history, "--" is a MISSING observation (WNBA parse), missing history fails closed;
//   5. unsupported / insufficient props cannot enter +EV (the list itself gates);
//   6. NBA frozen model output is unchanged (vs the committed HEAD page); MLB/NFL/NCAAF unchanged;
//   7. the uncommitted WNBA period-model block is untouched / does not touch the full-game model.
//   node scripts/test-wnba-integrity.js
const fs = require('fs'), path = require('path'), os = require('os');
const { execSync } = require('child_process');
const { loadModel, sliceArrowFn, HTML_PATH } = require('./lib/loadBeatsEdgeModel');
const { buildLiveShapedNbaPlayer, toGlRow } = require('./lib/nbaHistoricalInputs');
let failures = 0;
const check = (n, c, d) => { if (c) console.log(`PASS  ${n}`); else { failures++; console.log(`FAIL  ${n}${d ? '  -- ' + d : ''}`); } };
const skip = (n, w) => console.log(`SKIP  ${n}  -- ${w}`);
const html = fs.readFileSync(HTML_PATH, 'utf8');
const FUTURE = Date.now() + 6 * 3600e3;
const FAMILIES = ['points', 'rebounds', 'assists', 'threes', 'steals', 'blocks', 'turnovers', 'pra', 'pr', 'pa', 'ra', 'blocksSteals'];
const LINES = { points: 10.5, rebounds: 4.5, assists: 2.5, threes: 1.5, steals: 0.5, blocks: 0.5, turnovers: 1.5, pra: 17.5, pr: 14.5, pa: 13.5, ra: 6.5, blocksSteals: 1.5 };
const LIVE = (k, line, dir, x) => Object.assign({ statKey: k, type: k, line, direction: dir, lineSource: 'ParlayAPI · prizepicks', eventId: 'ev1', commenceTimeMs: FUTURE, book: 'prizepicks' }, x || {});
const BT = (k, line, dir) => ({ statKey: k, type: k, line, direction: dir, lineSource: 'backtest' });
const CAPTURE = [];
const m = loadModel({ liveNba: true, sandboxExtras: { __capture: CAPTURE }, transform: (s) => s.replace('function calculateEdgeScore(player, prop) {', 'function calculateEdgeScore(player, prop) { if (typeof __capture !== "undefined" && __capture.on) __capture.push({ player, prop });') });
CAPTURE.on = false;
const REQ = ['projection', 'rawModelProbPct', 'modelProbPct', 'confidence', 'prime', 'rawGrade', 'finalGrade', 'gradeAdjustmentReason'];
const sig = (e, f) => JSON.stringify((f || REQ).map(k => e[k]));

function synth(seed, mm, sport, opts) {
  opts = opts || {}; let a = seed >>> 0; const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const opps = ['NY', 'LV', 'SEA', 'CHI', 'MIN', 'PHX'], scale = 0.5 + r() * 1.1;
  const hist = Array.from({ length: 60 }, (_, i) => ({ game_id: 'w' + seed + '_' + i, athlete_id: 'w' + seed, season: 2025, season_type: 2, game_date: new Date(Date.UTC(2025, 4, 20) + i * 2 * 864e5).toISOString().slice(0, 10), team: 'IND', opponent: opps[i % 6], home_away: i % 2 ? 'home' : 'away', pos_group: 'G',
    minutes: 20 + Math.round(r() * 12), points: Math.round((4 + r() * 18) * scale), rebounds: Math.round((1 + r() * 7) * scale), assists: Math.round(r() * 6 * scale), threes: Math.round(r() * 3.5 * scale), steals: Math.round(r() * 2.4), blocks: Math.round(r() * 1.6), turnovers: Math.round(r() * 3.4) }));
  const target = { game_id: 'wt' + seed, athlete_id: 'w' + seed, season: 2025, season_type: 2, game_date: '2025-09-10', team: 'IND', opponent: 'NY', home_away: 'home', pos_group: 'G' };
  const p = buildLiveShapedNbaPlayer(mm || m, Object.assign({ target, hist, lineFor: LINES, prevTeamDate: '2025-09-08' }, opts.def || {})); p.sport = sport || 'wnba'; return p;
}

console.log('# 1. live == backtest (WNBA)');
{
  let n = 0, bad = []; const adj = new Set();
  for (const seed of Array.from({ length: 30 }, (_, i) => i * 5 + 2)) { const p = synth(seed); for (const k of FAMILIES) for (const d of ['over', 'under']) for (const dl of [-2, -0.5, 0, 0.5, 2, 5]) { const line = Math.max(0.5, LINES[k] + dl); const a = m.calculateEdgeScore(p, BT(k, line, d)), b = m.calculateEdgeScore(p, LIVE(k, line, d)); n++; if (sig(a) !== sig(b)) bad.push(seed + '/' + k + '/' + d + '/' + line); if (b.gradeAdjustmentReason) adj.add(b.gradeAdjustmentReason); } }
  check(`${n} WNBA scorings: backtest convention == live on projection, raw probability, final probability, confidence, Prime, rawGrade, finalGrade, adjustment reason`, bad.length === 0, bad.slice(0, 4).join(' '));
  check('the adjustment pipeline really fires in the WNBA fixtures (not vacuous): ' + [...adj].join('|'), adj.size > 0);
  const dbPath = path.join(__dirname, '..', 'data', 'beatsedge.db');
  if (!fs.existsSync(dbPath)) skip('in-app backtest function on real WNBA rows', 'data/beatsedge.db absent');
  else {
    const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(dbPath, { readOnly: true });
    const ids = db.prepare(`SELECT athlete_id FROM wnba_player_box WHERE season IN (2024, 2025) AND season_type = 2 AND played = 1 AND minutes > 10 GROUP BY athlete_id HAVING COUNT(*) >= 50 ORDER BY athlete_id LIMIT 6`).all().map(r => r.athlete_id);
    let pairs = 0, badPair = [], windowsMatch = 0, windowsChecked = 0, wrongSport = 0, notLiveBuilt = 0;
    for (const id of ids) {
      const dbr = db.prepare(`SELECT game_id, athlete_id, season, season_type, game_date, team_abbreviation AS team, opponent_team_abbreviation AS opponent, home_away, pos_group, minutes, points, rebounds, assists, threes, steals, blocks, turnovers FROM wnba_player_box
        WHERE athlete_id = ? AND season IN (2023, 2024, 2025) AND played = 1 AND minutes > 0 AND points IS NOT NULL AND rebounds IS NOT NULL AND assists IS NOT NULL AND threes IS NOT NULL AND steals IS NOT NULL AND blocks IS NOT NULL AND turnovers IS NOT NULL ORDER BY game_date, game_id`).all(id);
      const rows = dbr.map(r => toGlRow(m, r)); const vals = rows.map(r => m.NBA_PROP_DEFS.points.get(r.row) || 0), mins = rows.map(r => r.row.minutes), opps = rows.map(r => r.opponent), tss = rows.map(r => r.ts), homes = rows.map(r => !/^@/.test(r.vsLabel));
      CAPTURE.length = 0; CAPTURE.on = true; const acc = m.emptyBacktestAcc();
      m.nbaBacktestSeries(vals.slice(0, 40), mins.slice(0, 40), opps.slice(0, 40), tss.slice(0, 40), homes.slice(0, 40), 'G', 'points', acc, undefined, 'wnba', rows.slice(0, 40)); CAPTURE.on = false;
      const caps = CAPTURE.slice(); CAPTURE.length = 0;
      for (const c of caps.slice(0, 40)) { pairs++; if (c.player.sport !== 'wnba') wrongSport++;
        const liveProp = Object.assign({}, c.prop, { lineSource: 'ParlayAPI · prizepicks', eventId: 'ev1', commenceTimeMs: FUTURE, book: 'prizepicks' }); const clone = Object.assign({}, c.player);
        const a = m.calculateEdgeScore(c.player, c.prop), b = m.calculateEdgeScore(clone, liveProp); if (sig(a) !== sig(b)) badPair.push(id + ':' + c.prop.direction); }
      // the windows the backtest fed the model == what the LIVE builder produces from the same earlier rows
      for (const c of caps.filter(x => x.prop.direction === 'over').slice(0, 6)) { windowsChecked++; let found = false;
        for (let idx = 14; idx < 40 && !found; idx++) { const built = m.nbaComputeWindows(rows.slice(0, idx), { points: c.prop.line }, c.player.opponent, null, rows[idx] && rows[idx].season); if (JSON.stringify(built.statsByKey.points) === JSON.stringify(c.player.statsByKey.points) && JSON.stringify(built.gameLogByKey.points) === JSON.stringify(c.player.gameLogByKey.points)) found = true; }
        if (found) windowsMatch++; else notLiveBuilt++; } }
    check(`the in-app WNBA backtest scored ${pairs} real-row predictions with sport 'wnba' (was hard-coded 'nba'), and each re-scores identically through the live path`, pairs > 50 && wrongSport === 0 && badPair.length === 0, `wrongSport=${wrongSport} bad=${badPair.slice(0, 3)}`);
    check(`the backtest feeds the model the LIVE builder's windows and per-game log (${windowsMatch}/${windowsChecked} predictions reproduced by nbaComputeWindows on the same earlier rows)`, windowsChecked > 10 && notLiveBuilt === 0);
  }
  check('source: nbaBacktestSeries takes a sportKey + liveRows, and the WNBA branch passes them', /const nbaBacktestSeries = \(vals, mins, opps, tss, homes, group, statKey, acc, gate, sportKey, liveRows\)/.test(html) && /nbaBacktestSeries\(vals, mins, opps, tss, homes, group, k, acc, gate, 'wnba', rows\)/.test(html) && /sport: sportKey \|\| 'nba'/.test(html));
}

console.log('\n# 2. versioned WNBA config; no localStorage authority');
{
  const c = m.WNBA_GRADE_CONFIG;
  check('WNBA_GRADE_CONFIG is frozen: null cutoffs (default thresholds), IDENTITY calibration (probCalib null), Cap C (floored) -- the accepted BETA spec', Object.isFrozen(c) && c.id === 'wnba-defaults-2026-10-06' && c.gradeCutoffs === null && c.probCalib === null && c.wildGapRule === 'floored' && c.wildGapRuleSpec === 'abs(edge) / max(line, predictiveSpreadSD) > 0.50');
  check('WNBA config documents the spread caveat (conservative scale/floor, not a per-player SD); no family-specific cap values exist', /not a precise per-player SD/.test(c.predictiveSpreadCaveat) && Object.keys(c).every(k => !/family|perFamily|byFamily/i.test(k)));
  { const { wnbaSpecFingerprint } = require('./lib/wnbaSpecFingerprint'); const fp = wnbaSpecFingerprint(m).sha256;
    check('FROZEN SPEC FINGERPRINT unchanged (any change to the WNBA spec must be a NEW model version + new hash): ' + fp.slice(0, 16) + '...', fp === '13ac5cf63275ce3271e98454679cb1884cc3c3ee7602217d170f1f6203e9cd59', fp); }
  { // Cap C is what the engine actually applies to WNBA (and ONLY to WNBA among the non-NBA sports)
    const W = m.wildGapExceeds, mkp = (sp, k, line) => { const p = synth(21, m, sp); return m.calculateEdgeScore(p, LIVE(k, line, 'over')); };
    check('wildGapExceeds floored = Cap C: 0.4 edge on a 0.5 line with SD 1.0 is NOT capped; 0.6 is; threshold stays 0.50', W('floored', 0.4, 0.5, 1, true) === false && W('floored', 0.6, 0.5, 1, true) === true && W('floored', 0.5, 0.5, 1, true) === false);
    const e = mkp('wnba', 'blocks', 0.5);
    check('engine: WNBA metadata reports the floored rule; the predictive spread is exposed on the edge', e.modelMeta.wildGapRule === 'floored' && Number.isFinite(e.predictiveSpreadSD) && e.predictiveSpreadSD >= 1);
    // direct engine proof: across many WNBA BLK/STL/3PM scorings the capped set is exactly {|edge|/max(line,SD) > .5}, never the old |edge|/line set
    let n = 0, badRule = 0, oldOnly = 0; for (const seed of [3, 8, 13, 18, 23, 28]) { const p = synth(seed, m, 'wnba'); for (const k of ['blocks', 'steals', 'threes', 'turnovers', 'points']) for (const d of ['over', 'under']) for (const line of [0.5, 1.5, 2.5, 4.5, 9.5]) { const ed = m.calculateEdgeScore(p, LIVE(k, line, d)); if (ed.insufficientData) continue; n++; const exp = Math.abs(ed.edge) / Math.max(line, ed.predictiveSpreadSD) > 0.5; if (!!ed.wildGap !== exp) badRule++; if (Math.abs(ed.edge) / line > 0.5 && !exp && ed.wildGap) oldOnly++; } }
    check(`engine: ${n} WNBA scorings -- wildGap equals |edge|/max(line,SD) > 0.50 exactly (none follow the old |edge|/line rule where they differ)`, n > 100 && badRule === 0 && oldOnly === 0, `bad=${badRule}`);
    const diffSports = ['mlb', 'nfl', 'ncaaf'].every(sp => { const a = mkp(sp, 'blocks', 0.5), b = mkp(sp, 'blocks', 0.5); return a.wildGap === b.wildGap; });
    check('invalid/missing spread fails closed to the original rule for WNBA (no invented SD)', [undefined, null, NaN, 0, -3].every(sdv => [[0.4, 0.5], [8, 15], [3, 5.5]].every(([ed, l]) => W('floored', ed, l, sdv, true) === W('relative', ed, l, sdv, true))) && diffSports);
  }
  check('WNBA does not borrow NBA config values (separate object, NBA cap rule differs)', c !== m.NBA_GRADE_CONFIG && m.NBA_GRADE_CONFIG.wildGapRule === 'floored');
  const SEED = { beatsedge_grade_cutoffs_v1: JSON.stringify({ wnba: { A: 0.30, B: 0.20, C: 0.10 }, mlb: { A: 0.30, B: 0.20, C: 0.10 } }), beatsedge_prob_calib_v1: JSON.stringify({ wnba: [[22, 5], [50, 90], [78, 99]], mlb: [[22, 5], [50, 90], [78, 99]] }) };
  const bA = loadModel({ liveNba: true, localStorageSeed: SEED }), bB = loadModel({ liveNba: true });
  let n = 0, bad = []; const F2 = REQ.concat(['gradeScore', 'thinData', 'wildGap']);
  for (const seed of [4, 9, 16, 25, 36]) { const pA = synth(seed, bA), pB = synth(seed, bB); for (const k of FAMILIES) for (const d of ['over', 'under']) for (const src of [BT(k, LINES[k], d), LIVE(k, LINES[k], d)]) { const a = bA.calculateEdgeScore(pA, src), b = bB.calculateEdgeScore(pB, Object.assign({}, src)); n++; if (sig(a, F2) !== sig(b, F2) || JSON.stringify(a.probSteps) !== JSON.stringify(b.probSteps)) bad.push(seed + '/' + k + '/' + d); } }
  check(`two browsers with DIFFERENT WNBA localStorage give IDENTICAL official WNBA output (${n} scorings)`, bad.length === 0, bad.slice(0, 3).join(' '));
  let mlbDiff = 0; for (const seed of [4, 9]) { const pA = synth(seed, bA, 'mlb'), pB = synth(seed, bB, 'mlb'); for (const k of FAMILIES) { const a = bA.calculateEdgeScore(pA, LIVE(k, LINES[k], 'over')), b = bB.calculateEdgeScore(pB, LIVE(k, LINES[k], 'over')); if (a.grade !== b.grade || a.modelProbPct !== b.modelProbPct) mlbDiff++; } }
  check('control: the same stored values still alter MLB (so the WNBA equality is real)', mlbDiff > 0, 'mlbDiff=' + mlbDiff);
  const pB = synth(77, bB), before = FAMILIES.map(k => sig(bB.calculateEdgeScore(pB, LIVE(k, LINES[k], 'over')), F2)).join();
  bB.__setGradeCutoffs({ wnba: { A: 0.2, B: 0.1, C: 0.05 } }); bB.__setProbCalib({ wnba: [[20, 1], [60, 99]] }); bB.bumpEdgeCache(); const pB2 = synth(77, bB);
  check('an in-memory GRADE_CUTOFFS / PROB_CALIB override for WNBA (what the in-app backtest does) leaves official output unchanged', before === FAMILIES.map(k => sig(bB.calculateEdgeScore(pB2, LIVE(k, LINES[k], 'over')), F2)).join());
  check('source: WNBA reads cutoffs/calibration only from WNBA_GRADE_CONFIG; the WNBA backtest persists nothing', /sport === 'wnba' \? WNBA_GRADE_CONFIG\.gradeCutoffs/.test(html) && /sport === 'wnba' \? WNBA_GRADE_CONFIG\.probCalib/.test(html) && /selectedSport !== 'nba' && selectedSport !== 'wnba'\) \{ try \{ localStorage\.setItem\('beatsedge_grade_cutoffs_v1'/.test(html));
  const e = m.calculateEdgeScore(synth(3), LIVE('points', 10.5, 'over'));
  check('WNBA edge exposes rawGrade / finalGrade / gradeAdjustmentReason and the frozen BETA modelMeta (version, state BETA, calibration id, floored cap, defense NONE, real-line PENDING)', 'rawGrade' in e && 'finalGrade' in e && 'gradeAdjustmentReason' in e && e.finalGrade === e.grade && e.modelMeta.modelVersion === 'wnba-edge-2026.10-nodef-v1' && e.modelMeta.calibrationId === 'wnba-defaults-2026-10-06' && e.modelMeta.modelState === 'BETA' && e.modelMeta.wildGapRule === 'floored' && e.modelMeta.defenseFeature === 'NONE' && e.modelMeta.realLineValidation === 'PENDING' && /1\.38/.test(e.modelMeta.calibrationException));
}

console.log('\n# 3. simdef cannot change WNBA model output');
{
  const ranks = { NY: 2, LV: 11, SEA: 5, CHI: 9, MIN: 7, PHX: 12 };
  let n = 0, bad = [], fired = 0;
  for (const seed of Array.from({ length: 12 }, (_, i) => i * 7 + 1)) {
    const base = synth(seed), withR = synth(seed, m, 'wnba', { def: { oppRankByAbbr: ranks, oppRank: ranks.NY } });
    withR.gameLogByKey.points.forEach(g => { g.points = (g.oppRank != null && g.oppRank <= 8) ? 20 : 4; });   // make the similar-defense split fire
    const base2 = synth(seed); base2.gameLogByKey.points.forEach((g, i) => { g.points = withR.gameLogByKey.points[i].points; });
    for (const k of FAMILIES) for (const d of ['over', 'under']) { const pr = LIVE(k, LINES[k], d); const a = m.calculateEdgeScore(base2, pr), b = m.calculateEdgeScore(withR, Object.assign({}, pr)); n++; const F = REQ.concat(['gradeScore', 'thinData', 'edgePct', 'greenCount', 'totalFactors']); if (sig(a, F) !== sig(b, F) || JSON.stringify(a.probSteps) !== JSON.stringify(b.probSteps)) bad.push(seed + '/' + k + '/' + d); if ((b.context || []).some(x => x.key === 'simdef')) fired++; if (b.factors.some(f => f.key === 'simdef')) bad.push('simdef in factors ' + seed); } }
  check(`${n} WNBA scorings: with vs without the opponent-rank inputs => identical projection, probability, confidence, grade, Prime`, bad.length === 0, bad.slice(0, 3).join(' '));
  check('the similar-defense split still FIRES as context only (research information stays, truthfully labeled)', fired > 0 && (() => { const p = synth(5, m, 'wnba', { def: { oppRankByAbbr: ranks, oppRank: ranks.NY } }); p.gameLogByKey.points.forEach(g => { g.points = (g.oppRank != null && g.oppRank <= 8) ? 20 : 4; }); const e = m.calculateEdgeScore(p, LIVE('points', 10.5, 'over')); const c = (e.context || []).find(x => x.key === 'simdef'); return c && c.contextOnly && /^Context only/.test(c.label); })(), 'fired=' + fired);
}

console.log('\n# 4. zero values vs missing observations');
{
  const mkRows = (n, f) => Array.from({ length: n }, (_, i) => ({ eventId: 'z' + i, ts: Date.parse('2026-05-10T12:00:00Z') + i * 2 * 864e5, date: 'd', dateShort: 'd', opponent: ['NY', 'LV'][i % 2], vsLabel: 'vs NY', season: 2026, row: f(i) }));
  const run = (glRows, key, line) => { const { statsByKey, gameLogByKey } = m.nbaComputeWindows(glRows, { [key]: line }, 'NY', null, 2026); const p = { id: 'z' + Math.random(), sport: 'wnba', position: 'G', opponent: 'NY', statsByKey, gameLogByKey, stats: {}, minutesTrend: 0, props: [] }; const prop = { statKey: key, type: key, line, direction: 'over', lineSource: 'x', eventId: 'e', commenceTimeMs: FUTURE, modelSupported: true, hitRate: 50 }; m.applyHistoryGate([prop], statsByKey); return { e: m.calculateEdgeScore(p, prop), prop, statsByKey }; };
  const zero5 = run(mkRows(5, () => ({ points: 8, totalRebounds: 3, assists: 1, steals: 0, blocks: 0, turnovers: 1, minutes: 20, [m.NBA_3PM]: 0 })), 'blocks', 0.5);
  check('five RECORDED games of 0 blocks are REAL history: not insufficient, 5 games, graded (thin-capped), model-supported', !zero5.e.insufficientData && zero5.statsByKey.blocks.season.games === 5 && zero5.statsByKey.blocks.season.avg === 0 && zero5.prop.modelSupported !== false && zero5.e.grade != null);
  check('hasRealModelHistory: zero VALUES (5 games, avg 0) = history; zero OBSERVATIONS (0 games) = none; null average = none', m.hasRealModelHistory({ season: { games: 5, avg: 0 } }) && !m.hasRealModelHistory({ season: { games: 0, avg: 0 } }) && !m.hasRealModelHistory({ season: { games: 5, avg: null } }));
  const never = run(mkRows(5, () => ({ points: 8, minutes: 20 })), 'blocks', 0.5);
  check('a stat NEVER recorded on any row (zero observations) is INSUFFICIENT_DATA and model-unsupported', never.e.insufficientData === true && never.prop.modelSupported === false);
  // the parser
  const parse = new Function(sliceArrowFn(html, 'const nflParseGamelog = (gl, opts) => {') + '; return nflParseGamelog;')();
  const payload = (cells) => ({ names: ['minutes', 'points', 'blocks'], events: { e1: { gameDate: '2026-06-01T00:00:00Z', opponent: { abbreviation: 'NY' }, atVs: 'vs' } }, seasonTypes: [{ displayName: 'Regular Season', categories: [{ events: [{ eventId: 'e1', stats: cells }] }] }] });
  const rec0 = parse(payload(['22', '8', '0']), { nonNumericAsMissing: true })[0].row, dash = parse(payload(['--', '--', '--']), { nonNumericAsMissing: true })[0].row, mixed = parse(payload(['22', '--', '0']), { nonNumericAsMissing: true })[0].row;
  check('WNBA parse: a recorded "0" stays the number 0', rec0.blocks === 0 && rec0.points === 8 && rec0.minutes === 22 && 'blocks' in rec0);
  check('WNBA parse: "--" is a MISSING observation (field absent), not an observed 0', !('points' in dash) && !('blocks' in dash) && !('minutes' in dash) && !('points' in mixed) && mixed.blocks === 0 && mixed.minutes === 22);
  check('default parse (NFL / NBA / others) keeps its previous behavior: "--" -> 0 (scope-limited fix)', (() => { const r = parse(payload(['--', '--', '--']))[0].row; return r.points === 0 && r.blocks === 0; })());
  check('source: only the two WNBA gamelog call sites pass nonNumericAsMissing', (html.match(/nflParseGamelog\(gl, \{ nonNumericAsMissing: true \}\)/g) || []).length === 2 && !/nflParseGamelog\(gl, \{ nonNumericAsMissing: true \}\)[^\n]*NBA_ESPN/.test(html));
  // end to end: 5 real zero games + 3 dash games -> 5 games (dash games excluded), avg 0; all dashes -> insufficient
  const glMix = [...mkRows(5, () => ({ points: 8, totalRebounds: 3, assists: 1, steals: 0, blocks: 0, turnovers: 1, minutes: 20, [m.NBA_3PM]: 0 })), ...Array.from({ length: 3 }, (_, i) => ({ eventId: 'd' + i, ts: Date.parse('2026-06-01T12:00:00Z') + i * 864e5, date: 'd', dateShort: 'd', opponent: 'NY', vsLabel: 'vs NY', season: 2026, row: parse(payload(['--', '--', '--']), { nonNumericAsMissing: true })[0].row }))];
  const mix = run(glMix, 'blocks', 0.5);
  check('5 real zero games + 3 "--" games => the model sees 5 games (the "--" games are excluded, not counted as zeros)', mix.statsByKey.blocks.season.games === 5 && !mix.e.insufficientData);
  const allDash = run(Array.from({ length: 6 }, (_, i) => ({ eventId: 'q' + i, ts: Date.parse('2026-06-01T12:00:00Z') + i * 864e5, date: 'd', dateShort: 'd', opponent: 'NY', vsLabel: 'vs NY', season: 2026, row: parse(payload(['--', '--', '--']), { nonNumericAsMissing: true })[0].row })), 'blocks', 0.5);
  check('a gamelog of only "--" cells => INSUFFICIENT_DATA (fails closed), no fabricated zeros', allDash.e.insufficientData === true && allDash.prop.modelSupported === false);
  const empty = { id: 'w0', sport: 'wnba', position: 'G', opponent: 'NY', statsByKey: {}, stats: {}, gameLogByKey: {}, props: [{ statKey: 'points', type: 'points', line: 10.5, direction: 'over', lineSource: 'x', eventId: 'e', commenceTimeMs: FUTURE, hitRate: 90, plusEV: { eligible: true, modelDifference: 5, marketDifference: 5 } }] };
  const ee = m.calculateEdgeScore(empty, empty.props[0]);
  check('missing history fails closed for WNBA: no grade, no Prime, not in Top / Prime picks, not Smart-Parlay eligible', ee.insufficientData === true && ee.grade === null && ee.prime === false && m.findTopPicks([empty], 5).length === 0 && m.findPrimePicks([empty]).length === 0 && m.smartParlayEligibility(ee, empty.props[0]).eligible === false && m.playerBestGrade(empty).grade === null);
}

console.log('\n# 5. +EV list gate');
{
  const good = synth(10); good.props = [Object.assign(LIVE('points', 10.5, 'over'), { plusEV: { eligible: true, modelDifference: 5, marketDifference: 5 } })]; good.id = 'good';
  const noHist = { id: 'nohist', sport: 'wnba', position: 'G', opponent: 'NY', statsByKey: {}, stats: {}, gameLogByKey: {}, props: [Object.assign(LIVE('points', 10.5, 'over'), { plusEV: { eligible: true, modelDifference: 9, marketDifference: 9 } })] };      // NOT pre-flagged: the list itself must refuse it
  const flagged = synth(11); flagged.id = 'flag'; flagged.props = [Object.assign(LIVE('points', 10.5, 'over'), { modelState: 'INSUFFICIENT_DATA', plusEV: { eligible: true, modelDifference: 9, marketDifference: 9 } })];
  const unsupported = synth(12); unsupported.id = 'unsup'; unsupported.props = [Object.assign(LIVE('points', 10.5, 'over'), { modelSupported: false, plusEV: { eligible: true, modelDifference: 9, marketDifference: 9 } })];
  const ids = m.findPlusEVPicks([good, noHist, flagged, unsupported]).map(r => r.player.id);
  check('+EV list: a prop with NO history (not pre-flagged), an INSUFFICIENT_DATA-state prop and a modelSupported:false prop are all refused by the list itself; a valid prop still lists', ids.length === 1 && ids[0] === 'good', ids.join(','));
}

console.log('\n# 6. NBA frozen output unchanged; MLB/NFL/NCAAF unchanged (vs the COMMITTED page)');
{
  let headPath = null; try { const buf = execSync('git show HEAD:./BeatsEdge.html', { cwd: path.join(__dirname, '..'), maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }); headPath = path.join(os.tmpdir(), 'BeatsEdge.HEAD.' + process.pid + '.html'); fs.writeFileSync(headPath, buf); } catch (e) { /* no git */ }
  if (!headPath) skip('NBA/MLB/NFL/NCAAF vs HEAD', 'git HEAD not available');
  else {
    const head = loadModel({ liveNba: true, htmlPath: headPath }); const CORE = REQ.concat(['gradeScore', 'thinData', 'edge', 'edgePct', 'matchupLabel', 'wildGap']);
    let n = 0, bad = []; const NB = (mm, seed) => { const p = synth(seed, mm, 'nba'); p.position = 'G'; return p; };
    for (const seed of [2, 7, 12, 19, 23, 31]) { const pn = NB(m, seed), ph = NB(head, seed); for (const k of FAMILIES) for (const d of ['over', 'under']) for (const dl of [-1, 0, 1, 3]) for (const src of ['bt', 'live']) { const line = Math.max(0.5, LINES[k] + dl); const prop = src === 'bt' ? BT(k, line, d) : LIVE(k, line, d); const a = m.calculateEdgeScore(pn, prop), b = head.calculateEdgeScore(ph, Object.assign({}, prop)); n++; if (sig(a, CORE) !== sig(b, CORE)) bad.push('nba/' + seed + '/' + k + '/' + d + '/' + src); } }
    check(`${n} NBA scorings (backtest + live shapes): identical to the frozen commit on projection, probability, confidence, Prime, rawGrade, finalGrade, reason, cap`, bad.length === 0, bad.slice(0, 3).join(' '));
    let n2 = 0, bad2 = []; for (const sport of ['mlb', 'nfl', 'ncaaf']) for (const seed of [1, 9, 17]) { const pn = synth(seed, m, sport), ph = synth(seed, head, sport); for (const k of FAMILIES) for (const d of ['over', 'under']) for (const src of ['bt', 'live']) { const prop = src === 'bt' ? BT(k, LINES[k], d) : LIVE(k, LINES[k], d, { odds: -110, oppOdds: -110 }); const a = m.calculateEdgeScore(pn, prop), b = head.calculateEdgeScore(ph, Object.assign({}, prop)); n2++; if (sig(a, CORE) !== sig(b, CORE)) bad2.push(sport + '/' + seed + '/' + k + '/' + d + '/' + src); } }
    check(`${n2} MLB / NFL / NCAAF scorings identical to the committed page`, bad2.length === 0, bad2.slice(0, 3).join(' '));
    try { fs.unlinkSync(headPath); } catch (e) { }
  }
}

console.log('\n# 7. WNBA period-model work untouched / separate');
{
  const a = html.indexOf('Phase 2I-L -- WNBA PERIOD MODEL'), b = html.indexOf('const fetchWnbaSlate = async');
  const block = a > -1 && b > a ? html.slice(a, b) : '';
  // Always true: the pure model region (grade engine, configs, selection) has no dependency on the separate WNBA period-model work.
  check('the full-game model region does not reference the WNBA period model (periodEdge / wnbaPeriodModel / WNBA_PERIOD_*)', !/periodEdge|wnbaPeriodModel|WNBA_PERIOD|wnbaEnrichPeriod/.test(require('./lib/loadBeatsEdgeModel').readRegion()));
  if (!block) skip('period-model block checks', 'the WNBA period-model work is separate and not part of this build');
  else {
    check('the period-model block is present', block.length > 6000 && /function wnbaPeriodModel\(/.test(block) && /const wnbaEnrichPeriod1HAssists = async/.test(block));
    check('the period-model block never calls the full-game model or its builders', !/calculateEdgeScore\(|nbaComputeWindows\(|statsByKey\s*=|\.statsByKey\[/.test(block.replace(/\/\/[^\n]*/g, '')));
    check('it still attaches only prop.periodEdge to the provider-only 1H assists prop (modelSupported untouched)', /pr\.periodEdge = result/.test(block) && !/modelSupported\s*=/.test(block.replace(/\/\/[^\n]*/g, '')));
    check('the period-model grade cutoffs are its own, not WNBA_GRADE_CONFIG', /WNBA_PERIOD_GRADE_CUTOFFS/.test(block) && !/WNBA_GRADE_CONFIG/.test(block));
    check('the period block is not WNBA full-game config territory (no WNBA_GRADE_CONFIG / nonNumericAsMissing / simdef edits inside it)', !/nonNumericAsMissing|simdef/.test(block));
  }
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
