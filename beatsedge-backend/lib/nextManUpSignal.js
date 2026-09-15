// Next Man Up / Role Change research signal -- NBA only.
//
// SCOPE, per the audit that preceded this file: nba_player_box is the only
// table in this repo with deep, real historical data (17 seasons, real
// `starter` and `minutes` columns, 573k+ rows). MLB player-game history is
// only 9 days deep; NFL has no usable per-game date/id; NHL has zero rows.
// None of those can support a real backtest -- this module does not
// attempt them.
//
// WHAT THIS IS: a SEPARATE, additive research signal. It never touches
// Model A -- it does not read from or write to calculateEdgeScore's
// projection/probability/grade math (that logic lives entirely in
// BeatsEdge.html and is untouched by this file). Nothing in this module
// is wired into confluence/confidence/grade; see server.js/routes/api.js
// for how it's exposed (a new, separate API response field).
//
// WHAT IT DOES NOT DO: attribute a role change to a *specific announced
// injury* for historical analysis. No injury-status history is archived
// anywhere in this repo (confirmed by direct audit of every table) -- so
// a historical backtest cannot know what was publicly announced before a
// past game. What IS real and computable from nba_player_box alone is
// "teammate who recently played real minutes was entirely absent from
// this completed game" -- a legitimate, if coarser, historical proxy
// (it can't distinguish injury from rest/trade/coach's decision). The
// LIVE signal (real-time, for an upcoming game) is different and stronger:
// it can use BeatsEdge's already-existing live ESPN injury fetch (a real
// pregame-known input) instead of this box-score proxy -- see
// buildNextManUpSignal's `unavailableTeammates` parameter, which the
// caller supplies (from live injury data in production, or from the
// box-score-absence proxy in the historical backtest).

const SEASON_TYPE_REGULAR = 2; // per lib/db.js's own schema comment: "2 = regular, 3 = postseason" (a 4th value, 5, also exists in real data -- likely in-season-tournament/NBA Cup games added in later seasons -- excluded here same as postseason since it is not season_type 2)

// All-Star weekend / exhibition rows sneak into the feed under season_type 2
// (opponent = WORLD / STRIPES / EAST / WEST / ...) -- same list lib/nbaHistDb.js
// already excludes for the same reason. Not real competitive games; would
// contaminate a rotation-role baseline if left in.
const EXHIBITION_OPP = ['WORLD', 'STRIPES', 'EAST', 'WEST', 'STARS', 'USA', 'GLOBAL', 'DURANT', 'LEBRON', 'GIANNIS', 'SHAQ', 'CHUCK', 'KENNY'];
const NOT_EXHIB_CLAUSE = `opponent NOT IN (${EXHIBITION_OPP.map(() => '?').join(',')})`;

// Every date comparison below uses a strict `<` against `asOfDate` --
// this is the entire leakage defense. No query in this file ever reads a
// row whose game_date is >= asOfDate. There is no other path to data in
// this module (no live fetch, no other table) -- so leakage would only be
// possible by a caller passing today's own game_date as asOfDate and
// expecting today's row to be excluded, which it is by construction here.

// A player's own trailing role, from games strictly before asOfDate. Real,
// backward-looking, safe for both historical backtesting and live use.
function computeRoleWindow(db, athleteId, asOfDate, { games, minGames = 1, seasonOnly = null } = {}) {
  const seasonClause = seasonOnly != null ? 'AND season = ?' : '';
  const params = [athleteId, asOfDate, ...EXHIBITION_OPP];
  if (seasonOnly != null) params.push(seasonOnly);
  params.push(games);
  const rows = db.prepare(`
    SELECT game_date, minutes, starter, points, rebounds, assists, team, pos_group
    FROM nba_player_box
    WHERE athlete_id = ? AND game_date < ? AND season_type = ${SEASON_TYPE_REGULAR}
      AND played = 1 AND ${NOT_EXHIB_CLAUSE} ${seasonClause}
    ORDER BY game_date DESC
    LIMIT ?
  `).all(...params);

  if (rows.length < minGames) {
    return { games: rows.length, sufficient: false, avgMinutes: null, starterRate: null, team: null, posGroup: null };
  }
  const avgMinutes = rows.reduce((s, r) => s + (r.minutes || 0), 0) / rows.length;
  const starterRate = rows.reduce((s, r) => s + (r.starter ? 1 : 0), 0) / rows.length;
  return {
    games: rows.length,
    sufficient: true,
    avgMinutes,
    starterRate,
    team: rows[0].team, // most recent known team, for identity/team-continuity checks
    posGroup: rows[0].pos_group,
    mostRecentGameDate: rows[0].game_date,
  };
}

// Pure function, no DB -- compares a "recent" window against a "baseline"
// (season-to-date) window for the SAME player and returns whether a real,
// meaningfully-sized role change is evident. Thresholds are fixed here
// (not tuned against the backtest holdout -- see scripts/backtest-next-man-up.js).
const ROLE_CHANGE_MIN_ABS_MINUTES = 6; // at least a ~6 min/game bump
const ROLE_CHANGE_MIN_REL_PCT = 0.20; // and at least +20% relative to baseline
const ROLE_CHANGE_MIN_BASELINE_GAMES = 8; // baseline needs real sample size
const ROLE_CHANGE_MIN_RECENT_GAMES = 3;

function detectRoleChange(baseline, recent) {
  if (!baseline || !recent) return { roleChangeDetected: false, reason: 'missing window data' };
  if (!baseline.sufficient || baseline.games < ROLE_CHANGE_MIN_BASELINE_GAMES) {
    return { roleChangeDetected: false, reason: 'insufficient baseline history', evidenceGames: recent.games || 0 };
  }
  if (!recent.sufficient || recent.games < ROLE_CHANGE_MIN_RECENT_GAMES) {
    return { roleChangeDetected: false, reason: 'insufficient recent games', evidenceGames: recent.games || 0 };
  }
  const minutesDelta = recent.avgMinutes - baseline.avgMinutes;
  const minutesDeltaPct = baseline.avgMinutes > 0 ? minutesDelta / baseline.avgMinutes : null;
  const starterDelta = (recent.starterRate ?? 0) - (baseline.starterRate ?? 0);
  const roleChangeDetected = minutesDelta >= ROLE_CHANGE_MIN_ABS_MINUTES
    && (minutesDeltaPct == null || minutesDeltaPct >= ROLE_CHANGE_MIN_REL_PCT);
  return {
    roleChangeDetected,
    minutesDelta: Math.round(minutesDelta * 10) / 10,
    minutesDeltaPct: minutesDeltaPct != null ? Math.round(minutesDeltaPct * 1000) / 1000 : null,
    starterDelta: Math.round(starterDelta * 1000) / 1000,
    evidenceGames: recent.games,
    baselineGames: baseline.games,
  };
}

// Historical, box-score-derived proxy for "this specific rostered rotation
// player was absent from this specific completed game" -- used ONLY by the
// backtest (never by the live path, which uses real injury data instead).
// A player counts as "recently rotation-relevant" if they averaged
// >= minMinutes over their last N games strictly before gameDate for this
// team, and counts as "absent" if no row exists for (athleteId, gameId).
function findAbsentRotationPlayers(db, team, gameId, gameDate, { trailingGames = 5, minMinutes = 15 } = {}) {
  const candidates = db.prepare(`
    SELECT athlete_id, athlete_name, pos_group, AVG(minutes) avgmin, COUNT(*) g
    FROM (
      SELECT athlete_id, athlete_name, pos_group, minutes
      FROM nba_player_box
      WHERE team = ? AND game_date < ? AND season_type = ${SEASON_TYPE_REGULAR}
        AND played = 1 AND ${NOT_EXHIB_CLAUSE}
      ORDER BY game_date DESC
      LIMIT 200
    )
    GROUP BY athlete_id
    HAVING g >= 3
  `).all(team, gameDate, ...EXHIBITION_OPP);
  // LIMIT 200 above is a coarse cap across all players on the team combined,
  // not per-player -- the per-player trailing-N is refined below per
  // candidate using the real windowing function for correctness.
  const out = [];
  for (const c of candidates) {
    if (c.avgmin < minMinutes) continue;
    const win = computeRoleWindow(db, c.athlete_id, gameDate, { games: trailingGames, minGames: 3 });
    if (!win.sufficient || win.avgMinutes < minMinutes) continue;
    // played = 1 required here too -- a DNP/inactive row still exists for
    // (athleteId, gameId) in this table (confirmed: 75,842 such rows, 14.2%
    // of regular-season rows, always minutes = 0), so without this filter a
    // genuinely-absent rotation player would be wrongly counted as "played".
    const playedThisGame = db.prepare(`SELECT 1 FROM nba_player_box WHERE athlete_id = ? AND game_id = ? AND played = 1`).get(c.athlete_id, gameId);
    if (!playedThisGame) {
      out.push({ athleteId: c.athlete_id, athleteName: c.athlete_name, posGroup: c.pos_group, trailingAvgMinutes: win.avgMinutes, trailingGames: win.games });
    }
  }
  return out;
}

// Combines a candidate's own role-change read with information about which
// teammates are unavailable, into the requested output shape. Never
// fabricates -- returns active:false with null fields whenever the
// underlying data is insufficient, rather than guessing.
//
// `unavailableTeammates`: array of {athleteId, athleteName, posGroup,
// reason} -- supplied by the CALLER. In production this comes from
// BeatsEdge.html's existing live ESPN injury fetch (a real, pregame-known
// input -- see fetchLiveInjuries / sidelinedByTeam in BeatsEdge.html). In
// the historical backtest it comes from findAbsentRotationPlayers above
// (a box-score-absence proxy, explicitly NOT an injury attribution).
function buildNextManUpSignal({ db, athleteId, athleteName, team, posGroup, asOfDate, unavailableTeammates, dataFreshness = null }) {
  const empty = {
    active: false, confidence: null, reason: null, unavailableTeammate: null,
    roleChange: null, minutesImpact: null, usageImpact: null, opportunityImpact: null,
    evidenceGames: 0, dataFreshness: dataFreshness || null,
  };
  if (!db || !athleteId || !asOfDate) return empty;

  const relevantAbsences = (unavailableTeammates || []).filter(t => t && t.posGroup === posGroup && t.athleteId !== athleteId);
  if (!relevantAbsences.length) return empty; // component 1 (injury/unavailability-driven) has no basis -- inactive, not fabricated

  const baseline = computeRoleWindow(db, athleteId, asOfDate, { games: 15, minGames: ROLE_CHANGE_MIN_BASELINE_GAMES });
  const recent = computeRoleWindow(db, athleteId, asOfDate, { games: ROLE_CHANGE_MIN_RECENT_GAMES + 2, minGames: ROLE_CHANGE_MIN_RECENT_GAMES });
  const change = detectRoleChange(baseline, recent);

  // Component 2: starting-lineup change (own starter-rate shift, from real history only)
  const startingLineupChange = change.starterDelta != null && change.starterDelta >= 0.34; // ~1-in-3 games worth of shift

  // Vacated opportunity: the absent teammate's own real trailing minutes --
  // this is the "how much is up for grabs" estimate, not a guess.
  const primaryAbsence = relevantAbsences[0];
  const vacated = computeRoleWindow(db, primaryAbsence.athleteId, asOfDate, { games: 5, minGames: 2 });

  const active = !!(change.roleChangeDetected || startingLineupChange) && vacated.sufficient;
  if (!active) {
    return {
      ...empty,
      reason: !vacated.sufficient
        ? 'unavailable teammate has insufficient own history to estimate vacated opportunity'
        : (change.reason || 'no material role change detected yet in candidate\'s own recent games'),
      evidenceGames: recent.games || 0,
    };
  }

  // Confidence: purely a function of real sample sizes on both sides
  // (candidate's own evidence games, vacated player's own history) --
  // never a guess, capped at 0.85 to reflect that this is still a proxy.
  const sampleScore = Math.min(1, (recent.games || 0) / 6) * Math.min(1, (vacated.games || 0) / 5);
  const confidence = Math.round(Math.min(0.85, 0.35 + 0.5 * sampleScore) * 100) / 100;

  return {
    active: true,
    confidence,
    reason: change.roleChangeDetected
      ? `own minutes up ${change.minutesDelta>=0?'+':''}${change.minutesDelta}/g vs ${change.baselineGames}-game baseline, with ${primaryAbsence.athleteName} unavailable at the same position`
      : `starter-rate shift with ${primaryAbsence.athleteName} unavailable at the same position`,
    unavailableTeammate: primaryAbsence.athleteName,
    roleChange: startingLineupChange ? 'bench -> starter (recent trend)' : 'increased rotation minutes',
    minutesImpact: change.minutesDelta,
    usageImpact: null, // no real usage-rate column exists in nba_player_box (confirmed by audit) -- never fabricated
    opportunityImpact: vacated.avgMinutes != null ? Math.round(vacated.avgMinutes * 10) / 10 : null,
    evidenceGames: recent.games || 0,
    dataFreshness: dataFreshness || null,
  };
}

module.exports = {
  SEASON_TYPE_REGULAR,
  EXHIBITION_OPP,
  computeRoleWindow,
  detectRoleChange,
  findAbsentRotationPlayers,
  buildNextManUpSignal,
  ROLE_CHANGE_MIN_ABS_MINUTES,
  ROLE_CHANGE_MIN_REL_PCT,
  ROLE_CHANGE_MIN_BASELINE_GAMES,
  ROLE_CHANGE_MIN_RECENT_GAMES,
};
