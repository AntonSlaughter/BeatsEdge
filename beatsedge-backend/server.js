// Must run before anything below (routes/api.js and every cron module) is
// required — those transitively open the two SQLite connections at
// require-time, so the data directory / seed-once logic has to happen
// first. See lib/dataPaths.js and lib/ensureDataInitialized.js.
const { ensureDataInitialized } = require('./lib/ensureDataInitialized');
ensureDataInitialized();

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const apiRoutes = require('./routes/api');
const { runNightlyUpdate } = require('./cron/nightlyUpdate');
const { runMlbNightlyUpdate } = require('./cron/mlbNightlyUpdate');
const { runNhlNightlyUpdate } = require('./cron/nhlNightlyUpdate');
const { runSettleSnapshots } = require('./cron/settleSnapshots');
const { runNbaHistoryRefresh } = require('./cron/refreshNbaHistory');

const app = express();
const PORT = process.env.PORT || 3001;

// Wide-open CORS: this backend only ever serves free, public defensive
// stats (no user data, no secrets pass through it), so there's no
// sensitive-data reason to restrict origins. If you later add anything
// user-specific, lock this down to your actual site's origin.
app.use(cors());
// 16mb ceiling so the client can push a full slate of prop snapshots in one
// POST (see /api/snapshots). Everything else is tiny; the limit is just a cap.
app.use(express.json({ limit: '16mb' }));

app.use('/api', apiRoutes);

app.get('/', (req, res) => {
  res.json({
    service: 'beatsedge-backend',
    status: 'running',
    endpoints: [
      'GET /api/health',
      'GET /api/data-health (non-sensitive DB path/persistence/row-count status)',
      'GET /api/data-sources/health (provider status/cooldown for the ParlayAPI/PropLine passthroughs — no keys)',
      'GET /api/defense/overall/:sport/:season/:team',
      'GET /api/defense/by-position/:sport/:team?window=season|last10|last20',
      'GET /api/defense/combined/:sport/:season/:team?window=season|last10|last20',
      'GET /api/player/situational/:playerName',
      'GET /api/team/advanced/:sport/:team?window=season|last10',
      'GET /api/nfl/defense/by-position/:team (returns all windows: L3/L5/L10/season/multiseason + defenseInterceptions)',
      'GET /api/mlb/pitcher/:playerId?window=season|last5starts',
      'GET /api/mlb/team-batting/:team?window=season|last15games',
      'GET /api/nhl/defense/by-position/:team?window=season|last10|last5',
      'GET /api/nhl/team-shooting/:team?window=season|last10',
      'GET /api/nba/history-status',
      'GET /api/nba/backtest-pool?season=&minGames=&limit=',
      'GET /api/nba/gamelogs?athletes=id,id&since=YYYY-MM-DD',
      'GET /api/nba/dvp?since=YYYY-MM-DD',
      'POST /api/nba/next-man-up  { asOfDate, players: [{athleteId,athleteName,team,posGroup,unavailableTeammates:[...]}] } (research-only, not part of the graded model)',
      'POST /api/snapshots  { date, sport, rows: [...] }',
      'GET /api/snapshots/summary',
      'GET /api/snapshots?since=YYYY-MM-DD&sport=&limit=',
      'POST /api/snapshots/settle'
    ]
  });
});

// Snapshot storage (SQLite locally, Turso in production once configured)
// must be verified reachable BEFORE the server starts accepting traffic --
// never silently serve requests against a snapshot backend that's actually
// unreachable/misconfigured. A Turso connection/auth/schema failure here
// crashes the process on purpose (see lib/snapshotStore.js's header) rather
// than letting the app come up "healthy" with snapshot storage quietly
// broken.
(async () => {
  try {
    const snapshotStore = require('./lib/snapshotStore');
    await snapshotStore.verifyReady();
    console.log(`[startup] snapshot storage ready (backend=${snapshotStore.backend})`);
  } catch (err) {
    console.error('[startup] FATAL: snapshot storage is not reachable —', err.message);
    console.error('[startup] Refusing to start with broken snapshot storage. Check TURSO_DATABASE_URL / TURSO_AUTH_TOKEN.');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`BeatsEdge backend listening on port ${PORT}`);
  });
})();

// Nightly at 6am UTC — well after all US games have finished and box
// scores have posted, regardless of which US timezone the games were in.
// Sequential, not concurrent: see the startup chain below for why.
cron.schedule('0 6 * * *', async () => {
  console.log('[cron] Running scheduled NBA nightly update...');
  await runNightlyUpdate().catch(err => console.error('[cron] NBA nightly update failed:', err));

  console.log('[cron] Running scheduled MLB nightly update...');
  await runMlbNightlyUpdate().catch(err => console.error('[cron] MLB nightly update failed:', err));

  console.log('[cron] Running scheduled NHL nightly update...');
  await runNhlNightlyUpdate().catch(err => console.error('[cron] NHL nightly update failed:', err));

  await runNflPipeline('cron');
});

// A bit later — settle yesterday's prop snapshots against real box scores.
cron.schedule('30 7 * * *', () => {
  console.log('[cron] Settling prop snapshots...');
  runSettleSnapshots().catch(err => console.error('[cron] snapshot settle failed:', err));
});

// Refresh the historical NBA box scores (nba_player_box) — keeps the
// walk-forward backtest and the current-season DvP grid current in-season.
cron.schedule('45 8 * * *', () => {
  console.log('[cron] Refreshing NBA history...');
  runNbaHistoryRefresh().catch(err => console.error('[cron] NBA history refresh failed:', err));
});

// NFL ingest + DvP recompute — run as CHILD PROCESSES, not in-process like
// the jobs above. Both scripts write through node:sqlite's DatabaseSync
// rather than better-sqlite3 (see scripts/ingest-nflverse-stats.js's header
// comment): the write volume involved reproducibly crashes better-sqlite3's
// native binding on this box, so they must stay out of this process's own
// heap/handles entirely, not just avoid the module import.
//
// Awaitable and never throws (matches the previous fire-and-forget error
// handling) so callers can chain it into a sequential run — see the
// concurrency note on the startup chain below.
async function runNflPipeline(label) {
  const ingest = path.join(__dirname, 'scripts', 'ingest-nflverse-stats.js');
  const recompute = path.join(__dirname, 'scripts', 'recompute-nfl-dvp.js');
  console.log(`[${label}] Running NFL ingest...`);
  try {
    const { stdout } = await execFileAsync('node', [ingest]);
    if (stdout) console.log(`[${label}] NFL ingest output:`, stdout.trim());
  } catch (err) {
    console.error(`[${label}] NFL ingest failed:`, err.stderr || err.message);
    return;
  }
  console.log(`[${label}] Running NFL DvP recompute...`);
  try {
    const { stdout } = await execFileAsync('node', [recompute]);
    if (stdout) console.log(`[${label}] NFL recompute output:`, stdout.trim());
  } catch (err) {
    console.error(`[${label}] NFL recompute failed:`, err.stderr || err.message);
  }
}

// Only pull the NBA history if it's missing or stale (fresh Render deploys
// start with an empty disk). Cheap no-op once it's populated and current.
async function refreshNbaHistoryIfStale(label) {
  try {
    const db = require('./lib/db');
    const row = db.prepare(`SELECT COUNT(*) c, MAX(game_date) d FROM nba_player_box`).get();
    const stale = !row || !row.c || !row.d || (Date.now() - Date.parse(row.d) > 3 * 864e5);
    if (stale) {
      console.log(`[${label}] NBA history missing/stale — refreshing...`);
      await runNbaHistoryRefresh().catch(err => console.error(`[${label}] NBA history refresh failed:`, err));
    }
  } catch (e) {
    console.error(`[${label}] NBA history check failed:`, e.message);
  }
}

// Run once shortly after boot too, so a fresh deploy doesn't wait a full
// day for its first data refresh attempt. Set SKIP_STARTUP_JOBS=1 in dev to
// keep the process from churning the DB right after start.
//
// Sequential, not concurrent: firing the NBA/MLB/NHL updates, the NFL
// child-process pipeline, and the NBA history refresh all within the same
// ~15s window (previous two-setTimeout design) stacked enough simultaneous
// memory use to exceed Render Free's real RAM and crash with a V8
// "FATAL ERROR: Reached heap limit" during ingest-hoopr-nba.js (observed in
// production 2026-09-14). Each job fits comfortably on its own; five at
// once didn't. Awaiting them one at a time keeps peak memory to roughly one
// job's footprint without changing what any job does or how much data it
// touches.
if (!process.env.SKIP_STARTUP_JOBS) {
  setTimeout(async () => {
    console.log('[startup] Running initial NBA update pass...');
    await runNightlyUpdate().catch(err => console.error('[startup] NBA initial update failed:', err));

    console.log('[startup] Running initial MLB update pass...');
    await runMlbNightlyUpdate().catch(err => console.error('[startup] MLB initial update failed:', err));

    console.log('[startup] Running initial NHL update pass...');
    await runNhlNightlyUpdate().catch(err => console.error('[startup] NHL initial update failed:', err));

    console.log('[startup] Running initial NFL ingest + DvP recompute...');
    await runNflPipeline('startup');

    await refreshNbaHistoryIfStale('startup');
  }, 10_000);
}
