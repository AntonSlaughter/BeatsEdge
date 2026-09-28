// Historical data-quality repair for nfl_player_game_stats: rush_attempts,
// pass_attempts, completions are confirmed uniformly zero for seasons
// 2022-2024 (added via a later ALTER TABLE in lib/nflSchema.js that never
// backfilled pre-existing rows -- see lib/nflGameEnvironment.js's own
// audit comment). Backfills ONLY these 3 columns, ONLY for existing rows,
// matched by the exact stable key this table already uses (season, week,
// season_type, player_id -- gsis_id format, confirmed 25/25 real-row match
// in the prior research pass). Never inserts a new row, never fuzzy-name-
// matches, never touches any other column (passing_yards, receiving_yards,
// etc. are confirmed reliable for this window and are explicitly out of
// scope here).
//
// RECONCILIATION RULE: a row is only updated if its CURRENT value for that
// column is 0 or NULL. A nonzero existing value is never overwritten --
// logged as a "conflict" and skipped, never silently resolved.
//
// Source: nflverse-data (https://github.com/nflverse/nflverse-data),
// stats_player_week_<season>.csv, CC-BY-4.0. See NFLVERSE_ATTRIBUTION.md.
//
//   node scripts/repair-nfl-2022-2024-attempts.js --dry-run
//   node scripts/repair-nfl-2022-2024-attempts.js --apply

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { DatabaseSync } = require('node:sqlite'); // avoids the known better-sqlite3 native cleanup crash, same as scripts/ingest-nflverse-stats.js
const { BEATSEDGE_DB_PATH } = require('../lib/dataPaths');

const SEASONS = [2022, 2023, 2024];
const CSV_DIR = path.join(__dirname, '..', 'tmp', 'final-audit-nflverse-sample', 'raw');
const KEEP_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const APPLY = process.argv.includes('--apply');

const db = new DatabaseSync(BEATSEDGE_DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

const selectStmt = db.prepare(`
  SELECT id, pass_attempts, completions, rush_attempts
  FROM nfl_player_game_stats
  WHERE season = ? AND week = ? AND season_type = ? AND player_id = ?
`);
const updateStmt = db.prepare(`
  UPDATE nfl_player_game_stats
  SET pass_attempts = ?, completions = ?, rush_attempts = ?, source = 'nflverse-stats_player-repair-2026-09-28'
  WHERE id = ?
`);

function loadCsv(season) {
  const p = path.join(CSV_DIR, `stats_player_week_${season}.csv`);
  const text = fs.readFileSync(p, 'utf8');
  return parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true });
}

(async () => {
  const summary = {
    dryRun: !APPLY,
    seasons: SEASONS,
    eligibleCsvRows: 0,       // nflverse rows for QB/RB/WR/TE with a player_id
    matchedLocalRows: 0,      // exact (season,week,season_type,player_id) match found locally
    unmatchedCsvRows: 0,      // no local row exists for that exact key (never inserted -- out of scope)
    wouldChange: 0,           // matched row where >=1 of the 3 local columns is 0/null and nflverse has a real value to fill in
    nonzeroConflicts: 0,      // matched row where a local column is ALREADY nonzero and differs from nflverse -- skipped, logged
    unchanged: 0,             // matched row already consistent (no update needed)
    conflictSamples: [],
    changeSamples: [],
    perSeason: {},
  };

  for (const season of SEASONS) {
    const rows = loadCsv(season);
    const perSeason = { csvRows: rows.length, eligible: 0, matched: 0, unmatched: 0, wouldChange: 0, conflicts: 0, unchanged: 0 };

    for (const r of rows) {
      if (!KEEP_POSITIONS.has(r.position) || !r.player_id) continue;
      perSeason.eligible++; summary.eligibleCsvRows++;
      const seasonN = parseInt(r.season, 10), weekN = parseInt(r.week, 10);
      const seasonType = r.season_type || 'REG';

      const local = selectStmt.get(seasonN, weekN, seasonType, r.player_id);
      if (!local) { perSeason.unmatched++; summary.unmatchedCsvRows++; continue; }
      perSeason.matched++; summary.matchedLocalRows++;

      const nvAttempts = num(r.attempts), nvCompletions = num(r.completions), nvCarries = num(r.carries);
      const curAttempts = local.pass_attempts || 0, curCompletions = local.completions || 0, curCarries = local.rush_attempts || 0;

      const conflict = (
        (curAttempts !== 0 && nvAttempts !== 0 && curAttempts !== nvAttempts) ||
        (curCompletions !== 0 && nvCompletions !== 0 && curCompletions !== nvCompletions) ||
        (curCarries !== 0 && nvCarries !== 0 && curCarries !== nvCarries)
      );
      if (conflict) {
        perSeason.conflicts++; summary.nonzeroConflicts++;
        if (summary.conflictSamples.length < 10) {
          summary.conflictSamples.push({ season: seasonN, week: weekN, playerId: r.player_id, name: r.player_display_name, local: { curAttempts, curCompletions, curCarries }, nflverse: { nvAttempts, nvCompletions, nvCarries } });
        }
        continue; // never overwrite a nonzero conflicting value
      }

      const needsAttempts = curAttempts === 0 && nvAttempts !== 0;
      const needsCompletions = curCompletions === 0 && nvCompletions !== 0;
      const needsCarries = curCarries === 0 && nvCarries !== 0;
      if (!needsAttempts && !needsCompletions && !needsCarries) { perSeason.unchanged++; summary.unchanged++; continue; }

      perSeason.wouldChange++; summary.wouldChange++;
      if (summary.changeSamples.length < 10) {
        summary.changeSamples.push({ season: seasonN, week: weekN, playerId: r.player_id, name: r.player_display_name, before: { curAttempts, curCompletions, curCarries }, after: { nvAttempts, nvCompletions, nvCarries } });
      }
      if (APPLY) {
        updateStmt.run(
          needsAttempts ? nvAttempts : curAttempts,
          needsCompletions ? nvCompletions : curCompletions,
          needsCarries ? nvCarries : curCarries,
          local.id
        );
      }
    }
    summary.perSeason[season] = perSeason;
    console.log(`${season}: csvRows=${perSeason.csvRows} eligible=${perSeason.eligible} matched=${perSeason.matched} unmatched=${perSeason.unmatched} wouldChange=${perSeason.wouldChange} conflicts=${perSeason.conflicts} unchanged=${perSeason.unchanged}`);
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'} summary:`, JSON.stringify({
    eligibleCsvRows: summary.eligibleCsvRows, matchedLocalRows: summary.matchedLocalRows, unmatchedCsvRows: summary.unmatchedCsvRows,
    wouldChange: summary.wouldChange, nonzeroConflicts: summary.nonzeroConflicts, unchanged: summary.unchanged,
  }, null, 2));

  const outPath = path.join(__dirname, '..', 'tmp', `final-audit-nfl-repair-${APPLY ? 'applied' : 'dryrun'}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`Written to ${outPath}`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
