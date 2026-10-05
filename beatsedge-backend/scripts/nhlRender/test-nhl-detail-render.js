// MOUNTED / RENDERED regression test for the NHL detail experience (NHL release audit, Phase 1).
//
//   node scripts/nhlRender/test-nhl-detail-render.js
//
// Mounts the REAL BeatsEdge.html (React + Babel from cdnjs, so it needs network access) in a headless Chrome/Edge driven over
// the DevTools protocol (scripts/nhlRender/cdp.js, zero npm dependencies), against the REAL routes/api.js on a hermetic temp
// SQLite DB (scripts/nhlRender/harness.js -- never the real data dir, never Turso). The only page substitution is the ParlayAPI
// NHL board request -> a deterministic synthetic board.
//
// Exit codes: 0 = all passed; 1 = assertion failures; 3 = ENVIRONMENT (no browser / no network) -- NOT a pass.
//
// Proves: supported NHL prop opens the detail modal, real history loads, the app never unmounts or throws; unsupported props,
// combos and unresolved players never open model detail nor request history; no Grade/Prime/confluence DOM; genuine-empty vs
// route-missing vs 5xx vs retry states; NHL stays out of the grade engine even when an NHL player is contaminated with
// statsByKey (and a NEGATIVE CONTROL proves this test detects the original crash when the boundary is removed).
const H = require('./harness'); // FIRST: sets BEATSEDGE_DATA_DIR + clears TURSO_* before any lib/ module loads
const cdp = require('./cdp');

let failures = 0;
const check = (name, ok, detail) => { if (ok) console.log(`PASS  ${name}`); else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? '  -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FATAL = /^UNCAUGHT|TypeError|ReferenceError|Cannot read propert|The above error occurred/;
const fatalOf = (page) => page.errors.filter(e => FATAL.test(e));

const PAGE_HELPERS = `
window.__t = {
  clickBtn: t => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === t); if (b) b.click(); return !!b; },
  card: n => [...document.querySelectorAll('.player-card')].find(c => (c.querySelector('.player-name') || {}).textContent === n),
  pill: (n, re) => { const c = window.__t.card(n); return c ? ([...c.querySelectorAll('.prop-pill')].find(p => re.test(p.textContent)) || null) : null; },
  click: (n, re) => { const p = window.__t.pill(n, re); if (p) p.click(); return !!p; },
  cursor: (n, re) => { const p = window.__t.pill(n, re); return p ? getComputedStyle(p).cursor : null; },
  cards: () => document.querySelectorAll('.player-card').length,
  mounted: () => !!document.querySelector('#root') && document.querySelector('#root').children.length > 0,
  modal: () => !!document.querySelector('.modal-overlay'),
  modalText: () => (document.querySelector('.modal-overlay') || {}).innerText || '',
  hist: () => { const m = document.querySelector('.modal-overlay'); const e = m && m.querySelector('[data-nhl-history]'); return e ? e.getAttribute('data-nhl-history') : null; },
  closeModal: () => { const b = document.querySelector('.modal-overlay .close-btn'); if (b) b.click(); return !!b; },
  tab: t => { const b = [...document.querySelectorAll('.modal-overlay .stats-tab')].find(x => x.textContent.trim() === t); if (b) b.click(); return !!b; },
  stat: label => { const it = [...document.querySelectorAll('.modal-overlay .stat-summary-item')].find(x => (x.querySelector('.stat-summary-label') || {}).textContent === label); return it ? it.querySelector('.stat-summary-value').textContent : null; },
  gradeDom: () => document.querySelectorAll('.grade-badge, .grade-badge-sm, .is-prime, .prime-banner, .factors-list, .matchup-verdict-banner').length,
  gradeText: () => /Factor Confluence|FACTORS SUPPORT|GREEN MATCHUP|RED MATCHUP|PRIME CORNER|MODEL PROBABILITY\\s*\\n?\\s*FACTOR/i.test(document.body.innerText),
};`;

async function openApp(browser, harness) {
  const page = await browser.newPage();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('beatsedge_backend_url','${harness.url}');localStorage.setItem('beatsedge_parlayapi_key','render-test');localStorage.setItem('beatsedge_plan','pro');}catch(e){}${PAGE_HELPERS}` });
  await page.send('Page.navigate', { url: harness.url + '/' });
  try { await page.waitFor("window.__t && __t.mounted() && [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'NHL')", 150000, 'app mounted'); }
  catch (e) { const hasReact = await page.eval('typeof React !== "undefined"').catch(() => false); if (!hasReact) { const err = new Error('React/Babel did not load (needs network access to cdnjs.cloudflare.com)'); err.code = 'NO_NETWORK'; throw err; } throw e; }
  return page;
}
async function goNhlBrowse(page, expectCards) {
  await page.eval("__t.clickBtn('NHL')"); await sleep(1200);
  await page.eval("__t.clickBtn('Browse')");
  await page.waitFor(`__t.cards() >= ${expectCards}`, 45000, `>= ${expectCards} NHL cards`);
}
const openPill = async (page, name, re) => { const ok = await page.eval(`__t.click(${JSON.stringify(name)}, ${re})`); if (!ok) throw new Error(`pill not found: ${name} ${re}`); };

async function scenarioNormal(browser) {
  const harness = await H.startHarness({}); const { PL, EXPECTED_CARDS } = harness;
  const page = await openApp(browser, harness);
  try {
    await goNhlBrowse(page, EXPECTED_CARDS);
    check('N1: NHL Browse mounts the full synthetic board (7 players + 1 combo + 1 unresolvable = 9 cards)', (await page.eval('__t.cards()')) === EXPECTED_CARDS, await page.eval('__t.cards()'));
    check('N2: supported pill is clickable (pointer); Blocked Shots / First Goal Scorer are not', (await page.eval(`__t.cursor('Brett Pesce', /SHOTS ON GOAL/i)`)) === 'pointer' && (await page.eval(`__t.cursor('Brett Pesce', /BLOCKED/i)`)) === 'default' && (await page.eval(`__t.cursor('Brett Pesce', /FIRST GOAL/i)`)) === 'default');
    check('N3: no grade/Prime/confluence DOM anywhere on the NHL board before any detail is opened', (await page.eval('__t.gradeDom()')) === 0 && !(await page.eval('__t.gradeText()')));

    // 1) supported NHL prop opens detail, history loads, app does not unmount
    await openPill(page, 'Brett Pesce', '/SHOTS ON GOAL/i');
    await page.waitFor('__t.modal()', 10000, 'modal open');
    await page.waitFor("__t.hist() === 'loaded'", 20000, 'history loaded');
    await sleep(1500); // the original crash fired on the re-render right after history arrived
    const mt = await page.eval('__t.modalText()');
    check('N4: supported prop opened the detail modal and real history LOADED (analytics + chart present)', /Analytics/.test(mt) && (await page.eval("document.querySelectorAll('.modal-overlay .chart-bar-col').length")) === 10, mt.slice(0, 200));
    check('N5: the app is still mounted with all cards after history arrived (no unmount / crash)', (await page.eval('__t.mounted()')) && (await page.eval('__t.cards()')) === EXPECTED_CARDS);
    check('N6: no uncaught exception / TypeError / React render error during the whole flow', fatalOf(page).length === 0, fatalOf(page));
    check('N7: the detail shows the model projection and the real line, and NOT "No stored NHL game history"', /MODEL PROJECTION/i.test(mt) && /1\.16/.test(mt) && /1\.5/.test(mt) && !/No stored NHL game history/.test(mt), mt.slice(0, 300));
    check('N8: detail has NO Grade / Prime / Factor Confluence / matchup-verdict DOM or text', (await page.eval('__t.gradeDom()')) === 0 && !(await page.eval('__t.gradeText()')));

    // windows are real, chronological history: L5 -> 5 games; Vs <opp> -> exactly the fixture games vs that opponent
    await page.eval("__t.tab('L5')"); await sleep(300);
    check('N9: L5 window shows exactly 5 games', (await page.eval("__t.stat('Games')")) === '5');
    const OPPS = ['PHI', 'BOS', 'TOR', 'MTL']; let vs = 0; for (let i = 0; i < 30; i++) if (OPPS[(i + PL.pesce.seed) % 4] === PL.pesce.opp) vs++;
    await page.eval(`__t.tab('Vs ${PL.pesce.opp}')`); await sleep(300);
    check(`N10: "Vs ${PL.pesce.opp}" window filters by the real opponent column (${vs} fixture games)`, (await page.eval("__t.stat('Games')")) === String(vs), await page.eval("__t.stat('Games')"));
    await page.eval("__t.tab('L20')"); await sleep(300);
    check('N11: L20 window shows 20 games', (await page.eval("__t.stat('Games')")) === '20');

    // 2) unsupported / combo / unresolved never open model detail and never request history
    await page.eval('__t.closeModal()'); await sleep(500);
    for (const [name, re, label] of [['Brett Pesce', '/BLOCKED/i', 'Blocked Shots (unsupported)'], ['Brett Pesce', '/FIRST GOAL/i', 'First Goal Scorer (unsupported)'], [`${PL.pesce.full} + ${PL.bouchard.full}`, '/SHOTS ON GOAL/i', 'combo prop'], ['Zzzz Unknownson', '/SHOTS ON GOAL/i', 'unresolved player']]) {
      await openPill(page, name, re); await sleep(900);
      check(`N12: ${label} does NOT open the model-detail modal`, !(await page.eval('__t.modal()')));
      const note = await page.eval(`(__t.pill(${JSON.stringify(name)}, ${re}) || {innerText: ''}).innerText`);
      check(`N13: ${label} still shows "Model not supported yet" inline`, /Model not supported yet/.test(note), note);
    }
    check('N14: combo and unresolved cards carry no headshot <img> and no resolved history', (await page.eval(`['${PL.pesce.full} + ${PL.bouchard.full}', 'Zzzz Unknownson'].every(n => !__t.card(n).querySelector('.player-avatar img'))`)));
    const reqs = harness.historyRequests();
    check('N15: only the ONE supported, resolved player ever requested history (no request for unsupported/combo/unresolved)', reqs.length === 1 && reqs[0] === PL.pesce.id, reqs);

    // 3) NHL never enters grade logic: Top Picks / sorting views still render without NHL grades or errors
    await page.eval("__t.clickBtn('Top Picks')"); await sleep(1500);
    check('N16: Top Picks (NHL) renders without error, lists no NHL player, no grade/Prime DOM', (await page.eval('__t.mounted()')) && !(await page.eval("document.body.innerText.includes('Brett Pesce')")) && (await page.eval('__t.gradeDom()')) === 0, await page.eval("document.body.innerText.slice(0,200)"));
    check('N17: still no fatal errors after the full flow', fatalOf(page).length === 0, fatalOf(page));
  } finally { await page.close(); await harness.close(); }
}

async function scenarioEmpty(browser) {
  const harness = await H.startHarness({}); const { PL, EXPECTED_CARDS } = harness; const page = await openApp(browser, harness);
  try {
    await goNhlBrowse(page, EXPECTED_CARDS);
    await openPill(page, PL.empty.full, '/SHOTS ON GOAL/i');
    await page.waitFor("__t.hist() === 'empty'", 20000, 'genuine empty state');
    const mt = await page.eval('__t.modalText()');
    check('E1: a successful "no stored rows" answer (JSON 404 with games: []) shows the truthful no-history state', /No stored NHL game history for this player yet\./.test(mt) && !/Retry/.test(mt), mt.slice(0, 250));
    check('E2: the empty state still shows the model projection, and the app stays mounted', /MODEL PROJECTION/i.test(mt) && (await page.eval('__t.mounted()')) && fatalOf(page).length === 0);
  } finally { await page.close(); await harness.close(); }
}

async function scenarioErrors(browser) {
  const harness = await H.startHarness({}); const { PL, EXPECTED_CARDS } = harness; const page = await openApp(browser, harness);
  try {
    await goNhlBrowse(page, EXPECTED_CARDS);
    // route missing (Express HTML 404, what production returned) must be an ERROR, never "no history"
    harness.setMode('route-missing');
    await openPill(page, PL.kulak.full, '/SHOTS ON GOAL/i');
    await page.waitFor("__t.hist() === 'error'", 20000, 'error state (route missing)');
    let mt = await page.eval('__t.modalText()');
    check('R1: HTML 404 (route not deployed) renders an ERROR state, NOT "No stored NHL game history"', /Couldn.t load this player.s game history/.test(mt) && /isn.t available on this backend/.test(mt) && !/No stored NHL game history/.test(mt), mt.slice(0, 300));
    check('R2: the error state offers Retry and keeps the projection visible', /Retry/.test(mt) && /MODEL PROJECTION/i.test(mt));
    harness.setMode('normal');
    await page.eval("document.querySelector('[data-nhl-history-retry]').click()");
    await page.waitFor("__t.hist() === 'loaded'", 20000, 'loaded after Retry');
    check('R3: Retry after the backend recovers loads real history', (await page.eval("document.querySelectorAll('.modal-overlay .chart-bar-col').length")) > 0);
    // closing and reopening an errored card retries automatically (no Retry click)
    await page.eval('__t.closeModal()'); await sleep(400);
    harness.setMode('http500');
    await openPill(page, PL.bouchard.full, '/SHOTS ON GOAL/i');
    await page.waitFor("__t.hist() === 'error'", 20000, 'error state (HTTP 500)');
    check('R4: an HTTP 500 is an error state too (not empty)', !/No stored NHL game history/.test(await page.eval('__t.modalText()')));
    await page.eval('__t.closeModal()'); await sleep(500);
    harness.setMode('normal');
    await openPill(page, PL.bouchard.full, '/SHOTS ON GOAL/i');
    await page.waitFor("__t.hist() === 'loaded'", 20000, 'auto-retry on reopen');
    check('R5: reopening a previously failed card retries automatically and loads', true);
    check('R6: no fatal errors across the error/retry flows; app still mounted', fatalOf(page).length === 0 && (await page.eval('__t.mounted()')), fatalOf(page));
  } finally { await page.close(); await harness.close(); }
}

async function scenarioContaminated(browser) {
  const harness = await H.startHarness({ injectContaminatedStats: true }); const { PL, EXPECTED_CARDS } = harness; const page = await openApp(browser, harness);
  try {
    await goNhlBrowse(page, EXPECTED_CARDS);
    await openPill(page, 'Brett Pesce', '/SHOTS ON GOAL/i');
    await page.waitFor("__t.hist() === 'loaded'", 20000, 'history loaded (contaminated player)');
    await sleep(1200);
    check('C1: even if an NHL player object is contaminated with statsByKey, the app does not crash (boundary is by identity)', (await page.eval('__t.mounted()')) && (await page.eval('__t.cards()')) === EXPECTED_CARDS && fatalOf(page).length === 0, fatalOf(page));
    check('C2: ...and NHL still gets no Grade/Prime/confluence', (await page.eval('__t.gradeDom()')) === 0 && !(await page.eval('__t.gradeText()')));
  } finally { await page.close(); await harness.close(); }
}

async function scenarioNegativeControl(browser) {
  const harness = await H.startHarness({ injectContaminatedStats: true, removeGuard: true }); const page = await openApp(browser, harness);
  try {
    await page.eval("__t.clickBtn('NHL')"); await sleep(1200); await page.eval("__t.clickBtn('Browse')");
    let crashed = false;
    for (let i = 0; i < 100 && !crashed; i++) { await sleep(250); crashed = page.errors.some(e => /reading 'avg'|Cannot read propert/.test(e)) || !(await page.eval('__t.mounted()').catch(() => false)); }
    check('X1: NEGATIVE CONTROL -- with the boundary removed AND a contaminated NHL player, the original whole-app crash IS reproduced (so this suite can see it)', crashed, page.errors.slice(0, 2));
  } finally { await page.close(); await harness.close(); }
}

(async () => {
  let browser;
  try { browser = await cdp.launch(); }
  catch (e) { console.log(`SKIPPED (environment): ${e.message}. This is NOT a pass.`); process.exit(3); }
  console.log(`browser: ${browser.exe}`);
  try {
    for (const [name, fn] of [['normal', scenarioNormal], ['empty', scenarioEmpty], ['errors', scenarioErrors], ['contaminated', scenarioContaminated], ['negative-control', scenarioNegativeControl]]) {
      console.log(`\n--- scenario: ${name} ---`);
      try { await fn(browser); }
      catch (e) { if (e.code === 'NO_NETWORK') { console.log(`SKIPPED (environment): ${e.message}. This is NOT a pass.`); await browser.close(); H.cleanup(); process.exit(3); } failures++; console.log(`FAIL  scenario "${name}" threw: ${e.message}`); }
    }
  } finally { await browser.close(); H.cleanup(); }
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
