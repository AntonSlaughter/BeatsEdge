let failures = 0;
function check(name, condition, detail) { if (condition) console.log(`PASS  ${name}`); else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); } }
(async () => {
  const { getTeamScheduleContext } = require('../lib/situationalEngine');
  const store = require('../lib/historicalStore');
  const sample = await store.queryOne(`SELECT sport, team, game_id FROM team_schedule LIMIT 1`);
  check('1: real team_schedule sample row exists locally', !!sample, JSON.stringify(sample));
  if (sample) {
    const ctx = await getTeamScheduleContext(sample.sport, sample.team, sample.game_id);
    check('2: getTeamScheduleContext returns real data (not null) for a real row', !!ctx, JSON.stringify(ctx));
    check('3: returned context has is_home/rest_days/is_back_to_back fields (schema fix confirmed working)', ctx && 'is_home' in ctx && 'rest_days' in ctx && 'is_back_to_back' in ctx, JSON.stringify(ctx));
  }
  console.log(`\n${failures === 0 ? 'ALL SITUATIONAL CONVERSION TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
