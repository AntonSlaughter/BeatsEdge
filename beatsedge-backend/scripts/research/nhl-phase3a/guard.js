// PHASE 3A HOLDOUT GUARD. Every Phase 3A query goes through here. It refuses any SQL that could read outside
// seasons 2024-2025 (TRAIN=2024, VALIDATION=2025) and re-checks every returned row. The 2026 season (2025-10-07..2026-06-14)
// and the live 2027 rows are the untouched holdout / future and are structurally unreachable from this harness.
const store = require('../../../lib/historicalStore');

if (process.env.TURSO_HISTORICAL_DATABASE_URL || process.env.TURSO_HISTORICAL_AUTH_TOKEN) {
  throw new Error('Phase 3A must run on the LOCAL SQLite copy (no TURSO_HISTORICAL_* env). Refusing.');
}
const ALLOWED_SEASONS = [2024, 2025];
const MAX_DATE = '2025-07-31'; // 2025 playoffs end 2025-06-17; nothing in 2024-25 can be later than this
let queries = 0, rowsSeen = 0;

async function q(sql) {
  // Every query must carry the explicit season whitelist, and may not mention any other season literal.
  if (!/season\s+IN\s*\(\s*2024\s*,\s*2025\s*\)/i.test(sql)) throw new Error('GUARD: query lacks "season IN (2024,2025)" -> refused:\n' + sql);
  const lit = sql.match(/\b20\d\d\b/g) || [];
  if (lit.some(x => !['2024', '2025'].includes(x))) throw new Error('GUARD: query mentions a season/year outside 2024-2025 -> refused:\n' + sql);
  if (/\bgame_date\s*(>|>=)\s*'?20(26|27)/i.test(sql)) throw new Error('GUARD: query reaches 2026+ dates -> refused');
  const rows = await store.query(sql);
  queries++;
  for (const r of rows) {
    rowsSeen++;
    const s = r.s !== undefined ? r.s : r.season;
    if (s !== undefined && !ALLOWED_SEASONS.includes(Number(s))) throw new Error('GUARD: row from season ' + s + ' returned -> abort');
    const d = r.d !== undefined ? r.d : r.game_date;
    if (d !== undefined && d !== null && String(d) > MAX_DATE) throw new Error('GUARD: row dated ' + d + ' returned -> abort');
  }
  return rows;
}
module.exports = { q, stats: () => ({ queries, rowsSeen, allowedSeasons: ALLOWED_SEASONS, maxDate: MAX_DATE }) };
