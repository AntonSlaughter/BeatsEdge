// TEST-ONLY environment shim -- never required by product code. On this machine the installed better-sqlite3 (v11.10, built for Node 24.20) aborts the process in its Database finalizer
// ("RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr"), so server.js cannot boot at all, and production pins Node 22 which has no compatible binary here. To still exercise
// the REAL Express app and the REAL SQLite schema / SQL, this shim answers `require('better-sqlite3')` with a thin adapter over Node's built-in node:sqlite (real SQLite, JSON1 included).
// Use:  node --require ./scripts/lib/nodeSqliteShim.js server.js     or     require('./lib/nodeSqliteShim').install() before anything loads better-sqlite3.
const Module = require('module'); const { DatabaseSync } = require('node:sqlite');
class Database {
  constructor(file, opts) { opts = opts || {}; this._db = new DatabaseSync(file === ':memory:' ? ':memory:' : file, { readOnly: !!opts.readonly }); this.name = file; this.open = true; this.memory = file === ':memory:'; this.readonly = !!opts.readonly; }
  prepare(sql) { const st = this._db.prepare(sql); const norm = (a) => (a.length === 1 && Array.isArray(a[0]) ? a[0] : a); const wrap = (fn) => (...a) => fn.apply(st, norm(a));
    return { get: wrap(st.get), all: wrap(st.all), iterate: wrap(st.iterate), run: (...a) => { const r = st.run.apply(st, norm(a)); return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }; }, pluck() { return this; }, raw() { return this; }, source: sql }; }
  exec(sql) { this._db.exec(sql); return this; }
  pragma(str, o) { const rows = this._db.prepare('PRAGMA ' + str).all(); if (o && o.simple) { const r = rows[0]; return r ? Object.values(r)[0] : undefined; } return rows; }
  transaction(fn) { const self = this; const run = function (...a) { self._db.exec('BEGIN'); try { const r = fn.apply(this, a); self._db.exec('COMMIT'); return r; } catch (e) { try { self._db.exec('ROLLBACK'); } catch (x) { } throw e; } }; run.immediate = run; run.deferred = run; run.exclusive = run; return run; }
  close() { if (this.open) { this._db.close(); this.open = false; } return this; }
  function() { return this; } aggregate() { return this; }
}
Database.SqliteError = Error;
function install() { if (Module._load.__sqliteShim) return; const orig = Module._load; const patched = function (request) { if (request === 'better-sqlite3') return Database; return orig.apply(this, arguments); }; patched.__sqliteShim = true; Module._load = patched; }
install(); module.exports = { install, Database };
