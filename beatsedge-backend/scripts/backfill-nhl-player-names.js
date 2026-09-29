// One-time backfill: scripts/ingest-hoopr-nhl.js's original nhl_player_box
// INSERT column list omitted player_name entirely (bug, fixed in that
// file), so every already-ingested row has player_name=NULL despite the
// real source CSVs always carrying it. Re-reads the same real CSVs and
// UPDATEs player_name by (game_id, player_id) -- no re-insert, no risk to
// any other column, idempotent (safe to re-run).
//
//   node --env-file=.env scripts/backfill-nhl-player-names.js

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const store = require('../lib/historicalStore');

const PLAYER_DIR = path.join(__dirname, '..', 'data', 'hoopr-nhl', 'player_box');
const BATCH_SIZE = 200;

function readCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(parse({ columns: true, skip_empty_lines: true }))
      .on('data', r => rows.push(r))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

(async () => {
  console.log('backend:', store.backend);
  if (!fs.existsSync(PLAYER_DIR)) { console.log('No player_box CSVs found -- nothing to backfill.'); process.exit(0); }
  const files = fs.readdirSync(PLAYER_DIR).filter(f => /^player_box_\d{4}\.csv$/.test(f)).sort();
  let totalUpdated = 0;
  for (const f of files) {
    const rows = await readCsv(path.join(PLAYER_DIR, f));
    const seen = new Set();
    const updates = [];
    for (const r of rows) {
      const key = `${r.game_id}|${r.player_id}`;
      if (seen.has(key) || !r.game_id || !r.player_id || !r.player_name) continue;
      seen.add(key);
      updates.push([r.player_name, r.game_id, r.player_id]);
    }
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      await store.batchInsert(`UPDATE nhl_player_box SET player_name = ? WHERE game_id = ? AND player_id = ?`, batch);
    }
    console.log(`${f}: ${updates.length} rows backfilled`);
    totalUpdated += updates.length;
  }
  console.log(`\nDone. ${totalUpdated} rows had player_name backfilled.`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
