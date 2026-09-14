// Real test of lib/dataSourceHealth.js -- the per-provider cooldown/health
// tracker behind routes/api.js's ParlayAPI/PropLine passthroughs. Pure
// in-memory module, no network/DB involved, so this runs the actual
// exported functions directly rather than mocking them.

const assert = require('assert');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? ' -- ' + detail : ''}`);
  if (cond) pass++; else fail++;
}

(async () => {
  console.log('=== dataSourceHealth test ===\n');

  // Fresh module instance per test section so failure counts/cooldowns
  // from one section never bleed into another.
  const freshModule = () => {
    delete require.cache[require.resolve('../lib/dataSourceHealth')];
    return require('../lib/dataSourceHealth');
  };

  // --- 1. Unknown provider starts eligible (never seen = never failed) ---
  {
    const h = freshModule();
    ok(h.isEligible('parlayapi') === true, 'unknown provider starts eligible');
    const health = h.getHealth('parlayapi');
    ok(health.status === 'unknown' && health.lastSuccess === null && health.lastFailure === null, 'unknown provider has clean initial state', JSON.stringify(health));
  }

  // --- 2. recordSuccess -> healthy, eligible, no cooldown ---
  {
    const h = freshModule();
    h.recordSuccess('parlayapi');
    const health = h.getHealth('parlayapi');
    ok(health.status === 'healthy' && health.healthy === true, 'recordSuccess marks healthy');
    ok(health.available === true && health.cooldownUntil === null, 'healthy provider has no cooldown');
    ok(typeof health.lastSuccess === 'string', 'lastSuccess timestamp recorded');
  }

  // --- 3. 429 with explicit Retry-After -> cooldown matches Retry-After, not eligible until then ---
  {
    const h = freshModule();
    h.recordFailure('parlayapi', { kind: 'rateLimited', reason: 'HTTP 429', retryAfterSeconds: 5 });
    ok(h.isEligible('parlayapi') === false, '429 with Retry-After: provider ineligible immediately after');
    const health = h.getHealth('parlayapi');
    ok(health.status === 'rateLimited', '429 sets status=rateLimited', health.status);
    const cooldownMs = new Date(health.cooldownUntil).getTime() - Date.now();
    ok(cooldownMs > 4000 && cooldownMs <= 5000, 'cooldown honors the explicit Retry-After value (~5s)', `${cooldownMs}ms`);
  }

  // --- 4. 429/5xx with NO Retry-After -> bounded exponential backoff, never infinite/unbounded ---
  {
    const h = freshModule();
    const cooldowns = [];
    for (let i = 0; i < 6; i++) {
      h.recordFailure('parlayapi', { kind: 'temporarilyUnavailable', reason: 'HTTP 503' });
      const health = h.getHealth('parlayapi');
      cooldowns.push(Math.round((new Date(health.cooldownUntil).getTime() - Date.now()) / 1000));
    }
    ok(cooldowns[0] >= 25 && cooldowns[0] <= 30, 'first failure: ~30s backoff', `${cooldowns[0]}s`);
    ok(cooldowns[1] > cooldowns[0], 'backoff increases on repeated failure', cooldowns.join(','));
    ok(cooldowns[5] <= 600, 'backoff is capped (bounded), not unbounded', `${cooldowns[5]}s after 6 failures`);
    ok(new Set(cooldowns).size > 1, 'not a flat/fixed cooldown -- genuinely exponential', cooldowns.join(','));
  }

  // --- 5. Provider in cooldown stays ineligible; recovers once cooldown passes ---
  {
    const h = freshModule();
    h.recordFailure('parlayapi', { kind: 'rateLimited', reason: 'HTTP 429', retryAfterSeconds: 0.2 });
    ok(h.isEligible('parlayapi') === false, 'ineligible immediately during cooldown window');
    await new Promise(r => setTimeout(r, 350));
    ok(h.isEligible('parlayapi') === true, 'eligible again once the cooldown window has elapsed (provider recovers)');
  }

  // --- 6. recordSuccess after failures clears cooldown and resets failure streak ---
  {
    const h = freshModule();
    h.recordFailure('parlayapi', { kind: 'rateLimited', reason: 'HTTP 429', retryAfterSeconds: 300 });
    ok(h.isEligible('parlayapi') === false, 'ineligible after a long cooldown');
    h.recordSuccess('parlayapi');
    ok(h.isEligible('parlayapi') === true, 'a later success immediately clears the cooldown');
    const health = h.getHealth('parlayapi');
    ok(health.consecutiveFailures === 0, 'success resets the consecutive-failure counter', health.consecutiveFailures);
  }

  // --- 7. Providers are tracked independently (parlayapi failing does not affect propline) ---
  {
    const h = freshModule();
    h.recordFailure('parlayapi', { kind: 'rateLimited', reason: 'HTTP 429', retryAfterSeconds: 300 });
    h.recordSuccess('propline');
    ok(h.isEligible('parlayapi') === false, 'parlayapi still in cooldown');
    ok(h.isEligible('propline') === true, 'propline unaffected by parlayapi cooldown -- independent state');
  }

  // --- 8. getHealth never includes anything resembling a key/token/secret field ---
  {
    const h = freshModule();
    h.recordFailure('parlayapi', { kind: 'authFailed', reason: 'HTTP 401' });
    const health = h.getHealth('parlayapi');
    const keys = Object.keys(health);
    const suspicious = keys.filter(k => /key|token|secret|auth(?!Failed)/i.test(k));
    ok(suspicious.length === 0, 'getHealth() exposes no key/token/secret-shaped field', JSON.stringify(keys));
    ok(JSON.stringify(health).toLowerCase().indexOf('bearer') === -1, 'serialized health payload never contains "bearer"');
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
