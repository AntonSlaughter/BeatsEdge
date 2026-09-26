// Phase 2I-Q -- lightweight, read-only health/monitoring check for the
// real provider-line period archive (nba_provider_line_archive /
// wnba_provider_line_archive). Distinct from scripts/run-real-line-
// validation.js: this script never fits/scores a model and is scoped to
// EVERY period market currently being captured (not just the 13 Phase H
// candidates) -- it answers "is the archive healthy and growing", not
// "should any market be promoted". Safe and cheap to rerun anytime.
//
//   node scripts/check-archive-health.js
//
// Writes tmp/archive-health-report.json and prints a summary to stdout.

const fs = require('fs');
const path = require('path');
const store = require('../lib/snapshotStore');
const { resolveEvent, resolvePlayer, derivePeriodFromMarketKey, actualResult } = require('../lib/realLineMatcher');
// Market Archive Hardening (Gap 12) -- additive only; every field this
// adds is new, nothing existing above/below is changed or removed.
const { classifyTiming } = require('../lib/marketArchive/pregameClassifier');

const ARCHIVE_TABLES = { nba: 'nba_provider_line_archive', wnba: 'wnba_provider_line_archive', mlb: 'mlb_provider_line_archive', nfl: 'nfl_provider_line_archive', ncaaf: 'ncaaf_provider_line_archive' };

// Extended, cross-sport health snapshot: latest capture, rows in the last
// 24h, distinct events/players/markets/sources, a timing classification
// breakdown (pregame/live/final/unknown -- see item 9's explicit
// pregame=captured_at<commence_time rule), and a coarse "any row flagged
// as provider-truncated" signal where that metadata exists on the row
// (most archived rows don't carry it today -- reported as a coverage
// percentage, not fabricated). Read-only; never touches archived rows.
async function extendedHealthFor(sport) {
  const table = ARCHIVE_TABLES[sport];
  if (!table) return { sport, error: `no archive table configured for "${sport}"` };
  const total = (await store.queryOne(`SELECT COUNT(*) c FROM ${table}`)).c;
  if (!total) return { sport, total: 0, note: 'no archived rows -- nothing further to report' };

  const range = await store.queryOne(`SELECT MIN(captured_at) lo, MAX(captured_at) hi FROM ${table}`);
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const last24h = (await store.queryOne(`SELECT COUNT(*) c FROM ${table} WHERE captured_at >= ?`, [dayAgo])).c;
  const events = (await store.queryOne(`SELECT COUNT(DISTINCT event_id) c FROM ${table}`)).c;
  const players = (await store.queryOne(`SELECT COUNT(DISTINCT player_raw) c FROM ${table}`)).c;
  const markets = (await store.queryOne(`SELECT COUNT(DISTINCT market_key_raw) c FROM ${table}`)).c;
  const sources = await store.query(`SELECT source, COUNT(*) n FROM ${table} GROUP BY source ORDER BY n DESC`);

  const rows = await store.query(`SELECT captured_at, commence_time, game_status FROM ${table}`);
  const timingCounts = { PREGAME: 0, LIVE: 0, FINAL: 0, UNKNOWN: 0 };
  for (const r of rows) timingCounts[classifyTiming(r).classification]++;

  return {
    sport, total, last24h,
    firstCapture: range.lo, lastCapture: range.hi,
    distinctEvents: events, distinctPlayers: players, distinctMarkets: markets,
    sourceBreakdown: sources,
    timingBreakdown: timingCounts,
    // Provider truncation metadata (x-result-truncated etc.) is carried by
    // the PASSTHROUGH response headers, not persisted per-row today -- so
    // this reports "not currently tracked per snapshot" honestly rather
    // than fabricating a completeness percentage. See the Market Archive
    // Hardening report's item H for the full explanation.
    paginationCompletenessTrackedPerRow: false,
  };
}

const PERIOD_STATS = { points: true, rebounds: true, oreb: true, dreb: true, assists: true, tpm: true, tpa: true, pra: true };
// map a provider market_key_raw's stripped base back to a period-stat
// column name, so `actualResult` (which needs a column name) can be
// looked up generically for ANY period market, not just the 13 candidates.
const BASE_TO_STAT = {
  player_points: 'points', player_rebounds: 'rebounds', player_offensive_rebounds: 'oreb',
  player_defensive_rebounds: 'dreb', player_assists: 'assists', player_threes: 'tpm',
  player_3_pt_attempted: 'tpa', player_pra: 'pra', player_pts_rebs_asts: 'pra',
};
function statForMarketKey(marketKeyRaw) {
  const stripped = marketKeyRaw.replace(/_(1st_quarter|2nd_quarter|3rd_quarter|4th_quarter|1st_half|2nd_half|ot)$/, '');
  return BASE_TO_STAT[stripped] || null;
}

async function healthFor(sport) {
  const table = sport === 'nba' ? 'nba_provider_line_archive' : 'wnba_provider_line_archive';
  const all = await store.query(`SELECT * FROM ${table}`);
  const periodRows = all.filter(r => (r.period && r.period !== 'FULL') || derivePeriodFromMarketKey(r.market_key_raw));

  const bySport = { total: all.length, periodObservations: periodRows.length };
  const byMarket = {};
  const byProvider = {};
  let matched = 0, unresolvedEvent = 0, unresolvedPlayer = 0, graded = 0, ungraded = 0;

  const eventCache = new Map(), playerCache = new Map();

  for (const row of periodRows) {
    const period = row.period && row.period !== 'FULL' ? row.period : derivePeriodFromMarketKey(row.market_key_raw);
    const mk = `${row.market_key_raw}${period ? ` (${period})` : ''}`;
    byMarket[mk] = (byMarket[mk] || 0) + 1;
    byProvider[row.source] = (byProvider[row.source] || 0) + 1;

    const eKey = `${row.event_id}|${row.home_team}|${row.away_team}|${row.commence_time}`;
    if (!eventCache.has(eKey)) eventCache.set(eKey, resolveEvent(sport, row));
    const ev = eventCache.get(eKey);
    if (!ev.resolved) { unresolvedEvent++; continue; }

    const pKey = `${ev.gameId}|${row.player_raw}`;
    if (!playerCache.has(pKey)) playerCache.set(pKey, resolvePlayer(sport, ev.gameId, row.player_raw));
    const pl = playerCache.get(pKey);
    if (!pl.resolved) { unresolvedPlayer++; continue; }

    matched++;
    const stat = statForMarketKey(row.market_key_raw);
    if (!stat || !period) { ungraded++; continue; }
    const actual = actualResult(sport, period, stat, ev.gameId, pl.athleteId);
    if (actual !== null) graded++; else ungraded++;
  }

  return {
    sport, total: all.length, periodObservations: periodRows.length,
    byMarket, byProvider,
    matched, unresolvedEvent, unresolvedPlayer,
    graded, ungraded,
    historicalOutcomeCoveragePct: matched ? +((100 * graded / matched).toFixed(2)) : null,
  };
}

(async () => {
  const nba = await healthFor('nba');
  const wnba = await healthFor('wnba');
  // Market Archive Hardening (Gap 12) -- additive extended snapshot for
  // all five sports, alongside the original period-market health above
  // (unchanged, still NBA/WNBA only, since that's the only sport pair
  // with a period-market registry to resolve against).
  const extended = {};
  for (const sport of Object.keys(ARCHIVE_TABLES)) extended[sport] = await extendedHealthFor(sport);

  const report = { generatedAt: new Date().toISOString(), nba, wnba, extended };

  const outPath = path.join(__dirname, '..', 'tmp', 'archive-health-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  for (const h of [nba, wnba]) {
    console.log(`\n=== ${h.sport.toUpperCase()} ===`);
    console.log(`Total archived observations: ${h.total}  |  Period-market observations: ${h.periodObservations}`);
    console.log(`Matched: ${h.matched}  Unresolved (event): ${h.unresolvedEvent}  Unresolved (player): ${h.unresolvedPlayer}`);
    console.log(`Graded: ${h.graded}  Ungraded: ${h.ungraded}  Historical outcome coverage: ${h.historicalOutcomeCoveragePct}%`);
    console.log(`By provider:`, h.byProvider);
    console.log(`By market:`, h.byMarket);
  }
  console.log(`\n=== EXTENDED (all 5 sports) ===`);
  console.log(JSON.stringify(extended, null, 2));
  console.log(`\nWrote ${outPath}`);
})().catch(e => { console.error(e); process.exit(1); });
