// Phase 2I-H -- raw historical WNBA provider-line archive. Append-only:
// every genuinely new provider observation gets its own row; nothing is
// ever updated in place. Entirely separate from prop_snapshots (which
// upserts one row per day and feeds cron/settleSnapshots.js's real
// settlement path) -- this module and its table are not read by any
// grading/settlement/model code anywhere in this codebase.
//
// Uses the same backend-agnostic store (lib/snapshotStore.js) as
// lib/snapshotDb.js -- local SQLite in dev, Turso/libSQL in production --
// so a future capture cron job works unmodified in either environment.

const store = require('./snapshotStore');

const str = (x) => (x == null ? null : String(x));
const num = (x) => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
const jsonOf = (x) => { try { return x == null ? null : JSON.stringify(x); } catch (e) { return null; } };

// The identity tuple that defines "the same observation slot" -- NOT a DB
// UNIQUE constraint (a line returning to a prior value must still create a
// new row), just the lookup key used to find the most recent row for this
// slot so we can decide whether the new one is genuinely different.
const IDENTITY_COLS = ['sport', 'event_id', 'player_raw', 'market_key_raw', 'source', 'projection_type', 'period', 'side'];

function normalize(obs) {
  return {
    captured_at: num(obs.capturedAt) ?? Date.now(),
    provider_last_update: str(obs.providerLastUpdate),
    age_seconds: num(obs.ageSeconds),
    sport: str(obs.sport) || 'wnba',
    event_id: str(obs.eventId),
    home_team: str(obs.homeTeam), away_team: str(obs.awayTeam),
    commence_time: str(obs.commenceTime), game_status: str(obs.gameStatus),
    player_raw: str(obs.playerRaw),
    player_id: str(obs.playerId),
    market_key_raw: str(obs.marketKeyRaw),
    market_label: str(obs.marketLabel),
    period: str(obs.period),
    source: str(obs.source),
    source_type: str(obs.sourceType),
    projection_type: str(obs.projectionType),
    odds_type: str(obs.oddsType),
    side: str(obs.side),
    line: num(obs.line),
    over_price: num(obs.overPrice),
    under_price: num(obs.underPrice),
    projection_metadata: jsonOf(obs.projectionMetadata),
    raw_json: jsonOf(obs.raw),
    semantics_status: str(obs.semanticsStatus) || 'CONFIRMED',
  };
}

// Fields compared to decide "is this a genuinely new observation" once the
// identity tuple matches an existing row. Deliberately excludes captured_at/
// age_seconds (those always differ trivially between polls) and raw_json
// (compared via the fields it was derived from, not byte-for-byte).
const CHANGE_FIELDS = ['line', 'over_price', 'under_price', 'provider_last_update', 'game_status', 'market_label'];

async function mostRecentForIdentity(row) {
  const where = IDENTITY_COLS.map(c => `${c} IS ?`).join(' AND ');
  const params = IDENTITY_COLS.map(c => row[c]);
  const rows = await store.query(
    `SELECT * FROM wnba_provider_line_archive WHERE ${where} ORDER BY captured_at DESC LIMIT 1`,
    params
  );
  return rows[0] || null;
}

function differs(a, b) {
  return CHANGE_FIELDS.some(f => (a[f] ?? null) !== (b[f] ?? null));
}

// Records one provider observation. Returns { inserted: true, id } for a
// genuinely new/changed observation, or { inserted: false, reason: 'unchanged', id }
// when the most recent row for this identity already has identical values
// (a repeat poll of the same still-current line) -- see Part 16's dedup
// requirement: only a true repeat is skipped, never a real line change.
async function recordObservation(obs) {
  const row = normalize(obs);
  if (!row.event_id || !row.player_raw || !row.market_key_raw || !row.source) {
    throw new Error('recordObservation requires eventId, playerRaw, marketKeyRaw, and source');
  }
  const prior = await mostRecentForIdentity(row);
  if (prior && !differs(row, prior)) {
    return { inserted: false, reason: 'unchanged', id: prior.id };
  }
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(',');
  const result = await store.run(
    `INSERT INTO wnba_provider_line_archive (${cols.join(',')}) VALUES (${placeholders})`,
    cols.map(c => row[c])
  );
  return { inserted: true, id: result.lastInsertRowid };
}

async function recordBatch(observations) {
  let inserted = 0, unchanged = 0;
  for (const obs of observations) {
    const r = await recordObservation(obs);
    if (r.inserted) inserted++; else unchanged++;
  }
  return { total: observations.length, inserted, unchanged };
}

async function lineHistory({ eventId, playerRaw, marketKeyRaw, source, projectionType, period, side } = {}) {
  const filters = { event_id: eventId, player_raw: playerRaw, market_key_raw: marketKeyRaw, source, projection_type: projectionType, period, side };
  const clauses = [];
  const params = [];
  for (const [col, val] of Object.entries(filters)) {
    if (val === undefined) continue;
    clauses.push(`${col} IS ?`);
    params.push(val ?? null);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return store.query(`SELECT * FROM wnba_provider_line_archive ${where} ORDER BY captured_at ASC`, params);
}

async function summary() {
  const total = (await store.queryOne(`SELECT COUNT(*) c FROM wnba_provider_line_archive`)).c;
  const events = (await store.queryOne(`SELECT COUNT(DISTINCT event_id) c FROM wnba_provider_line_archive`)).c;
  const players = (await store.queryOne(`SELECT COUNT(DISTINCT player_raw) c FROM wnba_provider_line_archive`)).c;
  const markets = (await store.queryOne(`SELECT COUNT(DISTINCT market_key_raw) c FROM wnba_provider_line_archive`)).c;
  const sources = await store.query(`SELECT source, COUNT(*) c FROM wnba_provider_line_archive GROUP BY source ORDER BY c DESC`);
  const range = await store.queryOne(`SELECT MIN(captured_at) lo, MAX(captured_at) hi FROM wnba_provider_line_archive`);
  return { total, events, players, markets, sources, firstCapture: range.lo, lastCapture: range.hi };
}

// Phase 2I-H Part 15 -- data-quality checks. Each check distinguishes an
// EXPECTED NULL (a field the provider legitimately never supplies for that
// market/book, e.g. over_price on a DFS demon/goblin line) from a real
// DATA QUALITY ERROR (a field that should always be present, e.g. line or
// captured_at, but is missing). Read-only; reports counts, never mutates.
async function dataQualityChecks() {
  const q = async (sql, params = []) => (await store.query(sql, params));
  const c = async (sql, params = []) => (await store.queryOne(sql, params)).c;

  const results = {};
  results.missingEventId = { count: await c(`SELECT COUNT(*) c FROM wnba_provider_line_archive WHERE event_id IS NULL OR event_id = ''`), status: 'DATA_QUALITY_ERROR (event_id is required on insert)' };
  results.missingPlayer = { count: await c(`SELECT COUNT(*) c FROM wnba_provider_line_archive WHERE player_raw IS NULL OR player_raw = ''`), status: 'DATA_QUALITY_ERROR (player_raw is required on insert)' };
  results.missingMarketKey = { count: await c(`SELECT COUNT(*) c FROM wnba_provider_line_archive WHERE market_key_raw IS NULL OR market_key_raw = ''`), status: 'DATA_QUALITY_ERROR (market_key_raw is required on insert)' };
  results.missingLine = { count: await c(`SELECT COUNT(*) c FROM wnba_provider_line_archive WHERE line IS NULL`), status: 'EXPECTED_NULL_POSSIBLE (some real markets, e.g. anytime-TD-style yes/no props, may genuinely have no numeric line -- only a DATA_QUALITY_ERROR if the market is a normal over/under type)' };
  results.missingSource = { count: await c(`SELECT COUNT(*) c FROM wnba_provider_line_archive WHERE source IS NULL OR source = ''`), status: 'DATA_QUALITY_ERROR (source is required on insert)' };
  results.missingCapturedAt = { count: await c(`SELECT COUNT(*) c FROM wnba_provider_line_archive WHERE captured_at IS NULL`), status: 'DATA_QUALITY_ERROR (captured_at is required on insert, defaults to Date.now() if not supplied)' };
  results.duplicateExactRows = { count: await c(`
    SELECT COUNT(*) c FROM (
      SELECT sport, event_id, player_raw, market_key_raw, source, projection_type, period, side, line, captured_at, COUNT(*) n
      FROM wnba_provider_line_archive GROUP BY sport, event_id, player_raw, market_key_raw, source, projection_type, period, side, line, captured_at
      HAVING n > 1
    )`), status: 'DATA_QUALITY_ERROR (two rows with the identical identity, line, AND captured_at should never both exist -- recordObservation dedupes by identity+value, not by exact timestamp collision, so this specifically catches a bypass of that helper)' };
  results.impossibleTimestamps = { count: await c(`SELECT COUNT(*) c FROM wnba_provider_line_archive WHERE captured_at > ? OR captured_at < 0`, [Date.now() + 86400000]), status: 'DATA_QUALITY_ERROR (captured_at more than 1 day in the future, or negative)' };
  results.invalidLines = { count: await c(`SELECT COUNT(*) c FROM wnba_provider_line_archive WHERE line IS NOT NULL AND line < 0`), status: 'DATA_QUALITY_ERROR (a negative stat line is never legitimate for any currently known WNBA market)' };
  results.standardDemonGoblinCollisions = { count: await c(`
    SELECT COUNT(*) c FROM (
      SELECT sport, event_id, player_raw, market_key_raw, source, period, side, captured_at, COUNT(DISTINCT projection_type) n
      FROM wnba_provider_line_archive GROUP BY sport, event_id, player_raw, market_key_raw, source, period, side, captured_at
      HAVING n > 1
    )`), status: 'INFO (multiple projection types captured at the identical millisecond for the same identity -- expected when a single poll returns Standard+Demon+Goblin for the same player/market simultaneously, only an error if projection_type was supposed to disambiguate but got merged)' };
  results.eventCollisions = { count: await c(`
    SELECT COUNT(*) c FROM (SELECT event_id, COUNT(DISTINCT home_team || '|' || away_team) n FROM wnba_provider_line_archive WHERE home_team IS NOT NULL GROUP BY event_id HAVING n > 1)
  `), status: 'DATA_QUALITY_ERROR (the same event_id reporting different home/away team pairs across observations would indicate a real identity problem)' };
  results.playerNameIdentityCollisions = { count: await c(`
    SELECT COUNT(*) c FROM (SELECT player_raw, COUNT(DISTINCT player_id) n FROM wnba_provider_line_archive WHERE player_id IS NOT NULL GROUP BY player_raw HAVING n > 1)
  `), status: 'INFO (same raw player name string resolving to more than one player_id -- flag for manual review, never auto-merged or auto-split by this check)' };

  return results;
}

// ─── Phase 2I-I: live capture, hooked into the REAL existing ParlayAPI
// passthrough (routes/api.js's makeCachedParlayPassthrough) ────────────────
//
// Integration point chosen deliberately: the passthrough's own `doFetch`
// already makes the one real upstream call ParlayAPI traffic goes through,
// already gated by lib/parlayCache.js's 2-minute peak / 10-minute off-peak
// TTL, already used by BOTH the live WNBA board (BeatsEdge.html's
// fetchWnbaPropLines -> fetchParlayPropsBulk -> fetchParlayProps, which
// calls this exact `${backendUrl}/api/parlayapi/v1/sports/basketball_wnba/
// props` URL) and anything else that happens to hit it. Archiving here:
//   - costs ZERO additional upstream requests (only runs on a genuine
//     cache-MISS fetch that was going to happen anyway),
//   - automatically inherits the existing cadence (archiving frequency is
//     bounded by however often the cache itself decides to refetch),
//   - requires no new client code, no new polling loop, no change to
//     BeatsEdge.html, and no change to the passthrough's response to the
//     real caller (this runs fire-and-forget after the response is already
//     being sent -- see routes/api.js's call site).
// Only the WNBA props path is matched; every other sport's passthrough
// traffic (NBA/MLB/NFL/NCAAF/NHL) is untouched and this function is a no-op
// for it.
const WNBA_PROPS_PATH_RE = /(^|\/)v1\/sports\/basketball_wnba\/props(?:$|[/?])/i;

// Given directly by the project's own established provider taxonomy
// (unchanged across every prior 2I phase) -- not inferred, not guessed.
const DFS_SOURCES = new Set(['prizepicks', 'underdog', 'sleeper']);
const SPORTSBOOK_SOURCES = new Set(['fanduel', 'draftkings', 'betmgm', 'betrivers', 'caesars', 'pinnacle', 'bovada']);

// The three provider keys Phase 2I-G/2I-H's registry audit already found to
// have unconfirmed semantics (distinct from the mapped `player_threes`).
// Tagging them here reuses that already-established finding -- it does not
// re-derive or guess it, and it does not map them to any other market.
const KNOWN_SEMANTICS_UNRESOLVED_MARKETS = new Set(['player_three_pointers', 'player_threes_made', 'player_3_pt_made_combo']);

function isWnbaPropsPath(upstreamPath) {
  return WNBA_PROPS_PATH_RE.test(upstreamPath || '');
}

function sourceTypeFor(book) {
  if (!book) return null;
  const b = String(book).toLowerCase();
  if (DFS_SOURCES.has(b)) return 'dfs';
  if (SPORTSBOOK_SOURCES.has(b)) return 'sportsbook';
  return null; // an unrecognized book is preserved as `source` verbatim; source_type just stays unclassified, never guessed
}

// Parses a REAL raw ParlayAPI response body (the exact text the upstream
// server returned, already captured by routes/api.js before it forwards
// the response to the caller) and records every WNBA row. Never called for
// any other sport's path. Never touches req.query (so the apiKey, which
// lives only there, never reaches this function at all).
async function archiveFromRawParlayResponse(upstreamPath, bodyText) {
  if (!isWnbaPropsPath(upstreamPath)) return { archived: 0, applicable: false };
  let rows;
  try {
    rows = JSON.parse(bodyText);
    if (!Array.isArray(rows)) return { archived: 0, applicable: true, error: 'non-array response body' };
  } catch (e) {
    return { archived: 0, applicable: true, error: 'unparseable response body: ' + e.message };
  }
  const capturedAt = Date.now();
  let inserted = 0, unchanged = 0, skipped = 0;
  for (const row of rows) {
    if (!row || !row.event_id || !row.player || !row.market_key || !row.bookmaker || row.line == null) { skipped++; continue; }
    const lastUpdate = row.last_update || null;
    const lastUpdateMs = lastUpdate ? Date.parse(lastUpdate) : NaN;
    const ageSeconds = Number.isFinite(lastUpdateMs) ? (capturedAt - lastUpdateMs) / 1000 : null;
    try {
      const r = await recordObservation({
        capturedAt, providerLastUpdate: lastUpdate, ageSeconds,
        sport: 'wnba', eventId: row.event_id,
        homeTeam: row.home_team || null, awayTeam: row.away_team || null,
        commenceTime: row.commence_time || null, gameStatus: row.game_status || null,
        // Preserved EXACTLY as ParlayAPI supplied it -- no normalization,
        // no suffix stripping, no identity resolution against any roster.
        playerRaw: row.player,
        playerId: row.player_id != null ? String(row.player_id) : null,
        marketKeyRaw: row.market_key,
        // Not resolved at capture time: the human-readable label and
        // normalized period both require BeatsEdge.html's own PARLAY_BB_MKT/
        // PERIOD_MARKET_MAP, which are client-side-only and were not
        // duplicated here (duplicating them risks the two copies drifting
        // apart) -- see the Phase 2I-I report's documented limitation.
        marketLabel: null, period: null,
        source: row.bookmaker, sourceType: sourceTypeFor(row.bookmaker),
        // Preserved EXACTLY as supplied -- never inferred from line size.
        projectionType: row.projection_type || null,
        oddsType: row.odds_type || null,
        side: row.side || null,
        line: row.line, overPrice: row.over_price ?? null, underPrice: row.under_price ?? null,
        projectionMetadata: null,
        raw: row,
        semanticsStatus: KNOWN_SEMANTICS_UNRESOLVED_MARKETS.has(row.market_key) ? 'SEMANTICS_UNRESOLVED' : 'CONFIRMED',
      });
      if (r.inserted) inserted++; else unchanged++;
    } catch (e) {
      skipped++;
    }
  }
  return { archived: inserted, applicable: true, unchanged, skipped, totalRows: rows.length };
}

module.exports = {
  recordObservation, recordBatch, lineHistory, summary, dataQualityChecks, IDENTITY_COLS, CHANGE_FIELDS,
  archiveFromRawParlayResponse, isWnbaPropsPath,
};
