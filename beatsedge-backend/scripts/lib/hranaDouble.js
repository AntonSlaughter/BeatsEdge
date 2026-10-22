// TEST DOUBLE (not production code): a small libSQL/Turso-compatible HTTP server (Hrana v2 JSON pipeline) over a real SQLite file, for testing code that talks to Turso
// through @libsql/client -- no network, no credentials, no production data.
//
// What it models, on purpose:
//   - ONE writer at a time. A write transaction (BEGIN IMMEDIATE / BEGIN / BEGIN CONCURRENT) takes a global FIFO write lock and holds it until COMMIT / ROLLBACK / stream close; a
//     writing statement outside a transaction takes it for the duration of the statement. Anything else that needs to write (another transaction, a plain INSERT, and -- by default --
//     DDL such as CREATE TABLE/INDEX IF NOT EXISTS, which SQLite marks as a writing statement even when it changes nothing) queues behind it. Reads never wait.
//   - Network round trips: every HTTP request is delayed by \`rttMs\` (a Render -> Turso round trip is tens of milliseconds; measured ~77 ms per interactive INSERT in production logs).
//   - Fault injection for atomicity / partial-failure tests (\`failBatchNumber\`: the Nth batch request fails at its first statement).
// What it does NOT claim: that real Turso queues DDL no-ops behind a write transaction. \`ddlTakesWriteLock\` (default true) makes that assumption explicit and switchable.
const http = require('http'); const { DatabaseSync } = require('node:sqlite');

function startHranaDouble({ file, rttMs = 0, ddlTakesWriteLock = true, rejectPragmaFunctions = false, blockWrites = false } = {}) {
  let failAfter = null;   // null = no fault; n = let n more batch requests succeed, then fail the next one
  // Turso's "quota exceeded" state (observed in production 2026-10-22): every WRITING statement -- INSERT / UPDATE / DELETE and also a no-op CREATE ... IF NOT EXISTS -- is refused
  // with code BLOCKED; reads still work. Switchable at runtime (setBlockWrites) so a test can model "the schema exists, then the quota runs out".
  let blocked = !!blockWrites;
  const main = new DatabaseSync(file); main.exec('PRAGMA journal_mode = WAL');
  const stats = { requests: 0, batchRequests: 0, execRequests: 0, transactions: 0, lockWaits: [], maxQueued: 0, writeTxHeldMs: [], ddlStatements: 0, inflightBatch: 0, maxInflightBatch: 0 };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // FIFO write lock
  let held = false; const queue = [];
  const lockWrite = async (label) => { const t0 = Date.now(); if (held) { await new Promise(r => { queue.push(r); if (queue.length > stats.maxQueued) stats.maxQueued = queue.length; }); } else held = true; const waited = Date.now() - t0; if (waited > 5) stats.lockWaits.push({ label, waited }); return Date.now(); };
  const unlockWrite = () => { const next = queue.shift(); if (next) next(); else held = false; };
  const streams = new Map(); let nextId = 1;
  const isRead = (sql) => /^\s*(select|pragma|explain|with)\b/i.test(sql) && !/\b(insert|update|delete|replace)\b/i.test(sql);
  const txKind = (sql) => { const m = /^\s*(begin|commit|rollback|end)\b(\s+\w+)?/i.exec(sql); if (!m) return null; const w = m[1].toLowerCase(); if (w === 'begin') return /read|deferred/i.test(m[2] || '') ? 'begin-read' : 'begin-write'; return w === 'rollback' ? 'rollback' : 'commit'; };
  const bind = (a) => a.type === 'null' ? null : a.type === 'integer' ? (Math.abs(Number(a.value)) > Number.MAX_SAFE_INTEGER ? BigInt(a.value) : Number(a.value)) : a.type === 'float' ? Number(a.value) : a.type === 'blob' ? Buffer.from(a.base64, 'base64') : String(a.value);
  const enc = (v) => v === null || v === undefined ? { type: 'null' } : typeof v === 'bigint' ? { type: 'integer', value: String(v) } : typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v }) : (v instanceof Uint8Array) ? { type: 'blob', base64: Buffer.from(v).toString('base64') } : { type: 'text', value: String(v) };

  async function runStmt(stream, stmt) {
    const sql = stmt.sql !== undefined && stmt.sql !== null ? stmt.sql : stream.sqls.get(stmt.sql_id); const args = (stmt.args || []).map(bind); const conn = stream.conn; const tk = txKind(sql);
    if (blocked && (tk === 'begin-write' || (tk === null && !isRead(sql)))) { const e = new Error('Operation was blocked: SQL write operations are forbidden (writes are blocked, do you need to upgrade your plan?)'); e.code = 'BLOCKED'; throw e; }
    if (tk === 'begin-write') { if (stream.inTx) throw new Error('cannot start a transaction within a transaction'); stream.heldSince = await lockWrite('tx'); stream.holdsLock = true; conn.exec('BEGIN IMMEDIATE'); stream.inTx = true; stats.transactions++; return { cols: [], rows: [], affected_row_count: 0 }; }
    if (tk === 'begin-read') { conn.exec('BEGIN'); stream.inTx = true; return { cols: [], rows: [], affected_row_count: 0 }; }
    if (tk === 'commit' || tk === 'rollback') { if (stream.inTx) conn.exec(tk === 'commit' ? 'COMMIT' : 'ROLLBACK'); stream.inTx = false; if (stream.holdsLock) { stats.writeTxHeldMs.push(Date.now() - stream.heldSince); stream.holdsLock = false; unlockWrite(); } return { cols: [], rows: [], affected_row_count: 0 }; }
    if (rejectPragmaFunctions && /pragma_(table|index)_info/i.test(sql)) throw new Error('no such table: pragma_table_info (test double: introspection pragmas disabled)');
    const read = isRead(sql); const isDdl = /^\s*(create|drop|alter)\b/i.test(sql); if (isDdl) stats.ddlStatements++;
    const needsLock = !read && !(isDdl && !ddlTakesWriteLock) && !stream.holdsLock;
    if (needsLock) { await lockWrite(isDdl ? 'ddl' : 'write'); }
    try {
      const st = conn.prepare(sql);
      if (read || /\breturning\b/i.test(sql)) { const rows = st.all(...args); const cols = (typeof st.columns === 'function' ? st.columns().map(c => c.name) : (rows[0] ? Object.keys(rows[0]) : [])); return { cols: cols.map(n => ({ name: n, decltype: null })), rows: rows.map(r => cols.map(n => enc(r[n]))), affected_row_count: 0 }; }
      const info = st.run(...args); return { cols: [], rows: [], affected_row_count: Number(info.changes), last_insert_rowid: String(info.lastInsertRowid) };
    } finally { if (needsLock) unlockWrite(); }
  }
  const errOf = (e) => ({ message: String(e && e.message || e), code: (e && e.code === 'BLOCKED') ? 'BLOCKED' : 'SQLITE_ERROR' });
  async function evalCond(c, ok, errs, stream) {
    if (!c) return true; if (c.type === 'ok') return !!ok[c.step]; if (c.type === 'error') return !!errs[c.step]; if (c.type === 'not') return !(await evalCond(c.cond, ok, errs, stream));
    if (c.type === 'and') { for (const x of c.conds) if (!(await evalCond(x, ok, errs, stream))) return false; return true; } if (c.type === 'or') { for (const x of c.conds) if (await evalCond(x, ok, errs, stream)) return true; return false; }
    if (c.type === 'is_autocommit') return !stream.inTx; throw new Error('unsupported condition ' + c.type);
  }
  async function pipeline(body) {
    let stream = body.baton ? streams.get(body.baton) : null; if (body.baton && !stream) return { status: 400, json: { message: 'unknown baton' } };
    if (!stream) { stream = { id: String(nextId++), conn: new DatabaseSync(file), inTx: false, holdsLock: false, sqls: new Map() }; stream.conn.exec('PRAGMA journal_mode = WAL'); streams.set(stream.id, stream); }
    let closed = false; const results = [];
    for (const r of body.requests) {
      try {
        if (r.type === 'execute') { stats.execRequests++; results.push({ type: 'ok', response: { type: 'execute', result: await runStmt(stream, r.stmt) } }); }
        else if (r.type === 'batch') {
          stats.batchRequests++; stats.inflightBatch++; if (stats.inflightBatch > stats.maxInflightBatch) stats.maxInflightBatch = stats.inflightBatch; let injectFail = false; if (failAfter !== null) { if (failAfter === 0) { failAfter = null; injectFail = true; } else failAfter--; } const ok = [], errs = [], stepResults = [], stepErrors = [];
          for (let i = 0; i < r.batch.steps.length; i++) {
            const step = r.batch.steps[i]; if (!(await evalCond(step.condition, ok, errs, stream))) { ok[i] = false; errs[i] = false; stepResults.push(null); stepErrors.push(null); continue; }
            try { if (injectFail && i === 1) throw new Error('injected failure (test double)'); const res = await runStmt(stream, step.stmt); ok[i] = true; errs[i] = false; stepResults.push(res); stepErrors.push(null); }
            catch (e) { ok[i] = false; errs[i] = true; stepResults.push(null); stepErrors.push(errOf(e)); }
          }
          stats.inflightBatch--; results.push({ type: 'ok', response: { type: 'batch', result: { step_results: stepResults, step_errors: stepErrors } } });
        }
        else if (r.type === 'sequence') { for (const s of String(r.sql || '').split(';').filter(x => x.trim())) await runStmt(stream, { sql: s, args: [] }); results.push({ type: 'ok', response: { type: 'sequence' } }); }
        else if (r.type === 'store_sql') { stream.sqls.set(r.sql_id, r.sql); results.push({ type: 'ok', response: { type: 'store_sql' } }); }
        else if (r.type === 'close_sql') { stream.sqls.delete(r.sql_id); results.push({ type: 'ok', response: { type: 'close_sql' } }); }
        else if (r.type === 'get_autocommit') results.push({ type: 'ok', response: { type: 'get_autocommit', is_autocommit: !stream.inTx } });
        else if (r.type === 'close') { closed = true; results.push({ type: 'ok', response: { type: 'close' } }); }
        else results.push({ type: 'error', error: { message: 'unsupported request ' + r.type } });
      } catch (e) { results.push({ type: 'error', error: errOf(e) }); }
    }
    if (closed) { if (stream.inTx) { try { stream.conn.exec('ROLLBACK'); } catch (e) { /* ignore */ } stream.inTx = false; } if (stream.holdsLock) { stats.writeTxHeldMs.push(Date.now() - stream.heldSince); stream.holdsLock = false; unlockWrite(); } try { stream.conn.close(); } catch (e) { /* ignore */ } streams.delete(stream.id); }
    return { status: 200, json: { baton: closed ? null : stream.id, base_url: null, results } };
  }
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') { res.statusCode = req.url === '/v2' ? 200 : 404; return res.end(); }   // protocol discovery: v2 only
    let buf = ''; req.on('data', d => { buf += d; });
    req.on('end', async () => { stats.requests++; try { if (rttMs) await sleep(rttMs); if (req.url !== '/v2/pipeline') { res.statusCode = 404; return res.end(); } const out = await pipeline(JSON.parse(buf)); if (rttMs) await sleep(Math.round(rttMs / 4)); res.statusCode = out.status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out.json)); } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ message: String(e && e.message) })); } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: 'http://127.0.0.1:' + server.address().port, stats, db: main, isWriteLocked: () => held, failNextBatchAfter: (n) => { failAfter = n; }, setBlockWrites: (b) => { blocked = !!b; },
    close: () => new Promise((r) => { for (const s of streams.values()) { try { s.conn.close(); } catch (e) { /* ignore */ } } try { main.close(); } catch (e) { /* ignore */ } server.close(() => r()); server.closeAllConnections && server.closeAllConnections(); }),
  })));
}
module.exports = { startHranaDouble };
