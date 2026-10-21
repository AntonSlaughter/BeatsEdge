# Production heap exhaustion - diagnosis and fix (2026-10-21)

Status: **built and tested locally; nothing committed, pushed or deployed; no production write.** Independent of the paired security / frontend patches (it touches no file they touch).

## 1. Summary

- **What happened.** The Render service (`BeatsEdge`, free plan, 512 MiB) was killed **45 times in 23.5 hours** (2026-10-20 02:38Z to 2026-10-21 02:10Z) with `exit 134 - FATAL ERROR: Ineffective mark-compacts near heap limit - JavaScript heap out of memory`, every 8-23 minutes of uptime, each at ~253 MB of live heap. Every restart was followed 30-90 s later by the first successful ParlayAPI call: a client that keeps polling re-created the load on each fresh instance, so the loop sustained itself. It stopped by itself at 02:10Z when no client was polling.
- **Cause.** The NBA and WNBA provider-line archives (`lib/nbaProviderLineArchive.js`, `lib/wnbaProviderLineArchive.js`) archive each ParlayAPI response with a **sequential per-row loop - one SELECT and, when the row changed, one INSERT, i.e. two Turso round trips per row (~77 ms each on Render)** - and **nothing limits how many such passes run at once**. A 3,000-row page takes ~4.5-10 minutes, the board refreshes every 2 minutes, and every running pass keeps its whole response, its parsed array and one normalized row per row alive until it finishes. Passes pile up (observed in the reproduction: 8 started, **0 finished**), the heap grows ~25 MB per refresh, and V8 dies at its ~254 MB limit. Two aggravating factors were found and fixed with it: the five other sports' archives (batched since `76f62d0`) could each run a ~20 MB pass at the same moment, and the response cache **under-counted** what it holds (see 3.3).
- **Fix.** Archive passes now run through the shared batched implementation (one lookup + chunked writes, seconds per pass instead of minutes), one pass at a time per sport, **one pass at a time across all sports**, with a bounded number waiting; the lookup stops loading every stored `raw_json`; the response cache counts real heap cost and its budget follows the real V8 heap limit. The heap limit is **not** raised.
- **Evidence it works.** Same synthetic load, unmodified code: **dies after 601-841 s (exit 134)**. Patched code: **survives 30 minutes with every archive pass finished, memory flat** (steady 88 MB, sawtooth back to 88 MB after every refresh), including five sports refreshing together and a 4x-faster refresh rate. Section 4.

## 2. Evidence from Render (read-only; no production request was made)

| Source | Finding |
|---|---|
| `list_events` | 45 `server_failed` events with `nonZeroExit: 134`, first 2026-10-20 02:38:42Z, last 2026-10-21 02:10:16Z; none since. Before that window the failures were other kinds (exit 1 on Oct 1 / 12 / 18; one `oomKilled 512Mi` on Oct 1). The first exit-134 came ~1 h 40 min after the 00:56Z redeploy of `76f62d0`; the NBA module is byte-identical to the one deployed since Phase 2I-Q, so the onset is explained by traffic, not by a code change (the unbounded design only needs a client that keeps requesting full NBA boards). |
| `list_logs` (the failing instances) | `Mark-Compact 253.7 (258.4) -> 252.8 (258.7) MB ... scavenge might not succeed`, then `FATAL ERROR: Ineffective mark-compacts near heap limit`. V8 isolate uptime at death: 469 s, 548 s, 858 s, 1,365 s. Mark-compacts freed ~1 MB of ~253: the memory was **retained**, not churn. |
| `list_logs` (what ran before the death) | Only `[nba-archive] captured=... written=...` lines (small pages, i.e. only passes that **finished** log), `[data-source] parlayapi recovered` 30-90 s after each boot, and `SqliteError: no such table: team_schedule` from `/api/player/situational/*` (one cheap request each). No cron / startup-chain job ran. An archive pass that is still running logs nothing - which is why the logs show small successes and then a crash. |
| `get_metrics` (memory_usage) | Instances with no traffic sit at **50-86 MB** for hours. Instances with board traffic: RSS **66 MB -> 124 MB -> 352 MB within ~10 minutes** (e.g. `l76l8` 12:00Z-12:10Z), CPU 3-14 % of a core, then a restart. Limit 536,870,900 B (512 MiB). |
| Idle baseline (local, full `server.js`) | heapUsed **9 MB**, RSS 53 MB. So ~245 MB of the 253 MB at death is traffic-driven. |
| Not available | Render keeps no request logs for these windows; no production heap snapshot can be taken. The page sizes, the Turso latency and the 646 B/row row size come from earlier recorded measurements (`tmp/parlayapi-bulk-test.json`: 10,000 rows = 6,459,268 B; ~77 ms/INSERT in production logs). |

## 3. Mechanism, in the code

### 3.1 The unbounded per-row pass (the cause)
`routes/api.js` (`makeCachedParlayPassthrough`) fires `nbaProviderLineArchive.archiveFromRawParlayResponse(path, body)` and `wnbaProviderLineArchive...` for **every upstream response**, fire-and-forget. In `6ddfdea` those two functions were:

```
rows = JSON.parse(bodyText)                      // whole payload as objects, alive until the loop ends
for (const row of rows) { ... await recordObservation(...) }   // SELECT ... LIMIT 1, then maybe INSERT: 2 round trips per row, sequential
```
with no in-flight guard. **How the page drives it** (`BeatsEdge.html` `fetchParlayPropsBulk` / `fetchParlayProps`): one broad request (`limit=10000`, up to 5 pages, strictly sequential); if the provider truncated it (~10,000 rows per source), the same selection is re-requested **book by book** and, for a book still truncated, **market group by market group** - up to 90 further sequential requests per refresh. Every one of those responses reaches the archive hook, which is why the logs show many small `captured=58 / 120 / 1` passes (only finished passes log) and why a refresh can start dozens of passes. The four other sports (MLB / NFL / NCAAF / NHL) already ran through `lib/marketArchive/providerLineArchiveFactory.js` (batched since `76f62d0`, plus a per-sport "drop a body that arrives while a pass runs" guard); NBA and WNBA were deliberately left alone then and were the ones the page actually drove.

### 3.2 Overlap across sports
The factory's guard is per sport. Five sports refreshing at once ran five passes at once (~20 MB each for a 10,000-row page) on top of the cache; in the reproduction that alone peaked at 240 MB.

### 3.3 The cache under-counted
`lib/parlayCache.js` bounded the cache at 96 MB **of UTF-8 bytes**. V8 stores a string at one byte per character only while every character is <= U+00FF; one character above that (the `c` with caron in Doncic / Jokic - present in nearly every NBA, NHL and MLB board) makes the **whole string two bytes per character**. A "96 MB" cache could therefore hold up to ~190 MB of a ~254 MB heap. The budget was also derived from the instance's 512 MB of RAM, while a Node process is bounded by its V8 heap limit (~254 MB here).

### 3.4 What was checked and ruled out
Archive batching (the four factory sports are fine at one sport; the cross-sport overlap is 3.2); the response cache (a real problem and fixed, but not the main retainer: in the reproduction it held 18-90 MB while the unmodified archive passes held the rest); idle baseline (9 MB); startup / nightly jobs (none ran in the crash windows); `POST /api/snapshots` (accepts up to 16 MB / 20,000 rows with no concurrency limit - **not** seen in the crash windows and **not changed here**; the paired security patch gates it and the paired page no longer posts); the other module-level caches on live request paths are bounded by construction (`statsProxy`: one key per sport and season, expired on read; the AI and telemetry rate-limit maps prune above 500 clients; `dataSourceHealth`: one entry per provider).

## 4. Reproduction and results

Harness: `scripts/lib/archiveHeapHarness.js` (test tooling). It runs the **real** `routes/api.js`, `lib/snapshotStore` and `@libsql/client` in a child process started with the production-sized heap (`--max-old-space-size=256`; Render's logged ceiling is ~253-255 MB), against `scripts/lib/hranaDouble.js` (a real SQLite file behind the Turso/Hrana protocol, one writer, a 60 ms + 25 % round trip ~ the 77 ms measured on Render). Only the ParlayAPI **host** is stubbed (off-heap Buffer bodies, so the stub costs the process nothing); rows are calibrated to the one real measurement (646 B/row, with a non-Latin-1 character in every name). Every refresh (every 120 s unless noted) requests `--pages` pages of 10,000 rows with a new `cycle` value (every page is a cache miss, like a TTL expiry); 20 % of rows change per cycle. No network, no credentials, no paid call.

| Run (all 256 MB heap) | Code | Result |
|---|---|---|
| NBA, 3 x 3,000 rows (a 9k board), 25 min | unmodified `6ddfdea` | survived, but peak 148 MB with **18 archive passes running at once**; first passes took ~10 min each |
| NBA, 2 x 10,000 rows, calibrated 646 B rows | unmodified | **DIED at 601 s, exit 134 `JavaScript heap out of memory`, 235-255 MB; 10 passes started, 0 finished** |
| NBA, 2 x 10,000 rows, 455 B rows, lean stub | unmodified | **DIED at 841 s, exit 134**; heap +25 MB per refresh |
| NBA, 2 x 10,000 rows, 455 B rows, first stub | unmodified | **DIED at 481 s, exit 134**; 8 passes in flight, 0 finished |
| NBA, 2 x 10,000, 20 min | **patched** | survived; **20 of 20 passes finished**; peak sampled 159 MB; 56,009 rows archived |
| NBA, 2 x 10,000 every **30 s** (4x the real rate), 15 min | **patched** | survived; **60 of 60 passes finished**; sawtooth 88 MB trough / 178-195 MB peak, **no upward trend**; 136,029 rows |
| **NBA + NHL + MLB + NFL + NCAAF together**, 2 x 10,000 each, 30 min | **patched** | survived; 150 of 159 archive calls had finished (the other 9 were the burst in progress when the run stopped); steady **88 MB**, burst peaks 167-186 MB, one transient sample of 229 MB (a peak that includes not-yet-collected garbage: the run survived 15 such bursts, and the lowered-limit test below shows the real margin) |
| same five sports, intermediate code (shared slot, no waiting bound, 96 MB cache) | v2 | survived but bursts reached 229 MB -> led to the bounded waiting and the heap-derived budget |
| same five sports, intermediate code (no shared slot) | v1 | bursts 202-240 MB -> led to the shared pass slot |
| **Headroom:** the same five sports with the V8 limit **lowered to 200 MB** (cache pinned at 75 MB), 12 min | patched | survived; peak sampled **181 MB of 200**; nothing skipped - so at the real ~256 MB limit the worst case has >= 55 MB to spare |
| **Request shape 1 - the page's "book split":** NBA, 12 sequential pages x 5,000 rows, 2 s apart, one refresh per 3 min, 12 min | patched | survived; **47 of 48 passes completed, 1 skipped (2 %)**; 95,000 rows archived; peak 173 MB (a second harness was competing for CPU) |
| **Request shape 2 - the page's "market split":** NBA, 60 pages x 300 rows, 1 s apart, 8 min | patched | survived; **241 of 241 passes completed, 0 skipped**; peak **70 MB** |

(For the four older sports only the **first** page of a refresh is archived - their existing drop-while-running guard, unchanged: `nhl=20,006` vs `nba=40,005` rows after the same five-sport run. The unmodified code behaved the same for them.)

Event-loop health while loaded (`/api/health` once a second, one sport, 2 x 10,000 rows, solo): before the cooperative yield was added the slowest was **343 ms** (715 probes, none over 1 s); with it **240 ms** (536 probes). With a second heavy harness competing for CPU the slowest was 0.96-1.4 s (one probe over 1 s). The unmodified code's probes saw 89 ms only because its passes were mostly waiting on the database, until it died. On the 0.1 vCPU instance every one of these will be several times longer; the remaining stall is the single `JSON.parse` call and sending the response, which cannot be sliced.

Where one 10,000-row pass holds its memory (post-GC, instrumented copy, 6.9 MB body): +9 MB after parsing, +21 MB with the normalized rows (the parsed array is then released), +0 for the lookup (narrowed). So one pass ~21 MB retained, ~40 MB while parsing; the old code held these for **every** running pass.

## 5. The change (4 product files, +115 / -159; most of the deleted lines are the per-row loops that moved into the shared implementation)

1. `lib/nbaProviderLineArchive.js`, `lib/wnbaProviderLineArchive.js` - `archiveFromRawParlayResponse` now delegates to `createProviderLineArchive({...serialize: { maxPending: 3 }})` (WNBA passes a `semanticsFor` that keeps its `SEMANTICS_UNRESOLVED` tag for the three unresolved markets). Their per-row `recordObservation`, `lineHistory`, `summary`, `dataQualityChecks` and every export stay as they were.
2. `lib/marketArchive/providerLineArchiveFactory.js` -
   - opt-in `serialize`: one pass at a time per sport with up to `maxPending` waiting (they hold only the response text, which the cache already owns); beyond that a pass is skipped and logged (`[nba-archive] pass skipped ...`);
   - **process-wide pass slot**: one pass at a time across all sports (`ARCHIVE_PASS_CONCURRENCY`, default 1) and at most `ARCHIVE_PASS_MAX_WAITING` (default 4) waiting; beyond that a pass is skipped and logged (`[archive] pass skipped ...`);
   - the lookup selects only the identity + compared columns (it used to `SELECT *`, loading every stored row's `raw_json` for every identity of the batch's events);
   - the parsed payload is released before the database work, and the row-normalizing loop hands the event loop back every 1,000 rows (the other requests the server is handling are not frozen for the length of a 10,000-row page);
   - `semanticsFor` hook (default unchanged); `passStats()` for diagnostics. The four existing sports keep their drop-while-running guard.
3. `lib/parlayCache.js` - cached bodies are counted at heap cost (2 bytes/char if any character is above U+00FF), the budget is **a quarter of the real V8 heap limit, at most the old 96 MB** (~64-80 MB on the 512 MiB instance; `PARLAY_CACHE_MAX_MB` overrides), and the existing 2-minute sweep logs one line while the cache holds data: `[mem] heapUsed=..MB of limit ..MB rss=..MB; parlayCache N entries ..MB of ..MB` (silent when idle).

**What does NOT change:** the heap limit (not raised); routes, frontend, schema, stored rows, provider calls and request volume; the changed/unchanged rule, identity, columns, INSERT-only semantics, log line format of the archives; anything a model or grade reads. Test tooling added: `scripts/test-archive-heap-bound.js`, `scripts/lib/archiveHeapHarness.js`, `scripts/lib/mutateHeapFix.js`, `scripts/fixtures/archive-baseline-6ddfdea/` (the four deployed files, for the equivalence test).

### Behaviour changes you should know about (none alters stored data)
- **A pass can now be skipped under a burst** (a line is logged each time). The next refresh re-reads the same lines, so the final state is recorded; only an intermediate movement between two refreshes can go unrecorded. Before, such passes also lost data - by crashing the process mid-pass.
- **A failed pass now rejects to `routes/api.js`** (logged `[nba-archive] failed to archive this refresh`) instead of being counted row by row as `failed=N`; earlier 200-row chunks stay committed and the next pass continues from there (the dedupe reads what is stored).
- **The response cache holds fewer full pages**: ~4-5 two-byte 10,000-row pages (~64 MB) instead of "13 pages" counted in UTF-8 (which really needed ~190 MB and is what killed the heap). A single sport's board (2-3 pages) is unaffected; a session that loads many sports' full boards inside one TTL re-fetches evicted pages upstream, i.e. **more ParlayAPI requests (credits)** in that case. If that matters later, the follow-up is to cache UTF-8 `Buffer`s (half the size, outside the V8 heap) - a larger change than this fix.
- NBA/WNBA archive row **insertion order** inside a pass is unchanged; ids and values are identical (test A).

## 6. Tests

`node scripts/test-archive-heap-bound.js` - **12 checks, all pass**, against an isolated Turso-compatible server:
A (x2) NBA and WNBA stored rows are **identical** (hash of every column but `captured_at`/`age_seconds`, in insertion order, plus `semantics_status` distribution and per-pass counts) to what the deployed per-row modules wrote, over six payloads covering duplicate identities in one batch, a changed duplicate, unchanged repeats, price / `last_update` / status changes, null `side`/`period` identities, ineligible rows, a non-ASCII name, the WNBA unresolved market, a non-JSON body and a non-array body;
B / B2 ten simultaneous NBA (eight WNBA) responses -> never more than one pass at a time, 1 running + 3 waiting archived, the rest skipped and logged, the queue accepts work afterwards (control: the deployed code overlaps passes);
F / F2 / F3 five sports at once never overlap passes (control: deployed code did), `ARCHIVE_PASS_CONCURRENCY=2` allows exactly two, waiting passes are bounded (`ARCHIVE_PASS_MAX_WAITING`) and the skipped ones write nothing;
C a failing pass rejects, earlier state is kept, the next pass runs; D the lookup selects no `raw_json` and the parsed payload is released; E / E2 / E3 cache accounting (1 byte/char Latin-1 incl. accented, 2 bytes/char otherwise; the old UTF-8 count under-counts), the budget follows the heap limit and the env override, and the `[mem]` line is emitted / silent as specified.

**Mutation check** (`node scripts/lib/mutateHeapFix.js`): 21 mutants, each removing one protection (either archive not serialized, queue bound removed, queue wedged / never released, wide lookup (outer or inner) back, an identity column or a compared column dropped from the lookup, parsed rows kept, WNBA semantics tag lost, wrong sport label, shared slot not enforced / waiting unbounded / slot not released, fixed 96 MB budget, UTF-8 / 1-byte / 2-byte cache counting, `[mem]` never / always logged) - **all 21 killed** by the test above.

**Existing suites, clean `6ddfdea` vs patched (identical results):** `test-parlay-cache` 22/22, `test-wnba-provider-archive` 33/33, `test-snapshot-startup-archive` 17/17, `test-nhl-market-archive` 20/20, `test-data-source-health` 21/21, `test-no-split-brain` 6/6, `test-news-route` 18/18, `test-news-ingest` 34/34. **Failing identically on the unmodified deployed code (not caused by this change):** `test-nfl-dvp-read-cutover` (2 failures), `test-archive-hardening` (needs real archived WNBA rows; throws on its first query). The real `server.js` boots with the patched modules (`/api/health` ok; `/api/data-sources/health` reports `maxCacheBytes`).

**Whole-repo comparison on two FRESH checkouts** (clean `6ddfdea` vs `6ddfdea` + this patch applied with plain `git apply`, same environment, same order): 93 top-level `scripts/test-*.js`; **67 pass in both trees; 26 fail in both trees in the same way** (pre-existing on the deployed code in this environment - e.g. `test-settlement`, `test-nfl-leakage`, `test-nhl-model-parity`, `test-archive-hardening`; not investigated here, identical before and after); **the only difference is the new test file itself** (absent from the clean tree). `test-snapshot-startup-archive` is slow (clean 168 s and 195 s, patched 150 s and 206 s; 17/17 every time). An earlier comparison on two long-used worktrees showed spurious differences (leftover generated files); it was discarded for that reason.

**The patch itself:** applies strictly (`git apply --check` then `git apply`, no whitespace leniency) to a pristine `6ddfdea` checkout (the resulting files are identical to the tested ones) and on top of the security patch (`docs/SECURITY_PATCH_2026-10-21.patch`) - the file sets are disjoint; with **both** applied to a fresh tree `test-security-hardening` reports ALL PASSED and `test-archive-heap-bound` 12/12.

## 7. Not verified / residual risk
- **Not run against real Turso or real ParlayAPI** (no paid call was made); latency, row size and page size come from earlier measurements. **The service runs on ~0.1 vCPU**; parse/normalize will be slower than on this machine. That cannot raise memory (the bounds are counts of passes and waiting bodies, not speeds) - it can only raise the number of skipped passes under a burst.
- The harness stubs the provider and models only the passthrough + archive load; other routes' memory is not modelled (they were not implicated: idle 9 MB, flat in the no-traffic instances).
- The WNBA path is covered by the equivalence / bound tests, not by the long harness runs (WNBA is out of season).
- `POST /api/snapshots` can still take a 16 MB body with no concurrency limit (3.4) until the paired security / frontend patches are deployed.
- The 229 MB transient sample in the five-sport run (an event no production page is known to produce: five sports x 20,000 rows refreshing in the same second) shows the margin there is thinner than for one sport; section 4 reports the lowered-limit headroom test.
- After deploy the real confirmation is the service's own numbers (section 8).

## 8. Deploy, watch, rollback (nothing below was run)
**Order.** This is a backend-only change to four `lib/` files. It does not touch the paired security patch (`server.js`, `routes/api.js`, `lib/security.js`, `package-lock.json`) or the frontend package, so it can ship first and alone. Deploying on `main` redeploys the (currently crash-looping) instance once.
**Watch** (first 60 minutes with a page open on NBA): Render events - no `server_failed`; Render memory metric - RSS plateaus (instances under load previously went 66 -> 350 MB within 10 min); logs - a `[mem] heapUsed=...` line every 2 minutes (expected: plateau well under the limit; during the old failure heapUsed would have climbed ~25 MB per refresh), `[nba-archive] captured=... written=...` lines finishing within seconds, and no or only occasional `pass skipped` lines; `GET /api/data-sources/health` -> `parlayApiCache.maxCacheBytes` (~64 MB on this instance).
**Knobs** (environment only, no code change): `ARCHIVE_PASS_CONCURRENCY`, `ARCHIVE_PASS_MAX_WAITING`, `PARLAY_CACHE_MAX_MB`, existing `SNAPSHOT_WRITE_CHUNK`, `SNAPSHOT_WRITE_CONCURRENCY`.
**Rollback.** Revert the single commit, or redeploy `dep-dbbp0p0473hc73eqt4g0` (`6ddfdea`). No schema, data or dependency change in either direction: rows written by the patched code have the same shape and values as before. Rolling back restores the crash loop while any client polls NBA boards.
**No-code stopgap, if the patch must wait:** the loop only exists while a client keeps requesting boards - after the last polling page was closed the service sat idle at 50-86 MB with no failures (since 02:10Z). Raising `--max-old-space-size` is **not** a fix and not safe here: RSS at the 256 MB heap limit already reaches 300-360 MB of the 512 MiB.

## 9. Open decisions
1. Approve this patch (it supersedes nothing; the paired patches are untouched) and ship it before the paired ones, so the beta is not built on an unstable instance.
2. Whether a lower cache budget is acceptable (more upstream calls when a session loads several sports' full boards) or you prefer the larger "cache UTF-8 Buffers" follow-up.
3. Whether to also move the four older sports from "drop a page that arrives while a pass runs" to the queueing mode NBA/WNBA now use (archive completeness; unchanged here on purpose).
