// Prop-snapshot store — the full picture behind every prop BeatsEdge grades
// (model inputs + factor values + data-quality flags + model outputs),
// pushed up from the client each slate. Six months of these + the settled
// results = a real calibration / feature-value dataset.
//
// Deliberately its OWN SQLite file (data/snapshots.db, gitignored) so it is
// never touched by a re-seed of the rebuildable NBA data, and so a
// `git checkout -- data/beatsedge.db` during development can't wipe it.

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'snapshots.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS prop_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snap_date TEXT NOT NULL,          -- the slate date, "YYYY-MM-DD"
    sport TEXT NOT NULL,
    player TEXT NOT NULL,
    team TEXT, opp TEXT, pos TEXT,
    stat TEXT NOT NULL,
    type TEXT,
    line REAL,
    dir TEXT DEFAULT 'over',
    book TEXT,
    line_source TEXT,
    model_projection REAL,
    proj_min REAL,                    -- NBA opportunity
    pa_per_game REAL,                -- MLB batter opportunity
    ab_per_game REAL,
    batting_order INTEGER,
    probability REAL,
    raw_probability REAL,
    edge REAL,
    edge_pct REAL,
    edge_signal_pct REAL,
    grade TEXT,
    grade_score REAL,
    confidence REAL,
    factors_aligned INTEGER,
    factors_total INTEGER,
    prime INTEGER DEFAULT 0,
    market_line REAL,
    mkt_gap REAL,
    hit_rates TEXT,                   -- JSON {season,last10,last5,vsOpp}
    factors TEXT,                     -- JSON {<key>: {s,d,inProj,v}}
    data_quality TEXT,               -- JSON {gameLog,oppDefense,minutes,...}
    -- settled result, filled in later by a results-join job
    actual REAL,
    result TEXT,                      -- 'over' | 'under' | 'push' | null
    graded_at TEXT,
    captured_at INTEGER,             -- client ts
    received_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_prop_snap_unique
    ON prop_snapshots(snap_date, sport, player, stat, line, dir);
  CREATE INDEX IF NOT EXISTS idx_prop_snap_slate ON prop_snapshots(snap_date, sport);
  CREATE INDEX IF NOT EXISTS idx_prop_snap_ungraded ON prop_snapshots(result, snap_date);
`);

// Lazy migrations for DBs created before a column existed.
for (const col of ['proj_min REAL', 'pa_per_game REAL', 'ab_per_game REAL', 'batting_order INTEGER']) {
  try { db.exec(`ALTER TABLE prop_snapshots ADD COLUMN ${col}`); } catch (e) { /* already there */ }
}

const upsert = db.prepare(`
  INSERT INTO prop_snapshots (
    snap_date, sport, player, team, opp, pos, stat, type, line, dir, book, line_source,
    model_projection, proj_min, pa_per_game, ab_per_game, batting_order,
    probability, raw_probability, edge, edge_pct, edge_signal_pct,
    grade, grade_score, confidence, factors_aligned, factors_total, prime,
    market_line, mkt_gap, hit_rates, factors, data_quality, captured_at
  ) VALUES (
    @snap_date, @sport, @player, @team, @opp, @pos, @stat, @type, @line, @dir, @book, @line_source,
    @model_projection, @proj_min, @pa_per_game, @ab_per_game, @batting_order,
    @probability, @raw_probability, @edge, @edge_pct, @edge_signal_pct,
    @grade, @grade_score, @confidence, @factors_aligned, @factors_total, @prime,
    @market_line, @mkt_gap, @hit_rates, @factors, @data_quality, @captured_at
  )
  ON CONFLICT(snap_date, sport, player, stat, line, dir) DO UPDATE SET
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
`);

const num = (x) => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
const str = (x) => (x == null ? null : String(x));
const jsonOf = (x) => { try { return x == null ? null : JSON.stringify(x); } catch (e) { return null; } };

// Insert / update a batch of client rows for one slate. Returns { written }.
function saveSnapshots(snapDate, sport, rows) {
  if (!snapDate || !sport || !Array.isArray(rows) || !rows.length) return { written: 0 };
  let written = 0;
  const tx = db.transaction((list) => {
    for (const r of list) {
      if (!r || !r.player || !r.stat) continue;
      upsert.run({
        snap_date: str(snapDate),
        sport: str(sport),
        player: str(r.player),
        team: str(r.team), opp: str(r.opp), pos: str(r.pos),
        stat: str(r.stat), type: str(r.type), line: num(r.line),
        dir: str(r.dir) || 'over', book: str(r.book), line_source: str(r.lineSource),
        model_projection: num(r.modelProjection),
        proj_min: num(r.projMin), pa_per_game: num(r.paPerGame),
        ab_per_game: num(r.abPerGame), batting_order: num(r.battingOrder),
        probability: num(r.probability),
        raw_probability: num(r.rawProbability), edge: num(r.edge),
        edge_pct: num(r.edgePct), edge_signal_pct: num(r.edgeSignalPct),
        grade: str(r.grade), grade_score: num(r.gradeScore), confidence: num(r.confidence),
        factors_aligned: num(r.factorsAligned), factors_total: num(r.factorsTotal),
        prime: r.prime ? 1 : 0,
        market_line: num(r.marketLine), mkt_gap: num(r.mktGap),
        hit_rates: jsonOf(r.hitRates), factors: jsonOf(r.factors), data_quality: jsonOf(r.dataQuality),
        captured_at: num(r.ts)
      });
      written++;
    }
  });
  tx(rows);
  return { written };
}

function snapshotSummary() {
  const total = db.prepare(`SELECT COUNT(*) c FROM prop_snapshots`).get().c;
  const slates = db.prepare(`
    SELECT snap_date, sport, COUNT(*) n FROM prop_snapshots
    GROUP BY snap_date, sport ORDER BY snap_date DESC, sport
  `).all();
  const graded = db.prepare(`SELECT COUNT(*) c FROM prop_snapshots WHERE result IS NOT NULL`).get().c;
  const range = db.prepare(`SELECT MIN(snap_date) lo, MAX(snap_date) hi FROM prop_snapshots`).get();
  return { total, graded, slates, firstDate: range.lo, lastDate: range.hi };
}

function getSnapshots({ since, sport, limit = 50000 } = {}) {
  const where = [];
  const args = {};
  if (since) { where.push(`snap_date >= @since`); args.since = String(since); }
  if (sport) { where.push(`sport = @sport`); args.sport = String(sport); }
  const sql = `SELECT * FROM prop_snapshots ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY snap_date DESC, sport, player LIMIT @limit`;
  args.limit = Math.min(Number(limit) || 50000, 200000);
  return db.prepare(sql).all(args).map(row => ({
    ...row,
    hit_rates: row.hit_rates ? JSON.parse(row.hit_rates) : null,
    factors: row.factors ? JSON.parse(row.factors) : null,
    data_quality: row.data_quality ? JSON.parse(row.data_quality) : null
  }));
}

module.exports = { db, saveSnapshots, snapshotSummary, getSnapshots };
