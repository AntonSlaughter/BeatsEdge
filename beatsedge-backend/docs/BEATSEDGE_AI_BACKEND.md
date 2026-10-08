# BeatsEdge AI — Phase 3A backend integration (no UI yet)

Builds on `lib/ai` (Phase 1A, commit `bb03950`, unchanged) and the client-reported site telemetry (`9b8048d`). New code lives in `lib/aiService/` and `routes/ai.js`.

## Endpoints (all under `/api`)
| Route | Purpose |
|---|---|
| `POST /ai/explain-prop` `{ question, selection }` | Explain ONE selected prop from validated evidence. |
| `POST /ai/site-question` `{ question, selection? }` | Read-only site intelligence from client-reported telemetry. |
| `GET /ai/status` | Whether a provider is configured (name only; never a credential). |

`selection` = `{ sport, player:{id,name,team,position,status,opponent,…}, prop:{statKey,type,line,direction,book,odds,eventId,…,lineStatus,marketClass,modelState,modelSupported}, edge:<the engine's calculateEdgeScore result>, windows:{season,last10,last5,vsOpp:{avg,games}} }`.

## Where the evidence comes from — and how far it is trusted
The grade / probability engine runs **in the browser** (`BeatsEdge.html`), not on the server, so the model evidence is **client-reported**. The server therefore: whitelists every field; range-checks it; cross-checks it (state vs outputs, probability vs percent, edge vs projection and line, grade shape, confluence counts); drops anything that fails (never repairs or invents); ignores every supplied model output for `NOT_YET_MODELED` / `INSUFFICIENT_DATA` / `modelSupported:false` plays; never accepts placeholder history (`hitRatesSource ≠ game_log`, seeded windows). Every response states `evidenceOrigin: CLIENT_REPORTED_ENGINE_OUTPUT`.

Every prop response carries `model.evidenceOrigin: CLIENT_REPORTED_ENGINE_OUTPUT` and `model.serverVerified: false`, and the evidence text itself has an EVIDENCE ORIGIN section (so a provider sees it too).

Additional real data attached server-side: the sport/book **site telemetry** (client-reported, with freshness), and **recorded settled results** from `prop_snapshots` (sport / stat / grade, `model_variant = 'A'`, `result` over/under). **Model-version attribution:** the table has no version column (`model_variant` is an experiment tag). The only version evidence is the client-captured `data_quality.modelMeta.modelVersion` (present only on newer snapshots). A rate is therefore stated ONLY from snapshots tagged with EXACTLY the selection's own reported model version, with ≥ 30 settled plays; snapshots from other or untagged versions are counted, excluded and never combined into any rate. No reported version, or fewer than 30 same-version plays → the rate is suppressed and the reason is given. It is labeled recorded / client-tagged, not a validation, not live results.

## Site intelligence
Distinct categories: provider errors · truncation (unresolved vs recovered by splitting) · Standard lines not returned by the provider · provider-only / ambiguous / routed listings · identity failures · stale / expired / missing reports · documented model-coverage policy (static). Every answer says the telemetry is **client-reported, not authoritative monitoring**. No report for a sport = "unknown", never "complete". Telemetry carries counts, not player names, so "why is player X missing" is answered as **insufficient evidence** with the reported conditions listed.

## AI provider
No vendor, model or key exists in the repo. An operator sets, **in the server environment**: `BEATSEDGE_AI_PROVIDER` (adapter name) and `BEATSEDGE_AI_PROVIDER_MODULE` (a plain file name under `ai-providers/` exporting `{ name, explain({system,user,intent}) }`). The adapter reads its own credentials from the server environment. With nothing configured every answer is the deterministic evidence (`NO_PROVIDER_CONFIGURED`).

Guards: timeout (15 s), 1,500-char response cap, per-client and global-concurrency limits and a daily budget (`BEATSEDGE_AI_DAILY_LIMIT`, default 500), one play's evidence only (never a board), provider/user text sanitized and wrapped in `<<<DATA … DATA>>>` that the system contract declares untrusted, output validated by `lib/ai validateExplanation` (invented numbers, grades, Prime, injuries, line movement, certainty language, confluence-as-probability, unsupported causation) plus no links / markup. Any rejection falls back to the deterministic evidence. Insufficient-evidence and no-model answers are never sent to a provider.

**Kill switch:** `BEATSEDGE_AI_DISABLED=1` disables every provider call regardless of the other settings (`GET /ai/status` → `DISABLED_BY_OPERATOR`); unsetting `BEATSEDGE_AI_PROVIDER` has the same effect. Optional hardening: `BEATSEDGE_AI_TOKEN` (Bearer), `BEATSEDGE_AI_ALLOWED_ORIGINS`. Malformed / oversize JSON returns a short JSON 400 / 413 (never an HTML stack trace).

Tests: `node scripts/test-ai-backend.js` (unit / in-process) and `node scripts/test-ai-live-express.js` (boots the real `server.js` on a throwaway data dir and calls both endpoints over HTTP; no ParlayAPI, no paid AI). On a machine whose `better-sqlite3` binary aborts under Node 24 the live test runs real SQLite through `scripts/lib/nodeSqliteShim.js` (`node:sqlite`) -- a TEST-ONLY shim, never loaded by product code.
