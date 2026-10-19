# Snapshot-storage startup stall and archive write lock: fix for approval (2026-10-19)

Status: tested in isolation, **not deployed, not committed, not pushed**. Production is unchanged (commit `15f1b55`, `SKIP_STARTUP_JOBS=1`, BETA flags `0`).

## What stalled, with the evidence

| Evidence | Value |
|---|---|
| Boot readiness (`snapshotStore.verifyReady()`) ran | 46 `CREATE ... IF NOT EXISTS` statements, one round trip each. SQLite marks even a no-op `CREATE ... IF NOT EXISTS` as a writing statement. |
| Archive writers (`providerLineArchiveFactory.js`) ran | ONE interactive write transaction per pass, one `INSERT` round trip per row (`store.transaction` → `client.transaction('write')`). |
| Measured cost per inserted row on Render | about 77 ms (NFL passes in the logs: 6,133 rows in 490 s, 5,709 in 515 s, 5,818 in 381 s) |
| So one 6,000-row pass holds Turso's single write lock for | 6 to 9 minutes, and passes ran nearly back to back while a page was open |
| Failed boots (4 of 4) | stalled 303–324 s (undici's 300 s response timeout) while a pass of 6,000+ rows was in flight; the idle process (CPU about 0.05%) was waiting on the network |
| Successful boots | 39–79 s, each right after a large pass had finished |
| Isolated reproduction | deployed code: boot waited **52.5 s** behind a 53.2 s pass (the real `server.js` listened after **51.7 s**) |

What is measured: the per-row cost, the lock hold, the stall in the isolated server, the fix's effect. What is NOT proven: that production Turso queues a DDL no-op behind a write transaction (the isolated server models that assumption explicitly, `ddlTakesWriteLock`). The fix does not depend on it: boot issues no write at all on a verified schema, and the write lock is held for about 20 ms instead of minutes either way.

## The change (3 runtime files)

1. `lib/schemaCatalog.js` (new): builds the expected catalog by running the real schema statements in an in-memory SQLite, reads the live catalog with **two read queries** (`pragma_table_info` / `pragma_index_info`), and reports missing tables, **missing columns**, missing indexes, and retired indexes that still exist. Type / NOT NULL / PK / index-definition differences that DDL could never repair are logged as non-blocking drift. Verified read-only against the real production historical Turso schema: 24 tables, 368 columns, 28 indexes, 0 drift, 2 queries, 343 ms cold.
2. `lib/snapshotStore.js`: Turso `ensureSchema()` first runs that check. Verified → no DDL, boot continues (`schema verified read-only in N ms`). Anything missing, or the server cannot introspect → the **full statement list runs exactly as before** (readiness never weaker). A network failure is rethrown unchanged, so the server's readiness guard still refuses to start. New `batchWrite()`: chunked (200 rows) batches, one round trip and one short write transaction each, in order, with a process-wide cap of 2 chunks in flight (`SNAPSHOT_WRITE_CONCURRENCY`, `SNAPSHOT_WRITE_CHUNK`). The SQLite backend and every existing export are unchanged.
3. `lib/marketArchive/providerLineArchiveFactory.js`: the write step uses `store.batchWrite` instead of one long transaction. Same rows, same SQL, same order, INSERT-only, same decision logic, same log line.

Preserving migrations: `SCHEMA_MIGRATION_STATEMENTS` and `SCHEMA_RETIRED_INDEXES` (both empty at this commit; the Turso path has no migration beyond the DDL list) are the registration points. Any additive `ALTER TABLE ... ADD COLUMN` or index drop the Turso path performs MUST be listed there, otherwise the read-only check cannot see it is pending. The uncommitted snapshot-identity work (new columns, `idx_prop_snap_identity`, retiring `idx_prop_snap_unique`) must register its columns and retired indexes there when it is merged; that merge will also conflict textually in `snapshotStore.js` (not tested here).

Behavior difference to know about: a pass used to be one all-or-nothing transaction; it is now atomic per 200-row chunk. If a chunk fails, earlier chunks stay committed, no later chunk starts, the error carries `rowsCommitted`, and the next pass's latest-row lookup sees the committed rows, so nothing is duplicated or lost (tested).

## Tests (isolated; no network, no credentials, no production data)

`node scripts/test-snapshot-startup-archive.js` → 17 / 17. Real `@libsql/client` against `scripts/lib/hranaDouble.js` (Turso-compatible HTTP server over a SQLite file: single writer, per-request delay, fault injection) and byte-exact copies of the deployed files (`scripts/fixtures/snapshot-baseline-15f1b55`).

| Check | Result |
|---|---|
| Baseline boot during a baseline pass (2,400 rows) | boot 52.5 s, pass 53.1 s (22 ms/row), longest write transaction 52.0 s |
| Fixed boot during a fixed pass 10x larger (24,000 rows) | boot **0.21 s**, 0 DDL statements, pass 4.4 s (0.18 ms/row), longest write transaction **22 ms** |
| Per-row cost / lock hold | >= 100x lower / >= 2,000x shorter |
| Missing table / index / column, empty database, no introspection | full statement list runs and creates what is missing; boot ready (a missing column is reported, exactly as before neither path can add it) |
| Unreachable database | fails closed in about 0.1 s with the network error, no DDL fallback attempt (same as deployed) |
| Four sports archiving at once | at most 2 chunks in flight (client and server side), one open write transaction |
| Chunk 2 fails | chunk 1 committed, rest not started, next pass inserts only the remainder, no duplicates |
| Deployed vs fixed code, 3 passes, same payloads (Turso-compatible and local SQLite) | byte-identical archive rows (ids, order, values) and identical counts and log lines |
| Mutation check | 6 deliberately broken copies, all caught (one by the 400 s timeout) |
| Real `server.js` booting during a baseline-style pass | deployed: listening after 51.7 s; fixed: 426 ms; unreachable database: exit 1, `FATAL ... Refusing to start` unchanged |
| Existing tests (13 related files) | identical results on the deployed tree and the fixed tree; the same pre-existing failures (`test-settlement` 11/3, `test-empty-local-db`, `test-archive-hardening`) need the local production-size database and fail identically on both |

## What is NOT verified

- The production **snapshot** database's schema (its credentials are not available here). If it differs from the statements, the boot log says so and the old path runs (no worse than today). Look for `schema verified read-only` or `schema check found work to do (...)` in the first deploy's log.
- Snapshot-DB token expiry and permissions (unchanged, unverified).
- Real Turso's treatment of DDL no-ops under a write lock (assumption, see above).
- Running on Render's Node 22.16.0 (tested on 22.23.2).

## Findings to know about (not changed)

- `idx_npla_*` index names are used for both `nba_provider_line_archive` and `nhl_provider_line_archive`; the NHL `CREATE INDEX IF NOT EXISTS` statements are no-ops, so the NHL archive table has **no indexes of its own**, and its latest-row lookup scans the table. The catalog counts 33 indexes for that reason. Fixing it is a separate, additive change.
- `lib/nbaProviderLineArchive.js` and `lib/wnbaProviderLineArchive.js` still write one row per round trip with autocommit (short locks, many round trips); they are idle out of season and were left untouched.

## Rollout and rollback

Deploy only the three runtime files (tests and fixtures ride along). Keep `SKIP_STARTUP_JOBS=1` and the BETA flags at `0` for this deploy; change nothing else. The first boot does not need a quiet window to be fast, because it no longer waits for the old instance's lock. Rollback: redeploy `15f1b55` (no schema or data change; archive rows are identical in format).
