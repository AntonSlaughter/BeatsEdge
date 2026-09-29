// Player Availability & Game-Day Role research signal -- NBA only, and
// deliberately NARROWER than the full field list a naive reading of
// "availability" might suggest. See the audit note below for exactly why.
//
// AUDIT SUMMARY (performed before writing this file):
// - No table in this repo -- NBA or any other sport -- archives a
//   historical qualitative injury-status label (OUT/QUESTIONABLE/PROBABLE/
//   DOUBTFUL). That vocabulary exists ONLY in BeatsEdge.html's live ESPN
//   injury fetch (fetchLiveInjuries), which is ephemeral (never persisted
//   to a database) and ISO-timestamped in the browser at fetch time. So a
//   historical backtest CANNOT reconstruct "this player was QUESTIONABLE
//   before this specific past game" -- there is nothing to query. Any
//   attempt to infer it (e.g. from low minutes, from a missed game, from
//   a suspiciously short box score line) would be exactly the fabrication
//   this task explicitly prohibits.
// - What IS real and reconstructable from nba_player_box (573k+ rows,
//   2009-2026, real `starter`/`minutes`/`played` columns): whether a
//   player played at all (played=1/0), their own minutes in a game, and
//   whether they started. That supports three real, honest features this
//   module builds: (1) the player's own trailing minutes/starter-rate
//   (reusing lib/nextManUpSignal.js's computeRoleWindow -- NOT
//   reimplemented here), (2) a role-change classification (increased/
//   decreased/unchanged/insufficient -- see classifyRoleChange, which
//   reuses the SAME threshold constants Next Man Up already uses but adds
//   the DECREASE direction, since detectRoleChange only ever flags
//   increases by design), and (3) a real "returning after an absence"
//   status, reconstructed from the player's own game log against their
//   team's actual real schedule (computeReturnStatus).
// - `minutesRestriction` has no real source anywhere in this repo, live or
//   historical -- always null. Never inferred from one low-minute game
//   (explicit instruction).
// - `availabilityStatus` (the OUT/QUESTIONABLE/PROBABLE/DOUBTFUL label) is
//   NEVER computed by this module -- it's a live-only field the CALLER
//   already owns (BeatsEdge.html's existing fetchLiveInjuries), not
//   something reconstructable from nba_player_box. This module leaves it
//   null and documents why rather than guessing.
// - `starterStatus` for the TARGET game (not a trailing window) is
//   supplied by the CALLER, since only the caller knows whether it's
//   asking about a live upcoming game (no source exists -- confirmed no
//   live NBA starting-lineup feed anywhere in this repo, unlike MLB which
//   has real confirmed lineups) or a historical backtest game (where the
//   completed box score's own `starter` field is the real, if post-hoc,
//   record -- treated as a pregame-knowable fact per real NBA convention,
//   since starting lineups are announced well before tip-off in practice;
//   this is a documented modeling assumption, not a leakage-free
//   guarantee, and is disclosed as such everywhere this module is used).
//
// SEPARATE FROM NEXT MAN UP (do not collapse): Next Man Up asks "is a
// TEAMMATE absent, and did that redistribute opportunity to this
// candidate?" This module asks "what is THIS player's own availability/
// role situation?" They can be combined by a caller (e.g. the backtest
// script cross-tabs both), but this file does not import or duplicate
// buildNextManUpSignal/findAbsentRotationPlayers logic for that purpose.

const {
  SEASON_TYPE_REGULAR, EXHIBITION_OPP, computeRoleWindow, computeRoleWindowFromRows,
  ROLE_CHANGE_MIN_ABS_MINUTES, ROLE_CHANGE_MIN_REL_PCT,
  ROLE_CHANGE_MIN_BASELINE_GAMES, ROLE_CHANGE_MIN_RECENT_GAMES,
} = require('./nextManUpSignal');
// NOTE: lib/historicalQueries.js (and getPlayerGameHistories specifically)
// is required LAZILY inside buildAvailabilityRoleSignalsBulk/
// getTeamSchedulesBulk below, not here at module load time -- see
// lib/nextManUpSignal.js's matching comment for why (loading node:sqlite
// in the same process as better-sqlite3 crashes the native addon on this
// machine).

const NOT_EXHIB_CLAUSE = `opponent NOT IN (${EXHIBITION_OPP.map(() => '?').join(',')})`;

// Real, distinct team games (from any player's row on that team) strictly
// before asOfDate -- used to reconstruct the team's actual schedule so
// computeReturnStatus can tell "this player missed real team games" from
// "there were no games to miss."
function computeTeamScheduleAsOf(db, team, asOfDate, { lookbackGames = 12 } = {}) {
  return db.prepare(`
    SELECT DISTINCT game_id, game_date
    FROM nba_player_box
    WHERE team = ? AND game_date < ? AND season_type = ${SEASON_TYPE_REGULAR} AND ${NOT_EXHIB_CLAUSE}
    ORDER BY game_date DESC
    LIMIT ?
  `).all(team, asOfDate, ...EXHIBITION_OPP, lookbackGames);
}

// Core, DB-agnostic version: given the team's real schedule (an array of
// {game_id, game_date}, most-recent-first, already limited to lookbackGames
// -- from EITHER computeTeamScheduleAsOf's single-team query or the bulk
// getTeamSchedulesBulk fetch below) and this player's OWN full row history
// (any shape carrying game_id/played -- both the legacy per-player query
// and historicalQueries.getPlayerGameHistories's bulk rows satisfy this),
// computes the same real "returning after an absence" status. Used by BOTH
// the legacy per-player path and the bulk production path so the logic
// itself can never diverge between them.
function computeReturnStatusFromRows(teamGames, ownRows, { minEstablishedGames = 5 } = {}) {
  if (teamGames.length < 3) return { status: 'insufficient_history', gamesSinceReturn: null, consecutiveGamesMissed: null, evidenceGames: teamGames.length };

  const playedSet = new Set((ownRows || []).filter(r => r.played === 1).map(r => r.game_id));

  let idx = 0, consecutivePlayed = 0;
  while (idx < teamGames.length && playedSet.has(teamGames[idx].game_id)) { consecutivePlayed++; idx++; }

  if (idx === 0) {
    // Missed the most recent team game. Did they play at all further back
    // in the lookback window? If so, THIS target game is their real,
    // reconstructed return game.
    let consecutiveMissed = 0;
    while (idx < teamGames.length && !playedSet.has(teamGames[idx].game_id)) { consecutiveMissed++; idx++; }
    if (idx >= teamGames.length) return { status: 'insufficient_history', gamesSinceReturn: null, consecutiveGamesMissed: consecutiveMissed, evidenceGames: teamGames.length };
    return { status: 'returning_after_absence', gamesSinceReturn: 0, consecutiveGamesMissed: consecutiveMissed, evidenceGames: teamGames.length };
  }

  if (idx < teamGames.length && !playedSet.has(teamGames[idx].game_id)) {
    // A real streak of played games, immediately preceded by a real miss --
    // still within the "recently returned" window (gamesSinceReturn = how
    // many games they've already played since coming back).
    return { status: 'returning_after_absence', gamesSinceReturn: consecutivePlayed, consecutiveGamesMissed: null, evidenceGames: teamGames.length };
  }

  if (consecutivePlayed < minEstablishedGames) return { status: 'insufficient_history', gamesSinceReturn: null, consecutiveGamesMissed: 0, evidenceGames: teamGames.length };
  return { status: 'established', gamesSinceReturn: null, consecutiveGamesMissed: 0, evidenceGames: teamGames.length };
}

// Legacy single-player, per-call-query path -- kept for local-development/
// offline-script/test-fixture use (scripts/test-player-availability.js). No
// longer called by any LIVE production route as of Phase 4. Implemented in
// terms of computeReturnStatusFromRows so the math can never drift between
// the two paths.
function computeReturnStatus(db, athleteId, team, asOfDate, { lookbackGames = 12, minEstablishedGames = 5 } = {}) {
  const teamGames = computeTeamScheduleAsOf(db, team, asOfDate, { lookbackGames });
  const ownRows = db.prepare(`SELECT game_id, played FROM nba_player_box WHERE athlete_id = ?`).all(athleteId);
  return computeReturnStatusFromRows(teamGames, ownRows, { minEstablishedGames });
}

// Symmetric extension of Next Man Up's own role-change thresholds to also
// classify DECREASES -- detectRoleChange (lib/nextManUpSignal.js, frozen,
// NOT modified here) only ever flags increases by design, since its job is
// "did opportunity go up." Phase 5 needs both directions, so this reuses
// the exact same threshold CONSTANTS (imported, not redefined) rather than
// inventing new ones.
function classifyRoleChange(baseline, recent) {
  if (!baseline || !baseline.sufficient || baseline.games < ROLE_CHANGE_MIN_BASELINE_GAMES) return 'insufficient_evidence';
  if (!recent || !recent.sufficient || recent.games < ROLE_CHANGE_MIN_RECENT_GAMES) return 'insufficient_evidence';
  const minutesDelta = recent.avgMinutes - baseline.avgMinutes;
  const minutesDeltaPct = baseline.avgMinutes > 0 ? minutesDelta / baseline.avgMinutes : null;
  if (minutesDelta >= ROLE_CHANGE_MIN_ABS_MINUTES && (minutesDeltaPct == null || minutesDeltaPct >= ROLE_CHANGE_MIN_REL_PCT)) return 'increased';
  if (minutesDelta <= -ROLE_CHANGE_MIN_ABS_MINUTES && (minutesDeltaPct == null || minutesDeltaPct <= -ROLE_CHANGE_MIN_REL_PCT)) return 'decreased';
  return 'unchanged';
}

const DATA_SOURCE_LABEL = 'nba_player_box (real box scores); starterStatus reflects the TARGET game when supplied by the caller; availabilityStatus/minutesRestriction have no reconstructable historical source and are always null';

// Combines everything above into the requested output shape. Fields with
// no real, reconstructable source (minutesRestriction, availabilityStatus)
// are always null, documented, never guessed.
//
// `getWindow(athleteId, opts)` / `getReturnStatus()` abstract away HOW the
// underlying windows/return-status are fetched -- per-call SQL (legacy) or
// an in-memory lookup against pre-fetched bulk data (the live production
// path, see buildAvailabilityRoleSignalsBulk below). The actual signal-
// building logic lives here ONCE.
//
// `targetGameStarter`: 1 (started), 0 (bench), or null/undefined (unknown)
// -- supplied by the CALLER for the SPECIFIC game being evaluated. See the
// file header for why this module never looks this up itself.
function buildAvailabilityRoleSignalCore(getWindow, getReturnStatus, { athleteId, team, asOfDate, targetGameStarter = null }) {
  const empty = {
    starterStatus: 'unknown', roleChange: 'insufficient_evidence',
    returningFromAbsence: false, returnStatus: 'insufficient_history', gamesSinceReturn: null,
    minutesTrend: { l3: null, l5: null, l10: null },
    minutesRestriction: null, availabilityStatus: null,
    sampleSize: { baselineGames: 0, recentGames: 0, l3Games: 0, l5Games: 0, l10Games: 0 },
    dataSource: DATA_SOURCE_LABEL,
  };
  if (!athleteId || !asOfDate) return empty;

  const baseline = getWindow(athleteId, { games: 15, minGames: ROLE_CHANGE_MIN_BASELINE_GAMES });
  const recent = getWindow(athleteId, { games: ROLE_CHANGE_MIN_RECENT_GAMES + 2, minGames: ROLE_CHANGE_MIN_RECENT_GAMES });
  const l3 = getWindow(athleteId, { games: 3, minGames: 1 });
  const l5 = getWindow(athleteId, { games: 5, minGames: 1 });
  const l10 = getWindow(athleteId, { games: 10, minGames: 1 });
  const returnStatus = team ? getReturnStatus() : { status: 'insufficient_history', gamesSinceReturn: null };

  let starterStatus = 'unknown';
  if (targetGameStarter === 1) starterStatus = 'starter';
  else if (targetGameStarter === 0) starterStatus = 'bench';

  return {
    starterStatus,
    roleChange: classifyRoleChange(baseline, recent),
    returningFromAbsence: returnStatus.status === 'returning_after_absence',
    returnStatus: returnStatus.status,
    gamesSinceReturn: returnStatus.gamesSinceReturn,
    minutesTrend: {
      l3: l3.sufficient ? Math.round(l3.avgMinutes * 10) / 10 : null,
      l5: l5.sufficient ? Math.round(l5.avgMinutes * 10) / 10 : null,
      l10: l10.sufficient ? Math.round(l10.avgMinutes * 10) / 10 : null,
    },
    minutesRestriction: null, // no real source anywhere in this repo -- never inferred from low minutes
    availabilityStatus: null, // live-only (ESPN), never archived -- never reconstructed here
    sampleSize: { baselineGames: baseline.games, recentGames: recent.games, l3Games: l3.games, l5Games: l5.games, l10Games: l10.games },
    dataSource: DATA_SOURCE_LABEL,
  };
}

// Legacy single-player, per-call-query path -- kept for local-development/
// offline-script/test-fixture use (scripts/test-player-availability.js). No
// longer called by any LIVE production route as of Phase 4.
function buildAvailabilityRoleSignal({ db, athleteId, team, asOfDate, targetGameStarter = null }) {
  if (!db || !athleteId || !asOfDate) {
    return {
      starterStatus: 'unknown', roleChange: 'insufficient_evidence',
      returningFromAbsence: false, returnStatus: 'insufficient_history', gamesSinceReturn: null,
      minutesTrend: { l3: null, l5: null, l10: null },
      minutesRestriction: null, availabilityStatus: null,
      sampleSize: { baselineGames: 0, recentGames: 0, l3Games: 0, l5Games: 0, l10Games: 0 },
      dataSource: DATA_SOURCE_LABEL,
    };
  }
  const getWindow = (id, opts) => computeRoleWindow(db, id, asOfDate, opts);
  const getReturnStatus = () => computeReturnStatus(db, athleteId, team, asOfDate);
  return buildAvailabilityRoleSignalCore(getWindow, getReturnStatus, { athleteId, team, asOfDate, targetGameStarter });
}

// ---------- LIVE production path (Phase 4): bulk, historicalStore-backed ----------
//
// Bulk-fetches, for the WHOLE request: (a) every requested athlete's own
// full row history (ONE query, reused for baseline/recent/l3/l5/l10 AND for
// this player's own played-game-id set that computeReturnStatusFromRows
// needs -- no separate per-player "did they play in these team games?"
// query required), and (b) every referenced team's real schedule (ONE
// query, grouped/sorted/sliced to lookbackGames in memory). A 500-player
// request that used to issue up to 7 queries per player (baseline, recent,
// l3, l5, l10, team schedule, played-rows) now issues exactly 2, total.
async function getTeamSchedulesBulk(teams, beforeDate, { lookbackGames = 12 } = {}) {
  const store = require('./historicalStore');
  const list = [...new Set((teams || []).filter(Boolean))];
  if (!list.length || !beforeDate) return new Map();
  const ph = list.map(() => '?').join(',');
  const rows = await store.query(`
    SELECT team, game_id, game_date FROM nba_player_box
    WHERE team IN (${ph}) AND game_date < ? AND season_type = ${SEASON_TYPE_REGULAR} AND ${NOT_EXHIB_CLAUSE}
  `, [...list, beforeDate, ...EXHIBITION_OPP]);
  const byTeam = new Map();
  const seen = new Set();
  for (const r of rows) {
    const key = r.team + '|' + r.game_id;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byTeam.has(r.team)) byTeam.set(r.team, []);
    byTeam.get(r.team).push(r);
  }
  for (const [team, games] of byTeam) {
    games.sort((a, b) => (a.game_date < b.game_date ? 1 : a.game_date > b.game_date ? -1 : 0));
    byTeam.set(team, games.slice(0, lookbackGames));
  }
  return byTeam;
}

async function buildAvailabilityRoleSignalsBulk(requests, asOfDate) {
  const { getPlayerGameHistories } = require('./historicalQueries'); // lazy -- see the NOTE near the top of this file
  const ids = [...new Set((requests || []).map(r => r && r.athleteId).filter(Boolean).map(String))];
  const teams = [...new Set((requests || []).map(r => r && r.team).filter(Boolean))];
  const [rawHistoriesMap, teamSchedules] = await Promise.all([
    ids.length ? getPlayerGameHistories('nba', ids) : Promise.resolve(new Map()),
    asOfDate ? getTeamSchedulesBulk(teams, asOfDate) : Promise.resolve(new Map()),
  ]); // 2 bulk queries total, regardless of players.length
  const historiesMap = new Map();
  for (const [k, v] of rawHistoriesMap) historiesMap.set(String(k), v);

  const signals = {};
  for (const r of (requests || [])) {
    if (!r || !r.athleteId) continue;
    const ownRows = historiesMap.get(String(r.athleteId)) || [];
    const getWindow = (id, opts) => computeRoleWindowFromRows(historiesMap.get(String(id)) || [], asOfDate, opts);
    const getReturnStatus = () => computeReturnStatusFromRows(teamSchedules.get(r.team) || [], ownRows);
    signals[r.athleteId] = buildAvailabilityRoleSignalCore(getWindow, getReturnStatus, { athleteId: r.athleteId, team: r.team, asOfDate, targetGameStarter: r.targetGameStarter });
  }
  return signals;
}

module.exports = {
  computeTeamScheduleAsOf,
  computeReturnStatus,
  computeReturnStatusFromRows,
  getTeamSchedulesBulk,
  classifyRoleChange,
  buildAvailabilityRoleSignal,
  buildAvailabilityRoleSignalsBulk,
};
