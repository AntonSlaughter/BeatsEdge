// Prop-snapshot store — the full picture behind every prop BeatsEdge grades
// (model inputs + factor values + data-quality flags + model outputs),
// pushed up from the client each slate. Six months of these + the settled
// results = a real calibration / feature-value dataset.
//
// Storage backend (local SQLite file vs. a persistent Turso/libSQL
// database) is selected by lib/snapshotStore.js based on whether
// TURSO_DATABASE_URL/TURSO_AUTH_TOKEN are set — this file doesn't know or
// care which one is active. Every exported function here is async as a
// result; every caller (routes/api.js, cron/settleSnapshots.js) awaits them.

const store = require('./snapshotStore');

const num = (x) => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
const str = (x) => (x == null ? null : String(x));
const jsonOf = (x) => { try { return x == null ? null : JSON.stringify(x); } catch (e) { return null; } };

const UPSERT_SQL = `
  INSERT INTO prop_snapshots (
    snap_date, sport, player, team, opp, pos, stat, type, line, dir, book, line_source,
    model_variant, model_projection, proj_min, pa_per_game, ab_per_game, batting_order,
    probability, raw_probability, edge, edge_pct, edge_signal_pct,
    grade, grade_score, confidence, factors_aligned, factors_total, prime,
    market_line, mkt_gap, hit_rates, factors, data_quality, captured_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(snap_date, sport, player, stat, line, dir, model_variant) DO UPDATE SET
    team=excluded.team, opp=excluded.opp, pos=excluded.pos, type=excluded.type,
    book=excluded.book, line_source=excluded.line_source,
    model_projection=excluded.model_projection, proj_min=excluded.proj_min,
    pa_per_game=excluded.pa_per_game, ab_per_game=excluded.ab_per_game,
    batting_order=excluded.batting_order,
    probability=excluded.probability,
    raw_probability=excluded.raw_probability, edge=excluded.edge, edge_pct=excluded.edge_pct,
    edge_signal_pct=excluded.edge_signal_pct, grade=excluded.grade, grade_score=excluded.grade_score,
    confidence=excluded.confidence, factors_aligned=excluded.factors_aligned,
    factors_total=excluded.factors_total, prime=excluded.prime, market_line=excluded.market_line,
    mkt_gap=excluded.mkt_gap, hit_rates=excluded.hit_rates, factors=excluded.factors,
    data_quality=excluded.data_quality, captured_at=excluded.captured_at,
    received_at=datetime('now')
`;

function rowParams(snapDate, sport, r) {
  return [
    str(snapDate), str(sport), str(r.player),
    str(r.team), str(r.opp), str(r.pos), str(r.stat), str(r.type), num(r.line),
    str(r.dir) || 'over', str(r.book), str(r.lineSource),
    str(r.modelVariant) || 'A', num(r.modelProjection),
    num(r.projMin), num(r.paPerGame), num(r.abPerGame), num(r.battingOrder),
    num(r.probability), num(r.rawProbability), num(r.edge), num(r.edgePct), num(r.edgeSignalPct),
    str(r.grade), num(r.gradeScore), num(r.confidence), num(r.factorsAligned), num(r.factorsTotal),
    r.prime ? 1 : 0,
    num(r.marketLine), num(r.mktGap), jsonOf(r.hitRates), jsonOf(r.factors), jsonOf(r.dataQuality),
    num(r.ts)
  ];
}

// Insert / update a batch of client rows for one slate. Returns { written }.
async function saveSnapshots(snapDate, sport, rows) {
  if (!snapDate || !sport || !Array.isArray(rows) || !rows.length) return { written: 0 };
  let written = 0;
  await store.transaction(async (exec) => {
    for (const r of rows) {
      if (!r || !r.player || !r.stat) continue;
      await exec(UPSERT_SQL, rowParams(snapDate, sport, r));
      written++;
    }
  });
  return { written };
}

async function snapshotSummary() {
  const total = (await store.queryOne(`SELECT COUNT(*) c FROM prop_snapshots`)).c;
  const slates = await store.query(`
    SELECT snap_date, sport, COUNT(*) n FROM prop_snapshots
    GROUP BY snap_date, sport ORDER BY snap_date DESC, sport
  `);
  const graded = (await store.queryOne(`SELECT COUNT(*) c FROM prop_snapshots WHERE result IS NOT NULL`)).c;
  const range = await store.queryOne(`SELECT MIN(snap_date) lo, MAX(snap_date) hi FROM prop_snapshots`);
  return { total, graded, slates, firstDate: range.lo, lastDate: range.hi };
}

async function getSnapshots({ since, sport, limit = 50000 } = {}) {
  const where = [];
  const params = [];
  if (since) { where.push(`snap_date >= ?`); params.push(String(since)); }
  if (sport) { where.push(`sport = ?`); params.push(String(sport)); }
  const sql = `SELECT * FROM prop_snapshots ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY snap_date DESC, sport, player LIMIT ?`;
  params.push(Math.min(Number(limit) || 50000, 200000));
  const rows = await store.query(sql, params);
  return rows.map(row => ({
    ...row,
    hit_rates: row.hit_rates ? JSON.parse(row.hit_rates) : null,
    factors: row.factors ? JSON.parse(row.factors) : null,
    data_quality: row.data_quality ? JSON.parse(row.data_quality) : null
  }));
}

module.exports = { saveSnapshots, snapshotSummary, getSnapshots, store };
