// Re-sync NHL skater/goalie box rows for a date range through the EXISTING sync (lib/nhlPlayerBoxSync.syncBoxscoreToPlayerBox), so rows stored before its 2026-10-14 fix get their source toi_seconds / plus_minus / home_away.
// What a write run does to the store (the sync is an upsert, so there are exactly two kinds of change):
//   UPDATE  a stored row whose home_away / toi_seconds / plus_minus is NULL gets the source value (COALESCE: a stored value is never overwritten; no other column changes)
//   INSERT  a player in the boxscore with NO stored row for that game gets a new row (the nightly sync does the same)
// Reads only the free, keyless NHL API (api-web.nhle.com) and the store.
//   node scripts/nhl-resync-player-box.js --from 2026-10-07 --to 2026-10-19            DRY RUN (default): fetches boxscores, writes NOTHING (no store change, no journal), reports what a write would update / insert
//   ... --write [--journal <file>]                                                      writes (local SQLite only) and records every changed row's exact ORIGINAL and WRITTEN values in a JSONL journal (default ./nhl-resync-journal-<from>-<to>-<timestamp>.jsonl; an existing file is never overwritten)
//   ... --write --allow-remote                                                          required to write when the historical store is Turso (production): a deliberate, separately approved step
//   node scripts/nhl-resync-player-box.js --rollback <journal>                          ROLLBACK DRY RUN (default): reports what would be restored / kept, changes nothing
//   node scripts/nhl-resync-player-box.js --rollback <journal> --write [--allow-remote]  restores ONLY what this run changed and that still holds exactly the value this run wrote (see rollback() below); nothing else is touched
const fs = require('fs'), path = require('path');
const TRACKED = ['home_away', 'toi_seconds', 'plus_minus'];
const sameVal = (a, b) => (a == null && b == null) || (a != null && b != null && a === b);   // null-safe strict equality; numbers from SQLite are plain JS numbers
const key = (r) => String(r.game_id) + '\u0000' + String(r.player_id);
const colsOf = (r) => Object.keys(r).filter(k => !/^\d+$/.test(k));   /* a libSQL row may carry numeric index keys next to the column names */
const plain = (r) => { const o = {}; colsOf(r).forEach(c => { o[c] = r[c]; }); return o; };
const readGame = (store, gameId) => store.query('SELECT * FROM nhl_player_box WHERE CAST(game_id AS TEXT) = ?', [String(gameId)]);   /* the id is text in the store and a number in the schedule: compare as text */
const jline = (file, obj) => fs.appendFileSync(file, JSON.stringify(obj) + '\n');

// One game. deps: { store, sync, sourceFields }. opts: { write, journalFile }. Returns counts; with write it journals the observed before -> after difference (one line per game, written right after that game's sync).
async function processGame(deps, box, date, gameId, opts) {
  const { store, sync, sourceFields } = deps; const out = { storedRows: 0, rowsToFill: { home_away: 0, toi_seconds: 0, plus_minus: 0 }, rowsToInsert: 0, updated: 0, inserted: 0, unexpected: 0 };
  const before = await readGame(store, gameId); out.storedRows = before.length; const have = new Map(before.map(r => [String(r.player_id), r]));
  const parsed = require('../lib/nhlEngine').parseBoxscore(box, date, gameId); const written = new Set(parsed.skaterRows.concat(parsed.goalieRows).map(r => String(r.player_id)));   /* the sync stores only the players the parser returns (a listed player with no stat line gets no row) */
  sourceFields(box).forEach((f, pid) => { const r = have.get(pid); if (!r) { if (written.has(pid)) out.rowsToInsert++; return; } TRACKED.forEach(c => { if (r[c] == null && f[c] != null) out.rowsToFill[c]++; }); });
  if (!opts.write) return out;
  let syncErr = null; try { await sync(box, date, gameId); } catch (e) { syncErr = e; }   /* journal whatever did change even if the sync threw part-way */
  const after = await readGame(store, gameId); const beforeMap = new Map(before.map(r => [key(r), r])); const changes = [];
  for (const a of after) {
    const b = beforeMap.get(key(a));
    if (!b) { changes.push({ type: 'insert', game_id: String(a.game_id), player_id: String(a.player_id), row: plain(a) }); out.inserted++; continue; }
    const fields = []; let other = false;
    colsOf(a).forEach(c => { if (sameVal(a[c], b[c])) return; if (TRACKED.indexOf(c) >= 0 && b[c] == null) fields.push({ column: c, original: null, written: a[c] }); else other = true; });
    if (other) out.unexpected++;                       /* a stored value changed, or an untracked column changed: never expected from this sync; reported, never journalled as ours */
    if (fields.length) { changes.push({ type: 'update', game_id: String(a.game_id), player_id: String(a.player_id), fields }); out.updated++; }
  }
  if (changes.length) jline(opts.journalFile, { type: 'game', gameId: String(gameId), date, changes });
  if (syncErr) throw syncErr;
  return out;
}

function readJournal(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l, i) => { try { return JSON.parse(l); } catch (e) { throw new Error('journal line ' + (i + 1) + ' is not valid JSON'); } });
  if (!lines.length || lines[0].type !== 'header') throw new Error('not a re-sync journal (no header line)');
  return { header: lines[0], games: lines.slice(1).filter(l => l.type === 'game') };
}

// Rollback. Restores a changed field to its recorded ORIGINAL only while the stored value is still exactly the value this run WROTE; deletes a row this run INSERTED only while every column still equals what this run inserted.
// A value changed by anything later (a later sync, the nightly job, a correction) no longer matches and is kept; a row that is already gone or already restored is reported, not touched. The guard is part of each UPDATE / DELETE statement, so a change between the check and the write cannot be overwritten.
async function rollback(store, journalFile, opts) {
  const { header, games } = readJournal(journalFile); const rep = { restoredFields: 0, deletedRows: 0, alreadyOriginal: 0, keptChangedSince: [], keptRowModified: [], rowGone: 0, wouldRestoreFields: 0, wouldDeleteRows: 0 };
  if (header.backend && header.backend !== store.backend) throw new Error(`journal was written against the '${header.backend}' store but the current store is '${store.backend}': refusing`);
  for (const g of games.slice().reverse()) for (const ch of g.changes.slice().reverse()) {
    const cur = (await store.query('SELECT * FROM nhl_player_box WHERE game_id = ? AND player_id = ?', [ch.game_id, ch.player_id]))[0];
    if (ch.type === 'update') for (const f of ch.fields) {
      if (!cur) { rep.rowGone++; continue; }
      if (sameVal(cur[f.column], f.written)) {
        if (!opts.write) { rep.wouldRestoreFields++; continue; }
        const r = await store.run(`UPDATE nhl_player_box SET ${f.column} = ? WHERE game_id = ? AND player_id = ? AND ${f.column} IS ?`, [f.original, ch.game_id, ch.player_id, f.written]);
        if (r.changes === 1) rep.restoredFields++; else rep.keptChangedSince.push(`${ch.game_id}/${ch.player_id}.${f.column}`);
      } else if (sameVal(cur[f.column], f.original)) rep.alreadyOriginal++;
      else rep.keptChangedSince.push(`${ch.game_id}/${ch.player_id}.${f.column}`);
    } else if (ch.type === 'insert') {
      if (!cur) { rep.rowGone++; continue; }
      const cols = Object.keys(ch.row); const equal = cols.every(c => sameVal(cur[c], ch.row[c])) && colsOf(cur).every(c => cols.indexOf(c) >= 0);
      if (!equal) { rep.keptRowModified.push(`${ch.game_id}/${ch.player_id}`); continue; }
      if (!opts.write) { rep.wouldDeleteRows++; continue; }
      const r = await store.run(`DELETE FROM nhl_player_box WHERE game_id = ? AND player_id = ? AND ${cols.map(c => `${c} IS ?`).join(' AND ')}`, [ch.game_id, ch.player_id, ...cols.map(c => ch.row[c])]);
      if (r.changes === 1) rep.deletedRows++; else rep.keptRowModified.push(`${ch.game_id}/${ch.player_id}`);
    }
  }
  return rep;
}

async function main() {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; }; const flag = (k) => process.argv.includes('--' + k);
  const store = require('../lib/historicalStore'); const WRITE = flag('write'), REMOTE_OK = flag('allow-remote'); const rb = arg('rollback');
  if (rb) {
    console.log(`[rollback] store backend: ${store.backend}; ${WRITE ? 'WRITE' : 'DRY RUN'}; journal ${rb}`);
    if (WRITE && store.backend !== 'sqlite' && !REMOTE_OK) { console.error('[rollback] refusing to write to a non-local store without --allow-remote'); process.exit(3); }
    const rep = await rollback(store, rb, { write: WRITE }); console.log('[rollback] ' + JSON.stringify(rep)); console.log(WRITE ? '[rollback] done: only fields / rows still holding this run\'s written values were restored; everything listed under kept* was left as it is.' : '[rollback] dry run only: nothing was changed.'); process.exit(0);
  }
  const { fetchSchedule, fetchBoxscore } = require('../lib/nhlProxy'); const { syncBoxscoreToPlayerBox, sourceFields } = require('../lib/nhlPlayerBoxSync');
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; const from = arg('from'), to = arg('to', new Date().toISOString().slice(0, 10));
  if (!DATE_RE.test(String(from)) || !DATE_RE.test(String(to)) || from > to) { console.error('usage: --from YYYY-MM-DD [--to YYYY-MM-DD] [--write [--journal <file>] [--allow-remote]]   |   --rollback <journal> [--write] [--allow-remote]'); process.exit(2); }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const polite = async (fn) => { for (let attempt = 0; attempt < 5; attempt++) { try { await sleep(350); return await fn(); } catch (e) { if (!/429|5\d\d/.test(String(e.message)) || attempt === 4) throw e; await sleep(2000 * (attempt + 1)); } } };   // ~3 requests/s, backing off on a 429 / 5xx
  const days = (a, b) => { const out = []; for (let t = Date.parse(a + 'T12:00:00Z'); t <= Date.parse(b + 'T12:00:00Z'); t += 864e5) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
  console.log(`[resync] store backend: ${store.backend}; ${WRITE ? 'WRITE' : 'DRY RUN'}; ${from} .. ${to}`);
  if (WRITE && store.backend !== 'sqlite' && !REMOTE_OK) { console.error('[resync] refusing to write to a non-local store without --allow-remote'); process.exit(3); }
  let journalFile = null; if (WRITE) { journalFile = path.resolve(arg('journal', `nhl-resync-journal-${from}-${to}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)); if (fs.existsSync(journalFile)) { console.error('[resync] refusing to overwrite an existing journal: ' + journalFile); process.exit(3); } jline(journalFile, { type: 'header', version: 1, tool: 'nhl-resync-player-box', startedAt: new Date().toISOString(), backend: store.backend, from, to }); console.log('[resync] journal: ' + journalFile); }
  const tot = { dates: 0, games: 0, boxFetched: 0, skipped: 0, storedRows: 0, rowsToFillToi: 0, rowsToFillPm: 0, rowsToFillHomeAway: 0, rowsToInsert: 0, updatedRows: 0, insertedRows: 0, unexpected: 0, failed: 0 };
  for (const d of days(from, to)) {
    let games = []; try { const s = await polite(() => fetchSchedule(d)); games = (s.gameWeek && s.gameWeek[0] && s.gameWeek[0].games) || []; } catch (e) { console.warn(`[resync] schedule ${d} failed: ${e.message}`); tot.failed++; continue; }
    tot.dates++;
    for (const g of games) {
      if (g.gameState && g.gameState !== 'OFF' && g.gameState !== 'FINAL') { tot.skipped++; continue; } tot.games++;
      try {
        const box = await polite(() => fetchBoxscore(g.id)); tot.boxFetched++;
        const r = await processGame({ store, sync: syncBoxscoreToPlayerBox, sourceFields }, box, d, g.id, { write: WRITE, journalFile });
        tot.storedRows += r.storedRows; tot.rowsToFillToi += r.rowsToFill.toi_seconds; tot.rowsToFillPm += r.rowsToFill.plus_minus; tot.rowsToFillHomeAway += r.rowsToFill.home_away; tot.rowsToInsert += r.rowsToInsert; tot.updatedRows += r.updated; tot.insertedRows += r.inserted; tot.unexpected += r.unexpected;
      } catch (e) { console.warn(`[resync] game ${g.id} (${d}) failed: ${e.message}`); tot.failed++; }
    }
  }
  console.log('[resync] ' + JSON.stringify(tot)); console.log(WRITE ? `[resync] done (writes applied). Roll back with: node scripts/nhl-resync-player-box.js --rollback ${journalFile}` : '[resync] dry run only: nothing was written.');
  process.exit(0);
}
module.exports = { processGame, rollback, readJournal };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
