// Nightly: keep nba_player_box current in-season. Re-downloads the latest
// 2 season files from the hoopR bulk repo (current + previous, so the
// Oct season boundary is covered) and re-ingests them. The season CSVs
// are updated within a day of each game there, so this stays fresh.
//
// Shells out to the standalone scripts on purpose: the ingest writes via
// node:sqlite in its own process (the prebuilt better-sqlite3 binary
// aborts on a large transaction under Node 24 — see scripts/ingest-hoopr-nba.js),
// and running it detached never touches the server's live DB handle mid-write.

const { execFile } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const run = (args) => new Promise((resolve, reject) => {
  execFile(process.execPath, args, { cwd: ROOT, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      err ? reject(err) : resolve(stdout);
    });
});

async function runNbaHistoryRefresh() {
  const now = new Date();
  // Season END year: Oct-Dec belongs to next year's season, Jan-Sep to this year's.
  const latest = now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
  const from = latest - 1;
  console.log(`[nba-history] refreshing seasons ${from}..${latest}`);
  await run(['scripts/fetch-hoopr-nba.js', '--from', String(from), '--to', String(latest), '--sets', 'player_box,team_box', '--format', 'csv', '--force']);
  await run(['scripts/ingest-hoopr-nba.js', '--since', String(from)]);
  console.log('[nba-history] done');
  return { seasons: [from, latest] };
}

module.exports = { runNbaHistoryRefresh };

if (require.main === module) {
  runNbaHistoryRefresh().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
