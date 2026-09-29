// Phase 4, Section 12: a static regression guard. Enumerates the files that
// sit on ACTIVE production historical read/write paths (routes/api.js plus
// the cron nightly jobs) and fails if any of them directly opens/queries a
// legacy SQLite handle (better-sqlite3, node:sqlite DatabaseSync, or
// lib/db.js/lib/nflDb.js/lib/mlbDb.js/lib/nhlDb.js) for AUTHORITATIVE
// historical data, outside an explicitly documented, still-legitimate
// exception below. New accidental regressions (a future PR reintroducing
// `db.prepare(...)` in routes/api.js for some new historical read) will
// show up here as an unexpected match, not silently pass.
//
// This is intentionally a TEXT-level static check, not a full AST/call-
// graph analysis -- proportionate to what Phase 4 asks for ("enumerates
// ACTIVE production historical readers and writers... make future
// accidental regression visible"), and specific enough that a genuine new
// legacy dependency cannot slip in unnoticed.

const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, condition, detail) { if (condition) console.log(`PASS  ${name}`); else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? '  -- ' + JSON.stringify(detail) : ''}`); } }

const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// Every db.prepare(...)/legacy-handle-usage LINE explicitly allowed to
// remain, with the reason it does not block cutover. Anything NOT on this
// list that matches the forbidden patterns below is a real, unreviewed
// regression.
const ALLOWLIST = {
  'routes/api.js': [
    // /api/data-health's own diagnostic: it deliberately inspects the
    // legacy beatsedge.db file's raw table row counts AS THE THING BEING
    // REPORTED ON (proving it's ephemeral/empty), not as an authoritative
    // data source for any user-facing feature.
    `beatsedgeTableCounts[t] = db.prepare`,
    // getPlayerSituationalSplits is documented dead code -- its own
    // upstream table (box_scores-derived JOIN team_schedule) was
    // confirmed EMPTY in production before this migration even started
    // (Phase 1), so this function already returns nothing live in
    // production regardless of storage backend; deliberately NOT
    // converted because there is no live functionality to restore. See
    // lib/situationalEngine.js's own header comment.
    `getPlayerSituationalSplits(decodeURIComponent(req.params.playerName))`,
  ],
  // cron/nhlNightlyUpdate.js: converted Phase 5 (writer mechanically moved
  // to historicalStore, see lib/nhlEngine.js's insertBoxscoreAsync/
  // recomputeDefenseByPositionBulk/recomputeTeamShootingRollupBulk) -- no
  // remaining exception needed here.
};

const FORBIDDEN = [
  /\bdb\.prepare\(/g,
  /\bnflDb\.prepare\(/g,
  /\bmlbDb\.prepare\(/g,
  /\bnhlDb\.prepare\(/g,
  /require\(['"]better-sqlite3['"]\)/g,
  /require\(['"]node:sqlite['"]\)/g,
];

const ACTIVE_FILES = ['routes/api.js', 'cron/nightlyUpdate.js', 'cron/mlbNightlyUpdate.js', 'cron/nhlNightlyUpdate.js', 'scripts/recompute-nfl-dvp.js', 'server.js'];

for (const file of ACTIVE_FILES) {
  let text;
  try { text = read(file); } catch (e) { check(`${file}: file readable`, false, e.message); continue; }
  const lines = text.split('\n');
  const unexpected = [];
  lines.forEach((line, i) => {
    for (const re of FORBIDDEN) {
      re.lastIndex = 0;
      if (re.test(line)) {
        const allowed = (ALLOWLIST[file] || []).some(snippet => line.includes(snippet));
        if (!allowed) unexpected.push({ line: i + 1, text: line.trim() });
      }
    }
  });
  check(`${file}: no unreviewed legacy-SQLite dependency for authoritative historical data`, unexpected.length === 0, unexpected);
}

console.log(`\n${failures === 0 ? 'ALL NO-SPLIT-BRAIN CHECKS PASSED' : `${failures} CHECK(S) FAILED -- review the unexpected legacy dependency above`}`);
process.exit(failures === 0 ? 0 : 1);
