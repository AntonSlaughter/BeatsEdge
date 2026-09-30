// BeatsEdge Market Archive Hardening -- shared, generic provider-line
// archive factory (Gap 2/5). Extracts the EXACT SAME identity/dedup/
// insert/query logic that lib/nbaProviderLineArchive.js and
// lib/wnbaProviderLineArchive.js each already implement independently --
// this module is used ONLY to add MLB/NFL/NCAAF, which currently have no
// equivalent archive at all. The existing NBA/WNBA modules are left
// completely untouched (zero behavior change, zero regression risk to
// already-collecting-real-data production code) -- see the Market
// Archive Hardening report for why duplicating this pattern once more
// (rather than also migrating NBA/WNBA onto this factory) was the
// deliberately lower-risk choice.

const store = require('../snapshotStore');

const str = (x) => (x == null ? null : String(x));
const num = (x) => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
const jsonOf = (x) => { try { return x == null ? null : JSON.stringify(x); } catch (e) { return null; } };

const IDENTITY_COLS = ['sport', 'event_id', 'player_raw', 'market_key_raw', 'source', 'projection_type', 'period', 'side'];
const CHANGE_FIELDS = ['line', 'over_price', 'under_price', 'provider_last_update', 'game_status', 'market_label'];

const DFS_SOURCES = new Set(['prizepicks', 'underdog', 'sleeper']);
const SPORTSBOOK_SOURCES = new Set(['fanduel', 'draftkings', 'betmgm', 'betrivers', 'caesars', 'pinnacle', 'bovada']);
function sourceTypeFor(book) {
  if (!book) return null;
  const b = String(book).toLowerCase();
  if (DFS_SOURCES.has(b)) return 'dfs';
  if (SPORTSBOOK_SOURCES.has(b)) return 'sportsbook';
  return null;
}

/**
 * @param {string} sport lowercase sport key used as the `sport` column value AND to build the default table name
 * @param {RegExp} propsPathRegex matches the upstream passthrough path for this sport's props endpoint
 * @param {string} [tableName] defaults to `${sport}_provider_line_archive`
 */
function createProviderLineArchive({ sport, propsPathRegex, tableName }) {
  const TABLE = tableName || `${sport}_provider_line_archive`;

  function normalize(obs) {
    return {
      captured_at: num(obs.capturedAt) ?? Date.now(),
      provider_last_update: str(obs.providerLastUpdate),
      age_seconds: num(obs.ageSeconds),
      sport: str(obs.sport) || sport,
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

  async function mostRecentForIdentity(row) {
    const where = IDENTITY_COLS.map(c => `${c} IS ?`).join(' AND ');
    const params = IDENTITY_COLS.map(c => row[c]);
    const rows = await store.query(`SELECT * FROM ${TABLE} WHERE ${where} ORDER BY captured_at DESC LIMIT 1`, params);
    return rows[0] || null;
  }

  function differs(a, b) { return CHANGE_FIELDS.some(f => (a[f] ?? null) !== (b[f] ?? null)); }

  // Stable string key for IDENTITY_COLS -- used only as an in-memory Map
  // key (never sent to the DB), so it never needs to match SQL's NULL
  // semantics, just be collision-free per distinct (col value) tuple.
  function identityKeyOf(row) {
    return IDENTITY_COLS.map(c => (row[c] === null || row[c] === undefined) ? '\u0000' : String(row[c])).join('\u0001');
  }

  // Batched replacement for calling mostRecentForIdentity() once per row.
  // Real production logs showed a single refresh producing thousands of
  // eligible rows (e.g. one real NHL pull: eligible=7481) -- that many
  // individual "SELECT ... ORDER BY captured_at DESC LIMIT 1" round trips
  // per refresh, across all six sports on this factory + the two standalone
  // NBA/WNBA modules, every ~2-minute cache cycle, is the measured, code-
  // supported explanation for the Turso beatsedge-snapshots quota
  // exhaustion this fixes. This changes ONLY how the "what's the current
  // latest row for each identity" lookup is obtained -- never what counts
  // as changed/unchanged (still differs(), untouched), never what identity
  // means (IDENTITY_COLS untouched), never an overwrite of any existing
  // row (still INSERT-only, no UPDATE/REPLACE, so every prior observation
  // stays exactly as archived for real-line/movement history).
  //
  // One SELECT (scoped to just this batch's own distinct event_ids -- never
  // the whole table) using ROW_NUMBER() OVER (PARTITION BY <identity>...)
  // to get the latest row per identity server-side, instead of N SELECTs.
  // window functions have been in SQLite (and therefore libSQL/Turso, and
  // the bundled better-sqlite3 used locally) since 3.25 -- both backends
  // this app already supports run the identical SQL here.
  async function fetchLatestForIdentities(normalizedRows) {
    const map = new Map();
    const eventIds = [...new Set(normalizedRows.map(r => r.event_id))];
    if (!eventIds.length) return map;
    const placeholders = eventIds.map(() => '?').join(',');
    const partitionCols = IDENTITY_COLS.join(', ');
    const sql = `
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY ${partitionCols} ORDER BY captured_at DESC) AS _rn
        FROM ${TABLE}
        WHERE sport IS ? AND event_id IN (${placeholders})
      ) WHERE _rn = 1
    `;
    const rows = await store.query(sql, [sport, ...eventIds]);
    for (const row of rows) map.set(identityKeyOf(row), row);
    return map;
  }

  // Applies the EXACT existing changed/unchanged decision (differs()) to
  // every normalized row in one pass, using the batched lookup above
  // instead of a per-row DB read, then inserts every changed row inside
  // ONE transaction (still one INSERT per new row -- no INSERT OR REPLACE,
  // no UPDATE -- just far fewer round trips than one transaction per row).
  // Two (or more) incoming rows that happen to share the same identity
  // within a single payload are still compared IN ORDER against each
  // other, exactly as sequential recordObservation() calls would have --
  // the in-memory map is updated after each decision, so a later duplicate
  // in the same batch correctly compares against the earlier one's outcome
  // instead of stale DB state.
  async function recordNormalizedBatch(normalizedRows) {
    if (!normalizedRows.length) return { inserted: 0, unchanged: 0 };
    const latestByIdentity = await fetchLatestForIdentities(normalizedRows);
    const toInsert = [];
    let unchanged = 0;
    for (const row of normalizedRows) {
      const key = identityKeyOf(row);
      const prior = latestByIdentity.get(key) || null;
      if (prior && !differs(row, prior)) { unchanged++; continue; }
      toInsert.push(row);
      latestByIdentity.set(key, row);
    }
    if (toInsert.length) {
      const cols = Object.keys(toInsert[0]);
      const placeholders = cols.map(() => '?').join(',');
      await store.transaction(async (exec) => {
        for (const row of toInsert) {
          await exec(`INSERT INTO ${TABLE} (${cols.join(',')}) VALUES (${placeholders})`, cols.map(c => row[c]));
        }
      });
    }
    return { inserted: toInsert.length, unchanged };
  }

  async function recordObservation(obs) {
    const row = normalize(obs);
    if (!row.event_id || !row.player_raw || !row.market_key_raw || !row.source) {
      throw new Error('recordObservation requires eventId, playerRaw, marketKeyRaw, and source');
    }
    const prior = await mostRecentForIdentity(row);
    if (prior && !differs(row, prior)) return { inserted: false, reason: 'unchanged', id: prior.id };
    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(',');
    const result = await store.run(`INSERT INTO ${TABLE} (${cols.join(',')}) VALUES (${placeholders})`, cols.map(c => row[c]));
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
    const clauses = [], params = [];
    for (const [col, val] of Object.entries(filters)) { if (val === undefined) continue; clauses.push(`${col} IS ?`); params.push(val ?? null); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return store.query(`SELECT * FROM ${TABLE} ${where} ORDER BY captured_at ASC`, params);
  }

  async function summary() {
    const total = (await store.queryOne(`SELECT COUNT(*) c FROM ${TABLE}`)).c;
    const events = (await store.queryOne(`SELECT COUNT(DISTINCT event_id) c FROM ${TABLE}`)).c;
    const players = (await store.queryOne(`SELECT COUNT(DISTINCT player_raw) c FROM ${TABLE}`)).c;
    const markets = (await store.queryOne(`SELECT COUNT(DISTINCT market_key_raw) c FROM ${TABLE}`)).c;
    const sources = await store.query(`SELECT source, COUNT(*) c FROM ${TABLE} GROUP BY source ORDER BY c DESC`);
    const range = await store.queryOne(`SELECT MIN(captured_at) lo, MAX(captured_at) hi FROM ${TABLE}`);
    return { total, events, players, markets, sources, firstCapture: range.lo, lastCapture: range.hi };
  }

  function isPropsPath(upstreamPath) { return propsPathRegex.test(upstreamPath || ''); }

  async function _archiveFromRawParlayResponseImpl(bodyText) {
    let rows;
    try {
      rows = JSON.parse(bodyText);
      if (!Array.isArray(rows)) {
        console.warn(`[${sport}-archive] archive error: non-array response body`);
        return { archived: 0, applicable: true, error: 'non-array response body' };
      }
    } catch (e) {
      console.warn(`[${sport}-archive] archive error: unparseable response body:`, e.message);
      return { archived: 0, applicable: true, error: 'unparseable response body: ' + e.message };
    }
    const capturedAt = Date.now();
    let skipped = 0, eligible = 0, failedCount = 0;
    // Same eligibility filter and same normalize() call as before -- only
    // the LOOKUP strategy below changes (batched instead of per-row).
    const candidates = [];
    for (const row of rows) {
      if (!row || !row.event_id || !row.player || !row.market_key || !row.bookmaker || row.line == null) { skipped++; continue; }
      eligible++;
      const lastUpdate = row.last_update || null;
      const lastUpdateMs = lastUpdate ? Date.parse(lastUpdate) : NaN;
      const ageSeconds = Number.isFinite(lastUpdateMs) ? (capturedAt - lastUpdateMs) / 1000 : null;
      try {
        candidates.push(normalize({
          capturedAt, providerLastUpdate: lastUpdate, ageSeconds,
          sport, eventId: row.event_id,
          homeTeam: row.home_team || null, awayTeam: row.away_team || null,
          commenceTime: row.commence_time || null, gameStatus: row.game_status || null,
          playerRaw: row.player, playerId: row.player_id != null ? String(row.player_id) : null,
          marketKeyRaw: row.market_key, marketLabel: row.market || null, period: row.period || null,
          source: row.bookmaker, sourceType: sourceTypeFor(row.bookmaker),
          projectionType: row.projection_type || null, oddsType: row.odds_type || null, side: row.side || null,
          line: row.line, overPrice: row.over_price ?? null, underPrice: row.under_price ?? null,
          projectionMetadata: null, raw: row, semanticsStatus: 'CONFIRMED',
        }));
      } catch (e) { skipped++; failedCount++; }
    }
    // Batched: one SELECT (scoped to this batch's own event_ids) instead of
    // one per candidate row, then one transaction for every changed row --
    // see recordNormalizedBatch's own comment for the full rationale.
    const { inserted, unchanged } = await recordNormalizedBatch(candidates);
    const skippedForLog = skipped - failedCount + unchanged;
    console.log(`[${sport}-archive] captured=${rows.length} eligible=${eligible} written=${inserted} skipped=${skippedForLog} failed=${failedCount}`);
    return { archived: inserted, applicable: true, unchanged, skipped, totalRows: rows.length };
  }

  // In-flight guard: this factory is one instance per sport, so this
  // closure-scoped variable naturally coalesces per sport -- if a previous
  // archive pass over this same table is still running (e.g. a slow Turso
  // round trip) when the NEXT refresh's response arrives, the new call
  // reuses that SAME in-flight promise instead of starting a second
  // concurrent full pass over the same identities. Purely a concurrency
  // guard -- never changes which rows get archived, only prevents two
  // passes from ever overlapping.
  let _inFlight = null;
  async function archiveFromRawParlayResponse(upstreamPath, bodyText) {
    if (!isPropsPath(upstreamPath)) return { archived: 0, applicable: false };
    if (_inFlight) return _inFlight;
    _inFlight = _archiveFromRawParlayResponseImpl(bodyText).finally(() => { _inFlight = null; });
    return _inFlight;
  }

  return {
    TABLE, IDENTITY_COLS, CHANGE_FIELDS,
    recordObservation, recordBatch, lineHistory, summary,
    archiveFromRawParlayResponse, isPropsPath,
  };
}

module.exports = { createProviderLineArchive, DFS_SOURCES, SPORTSBOOK_SOURCES, sourceTypeFor };
