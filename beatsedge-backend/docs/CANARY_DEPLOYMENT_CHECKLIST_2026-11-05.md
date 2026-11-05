# Backend resource-optimization canary — deployment checklist (2026-11-05)

**Status: prepared, NOT deployed. Nothing below has been executed against production.** Every step that changes production needs your explicit approval at the moment it is run.

## 1. Facts this checklist depends on (read from Render and GitHub, read-only, 2026-11-05)

| Fact | Value |
|---|---|
| Service | `BeatsEdge`, `srv-daf0490n74is73fohgkg`, free plan, 1 instance, region oregon, root dir `beatsedge-backend`, no health-check path |
| Repo / branch / auto-deploy | `github.com/AntonSlaughter/BeatsEdge`, branch **`main`**, **auto-deploy on every commit: pushing to `main` IS the deploy** |
| Live deploy | `dep-dbd9r7dg1s2s73de6ujg`, commit **`d9b0e3ffd6c6217b9948d95394134512796d71d5`** (2026-10-22), status live |
| GitHub `main` (checked with `git ls-remote`) | `d9b0e3ffd6c6217b9948d95394134512796d71d5` — equal to the live deploy and to the patch base |
| Previous deploy (second-level rollback) | `dep-dbcfjvo473hc73c6noog`, commit `8b0eb62698afda8d9079537d4f8bbf01ad834fd2` (heap fix) |
| **Local `main` in your working repo** | `ca8db40` — a divergent branch that does **not** contain `d9b0e3f`. **Never push local `main`.** The canary is built in the isolated worktree on top of `d9b0e3f` |

## 2. What the canary contains (and does not)

Contains (backend only): response cache TTL 10 min; ETag/304 and brotli/gzip; upstream credit budget (**board mode**, 450 credits/hour, **1,500 credits/day**); archive latest-row cache; Turso quota-block degraded start + circuit breaker; boot-job gate; `/api/resource-metrics`. **Stale-on-error stays disabled** (`PARLAY_STALE_MAX_MS` default 0; do not set it).

Does **not** contain: any page change (`BeatsEdge.html` is untouched), the adaptive request plan, the archive ladder de-duplication, any model / grade / scoring file, any schema, dependency or environment change. Artifact: `CANARY_BACKEND_PATCH_2026-11-05.patch` (hashes in `CANARY_MANIFEST_2026-11-05.txt`).

### How the budget behaves (items 4 and 5 of the approval)
- Limits: **1,500 credits per rolling 24 h, 450 per rolling hour**, 3 credits per provider request (docs; the provider sends no credit headers, so every charge is that assumption).
- One complete NBA board = 42–52 requests = 126–156 credits (measured: 51 requests, 153 credits). The hourly cap admits at least two whole boards; the daily cap admits **nine** whole boards (the tenth is refused up front).
- **A budget limit cannot produce a partial board.** A board may only *start* if a whole board is affordable (remaining ≥ the board reserve: 160 credits, rising to 1.25 × the measured average board). A board in progress is allowed to *finish* even if that crosses the cap (hard stop 100 credits past it — an NBA board never reaches it). When no board is affordable, **every** request for that sport is refused — cache hits included — with `503`, `x-credit-budget: board-denied` and `Retry-After`; so a cached part of a board is never mixed with refused parts. The browser keeps the board it already has and shows its own error pill (`🟡 ERROR`).
- Residual case, stated plainly: if the hard stop is ever hit while a board is loading, that one refresh is incomplete; it is labelled `x-credit-budget: board-aborted` and counted in `provider.budget.boards.overshootStops` (success criterion: stays 0). The page itself shows its green LIVE pill for any board that arrived partially — that is existing page behaviour and independent of the budget; it is why the budget refuses whole boards instead of letting them go partial.
- **Consequence to accept on day one:** 1,500 credits ≈ 9 cold boards. Under continuous use the board will be refused for part of the day (`🟡 ERROR`, old board stays on screen). That is the intended conservative behaviour for the first day; raise by environment variable after review, not before.

## 3. Pre-deploy gate (all must be true before you are asked to approve)

- [ ] Base is `d9b0e3f` = GitHub `main` = Render live (re-check with `git ls-remote origin refs/heads/main` immediately before pushing; if it moved, stop).
- [ ] Canary patch applies cleanly to a pristine `d9b0e3f` export, the whole new suite passes there (`node scripts/test-resource-optimization.js`), the existing suites match baseline, and `git apply -R` returns the byte-identical `d9b0e3f` tree (done and recorded in the manifest).
- [ ] No environment variable is required: the canary values are the code defaults. For visibility you may set `PARLAY_HOURLY_CREDIT_BUDGET=450` and `PARLAY_DAILY_CREDIT_BUDGET=1500` explicitly (then they are also the first thing to edit when raising limits). Do **not** set `PARLAY_STALE_MAX_MS`.
- [ ] You have the ParlayAPI dashboard open to read the credit counter before and after the first board.
- [ ] Turso quota state known (blocked or restored) — the canary starts either way (degraded if blocked).

## 4. Deploy procedure (NOT executed; needs your approval to run)

Run from `C:\Users\Smurf\Downloads\beatsedge-resource-opt` (the isolated worktree, detached at `d9b0e3f`).

```bash
git ls-remote origin refs/heads/main                      # must print d9b0e3ffd6c6217b9948d95394134512796d71d5
git switch -c canary/resource-opt-2026-11-05
git apply --index beatsedge-backend/docs/CANARY_BACKEND_PATCH_2026-11-05.patch
git diff --cached --stat                                    # expected: the 14 files listed in the manifest, nothing else
git commit -m "feat: backend resource optimization canary (budget, cache, Turso quota fallback)"   # asks for your approval first
git push origin canary/resource-opt-2026-11-05             # a branch push: Render deploys only main, so this does NOT deploy
# --- the deploying step, only after your explicit go ---
git push origin canary/resource-opt-2026-11-05:main        # fast-forward of main = AUTO-DEPLOY
```

Then watch the deploy (Render dashboard → BeatsEdge → Events). Record the new `dep-…` id and commit sha next to the rollback target below.

## 5. Success and failure criteria (measurable)

**Stage A — startup (first 15 minutes).** Source: Render logs + the endpoints below.

| # | Check | Success | Failure (→ roll back) |
|---|---|---|---|
| A1 | Deploy status | `live` | `update_failed` / build failed |
| A2 | Process restarts after the deploy | 0 in 30 min | ≥ 3 restarts in 30 min (crash loop) |
| A3 | Log lines | `BeatsEdge backend listening on port …` and either `snapshot storage ready (backend=turso)` or `Starting in DEGRADED mode` | any `FATAL` line, or no `listening` line within 5 min |
| A4 | `GET /api/health` | `200 {"ok":true,…}` (may add `snapshotStorage:"blocked"`) | non-200 for 5 consecutive minutes |
| A5 | `GET /api/data-sources/health` → `parlayApiCache` | `ttlMs` 600000, **`staleMaxAgeMs` 0** | `staleMaxAgeMs` ≠ 0 (stale-on-error accidentally enabled) |
| A6 | `GET /api/resource-metrics` → `provider.budget` | `mode "board"`, `limits.hourlyCredits 450`, `limits.dailyCredits 1500` | different limits or `mode "call"` |
| A7 | Boot jobs (if Turso blocked) | `[startup] … skipped — … could not be read` ×4, no `Running initial …` | any boot job running against a refusing database |

**Stage B — first provider traffic (first board load by one browser).**

| # | Check | Success | Failure |
|---|---|---|---|
| B1 | Upstream requests for one NBA board (`provider.budget.upstreamCalls` delta) | 42–60 | > 70, or > 3 retries per request |
| B2 | Credits spent (`spentLastHour`) vs ParlayAPI dashboard delta | dashboard ≈ 3 × requests (±15 %) | dashboard ≥ 1.5 × `spentLastHour` → the 3-credit assumption is wrong: **stop, lower the caps** |
| B3 | Board completeness (page telemetry / `GET /api/site-status`) | NBA `COMPLETE` | `TRUNCATED` / `PROVIDER_ERROR` with no refusal logged |
| B4 | Second load of the same board within 10 minutes | ≤ 5 upstream requests (expect 0), responses `x-cache: HIT` | > 20 requests (cache not working) |
| B5 | Compression | board responses carry `Content-Encoding: br` or `gzip`; wire bytes ≤ 25 % of raw | uncompressed multi-MB responses |
| B6 | Revalidation | `If-None-Match` returns `304` with no body | always 200 |

**Stage C — first 24 hours.**

| # | Check | Success | Failure |
|---|---|---|---|
| C1 | Credits per rolling 24 h (`spentLast24h`; dashboard daily delta) | ≤ 1,500 (dashboard ≤ 1,600) | dashboard delta > 1,800 |
| C2 | Every budget refusal | `503` with `x-credit-budget`; `boards.overshootStops` = **0** | `overshootStops` > 0 (a board went partial: investigate before raising anything) |
| C3 | Unplanned restarts | 0 | ≥ 1 `exit 134` (heap) or any crash |
| C4 | Memory (`[mem] heapUsed=` log lines / `memory.heapUsedMB`) | ≤ 200 MB (V8 limit ≈ 254 MB) | > 230 MB sustained |
| C5 | Passthrough errors not caused by the provider or the budget | < 5 % of requests over any hour | ≥ 5 % |
| C6 | Turso (when not blocked) | rows read per hour down ≥ 80 % vs the previous day's same hours; no new BLOCKED | reads not down, or a new quota block |
| C7 | While Turso is blocked | `storage.shortCircuited` grows, `refused` statements idle ≈ 0 | per-request refused statements continue |

**Go / no-go to widen:** after 24 h with every Stage C success, ask for approval to raise `PARLAY_DAILY_CREDIT_BUDGET` (suggested next step 2,500) and, separately, to consider the adaptive request plan. Any failure → roll back first, investigate second.

## 6. Rollback (verified on paper and by reversibility test; NOT executed)

- **Exact previous commit:** `d9b0e3ffd6c6217b9948d95394134512796d71d5` (live deploy `dep-dbd9r7dg1s2s73de6ujg`). Second level: `8b0eb62698afda8d9079537d4f8bbf01ad834fd2` (`dep-dbcfjvo473hc73c6noog`).
- **Fastest:** Render dashboard → BeatsEdge → Deploys → `dep-dbd9r7dg1s2s73de6ujg` → *Rollback* (confirm in the dashboard whether Render pauses auto-deploy after a rollback and re-enable it afterwards if so).
- **Via git:** `git revert --no-edit <canary-commit>` then `git push origin HEAD:main` (auto-deploys the reverted tree). Check first that `git diff d9b0e3f HEAD` is empty after the revert.
- **Reversibility proof:** applying the canary patch to a pristine `d9b0e3f` export and then `git apply -R` returns a tree identical to `d9b0e3f` (byte comparison recorded in the manifest).
- **Environment:** the canary needs no environment change. If you set `PARLAY_*` variables explicitly, delete them after rolling back (they are ignored by the old code anyway).
- **Data:** the canary changes no schema and deletes nothing; it writes the same archive rows as before (only fewer lookups). Nothing to undo in Turso.
- **Important limit of rollback:** `d9b0e3f` itself crash-loops while Turso refuses reads (that is today's state). If Turso is still blocked, rolling back returns the service to that crash loop; restoring Turso quota is the real remedy for that, not the rollback.
- After rollback re-run checks A1–A4.

## 7. Confirmations requested (item 7)

- **Edge engine unchanged:** the canary touches no model, grade, scoring or page file (file list in the manifest; none under `BeatsEdge.html`, `lib/*Engine*`, `lib/*Model*`, grading, settlement or snapshot-grade code). The earlier differential browser run showed identical graded text between the patched and unpatched page, and the engine tests are identical with either page.
- **Local 8797 preview and 8798:** not running now (ports closed before and after this work), page file `page-tested.html` unchanged (sha12 `83E09ED93190`), nothing of this work reads from or writes to them; the saved provider responses used for testing were copied read-only.
- **Databases:** `beatsedge.db` and `snapshots.db` in the main repo keep their previous size and modification time (verified before and after, listed in the manifest); the only artifact of the earlier accidental port-3001 start is the rebuildable `beatsedge.db-shm` index. No Turso database was contacted.

## 8. Known limits to keep in mind while watching

1. The credit effect is modelled, not yet measured; Stage B2 is the first real measurement.
2. The page shows a green LIVE pill for a board that arrives partially for any reason; the canary's board-level budget avoids creating such boards, but a provider failure still can.
3. AI Research / Ask BeatsEdge endpoints do not exist on `d9b0e3f`; the canary does not add them.
4. `GET /api/resource-metrics` is unauthenticated (counts and timestamps only: no keys, URLs, bodies or rows). It reveals credit spend and uptime; restrict it if you consider that sensitive.
5. Budget and metrics are per process: a restart clears them (the ParlayAPI dashboard is the persistent record).
