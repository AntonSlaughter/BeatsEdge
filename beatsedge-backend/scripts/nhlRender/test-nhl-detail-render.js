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

    // Phase 2 (UX unification): the NHL board uses the shared BeatsEdge card, keeps combo/unresolved listings visible but
    // does not call them players, and carries no developer copy.
    const boardText = await page.eval('document.querySelector(".players-grid").innerText');
    const countText = await page.eval('(document.querySelector(".grid-count") || {}).textContent');
    check('P1: the Browse count calls only identified players "players" and labels combo/unmatched listings separately (7 + 2)', /^7 players · 2 combo \/ unmatched listings/.test(countText), countText);
    check('P2: Details button exists on a card with a supported prop, and NOT on combo / unresolved / unsupported-only cards', (await page.eval(`!!__t.card('Brett Pesce').querySelector('.details-btn')`)) && (await page.eval(`['${PL.pesce.full} + ${PL.bouchard.full}', 'Zzzz Unknownson'].every(n => !__t.card(n).querySelector('.details-btn'))`)));
    check('P3: NHL cards render through the shared card classes (player-header / avatar / info / prop-pill-label / prop-pill-value) with the provider named in the pill', (await page.eval(`(() => { const c = __t.card('Brett Pesce'); const p = __t.pill('Brett Pesce', /SHOTS ON GOAL/i); return !!c.querySelector('.player-header .player-avatar') && !!c.querySelector('.player-info .player-name') && !!p.querySelector('.prop-pill-label') && !!p.querySelector('.prop-pill-value .prop-pill-source') && /PrizePicks/.test(p.querySelector('.prop-pill-value').textContent); })()`)));
    check('P4: no developer / internal copy anywhere on the NHL board', !/nhl_player_box|shrinkage|trailing-mean|Poisson|not enabled for NHL|validated NHL|real games\)/i.test(boardText), boardText.slice(0, 200));
    check('P5: the pill shows direction-free model output only where real (SOG: projection + edge), never a grade', (await page.eval(`/Model 1\\.16/.test(__t.pill('Brett Pesce', /SHOTS ON GOAL/i).innerText)`)));

    // Phase 2 polish: supported vs unsupported hierarchy, probability wording, scrollable market row
    const hier = await page.eval(`(() => { const sup = __t.pill('Brett Pesce', /SHOTS ON GOAL/i), uns = __t.pill('Brett Pesce', /BLOCKED/i); const q = (p, s) => getComputedStyle(p.querySelector(s)); return { supCls: sup.className, unsCls: uns.className, unsOpacity: getComputedStyle(uns).opacity, unsLabel: q(uns, '.prop-pill-label').color, mutedNote: q(uns, '.nhl-no-model').color, unsLine: uns.querySelector('.prop-pill-value').innerText, supBorder: getComputedStyle(sup).borderTopColor, unsBorder: getComputedStyle(uns).borderTopColor, unsText: uns.innerText }; })()`);
    check('H1: unsupported real offering is fully readable (opacity 1, market/line/provider visible), with only "Model not supported yet" kept quiet', hier.unsOpacity === '1' && /1\.5|2\.5/.test(hier.unsLine) && /PrizePicks/.test(hier.unsLine) && /BLOCKED SHOTS/i.test(hier.unsText) && hier.unsLabel !== hier.mutedNote, hier);
    check('H2: modeled pills carry a distinct BeatsEdge accent border vs. unmodeled', /nhl-modeled/.test(hier.supCls) && /nhl-unmodeled/.test(hier.unsCls) && hier.supBorder !== hier.unsBorder, hier);
    const goalPill = await page.eval(`__t.pill('Brett Pesce', /POINT \\(1\\+\\)/i).innerText`);
    check('H3: probability wording on Browse is "Model Probability NN.N%" (no P(>=1))', /Model Probability \d+\.\d%/.test(goalPill) && !/P\(≥1\)/.test(goalPill), goalPill);
    const catBar = await page.eval(`(() => { const b = document.querySelector('.stat-cat-bar'); return b ? { cls: b.className, chips: b.querySelectorAll('.stat-cat-chip').length, scrolls: b.scrollWidth > b.clientWidth } : null; })()`);
    check('H4: NHL market row uses the themed scroller, keeps every market chip, and stays horizontally scrollable', catBar && /is-scrollable/.test(catBar.cls) && catBar.chips >= 8, catBar);

    // 1) supported NHL prop opens detail, history loads, app does not unmount
    await openPill(page, 'Brett Pesce', '/SHOTS ON GOAL/i');
    await page.waitFor('__t.modal()', 10000, 'modal open');
    await page.waitFor("__t.hist() === 'loaded'", 20000, 'history loaded');
    await sleep(1500); // the original crash fired on the re-render right after history arrived
    const mt = await page.eval('__t.modalText()');
    check('N4: supported prop opened the detail modal and real history LOADED (analytics + chart present)', /Analytics/.test(mt) && (await page.eval("document.querySelectorAll('.modal-overlay .chart-bar-col').length")) === 10, mt.slice(0, 200));
    check('N5: the app is still mounted with all cards after history arrived (no unmount / crash)', (await page.eval('__t.mounted()')) && (await page.eval('__t.cards()')) === EXPECTED_CARDS);
    check('N6: no uncaught exception / TypeError / React render error during the whole flow', fatalOf(page).length === 0, fatalOf(page));
    check('N7: the detail shows the model projection and the real line, and NOT "No NHL game history"', /MODEL PROJECTION/i.test(mt) && /1\.16/.test(mt) && /1\.5/.test(mt) && !/No NHL game history/.test(mt), mt.slice(0, 300));
    check('N8: detail has NO Grade / Prime / Factor Confluence / matchup-verdict DOM or text', (await page.eval('__t.gradeDom()')) === 0 && !(await page.eval('__t.gradeText()')));

    // windows are real, chronological history: L5 -> 5 games; Vs <opp> -> exactly the fixture games vs that opponent
    await page.eval("__t.tab('L5')"); await sleep(300);
    check('N9: L5 window shows exactly 5 games', (await page.eval("__t.stat('Games')")) === '5');
    const OPPS = ['PHI', 'BOS', 'TOR', 'MTL']; let vs = 0; for (let i = 0; i < 30; i++) if (OPPS[(i + PL.pesce.seed) % 4] === PL.pesce.opp) vs++;
    await page.eval(`__t.tab('Vs ${PL.pesce.opp}')`); await sleep(300);
    check(`N10: "Vs ${PL.pesce.opp}" window filters by the real opponent column (${vs} fixture games)`, (await page.eval("__t.stat('Games')")) === String(vs), await page.eval("__t.stat('Games')"));
    await page.eval("__t.tab('L20')"); await sleep(300);
    check('N11: L20 window shows 20 games', (await page.eval("__t.stat('Games')")) === '20');

    // Phase 2 polish: window-aware summary, readable chart labels
    await page.eval("__t.tab('L5')"); await sleep(300);
    const w5 = await page.eval(`(() => { const m = document.querySelector('.modal-overlay'); return { head: m.querySelector('.hit-rate-main').textContent, note: m.querySelector('.hit-rate-header').innerText, active: [...m.querySelectorAll('.hit-rate-bar.is-active .hit-rate-bar-label')].map(e => e.textContent), activeVal: [...m.querySelectorAll('.hit-rate-bar.is-active .hit-rate-bar-value')].map(e => e.textContent), compact: !!m.querySelector('.hit-rate-header.is-compact'), games: m.querySelectorAll('.chart-bar-col').length }; })()`);
    check('W1: L5 selected => headline % equals the highlighted L5 bar, summary says "Last 5 · 5 games", chart has 5 bars', w5.active.length === 1 && w5.active[0] === 'L5' && w5.head === w5.activeVal[0] && /Last 5 · 5 games/.test(w5.note) && w5.games === 5 && w5.compact, w5);
    await page.eval("__t.tab('L10')"); await sleep(300);
    const w10 = await page.eval(`(() => { const m = document.querySelector('.modal-overlay'); return { head: m.querySelector('.hit-rate-main').textContent, note: m.querySelector('.hit-rate-header').innerText, active: [...m.querySelectorAll('.hit-rate-bar.is-active .hit-rate-bar-label')].map(e => e.textContent), activeVal: [...m.querySelectorAll('.hit-rate-bar.is-active .hit-rate-bar-value')].map(e => e.textContent) }; })()`);
    check('W2: L10 selected => "Last 10 · 10 games" and the L10 bar is highlighted (no stale "last 40 games")', w10.active[0] === 'L10' && w10.head === w10.activeVal[0] && /Last 10 · 10 games/.test(w10.note) && !/last 40/i.test(w10.note), w10);
    await page.eval(`__t.tab('Season')`); await sleep(300);
    const wS = await page.eval(`(() => { const m = document.querySelector('.modal-overlay'); return { head: m.querySelector('.hit-rate-main').textContent, note: m.querySelector('.hit-rate-header').innerText, activeVal: [...m.querySelectorAll('.hit-rate-bar.is-active .hit-rate-bar-value')].map(e => e.textContent), n: __t.stat('Games') }; })()`);
    check('W3: Season selected => "Current season" with the real game count and the Season bar value', /Current season · \d+ games/.test(wS.note) && wS.head === wS.activeVal[0] && wS.note.includes(`${wS.n} game`), wS);
    await page.eval(`__t.tab('Vs ${PL.pesce.opp}')`); await sleep(300);
    const wV = await page.eval(`(() => { const m = document.querySelector('.modal-overlay'); return { head: m.querySelector('.hit-rate-main').textContent, note: m.querySelector('.hit-rate-header').innerText, activeVal: [...m.querySelectorAll('.hit-rate-bar.is-active .hit-rate-bar-value')].map(e => e.textContent), n: __t.stat('Games') }; })()`);
    check('W4: Vs-opponent selected => "Vs PHI" with the real opponent game count and the Vs Opp bar value', new RegExp(`Vs ${PL.pesce.opp} · ${wV.n} games?`).test(wV.note) && wV.head === wV.activeVal[0], wV);
    await page.eval("__t.tab('L10')"); await sleep(300);
    const lab = await page.eval(`(() => { const d = document.querySelector('.modal-overlay .chart-bar-date'); const cs = getComputedStyle(d); const col = document.querySelector('.modal-overlay .chart-bar-col'); return { fs: parseFloat(cs.fontSize), date: d.querySelector('.cbd-date').textContent, opp: d.querySelector('.cbd-opp').textContent, colW: col.getBoundingClientRect().width, plotW: document.querySelector('.modal-overlay .chart-plot').getBoundingClientRect().width, innerW: document.querySelector('.modal-overlay .chart-inner').getBoundingClientRect().width, overflow: d.scrollWidth > d.getBoundingClientRect().width + 1 }; })()`);
    check('C1: chart labels are readable: >= 10px, short M/D/YY date, "vs XXX" opponent, bars spread to the plot width, labels not clipped', lab.fs >= 10 && /^\d{1,2}\/\d{1,2}\/\d{2}$/.test(lab.date) && /^vs [A-Z]{2,3}$/.test(lab.opp) && lab.innerW >= lab.plotW - 2 && !lab.overflow, lab);
    check('C2: the full date + opponent + value stay in each bar tooltip', (await page.eval(`/\\d{4}-\\d{2}-\\d{2} — vs [A-Z]+ — \\d+ \\(/.test(document.querySelector('.modal-overlay .chart-bar-col').title)`)));

    // Phase 2: same section hierarchy as every working sport's modal, real NHL info only, no developer copy
    const order = await page.eval(`(() => { const m = document.querySelector('.modal-overlay .modal-body'); const sel = ['.edge-section', '.hit-rate-section', '.stats-tabs', '.stats-table', '.game-log-chart']; return sel.map(s => { const e = m.querySelector(s); return e ? [...m.querySelectorAll('*')].indexOf(e) : -1; }); })()`);
    check('P6: modal hierarchy = model summary -> hit-rate -> window tabs -> analytics -> game chart (same order as the other sports)', order.every(i => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), order);
    const mt2 = await page.eval('__t.modalText()');
    check('P7: modal has no developer / internal copy and no basketball-only or invented fields', !/nhl_player_box|shrinkage|trailing-mean|Poisson|not enabled for NHL|validated NHL|real games sampled|Grade|Prime|Confluence|Projected Minutes|Edge vs|Implied|Defense/i.test(mt2), mt2.slice(0, 400));
    check('P8: modal shows the customer-facing basis line, the real provider name, and the window tabs L5..Vs', /Model estimate based on \d+ NHL games/.test(mt2) && !/not a lock/i.test(mt2) && /Real line — PrizePicks/.test(mt2) && ['L5', 'L10', 'L15', 'L20', 'Season', `Vs ${PL.pesce.opp}`].every(t => mt2.includes(t)), mt2.slice(0, 300));
    check('P9: the game chart has the dashed line + legend + hit line (shared GameLogChart) and one bar per shown game', (await page.eval(`!!document.querySelector('.modal-overlay .chart-line-label') && !!document.querySelector('.modal-overlay .chart-legend') && !!document.querySelector('.modal-overlay .chart-hitline') && document.querySelectorAll('.modal-overlay .chart-bar-col').length === 10`)));
    // prop switcher: Pesce has two validated props (SOG + Point 1+); switching changes the selected prop without a new history request
    const histBefore = harness.historyRequests().length;
    const sw = await page.eval(`(() => { const s = document.querySelector('.modal-overlay .edge-prop-select'); if (!s) return null; const o = [...s.options].map(x => x.textContent); return o; })()`);
    const nSupportedPills = await page.eval(`[...__t.card('Brett Pesce').querySelectorAll('.prop-pill')].filter(p => !/Model not supported yet/.test(p.innerText)).length`);
    check('P10: the prop switcher lists exactly the validated props on the card (not Blocked Shots / First Goal Scorer)', Array.isArray(sw) && sw.length === nSupportedPills && sw.length >= 2 && sw.some(x => /Shots on Goal/i.test(x)) && sw.some(x => /Point/i.test(x)) && !sw.some(x => /Blocked|First Goal/i.test(x)), { sw, nSupportedPills });
    await page.eval(`(() => { const s = document.querySelector('.modal-overlay .edge-prop-select'); const o = [...s.options].find(x => /Point/i.test(x.textContent)); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, o.value); s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(600);
    const mt3 = await page.eval('__t.modalText()');
    check('P11: switching prop shows the binary family (Model Probability, no point projection / edge) from the already-loaded history, with no extra request', /Model Probability/i.test(mt3) && !/P\(≥1\)|not a lock/i.test(mt3) && /Point \(1\+\)/.test(mt3) && !/Model Projection/i.test(mt3) && harness.historyRequests().length === histBefore && (await page.eval('__t.hist()')) === 'loaded', mt3.slice(0, 300));

    // line-0 market (Anytime Goal Scorer): Analytics, chart hit line and hit-rate bars must agree (was 100% vs ~20%)
    await page.eval(`(() => { const s = document.querySelector('.modal-overlay .edge-prop-select'); const o = [...s.options].find(x => /Anytime/i.test(x.textContent)); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, o.value); s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(600);
    const ag = await page.eval(`(() => { const m = document.querySelector('.modal-overlay'); const n = s => parseInt(s, 10); return { analytics: n(__t.stat('Hit Rate')), bar: n(m.querySelector('.hit-rate-bar.is-active .hit-rate-bar-value').textContent), headline: n(m.querySelector('.hit-rate-main').textContent), chart: (m.querySelector('.chart-hitline .chart-hitpct') || {}).textContent }; })()`);
    check('W5: line-0 market: Analytics hit rate == headline == selected bar == chart hit line (no 100% vs 20% split)', ag.analytics === ag.bar && ag.headline === ag.bar && new RegExp(`${ag.bar}% hit rate`).test(ag.chart) && ag.bar < 100, ag);

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
    check('E1: a successful "no stored rows" answer (JSON 404 with games: []) shows the truthful no-history state', /No NHL game history for this player yet\./.test(mt) && !/Retry/.test(mt), mt.slice(0, 250));
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
    check('R1: HTML 404 (route not deployed) renders an ERROR state, NOT "No NHL game history"', /Couldn.t load this player.s game history/.test(mt) && /game history is temporarily unavailable/.test(mt) && !/backend/i.test(mt) && !/No NHL game history/.test(mt), mt.slice(-260));
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
    check('R4: an HTTP 500 is an error state too (not empty)', !/No NHL game history/.test(await page.eval('__t.modalText()')));
    await page.eval('__t.closeModal()'); await sleep(500);
    harness.setMode('normal');
    await openPill(page, PL.bouchard.full, '/SHOTS ON GOAL/i');
    await page.waitFor("__t.hist() === 'loaded'", 20000, 'auto-retry on reopen');
    check('R5: reopening a previously failed card retries automatically and loads', true);
    check('R6: no fatal errors across the error/retry flows; app still mounted', fatalOf(page).length === 0 && (await page.eval('__t.mounted()')), fatalOf(page));
  } finally { await page.close(); await harness.close(); }
}

// NHL model v2 (lib/nhlModel.js) rendered end-to-end: the API payload carries opponent-independent values + baseLambda + the opponent context,
// the board applies the frozen factor for the real opponent, and the existing card/modal show the new numbers. Expected values are computed
// with the SERVER's own applyOpponent (the parity test separately proves the frontend adjuster == server).
async function scenarioV2(browser, kind) {
  const MODEL = require('../../lib/nhlModel');
  const harness = await H.startHarness({ payload: kind }); const { PL, EXPECTED_CARDS } = harness; const { V2_BASE, V2_CONTEXT } = H; const page = await openApp(browser, harness);
  const r2 = (x) => Math.round(x * 100) / 100, signed = (x) => (x >= 0 ? '+' : '') + x;
  const withCtx = kind === 'v2'; const ctxOf = (opp) => (withCtx ? V2_CONTEXT[opp] : undefined);
  try {
    await goNhlBrowse(page, EXPECTED_CARDS);
    const txt = async (name, re) => await page.eval(`(__t.pill(${JSON.stringify(name)}, ${re}) || {innerText: ''}).innerText`);
    // SOG (Pesce vs PHI): projection = lambda0 * allowed-factor ; Edge = projection - 1.5
    const sog = MODEL.applyOpponent('shots_on_goal', V2_BASE.sog.pesce, ctxOf('PHI')).projection; const sogEdge = r2(r2(sog) === sog ? sog - 1.5 : sog - 1.5);
    const t1 = await txt('Brett Pesce', '/SHOTS ON GOAL/i');
    check(`V1[${kind}]: SOG pill shows the model projection ${r2(sog)} and Edge ${signed(Math.round((sog - 1.5) * 100) / 100)} (projection - provider line 1.5)`, t1.includes(`Model ${r2(sog)}`) && t1.includes(signed(Math.round((sog - 1.5) * 100) / 100)), t1);
    // Saves (Bobrovsky TOR vs BOS): V5 offense factor at half strength
    const sv = MODEL.applyOpponent('goalie_saves', V2_BASE.saves, ctxOf('BOS')).projection; const t2 = await txt('Sergei Bobrovsky', '/GOALIE SAVES/i');
    check(`V2[${kind}]: Saves pill shows ${r2(sv)} and Edge ${signed(Math.round((sv - 24.5) * 100) / 100)} (projection - provider line 24.5)`, t2.includes(`Model ${r2(sv)}`) && t2.includes(signed(Math.round((sv - 24.5) * 100) / 100)), t2);
    // Goal / Assist: probability only, never opponent-adjusted
    const tg = await txt('Brett Pesce', '/ANYTIME GOAL/i'), ta = await txt('Brett Pesce', '/ASSIST/i');
    check(`V3[${kind}]: Goal and Assist show their materialized probability (2.3% / 17.2%), unaffected by the opponent`, /Model Probability 2\.3%/.test(tg) && /Model Probability 17\.2%/.test(ta), { tg, ta });
    // Point (Pesce vs PHI): P = 1 - exp(-lambda_eb * allowed-factor)
    const pt = MODEL.applyOpponent('points_at_least_1', V2_BASE.point.pesce, ctxOf('PHI')).probability; const tp = await txt('Brett Pesce', '/POINT/i');
    check(`V4[${kind}]: Point pill shows Model Probability ${(pt * 100).toFixed(1)}%`, tp.includes(`Model Probability ${(pt * 100).toFixed(1)}%`), tp);
    // fail-closed: Ceci's opponent (MTL) has NO context entry => unadjusted values, board intact
    const ceci = await txt('Cody Ceci', '/SHOTS ON GOAL/i'), ceciP = await txt('Cody Ceci', '/POINT/i');
    check(`V5[${kind}]: a player whose opponent has no context (MTL) falls back to the unadjusted frozen value (SOG ${r2(V2_BASE.sog.ceci)}, Point ${(MODEL.probabilityFromLambda(V2_BASE.point.ceci) * 100).toFixed(1)}%) and still renders`, ceci.includes(`Model ${r2(V2_BASE.sog.ceci)}`) && ceciP.includes(`Model Probability ${(MODEL.probabilityFromLambda(V2_BASE.point.ceci) * 100).toFixed(1)}%`), { ceci, ceciP });
    // detail modal shows the same adjusted number and edge; the product boundaries hold
    await openPill(page, 'Brett Pesce', '/SHOTS ON GOAL/i'); await page.waitFor('__t.modal()', 10000, 'modal'); await page.waitFor("__t.hist() === 'loaded'", 20000, 'history'); await sleep(500);
    const mt = await page.eval('__t.modalText()');
    check(`V6[${kind}]: SOG detail modal shows the same projection (${r2(sog)}) and Edge, no grade/Prime/confluence, no version or validation claims`, mt.includes(String(r2(sog))) && mt.includes(signed(Math.round((sog - 1.5) * 100) / 100)) && (await page.eval('__t.gradeDom()')) === 0 && !/2026\.10|v2|validated|backtest|\d+(\.\d+)?%\s*(more )?(accurate|better)/i.test(mt + (await page.eval('document.querySelector(".players-grid").innerText'))), mt.slice(0, 200));
    check(`V7[${kind}]: ${withCtx ? 'with context the unadjusted SOG value would DIFFER from the shown one (the factor really applied)' : 'with a null context every card shows the unadjusted value'}`, withCtx ? r2(sog) !== r2(V2_BASE.sog.pesce) : t1.includes(`Model ${r2(V2_BASE.sog.pesce)}`), { sog, base: V2_BASE.sog.pesce });
    check(`V8[${kind}]: all ${EXPECTED_CARDS} cards render, no fatal errors`, (await page.eval('__t.cards()')) === EXPECTED_CARDS && fatalOf(page).length === 0, fatalOf(page));
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
    for (const [name, fn] of [['normal', scenarioNormal], ['empty', scenarioEmpty], ['errors', scenarioErrors], ['v2-with-context', (b) => scenarioV2(b, 'v2')], ['v2-null-context', (b) => scenarioV2(b, 'v2-nocontext')], ['contaminated', scenarioContaminated], ['negative-control', scenarioNegativeControl]]) {
      console.log(`\n--- scenario: ${name} ---`);
      try { await fn(browser); }
      catch (e) { if (e.code === 'NO_NETWORK') { console.log(`SKIPPED (environment): ${e.message}. This is NOT a pass.`); await browser.close(); H.cleanup(); process.exit(3); } failures++; console.log(`FAIL  scenario "${name}" threw: ${e.message}`); }
    }
  } finally { await browser.close(); H.cleanup(); }
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
