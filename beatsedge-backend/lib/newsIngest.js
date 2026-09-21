// News Intelligence — Phase 1: fetch + normalize.
//
// Sources: ESPN's real, keyless site-API news endpoint (same one the
// frontend already calls directly today) and, per sport, the same real
// outlet RSS feeds already verified live in BeatsEdge.html's
// NEWS_RSS_SOURCES (via the same rss2json.com proxy the frontend already
// uses). No new source, no new credential, nothing paid -- this only
// moves the SAME real calls server-side so they can be normalized, deduped
// and cached once for every visitor instead of refetched raw in every
// browser tab. Running from Node also means the CORS workaround the
// frontend needs for ESPN (allorigins.win fallback) is unnecessary here --
// ESPN's API has no CORS restriction against a server-side fetch.
//
// classifyNewsKind and its regexes are copied VERBATIM from BeatsEdge.html
// (search "NEWS_INJURY_RE" there) so both layers agree on the same
// taxonomy -- not a second, drifting classifier.

const newsDb = require('./newsDb');

const ESPN_NEWS_SPORT_PATHS = {
  nba: 'basketball/nba',
  wnba: 'basketball/wnba',
  nfl: 'football/nfl',
  nhl: 'hockey/nhl',
  mlb: 'baseball/mlb',
  ncaaf: 'football/college-football'
};

// Copied verbatim from BeatsEdge.html's NEWS_RSS_SOURCES -- every entry was
// live-verified there before being added; WNBA intentionally has none (no
// outlet feed was ever confirmed to work for it).
const NEWS_RSS_SOURCES = {
  nba: [{ name: 'Yahoo Sports', url: 'https://sports.yahoo.com/nba/rss.xml' }, { name: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/nba/' }],
  nfl: [{ name: 'Yahoo Sports', url: 'https://sports.yahoo.com/nfl/rss.xml' }, { name: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/nfl/' }],
  mlb: [{ name: 'Yahoo Sports', url: 'https://sports.yahoo.com/mlb/rss.xml' }, { name: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/mlb/' }],
  nhl: [{ name: 'Yahoo Sports', url: 'https://sports.yahoo.com/nhl/rss.xml' }, { name: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/nhl/' }],
  ncaaf: [{ name: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/college-football/' }],
  wnba: []
};

const strOf = (v) => (v == null ? '' : String(v)).trim();

// ── Classification (verbatim copy of BeatsEdge.html's regexes) ───────────
const NEWS_INJURY_RE = /\b(out|questionable|doubtful|day-to-day|dtd|injur|ruled out|will not play|won'?t play|placed on|activat|reinstat|return|left the game|exits?|leaves?|scratched|game-time|IL|DL|concussion|strain|sprain|soreness|surgery|MRI)\b/i;
const LINEUP_NEWS_RE = /\b(?:in the (?:starting )?lineup|out of the lineup|(?:back|return[s]?|rejoin[s]?|recalled) (?:to|in) (?:the )?(?:starting )?(?:lineup|rotation)|return[s]? to (?:the )?[A-Z][\w']+ ?(?:'s)? lineup|(?:starting|batting) (?:lineup|order)|(?:named|will be|is|is the|listed as) (?:the )?(?:starting|starter)\b|gets? the (?:start|nod|ball)|will (?:start|get the start|be under center)|(?:late )?scratch(?:ed|es)?|benched?|to the bench|activated (?:from|off)|reinstated|recall(?:s|ed)?|call(?:s|ed)?[ -]up|promoted to the (?:active roster|majors|big leagues?)|(?:ruled|listed as) (?:inactive|active)|game-time decision|expected to (?:start|play)|named (?:the )?starter|starting (?:pitcher|goalie|goaltender|quarterback|qb|center|nine|five)|to start at\b|makes? (?:his|her|the) (?:first|season) start)/i;
const ROSTER_NEWS_RE = /\b(sign(?:s|ed|ing)?|trade[ds]?|acquire[ds]?|claim(?:ed|s)?|waive[ds]?|release[ds]?|(?:is|are|were) (?:released|cut)|designat(?:e|ed) for assignment|option(?:ed|s)? (?:to|down)|contract extension|DFA'?d?)\b/i;
const WEATHER_NEWS_RE = /\b(rain(?:ed|ing|out)?|wind|snow|storm|postpone[ds]?|(?:weather|rain) delay|tarp (?:on|is)|game (?:suspended|postponed)|makeup game)\b/i;
const RECAP_NEWS_RE = /(?:\b\d+-\d+\b|game highlights|final score|:\s*game highlights$)|\b(?:beat|beats|defeat[s]?|hold[s]? off|rally (?:past|to)|carries?|blank[s]?|edge[s]?|top[s]?|rout[s]?|snap[s]? (?:a |their )?\d|homers? (?:as|to)|walk-?off)\b/i;
const NEWS_NOISE_RE = /\bfantasy (?:football|baseball|hockey|basketball)\b|\bforecaster\b|\bwaiver\b|start[\/-]?sit|\brankings?\b|cheat sheet|\bmock draft\b|best bets|how to bet\b|odds,? (?:tips|analysis)|betting (?:preview|preparations)|power rankings|\bpodcast\b|\bfree tix\b/i;
const NEWS_PROMO_RE = /\bpromo code\b|\bbonus bets?\b|\bfree bets?\b|sign[\s-]?up bonus|\brisk-free\b|gambling problem|1-800-GAMBLER|use (?:draftkings|fanduel|betmgm|caesars)\b/i;

function classifyNewsKind(headline, description) {
  const text = `${headline || ''} ${description || ''}`;
  return NEWS_NOISE_RE.test(text) ? 'news'
    : RECAP_NEWS_RE.test(headline || '') ? 'recap'
      : LINEUP_NEWS_RE.test(text) ? 'lineup'
        : NEWS_INJURY_RE.test(text) ? 'injury'
          : ROSTER_NEWS_RE.test(text) ? 'roster'
            : WEATHER_NEWS_RE.test(text) ? 'weather'
              : 'news';
}

// ── Timestamp normalization (Step 4) ──────────────────────────────────────
// Prefer UTC internally. Never fabricates a timestamp -- returns null when
// the source value doesn't parse to a real instant.
function normalizeTimestamp(raw, { assumeUtcNoZone = false } = {}) {
  const s = strOf(raw);
  if (!s) return null;
  let candidate = s;
  // rss2json's own pubDate format, confirmed live this session:
  // "YYYY-MM-DD HH:MM:SS" with no timezone indicator at all. rss2json
  // documents this as already being UTC -- treated as such explicitly
  // here (converted to a real ISO string) rather than left for each
  // JS engine to guess local-vs-UTC inconsistently.
  if (assumeUtcNoZone && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    candidate = s.replace(' ', 'T') + 'Z';
  }
  const ms = Date.parse(candidate);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

// ── Dedup key (Step 5) ────────────────────────────────────────────────────
function canonicalizeUrl(url) {
  const s = strOf(url);
  if (!s) return null;
  try {
    const u = new URL(s);
    return (u.origin + u.pathname).replace(/\/$/, '').toLowerCase();
  } catch (e) {
    return s.split('?')[0].replace(/\/$/, '').toLowerCase();
  }
}
function buildDedupeKey({ source, sourceArticleId, url, title, publishedAt }) {
  if (sourceArticleId) return `${source}:id:${sourceArticleId}`;
  const curl = canonicalizeUrl(url);
  if (curl) return `${source}:url:${curl}`;
  return `${source}:fp:${title}|${publishedAt || 'no-ts'}`;
}

// ── Minimal, dependency-free HTML entity decode + tag strip for RSS text
// (Node has no DOM; the frontend's textarea trick doesn't exist here).
// Covers the entities actually observed live in Yahoo/CBS RSS feeds this
// session plus the standard numeric-entity forms -- not a full HTML parser,
// deliberately, since RSS description/title fields are never full markup.
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function decodeHtmlEntities(s) {
  if (!s) return '';
  let out = String(s);
  for (let pass = 0; pass < 2; pass++) {
    out = out.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+\d*);/g, (m, code) => {
      if (code[0] === '#') {
        const cp = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
      }
      return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, code) ? HTML_ENTITIES[code] : m;
    });
  }
  return out;
}
function stripHtml(s) {
  return decodeHtmlEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// ── Normalization (Step 3) ────────────────────────────────────────────────
// Both normalizers return null for a row that isn't real usable news
// (no headline, or matches NEWS_PROMO_RE) -- filtered out, never stored as
// a placeholder. playerId/eventId/importance are never set here (Phase 1
// scope) -- left for a later phase, never guessed.
function normalizeEspnArticle(a, sport) {
  const title = strOf(a.headline);
  if (!title) return null;
  const summary = strOf(a.description) || null;
  if (NEWS_PROMO_RE.test(`${title} ${summary || ''}`)) return null;
  const url = strOf(a.links && a.links.web && a.links.web.href) || null;
  const publishedAt = normalizeTimestamp(a.published);
  const updatedAt = normalizeTimestamp(a.lastModified);
  const sourceArticleId = a.id != null ? String(a.id) : null;
  const athleteCat = (a.categories || []).find(c => c.type === 'athlete' && c.athlete);
  const teamCat = (a.categories || []).find(c => c.type === 'team' && c.team);
  const image = (Array.isArray(a.images) && a.images[0] && strOf(a.images[0].url)) || null;
  const base = {
    source: 'ESPN', sourceArticleId, title, summary, url, imageUrl: image,
    publishedAt, rawPublishedAt: strOf(a.published) || null, updatedAt,
    sport, league: null,
    team: strOf(teamCat && teamCat.team && (teamCat.team.abbreviation || teamCat.team.name)) || null,
    playerName: strOf(athleteCat && athleteCat.athlete && (athleteCat.athlete.displayName || athleteCat.athlete.fullName)) || null,
    category: classifyNewsKind(title, summary)
  };
  return { ...base, dedupeKey: buildDedupeKey(base) };
}

function normalizeRssItem(item, sport, sourceName) {
  const title = decodeHtmlEntities(strOf(item.title));
  if (!title) return null;
  const summary = stripHtml(item.description).slice(0, 500) || null;
  if (NEWS_PROMO_RE.test(`${title} ${summary || ''}`)) return null;
  const url = strOf(item.link) || null;
  const publishedAt = normalizeTimestamp(item.pubDate, { assumeUtcNoZone: true });
  const sourceArticleId = strOf(item.guid) || null;
  const image = strOf(item.thumbnail) || null;
  const base = {
    source: sourceName, sourceArticleId, title, summary, url, imageUrl: image,
    publishedAt, rawPublishedAt: strOf(item.pubDate) || null, updatedAt: null,
    sport, league: null, team: null, playerName: null,
    category: classifyNewsKind(title, summary)
  };
  return { ...base, dedupeKey: buildDedupeKey(base) };
}

// ── Fetching ───────────────────────────────────────────────────────────────
async function fetchEspnNews(sport) {
  const espnPath = ESPN_NEWS_SPORT_PATHS[sport];
  if (!espnPath) return { ok: false, reason: 'unsupported sport', articles: [] };
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/news?limit=50`);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, articles: [] };
    const data = await res.json();
    const articles = (Array.isArray(data.articles) ? data.articles : [])
      .map(a => normalizeEspnArticle(a, sport))
      .filter(Boolean);
    return { ok: true, articles };
  } catch (e) {
    return { ok: false, reason: e.message, articles: [] };
  }
}

async function fetchRssSource(url) {
  const proxied = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(url);
  const res = await fetch(proxied);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data.status !== 'ok' || !Array.isArray(data.items)) throw new Error('rss2json status: ' + (data.status || 'unknown'));
  return data.items;
}

// Ingest one sport: ESPN + any verified RSS outlets for it. Per-source
// failures are isolated (one dead feed never blocks the others) and never
// produce a fabricated article -- only real, successfully-parsed rows are
// upserted. Returns a per-source report so the API layer can honestly
// distinguish "no news" from "a source failed."
async function ingestSport(sport) {
  const sourceReports = [];
  const allArticles = [];

  const espnResult = await fetchEspnNews(sport);
  sourceReports.push({ source: 'ESPN', ok: espnResult.ok, count: espnResult.articles.length, reason: espnResult.reason || null });
  allArticles.push(...espnResult.articles);

  const rssSources = NEWS_RSS_SOURCES[sport] || [];
  for (const src of rssSources) {
    try {
      const items = await fetchRssSource(src.url);
      const normalized = items.map(item => normalizeRssItem(item, sport, src.name)).filter(Boolean);
      sourceReports.push({ source: src.name, ok: true, count: normalized.length, reason: null });
      allArticles.push(...normalized);
    } catch (e) {
      sourceReports.push({ source: src.name, ok: false, count: 0, reason: e.message });
    }
  }

  const { inserted, updated } = newsDb.upsertArticles(allArticles);
  return { sport, sourceReports, fetched: allArticles.length, inserted, updated };
}

async function ingestAllSports() {
  const sports = Object.keys(ESPN_NEWS_SPORT_PATHS);
  const results = [];
  for (const sport of sports) {
    results.push(await ingestSport(sport));
  }
  return results;
}

module.exports = {
  ESPN_NEWS_SPORT_PATHS, NEWS_RSS_SOURCES,
  classifyNewsKind, normalizeTimestamp, buildDedupeKey, canonicalizeUrl,
  normalizeEspnArticle, normalizeRssItem,
  ingestSport, ingestAllSports
};
