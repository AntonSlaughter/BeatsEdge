const express = require('express');
const router = express.Router();
const { fetchLeagueDefenseStats } = require('../lib/statsProxy');
const { fetchProbablePitchers } = require('../lib/mlbProxy');
const { getDefenseByPosition, getTeamAdvancedStats } = require('../lib/dvpEngine');
const { getPlayerSituationalSplits, getTeamScheduleContext } = require('../lib/situationalEngine');
const { getNflDefenseByPosition } = require('../lib/nflDvpEngine');
const mlbDb = require('../lib/mlbDb');
const { getDefenseByPosition: getNhlDefenseByPosition } = require('../lib/nhlEngine');
const nhlDb = require('../lib/nhlDb');
const db = require('../lib/db');

// GET /api/health — quick check this is alive (also what wakes a sleeping
// Render free instance, and what BeatsEdge.html can ping before relying on it)
router.get('/health', (req, res) => {
  const lastIngest = db.prepare(`SELECT * FROM ingest_log ORDER BY ran_at DESC LIMIT 1`).get();
  res.json({ ok: true, lastIngest: lastIngest || null });
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

// GET /api/nfl/defense/by-position/:team?window=season|last8|last4
router.get('/nfl/defense/by-position/:team', (req, res) => {
  const { team } = req.params;
  const windowType = req.query.window || 'season';
  const byPosition = getNflDefenseByPosition(team.toUpperCase(), windowType);
  if (Object.keys(byPosition).length === 0) {
    return res.status(404).json({ error: `No computed NFL data for ${team}` });
  }
  res.json({ source: 'BeatsEdge computed (real nflverse box scores)', team: team.toUpperCase(), window: windowType, byPosition });
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
// PropLine passthrough — api.prop-line.com sends no CORS headers, so a
// static browser app (BeatsEdge.html) can't call it directly. This is a
// thin, read-only forwarder that just adds this backend's CORS. The
// caller supplies its own PropLine apiKey as a query param (same trust
// model as every other key BeatsEdge.html holds). No key is stored here.
//
//   GET /api/propline/v1/sports/baseball_mlb/events?apiKey=...
//   GET /api/propline/v1/sports/baseball_mlb/events/:id/odds?apiKey=...&markets=...&bookmakers=...
//
// Only GET, only the prop-line.com host, query string forwarded verbatim.
router.get('/propline/*', async (req, res) => {
  const upstreamPath = req.params[0];
  if (!upstreamPath || upstreamPath.includes('..')) {
    return res.status(400).json({ error: 'bad path' });
  }
  const qs = new URLSearchParams(req.query).toString();
  const url = `https://api.prop-line.com/${upstreamPath}${qs ? '?' + qs : ''}`;
  try {
    const upstream = await fetch(url, { headers: { Accept: 'application/json' } });
    const body = await upstream.text();
    res.status(upstream.status)
      .type(upstream.headers.get('content-type') || 'application/json')
      .send(body);
  } catch (err) {
    res.status(502).json({ error: 'PropLine unreachable: ' + err.message });
  }
});

module.exports = router;
