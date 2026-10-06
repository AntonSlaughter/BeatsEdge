// Materializes the NHL model (lib/nhlProjectionEngine.js + lib/nhlModel.js) into two small tables so the API never recomputes it:
//   nhl_player_projections : one row per (player, stat family) -- the opponent-INDEPENDENT value + base_lambda
//   nhl_team_context       : one row per team -- the opponent shot environment (as of the latest stored game)
// This is what fixed the original ~69s synchronous /api/nhl/player-projections timeout, and it still holds: the route is two
// plain table reads (~5k player rows + ~32 team rows) and NEVER calls the engine.
//
// This module never reimplements model arithmetic -- it persists/reads what computeAllModelOutputs() returns.

const { computeAllModelOutputs } = require('./nhlProjectionEngine');
const M = require('./nhlModel');
const store = require('./historicalStore');

const MODEL_VERSION = M.NHL_MODEL_VERSION;

const UPSERT_SQL = `
  INSERT INTO nhl_player_projections
    (player_id, stat_family, player_name, team, projection, probability, games_sampled, rest_adjusted, model_version, latest_game_date, base_lambda, calculated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(player_id, stat_family) DO UPDATE SET
    player_name = excluded.player_name, team = excluded.team,
    projection = excluded.projection, probability = excluded.probability,
    games_sampled = excluded.games_sampled, rest_adjusted = excluded.rest_adjusted,
    model_version = excluded.model_version, latest_game_date = excluded.latest_game_date,
    base_lambda = excluded.base_lambda,
    calculated_at = excluded.calculated_at
`;
const TEAM_UPSERT_SQL = `
  INSERT INTO nhl_team_context
    (team, games, latest_game_date, sa15, sf15, league_avg, league_games, allowed_ratio, offense_ratio, as_of_date, model_version, calculated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(team) DO UPDATE SET
    games = excluded.games, latest_game_date = excluded.latest_game_date, sa15 = excluded.sa15, sf15 = excluded.sf15,
    league_avg = excluded.league_avg, league_games = excluded.league_games, allowed_ratio = excluded.allowed_ratio,
    offense_ratio = excluded.offense_ratio, as_of_date = excluded.as_of_date, model_version = excluded.model_version,
    calculated_at = excluded.calculated_at
`;

function rowsFromProjections(projections) {
  const rows = [];
  for (const [statFamily, familyRows] of Object.entries(projections)) {
    for (const r of familyRows) {
      rows.push([
        r.playerId, statFamily, r.playerName || null, r.team || null,
        r.projection ?? null, r.probability ?? null, r.gamesSampled ?? null,
        r.restAdjusted ? 1 : 0, MODEL_VERSION, r.latestGameDate ?? null, r.baseLambda ?? null,
      ]);
    }
  }
  return rows;
}
function teamRowsFromContext(ctx) {
  return Object.entries(ctx.teams).map(([team, t]) => [team, t.games, t.latestGameDate, t.sa15, t.sf15, ctx.league, ctx.leagueGames, t.allowed, t.offense, ctx.asOf, MODEL_VERSION]);
}

// Databases that pre-date v2 have nhl_player_projections without base_lambda. Add it ONCE, on the write path only
// (the read path tolerates its absence, so a deploy that lands before the first v2 materialization cannot break the API).
async function ensureModelColumns() {
  const cols = (await store.query(`PRAGMA table_info(nhl_player_projections)`)).map(c => c.name);
  if (!cols.includes('base_lambda')) {
    try { await store.run(`ALTER TABLE nhl_player_projections ADD COLUMN base_lambda REAL`); }
    catch (e) { if (!/duplicate column/i.test(String(e.message))) throw e; }
  }
}

// Idempotent, safe to rerun: UPSERT on the real PRIMARY KEYs -- never duplicates, never appends, and (no DELETE step) a failure
// never blanks the previously materialized snapshot. Callers (cron, backfill script) isolate failures from whatever else they do.
async function materializeNhlProjections() {
  const { projections, opponentContext } = await computeAllModelOutputs();
  await ensureModelColumns();
  const rows = rowsFromProjections(projections);
  if (rows.length) await store.batchInsert(UPSERT_SQL, rows);
  const teamRows = teamRowsFromContext(opponentContext);
  if (teamRows.length) await store.batchInsert(TEAM_UPSERT_SQL, teamRows);
  return { rowsWritten: rows.length, teamContextRows: teamRows.length, families: Object.keys(projections), modelVersion: MODEL_VERSION };
}

// `SELECT *` on purpose: tolerant of a database whose nhl_player_projections has not been migrated yet (base_lambda absent => null).
async function getMaterializedProjections() {
  const rows = await store.query(`SELECT * FROM nhl_player_projections`);
  const out = {};
  for (const r of rows) {
    if (!out[r.stat_family]) out[r.stat_family] = [];
    out[r.stat_family].push({
      playerId: r.player_id, playerName: r.player_name, team: r.team,
      projection: r.projection, probability: r.probability,
      baseLambda: r.base_lambda ?? null,
      gamesSampled: r.games_sampled, restAdjusted: !!r.rest_adjusted,
      modelVersion: r.model_version ?? null,
    });
  }
  return out;
}

// Opponent context for the API. NEVER throws: a missing/empty/unreadable table => `null`, and clients then apply no opponent factor
// (the frozen fallback). A broken context must not take the board down.
async function getOpponentContext() {
  try {
    const rows = await store.query(`SELECT * FROM nhl_team_context`);
    if (!rows.length) return null;
    const teams = {}; let league = null, leagueGames = null, asOf = null, modelVersion = null;
    for (const r of rows) {
      teams[r.team] = { games: r.games, latestGameDate: r.latest_game_date, allowed: r.allowed_ratio ?? null, offense: r.offense_ratio ?? null };
      league = r.league_avg ?? league; leagueGames = r.league_games ?? leagueGames; asOf = r.as_of_date ?? asOf; modelVersion = r.model_version ?? modelVersion;
    }
    return { asOf, leagueAvgShotsPerTeamGame: league, leagueTeamGames: leagueGames, modelVersion, teams };
  } catch (e) { return null; }
}

function modelMetadata() {
  return { version: M.NHL_MODEL_VERSION, specSha256: M.NHL_MODEL_SPEC_SHA256, opponentAdjustment: M.opponentAdjustmentMeta() };
}

module.exports = { materializeNhlProjections, getMaterializedProjections, getOpponentContext, modelMetadata, rowsFromProjections, teamRowsFromContext, ensureModelColumns, MODEL_VERSION };
