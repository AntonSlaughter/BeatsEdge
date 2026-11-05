// Upstream credit budget for the ParlayAPI passthrough (routes/api.js). Every upstream call that is NOT answered from the response cache costs provider credits; this module is the one
// place that decides whether another one may be made, so a refresh loop in a browser (or a bug) cannot spend the monthly allowance faster than intended.
//
//   hourly cap   PARLAY_HOURLY_CREDIT_BUDGET   default 450   credits spent in the last 60 minutes   (canary value; one complete NBA board is ~153 credits)
//   daily cap    PARLAY_DAILY_CREDIT_BUDGET    default 1500  credits spent in the last 24 hours     (first-day canary value; raise by environment variable after the canary)
//   reserve      PARLAY_CREDIT_RESERVE         default 1000  stop calling when the provider itself reports fewer credits than this remaining
//
// BOARD MODE (default, PARLAY_BUDGET_MODE=board) -- why: the page builds one board from ~20-50 requests. A per-call cap that trips in the middle of those requests yields a board with
// whole books or markets missing, and the page still shows its green "LIVE" pill for it. So the budget is enforced per BOARD (one sport's /props requests):
//   * a board may START only if the whole board is affordable: remaining hourly AND daily credits >= the board reserve, i.e. max(PARLAY_BOARD_RESERVE_CREDITS (default 160, one NBA
//     board is 153), 1.25 x the average cost of the boards actually loaded since start);
//   * a board in progress (the sport made an upstream call within PARLAY_BOARD_LEASE_SECONDS, default 150) is allowed to FINISH even if that crosses the cap, up to
//     PARLAY_BOARD_OVERSHOOT_CREDITS (default 100) past it -- a hard stop that an NBA board never reaches;
//   * when no board is affordable, EVERY /props request for that sport is refused (503, x-credit-budget: board-denied), cache hits included, because serving the cached part of a
//     board while refusing the rest would also be a partial board. The browser keeps the board it already has and shows its own error state.
// PARLAY_BUDGET_MODE=call restores the plain per-call cap (the first patch's behaviour). Requests that are not a sport's /props board always use the per-call rule.
//
// What a call costs: the provider's own `x-credits-cost` response header when it sends one (a measured value), otherwise PARLAY_ASSUMED_CALL_COST (default 3 -- the documented price; the
// provider sends no credit headers on /props today, so every charge is the assumption and the provider dashboard is the only record of the true balance). The `x-credits-remaining`
// header, when present, is honoured: a reserve denial holds for one hour and then ONE call is allowed through to re-read the balance.
//
// State is per process and in memory (like lib/dataSourceHealth.js); a restart clears it. It never sees an API key: callers pass a provider name, a sport key and response metadata.

const HOUR_MS = 3_600_000, DAY_MS = 24 * HOUR_MS;
const envNum = (name, def, min = 0) => { const v = Number(process.env[name]); return Number.isFinite(v) && v >= min && process.env[name] !== '' && process.env[name] != null ? v : def; };

function limits() {
  return {
    hourly: envNum('PARLAY_HOURLY_CREDIT_BUDGET', 450, 1),
    daily: envNum('PARLAY_DAILY_CREDIT_BUDGET', 1500, 1),
    reserve: envNum('PARLAY_CREDIT_RESERVE', 1000, 0),
    assumedCost: envNum('PARLAY_ASSUMED_CALL_COST', 3, 0),
    boardMode: process.env.PARLAY_BUDGET_MODE !== 'call',
    boardReserveMin: envNum('PARLAY_BOARD_RESERVE_CREDITS', 160, 0),
    leaseMs: envNum('PARLAY_BOARD_LEASE_SECONDS', 150, 10) * 1000,
    overshoot: envNum('PARLAY_BOARD_OVERSHOOT_CREDITS', 100, 0),
  };
}

const state = new Map(); // provider -> { spends, remaining, remainingAt, calls, chargedByHeader, chargedByAssumption, denied, leases, boardCost, boards }
function get(provider) {
  let s = state.get(provider);
  if (!s) { s = { spends: [], remaining: null, remainingAt: null, calls: 0, chargedByHeader: 0, chargedByAssumption: 0, denied: { hourly: 0, daily: 0, reserve: 0, board: 0, overshoot: 0 }, leases: new Map(), boardCost: null, boards: { started: 0, completed: 0, denied: 0, blockedRequests: 0, overshootStops: 0 } }; state.set(provider, s); }
  return s;
}
function prune(s, now) { const cut = now - DAY_MS; let i = 0; while (i < s.spends.length && s.spends[i].t < cut) i++; if (i) s.spends.splice(0, i); }
function spentSince(s, since) { let n = 0; for (let i = s.spends.length - 1; i >= 0 && s.spends[i].t >= since; i--) n += s.spends[i].credits; return n; }

// Seconds until `needed` more credits are free in a rolling window of `windowMs` (the spends that age out first free credits first).
function secondsUntilFree(s, now, windowMs, needed) {
  let freed = 0;
  for (const x of s.spends) { if (x.t < now - windowMs) continue; freed += x.credits; if (freed >= needed) return Math.max(1, Math.ceil((x.t + windowMs - now) / 1000)); }
  return Math.max(1, Math.ceil(windowMs / 1000));
}
function reserveRule(s, L, now) {   // the provider's own reported balance
  if (s.remaining != null && s.remaining < L.reserve && s.remainingAt != null && now - s.remainingAt < HOUR_MS) {
    s.denied.reserve++;
    return { allowed: false, reason: 'reserve', retryAfterSeconds: Math.max(1, Math.ceil((s.remainingAt + HOUR_MS - now) / 1000)), detail: `provider reports ${s.remaining} credits remaining, below the ${L.reserve} reserve` };
  }
  return null;
}

// Per-call rule: { allowed: true } or { allowed: false, reason: 'hourly'|'daily'|'reserve', retryAfterSeconds, detail }. Call BEFORE an upstream request.
function check(provider, now = Date.now()) {
  const s = get(provider), L = limits(); prune(s, now);
  const rr = reserveRule(s, L, now); if (rr) return rr;
  const hour = spentSince(s, now - HOUR_MS);
  if (hour >= L.hourly) {
    s.denied.hourly++;
    return { allowed: false, reason: 'hourly', retryAfterSeconds: secondsUntilFree(s, now, HOUR_MS, hour - L.hourly + 1), detail: `${hour} of ${L.hourly} credits spent in the last hour` };
  }
  const day = spentSince(s, now - DAY_MS);
  if (day >= L.daily) {
    s.denied.daily++;
    return { allowed: false, reason: 'daily', retryAfterSeconds: secondsUntilFree(s, now, DAY_MS, day - L.daily + 1), detail: `${day} of ${L.daily} credits spent in the last 24 hours` };
  }
  return { allowed: true };
}

function leaseActive(s, L, scope, now) { const l = s.leases.get(scope); return !!l && now - l.lastAt < L.leaseMs; }
function boardReserve(s, L) { return Math.max(L.boardReserveMin, s.boardCost != null ? Math.ceil(s.boardCost * 1.25) : 0); }
function finishLease(s, scope) {   // fold a finished board's real cost into the running average the reserve is based on
  const l = s.leases.get(scope); if (!l) return;
  if (l.spent > 0) { s.boardCost = s.boardCost == null ? l.spent : Math.round((s.boardCost * 0.5 + l.spent * 0.5) * 10) / 10; s.boards.completed++; }
  s.leases.delete(scope);
}
// Can a NEW board start now? null when yes, otherwise the denial. No side effects except the denial counters when `count` is set.
function boardStartDenial(s, L, now, count) {
  const need = boardReserve(s, L), hour = spentSince(s, now - HOUR_MS), day = spentSince(s, now - DAY_MS);
  if (L.hourly - hour < need) { if (count) s.denied.board++; return { allowed: false, reason: 'board-hourly', retryAfterSeconds: secondsUntilFree(s, now, HOUR_MS, need - (L.hourly - hour)), detail: `a board needs ~${need} credits and only ${Math.max(0, L.hourly - hour)} of the ${L.hourly} hourly credits remain` }; }
  if (L.daily - day < need) { if (count) s.denied.board++; return { allowed: false, reason: 'board-daily', retryAfterSeconds: secondsUntilFree(s, now, DAY_MS, need - (L.daily - day)), detail: `a board needs ~${need} credits and only ${Math.max(0, L.daily - day)} of the ${L.daily} daily credits remain` }; }
  return null;
}

// Gate for EVERY request of a sport's /props board (cache hits included), before the cache is consulted: when no board can be afforded and none is in progress, refuse the sport as a whole so a
// partial board cannot be assembled from cache + refusals. null = go on. Per-call mode and unscoped requests are never gated here.
function blockedFor(provider, scope, now = Date.now()) {
  const L = limits(); if (!L.boardMode || !scope) return null;
  const s = get(provider); prune(s, now);
  if (leaseActive(s, L, scope, now)) return null;
  const rr = reserveRule(s, L, now); const d = rr || boardStartDenial(s, L, now, false);
  if (d) s.boards.blockedRequests++;
  return d;
}

// Decision for one upstream call that the cache could not answer. `scope` = the sport key of a /props board, or null.
function admit(provider, scope, now = Date.now()) {
  const L = limits(); if (!L.boardMode || !scope) return check(provider, now);
  const s = get(provider); prune(s, now);
  const rr = reserveRule(s, L, now); if (rr) return rr;
  if (leaseActive(s, L, scope, now)) {   // a board in progress may finish, up to a hard overshoot
    const hour = spentSince(s, now - HOUR_MS), day = spentSince(s, now - DAY_MS);
    if (hour >= L.hourly + L.overshoot || day >= L.daily + L.overshoot) {
      s.denied.overshoot++; s.boards.overshootStops++;
      return { allowed: false, reason: 'overshoot', retryAfterSeconds: secondsUntilFree(s, now, hour >= L.hourly + L.overshoot ? HOUR_MS : DAY_MS, 1), detail: `board in progress reached the hard stop (${L.overshoot} credits past the cap): ${hour} credits this hour, ${day} in 24 h` };
    }
    s.leases.get(scope).lastAt = now; return { allowed: true, board: 'continue' };
  }
  finishLease(s, scope);
  const d = boardStartDenial(s, L, now, true);
  if (d) { s.boards.denied++; return d; }
  s.leases.set(scope, { startedAt: now, lastAt: now, spent: 0 }); s.boards.started++;
  return { allowed: true, board: 'start' };
}

// Record one upstream call that actually reached the provider. `headers` is a plain object (lowercase names) or anything with .get(name). `scope` attributes the spend to its board.
function record(provider, { status, headers } = {}, now = Date.now(), scope = null) {
  const s = get(provider), L = limits();
  const h = (name) => { if (!headers) return null; const v = typeof headers.get === 'function' ? headers.get(name) : headers[name]; return v == null || v === '' ? null : v; };
  // A header that is ABSENT must stay absent: Number(null) is 0, which would read as "costs nothing" / "0 credits left" (and the reserve rule would then block every call).
  const rawCost = h('x-credits-cost'), rawRemaining = h('x-credits-remaining');
  const cost = rawCost == null ? NaN : Number(rawCost), remaining = rawRemaining == null ? NaN : Number(rawRemaining);
  let credits;
  if (Number.isFinite(cost) && cost >= 0) { credits = cost; s.chargedByHeader++; } else { credits = L.assumedCost; s.chargedByAssumption++; }
  s.calls++;
  if (credits > 0) s.spends.push({ t: now, credits });
  if (scope && s.leases.has(scope)) { const l = s.leases.get(scope); l.spent += credits; l.lastAt = now; }
  if (Number.isFinite(remaining) && remaining >= 0) { s.remaining = remaining; s.remainingAt = now; }
  prune(s, now);
  return { credits, status };
}

function stats(provider = 'parlayapi', now = Date.now()) {
  const s = get(provider), L = limits(); prune(s, now);
  return {
    provider, mode: L.boardMode ? 'board' : 'call',
    limits: { hourlyCredits: L.hourly, dailyCredits: L.daily, reserveCredits: L.reserve, assumedCostPerCall: L.assumedCost, boardReserveCredits: boardReserve(s, L), boardOvershootCredits: L.overshoot, boardLeaseSeconds: L.leaseMs / 1000 },
    spentLastHour: spentSince(s, now - HOUR_MS), spentLast24h: spentSince(s, now),
    upstreamCalls: s.calls, chargedByProviderHeader: s.chargedByHeader, chargedByAssumption: s.chargedByAssumption,
    providerReportedRemaining: s.remaining, providerReportedRemainingAt: s.remainingAt ? new Date(s.remainingAt).toISOString() : null,
    denied: { ...s.denied },
    boards: { ...s.boards, averageCostCredits: s.boardCost, inProgress: [...s.leases.entries()].filter(([k]) => leaseActive(s, L, k, now)).map(([k, l]) => ({ sport: k, spentCredits: l.spent })) },
  };
}

function _reset() { state.clear(); }
module.exports = { check, admit, blockedFor, record, stats, limits, _reset };
