// Read-only schema verification for a libSQL / Turso database at boot.
//
// WHY: lib/snapshotStore.js used to prove readiness by running EVERY `CREATE ... IF NOT EXISTS` statement (46 of them) against Turso on every boot. Those
// statements are not read-only (SQLite marks even a no-op CREATE ... IF NOT EXISTS as a writing statement), so a booting instance had to queue behind whatever
// write transaction was open -- and the archive writers held one open for minutes (one INSERT round trip per row). The boot then waited out the 300 s response
// timeout and the platform's port scan gave up. This module answers the same question ("does the database already have everything the schema statements
// would create?") with two READ queries and no write lock.
//
// WHAT IT CHECKS (a superset of what the no-op DDL guaranteed):
//   - every table the statements create exists AND has every column they declare (table existence alone is not enough),
//   - every index the statements create exists (by name),
//   - every index in `mustNotExist` is absent (a retired index a migration is supposed to drop),
//   - `migrationStatements` (e.g. `ALTER TABLE ... ADD COLUMN ...`) are applied to the expected catalog too, so a pending additive migration shows up as a
//     missing column and sends the caller down the full DDL + migration path.
// Differences the DDL could never repair (a column's declared type / NOT NULL / PRIMARY KEY, an index's column list) are returned as `drift` for logging; they do
// not block readiness, exactly as they never did.
//
// The expected catalog is built by executing the very same statements in an in-memory SQLite database, so it can never disagree with the statement list.

function openMemoryDb() {
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(':memory:'); }
  catch (e) { const Database = require('better-sqlite3'); return new Database(':memory:'); }
}
const qid = (n) => '"' + String(n).replace(/"/g, '""') + '"';
const lower = (s) => String(s == null ? '' : s).toLowerCase();

function expectedCatalog(statements, migrationStatements = []) {
  const db = openMemoryDb(); const out = { tables: {}, indexes: {} };
  try {
    for (const s of statements) db.exec(s);
    for (const s of migrationStatements) { try { db.exec(s); } catch (e) { if (!/duplicate column|already exists/i.test(String(e && e.message))) throw e; } }
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      out.tables[t.name] = {}; for (const c of db.prepare('PRAGMA table_info(' + qid(t.name) + ')').all()) out.tables[t.name][c.name] = { type: lower(c.type), notnull: c.notnull ? 1 : 0, pk: c.pk ? 1 : 0 };
    }
    for (const i of db.prepare("SELECT name, tbl_name AS tbl, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all()) {
      out.indexes[i.name] = { table: i.tbl, unique: /^\s*create\s+unique/i.test(i.sql || ''), cols: db.prepare('PRAGMA index_info(' + qid(i.name) + ')').all().sort((a, b) => a.seqno - b.seqno).map(r => r.name) };
    }
  } finally { try { db.close(); } catch (e) { /* ignore */ } }
  return out;
}

// `query(sql)` must resolve to an array of plain row objects. Two statements, no writes.
const TABLES_SQL = "SELECT m.name AS tbl, p.name AS col, p.type AS ctype, p.\"notnull\" AS nn, p.pk AS pk FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'";
const INDEXES_SQL = "SELECT m.name AS idx, m.tbl_name AS tbl, m.sql AS sql, ii.seqno AS seqno, ii.name AS col FROM sqlite_master m JOIN pragma_index_info(m.name) ii WHERE m.type = 'index' AND m.name NOT LIKE 'sqlite_%'";
async function readCatalog(query) {
  const out = { tables: {}, indexes: {} };
  for (const r of await query(TABLES_SQL)) { (out.tables[r.tbl] = out.tables[r.tbl] || {})[r.col] = { type: lower(r.ctype), notnull: Number(r.nn) ? 1 : 0, pk: Number(r.pk) ? 1 : 0 }; }
  const seq = {};
  for (const r of await query(INDEXES_SQL)) { const x = (out.indexes[r.idx] = out.indexes[r.idx] || { table: r.tbl, unique: /^\s*create\s+unique/i.test(r.sql || ''), cols: [] }); (seq[r.idx] = seq[r.idx] || []).push([Number(r.seqno), r.col]); }
  Object.keys(seq).forEach(k => { out.indexes[k].cols = seq[k].sort((a, b) => a[0] - b[0]).map(x => x[1]); });
  return out;
}

function compare(expected, actual, { mustNotExist = [] } = {}) {
  const missingTables = [], missingColumns = [], missingIndexes = [], unexpectedIndexes = [], drift = [];
  for (const [t, cols] of Object.entries(expected.tables)) {
    const have = actual.tables[t]; if (!have) { missingTables.push(t); continue; }
    for (const [c, def] of Object.entries(cols)) {
      const h = have[c]; if (!h) { missingColumns.push(t + '.' + c); continue; }
      if (def.type && h.type && def.type !== h.type) drift.push(t + '.' + c + ' type ' + h.type + ' (expected ' + def.type + ')');
      else if (def.notnull !== h.notnull) drift.push(t + '.' + c + ' notnull ' + h.notnull + ' (expected ' + def.notnull + ')');
      else if (def.pk !== h.pk) drift.push(t + '.' + c + ' pk ' + h.pk + ' (expected ' + def.pk + ')');
    }
  }
  for (const [i, def] of Object.entries(expected.indexes)) {
    if (!actual.indexes[i]) { missingIndexes.push(i); continue; }
    const h = actual.indexes[i]; if (h && (h.cols.join(',') !== def.cols.join(',') || h.unique !== def.unique)) drift.push('index ' + i + ' is (' + h.cols.join(', ') + ')' + (h.unique ? ' UNIQUE' : '') + ' (expected (' + def.cols.join(', ') + ')' + (def.unique ? ' UNIQUE' : '') + ')');
  }
  for (const i of mustNotExist) if (actual.indexes[i]) unexpectedIndexes.push(i);
  const ok = !missingTables.length && !missingColumns.length && !missingIndexes.length && !unexpectedIndexes.length;
  return { ok, missingTables, missingColumns, missingIndexes, unexpectedIndexes, drift };
}

// One call: build the expectation, read the live catalog, compare. Throws whatever `query` throws (the caller decides whether that is a network failure to
// surface or a "this server cannot introspect" case that falls back to the full DDL path).
async function verify(query, statements, options = {}) {
  const expected = expectedCatalog(statements, options.migrationStatements || []); const actual = await readCatalog(query);
  const res = compare(expected, actual, options);
  res.counts = { tables: Object.keys(expected.tables).length, columns: Object.values(expected.tables).reduce((n, c) => n + Object.keys(c).length, 0), indexes: Object.keys(expected.indexes).length };
  return res;
}

module.exports = { expectedCatalog, readCatalog, compare, verify, TABLES_SQL, INDEXES_SQL };
