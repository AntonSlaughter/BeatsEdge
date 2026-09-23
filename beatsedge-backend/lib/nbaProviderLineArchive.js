// Phase 2I-Q -- raw historical NBA provider-line archive. Mirrors
// lib/wnbaProviderLineArchive.js exactly (same identity/dedup discipline,
// same append-only guarantee, same backend-agnostic store), the only
// differences being the table name (nba_provider_line_archive, entirely
// separate from wnba_provider_line_archive -- never merged) and the
// upstream path this module matches (basketball_nba, not basketball_wnba).
// This is the same reusable archive SYSTEM extended to a second sport, not
// a second system -- the Phase 2I-P precedent (nba_pbp mirroring wnba_pbp)
// is the same pattern.
//
// Before this phase, NBA ParlayAPI traffic flowed through the exact same
// passthrough as WNBA (routes/api.js's makeCachedParlayPassthrough is
// sport-agnostic) but was never archived -- archiveFromRawParlayResponse in
// the WNBA module only matched the WNBA path, so every NBA response was
// silently ignored. This module is what closes that gap.

const store = require('./snapshotStore');

const str = (x) => (x == null ? null : String(x));
const num = (x) => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
const jsonOf = (x) => { try { return x == null ? null : JSON.stringify(x); } catch (e) { return null; } };

const IDENTITY_COLS = ['sport', 'event_id', 'player_raw', 'market_key_raw', 'source', 'projection_type', 'period', 'side'];

function normalize(obs) {
  return {
    captured_at: num(obs.capturedAt) ?? Date.now(),
    provider_last_update: str(obs.providerLastUpdate),
    age_seconds: num(obs.ageSeconds),
    sport: str(obs.sport) || 'nba',
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

const CHANGE_FIELDS = ['line', 'over_price', 'under_price', 'provider_last_update', 'game_status', 'market_label'];

async function mostRecentForIdentity(row) {
  const where = IDENTITY_COLS.map(c => `${c} IS ?`).join(' AND ');
  const params = IDENTITY_COLS.map(c => row[c]);
  const rows = await store.query(
    `SELECT * FROM nba_provider_line_archive WHERE ${where} ORDER BY captured_at DESC LIMIT 1`,
    params
  );
  return rows[0] || null;
}

function differs(a, b) {
  return CHANGE_FIELDS.some(f => (a[f] ?? null) !== (b[f] ?? null));
}

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
    `INSERT INTO nba_provider_line_archive (${cols.join(',')}) VALUES (${placeholders})`,
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
  return store.query(`SELECT * FROM nba_provider_line_archive ${where} ORDER BY captured_at ASC`, params);
}

async function summary() {
  const total = (await store.queryOne(`SELECT COUNT(*) c FROM nba_provider_line_archive`)).c;
  const events = (await store.queryOne(`SELECT COUNT(DISTINCT event_id) c FROM nba_provider_line_archive`)).c;
  const players = (await store.queryOne(`SELECT COUNT(DISTINCT player_raw) c FROM nba_provider_line_archive`)).c;
  const markets = (await store.queryOne(`SELECT COUNT(DISTINCT market_key_raw) c FROM nba_provider_line_archive`)).c;
  const sources = await store.query(`SELECT source, COUNT(*) c FROM nba_provider_line_archive GROUP BY source ORDER BY c DESC`);
  const range = await store.queryOne(`SELECT MIN(captured_at) lo, MAX(captured_at) hi FROM nba_provider_line_archive`);
  return { total, events, players, markets, sources, firstCapture: range.lo, lastCapture: range.hi };
}

// ─── live capture, mirroring lib/wnbaProviderLineArchive.js's Phase 2I-I
// integration point exactly, just for the NBA props path instead ─────────
const NBA_PROPS_PATH_RE = /(^|\/)v1\/sports\/basketball_nba\/props(?:$|[/?])/i;

const DFS_SOURCES = new Set(['prizepicks', 'underdog', 'sleeper']);
const SPORTSBOOK_SOURCES = new Set(['fanduel', 'draftkings', 'betmgm', 'betrivers', 'caesars', 'pinnacle', 'bovada']);

function isNbaPropsPath(upstreamPath) {
  return NBA_PROPS_PATH_RE.test(upstreamPath || '');
}

function sourceTypeFor(book) {
  if (!book) return null;
  const b = String(book).toLowerCase();
  if (DFS_SOURCES.has(b)) return 'dfs';
  if (SPORTSBOOK_SOURCES.has(b)) return 'sportsbook';
  return null;
}

async function archiveFromRawParlayResponse(upstreamPath, bodyText) {
  if (!isNbaPropsPath(upstreamPath)) return { archived: 0, applicable: false };
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
        sport: 'nba', eventId: row.event_id,
        homeTeam: row.home_team || null, awayTeam: row.away_team || null,
        commenceTime: row.commence_time || null, gameStatus: row.game_status || null,
        playerRaw: row.player,
        playerId: row.player_id != null ? String(row.player_id) : null,
        marketKeyRaw: row.market_key,
        // Row already carries these directly -- see Phase 2I-Q fix applied
        // to lib/wnbaProviderLineArchive.js; this module never had the
        // stale null-hardcode to begin with.
        marketLabel: row.market || null, period: row.period || null,
        source: row.bookmaker, sourceType: sourceTypeFor(row.bookmaker),
        projectionType: row.projection_type || null,
        oddsType: row.odds_type || null,
        side: row.side || null,
        line: row.line, overPrice: row.over_price ?? null, underPrice: row.under_price ?? null,
        projectionMetadata: null,
        raw: row,
        // No NBA-specific semantics audit has been run yet (the WNBA
        // unresolved-markets set is a WNBA-specific finding from Phase
        // 2I-G/H and is never reused here for a different sport's market
        // registry) -- every NBA row is CONFIRMED as supplied until an
        // equivalent NBA audit is done.
        semanticsStatus: 'CONFIRMED',
      });
      if (r.inserted) inserted++; else unchanged++;
    } catch (e) {
      skipped++;
    }
  }
  return { archived: inserted, applicable: true, unchanged, skipped, totalRows: rows.length };
}

module.exports = {
  recordObservation, recordBatch, lineHistory, summary, IDENTITY_COLS, CHANGE_FIELDS,
  archiveFromRawParlayResponse, isNbaPropsPath,
};
