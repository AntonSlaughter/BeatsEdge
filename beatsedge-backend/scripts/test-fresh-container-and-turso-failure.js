// Simulates the two Render failure modes this whole migration exists to
// fix, using env-var manipulation (no real infrastructure created/changed):
//   1. Fresh container, no local beatsedge.db, Turso configured but
//      unreachable (fake creds) -- healthStatus() must report unhealthy,
//      never silently report a healthy empty local DB as production data.
//   2. "Looks like production" (RENDER/NODE_ENV=production set) with NO
//      Turso configured at all -- must surface an explicit ephemeral
//      warning, never silently continue as if nothing were wrong.
//
//   node scripts/test-fresh-container-and-turso-failure.js

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

(async () => {
  // ---------- Scenario 1: Turso configured but unreachable ----------
  process.env.TURSO_HISTORICAL_DATABASE_URL = 'libsql://fake-invalid-historical-db.turso.io';
  process.env.TURSO_HISTORICAL_AUTH_TOKEN = 'fake-invalid-token';
  delete require.cache[require.resolve('../lib/historicalStore')];
  const storeUnreachable = require('../lib/historicalStore');
  check('1: backend correctly selects turso when both env vars are set', storeUnreachable.backend === 'turso');
  const health1 = await storeUnreachable.healthStatus();
  check('2: healthStatus() reports unhealthy (ok:false) for an unreachable Turso, never silently healthy', health1.ok === false, JSON.stringify(health1));
  check('3: healthStatus() surfaces a real error message, not a generic/empty one', typeof health1.error === 'string' && health1.error.length > 0, JSON.stringify(health1));
  let queryThrew = false;
  try { await storeUnreachable.query('SELECT 1'); } catch (e) { queryThrew = true; }
  check('4: a direct query() against unreachable Turso THROWS (fails loudly) rather than returning empty/fake data', queryThrew);

  delete process.env.TURSO_HISTORICAL_DATABASE_URL;
  delete process.env.TURSO_HISTORICAL_AUTH_TOKEN;

  // ---------- Scenario 2: looks like production, no Turso configured at all ----------
  process.env.NODE_ENV = 'production';
  delete require.cache[require.resolve('../lib/historicalStore')];
  const storeEphemeral = require('../lib/historicalStore');
  check('5: falls back to sqlite backend when Turso is not configured', storeEphemeral.backend === 'sqlite');
  check('6: ephemeralWarning is set when NODE_ENV=production and Turso is not configured', typeof storeEphemeral.ephemeralWarning === 'string' && storeEphemeral.ephemeralWarning.length > 0, storeEphemeral.ephemeralWarning);
  const health2 = await storeEphemeral.healthStatus();
  check('7: healthStatus() still carries the ephemeral warning through even though the local backend itself is technically reachable', typeof health2.ephemeralWarning === 'string' && health2.ephemeralWarning.length > 0);
  delete process.env.NODE_ENV;

  // ---------- Scenario 3: partial Turso config (one var set, not both) fails LOUDLY at require time ----------
  process.env.TURSO_HISTORICAL_DATABASE_URL = 'libsql://only-one-var-set.turso.io';
  delete require.cache[require.resolve('../lib/historicalStore')];
  let threwOnPartialConfig = false;
  try { require('../lib/historicalStore'); } catch (e) { threwOnPartialConfig = true; }
  check('8: partial Turso config (URL set, token missing) throws at require time rather than silently picking a backend', threwOnPartialConfig);
  delete process.env.TURSO_HISTORICAL_DATABASE_URL;

  // ---------- Scenario 4: clean local dev (no env vars) is healthy and NOT flagged ephemeral ----------
  delete require.cache[require.resolve('../lib/historicalStore')];
  const storeLocal = require('../lib/historicalStore');
  const health4 = await storeLocal.healthStatus();
  check('9: local dev (no RENDER/NODE_ENV=production, no Turso) is healthy with NO ephemeral warning -- local dev SQLite use is intentional, not an error state', health4.ok === true && storeLocal.ephemeralWarning === null, JSON.stringify({ ok: health4.ok, warning: storeLocal.ephemeralWarning }));

  console.log(`\n${failures === 0 ? 'ALL FRESH-CONTAINER / TURSO-FAILURE TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
