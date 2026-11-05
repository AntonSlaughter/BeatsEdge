# Resource optimization patch — 2026-11-05

> **Update 2026-11-05 (canary preparation):** the credit budget is now enforced per board with canary defaults of 450 credits/hour and 1,500 credits/day (the figures further down this page that say otherwise are superseded), and PARLAY_BUDGET_MODE=call restores the per-call rule described in the first version. Everything else here is unchanged. Deployment procedure, success/failure criteria and rollback: docs/CANARY_DEPLOYMENT_CHECKLIST_2026-11-05.md.

Built from the commit that is **deployed on Render, `d9b0e3f`** (Oct 22), in the isolated copy `C:\Users\Smurf\Downloads\beatsedge-resource-opt`. It is **not applied, not deployed, and nothing in production was touched.** Local `main` (`ca8db40`) does not contain `d9b0e3f`, so this patch applies to `d9b0e3f`, not to `main`; carrying it onto `main` is a separate merge.

Patch file: `docs/RESOURCE_OPTIMIZATION_PATCH_2026-11-05.patch` (diff against `d9b0e3f`, new files included).

## What was wrong (evidence in `beatsedge-credit-burn-state` / `beatsedge-turso-diagnosis-state`)

| Symptom | Cause found in the code |
|---|---|
| ParlayAPI credits 10,296 → 32,232 in 3 days | Every provider call is browser-triggered. The page polls every 90 s; one board refresh is ~36 upstream requests; the 2-minute response cache missed on about every other tick. |
| Render crash loop since 2026-11-05 06:02Z (100+ restarts) | Turso is refusing **reads as well as writes**. `snapshotStore.ensureSchema()` treats a refused read as "cannot introspect", falls through to schema **writes**, those are refused too, and `server.js` exits with code 1 on purpose. A restart cannot fix a quota. |
| Turso rows **read** | Every archive pass runs `ROW_NUMBER() OVER (PARTITION BY identity ...)` over **all stored rows** of every event on the board, and one refresh produces ~36 passes. |
| Turso rows **written** | One archive pass hangs off every upstream fetch (so ~5x fewer passes at a 10-minute TTL), plus ladder re-insertion (below). |
| Boot cost | `server.js` re-ran the NBA / MLB / NHL nightly jobs and the NFL ingest + DvP recompute (thousands of writes) on **every** boot, i.e. every free-tier wake-up. |

## What the patch changes

1. **Response cache TTL 2 → 10 minutes** (off-peak 10 → 30), `lib/parlayCache.js`. This is the lever that cuts upstream calls, archive passes, Turso reads/writes and outbound bytes together. Archive line-movement history therefore has ~10-minute resolution while a board is viewed.
2. **Upstream credit budget**, `lib/providerBudget.js`. Checked only for a request that would otherwise cost an upstream call (cache hits are free). Hourly cap 450, daily cap 1,500 (canary values), enforced PER BOARD (board mode, see CANARY_DEPLOYMENT_CHECKLIST_2026-11-05.md): a board may start only if a whole board is affordable, a board in progress may finish (hard stop 100 credits past the cap), and when no board is affordable every request of that sport is refused including cache hits, so a budget limit cannot produce a partial board (rolling windows), and a reserve: stop when the provider's own `x-credits-remaining` is below 1,000 (one probe call per hour re-reads the balance). A call is charged at the provider's own `x-credits-cost` header when sent, otherwise at an **assumed 3** (not a measurement; the metrics say how many calls were charged each way). Refused calls answer `503 { status: 'unavailable', reason: 'credit budget reached (…)' }` with `Retry-After`; the provider is not called.
3. **ETag / 304 and brotli / gzip** on the cached passthrough, `lib/httpEncoding.js` (Node `zlib`, no new dependency): strong ETag per cache entry (and per encoding), `304` with no body (pagination headers kept), each encoding computed once per entry and reused. A global middleware compresses other large JSON responses. `Cache-Control: private, no-cache` (the URL carries the caller's key). A request with `Cache-Control: no-cache` (the page's direct book check) still bypasses the cache and is never answered 304.
4. **Archive latest-row cache**, `lib/marketArchive/providerLineArchiveFactory.js`. The latest stored row per identity is read from the database **once per event per process** (re-read after 6 h or after any failed / out-of-pass write) and compared in memory afterwards. Same changed/unchanged rule, same INSERT-only writes, same order; the existing row-for-row equivalence tests pass unchanged. Bounded (60,000 identities per sport, whole events evicted oldest first).
5. **Turso quota-block handling**, `lib/snapshotStore.js` + `server.js`. A refused statement is recognised as a quota block; the process **starts in degraded mode instead of exiting**, snapshot/archive requests fail fast through a circuit breaker (no per-request refused statements, 5-minute backoff), storage is re-verified on a timer and **recovers without a restart**. A failed startup check is no longer cached forever; a refused read no longer falls through to schema writes. Every other failure (bad URL/token, unreachable network) is still fatal at startup, exit 1. `/api/health` stays 200 and reports `snapshotStorage: "blocked"`.
6. **Boot-job gate**, `lib/startupJobs.js`. A boot-time job runs only if `ingest_log` has no completed run in the last 20 h (`STARTUP_JOB_MIN_AGE_HOURS`, `0` = old behaviour). Unreadable history → skipped. The NFL pipeline now records an `NFL:` row so it can be gated too. The 06:00 UTC cron is not gated.
7. **Metrics**, `GET /api/resource-metrics` (counts only; no keys, URLs, bodies or rows): upstream calls and credits (header-measured vs assumed), provider-reported balance, cache hits / misses / coalesced / 304s, compression ratio, archive cache lookups avoided, storage operations and breaker state, boot-job decisions.
8. **Page** (`BeatsEdge.html`, two edits): the silent refresh interval 90 s → 5 min, and the freshness stamp no longer says "Live data · updated N sec ago" (it would overstate a 10-minute cache). It now reads "Checked N sec/min ago · odds refresh every 5–10 min". Not browser-tested (see below).
9. **Stale-on-error is built, tested, and OFF by default** (`PARLAY_STALE_MAX_MS`, default `0`). With it on, a provider failure / cooldown / spent budget serves the last good board labelled `x-cache: STALE` with `x-data-age-seconds` and `x-stale-reason`; a 401/403 is never masked. It is off because the page does not read those headers, and its "Checked …" stamp is the page's own clock, so a stale board would look current. Enable only together with a page change that shows the data age.

## Measured, and one finding that needs your decision

Local WNBA archive (`data/snapshots.db`, read-only; **4 capture passes, 13,939 rows — a small sample, one sport**):

| | rows | share |
|---|---|---|
| Rows that repeat the previous observation of the same identity + line + prices | 5,000 | **35.9 %** |
| … of which differ only by the provider's `last_update` | 4,774 | 34.2 % |
| … of which are byte-identical, including `last_update` | 226 | 1.6 % |
| Rows in groups where one identity has several lines in one pass (alt-line ladders) | 5,718 | 41.0 % |
| MLB sample (2,291 rows) repeating the previous observation | 0 | 0 % |

**Ladder re-insertion.** The identity does not include the line, and every row of one pass shares one `captured_at`. When a response lists several lines for one identity, the deployed "latest row per identity" lookup breaks the tie by keeping the first inserted row, so the next pass compares the whole ladder against that one row and re-inserts most of it **whether or not anything changed**. The patch deliberately preserves this exactly (the equivalence tests require identical stored rows, and the cache reproduces the tie-break), so the patch **does not** remove it. It is probably the largest remaining write multiplier on ladder-heavy boards (sportsbook alt lines).

Fixing it changes what the archive stores, so it is your call: compare per identity **as a set of (line, prices)** and write the whole ladder only when the set changes. For a single-line identity that is today's behaviour; for ladders it removes the repeats and leaves a complete, consistent "latest ladder" for readers (`reconstructPrimaryTimeline`, the real-line matcher). A naive per-line comparison is **not** safe (25.5 → 26.5 → 25.5 would store no row for the return to 25.5 and give a wrong as-of line). This needs its own validation against those readers before it ships.

Opt-in knob already in the patch: `ARCHIVE_LAST_UPDATE_IS_CHANGE=0` stops writing rows whose only difference is the provider's `last_update` (34 % of rows in the WNBA sample). Default stays `1` because a stored row's `provider_last_update` / `age_seconds` are what freshness checks read.

## Honest limits

- **Credit effect is not measured.** Nothing here was run against the real provider. The mechanism is bounded (at most one board refetch per cache key per 10 minutes regardless of viewers, plus a hard credit cap), but the earlier 780 credits/h figure assumed 3 credits per call. **The biggest remaining lever is untouched: ~36 upstream requests per board refresh**, which is how the page fetches (per-book and per-market calls). That is a frontend design question.
- **Budget defaults are placeholders** derived from that assumed cost: one continuously viewed sport at ~36 requests per refresh every 10 minutes would cost about 650 credits/h at 3/call, above the 450/h canary cap (which is why the budget is enforced per board). Read `/api/resource-metrics` (`provider.budget.chargedByProviderHeader`) for the first real hour, then set `PARLAY_HOURLY_CREDIT_BUDGET` / `PARLAY_DAILY_CREDIT_BUDGET` from the true cost. The provider's own balance (`x-credits-remaining`) is the persistent figure; this process's counters reset on restart.
- The latest-row cache assumes one writer process (the 6 h expiry bounds any divergence during a deploy overlap).
- The circuit breaker covers `snapshotStore`. `historicalStore` already survives blocked queries (Oct 22 fix) but has no breaker.
- Restoring Turso resumes provider traffic; the budget and TTL are what bound it.

## Verification actually performed

Run with Node 22.23.2 (project: 22.x). New suite `scripts/test-resource-optimization.js`: **107 passed, 0 failed.** It boots the real `server.js` against a local provider stub (every other host refused) and the local Hrana Turso double, and covers budget, cache/stale pool, compression, boot gate, archive cache (hit, miss, failed write, TTL, bound, out-of-pass write, flags), breaker, and the full request path (MISS / HIT / COALESCED / 304 / br / gzip / no-cache bypass / cooldown / budget / reserve / a rejected key not masked / metrics with no key in the output / degraded start with Turso refusing everything / unreachable Turso still fatal).

Mutation check: 8 deliberate breakages (reserve rule, archive cache, breaker, degraded start, stale serving, 304, ladder tie-break, boot gate) were each detected (the ladder one by the existing `test-archive-heap-bound`). The first full run also caught a real bug in my own budget code (an absent `x-credits-remaining` header read as 0 and would have locked all calls); fixed.

Existing tests (about 40 run on the patched copy): every one passes except five, and those five fail identically on a pristine export of `d9b0e3f` (they need real historical data a clean checkout lacks): `test-empty-local-db` (5 failing checks), `test-settlement` (3), `test-historical-store-parity` (exit 1), `test-query-budget` (10), `test-archive-hardening` (crash). Passing on the patched copy include `test-archive-heap-bound` 12/12 and `test-snapshot-startup-archive` 17/17 (both compare stored archive rows row for row against the deployed code), `test-turso-blocked-resilience` 18/18, `test-parlay-cache` 22/22, `test-data-source-health` 21/21, `test-provider-completeness` 106/106, and the page-parsing tests `test-ai-ui` 73/73, `test-game-period-view` 45/45, `test-lineups-news` 21, `test-news-player-card` 16, `test-projection-stability` 21 (these last five were also run on the pristine export with identical counts).

**Not verified:** the page edit was not run in a browser (only the page-parsing tests ran, and they match the baseline); nothing was tested against the real ParlayAPI or real Turso; the credit and Turso savings are unmeasured in production; behaviour on Render's actual instance (0.1 vCPU) is untested, including brotli CPU time on a multi-MB board.

## Environment knobs (all optional; defaults shown)

| Variable | Default | Meaning |
|---|---|---|
| `PARLAY_CACHE_TTL_MS` / `PARLAY_OFF_PEAK_TTL_MS` | 600000 / 1800000 | response cache lifetime |
| `PARLAY_STALE_MAX_MS` | 0 (off) | stale-on-error window (max 2 h) |
| `PARLAY_HOURLY_CREDIT_BUDGET` / `PARLAY_DAILY_CREDIT_BUDGET` | 450 / 1500 | credits per rolling hour / 24 h |
| `PARLAY_CREDIT_RESERVE` | 1000 | stop when the provider reports fewer credits left |
| `PARLAY_ASSUMED_CALL_COST` | 3 | credits charged when the provider sends no cost header |
| `PARLAY_BUDGET_MODE` | board | `call` = plain per-call cap |
| `PARLAY_BOARD_RESERVE_CREDITS` | 160 | credits that must remain to START a board (one NBA board = 153; raised to 1.25 x the measured average) |
| `PARLAY_BOARD_LEASE_SECONDS` | 150 | a board in progress may finish while its sport keeps calling within this gap |
| `PARLAY_BOARD_OVERSHOOT_CREDITS` | 100 | hard stop for a board in progress, past the cap |
| `COMPRESS_MIN_BYTES` | 1024 | smallest body worth compressing |
| `ARCHIVE_LATEST_CACHE_MAX` / `ARCHIVE_LATEST_CACHE_TTL_MS` | 60000 / 21600000 | archive cache bound (0 = off) / lifetime |
| `ARCHIVE_LAST_UPDATE_IS_CHANGE` | 1 | 0 = do not write timestamp-only changes |
| `TURSO_BLOCKED_BACKOFF_MS` | 300000 | pause after a quota-blocked statement |
| `STARTUP_JOB_MIN_AGE_HOURS` | 20 | boot-job gate (0 = always run, previous behaviour) |

## Rollback

Every behaviour above has an environment value that restores the previous one except the page edit and the degraded-start / breaker handling (which have no downside to keep). Deploying the previous commit is a full rollback; the patch adds no schema change and no new dependency.

## Files

New: `lib/providerBudget.js`, `lib/httpEncoding.js`, `lib/resourceMetrics.js`, `lib/startupJobs.js`, `scripts/test-resource-optimization.js`, `scripts/lib/stubParlayFetch.js` (test double). Changed: `lib/parlayCache.js`, `lib/snapshotStore.js`, `lib/marketArchive/providerLineArchiveFactory.js`, `routes/api.js`, `server.js`, `BeatsEdge.html`, `scripts/lib/hranaDouble.js` (additive: `setBlockAll`, to model Turso refusing reads).
