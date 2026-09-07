const Module = require('module');
const path = require('path');

// Mock global fetch for this specific test only
const originalFetch = global.fetch;
global.fetch = async (url) => {
  if (url.includes('probablePitcher')) {
    return {
      ok: true,
      json: async () => ({
        dates: [{
          games: [
            {
              teams: {
                away: { team: { abbreviation: 'NYY' }, probablePitcher: { id: 12345, fullName: 'Gerrit Cole' } },
                home: { team: { abbreviation: 'BOS' }, probablePitcher: { id: 67890, fullName: 'Test Sox Starter' } }
              }
            }
          ]
        }]
      })
    };
  }
  return originalFetch(url);
};

const { fetchProbablePitchers } = require('../lib/mlbProxy');

async function main() {
  console.log('=== Probable Pitcher Lookup Test ===\n');
  const result = await fetchProbablePitchers('2026-09-06');

  let pass = 0, fail = 0;
  function check(cond, label) { console.log(`${cond ? '✓' : '✗'} ${label}`); cond ? pass++ : fail++; }

  check(result.BOS && result.BOS.pitcherName === 'Gerrit Cole', `BOS batters correctly see NYY's starter (Cole) as opposing pitcher, got: ${result.BOS && result.BOS.pitcherName}`);
  check(result.NYY && result.NYY.pitcherName === 'Test Sox Starter', `NYY batters correctly see BOS's starter as opposing pitcher, got: ${result.NYY && result.NYY.pitcherName}`);
  check(result.BOS && result.BOS.pitcherId === '12345', `Cole's ID correctly captured as string: ${result.BOS && result.BOS.pitcherId}`);

  global.fetch = originalFetch;
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main();
