// MUTATION CHECK (test tooling, not product code):   node scripts/lib/mutateHeapFix.js [name-substring]
// Each mutant removes ONE protection of the heap-exhaustion fix in place, runs scripts/test-archive-heap-bound.js, and restores the file (also on crash). A mutant the test does not
// fail on is a hole in the test. Exit 0 only if every mutant is killed.
const fs = require('fs'), path = require('path'), cp = require('child_process'); const root = path.join(__dirname, '..', '..');
const F = { nba: 'lib/nbaProviderLineArchive.js', wnba: 'lib/wnbaProviderLineArchive.js', fac: 'lib/marketArchive/providerLineArchiveFactory.js', cache: 'lib/parlayCache.js' };
const M = [
  ['NBA archive not serialized (the unbounded concurrent passes come back)', 'nba', "propsPathRegex: NBA_PROPS_PATH_RE, serialize: { maxPending: 3 } }", "propsPathRegex: NBA_PROPS_PATH_RE }"],
  ['WNBA archive not serialized', 'wnba', "propsPathRegex: WNBA_PROPS_PATH_RE, serialize: { maxPending: 3 },", "propsPathRegex: WNBA_PROPS_PATH_RE,"],
  ['queue never refuses (maxPending unbounded)', 'fac', "if (_waiting.length >= maxPending) {", "if (false) {"],
  ['a rejected pass wedges the queue', 'fac', "catch (e) { job.reject(e); } } }", "catch (e) { job.reject(e); throw e; } } }"],
  ['the queue is not released after a pass (second call never runs)', 'fac', "finally { _running = false; }", "finally { }"],
  ['lookup reads every column again (raw_json comes back)', 'fac', "SELECT ${lookupCols} FROM (", "SELECT * FROM ("],
  ['inner lookup reads every column again', 'fac', "SELECT ${lookupCols}, ROW_NUMBER()", "SELECT *, ROW_NUMBER()"],
  ['lookup drops a compared column (a price change would go unseen)', 'fac', "const lookupCols = [...new Set([...IDENTITY_COLS, ...CHANGE_FIELDS])].join(', ');", "const lookupCols = [...new Set([...IDENTITY_COLS, ...CHANGE_FIELDS.filter(c => c !== 'under_price')])].join(', ');"],
  ['lookup drops an identity column', 'fac', "const lookupCols = [...new Set([...IDENTITY_COLS, ...CHANGE_FIELDS])].join(', ');", "const lookupCols = [...new Set([...IDENTITY_COLS.filter(c => c !== 'period'), ...CHANGE_FIELDS])].join(', ');"],
  ['parsed payload kept through the database work', 'fac', "const totalRows = rows.length; rows = null;", "const totalRows = rows.length;"],
  ['WNBA unresolved-semantics tag lost', 'wnba', "semanticsFor: (row) => (KNOWN_SEMANTICS_UNRESOLVED_MARKETS.has(row.market_key) ? 'SEMANTICS_UNRESOLVED' : 'CONFIRMED'),", "semanticsFor: (row) => 'CONFIRMED',"],
  ['NBA archive writes a different sport label', 'nba', "createProviderLineArchive({ sport: 'nba',", "createProviderLineArchive({ sport: 'nbb',"],
  ['the process-wide pass slot is not enforced (sports archive concurrently again)', 'fac', "if (_passActive < PASS_CONCURRENCY) { _passActive++; if (_passActive > _passMax) _passMax = _passActive; }", "if (true) { _passActive++; if (_passActive > _passMax) _passMax = _passActive; }"],
  ['passes waiting for the slot are unbounded', 'fac', "if (_passActive >= PASS_CONCURRENCY && _passWaiters.length >= PASS_MAX_WAITING) {", "if (false) {"],
  ['the slot is not handed over / released (a second pass never runs)', 'fac', "finally { const next = _passWaiters.shift(); if (next) next(); else _passActive--; }", "finally { }"],
  ['cache budget back to a fixed 96 MB', 'cache', "return Math.min(96 * 1024 * 1024, Math.floor(HEAP_LIMIT * 0.25));", "return 96 * 1024 * 1024;"],
  ['the [mem] line is never logged', 'cache', "if (cache.size > 0 || counters.sets !== _lastLoggedSets) {", "if (false) {"],
  ['the [mem] line is logged even when idle', 'cache', "if (cache.size > 0 || counters.sets !== _lastLoggedSets) {", "if (true) {"],
  ['cache counts UTF-8 bytes again', 'cache', "return NON_LATIN1.test(entry.body) ? entry.body.length * 2 : entry.body.length;", "return Buffer.byteLength(entry.body, 'utf8');"],
  ['cache counts every body as one byte per character', 'cache', "return NON_LATIN1.test(entry.body) ? entry.body.length * 2 : entry.body.length;", "return entry.body.length;"],
  ['cache counts every body as two bytes per character (over-counts Latin-1)', 'cache', "return NON_LATIN1.test(entry.body) ? entry.body.length * 2 : entry.body.length;", "return entry.body.length * 2;"],
];
const only = process.argv[2] || ''; let survived = 0, n = 0;
for (const [name, key, a, b] of M.filter(m => !only || m[0].includes(only))) {
  const file = path.join(root, F[key]); const orig = fs.readFileSync(file, 'utf8'); const count = orig.split(a).length - 1; n++;
  if (count !== 1) { console.log('ANCHOR x' + count + '  ' + name); survived++; continue; }
  try { fs.writeFileSync(file, orig.replace(a, () => b)); const r = cp.spawnSync(process.execPath, [path.join(root, 'scripts', 'test-archive-heap-bound.js')], { cwd: root, encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 26 });
    const failing = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).filter(l => /^FAIL/.test(l)).map(l => l.slice(0, 40)); const killed = r.status !== 0;
    if (!killed) survived++; console.log((killed ? 'KILLED   ' : 'SURVIVED ') + name + (killed ? '   (' + (failing.length ? failing.join(' | ') : 'exit ' + r.status) + ')' : '')); }
  finally { fs.writeFileSync(file, orig); }
}
console.log(survived ? `\n${survived} of ${n} mutant(s) NOT killed` : `\nall ${n} mutants killed`); process.exit(survived ? 1 : 0);
