# NFL model — FROZEN BETA specification: `nfl-edge-2026.10-nodef-v1`

Frozen 2026-10-06. **State: BETA.** **REAL_LINE_VALIDATION = PENDING / DATA GAP.**
**Future NFL model changes require a new model version** (and start again at BETA): any change to a formula, feature, threshold, calibration value, the Prime rule, the wild-gap rule, the A-grade rules, the defense treatment, the low-line policy or the history semantics below. This specification must never be altered silently.

## Frozen specification

| Item | Frozen value |
|---|---|
| Model version | `nfl-edge-2026.10-nodef-v1` |
| State | `BETA` (UI gating by state is not implemented; grades are shown) |
| Feature set | `nfl-window-blend-v1` — the live NFL window builders (`nflComputeWindows`; L5 / L10 / season / vs-opponent windows over the previous two seasons + current, empirical-Bayes shrinkage blend) |
| Projection | **Unchanged from the cleaned Phase-2 model:** `0.35·L5 + 0.25·season + 0.25·L10 + 0.15·vsOpp`, L5 / L10 shrunk toward season (k = 8), vsOpp shrunk (k = 10). No weight was retuned. |
| Defense | **`NONE`.** The generic team points-allowed rank (and the DvP table, defensive-interception data) is **context / display only** (`edge.context`, labeled "context only"). It cannot affect the projection, probability, confidence, grade or Prime. The old ±6% rank multiplier and the `oppdef` confluence factor no longer apply to NFL (CFB keeps its previous behavior). |
| Calibration | **IDENTITY** — `probCalib: null`, id `nfl-defaults-2026-10-06`. No global and no family calibration. (A 2-parameter logistic improved pooled Brier by 0.00052 but degraded PassTD by +0.0023 and RecYds by +0.0007, so it was not adopted.) |
| Grade thresholds | **Unchanged:** `gradeScore = 0.25·confidence + 0.75·edgeComponent`; A ≥ 0.86 & confidence ≥ 80, B ≥ 0.68 & confidence ≥ 50, C ≥ 0.46, else D; RED-matchup and thin-data caps unchanged |
| Wild-gap rule | **Cap C:** `abs(edge) / max(line, predictiveSpreadSD) > 0.50` (`wildGapRule: 'floored'`). Threshold exactly 0.50, no family-specific values; an invalid / missing spread fails closed to the original `abs(edge)/line` rule. The football thin-history protection (`games < 4` thin cap, and `games < 6 && abs(edge)/line > 0.30`) is kept **separately and unchanged**. |
| NFL A-grade rule | **The football "an A needs ≥ 4 supporting factors" requirement is REMOVED FOR NFL ONLY.** It is unchanged for CFB (NCAAF) and every other sport. |
| Prime rule | **Unchanged:** `!thinData && !RED matchup && confShare ≥ 0.67 && edgeSignal ≥ 11%` |
| Final-grade pipeline | one function, `resolveFinalGrade`, for live **and** historical scoring (Prime promotion, real-price cap, probability < 50% → C, < 44% → D, D with ≥ 58% → C); exposes `rawGrade`, `finalGrade`, `gradeAdjustmentReason`. The NFL backtest scorer (`nflBacktestSeries`) runs the same pipeline with live-builder inputs. |
| Rare events | **RushTD prior 0.175, RecTD prior 0.187**, Poisson count model (λ = projection), regression toward the frozen league rate, calibration curve bypassed, raw band 0.03–0.97 — exactly as validated; unchanged. Engaged on 100% of sub-1 RushTD / RecTD sides. |
| Low-line policy | **Every other NFL line < 1 with no validated recipe is `NOT_YET_MODELED` (fail closed).** The real line is shown; no model probability, grade, Prime, Best Plays, +EV or Smart Parlay. The restriction applies to the sub-1 offering only, not to the stat at normal lines. |
| Missing / zero semantics (NFL only) | a recorded `0` is a valid observation; **all-zero recorded history is valid history** (n games, average 0); `"--"`, blank, null and undefined are **missing** (never zero); a combo (Pass+Rush, Rush+Rec) missing a required component is a missing combo observation for that game (never zero-filled). A stat with zero recorded observations has no window → INSUFFICIENT_DATA. |
| Authority | NFL probability and grade read only `NFL_GRADE_CONFIG`; browser `localStorage` (`GRADE_CUTOFFS` / `PROB_CALIB`) cannot alter NFL output; the NFL in-app backtests are diagnostic-only and persist nothing. |
| Containment | missing / empty / seeded history ⇒ INSUFFICIENT_DATA; the +EV list itself refuses insufficient, `modelSupported:false` and NOT_YET_MODELED props; Smart Parlay needs a real game-log hit rate. |

**Canonical configuration fingerprint** (sha256 of the key-sorted JSON of version + feature set + `NFL_GRADE_CONFIG` + `nflModelMeta()`):

`f82b3a3a521311d9e568c111c8c85491be194901ce2e4f7f510cfec955baabc3`

Reproduce with `node scripts/lib/nflSpecFingerprint.js`. `scripts/test-nfl-integrity.js` pins it, so any change to a spec value fails the test until a **new model version and a new hash** are recorded.

## Historical dataset

`nfl_player_game_stats` (23,543 rows, 1,026 players, 2022-09-08 … 2026-09-21; QB / RB / WR / TE only; no NULLs — an unrecorded stat is stored as 0; 8 rows without a game date dropped). Regular-season targets **2023–2026** (2026 is weeks 1–2 only) with ≥ 6 prior games, inputs built by the live builder from **strictly earlier** rows (previous two seasons + current): **14,933 targets → 82,871 prop records → 165,742 graded sides**, 14 testable stats. Not historically testable (columns do not exist): longRush, longRec, kickingPts, fgMade. **Withheld as NOT_YET_MODELED: 11,817 records** (INT 1,708 · RushYds 4,201 · Rec 2,188 · RecYds 1,305 · Targets 1,190 · PassTD 568 · Rush+RecYds 352 · RushAtt 254 · PassComp 18 · PassAtt 16 · PassYds 11 · Pass+RushYds 6; RushTD / RecTD 0).

## Final historical results — SYNTHETIC pseudo-line, computed from the implemented scorer

> **These are NOT sportsbook or DFS profitability claims, ROI, or real-market hit rates.** The "line" is the app's own pseudo-line (scale-aware; the value whose trailing over-rate is closest to 0.48), built from the player's own earlier games. It cannot test stale or bad market lines, prices, vig or closing-line value. **For TD props it carries a ~82% Under base rate** (RushTD pseudo-line Over 18.5%, RecTD 17.5%), so TD grades largely sort Over vs Under; the **non-TD10** view (excluding PassTD, INT, RushTD, RecTD) is the cleaner read of model skill.

Numbers come from the in-app `nflBacktestSeries` invoked once per target; its own accumulator matches the tallies exactly (grade counts, hits, Prime).

| Grade | All 14 stats: hit (N, coverage, stated) | Non-TD10: hit (N, coverage, stated) |
|---|---|---|
| A | 80.1% (16,557, 9.99%, 79%) | 60.4% (3,978, 3.06%, 61%) |
| B | 59.5% (27,029, 16.31%, 58%) | 58.2% (24,031, 18.47%, 56%) |
| C | 52.9% (43,539, 26.27%, 52%) | 52.5% (41,426, 31.85%, 52%) |
| D | 38.8% (78,617, 47.43%, 39%) | 44.3% (60,649, 46.62%, 45%) |
| **Prime** | **73.1%** (27,944, 16.86%, stated 71.2%; CI 72.6–73.6) | **61.1%** (13,111, 10.08%, stated 58.7%; CI 60.3–61.9) |

- **Monotone:** A ≥ B ≥ C ≥ D overall, in each of the four seasons, on Over and on Under, in all 14 stats and all 9 structural families — **no significant inversion anywhere**. One non-significant point-estimate inversion: RushAtt A 62.0% (n = 305) vs B 62.7% (0.7 pt, z 0.2).
- **Seasons (all stats, A / B / C / D):** 2023 80.5 / 59.8 / 52.9 / 38.9 · 2024 79.6 / 60.4 / 53.4 / 38.1 · 2025 80.5 / 58.5 / 52.6 / 39.1 · 2026 (partial) 77.3 / 58.2 / 52.2 / 40.3. Prime 73.7 / 73.1 / 72.9 / 71.2%. **Non-TD10 Prime 62.1 / 61.1 / 60.8 / 55.7% (2026 partial, n = 490).**
- **Over / Under (all stats):** Over A 57.4 · B 53.0 · C 46.2 · D 27.2; Under A 86.3 · B 69.6 · C 61.8 · D 49.6. Prime Over 54.6% (8,997), Under 81.9% (18,947). Non-TD10: Over 57.8 / 53.1 / 46.2 / 34.6, Under 73.6 / 68.8 / 61.5 / 49.5.
- **TD families:** RushTD A / B / C / D = 87 / 73 / 61 / 19 (Under base 81.5%), RecTD 86 / 73 / 66 / 18 (Under base 82.5%); Prime 84.7% on both. The original cap's 11-pt B<C inversions are gone. About three quarters of all A-grade sides (12,360 of 16,557) are RushTD / RecTD Unders — read the headline A hit rate with that in mind.
- **Calibration (identity):** pooled Brier 0.2217, pooled slope 1.14 (inside the default BETA gate [0.7, 1.3]), mean stated 49.7% vs 50.0% actual. **Probabilities are under-confident on the non-TD stats** (non-TD10 slope 1.46; PassAtt / PassComp / Pass+RushYds / RushAtt about 1.9). This is the conservative direction and is documented, not corrected (family-aware calibration is deferred until stronger / real-line evidence exists).
- Evidence (not committed; regenerate with the scripts): `tmp/model-integrity/nfl-final-numbers/results.json` from `scripts/model-integrity/nfl-final-measure.js`; the decision studies `nfl-phase1-*`, `nfl-final-calibration-cap-validation.js`, `nfl-4factor-rule-validation.js` and their `tmp/model-integrity/nfl-*` outputs (the Phase-1 and 4-factor scripts describe the **pre-implementation** page and are not expected to run unmodified against this one).

## Decisions recorded

- **Cap C** was approved by explicit decision. By the predeclared literal criteria no candidate was eligible (the spread gate failed, and the one-sided degradation test fired on a statistically null 1.1-pt gap in a 451-side cell); capped would-be A/B sides did not regress on the pseudo-line (e.g. 86.2% / 76.6% hit vs 65.6% / 60.5% uncapped under the old rule). Cap C effectively removes the cap where the 1.0 spread floor exceeds a sub-1 line (the TD stats) and equals the original rule wherever `line ≥ predictiveSpreadSD`.
- **4-factor A requirement removed for NFL only:** under the rule non-TD A = B (58.5% vs 58.5%); without it A 60.4% vs B 58.2%. The vs-opponent factor it effectively required (≥ 2 prior games vs the opponent, available on 26.5% of sides) added no discrimination on non-TD stats (supports 61.8% / against 62.4% / absent 61.9%). Newly promoted non-TD A sides hit 60.8% (n = 3,347) vs 58.5% for shared A and 58.2% for the remaining B.

## predictiveSpreadSD caveat

`predictiveSpreadSD` is a **conservative scale / floor, NOT a validated NFL per-player standard deviation.** It is the engine's 1.0 floor on **99% of RushTD and 100% of RecTD** observations (spread / error ratio 2.1–2.2, i.e. a constant), it is **negatively** related to realized absolute error for QB passing stats (Spearman −0.04 PassYds, −0.23 PassAtt, −0.18 PassComp), and it is informative only for skill-position yards / volume stats (Spearman 0.25–0.43: RushYds, RushAtt, RecYds, Targets, Rec). Its constants were **not** re-optimized. Cap C uses it only where `predictiveSpreadSD > line` (62% of RushYds, 65% of RecYds, 53% of Rush+RecYds records, and the TD stats); where `line ≥ spread` Cap C equals the original rule.

## Leakage and parity (final configuration)

- **Leakage (`scripts/test-nfl-leakage.js`)** — real production scorer on real rows: 48 players × all 14 testable stats = **310 series**, **30,840 predictions compared** across the mutation runs. Mutating the target game's outcome, all later games, or both changed **0** predictions at or before the target (projection, spread, probability, cap, grade, Prime). Mutating an eligible prior game changed the target prediction in **310 / 310** series; the target-game mutation changed the next game's prediction in **309 / 309**. A row-index marker run over **11,273 scored predictions** (4,337 with the full 40-game log) proved the per-game log, L5, L10 and season windows contain exactly the strictly-earlier rows; sampled histories have strictly increasing dates (0 violations). **2,190 scorings** with team-defense rank 1 / 12 / 30 / 32 / absent, an absurd DvP-by-position object and defensive-interception data were identical; the scorer passes no defensive snapshot at all.
- **Live / backtest parity (`scripts/test-nfl-integrity.js`)** — 2,636 real-row predictions across 14 stats: the in-app scorer and an independently built production-shaped live scoring are identical on projection, `predictiveSpreadSD`, raw / final probability, confidence, raw / final grade, adjustment reason, Prime, wild-gap state, thin state and the model-supported state (builder gate + engine).
- **Latent path (documented, unreachable):** the engine's generic rest / venue factors read `player.situational`; it is attached only by `fetchPlayerSituationalData`, which returns immediately unless the sport is NBA, and no NFL player constructor sets it.

## Strict-combo telemetry

The database has no NULLs, so offline the strict combo rule loses nothing. A read-only sample of real ESPN gamelogs (98 players, 1,077 games, 2025) showed the strict rule loses **0** observations beyond the old rule: ESPN prints `0`, not `--`, for zero attempts (4 empty WR rows are dropped by both rules). One season only.

## Outstanding requirement (does not block the BETA freeze)

**REAL_LINE_VALIDATION = PENDING / DATA GAP.** `nfl_provider_line_archive` has 0 rows; `prop_snapshots` holds 282 NFL rows from two days, of which 81 are settled (one day). Once genuine NFL lines and settled outcomes accumulate, this specification — Cap C, the grade rules (including the removed 4-factor requirement), the Prime rule, the identity calibration, the low-line policy and the Over/Under skew — **must be revalidated against those real lines**, kept strictly separate from the synthetic results above. Until then the model stays BETA and **no profitability, ROI or edge-versus-market claim may be made.**

## Known limitations

2026 is a two-week partial season; the football thin-history clause is inert in the validation set (≥ 6 prior games; 1,880 targets with 1–5 prior games are graded live under the thin cap but were not validated); A-grade coverage is dominated by TD Unders; per-stat probabilities are under-confident; sub-1 lines (≈ 12.5% of candidate records) are not modeled; NFL positions are QB / RB / WR / TE only (no kickers).

## Scope boundaries

NBA (`nba-edge-2026.10-nodef-v1`) and WNBA (`wnba-edge-2026.10-nodef-v1`) are frozen separately and unchanged; MLB, NCAAF (including its 4-factor A requirement) and NHL are unchanged (verified identical to the committed page); the WNBA period-model work is separate and not part of this freeze.

## Tests

`scripts/test-nfl-integrity.js` (spec + fingerprint, Cap C formula, NFL-only 4-factor removal vs CFB, live/backtest parity incl. model-supported state, defense context-only, localStorage isolation, zero / missing / combo semantics, rare-event bit-identity vs the committed page, low-line fail-closed, +EV gate, containment, NBA / WNBA / MLB / NCAAF / NHL unchanged), `scripts/test-nfl-leakage.js`, plus `test-nba-defense-removed-and-parity`, `test-nba-grade-pipeline-parity`, `test-wnba-integrity`, `test-wnba-leakage`, `test-model-integrity-containment`, `test-nhl-main-line-integrity`, `test-nhl-model-parity`, `test-e2e-model-parity-nba`.
