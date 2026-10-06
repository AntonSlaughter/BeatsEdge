// READ-ONLY inventory: how many GENUINE archived NBA provider lines exist locally, over what dates/sources/markets, and could any be joined to a
// real settled outcome (nba_player_box). Opens SQLite files read-only; never writes; never contacts Turso/Render.
//   node scripts/model-integrity/nba-archive-line-inventory.js
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..', '..', 'data');
const out = { files: {} };
for (const f of ['snapshots.db', 'beatsedge.db']) {
  let db; try { db = new DatabaseSync(path.join(root, f), { readOnly: true }); } catch (e) { out.files[f] = 'cannot open: ' + e.message; continue; }
  const tabs = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  const rec = { archiveTables: {} };
  for (const t of tabs.filter(n => /provider_line_archive|line_archive|prop_snapshots/.test(n))) {
    const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; const o = { rows: n };
    if (n) { const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      if (cols.includes('captured_at')) { const r = db.prepare(`SELECT MIN(captured_at) a, MAX(captured_at) b FROM ${t}`).get(); o.capturedFrom = r.a && new Date(r.a).toISOString(); o.capturedTo = r.b && new Date(r.b).toISOString(); }
      if (cols.includes('source')) o.sources = db.prepare(`SELECT source, COUNT(*) n FROM ${t} GROUP BY source ORDER BY n DESC LIMIT 12`).all().map(r => `${r.source}:${r.n}`);
      if (cols.includes('market_key_raw')) o.markets = db.prepare(`SELECT market_key_raw, COUNT(*) n FROM ${t} GROUP BY market_key_raw ORDER BY n DESC LIMIT 15`).all().map(r => `${r.market_key_raw}:${r.n}`);
      if (cols.includes('player_raw')) o.distinctPlayers = db.prepare(`SELECT COUNT(DISTINCT player_raw) c FROM ${t}`).get().c;
      if (cols.includes('event_id')) o.distinctEvents = db.prepare(`SELECT COUNT(DISTINCT event_id) c FROM ${t}`).get().c;
      if (cols.includes('commence_time')) { const r = db.prepare(`SELECT MIN(commence_time) a, MAX(commence_time) b FROM ${t}`).get(); o.commenceFrom = r.a; o.commenceTo = r.b; }
      if (t === 'prop_snapshots') { o.bySport = db.prepare(`SELECT sport, COUNT(*) n, SUM(CASE WHEN result IS NOT NULL THEN 1 ELSE 0 END) settled, MIN(snap_date) a, MAX(snap_date) b FROM prop_snapshots GROUP BY sport`).all().map(r => `${r.sport}:${r.n} settled ${r.settled} ${r.a}..${r.b}`); } }
    rec.archiveTables[t] = o;
  }
  out.files[f] = rec;
}
console.log(JSON.stringify(out, null, 1));
