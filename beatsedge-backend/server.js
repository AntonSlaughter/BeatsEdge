const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
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
      'GET /api/defense/overall/:sport/:season/:team',
      'GET /api/defense/by-position/:sport/:team?window=season|last10|last20',
      'GET /api/defense/combined/:sport/:season/:team?window=season|last10|last20',
      'GET /api/player/situational/:playerName',
      'GET /api/team/advanced/:sport/:team?window=season|last10',
      'GET /api/nfl/defense/by-position/:team?window=season|last8|last4',
      'GET /api/mlb/pitcher/:playerId?window=season|last5starts',
      'GET /api/mlb/team-batting/:team?window=season|last15games',
      'GET /api/nhl/defense/by-position/:team?window=season|last10|last5',
      'GET /api/nhl/team-shooting/:team?window=season|last10',
      'GET /api/nba/history-status',
      'GET /api/nba/backtest-pool?season=&minGames=&limit=',
      'GET /api/nba/gamelogs?athletes=id,id&since=YYYY-MM-DD',
      'GET /api/nba/dvp?since=YYYY-MM-DD',
      'POST /api/snapshots  { date, sport, rows: [...] }',
      'GET /api/snapshots/summary',
      'GET /api/snapshots?since=YYYY-MM-DD&sport=&limit=',
      'POST /api/snapshots/settle'
    ]
  });
});

app.listen(PORT, () => {
  console.log(`BeatsEdge backend listening on port ${PORT}`);
});

// Nightly at 6am UTC — well after all US games have finished and box
// scores have posted, regardless of which US timezone the games were in.
cron.schedule('0 6 * * *', () => {
  console.log('[cron] Running scheduled NBA nightly update...');
  runNightlyUpdate().catch(err => console.error('[cron] NBA nightly update failed:', err));

  console.log('[cron] Running scheduled MLB nightly update...');
  runMlbNightlyUpdate().catch(err => console.error('[cron] MLB nightly update failed:', err));

  console.log('[cron] Running scheduled NHL nightly update...');
  runNhlNightlyUpdate().catch(err => console.error('[cron] NHL nightly update failed:', err));
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

// Run once shortly after boot too, so a fresh deploy doesn't wait a full
// day for its first data refresh attempt. Set SKIP_STARTUP_JOBS=1 in dev to
// keep the process from churning the DB right after start.
if (!process.env.SKIP_STARTUP_JOBS) {
  setTimeout(() => {
    console.log('[startup] Running initial NBA update pass...');
    runNightlyUpdate().catch(err => console.error('[startup] NBA initial update failed:', err));

    console.log('[startup] Running initial MLB update pass...');
    runMlbNightlyUpdate().catch(err => console.error('[startup] MLB initial update failed:', err));

    console.log('[startup] Running initial NHL update pass...');
    runNhlNightlyUpdate().catch(err => console.error('[startup] NHL initial update failed:', err));
  }, 10_000);

  // Slightly later + guarded: only pull the NBA history if it's missing or
  // stale (fresh Render deploys start with an empty disk). Cheap no-op once
  // it's populated and current.
  setTimeout(() => {
    try {
      const db = require('./lib/db');
      const row = db.prepare(`SELECT COUNT(*) c, MAX(game_date) d FROM nba_player_box`).get();
      const stale = !row || !row.c || !row.d || (Date.now() - Date.parse(row.d) > 3 * 864e5);
      if (stale) {
        console.log('[startup] NBA history missing/stale — refreshing...');
        runNbaHistoryRefresh().catch(err => console.error('[startup] NBA history refresh failed:', err));
      }
    } catch (e) { console.error('[startup] NBA history check failed:', e.message); }
  }, 25_000);
}
