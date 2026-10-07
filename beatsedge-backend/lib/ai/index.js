'use strict';
// BeatsEdge AI foundation (Phase 1A): provider-independent context -> deterministic evidence -> routed question -> (future) LLM explanation.
module.exports = Object.assign({}, require('./constants'), require('./context'), require('./evidence'), require('./router'), require('./guardrails'), require('./contracts'), require('./provider'));
