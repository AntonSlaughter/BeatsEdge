// Repairs the historical NULL game_date in nfl_player_game_stats, using
// nflverse's real "schedules" release (games.csv: game_id, season, week,
// gameday, away_team, home_team -- CC-BY-4.0, see NFLVERSE_ATTRIBUTION.md).
// Deterministic join, NOT fuzzy matching: for each (season, week, team,
// opponent) row, the real schedule game where {away_team,home_team} as a
// SET equals {team,opponent} as a set is unique (a team plays at most one
// real game in a given week). Only ever WRITES game_date -- no other
// column touched, and only when it's currently NULL (never overwrites an
// existing value).
//
//   node scripts/repair-nfl-game-date.js --dry-run
//   node scripts/repair-nfl-game-date.js --apply

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { DatabaseSync } = require('node:sqlite');
const { BEATSEDGE_DB_PATH } = require('../lib/dataPaths');

const APPLY = process.argv.includes('--apply');
const CSV_PATH = path.join(__dirname, '..', 'tmp', 'final-audit-nflverse-sample', 'raw', 'games.csv');

(async () => {
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const games = parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true });
  console.log(`Loaded ${games.length} real scheduled games from nflverse games.csv`);

  // Build a lookup: "season|week|teamA|teamB" (teams sorted) -> gameday
  const byMatchup = new Map();
  for (const g of games) {
    if (!g.season || !g.week || !g.away_team || !g.home_team || !g.gameday) continue;
    const teams = [g.away_team, g.home_team].sort();
    const key = `${g.season}|${g.week}|${teams[0]}|${teams[1]}`;
    byMatchup.set(key, g.gameday);
  }

  const db = new DatabaseSync(BEATSEDGE_DB_PATH);
  const rows = db.prepare(`SELECT id, season, week, team, opponent, game_date FROM nfl_player_game_stats`).all();
  console.log(`Loaded ${rows.length} local nfl_player_game_stats rows`);

  const summary = { eligible: 0, alreadySet: 0, matched: 0, unmatched: 0, wouldChange: 0, unmatchedSamples: [] };
  const updates = [];
  for (const r of rows) {
    if (r.game_date != null && r.game_date !== '') { summary.alreadySet++; continue; }
    summary.eligible++;
    const teams = [r.team, r.opponent].sort();
    const key = `${r.season}|${r.week}|${teams[0]}|${teams[1]}`;
    const gameday = byMatchup.get(key);
    if (!gameday) {
      summary.unmatched++;
      if (summary.unmatchedSamples.length < 10) summary.unmatchedSamples.push({ season: r.season, week: r.week, team: r.team, opponent: r.opponent });
      continue;
    }
    summary.matched++;
    summary.wouldChange++;
    updates.push({ id: r.id, gameday });
  }

  console.log('\n' + (APPLY ? 'APPLIED' : 'DRY RUN') + ' summary:', JSON.stringify(summary, null, 2));

  if (APPLY && updates.length) {
    const upd = db.prepare(`UPDATE nfl_player_game_stats SET game_date = ? WHERE id = ?`);
    db.exec('BEGIN');
    try {
      for (const u of updates) upd.run(u.gameday, u.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    console.log(`Applied ${updates.length} game_date updates.`);
  }

  const outPath = path.join(__dirname, '..', 'tmp', `nfl-game-date-repair-${APPLY ? 'applied' : 'dryrun'}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`Written to ${outPath}`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
