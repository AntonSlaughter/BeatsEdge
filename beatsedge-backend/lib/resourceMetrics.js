// Tiny in-process counters for the resource-use report (GET /api/resource-metrics). Flat name -> number, no labels, no request data, nothing that could carry a key
// or a user value: callers pass a fixed counter name and an amount. State is per process and resets on a restart (like lib/dataSourceHealth.js).
const counters = new Map();
const startedAt = Date.now();
function inc(name, n = 1) { counters.set(name, (counters.get(name) || 0) + n); }
function get(name) { return counters.get(name) || 0; }
function snapshot() { const out = {}; for (const k of [...counters.keys()].sort()) out[k] = counters.get(k); return out; }
function uptimeSeconds() { return Math.round((Date.now() - startedAt) / 1000); }
function _reset() { counters.clear(); }
module.exports = { inc, get, snapshot, uptimeSeconds, _reset };
