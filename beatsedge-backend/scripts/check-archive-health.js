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
  const report = { generatedAt: new Date().toISOString(), nba, wnba };

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
  console.log(`\nWrote ${outPath}`);
})().catch(e => { console.error(e); process.exit(1); });
