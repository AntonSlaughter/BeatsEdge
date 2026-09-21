// News Intelligence Phase 2A -- reliable player identity for news articles.
//
// REUSES BeatsEdge's existing, proven canonical player-identity sources
// rather than inventing a second system (per this phase's explicit
// instruction). This does NOT reuse BeatsEdge.html's own resolvePlayerIdentity
// function directly -- that function is frontend-only (browser JS, no
// module system, operates on "today's live roster" which only the browser
// ever fetches) and cannot be require()'d into this backend Node module,
// the same cross-runtime constraint documented for lib/propLineNormalize.js
// in Phase 1-3. Instead this reuses the SAME underlying real data BeatsEdge
// already has on the backend: its own historical stats tables, which carry
// real player ids in real, already-established id spaces:
//
//   MLB   -- mlb_batter_game_stats / mlb_pitcher_game_stats . player_id
//            = MLB Stats API person.id (SAME id space the live MLB prop
//            pipeline uses -- confirmed: source='statsapi-live').
//   NFL   -- nfl_player_game_stats . player_id = nflverse's own GSIS-style
//            id (e.g. "00-0019596" for Tom Brady) -- confirmed via a real
//            row read. This is NOT the same id space BeatsEdge's live NFL
//            prop pipeline uses (ESPN athlete id) -- labeled honestly as
//            playerIdSource:'nflverse', never mislabeled as 'espn'. See
//            this file's own report for why reconciling the two spaces is
//            explicitly left for a later phase rather than guessed at here.
//   NCAAF -- no backend historical player table exists at all (confirmed:
//            no ncaaf-scoped table anywhere in lib/). Always UNMATCHED.
//   NBA   -- nba_player_box . athlete_id = ESPN athlete id (confirmed by
//            that table's own header comment: "ESPN-sourced ... same id
//            space the live BeatsEdge NBA pipeline uses").
//   WNBA  -- box_scores has a sport='wnba' slice but ZERO rows exist right
//            now (confirmed live) and it has no player-id column at all,
//            only player_name. Always UNMATCHED.
//
// PLUS a stronger, sport-agnostic signal that doesn't need any of the
// above: ESPN's own news API already tags many articles with a real,
// explicit `athlete.id` (confirmed live for MLB/NFL/NBA -- e.g. LeBron
// James = 1966, Tom Brady-tagged article present, Bryce Eldridge = 5149064).
// That IS a real, provider-supplied identifier -- Tier 1, strongest
// possible signal, no name-matching involved at all.

// Reuses lib/newsDb.js's ALREADY-open connection rather than opening yet
// another one via require('./db')/require('./mlbDb'). All of BeatsEdge's
// tables (news_articles, nba_player_box, mlb_batter_game_stats, ...) live
// in the SAME physical SQLite file (BEATSEDGE_DB_PATH) regardless of which
// module originally created them, so any open connection to that file can
// query any table in it -- this is purely about not adding two more
// simultaneous better-sqlite3 connections in a sandbox where multiple
// connections have shown pre-existing, unrelated native-cleanup flakiness
// (see this phase's own report; per explicit instruction that underlying
// bug is not touched here, only this file's own resource footprint is).
const db = require('./newsDb').db;

// ── Name normalization (Step 4) ───────────────────────────────────────────
// Deliberately NOT the same function as BeatsEdge.html's nflNormName --
// that one STRIPS suffixes entirely (Jr/Sr/II/III/IV/V removed), which is
// safe for prop-line matching (team+game context already disambiguates)
// but unsafe here: a news headline is often the ONLY context available, so
// collapsing "Ken Griffey" and "Ken Griffey Jr." (two different real
// people) would be exactly the false-attribution risk this phase exists to
// prevent. This normalizer PRESERVES the suffix as a token in the
// normalized string; matching WITHOUT the suffix is a separate, explicit,
// safety-checked fallback (see resolveNameInIndex below), not baked into
// normalization itself.
function normalizePlayerName(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // "Last, First[ Suffix]" -> "First Last Suffix" (handles "Acuna, Ronald Jr.").
  // The suffix, if present, trails the FIRST name in comma form -- naively
  // concatenating [First+Suffix, Last] would misorder it ("Ronald Jr.
  // Acuna" instead of "Ronald Acuna Jr."), so it's extracted explicitly
  // and re-appended at the true end.
  const commaParts = s.split(',').map(p => p.trim()).filter(Boolean);
  if (commaParts.length >= 2) {
    const lastName = commaParts[0];
    const rest = commaParts.slice(1).join(' ');
    const suffixMatch = rest.match(/\s+(jr\.?|sr\.?|ii|iii|iv|v)\.?$/i);
    s = suffixMatch ? `${rest.slice(0, suffixMatch.index).trim()} ${lastName} ${suffixMatch[1]}` : `${rest} ${lastName}`;
  }
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); // strip diacritics: Acuña -> Acuna
  s = s.toLowerCase();
  s = s.replace(/\bjunior\b/g, 'jr').replace(/\bsenior\b/g, 'sr');
  s = s.replace(/['']/g, ''); // apostrophes: O'Neal -> oneal
  s = s.replace(/[^a-z0-9\s-]/g, ' '); // periods/commas/etc -> space
  s = s.replace(/-/g, ' '); // hyphenated names: Smith-Jones -> smith jones
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Strip a trailing suffix token, if present, for the "safe suffix-less
// fallback" match described in resolveNameInIndex. Returns the same string
// unchanged if it has no recognizable suffix token.
const SUFFIX_RE = /\s(jr|sr|ii|iii|iv|v)$/;
function stripSuffix(normalized) {
  return normalized.replace(SUFFIX_RE, '');
}

// ── Canonical player index (Step 3) ───────────────────────────────────────
// Built from BeatsEdge's own real, already-ingested historical tables --
// never a second, hand-maintained player universe. Lazily built once per
// process (these tables are large -- NBA alone is 573k+ rows -- and don't
// change intra-process) and cached; safe because this is read-only
// reference data, not live state.
const _indexCache = {};

function buildIndexFromRows(rows, idKey, nameKey, teamKey) {
  const byId = new Map(); // id -> {id, name, team} -- keeps the FIRST row seen per id; callers order their query most-recent-first so this is the player's latest known team, never a permanent binding (Step 7) -- re-queried fresh from the live table on every process start, not hardcoded
  rows.forEach(r => {
    const id = r[idKey] != null ? String(r[idKey]) : null;
    const name = r[nameKey];
    if (!id || !name) return;
    if (!byId.has(id)) byId.set(id, { id, name, team: r[teamKey] || null, normalized: normalizePlayerName(name) });
  });
  const byNormName = new Map(); // normalized full name -> [{id, name, team}]
  byId.forEach(entry => {
    const arr = byNormName.get(entry.normalized) || [];
    arr.push(entry);
    byNormName.set(entry.normalized, arr);
  });
  return { byId, byNormName };
}

function getIndexForSport(sport) {
  if (_indexCache[sport]) return _indexCache[sport];
  let index = null;
  try {
    if (sport === 'mlb') {
      // MLB's backend history is already thin (892 batter + 351 pitcher
      // rows total, confirmed live) -- no scoping needed for performance,
      // and every row is real recent data already.
      const batters = db.prepare(`SELECT DISTINCT player_id, player_name, team FROM mlb_batter_game_stats ORDER BY game_date DESC`).all();
      const pitchers = db.prepare(`SELECT DISTINCT player_id, player_name, team FROM mlb_pitcher_game_stats ORDER BY game_date DESC`).all();
      index = buildIndexFromRows([...batters, ...pitchers], 'player_id', 'player_name', 'team');
      index.playerIdSource = 'mlb';
    } else if (sport === 'nfl') {
      // Scoped to the most recent 3 seasons present -- both a real perf win
      // (23k+ total rows) and more correct: a current news article is about
      // an active-era player, and this also makes a traded player's `team`
      // reflect their real MOST RECENT team (ORDER BY season DESC means the
      // first row buildIndexFromRows sees per id is the newest one -- it
      // only keeps the FIRST occurrence per id).
      const rows = db.prepare(`SELECT DISTINCT player_id, player_name, team FROM nfl_player_game_stats WHERE season >= (SELECT MAX(season) FROM nfl_player_game_stats) - 2 ORDER BY season DESC, week DESC`).all();
      index = buildIndexFromRows(rows, 'player_id', 'player_name', 'team');
      index.playerIdSource = 'nflverse';
    } else if (sport === 'nba') {
      // Same reasoning as NFL -- confirmed live: unscoped took ~1.8s over
      // 573k rows; scoped to the last 3 seasons takes ~40ms over ~1.4k
      // distinct players, and is more relevant for current news besides.
      const rows = db.prepare(`SELECT DISTINCT athlete_id, athlete_name, team FROM nba_player_box WHERE season >= (SELECT MAX(season) FROM nba_player_box) - 2 ORDER BY season DESC, game_date DESC`).all();
      index = buildIndexFromRows(rows, 'athlete_id', 'athlete_name', 'team');
      index.playerIdSource = 'espn';
    }
    // ncaaf / wnba: no backend historical player table exists (confirmed
    // live -- box_scores has a wnba slice with zero rows and no id column;
    // no ncaaf table anywhere). Left as null on purpose -- NOT invented.
  } catch (e) {
    console.warn(`[newsPlayerIdentity] Failed to build canonical index for ${sport}:`, e.message);
    index = null;
  }
  _indexCache[sport] = index;
  return index;
}

// Tiers 3/4 of Step 5: exact normalized-name match, then a team-
// disambiguated match, within one sport's canonical index. Never guesses --
// returns a method tag explaining exactly why, even on failure.
function resolveNameInIndex(index, rawName, team) {
  if (!index) return { method: 'UNMATCHED', reason: 'no canonical index for this sport' };
  const normalized = normalizePlayerName(rawName);
  if (!normalized) return { method: 'UNMATCHED', reason: 'empty name' };

  let candidates = index.byNormName.get(normalized) || [];
  let viaSuffixFallback = false;

  if (candidates.length === 0) {
    // Safe suffix-less fallback (Step 4): only trust it if EVERY entry in
    // the index whose suffix-stripped name matches collapses to the SAME
    // single real person (same id). If two distinct real people share a
    // base name and differ only by suffix (or one has a suffix and one
    // doesn't), a suffix-less mention is genuinely ambiguous and must NOT
    // be guessed -- this is exactly the Ken Griffey / Ken Griffey Jr. case
    // the phase spec calls out.
    const strippedInput = stripSuffix(normalized);
    if (strippedInput !== normalized) {
      const matchingIds = new Set();
      const matchingEntries = [];
      index.byNormName.forEach((entries, key) => {
        if (stripSuffix(key) === strippedInput) {
          entries.forEach(e => { matchingIds.add(e.id); matchingEntries.push(e); });
        }
      });
      if (matchingIds.size === 1) { candidates = matchingEntries.slice(0, 1); viaSuffixFallback = true; }
      else if (matchingIds.size > 1) return { method: 'AMBIGUOUS', reason: `${matchingIds.size} distinct players share the base name "${strippedInput}", differing only by suffix -- refusing to guess` };
    }
  }

  if (candidates.length === 0) return { method: 'UNMATCHED', reason: 'no candidate in this sport\'s canonical index' };

  if (candidates.length === 1) {
    return {
      method: viaSuffixFallback ? 'EXACT_NAME' : 'EXACT_NAME',
      player: candidates[0]
    };
  }

  // Multiple distinct real players share this exact normalized name
  // (Step 5's "two players with the same name" case) -- team is the only
  // safe discriminator available from a news article (Step 7). The
  // canonical index's `team` is that player's most-recently-seen team in
  // real ingested data, not a permanent binding (a real trade updates it
  // the next time that table is refreshed) -- so this is real, current
  // evidence, not a stale assumption.
  if (team) {
    const teamNorm = String(team).trim().toUpperCase();
    const teamMatches = candidates.filter(c => c.team && String(c.team).trim().toUpperCase() === teamNorm);
    if (teamMatches.length === 1) return { method: 'EXACT_NAME_TEAM', player: teamMatches[0] };
    if (teamMatches.length > 1) return { method: 'AMBIGUOUS', reason: `${teamMatches.length} candidates share both name and team -- refusing to guess` };
  }
  return { method: 'AMBIGUOUS', reason: `${candidates.length} distinct players share the exact name "${normalized}" and no team evidence disambiguates them` };
}

// ── Public resolver (Step 5's full hierarchy, Step 6/7 boundaries) ────────
// `article` is a Phase-1-shaped raw source object: for ESPN, the article's
// own `categories` array (to find a real athlete.id, Tier 1) and a
// fallback raw name/team; for RSS, there is no structured athlete field at
// all (Phase 1 never captured one), so RSS articles always resolve
// UNMATCHED here -- scanning free-text headlines for a candidate name
// would be exactly the "loose/fuzzy" inference this phase must avoid, and
// is explicitly out of scope.
function resolvePlayerForArticle({ sport, espnAthleteId, espnAthleteName, rawName, team }) {
  // Tier 1 -- explicit provider id. Sport-agnostic: ESPN tags athletes the
  // same way across every sport it covers. Bypasses name-matching entirely,
  // so it is immune to every accent/suffix/collision edge case below.
  if (espnAthleteId != null) {
    return {
      playerId: String(espnAthleteId),
      playerIdSource: 'espn',
      playerName: espnAthleteName || null,
      playerMatchMethod: 'EXACT_ID'
    };
  }

  // Tier 2/3 -- this sport's own canonical historical index, by name
  // (+team). Sport is a hard boundary by construction: only that sport's
  // own table is ever queried (Step 6) -- an NBA name can never resolve
  // against the NFL index because the NFL index is never consulted for an
  // article tagged sport:'nba'.
  const nameToMatch = rawName;
  if (!nameToMatch) return { playerId: null, playerIdSource: null, playerName: null, playerMatchMethod: 'UNMATCHED' };

  const index = getIndexForSport(sport);
  const result = resolveNameInIndex(index, nameToMatch, team);
  if (result.method === 'EXACT_NAME' || result.method === 'EXACT_NAME_TEAM') {
    return {
      playerId: result.player.id,
      playerIdSource: index.playerIdSource,
      playerName: result.player.name,
      playerMatchMethod: result.method
    };
  }
  // AMBIGUOUS / UNMATCHED -- Step 1's core principle: both null, never a
  // partial/best-guess value.
  return { playerId: null, playerIdSource: null, playerName: null, playerMatchMethod: result.method };
}

module.exports = { normalizePlayerName, stripSuffix, buildIndexFromRows, getIndexForSport, resolveNameInIndex, resolvePlayerForArticle };
