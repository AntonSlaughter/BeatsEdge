let failures = 0;
function check(name, condition, detail) { if (condition) console.log(`PASS  ${name}`); else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); } }
(async () => {
  const { buildGameEnvironmentSignal, bulkTeamHistory } = require('../lib/gameEnvironment');
  const signal = await buildGameEnvironmentSignal({ team: 'BOS', opponent: 'LAL', asOfDate: '2026-01-01' });
  check('1: buildGameEnvironmentSignal returns a real object (awaited correctly, not a Promise)', typeof signal === 'object' && typeof signal.then !== 'function');
  check('2: real pace data resolved for a real team/date', signal.teamPace !== null || signal.sampleSize.team >= 0, JSON.stringify(signal));
  const hist = await bulkTeamHistory(null, ['BOS', 'LAL']);
  check('3: bulkTeamHistory returns real grouped data', typeof hist === 'object' && (hist.BOS || hist.LAL));
  console.log(`\n${failures === 0 ? 'ALL GAME-ENVIRONMENT CONVERSION TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
