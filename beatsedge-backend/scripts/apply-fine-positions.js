// Upgrades box_scores.position from coarse (G/F) to fine (PG/SG/SF/PF)
// using the compiled reference table — but ONLY when the fine position
// is compatible with what was actually recorded for that row. If the
// compiled table says "SF" but a specific row was recorded as "G" (real
// data sometimes does this for versatile players), that row is left
// alone rather than forced into a contradiction. This is a safety net,
// not just a formality — it already caught a real case (Mikal Bridges,
// classically a forward, was recorded as "G" for many rows in this
// dataset) during review.

const db = require('../lib/db');
const compiledPositions = require('../data/compiled-positions');
const { recomputeDefenseByPosition, getDefenseByPosition } = require('../lib/dvpEngine');

const COMPATIBLE = {
  G: ['PG', 'SG'],
  F: ['SF', 'PF']
};

const rows = db.prepare(`
  SELECT id, player_name, position FROM box_scores
  WHERE sport = 'nba' AND position IN ('G', 'F')
`).all();

console.log(`Scanning ${rows.length} coarse (G/F) rows...`);

const update = db.prepare(`UPDATE box_scores SET position = ? WHERE id = ?`);

let upgraded = 0, noMapping = 0, incompatible = 0;
const upgradedPlayers = new Set();
const incompatiblePlayers = new Set();

const applyUpdates = db.transaction((rows) => {
  for (const row of rows) {
    const finePosition = compiledPositions[row.player_name];
    if (!finePosition) {
      noMapping++;
      continue;
    }
    const allowed = COMPATIBLE[row.position] || [];
    if (!allowed.includes(finePosition)) {
      incompatible++;
      incompatiblePlayers.add(`${row.player_name} (compiled=${finePosition}, recorded=${row.position})`);
      continue;
    }
    update.run(finePosition, row.id);
    upgraded++;
    upgradedPlayers.add(row.player_name);
  }
});

applyUpdates(rows);

console.log(`\n✓ Upgraded to fine position: ${upgraded} rows (${upgradedPlayers.size} distinct players)`);
console.log(`- No compiled mapping (left coarse): ${noMapping} rows`);
console.log(`- Incompatible with recorded bucket (left coarse, not forced): ${incompatible} rows`);
if (incompatiblePlayers.size > 0) {
  console.log(`  Players with a real bucket conflict:`, [...incompatiblePlayers].slice(0, 10));
}

console.log(`\nCoverage: ${(100 * upgraded / rows.length).toFixed(1)}% of all G/F rows now have a real PG/SG/SF/PF label`);

console.log('\nRecomputing defense_by_position with the new fine-grained data...');
const summary = recomputeDefenseByPosition('nba');
console.log(JSON.stringify(summary, null, 2));

console.log('\nSample real results, PG (season):');
['BOS', 'OKC', 'WAS', 'CLE'].forEach(team => {
  const d = getDefenseByPosition('nba', team, 'season');
  console.log(`  ${team}: PG allowed`, d.PG || 'no data');
});

console.log('\nSample real results, SG (season):');
['BOS', 'OKC', 'WAS', 'CLE'].forEach(team => {
  const d = getDefenseByPosition('nba', team, 'season');
  console.log(`  ${team}: SG allowed`, d.SG || 'no data');
});

db.prepare(`INSERT INTO ingest_log (run_type, rows_added, notes) VALUES ('seed', ?, ?)`)
  .run(upgraded, `Applied compiled PG/SG/SF/PF reference (v1) — ${upgraded} rows upgraded, ${upgradedPlayers.size} players`);
