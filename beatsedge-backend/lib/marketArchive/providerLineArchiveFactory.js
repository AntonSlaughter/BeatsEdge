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

  async function archiveFromRawParlayResponse(upstreamPath, bodyText) {
    if (!isPropsPath(upstreamPath)) return { archived: 0, applicable: false };
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
    let inserted = 0, unchanged = 0, skipped = 0, eligible = 0, failedCount = 0;
    for (const row of rows) {
      if (!row || !row.event_id || !row.player || !row.market_key || !row.bookmaker || row.line == null) { skipped++; continue; }
      eligible++;
      const lastUpdate = row.last_update || null;
      const lastUpdateMs = lastUpdate ? Date.parse(lastUpdate) : NaN;
      const ageSeconds = Number.isFinite(lastUpdateMs) ? (capturedAt - lastUpdateMs) / 1000 : null;
      try {
        const r = await recordObservation({
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
        });
        if (r.inserted) inserted++; else unchanged++;
      } catch (e) { skipped++; failedCount++; }
    }
    const skippedForLog = skipped - failedCount + unchanged;
    console.log(`[${sport}-archive] captured=${rows.length} eligible=${eligible} written=${inserted} skipped=${skippedForLog} failed=${failedCount}`);
    return { archived: inserted, applicable: true, unchanged, skipped, totalRows: rows.length };
  }

  return {
    TABLE, IDENTITY_COLS, CHANGE_FIELDS,
    recordObservation, recordBatch, lineHistory, summary,
    archiveFromRawParlayResponse, isPropsPath,
  };
}

module.exports = { createProviderLineArchive, DFS_SOURCES, SPORTSBOOK_SOURCES, sourceTypeFor };
