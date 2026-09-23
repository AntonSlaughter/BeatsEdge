const express = require('express');
const router = express.Router();
const { fetchLeagueDefenseStats } = require('../lib/statsProxy');
const { fetchProbablePitchers } = require('../lib/mlbProxy');
const { getDefenseByPosition, getTeamAdvancedStats } = require('../lib/dvpEngine');
const { getPlayerSituationalSplits, getTeamScheduleContext } = require('../lib/situationalEngine');
const { getNflDefenseByPosition } = require('../lib/nflDvpEngine');
const nflDb = require('../lib/nflDb');
const mlbDb = require('../lib/mlbDb');
const { getDefenseByPosition: getNhlDefenseByPosition } = require('../lib/nhlEngine');
const nhlDb = require('../lib/nhlDb');
const db = require('../lib/db');
const { saveSnapshots, snapshotSummary, getSnapshots } = require('../lib/snapshotDb');
const { runSettleSnapshots } = require('../cron/settleSnapshots');
const nbaHist = require('../lib/nbaHistDb');
const dataSourceHealth = require('../lib/dataSourceHealth');
const parlayCache = require('../lib/parlayCache');
const wnbaProviderLineArchive = require('../lib/wnbaProviderLineArchive');
const nbaProviderLineArchive = require('../lib/nbaProviderLineArchive');
const { buildNextManUpSignal } = require('../lib/nextManUpSignal');
const { buildGameEnvironmentSignal, bulkTeamHistory } = require('../lib/gameEnvironment');
const { buildNflGameEnvironmentSignal } = require('../lib/nflGameEnvironment');
const { buildAvailabilityRoleSignal } = require('../lib/playerAvailabilitySignal');
const { computeDefenseAllowedAsOf, bulkDefenseAllowedHistory, bulkPlayerHistory, backtestPool: nflBacktestPool } = require('../lib/nflMatchupSignal');
const newsDb = require('../lib/newsDb');
const newsIngest = require('../lib/newsIngest');
const newsClassifier = require('../lib/newsClassifier');
const newsImpact = require('../lib/newsImpact');

// GET /api/health — quick check this is alive (also what wakes a sleeping
// Render free instance, and what BeatsEdge.html can ping before relying on it)
router.get('/health', (req, res) => {
  const lastIngest = db.prepare(`SELECT * FROM ingest_log ORDER BY ran_at DESC LIMIT 1`).get();
  res.json({ ok: true, lastIngest: lastIngest || null });
});

// GET /api/data-health — non-sensitive database/storage status: where the
// two SQLite files actually live right now, whether they exist, their size,
// and headline row counts. No secrets, no env var values, no raw row
// contents — just enough to tell "production has real persistent data" from
// "production just reset to an empty/missing database" at a glance.
router.get('/data-health', async (req, res) => {
  try {
    const fs = require('fs');
    const { DATA_DIR, BEATSEDGE_DB_PATH, SNAPSHOTS_DB_PATH, usingCustomDataDir } = require('../lib/dataPaths');
    const snapStore = require('../lib/snapshotStore');

    const fileInfo = (p) => {
      try { const st = fs.statSync(p); return { exists: true, sizeBytes: st.size }; }
      catch (e) { return { exists: false, sizeBytes: null }; }
    };

    const BEATSEDGE_TABLES = [
      'box_scores', 'nba_player_box', 'team_schedule', 'team_game_advanced', 'team_advanced_rollup',
      'nfl_player_game_stats', 'nfl_defense_by_position', 'nfl_team_defense_game', 'nfl_defense_interceptions',
      'mlb_batter_game_stats', 'mlb_pitcher_game_stats', 'mlb_pitcher_rollup', 'mlb_team_batting_rollup',
      'nhl_skater_game_stats', 'nhl_goalie_game_stats', 'ingest_log'
    ];
    const beatsedgeTableCounts = {};
    BEATSEDGE_TABLES.forEach(t => {
      try { beatsedgeTableCounts[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; }
      catch (e) { /* table doesn't exist in this DB — omit rather than error the whole endpoint */ }
    });

    // Snapshot storage: reports which backend is ACTUALLY active (sqlite vs
    // turso) and, on Turso, whether the connection is genuinely reachable —
    // never reports "connected" by assumption. A Turso query failure here
    // surfaces as an explicit error field, not a silently-empty count.
    let snapshotStatus;
    try {
      const c = async (where) => (await snapStore.queryOne(`SELECT COUNT(*) c FROM prop_snapshots${where ? ' WHERE ' + where : ''}`)).c;
      const [total, modelA, modelB, settled, dnp, unresolved, invalid, neverAttempted] = await Promise.all([
        c(), c(`model_variant='A'`), c(`model_variant='B'`),
        c(`settlement_status='settled'`), c(`settlement_status='dnp'`),
        c(`settlement_status='unresolved'`), c(`settlement_status='invalid'`),
        c(`result IS NULL AND settlement_status IS NULL`)
      ]);
      snapshotStatus = {
        backend: snapStore.backend, connected: true,
        counts: { total, modelA, modelB, settled, dnp, unresolved, invalid, neverAttempted }
      };
    } catch (e) {
      snapshotStatus = { backend: snapStore.backend, connected: false, error: e.message };
    }
    if (snapStore.backend === 'sqlite') {
      snapshotStatus.path = SNAPSHOTS_DB_PATH;
      snapshotStatus = { ...snapshotStatus, ...fileInfo(SNAPSHOTS_DB_PATH) };
    }

    res.json({
      databaseType: 'sqlite',
      dataDir: DATA_DIR,
      persistenceMode: usingCustomDataDir
        ? 'persistent (BEATSEDGE_DATA_DIR set — expected to be a mounted disk)'
        : 'ephemeral (default repo ./data path — resets on every deploy/restart unless a disk is mounted here)',
      beatsedge: { backend: 'sqlite-local', path: BEATSEDGE_DB_PATH, ...fileInfo(BEATSEDGE_DB_PATH), tableCounts: beatsedgeTableCounts },
      snapshots: snapshotStatus
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/defense/overall/:sport/:season/:team
// Tries the LIVE stats.nba.com/wnba.com call first (real-time if it gets
// through). If that fails — which it did with an HTTP 403 in our own
// testing — falls back to defensive rating computed from your own
// historical CSV ingest (TeamStatisticsExtended.csv), which has NO live
// dependency at all. Either way you get a real number, never a guess.
router.get('/defense/overall/:sport/:season/:team', async (req, res) => {
  const { sport, season, team } = req.params;
  const windowType = req.query.window || 'season';

  try {
    const allTeams = await fetchLeagueDefenseStats(sport, season);
    const data = allTeams[team.toUpperCase()];
    if (data) {
      return res.json({ source: sport === 'wnba' ? 'WNBA.com (live)' : 'NBA.com (live)', ...data });
    }
  } catch (err) {
    // Live call failed — fall through to local historical data below.
  }

  const local = getTeamAdvancedStats(sport, team.toUpperCase(), windowType);
  if (local) {
    return res.json({
      source: 'Your historical data (computed, not live)',
      team: team.toUpperCase(),
      defensiveRating: local.defensiveRating,
      offensiveRating: local.offensiveRating,
      pace: local.pace,
      rank: local.rank,
      gamesSampled: local.gamesSampled
    });
  }

  res.status(404).json({ error: `No live or historical data for team ${team}` });
});

// GET /api/defense/by-position/:sport/:team?window=season|last10|last20
// Our own computed defense-vs-position numbers.
router.get('/defense/by-position/:sport/:team', (req, res) => {
  const { sport, team } = req.params;
  const windowType = req.query.window || 'season';
  try {
    const byPosition = getDefenseByPosition(sport, team.toUpperCase(), windowType);
    if (Object.keys(byPosition).length === 0) {
      return res.status(404).json({ error: `No computed data yet for ${team}. Has the seed/nightly job run?` });
    }
    res.json({ source: 'BeatsEdge computed (own box-score aggregation)', team: team.toUpperCase(), window: windowType, byPosition });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/defense/combined/:sport/:season/:team
// Convenience endpoint: overall (live, with real-historical fallback) +
// by-position (our compute) in one call. This is what BeatsEdge.html uses.
router.get('/defense/combined/:sport/:season/:team', async (req, res) => {
  const { sport, season, team } = req.params;
  const windowType = req.query.window || 'season';
  const result = { team: team.toUpperCase() };

  try {
    const allTeams = await fetchLeagueDefenseStats(sport, season);
    const liveData = allTeams[team.toUpperCase()];
    if (liveData) {
      result.overall = liveData;
      result.overallSource = sport === 'wnba' ? 'WNBA.com (live)' : 'NBA.com (live)';
    } else {
      throw new Error('team not found in live response');
    }
  } catch (err) {
    // Real fallback: your own historical defensive rating/pace — not a guess,
    // just not live-updated (only as fresh as your last CSV ingest).
    const local = getTeamAdvancedStats(sport, team.toUpperCase(), windowType);
    if (local) {
      result.overall = {
        team: team.toUpperCase(),
        oppPointsAllowed: null, // not directly comparable to live OPP_PTS; use defensiveRating instead
        defensiveRating: local.defensiveRating,
        offensiveRating: local.offensiveRating,
        pace: local.pace,
        rank: local.rank,
        gamesPlayed: local.gamesSampled
      };
      result.overallSource = 'Your historical data (computed, not live)';
    } else {
      result.overall = null;
      result.overallError = err.message;
    }
  }

  try {
    result.byPosition = getDefenseByPosition(sport, team.toUpperCase(), windowType);
    result.byPositionSource = 'BeatsEdge computed';
  } catch (err) {
    result.byPosition = {};
    result.byPositionError = err.message;
  }

  res.json(result);
});

// GET /api/team/advanced/:sport/:team?window=season|last10
// Real defensive rating, offensive rating, and pace — direct access to the
// historical rollup, useful for the Edge Score engine's "Pace" factor.
router.get('/team/advanced/:sport/:team', (req, res) => {
  const { sport, team } = req.params;
  const windowType = req.query.window || 'season';
  const data = getTeamAdvancedStats(sport, team.toUpperCase(), windowType);
  if (!data) return res.status(404).json({ error: `No historical advanced stats for ${team}` });
  res.json({ source: 'Your historical data (computed)', team: team.toUpperCase(), window: windowType, ...data });
});

// GET /api/player/situational/:playerName
// Real back-to-back vs rested, and home vs away splits, computed by
// joining actual box scores to the actual schedule. Not a model, not an
// estimate — literally what this player has done in each situation.
router.get('/player/situational/:playerName', (req, res) => {
  const splits = getPlayerSituationalSplits(decodeURIComponent(req.params.playerName));
  if (!splits) return res.status(404).json({ error: `No data for ${req.params.playerName}` });
  res.json({ source: 'BeatsEdge computed (real box scores joined to real schedule)', player: req.params.playerName, ...splits });
});

// GET /api/team/schedule-context/:sport/:team/:gameId
// Real rest-days/back-to-back/home-away for one specific game.
router.get('/team/schedule-context/:sport/:team/:gameId', (req, res) => {
  const { sport, team, gameId } = req.params;
  const context = getTeamScheduleContext(sport, team.toUpperCase(), gameId);
  if (!context) return res.status(404).json({ error: 'No schedule data for that game' });
  res.json({ source: 'BeatsEdge computed (real schedule)', ...context });
});

// ============================================================
// NFL — mirrors the NBA defense-vs-position pattern, but NFL
// positions (QB/RB/WR/TE) are clean from ingestion — no compiled
// reference table needed, unlike NBA's PG/SG/SF/PF situation.
// ============================================================

// GET /api/nfl/defense/by-position/:team
// Always returns all five windows (L3/L5/L10/season/multiseason) per
// position, each carrying its own games_sampled — never a single bare
// number. See lib/nflDvpEngine.js for the window/eligibility design.
router.get('/nfl/defense/by-position/:team', (req, res) => {
  const { team } = req.params;
  const { byPosition, interceptions } = getNflDefenseByPosition(nflDb, team.toUpperCase());
  const hasData = Object.values(byPosition).some(p => Object.values(p.windows).some(Boolean));
  if (!hasData) {
    return res.status(404).json({ error: `No computed NFL data for ${team}` });
  }
  res.json({
    source: 'BeatsEdge computed (real nflverse box scores)',
    team: team.toUpperCase(),
    byPosition,
    defenseInterceptions: interceptions
  });
});

// ============================================================
// NBA history — free hoopR / sportsdataverse box scores loaded into
// nba_player_box (scripts/ingest-hoopr-nba.js). Feeds the walk-forward
// backtest in the offseason (no live slate to iterate) and a fresh
// defense-vs-position grid. All read-only.
// ============================================================

// GET /api/nba/history-status — is the table populated, and how far back
router.get('/nba/history-status', (req, res) => {
  try {
    if (!nbaHist.hasData()) return res.json({ ready: false });
    const s = db.prepare(`SELECT COUNT(*) rows, COUNT(DISTINCT athlete_id) players, MIN(game_date) a, MAX(game_date) b, MAX(season) season FROM nba_player_box`).get();
    res.json({ ready: true, rows: s.rows, players: s.players, from: s.a, to: s.b, latestSeason: s.season });
  } catch (e) { res.json({ ready: false, error: e.message }); }
});

// GET /api/nba/backtest-pool?season=2026&minGames=25&limit=200
// A roster to walk-forward when there's no live slate.
router.get('/nba/backtest-pool', (req, res) => {
  try {
    const season = req.query.season ? parseInt(req.query.season, 10) : null;
    const minGames = Math.max(5, Math.min(82, parseInt(req.query.minGames, 10) || 25));
    const limit = Math.max(10, Math.min(500, parseInt(req.query.limit, 10) || 220));
    res.json({ season, pool: nbaHist.backtestPool({ season, minGames, limit }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/nba/gamelogs?athletes=1,2,3&since=2023-10-01
// Per-game rows (compact keys) for a set of ESPN athlete ids, oldest first.
router.get('/nba/gamelogs', (req, res) => {
  try {
    const ids = String(req.query.athletes || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 400);
    if (!ids.length) return res.status(400).json({ error: 'pass ?athletes=id,id,...' });
    const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since || '') ? req.query.since : null;
    res.json({ since, logs: nbaHist.gamelogs(ids, { since }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/nba/dvp?since=2025-10-01
// Defense-vs-position grid computed from nba_player_box: per team, per
// G/F/C, allowed-per-game for pts/reb/ast/3pm/stl/blk/to + a 1-30 rank.
router.get('/nba/dvp', (req, res) => {
  try {
    if (!nbaHist.hasData()) return res.status(404).json({ error: 'nba_player_box not populated — run scripts/ingest-hoopr-nba.js' });
    const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since || '') ? req.query.since : null;
    const asOf = db.prepare(`SELECT MAX(game_date) d FROM nba_player_box${since ? ' WHERE game_date >= ?' : ''}`).get(...(since ? [since] : []));
    res.json({ since, asOf: asOf && asOf.d, source: 'BeatsEdge computed (hoopR box scores)', grid: nbaHist.dvpGrid({ since }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/nba/next-man-up
// Body: { asOfDate: 'YYYY-MM-DD', players: [{ athleteId, athleteName, team,
//   posGroup, unavailableTeammates: [{athleteId,athleteName,posGroup}] }, ...] }
// SEPARATE, ADDITIVE research signal — see lib/nextManUpSignal.js's header.
// Does not read or write anything from calculateEdgeScore/grade/Prime/
// confluence (that logic lives entirely client-side in BeatsEdge.html and is
// untouched here). `unavailableTeammates` is supplied by the CALLER — in
// production BeatsEdge.html supplies it from its own existing live ESPN
// injury fetch (fetchLiveInjuries/sidelinedByTeam), not from anything this
// route looks up itself. Response never fabricates: any player with
// insufficient real history gets active:false with null impact fields.
router.post('/nba/next-man-up', (req, res) => {
  try {
    const { asOfDate, players } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate || '')) return res.status(400).json({ error: 'asOfDate must be YYYY-MM-DD' });
    if (!Array.isArray(players) || !players.length) return res.status(400).json({ error: 'players must be a non-empty array' });
    if (players.length > 500) return res.status(400).json({ error: 'too many players (max 500 per request)' });

    const signals = {};
    for (const p of players) {
      if (!p || !p.athleteId) continue;
      signals[p.athleteId] = buildNextManUpSignal({
        db,
        athleteId: String(p.athleteId),
        athleteName: p.athleteName || null,
        team: p.team || null,
        posGroup: p.posGroup || null,
        asOfDate,
        unavailableTeammates: Array.isArray(p.unavailableTeammates) ? p.unavailableTeammates : [],
        dataFreshness: p.dataFreshness || null,
      });
    }
    res.json({ source: 'BeatsEdge computed (real nba_player_box history, research-only, not part of the graded model)', asOfDate, signals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/nba/game-environment?team=BOS&opponent=LAL&asOfDate=YYYY-MM-DD
// SEPARATE, ADDITIVE research signal — see lib/gameEnvironment.js's header.
// Real per-game pace/offensive_rating/defensive_rating from team_game_advanced
// (Kaggle-seeded, 2023-10-24 through 2026-06-13). asOfDate defaults to today
// if omitted. Never writes to or reads from player.paceRating/paceDetail —
// those are existing fields the frozen model already reads; this is a
// distinct `gameEnvironment` field the caller attaches separately.
router.get('/nba/game-environment', (req, res) => {
  try {
    const { team, opponent } = req.query;
    const asOfDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOfDate || '') ? req.query.asOfDate : new Date().toISOString().slice(0, 10);
    if (!team || !opponent) return res.status(400).json({ error: 'team and opponent are required' });
    const signal = buildGameEnvironmentSignal({ db, team: String(team).toUpperCase(), opponent: String(opponent).toUpperCase(), asOfDate });
    res.json({ source: 'BeatsEdge computed (research-only, not part of the graded model)', asOfDate, ...signal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/nba/team-advanced-history?teams=BOS,LAL,...
// Bulk real per-game team_game_advanced rows for a set of teams — lets a
// caller (the backtest script/tool) build its own as-of trailing windows
// in memory instead of one request per prediction point. Read-only.
router.get('/nba/team-advanced-history', (req, res) => {
  try {
    const teams = String(req.query.teams || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 60);
    if (!teams.length) return res.status(400).json({ error: 'pass ?teams=BOS,LAL,...' });
    res.json({ source: 'BeatsEdge computed (real team_game_advanced rows, research-only)', history: bulkTeamHistory(db, teams) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/nfl/game-environment?team=KC&opponent=BUF&season=2026&week=2
// SEPARATE, ADDITIVE research signal — see lib/nflGameEnvironment.js's
// header. Real play-volume/pass-rate/rush-rate from nfl_player_game_stats,
// season 2025+ only (2022-2024 rows carry unpopulated zeros for these
// columns). No real game_date exists for this table, so this endpoint is
// ordered by season/week, not date.
router.get('/nfl/game-environment', (req, res) => {
  try {
    const { team, opponent } = req.query;
    const season = parseInt(req.query.season, 10);
    const week = parseInt(req.query.week, 10);
    if (!team || !opponent || !Number.isFinite(season) || !Number.isFinite(week)) {
      return res.status(400).json({ error: 'team, opponent, season, and week are all required' });
    }
    const signal = buildNflGameEnvironmentSignal({ db: nflDb, team: String(team).toUpperCase(), opponent: String(opponent).toUpperCase(), season, week });
    res.json({ source: 'BeatsEdge computed (research-only, not part of the graded model)', season, week, ...signal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/nfl/backtest-pool?minGames=&limit=
// A real NFL skill-position player pool with enough historical games to
// walk forward, sourced from nfl_player_game_stats — mirrors
// /api/nba/backtest-pool. Research-only, for the Phase 6 backtest.
router.get('/nfl/backtest-pool', (req, res) => {
  try {
    const minGames = Math.max(5, Math.min(50, parseInt(req.query.minGames, 10) || 15));
    const limit = Math.max(10, Math.min(500, parseInt(req.query.limit, 10) || 300));
    res.json({ source: 'BeatsEdge computed (real nfl_player_game_stats, research-only)', pool: nflBacktestPool(nflDb, { minGames, limit }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/nfl/player-history?ids=...
// Bulk real per-player-per-game rows from nfl_player_game_stats — the SAME
// backend table lib/nflMatchupSignal.js's defense-allowed data comes from,
// so the Phase 6 backtest sources both from one consistent pipeline.
router.get('/nfl/player-history', (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 400);
    if (!ids.length) return res.status(400).json({ error: 'pass ?ids=id,id,...' });
    res.json({ source: 'BeatsEdge computed (real nfl_player_game_stats, research-only)', history: bulkPlayerHistory(nflDb, ids) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/nfl/matchup-history?teams=DAL,SF,...&positions=WR,RB
// Bulk real per-team-week nfl_player_game_stats rows (stat-specific defense
// allowed, from Phase 6's audit) for a set of defenses/positions — lets a
// caller (the backtest) build its own as-of trailing windows in memory.
// SEPARATE, ADDITIVE research signal — see lib/nflMatchupSignal.js's header.
router.get('/nfl/matchup-history', (req, res) => {
  try {
    const teams = String(req.query.teams || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 60);
    const positions = String(req.query.positions || 'WR,RB').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!teams.length) return res.status(400).json({ error: 'pass ?teams=DAL,SF,...' });
    res.json({ source: 'BeatsEdge computed (real nfl_player_game_stats rows, research-only)', history: bulkDefenseAllowedHistory(nflDb, teams, positions) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/nfl/defense-allowed?team=DAL&position=WR&statKey=receivingYards&season=2025&week=3
// SEPARATE, ADDITIVE research signal — real, leak-safe, as-of trailing
// stat-specific defense-allowed for one team/position/stat. Research-only;
// NOT read by calculateEdgeScore (see lib/nflMatchupSignal.js's header for
// the full audit of why this exists and what it does not do).
router.get('/nfl/defense-allowed', (req, res) => {
  try {
    const { team, position, statKey } = req.query;
    const season = parseInt(req.query.season, 10);
    const week = parseInt(req.query.week, 10);
    if (!team || !position || !statKey || !Number.isFinite(season) || !Number.isFinite(week)) {
      return res.status(400).json({ error: 'team, position, statKey, season, and week are all required' });
    }
    const signal = computeDefenseAllowedAsOf(nflDb, String(team).toUpperCase(), String(position).toUpperCase(), statKey, season, week);
    res.json({ source: 'BeatsEdge computed (research-only, not part of the graded model)', team: String(team).toUpperCase(), position, statKey, season, week, ...signal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/nba/player-availability
// Body: { asOfDate: 'YYYY-MM-DD', players: [{ athleteId, team,
//   targetGameStarter }] }
// SEPARATE, ADDITIVE research signal — see lib/playerAvailabilitySignal.js's
// header. Distinct from /nba/next-man-up (teammate absence, already
// locked) -- this is the player's OWN availability/role. `targetGameStarter`
// (1/0/omitted) is supplied by the CALLER for the SPECIFIC game being
// evaluated -- this route never looks it up itself (no live NBA starting-
// lineup source exists; a historical caller passes the completed box
// score's own starter flag). availabilityStatus/minutesRestriction are
// always null here (no reconstructable source) -- never fabricated.
router.post('/nba/player-availability', (req, res) => {
  try {
    const { asOfDate, players } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate || '')) return res.status(400).json({ error: 'asOfDate must be YYYY-MM-DD' });
    if (!Array.isArray(players) || !players.length) return res.status(400).json({ error: 'players must be a non-empty array' });
    if (players.length > 500) return res.status(400).json({ error: 'too many players (max 500 per request)' });

    const signals = {};
    for (const p of players) {
      if (!p || !p.athleteId) continue;
      signals[p.athleteId] = buildAvailabilityRoleSignal({
        db,
        athleteId: String(p.athleteId),
        team: p.team || null,
        asOfDate,
        targetGameStarter: p.targetGameStarter === 1 || p.targetGameStarter === 0 ? p.targetGameStarter : null,
      });
    }
    res.json({ source: 'BeatsEdge computed (real nba_player_box history, research-only, not part of the graded model)', asOfDate, signals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// MLB — architecturally different from NBA/NFL on purpose. Baseball
// doesn't have "defense vs position"; a batter's matchup is really about
// the specific opposing pitcher, and a pitcher's matchup is about the
// opposing lineup as a whole. See lib/mlbDb.js for the full rationale.
// ============================================================

// GET /api/mlb/pitcher/:playerId?window=season|last5starts
// Real ERA/WHIP/K-9/HR-9 for a specific pitcher — the real matchup context
// for a BATTER prop (who is this batter facing tonight).
router.get('/mlb/pitcher/:playerId', (req, res) => {
  const { playerId } = req.params;
  const windowType = req.query.window || 'season';
  const row = mlbDb.prepare(`SELECT * FROM mlb_pitcher_rollup WHERE player_id = ? AND window_type = ?`).get(playerId, windowType);
  if (!row) return res.status(404).json({ error: `No computed pitcher data for ${playerId}` });
  res.json({ source: 'BeatsEdge computed (real statsapi.mlb.com box scores)', ...row });
});

// GET /api/mlb/team-batting/:team?window=season|last15games
// Real team-wide batting profile — the real matchup context for a
// PITCHER prop (what lineup is this pitcher facing tonight).
router.get('/mlb/team-batting/:team', (req, res) => {
  const { team } = req.params;
  const windowType = req.query.window || 'season';
  const row = mlbDb.prepare(`SELECT * FROM mlb_team_batting_rollup WHERE team = ? AND window_type = ?`).get(team.toUpperCase(), windowType);
  if (!row) return res.status(404).json({ error: `No computed batting data for ${team}` });
  res.json({ source: 'BeatsEdge computed (real statsapi.mlb.com box scores)', ...row });
});

// ============================================================
// NHL — skaters get a real defense-vs-position grid (Forward vs
// Defenseman), since NHL boxscores already split that way; goalies get
// a team-shooting-profile, mirroring MLB's pitcher-vs-lineup idea.
// ============================================================

// GET /api/nhl/defense/by-position/:team?window=season|last10|last5
router.get('/nhl/defense/by-position/:team', (req, res) => {
  const { team } = req.params;
  const windowType = req.query.window || 'season';
  const byPosition = getNhlDefenseByPosition(team.toUpperCase(), windowType);
  if (Object.keys(byPosition).length === 0) {
    return res.status(404).json({ error: `No computed NHL data for ${team}` });
  }
  res.json({ source: 'BeatsEdge computed (real api-web.nhle.com box scores)', team: team.toUpperCase(), window: windowType, byPosition });
});

// GET /api/nhl/team-shooting/:team?window=season|last10
// Real shots/goals generated per game — the matchup context for a
// GOALIE prop (saves, goals against): how much volume are they facing.
router.get('/nhl/team-shooting/:team', (req, res) => {
  const { team } = req.params;
  const windowType = req.query.window || 'season';
  const row = nhlDb.prepare(`SELECT * FROM nhl_team_shooting_rollup WHERE team = ? AND window_type = ?`).get(team.toUpperCase(), windowType);
  if (!row) return res.status(404).json({ error: `No computed shooting data for ${team}` });
  res.json({ source: 'BeatsEdge computed (real api-web.nhle.com box scores)', ...row });
});

// GET /api/mlb/probable-pitcher/:team?date=YYYY-MM-DD
// Real "who's actually pitching against this team tonight" — closes the
// gap that previously left batter matchups on sample data by default.
router.get('/mlb/probable-pitcher/:team', async (req, res) => {
  const { team } = req.params;
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const byTeam = await fetchProbablePitchers(date);
    const entry = byTeam[team.toUpperCase()];
    if (!entry) return res.status(404).json({ error: `No probable pitcher found for ${team} on ${date} (game may not be scheduled, or MLB hasn't posted a probable starter yet)` });
    res.json({ source: 'statsapi.mlb.com (live)', team: team.toUpperCase(), ...entry });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ============================================================
// Data-source health tracking (shared by both passthroughs below).
//
// Every request to a third-party prop-line provider goes through one of
// these two passthroughs, so the backend genuinely observes every response
// -- this is the one place that can track real health/cooldown state
// without ever touching the caller's API key (dataSourceHealth.js takes
// only a provider name + outcome, never the request itself). Never logs
// the key or the query string.
//
//   [data-source] <provider> rate limited (429) -- cooling down Ns
//   [data-source] <provider> in cooldown -- short-circuiting without calling upstream
//   [data-source] <provider> recovered
//
// Parses a standard HTTP Retry-After header (either delta-seconds or an
// HTTP-date) when the upstream sends one; falls back to bounded
// exponential backoff (see lib/dataSourceHealth.js) otherwise.
function parseRetryAfterSeconds(headerValue) {
  if (!headerValue) return null;
  const asSeconds = Number(headerValue);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds);
  const asDate = Date.parse(headerValue);
  if (!Number.isNaN(asDate)) return Math.max(0, Math.round((asDate - Date.now()) / 1000));
  return null;
}

let lastCooldownLogAt = {}; // provider -> ms timestamp, to avoid log spam during a long outage
function logOncePerMinute(provider, msg) {
  const now = Date.now();
  if (!lastCooldownLogAt[provider] || now - lastCooldownLogAt[provider] > 60_000) {
    lastCooldownLogAt[provider] = now;
    console.log(msg);
  }
}

// Thin, read-only GET forwarder shared by /propline/* and /parlayapi/* --
// same behavior both had before (path/host, query-string passthrough,
// 400 on a suspicious path, 502 on a network failure), now with health
// tracking wrapped around the upstream call.
function makePassthrough(provider, host, extraPassthroughHeaders = []) {
  return async (req, res) => {
    const upstreamPath = req.params[0];
    if (!upstreamPath || upstreamPath.includes('..')) {
      return res.status(400).json({ error: 'bad path' });
    }

    if (!dataSourceHealth.isEligible(provider)) {
      const health = dataSourceHealth.getHealth(provider);
      logOncePerMinute(provider, `[data-source] ${provider} in cooldown until ${health.cooldownUntil} -- short-circuiting without calling upstream`);
      return res.status(503).json({
        status: 'unavailable',
        reason: `${provider} is cooling down after repeated failures (${health.status})`,
        cooldownUntil: health.cooldownUntil
      });
    }

    const qs = new URLSearchParams(req.query).toString();
    const url = `https://${host}/${upstreamPath}${qs ? '?' + qs : ''}`;
    try {
      const upstream = await fetch(url, { headers: { Accept: 'application/json' } });
      const body = await upstream.text();

      if (upstream.status === 429) {
        const retryAfterSeconds = parseRetryAfterSeconds(upstream.headers.get('retry-after'));
        dataSourceHealth.recordFailure(provider, { kind: 'rateLimited', reason: 'HTTP 429', retryAfterSeconds });
        console.log(`[data-source] ${provider} rate limited (429)${retryAfterSeconds != null ? ` -- Retry-After ${retryAfterSeconds}s` : ''}`);
      } else if (upstream.status === 401 || upstream.status === 403) {
        dataSourceHealth.recordFailure(provider, { kind: 'authFailed', reason: `HTTP ${upstream.status}` });
        console.log(`[data-source] ${provider} auth failure (HTTP ${upstream.status})`);
      } else if (upstream.status >= 500) {
        dataSourceHealth.recordFailure(provider, { kind: 'temporarilyUnavailable', reason: `HTTP ${upstream.status}` });
        console.log(`[data-source] ${provider} upstream error (HTTP ${upstream.status})`);
      } else if (upstream.status >= 200 && upstream.status < 300) {
        const wasDown = dataSourceHealth.getHealth(provider).status !== 'healthy';
        dataSourceHealth.recordSuccess(provider);
        if (wasDown) console.log(`[data-source] ${provider} recovered`);
      }
      // Other 4xx (400/404/etc.) are request-shape problems, not provider
      // health -- pass the response through without touching health state.

      extraPassthroughHeaders.forEach(h => {
        const v = upstream.headers.get(h);
        if (v != null) res.set(h, v);
      });
      res.status(upstream.status)
        .type(upstream.headers.get('content-type') || 'application/json')
        .send(body);
    } catch (err) {
      const kind = /timeout|abort/i.test(err.message) ? 'timeout' : 'temporarilyUnavailable';
      dataSourceHealth.recordFailure(provider, { kind, reason: err.message });
      console.log(`[data-source] ${provider} unreachable (${kind}: ${err.message})`);
      res.status(502).json({ error: `${provider} unreachable: ` + err.message });
    }
  };
}

// Cached, coalescing passthrough for ParlayAPI ONLY (PropLine keeps using
// the plain makePassthrough above, completely unchanged). A separate
// function rather than a cache-aware branch inside makePassthrough, so
// PropLine's request/response path is provably byte-for-byte identical to
// before -- no shared code path that a ParlayAPI-focused change could
// accidentally alter.
//
// Request flow: cache hit -> return immediately, no upstream call, no
// health-check. In-flight hit (a request for the identical key already
// underway) -> await and share that SAME promise -- "coalescing": 100
// browser tabs asking for the same board within the same moment produce
// ONE upstream ParlayAPI call, not 100. Otherwise -> the normal
// eligibility check + upstream fetch + health tracking (identical logic to
// makePassthrough), then the successful result is cached for the next
// caller and this in-flight entry is cleared.
//
// Only successful (2xx) responses are cached -- a 429/503/502/etc. must
// never be served to a later caller as if it were a valid cached board.
function makeCachedParlayPassthrough(provider, host, extraPassthroughHeaders = []) {
  return async (req, res) => {
    const upstreamPath = req.params[0];
    if (!upstreamPath || upstreamPath.includes('..')) {
      return res.status(400).json({ error: 'bad path' });
    }

    const cacheKey = parlayCache.cacheKeyFor(upstreamPath, req.query);

    const sendResult = (result, cacheHeader) => {
      extraPassthroughHeaders.forEach(h => {
        if (result.headers && result.headers[h] != null) res.set(h, result.headers[h]);
      });
      res.set('x-cache', cacheHeader);
      return res.status(result.status).type(result.contentType || 'application/json').send(result.body);
    };

    const hit = parlayCache.get(cacheKey);
    if (hit) return sendResult(hit, 'HIT');

    const existing = parlayCache.getInFlight(cacheKey);
    if (existing) {
      parlayCache.recordCoalesced();
      try {
        const result = await existing;
        return sendResult(result, 'COALESCED');
      } catch (err) {
        return res.status(502).json({ error: `${provider} unreachable: ` + err.message });
      }
    }

    if (!dataSourceHealth.isEligible(provider)) {
      const health = dataSourceHealth.getHealth(provider);
      logOncePerMinute(provider, `[data-source] ${provider} in cooldown until ${health.cooldownUntil} -- short-circuiting without calling upstream`);
      return res.status(503).json({
        status: 'unavailable',
        reason: `${provider} is cooling down after repeated failures (${health.status})`,
        cooldownUntil: health.cooldownUntil
      });
    }

    const doFetch = (async () => {
      const qs = new URLSearchParams(req.query).toString();
      const url = `https://${host}/${upstreamPath}${qs ? '?' + qs : ''}`;
      const upstream = await fetch(url, { headers: { Accept: 'application/json' } });
      const body = await upstream.text();

      if (upstream.status === 429) {
        const retryAfterSeconds = parseRetryAfterSeconds(upstream.headers.get('retry-after'));
        dataSourceHealth.recordFailure(provider, { kind: 'rateLimited', reason: 'HTTP 429', retryAfterSeconds });
        console.log(`[data-source] ${provider} rate limited (429)${retryAfterSeconds != null ? ` -- Retry-After ${retryAfterSeconds}s` : ''}`);
      } else if (upstream.status === 401 || upstream.status === 403) {
        dataSourceHealth.recordFailure(provider, { kind: 'authFailed', reason: `HTTP ${upstream.status}` });
        console.log(`[data-source] ${provider} auth failure (HTTP ${upstream.status})`);
      } else if (upstream.status >= 500) {
        dataSourceHealth.recordFailure(provider, { kind: 'temporarilyUnavailable', reason: `HTTP ${upstream.status}` });
        console.log(`[data-source] ${provider} upstream error (HTTP ${upstream.status})`);
      } else if (upstream.status >= 200 && upstream.status < 300) {
        const wasDown = dataSourceHealth.getHealth(provider).status !== 'healthy';
        dataSourceHealth.recordSuccess(provider);
        if (wasDown) console.log(`[data-source] ${provider} recovered`);
      }

      const headers = {};
      extraPassthroughHeaders.forEach(h => {
        const v = upstream.headers.get(h);
        if (v != null) headers[h] = v;
      });
      const result = { status: upstream.status, contentType: upstream.headers.get('content-type') || 'application/json', body, headers };
      if (upstream.status >= 200 && upstream.status < 300) {
        parlayCache.set(cacheKey, result);
        // Phase 2I-I: archive real WNBA observations from this SAME
        // upstream fetch -- fires only for provider='parlayapi' requests to
        // the WNBA props path, costs no additional upstream call (this
        // response already happened), and never blocks or affects the
        // response being sent to the real caller. Fire-and-forget: a
        // failure here must never turn a good 200 into an error for the
        // actual user, so it's caught and logged, never thrown.
        // Phase 2I-Q: same fire-and-forget archiving, extended to NBA --
        // both calls are no-ops for any path that doesn't match their own
        // sport, so this line costs nothing on every other sport's traffic.
        if (provider === 'parlayapi') {
          wnbaProviderLineArchive.archiveFromRawParlayResponse(upstreamPath, body)
            .catch(e => console.warn('[wnba-archive] failed to archive this refresh:', e.message));
          nbaProviderLineArchive.archiveFromRawParlayResponse(upstreamPath, body)
            .catch(e => console.warn('[nba-archive] failed to archive this refresh:', e.message));
        }
      }
      return result;
    })();

    parlayCache.setInFlight(cacheKey, doFetch);

    try {
      const result = await doFetch;
      return sendResult(result, 'MISS');
    } catch (err) {
      const kind = /timeout|abort/i.test(err.message) ? 'timeout' : 'temporarilyUnavailable';
      dataSourceHealth.recordFailure(provider, { kind, reason: err.message });
      console.log(`[data-source] ${provider} unreachable (${kind}: ${err.message})`);
      return res.status(502).json({ error: `${provider} unreachable: ` + err.message });
    }
  };
}

// PropLine passthrough — api.prop-line.com sends no CORS headers, so a
// static browser app (BeatsEdge.html) can't call it directly. The caller
// supplies its own PropLine apiKey as a query param (same trust model as
// every other key BeatsEdge.html holds). No key is stored here.
//
//   GET /api/propline/v1/sports/baseball_mlb/events?apiKey=...
//   GET /api/propline/v1/sports/baseball_mlb/events/:id/odds?apiKey=...&markets=...&bookmakers=...
//
// Only GET, only the prop-line.com host, query string forwarded verbatim.
// Note: as of this writing nothing in BeatsEdge.html actually calls this
// route anymore (ParlayAPI replaced it as the live line source for every
// sport) -- kept working/health-tracked in case that changes, not removed.
router.get('/propline/*', makePassthrough('propline', 'api.prop-line.com'));

// ParlayAPI passthrough — parlay-api.com also sends no CORS headers. Same
// thin, read-only, GET-only forwarder as PropLine. The caller passes its
// own ParlayAPI key as the `apiKey` query param (parlay-api.com accepts
// it as a TOA-compatible alternative to the X-API-Key header). No key
// stored here.
//
//   GET /api/parlayapi/v1/sports/baseball_mlb/props?apiKey=...&bookmakers=prizepicks,underdog
//   GET /api/parlayapi/v1/sports?apiKey=...
//
// Pagination metadata ParlayAPI reports via response headers (offset-based:
// x-next-offset to advance, x-result-has-more to know when to stop, and
// x-result-truncated when its own internal per-source row cap was hit and
// pagination can't recover the rest) is forwarded through unchanged.
// Safe upstream metadata only -- NEVER the apiKey (that's a query param on
// the request, never an upstream response header, so it can't leak here
// regardless). Credit/rate-limit/request-id headers added so the frontend
// can actually see real credit cost and pagination state instead of only
// the pagination subset this list used to carry — must stay in sync with
// server.js's cors() exposedHeaders list (same header names, lowercase
// here since upstream.headers.get() is case-insensitive either way).
const PARLAYAPI_PASSTHROUGH_HEADERS = [
  'x-result-has-more', 'x-next-offset', 'x-result-truncated', 'x-result-truncated-hint', 'x-result-row-count',
  'x-result-degraded', 'x-credits-cost', 'x-credits-remaining', 'x-rate-limit-remaining', 'x-rate-limit-reset',
  'x-request-id', 'retry-after'
];
router.get('/parlayapi/*', makeCachedParlayPassthrough('parlayapi', 'parlay-api.com', PARLAYAPI_PASSTHROUGH_HEADERS));

// GET /api/data-sources/health — safe operational metadata only (status,
// timestamps, cooldown) for every provider this backend proxies and can
// therefore actually observe. NEVER includes API keys/tokens/auth headers
// -- dataSourceHealth.js never receives them in the first place. ESPN,
// the MLB Stats API, and BallDontLie are fetched directly by the browser
// (not proxied here), so this backend has no visibility into their health
// -- listed with serverObserved:false rather than guessed at.
router.get('/data-sources/health', (req, res) => {
  res.json({
    providers: dataSourceHealth.getAllHealth(['parlayapi', 'propline']),
    // Server-side cache/coalescing stats for the ParlayAPI passthrough only
    // (see lib/parlayCache.js) -- counts only, never the cached response
    // bodies or any API key. hitRate is null until at least one request has
    // been served (avoids a misleading 0% on a freshly-started process).
    parlayApiCache: parlayCache.stats(),
    notServerObserved: [
      { provider: 'espn', note: 'fetched directly by the browser, not proxied through this backend' },
      { provider: 'mlbstatsapi', note: 'fetched directly by the browser, not proxied through this backend' },
      { provider: 'balldontlie', note: 'fetched directly by the browser, not proxied through this backend' }
    ]
  });
});

// ── Prop snapshots ─────────────────────────────────────────────────────
// The client pushes the full picture behind every prop it grades (inputs +
// factor values + data-quality + model outputs) each slate. Stored in its
// own SQLite file so it accumulates across sessions and deploys. A
// results-join job fills in `actual` / `result` later.

// POST /api/snapshots  { date, sport, rows: [...] }
router.post('/snapshots', async (req, res) => {
  const { date, sport, rows } = req.body || {};
  if (!date || !sport || !Array.isArray(rows)) {
    return res.status(400).json({ error: 'need { date, sport, rows: [] }' });
  }
  if (rows.length > 20000) {
    return res.status(413).json({ error: 'too many rows in one post (max 20000)' });
  }
  try {
    const { written } = await saveSnapshots(date, sport, rows);
    res.json({ ok: true, written, ...(await snapshotSummary()) });
  } catch (err) {
    res.status(500).json({ error: 'snapshot save failed: ' + err.message });
  }
});

// GET /api/snapshots/summary — counts, for the panel
router.get('/snapshots/summary', async (req, res) => {
  try { res.json(await snapshotSummary()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/snapshots/settle — run the results-join now (also on a nightly cron)
let _settling = false;
router.post('/snapshots/settle', async (req, res) => {
  if (_settling) return res.status(409).json({ error: 'a settle pass is already running' });
  _settling = true;
  try {
    const out = await runSettleSnapshots({ minAgeDays: Math.max(1, Number(req.query.minAgeDays) || 1) });
    res.json({ ok: true, ...out, ...(await snapshotSummary()) });
  } catch (err) {
    res.status(500).json({ error: 'settle failed: ' + err.message });
  } finally { _settling = false; }
});

// GET /api/snapshots?since=YYYY-MM-DD&sport=mlb&limit=N — full export
router.get('/snapshots', async (req, res) => {
  try {
    const out = await getSnapshots({ since: req.query.since, sport: req.query.sport, limit: req.query.limit });
    res.json({ count: out.length, rows: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── News (Phase 1 — feed foundation only) ──────────────────────────────
// GET /api/news?sport=nba&limit=50
//
// Lazily refreshes from the real sources (ESPN + verified RSS outlets, see
// lib/newsIngest.js) at most once per NEWS_STALE_MS per sport, then serves
// from lib/newsDb.js's SQLite cache. This is a per-request freshness check,
// NOT a standing interval/cron — nothing polls in the background, and
// nothing here runs on every request once a sport is fresh, so it can't
// interfere with the existing sports-data ingestion pipelines. In-flight
// requests for the same sport share one ingest instead of firing twice.
const NEWS_STALE_MS = 5 * 60 * 1000;
const _newsIngestState = {}; // sport -> { lastAttempt, inFlight }

async function ensureNewsFresh(sport) {
  const sportsToCheck = sport ? [sport] : Object.keys(newsIngest.ESPN_NEWS_SPORT_PATHS);
  const now = Date.now();
  const reports = [];
  for (const s of sportsToCheck) {
    const st = _newsIngestState[s] || (_newsIngestState[s] = {});
    if (st.inFlight) { reports.push(await st.inFlight); continue; }
    if (st.lastAttempt && (now - st.lastAttempt) < NEWS_STALE_MS) continue; // already fresh, skip re-fetching
    st.lastAttempt = now;
    st.inFlight = newsIngest.ingestSport(s)
      .catch(e => ({ sport: s, error: e.message }))
      .finally(() => { st.inFlight = null; });
    reports.push(await st.inFlight);
  }
  return reports;
}

router.get('/news', async (req, res) => {
  const sport = req.query.sport ? String(req.query.sport).toLowerCase() : null;
  if (sport && !newsIngest.ESPN_NEWS_SPORT_PATHS[sport]) {
    return res.status(400).json({ error: `unsupported sport "${sport}"`, supportedSports: Object.keys(newsIngest.ESPN_NEWS_SPORT_PATHS) });
  }
  let ingestReports = [];
  try {
    ingestReports = await ensureNewsFresh(sport);
  } catch (e) {
    ingestReports = [{ error: e.message }];
  }
  let articles;
  try {
    articles = newsDb.getArticles({ sport, limit: req.query.limit });
  } catch (e) {
    return res.status(500).json({ error: 'news storage read failed: ' + e.message });
  }
  // Phase 2C — source-grounded classification, computed at read time (see
  // lib/newsClassifier.js's header for why: cheap, deterministic, and a
  // rule change applies retroactively with no migration/backfill). Purely
  // additive: every existing field on `articles[i]` is untouched, this
  // only attaches a new `classifications` array. An article with no
  // resolved playerId always gets classifications: [] (Step 11).
  articles = articles.map(a => ({ ...a, ...newsClassifier.classifyArticle(a) }));
  // Phase 2D — research-only impact signals derived from the Phase 2C
  // classifications just attached above (see lib/newsImpact.js's header:
  // same read-time-computation rationale as Phase 2C). Purely additive: a
  // new `impactSignals` array, nothing else on `articles[i]` changes.
  // Never touches the model — no probability/projection/edge/grade/Prime
  // field is read or written here.
  articles = articles.map(a => ({ ...a, ...newsImpact.computeArticleImpact(a) }));
  // Distinguish genuinely-empty from source-failed rather than always
  // saying "ok" — a real, currently-quiet news day looks identical to a
  // dead source unless this pass's own ingest reports are consulted.
  const thisPassFailed = ingestReports.length > 0 && ingestReports.every(r =>
    r && (r.error || (Array.isArray(r.sourceReports) && r.sourceReports.every(sr => !sr.ok)))
  );
  const status = articles.length ? 'ok' : (thisPassFailed ? 'source_unavailable' : 'empty');
  res.json({ status, sport: sport || 'all', count: articles.length, articles, ingest: ingestReports });
});

module.exports = router;
