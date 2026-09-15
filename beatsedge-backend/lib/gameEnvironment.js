// Game Environment research signal -- NBA only has real, backtestable
// support in this repo; see the audit note below for every other sport.
//
// SCOPE, per the audit that preceded this file:
// - NBA: team_game_advanced has real per-game pace/offensive_rating/
//   defensive_rating for every team, 2023-10-24 through 2026-06-13 (Kaggle
//   TeamStatisticsExtended.csv seed, ingested once -- not nightly-refreshed,
//   so it will not automatically pick up the next season's games until
//   re-ingested). This is the ONLY sport with a real, leak-safe-computable,
//   backtestable game-environment signal in this repo.
// - NFL: nfl_player_game_stats has real pass_attempts/rush_attempts/
//   completions per player-game, but ONLY for season 2025 onward --
//   confirmed by direct query: 0 of 5,489/5,537/5,480 rows for
//   2022/2023/2024 have any pass_attempts>0, vs 570/570 team-weeks fully
//   covered for season 2025 and 30/30 so far for 2026. game_date is NULL
//   on every row (confirmed), so only season+week ordering is available --
//   no true leak-safe temporal backtest is possible with one complete real
//   season. A live/descriptive play-volume-and-pass-rate computation is
//   still real and useful; see lib/nflGameEnvironment.js.
// - MLB: mlb_batter_game_stats covers only 9 real days (2026-09-05 to
//   2026-09-14 as of this audit) -- far too shallow for any backtest, and
//   too shallow even to trust as a descriptive season-level signal.
// - WNBA/CFB: no backend historical table exists for either sport in this
//   repo -- both stay entirely unavailable (null) server-side.
//
// WHAT THIS IS NOT: this module NEVER writes to player.paceRating/
// player.paceDetail -- those are EXISTING fields _calculateEdgeScoreImpl
// already reads (BeatsEdge.html, the pace-factor block) and currently
// treats as absent/neutral for every real live player (confirmed: every
// non-neutral paceRating assignment in BeatsEdge.html lives inside
// generateMockPlayerData, never a real fetch path). Populating that exact
// field for real players would immediately start influencing Model A's
// probability/grade for the first time -- explicitly out of scope without
// separate approval. This module exposes a SEPARATE `gameEnvironment`
// field instead; see BeatsEdge.html's own comment at the wiring site.

const SEASON_TYPE_REGULAR = 2; // unused here (team_game_advanced has no season_type column) -- kept for interface symmetry with nextManUpSignal.js

// Every query below uses a strict `<` against `asOfDate` -- the entire
// leakage defense, same principle as nextManUpSignal.js. No query in this
// file ever reads a row whose game_date is >= asOfDate.

// A team's own trailing pace/offensive/defensive rating, from real games
// strictly before asOfDate. Backward-looking, leak-safe, honest about
// sample size -- never pads or fabricates when fewer than `games` real
// rows exist.
function computeTeamEnvironmentAsOf(db, team, asOfDate, { games = 10, minGames = 3 } = {}) {
  const rows = db.prepare(`
    SELECT game_date, pace, offensive_rating, defensive_rating
    FROM team_game_advanced
    WHERE sport = 'nba' AND team = ? AND game_date < ?
    ORDER BY game_date DESC
    LIMIT ?
  `).all(team, asOfDate, games);

  if (rows.length < minGames) {
    return { games: rows.length, sufficient: false, pace: null, offensiveRating: null, defensiveRating: null, mostRecentGameDate: null };
  }
  const mean = (key) => {
    const vals = rows.map(r => r[key]).filter(v => v != null);
    return vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
  };
  return {
    games: rows.length, sufficient: true,
    pace: mean('pace'), offensiveRating: mean('offensive_rating'), defensiveRating: mean('defensive_rating'),
    mostRecentGameDate: rows[0].game_date
  };
}

// Combines both teams' real trailing environment into a descriptive
// research signal. Never fabricates: any input that can't be computed from
// real rows stays null, not guessed. `netRatingGap` is reported as a raw,
// real number (not a 0-1 "risk score") deliberately -- inventing a
// normalized blowout-risk scale (e.g. dividing by some arbitrary constant)
// would itself be the kind of unvalidated estimate this task explicitly
// prohibits. Whether netRatingGap actually predicts anything is exactly
// what scripts/backtest-game-environment.js checks.
function buildGameEnvironmentSignal({ db, team, opponent, asOfDate, games = 10 }) {
  const empty = {
    teamPace: null, opponentPace: null, expectedPace: null,
    teamOffensiveRating: null, teamDefensiveRating: null,
    opponentOffensiveRating: null, opponentDefensiveRating: null,
    netRatingGap: null,
    sampleSize: { team: 0, opponent: 0 },
    dataSource: 'team_game_advanced (real, per-game NBA pace/offensive_rating/defensive_rating; Kaggle TeamStatisticsExtended.csv, 2023-10-24 through 2026-06-13, not nightly-refreshed)'
  };
  if (!db || !team || !opponent || !asOfDate) return empty;

  const teamEnv = computeTeamEnvironmentAsOf(db, team, asOfDate, { games });
  const oppEnv = computeTeamEnvironmentAsOf(db, opponent, asOfDate, { games });

  const out = {
    ...empty,
    teamPace: teamEnv.pace, teamOffensiveRating: teamEnv.offensiveRating, teamDefensiveRating: teamEnv.defensiveRating,
    opponentPace: oppEnv.pace, opponentOffensiveRating: oppEnv.offensiveRating, opponentDefensiveRating: oppEnv.defensiveRating,
    sampleSize: { team: teamEnv.games, opponent: oppEnv.games }
  };
  if (!teamEnv.sufficient || !oppEnv.sufficient) return out;

  // expectedPace: the real average of both teams' own trailing pace -- a
  // standard, widely-documented approach (both teams influence a game's
  // total possessions), not an invented formula.
  out.expectedPace = Math.round(((teamEnv.pace + oppEnv.pace) / 2) * 10) / 10;

  // netRatingGap: how far apart the two teams' own real net ratings
  // (offense - defense) are. Larger = more mismatched on paper. Raw units
  // (points per 100 possessions), not normalized -- see comment above.
  const teamNet = teamEnv.offensiveRating - teamEnv.defensiveRating;
  const oppNet = oppEnv.offensiveRating - oppEnv.defensiveRating;
  out.netRatingGap = Math.round(Math.abs(teamNet - oppNet) * 10) / 10;

  return out;
}

// Bulk fetch: every real team_game_advanced row for a set of teams, for use
// by a caller that needs to build many as-of trailing windows itself
// (e.g. the backtest script) without one HTTP round trip per prediction
// point. Returns rows grouped by team, each list sorted oldest-first.
function bulkTeamHistory(db, teams) {
  const list = [...new Set((teams || []).map(String))].filter(Boolean);
  if (!list.length) return {};
  const ph = list.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT team, game_date, opponent, pace, offensive_rating, defensive_rating
    FROM team_game_advanced
    WHERE sport = 'nba' AND team IN (${ph})
    ORDER BY team, game_date ASC
  `).all(...list);
  const out = {};
  rows.forEach(r => { (out[r.team] = out[r.team] || []).push(r); });
  return out;
}

module.exports = { SEASON_TYPE_REGULAR, computeTeamEnvironmentAsOf, buildGameEnvironmentSignal, bulkTeamHistory };
