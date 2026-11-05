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

// RESOURCE OPTIMIZATION (2026-11-05, docs/RESOURCE_OPTIMIZATION_2026-11-05.md).
//
// 1. Latest-row cache. Every pass used to ask the database for the latest stored row of EVERY identity of EVERY event on the board it had just read (a window function
//    over all stored rows of those events), and the page's one refresh produces ~36 upstream responses -> ~36 such scans, each reading the event's whole stored history.
//    That scan is the measured driver of Turso rows READ. The latest row per identity is now loaded from the database ONCE per event (per process, and again after
//    ARCHIVE_LATEST_CACHE_TTL_MS, default 6 h) and kept in memory as a compact fingerprint of the CHANGE_FIELDS; later passes compare against memory. What counts as a
//    change, what an identity is, and what is written are untouched: the same rows are inserted, INSERT-only, in the same order. The cache is updated only AFTER a write
//    succeeds, and any failed write, or a write made outside a pass (recordObservation), drops the affected events so they are re-read from the database.
//    ARCHIVE_LATEST_CACHE_MAX (default 60000 identities across one sport's table; 0 turns the cache off = the previous behaviour) bounds the memory; whole events are
//    evicted, oldest first, so an event is never half cached.
// 2. ARCHIVE_LAST_UPDATE_IS_CHANGE (default 1 = unchanged). Set to 0 and a row whose ONLY difference from the stored latest row is the provider's own `last_update`
//    timestamp is not written. Measured on the local WNBA archive (13,939 rows): 21.9 % of rows are last_update-only, 55.5 % are real line / price changes, 22.4 % are
//    first observations (MLB sample: 0 % last_update-only). It stays 1 because a stored row's provider_last_update / age_seconds are what freshness checks read; flipping
//    it is a decision about the archive's contents, not a free optimization.
const _cacheMaxEnv = process.env.ARCHIVE_LATEST_CACHE_MAX;
const LATEST_CACHE_MAX = _cacheMaxEnv !== undefined && _cacheMaxEnv !== '' && Number.isFinite(Number(_cacheMaxEnv)) && Number(_cacheMaxEnv) >= 0 ? Math.floor(Number(_cacheMaxEnv)) : 60000;
const LATEST_CACHE_TTL_MS = Math.max(1000, Number(process.env.ARCHIVE_LATEST_CACHE_TTL_MS) || 6 * 3600_000);   // (the 1 s floor exists for tests)
const LAST_UPDATE_IS_CHANGE = process.env.ARCHIVE_LAST_UPDATE_IS_CHANGE !== '0';
const COMPARED_FIELDS = LAST_UPDATE_IS_CHANGE ? CHANGE_FIELDS : CHANGE_FIELDS.filter(f => f !== 'provider_last_update');
// Exact, type-tagged fingerprint of the compared fields: two rows have equal fingerprints iff no compared field differs (null and undefined are the same, as in differs()).
const fpOf = (row) => COMPARED_FIELDS.map(f => { const v = row[f]; return v == null ? '\u0000' : (typeof v === 'number' ? 'n' + v : 's' + v); }).join('\u0001');
const _registry = [];   // every factory's cache stats, for GET /api/resource-metrics

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

  function differs(a, b) { return COMPARED_FIELDS.some(f => (a[f] ?? null) !== (b[f] ?? null)); }

  // Latest-row cache (see the header comment above): eventId -> { loadedAt, ids: Map(identityKey -> fingerprint) }. Map insertion order is the LRU order.
  const latest = new Map(); let latestIdentities = 0;
  const cstat = { batches: 0, eventsFromMemory: 0, eventsLoaded: 0, dbLookups: 0, dbRowsRead: 0, evictedEvents: 0, invalidatedEvents: 0, expiredEvents: 0 };
  _registry.push({ table: TABLE, snapshot: () => ({ table: TABLE, enabled: LATEST_CACHE_MAX > 0, cachedEvents: latest.size, cachedIdentities: latestIdentities, maxIdentities: LATEST_CACHE_MAX, ttlMs: LATEST_CACHE_TTL_MS, lastUpdateIsChange: LAST_UPDATE_IS_CHANGE, ...cstat }) });
  function dropEvent(eventId) { const e = latest.get(eventId); if (!e) return false; latestIdentities -= e.ids.size; latest.delete(eventId); return true; }
  function invalidateEvents(eventIds) { for (const id of eventIds) if (dropEvent(id)) cstat.invalidatedEvents++; }
  function trimTo(keep) { // evict the oldest whole events (never one in `keep`) until under the bound
    if (LATEST_CACHE_MAX <= 0) return;
    for (const id of latest.keys()) { if (latestIdentities <= LATEST_CACHE_MAX) break; if (keep && keep.has(id)) continue; dropEvent(id); cstat.evictedEvents++; }
  }

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
  // Returns Map(eventId -> { ids: Map(identityKey -> fingerprint) }) for every event of the batch: from memory when cached and not expired, otherwise read from the database
  // (ONE query for all the events that are missing) and, unless the cache is off, remembered. Same SQL as before, but only for the events not already known.
  async function fetchLatestForIdentities(normalizedRows) {
    const eventIds = [...new Set(normalizedRows.map(r => r.event_id))];
    const out = new Map(); if (!eventIds.length) return out;
    cstat.batches++;
    const now = Date.now(); const missing = [];
    for (const id of eventIds) {
      const e = LATEST_CACHE_MAX > 0 ? latest.get(id) : null;
      if (e && now - e.loadedAt < LATEST_CACHE_TTL_MS) { out.set(id, e); cstat.eventsFromMemory++; latest.delete(id); latest.set(id, e); /* most recently used */ }
      else { if (e) { dropEvent(id); cstat.expiredEvents++; } missing.push(id); }
    }
    if (!missing.length) return out;
    const placeholders = missing.map(() => '?').join(',');
    const partitionCols = IDENTITY_COLS.join(', ');
    // Only the columns the comparison below reads (identityKeyOf -> IDENTITY_COLS, the fingerprint -> CHANGE_FIELDS). The lookup used to be SELECT *, which also pulled every stored
    // row's raw_json (~1 KB of text each) for EVERY identity of the batch's events into memory for the length of the pass; nothing reads it.
    const lookupCols = [...new Set([...IDENTITY_COLS, ...CHANGE_FIELDS])].join(', ');
    const sql = `
      SELECT ${lookupCols} FROM (
        SELECT ${lookupCols}, ROW_NUMBER() OVER (PARTITION BY ${partitionCols} ORDER BY captured_at DESC) AS _rn
        FROM ${TABLE}
        WHERE sport IS ? AND event_id IN (${placeholders})
      ) WHERE _rn = 1
    `;
    const rows = await store.query(sql, [sport, ...missing]);
    cstat.dbLookups++; cstat.dbRowsRead += rows.length; cstat.eventsLoaded += missing.length;
    const fresh = new Map(missing.map(id => [id, { eventId: id, loadedAt: now, ids: new Map() }]));
    for (const row of rows) { const e = fresh.get(row.event_id == null ? null : String(row.event_id)); if (e) e.ids.set(identityKeyOf(row), fpOf(row)); }
    for (const [id, e] of fresh) { out.set(id, e); if (LATEST_CACHE_MAX > 0) { latest.set(id, e); latestIdentities += e.ids.size; } }
    trimTo(new Set(eventIds));
    return out;
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
    const eventIds = [...new Set(normalizedRows.map(r => r.event_id))];
    let latestByEvent;
    try { latestByEvent = await fetchLatestForIdentities(normalizedRows); }
    catch (e) { invalidateEvents(eventIds); throw e; }
    const toInsert = [];
    const pending = [];   // [eventMap, key, fingerprint]: applied to the cache only once the write below has succeeded
    const overlay = new Map();   // a later duplicate in the SAME batch compares against the earlier one's outcome, exactly as sequential recordObservation() calls would
    let unchanged = 0;
    for (const row of normalizedRows) {
      const key = identityKeyOf(row);
      const ev = latestByEvent.get(row.event_id);
      const fp = fpOf(row);
      const okey = row.event_id + '\u0002' + key;
      const prior = overlay.has(okey) ? overlay.get(okey) : (ev ? ev.ids.get(key) : undefined);
      if (prior !== undefined && prior === fp) { unchanged++; continue; }
      toInsert.push(row);
      overlay.set(okey, fp);
      pending.push([ev, key, fp]);
    }
    if (toInsert.length) {
      const cols = Object.keys(toInsert[0]);
      const placeholders = cols.map(() => '?').join(',');
      const sql = `INSERT INTO ${TABLE} (${cols.join(',')}) VALUES (${placeholders})`;
      // Same statements, same order, still INSERT-only -- but written in chunks (store.batchWrite): each chunk is one round trip and one short write
      // transaction, with a process-wide cap on how many are open at once. The previous form held ONE write transaction open for the whole pass, one
      // round trip per row (minutes on Turso), which blocked every other writer and the booting instance's schema statements. If a chunk fails, the
      // earlier chunks stay committed and the next pass's latest-row lookup (above) sees them, so nothing is duplicated or lost.
      try { await store.batchWrite(toInsert.map(row => ({ sql, args: cols.map(c => row[c]) }))); }
      catch (e) { invalidateEvents(eventIds); throw e; }   // some chunks may be committed and some not: forget these events and re-read them
      // The write succeeded: the cache now reflects what is stored. When one pass inserts SEVERAL rows for the same identity (an alt-line ladder: the identity does not include
      // the line) they all carry the same captured_at, and the database lookup this cache replaces ("latest row per identity, ORDER BY captured_at DESC") breaks that tie by
      // keeping the FIRST row inserted. The cache reproduces exactly that (first wins), so the rows written are identical to what the database lookup would have produced
      // (scripts/test-archive-heap-bound.js section A and scripts/test-snapshot-startup-archive.js compare them row for row). That tie-break is also why a ladder is partly
      // re-written on every pass; see docs/RESOURCE_OPTIMIZATION_2026-11-05.md, "Ladder re-insertion", for the measurement and the decision it needs.
      const applied = new Set();
      for (const [ev, key, fp] of pending) {
        if (!ev) continue;
        const ak = ev.eventId + '\u0002' + key; if (applied.has(ak)) continue; applied.add(ak);
        const isNew = !ev.ids.has(key);
        ev.ids.set(key, fp);
        if (isNew && latest.get(ev.eventId) === ev) latestIdentities++;
      }
      trimTo(new Set(eventIds));
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
    invalidateEvents([row.event_id]);   // written outside a pass: the cached latest rows of this event are no longer authoritative
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
// Per-table latest-row cache statistics (counts only) for GET /api/resource-metrics.
const latestCacheStats = () => _registry.map(r => r.snapshot());
module.exports = { createProviderLineArchive, DFS_SOURCES, SPORTSBOOK_SOURCES, sourceTypeFor, passStats, latestCacheStats };
