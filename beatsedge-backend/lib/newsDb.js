// News Intelligence — Phase 1: storage layer.
//
// Same connection pattern every other *Db.js file in this repo already
// uses (own better-sqlite3 connection to the shared BEATSEDGE_DB_PATH file,
// own `CREATE TABLE IF NOT EXISTS`) -- see lib/mlbDb.js/lib/nhlDb.js for the
// precedent. Reuses the existing SQLite file rather than introducing a
// second database, per this phase's explicit instruction.
//
// This file only stores/reads already-normalized articles (see
// lib/newsIngest.js for fetching + normalization). It never fetches
// anything itself and never fabricates a value for a field the source
// didn't supply.

const Database = require('better-sqlite3');
const { BEATSEDGE_DB_PATH } = require('./dataPaths');

const db = new Database(BEATSEDGE_DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS news_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,              -- 'ESPN' | 'Yahoo Sports' | 'CBS Sports' | ...
    source_article_id TEXT,            -- real id/guid the source supplied, or NULL
    title TEXT NOT NULL,
    summary TEXT,
    url TEXT,
    image_url TEXT,
    published_at TEXT,                 -- ISO8601 UTC, normalized. NULL if the source gave no valid timestamp -- never fabricated.
    raw_published_at TEXT,             -- the ORIGINAL unparsed source value, kept for debugging when published_at is NULL
    updated_at TEXT,                   -- ISO8601 UTC, from the source's own "last modified" field when it has one
    sport TEXT NOT NULL,               -- BeatsEdge's internal sport key (mlb/nfl/ncaaf/nba/wnba/nhl)
    league TEXT,
    team TEXT,
    player_name TEXT,                  -- the RESOLVED player's canonical name -- null unless lib/newsPlayerIdentity.js actually established identity (Phase 2A). Never the source's raw unverified tag.
    player_id TEXT,                    -- real id in player_id_source's own id space, or NULL if identity could not be established
    player_id_source TEXT,             -- 'espn' | 'mlb' | 'nflverse' -- which real id space player_id is in (Phase 2A). NULL alongside player_id.
    player_match_method TEXT,          -- 'EXACT_ID' | 'EXACT_NAME' | 'EXACT_NAME_TEAM' | 'VERIFIED_ALIAS' | 'UNMATCHED' | 'AMBIGUOUS' (Phase 2A)
    event_id TEXT,                     -- always NULL -- no game/article join exists yet
    category TEXT,                     -- classifyNewsKind() taxonomy: lineup/injury/roster/weather/recap/news
    importance TEXT,                   -- always NULL -- no importance scoring exists yet
    first_seen_at TEXT DEFAULT (datetime('now')),
    last_seen_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_news_sport_published ON news_articles(sport, published_at);
  CREATE INDEX IF NOT EXISTS idx_news_dedupe ON news_articles(dedupe_key);
`);

// Phase 2A migration -- news_articles already existed from Phase 1 without
// player_id_source/player_match_method, so CREATE TABLE IF NOT EXISTS above
// is a no-op on an already-migrated database and never adds the new
// columns by itself. Guarded so this is a one-time, idempotent add, same
// pattern as lib/nflSchema.js's own migration guard. Existing Phase 1 rows
// simply get NULL in the two new columns (accurate -- their identity was
// never resolved) and remain valid; nothing about them is rewritten here.
{
  const existingCols = db.prepare(`PRAGMA table_info(news_articles)`).all().map(c => c.name);
  if (!existingCols.includes('player_id_source')) db.exec(`ALTER TABLE news_articles ADD COLUMN player_id_source TEXT`);
  if (!existingCols.includes('player_match_method')) db.exec(`ALTER TABLE news_articles ADD COLUMN player_match_method TEXT`);
}

// Insert a new article, or -- if its dedupe_key already exists -- just
// bump last_seen_at (and refresh fields that can legitimately change after
// first ingest: summary/image/updated_at, since an outlet sometimes edits
// a live story). Never overwrites published_at once set (the moment a
// story was first published doesn't change). Player identity fields ARE
// refreshed on re-ingest (Phase 2A) -- the canonical historical index a
// name is matched against can genuinely improve as more history is
// ingested by the existing nightly jobs, so a re-resolve is real
// freshness, not drift. event_id/importance are left alone (still no
// resolver exists for either).
const upsertStmt = db.prepare(`
  INSERT INTO news_articles
    (dedupe_key, source, source_article_id, title, summary, url, image_url, published_at, raw_published_at, updated_at, sport, league, team, player_name, player_id, player_id_source, player_match_method, category)
  VALUES
    (@dedupeKey, @source, @sourceArticleId, @title, @summary, @url, @imageUrl, @publishedAt, @rawPublishedAt, @updatedAt, @sport, @league, @team, @playerName, @playerId, @playerIdSource, @playerMatchMethod, @category)
  ON CONFLICT(dedupe_key) DO UPDATE SET
    title = excluded.title,
    summary = excluded.summary,
    url = excluded.url,
    image_url = excluded.image_url,
    updated_at = excluded.updated_at,
    player_name = excluded.player_name,
    player_id = excluded.player_id,
    player_id_source = excluded.player_id_source,
    player_match_method = excluded.player_match_method,
    last_seen_at = datetime('now')
`);

function upsertArticles(articles) {
  let inserted = 0, updated = 0;
  const tx = db.transaction((rows) => {
    for (const a of rows) {
      const before = db.prepare('SELECT id FROM news_articles WHERE dedupe_key = ?').get(a.dedupeKey);
      upsertStmt.run({
        dedupeKey: a.dedupeKey, source: a.source, sourceArticleId: a.sourceArticleId || null,
        title: a.title, summary: a.summary || null, url: a.url || null, imageUrl: a.imageUrl || null,
        publishedAt: a.publishedAt || null, rawPublishedAt: a.rawPublishedAt || null, updatedAt: a.updatedAt || null,
        sport: a.sport, league: a.league || null, team: a.team || null, playerName: a.playerName || null,
        playerId: a.playerId || null, playerIdSource: a.playerIdSource || null, playerMatchMethod: a.playerMatchMethod || null,
        category: a.category || null
      });
      if (before) updated++; else inserted++;
    }
  });
  tx(articles);
  return { inserted, updated };
}

// Newest -> oldest, undated articles last (never fabricated a date to sort
// them in). `sport` filters to one internal sport key; omit/pass null for
// every sport. `limit` caps the row count (default 100, matching the
// existing frontend's per-source `limit=50` ESPN calls in spirit).
const selectAllStmt = db.prepare(`
  SELECT * FROM news_articles
  ORDER BY (published_at IS NULL) ASC, published_at DESC
  LIMIT ?
`);
const selectBySportStmt = db.prepare(`
  SELECT * FROM news_articles WHERE sport = ?
  ORDER BY (published_at IS NULL) ASC, published_at DESC
  LIMIT ?
`);

function toApiShape(row) {
  return {
    id: row.id,
    source: row.source,
    sourceArticleId: row.source_article_id,
    title: row.title,
    summary: row.summary,
    url: row.url,
    imageUrl: row.image_url,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    sport: row.sport,
    league: row.league,
    team: row.team,
    playerName: row.player_name,
    playerId: row.player_id,
    playerIdSource: row.player_id_source,
    playerMatchMethod: row.player_match_method,
    // No separate numeric/percentage confidence exists or is claimed --
    // playerMatchMethod IS the confidence tier (a real categorical signal,
    // never a fabricated statistic). Exposed under both names because
    // Step 8 lists both as potential fields.
    playerMatchConfidence: row.player_match_method,
    eventId: row.event_id,
    category: row.category,
    importance: row.importance,
    // Derived, read-time only -- never stored. A simple, honest freshness
    // signal (published within the last 2h), not a claim about reader
    // history/state (no per-viewer "seen" tracking exists in Phase 1).
    isNew: !!(row.published_at && (Date.now() - Date.parse(row.published_at)) < 2 * 3600 * 1000)
  };
}

function getArticles({ sport, limit } = {}) {
  const cappedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = sport
    ? selectBySportStmt.all(sport, cappedLimit)
    : selectAllStmt.all(cappedLimit);
  return rows.map(toApiShape);
}

function articleCountForSport(sport) {
  return db.prepare('SELECT COUNT(*) AS n FROM news_articles WHERE sport = ?').get(sport).n;
}

module.exports = { upsertArticles, getArticles, articleCountForSport, db };
