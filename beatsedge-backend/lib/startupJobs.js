// Gate for the jobs server.js used to run unconditionally ~10 s after EVERY boot (NBA / MLB / NHL nightly updates and the NFL ingest + DvP recompute).
//
// Why: they are the nightly cron's work (06:00 UTC), repeated at boot "so a fresh deploy does not wait a day". On a free-tier instance that sleeps when idle, "every boot" means
// every wake-up: each one re-fetches the previous day from ESPN / NHL / MLB / nflverse and recomputes the rollups, which are thousands of Turso writes, even when the same job had
// completed hours earlier. The nightly jobs already record themselves in the historical database's ingest_log (run_type 'nightly'; notes start 'Date:' for NBA, 'MLB:', 'NHL:'),
// and the NFL pipeline now records 'NFL:'. A job is run at boot only when its last completed run is older than STARTUP_JOB_MIN_AGE_HOURS (default 20; 0 = always run, the previous
// behaviour) or has never run, so a fresh deploy / empty database still catches up immediately, and the 06:00 UTC cron itself is not gated at all.
//
// If the check cannot be answered (the database is unreachable or refusing queries) the job is skipped: it would need that same database to write its results.

const store = require('./historicalStore');
const metrics = require('./resourceMetrics');

const LIKE = { nba: 'Date:%', mlb: 'MLB:%', nhl: 'NHL:%', nfl: 'NFL:%' };
const minAgeHours = () => { const v = process.env.STARTUP_JOB_MIN_AGE_HOURS; const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : 20; };
const decisions = [];   // last decision per job, for /api/resource-metrics

// ingest_log.ran_at is SQLite's datetime('now'): 'YYYY-MM-DD HH:MM:SS' in UTC.
function parseRanAt(s) { if (!s) return null; const t = Date.parse(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z')); return Number.isFinite(t) ? t : null; }

async function decide(job, { now = Date.now(), queryOne = (sql, p) => store.queryOne(sql, p) } = {}) {
  const limit = minAgeHours();
  let d;
  if (!LIKE[job]) d = { job, run: true, reason: 'unknown job: not gated' };
  else if (limit === 0) d = { job, run: true, reason: 'STARTUP_JOB_MIN_AGE_HOURS=0: always run at boot' };
  else {
    try {
      const row = await queryOne(`SELECT MAX(ran_at) AS last FROM ingest_log WHERE run_type = 'nightly' AND notes LIKE ?`, [LIKE[job]]);
      const last = row && row.last ? parseRanAt(row.last) : null;
      if (last == null) d = { job, run: true, reason: 'no completed run recorded', lastRanAt: null };
      else {
        const ageHours = (now - last) / 3_600_000;
        d = ageHours < limit
          ? { job, run: false, reason: `completed ${ageHours.toFixed(1)} h ago (< ${limit} h); the 06:00 UTC cron covers the next run`, lastRanAt: new Date(last).toISOString(), ageHours: Math.round(ageHours * 10) / 10 }
          : { job, run: true, reason: `last completed ${ageHours.toFixed(1)} h ago (>= ${limit} h)`, lastRanAt: new Date(last).toISOString(), ageHours: Math.round(ageHours * 10) / 10 };
      }
    } catch (e) {
      d = { job, run: false, reason: 'skipped: the run history could not be read (' + String(e && e.message || e).slice(0, 120) + ')', error: true };
    }
  }
  d.decidedAt = new Date(now).toISOString();
  const i = decisions.findIndex(x => x.job === job); if (i >= 0) decisions[i] = d; else decisions.push(d);
  metrics.inc(d.run ? 'startup.jobRun.' + job : 'startup.jobSkipped.' + job);
  return d;
}

// Marks a completed pipeline that does not write its own ingest_log row (the NFL child-process pipeline). Never throws.
async function recordCompleted(job, note) {
  const prefix = job.toUpperCase() + ':'; const n = String(note || 'completed');
  try { await store.run(`INSERT INTO ingest_log (run_type, rows_added, notes) VALUES ('nightly', 0, ?)`, [n.startsWith(prefix) ? n : prefix + ' ' + n]); return true; }
  catch (e) { console.warn('[startup] could not record the ' + job + ' run in ingest_log:', e.message); return false; }
}

module.exports = { decide, recordCompleted, parseRanAt, minAgeHours, decisions: () => decisions.slice(), LIKE };
