// BeatsEdge Market Archive Hardening -- shared, generic provider-line
// archive factory (Gap 2/5). Extracts the EXACT SAME identity/dedup/
// insert/query logic that lib/nbaProviderLineArchive.js and
// lib/wnbaProviderLineArchive.js each already implement independently --
// this module was first used ONLY to add MLB/NFL/NCAAF, which had no
// equivalent archive at all, with the NBA/WNBA modules deliberately left
// alone (lower regression risk at the time). 2026-10-21: their LIVE-CAPTURE
// entry point (archiveFromRawParlayResponse) now runs through this factory
// as well -- the per-row implementation they kept ran two Turso round trips
// per row with no limit on concurrent passes and exhausted the 512 MiB
// instance's heap (docs/HEAP_EXHAUSTION_2026-10-21.md). Their per-row
// recordObservation / lineHistory / summary stay in their own modules.

const store = require('../snapshotStore');

// Process-wide cap on archive PASSES running at once, shared by every sport. A pass holds the parsed response, one normalized row per
// eligible row and the lookup result at the same time (tens of MB for a 10,000-row page); five sports refreshing together used to run five
// passes at once on top of the response cache. Passes are background work (the response is already sent), so they simply take turns.
// ARCHIVE_PASS_CONCURRENCY overrides it (>= 1).
// A pass that is waiting for the slot still holds its response text (tens of MB for a 10,000-row page, and it stays alive after the response cache evicts it), so the number
// that may wait is bounded too (ARCHIVE_PASS_MAX_WAITING, default 4, >= 0). Beyond it a pass is skipped and logged -- the next refresh re-reads the same lines and the
// changed/unchanged rule records whatever moved, so no stored row is ever altered; only an intermediate movement between two refreshes can go unrecorded, and only under a burst.
const PASS_CONCURRENCY = Math.max(1, Math.floor(Number(process.env.ARCHIVE_PASS_CONCURRENCY)) || 1);
const _mw = process.env.ARCHIVE_PASS_MAX_WAITING;
const PASS_MAX_WAITING = _mw !== undefined && _mw !== '' && Number.isFinite(Number(_mw)) ? Math.max(0, Math.floor(Number(_mw))) : 4;
let _passActive = 0, _passMax = 0, _passRun = 0, _passSkipped = 0; const _passWaiters = [];
async function withPassSlot(fn, onBusy) {
  if (_passActive >= PASS_CONCURRENCY && _passWaiters.length >= PASS_MAX_WAITING) {
    _passSkipped++; console.warn(`[archive] pass skipped: ${_passActive} running and ${_passWaiters.length} already waiting (${_passSkipped} skipped since start); the next refresh re-reads the same lines`);
    return onBusy();
  }
  if (_passActive < PASS_CONCURRENCY) { _passActive++; if (_passActive > _passMax) _passMax = _passActive; }
  else await new Promise(r => _passWaiters.push(r));   // the releasing pass hands its slot over, so _passActive is unchanged
  try { _passRun++; return await fn(); }
  finally { const next = _passWaiters.shift(); if (next) next(); else _passActive--; }
}

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
 * @param {(row: object) => string} [semanticsFor] semantics_status for one raw provider row (default: always 'CONFIRMED')
 * @param {{maxPending?: number}} [serialize] opt in to ONE pass at a time with up to `maxPending` waiting (default off: the in-flight guard below, which drops a body that arrives while a pass runs)
 */
function createProviderLineArchive({ sport, propsPathRegex, tableName, semanticsFor, serialize }) {
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
    // Only the columns the comparison below reads (identityKeyOf -> IDENTITY_COLS, differs -> CHANGE_FIELDS). The lookup used to be SELECT *, which also pulled every stored
    // row's raw_json (~1 KB of text each) for EVERY identity of the batch's events into memory for the length of the pass; nothing reads it.
    const lookupCols = [...new Set([...IDENTITY_COLS, ...CHANGE_FIELDS])].join(', ');
    const sql = `
      SELECT ${lookupCols} FROM (
        SELECT ${lookupCols}, ROW_NUMBER() OVER (PARTITION BY ${partitionCols} ORDER BY captured_at DESC) AS _rn
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
      const sql = `INSERT INTO ${TABLE} (${cols.join(',')}) VALUES (${placeholders})`;
      // Same statements, same order, still INSERT-only -- but written in chunks (store.batchWrite): each chunk is one round trip and one short write
      // transaction, with a process-wide cap on how many are open at once. The previous form held ONE write transaction open for the whole pass, one
      // round trip per row (minutes on Turso), which blocked every other writer and the booting instance's schema statements. If a chunk fails, the
      // earlier chunks stay committed and the next pass's latest-row lookup (above) sees them, so nothing is duplicated or lost.
      await store.batchWrite(toInsert.map(row => ({ sql, args: cols.map(c => row[c]) })));
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

  // One pass, run when it gets a turn in the process-wide slot (withPassSlot above).
  function _archiveFromRawParlayResponseImpl(bodyText) { return withPassSlot(() => _runPass(bodyText), () => ({ archived: 0, applicable: true, skippedBusy: true })); }
  async function _runPass(bodyText) {
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
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Hand the event loop back every 1,000 rows: normalizing a 10,000-row page in one go is a ~100 ms stall here and several times that on the 0.1 vCPU instance, during which no
      // other request (health check, board load, AI) is served. (JSON.parse above is a single call and cannot be sliced.)
      if (i > 0 && i % 1000 === 0) await new Promise(r => setImmediate(r));
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
          projectionMetadata: null, raw: row, semanticsStatus: semanticsFor ? semanticsFor(row) : 'CONFIRMED',
        }));
      } catch (e) { skipped++; failedCount++; }
    }
    // The parsed payload is not needed any more (every candidate carries its own raw_json text); drop it before the database round trips so a slow pass does not keep
    // two copies of the whole response alive.
    const totalRows = rows.length; rows = null;
    // Batched: one SELECT (scoped to this batch's own event_ids) instead of
    // one per candidate row, then one transaction for every changed row --
    // see recordNormalizedBatch's own comment for the full rationale.
    const { inserted, unchanged } = await recordNormalizedBatch(candidates);
    const skippedForLog = skipped - failedCount + unchanged;
    console.log(`[${sport}-archive] captured=${totalRows} eligible=${eligible} written=${inserted} skipped=${skippedForLog} failed=${failedCount}`);
    return { archived: inserted, applicable: true, unchanged, skipped, totalRows };
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
  // Opt-in serialized mode ({ serialize: { maxPending } }) -- used by the NBA and WNBA archives, whose boards arrive as many page/market responses within seconds of each other and
  // whose rows must not be lost the way the in-flight guard above loses them. ONE pass runs at a time; up to maxPending more wait, holding nothing but the response text (the same
  // string the response cache already owns -- the body is parsed only when its turn comes, so waiting costs no extra copy). A response that would exceed maxPending is skipped and
  // logged: the next refresh re-reads the same lines and the dedupe records whatever changed, so no stored row is ever altered and the memory held is bounded.
  const maxPending = serialize ? Math.max(0, Number(serialize.maxPending) || 3) : 0;
  const _waiting = []; let _running = false; let _skippedBusy = 0;
  async function _pump() {
    if (_running) return; _running = true;
    try { while (_waiting.length) { const job = _waiting.shift(); try { job.resolve(await _archiveFromRawParlayResponseImpl(job.bodyText)); } catch (e) { job.reject(e); } } }
    finally { _running = false; }
  }
  function _archiveSerialized(bodyText) {
    if (_waiting.length >= maxPending) {
      _skippedBusy++; console.warn(`[${sport}-archive] pass skipped: one is running and ${_waiting.length} are already waiting (${_skippedBusy} skipped since start); the next refresh re-reads the same lines`);
      return Promise.resolve({ archived: 0, applicable: true, skippedBusy: true });
    }
    return new Promise((resolve, reject) => { _waiting.push({ bodyText, resolve, reject }); _pump(); });
  }
  async function archiveFromRawParlayResponse(upstreamPath, bodyText) {
    if (!isPropsPath(upstreamPath)) return { archived: 0, applicable: false };
    if (serialize) return _archiveSerialized(bodyText);
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

// Diagnostic view of the shared pass slot: the cap, how many passes hold it now, the most that ever did, how many have run, how many wait.
const passStats = () => ({ limit: PASS_CONCURRENCY, maxWaiting: PASS_MAX_WAITING, active: _passActive, maxActive: _passMax, passesRun: _passRun, skipped: _passSkipped, waiting: _passWaiters.length });
module.exports = { createProviderLineArchive, DFS_SOURCES, SPORTSBOOK_SOURCES, sourceTypeFor, passStats };
