// In-memory, per-process health/cooldown tracker for the backend's
// third-party data-source passthrough routes (currently: ParlayAPI,
// PropLine — see routes/api.js's /api/parlayapi/* and /api/propline/*).
//
// This module NEVER sees API keys/tokens (routes/api.js passes only a
// provider name + an outcome), so there is nothing secret to log or leak
// here. It exists so a rate-limited/exhausted/unreachable provider stops
// being hammered — every request during an active cooldown is short-
// circuited with a fast, clear "unavailable" response instead of forwarding
// to the upstream provider (see isEligible/recordFailure below) -- and so
// GET /api/data-sources/health has something real to report.
//
// State is per-process (not persisted) -- a Render restart/redeploy resets
// it, which is fine: it exists to protect a live process from repeatedly
// hitting an already-failing provider within that process's own uptime,
// not as a durable record.

const BASE_COOLDOWN_SECONDS = 30;
const MAX_COOLDOWN_SECONDS = 600; // 10 minutes
const MAX_RETRY_AFTER_SECONDS = 3600; // ignore a nonsensical/huge Retry-After

const state = new Map(); // provider -> { status, lastSuccess, lastFailure, cooldownUntil, consecutiveFailures, lastReason }

function get(provider) {
  let s = state.get(provider);
  if (!s) {
    s = { status: 'unknown', lastSuccess: null, lastFailure: null, cooldownUntil: null, consecutiveFailures: 0, lastReason: null };
    state.set(provider, s);
  }
  return s;
}

// True if this provider currently has no active cooldown -- callers should
// check this BEFORE forwarding a request to the real upstream provider.
function isEligible(provider) {
  const s = get(provider);
  return !s.cooldownUntil || Date.now() >= s.cooldownUntil;
}

function recordSuccess(provider) {
  const s = get(provider);
  s.status = 'healthy';
  s.lastSuccess = new Date().toISOString();
  s.cooldownUntil = null;
  s.consecutiveFailures = 0;
  s.lastReason = null;
}

// kind: 'rateLimited' | 'quotaExhausted' | 'authFailed' | 'temporarilyUnavailable' | 'timeout' | 'invalidResponse'
// retryAfterSeconds: parsed from the upstream's own Retry-After header, if any
function recordFailure(provider, { kind, reason, retryAfterSeconds } = {}) {
  const s = get(provider);
  s.status = kind || 'temporarilyUnavailable';
  s.lastFailure = new Date().toISOString();
  s.lastReason = reason || null;
  s.consecutiveFailures += 1;

  let cooldown;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    cooldown = Math.min(retryAfterSeconds, MAX_RETRY_AFTER_SECONDS);
  } else {
    // Bounded exponential backoff: 30s, 60s, 120s, 240s, 480s, capped at 600s.
    cooldown = Math.min(BASE_COOLDOWN_SECONDS * (2 ** (s.consecutiveFailures - 1)), MAX_COOLDOWN_SECONDS);
  }
  s.cooldownUntil = Date.now() + cooldown * 1000;
}

function getHealth(provider) {
  const s = get(provider);
  return {
    provider,
    status: s.status,
    healthy: s.status === 'healthy',
    available: isEligible(provider),
    lastSuccess: s.lastSuccess,
    lastFailure: s.lastFailure,
    cooldownUntil: s.cooldownUntil ? new Date(s.cooldownUntil).toISOString() : null,
    consecutiveFailures: s.consecutiveFailures,
    lastReason: s.lastReason
  };
}

function getAllHealth(providers) {
  return providers.map(getHealth);
}

module.exports = { isEligible, recordSuccess, recordFailure, getHealth, getAllHealth };
