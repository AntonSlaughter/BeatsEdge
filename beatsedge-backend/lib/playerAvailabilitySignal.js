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
  SEASON_TYPE_REGULAR, EXHIBITION_OPP, computeRoleWindow,
  ROLE_CHANGE_MIN_ABS_MINUTES, ROLE_CHANGE_MIN_REL_PCT,
  ROLE_CHANGE_MIN_BASELINE_GAMES, ROLE_CHANGE_MIN_RECENT_GAMES,
} = require('./nextManUpSignal');

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

// Real "returning after an absence" status for THIS player, reconstructed
// from their own played/not-played record against their team's actual
// real schedule (strictly before asOfDate -- the leakage defense). Never
// guesses a reason (injury vs rest vs trade) -- only the fact of absence.
function computeReturnStatus(db, athleteId, team, asOfDate, { lookbackGames = 12, minEstablishedGames = 5 } = {}) {
  const teamGames = computeTeamScheduleAsOf(db, team, asOfDate, { lookbackGames });
  if (teamGames.length < 3) return { status: 'insufficient_history', gamesSinceReturn: null, consecutiveGamesMissed: null, evidenceGames: teamGames.length };

  const gameIds = teamGames.map(g => g.game_id);
  const placeholders = gameIds.map(() => '?').join(',');
  const playedRows = db.prepare(`SELECT game_id FROM nba_player_box WHERE athlete_id = ? AND played = 1 AND game_id IN (${placeholders})`).all(athleteId, ...gameIds);
  const playedSet = new Set(playedRows.map(r => r.game_id));

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

// Combines everything above into the requested output shape. Fields with
// no real, reconstructable source (minutesRestriction, availabilityStatus)
// are always null, documented, never guessed.
//
// `targetGameStarter`: 1 (started), 0 (bench), or null/undefined (unknown)
// -- supplied by the CALLER for the SPECIFIC game being evaluated. See the
// file header for why this module never looks this up itself.
function buildAvailabilityRoleSignal({ db, athleteId, team, asOfDate, targetGameStarter = null }) {
  const empty = {
    starterStatus: 'unknown', roleChange: 'insufficient_evidence',
    returningFromAbsence: false, returnStatus: 'insufficient_history', gamesSinceReturn: null,
    minutesTrend: { l3: null, l5: null, l10: null },
    minutesRestriction: null, availabilityStatus: null,
    sampleSize: { baselineGames: 0, recentGames: 0, l3Games: 0, l5Games: 0, l10Games: 0 },
    dataSource: 'nba_player_box (real box scores); starterStatus reflects the TARGET game when supplied by the caller; availabilityStatus/minutesRestriction have no reconstructable historical source and are always null',
  };
  if (!db || !athleteId || !asOfDate) return empty;

  const baseline = computeRoleWindow(db, athleteId, asOfDate, { games: 15, minGames: ROLE_CHANGE_MIN_BASELINE_GAMES });
  const recent = computeRoleWindow(db, athleteId, asOfDate, { games: ROLE_CHANGE_MIN_RECENT_GAMES + 2, minGames: ROLE_CHANGE_MIN_RECENT_GAMES });
  const l3 = computeRoleWindow(db, athleteId, asOfDate, { games: 3, minGames: 1 });
  const l5 = computeRoleWindow(db, athleteId, asOfDate, { games: 5, minGames: 1 });
  const l10 = computeRoleWindow(db, athleteId, asOfDate, { games: 10, minGames: 1 });
  const returnStatus = team ? computeReturnStatus(db, athleteId, team, asOfDate) : { status: 'insufficient_history', gamesSinceReturn: null };

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
    dataSource: empty.dataSource,
  };
}

module.exports = {
  computeTeamScheduleAsOf,
  computeReturnStatus,
  classifyRoleChange,
  buildAvailabilityRoleSignal,
};
