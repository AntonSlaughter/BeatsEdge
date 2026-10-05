// Minimal Chrome DevTools Protocol driver -- no npm dependencies (uses Node's built-in WebSocket + fetch).
// Used by scripts/nhlRender/test-nhl-detail-render.js to mount the REAL BeatsEdge.html in a headless Chrome/Edge.
// Browser lookup: $NHL_TEST_BROWSER, else the usual Chrome/Edge install paths (Windows/macOS/Linux).
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

function findBrowser() {
  const c = [process.env.NHL_TEST_BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return c.find(p => p && fs.existsSync(p)) || null;
}

async function launch() {
  const exe = findBrowser();
  if (!exe) { const e = new Error('no Chrome/Edge found (set NHL_TEST_BROWSER)'); e.code = 'NO_BROWSER'; throw e; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhl-cdp-'));
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--window-size=1280,1000', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(dir, 'DevToolsActivePort');
  let port = null;
  for (let i = 0; i < 100 && !port; i++) { // up to ~10s
    await new Promise(r => setTimeout(r, 100));
    if (fs.existsSync(portFile)) { const t = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim(); if (/^\d+$/.test(t)) port = +t; }
  }
  if (!port) { try { proc.kill(); } catch (e) {} throw Object.assign(new Error('browser did not expose a DevTools port'), { code: 'NO_BROWSER' }); }
  return {
    port, exe,
    async close() { try { proc.kill(); } catch (e) {} await new Promise(r => setTimeout(r, 400)); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} },
    async newPage() {
      const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      return openPage(t.webSocketDebuggerUrl, port, t.id);
    },
  };
}

function openPage(wsUrl, port, targetId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map(); const handlers = [];
    const page = {
      errors: [],        // uncaught exceptions + console.error text
      send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }),
      on: (fn) => handlers.push(fn),
      async eval(expression) { // evaluates (awaiting promises) and returns the JSON-able value; throws on page exception
        const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error('page eval failed: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
        return r.result.value;
      },
      async waitFor(expression, timeoutMs = 15000, label = expression) {
        const t0 = Date.now(); let last;
        while (Date.now() - t0 < timeoutMs) { try { last = await page.eval(expression); if (last) return last; } catch (e) { last = e.message; } await new Promise(r => setTimeout(r, 150)); }
        throw new Error(`timeout (${timeoutMs}ms) waiting for: ${label} (last: ${JSON.stringify(last)})`);
      },
      async close() { try { ws.close(); } catch (e) {} try { await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`); } catch (e) {} },
    };
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); return; }
      if (msg.method === 'Runtime.exceptionThrown') { const d = msg.params.exceptionDetails; page.errors.push('UNCAUGHT: ' + ((d.exception && d.exception.description) || d.text)); }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') page.errors.push('console.error: ' + msg.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 600));
      handlers.forEach(h => h(msg));
    };
    ws.onerror = (e) => reject(new Error('CDP websocket error'));
    ws.onopen = async () => { try { await page.send('Runtime.enable'); await page.send('Page.enable'); resolve(page); } catch (e) { reject(e); } };
  });
}

module.exports = { launch, findBrowser };
