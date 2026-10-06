// Builds LIVE-SHAPED NBA model inputs from historical box-score rows, using the LIVE builders themselves
// (`nbaComputeWindows`, `nbaMinutesTrend`, `nbaProjMinutes` -- extracted verbatim from BeatsEdge.html by loadBeatsEdgeModel({ liveNba: true })).
// Historical validation and the live app therefore construct model inputs with the same code and call the same `calculateEdgeScore`.
// Nothing here re-implements a window, a factor or a formula.

const DAY = 864e5;

// DB box row -> the ESPN-gamelog row shape the live code expects (NBA_PROP_DEFS getters read these field names).
function toGlRow(m, r) {
  const row = { points: r.points, totalRebounds: r.rebounds, assists: r.assists, steals: r.steals, blocks: r.blocks, turnovers: r.turnovers, minutes: r.minutes };
  row[m.NBA_3PM] = r.threes;
  const ts = Date.parse(r.game_date + 'T12:00:00Z');
  return { eventId: String(r.game_id), ts, date: r.game_date, dateShort: r.game_date, opponent: r.opponent,
    vsLabel: (r.home_away === 'away' ? '@ ' : 'vs ') + r.opponent, season: r.season, row };
}

// ctx: { target, hist, lineFor, prevTeamDate, oppRankByAbbr?, opponentDefense?, oppRank?, id? }
// hist = the player's strictly-earlier games (ascending). prevTeamDate = the date of the player's team's previous game (as-of schedule).
function buildLiveShapedNbaPlayer(m, ctx) {
  const glRows = ctx.hist.map(r => toGlRow(m, r));
  const { statsByKey, gameLogByKey } = m.nbaComputeWindows(glRows, ctx.lineFor, ctx.target.opponent, ctx.oppRankByAbbr || null, ctx.target.season);
  const tonight = Date.parse(ctx.target.game_date + 'T12:00:00Z');
  const restDays = ctx.prevTeamDate ? Math.round((tonight - Date.parse(ctx.prevTeamDate + 'T12:00:00Z')) / DAY) : null;
  return {
    id: ctx.id || (String(ctx.target.athlete_id) + ':' + ctx.target.game_date), sport: 'nba', role: 'skill',
    position: ctx.target.pos_group, team: ctx.target.team, opponent: ctx.target.opponent, status: 'ACTIVE',
    minutesTrend: m.nbaMinutesTrend(glRows), projMin: m.nbaProjMinutes(glRows),
    oppDef: null, oppRank: ctx.oppRank != null ? ctx.oppRank : null,
    b2b: restDays != null ? { restDays, tonight: restDays <= 1 ? 'second' : null, first: null } : null,
    isBackToBackTonight: restDays != null && restDays <= 1,
    isHomeTonight: ctx.target.home_away !== 'away',
    opponentDefense: ctx.opponentDefense || null,
    statsByKey, gameLogByKey, stats: {}, gameLog: [],
  };
}

module.exports = { toGlRow, buildLiveShapedNbaPlayer };
