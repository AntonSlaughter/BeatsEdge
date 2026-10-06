# WNBA model — FROZEN BETA specification: `wnba-edge-2026.10-nodef-v1`

Frozen 2026-10-06. **State: BETA.** **REAL_LINE_VALIDATION = PENDING.**
Any future change to anything below — a formula, a feature, a threshold, a calibration value, the Prime rule, the wild-gap rule, the defense treatment, the projection weights — **must create a new model version** (and start again at BETA). This specification must never be altered silently.

## Frozen specification

| Item | Frozen value |
|---|---|
| Model version | `wnba-edge-2026.10-nodef-v1` |
| State | `BETA` (UI gating by state is not implemented; grades are shown) |
| Feature set | `nba-window-blend-v1` — the shared live window builders (L5 / L10 / season / vs-opponent windows, empirical-Bayes shrinkage blend, factor confluence). Projection weights unchanged. |
| Opponent defense | **`NONE`** — the opponent-points-rank similar-defense split (`simdef`) is presentation-only `edge.context`, labeled "context only"; no defense input reaches the projection, probability, confidence, grade or Prime |
| Calibration id | `wnba-defaults-2026-10-06` — `gradeCutoffs: null` (built-in thresholds A ≥ 0.86 & conf ≥ 80, B ≥ 0.68 & conf ≥ 50, C ≥ 0.46), **`probCalib: null` (identity probability curve)**; no family calibration layer exists for WNBA |
| Wild-gap rule | **Cap C**: `abs(edge) / max(line, predictiveSpreadSD) > 0.50` (`wildGapRule: 'floored'`). Threshold 0.50 unchanged; no family-specific values |
| Predictive spread | `projStdDev(projection, statKey, windows)` — as-of projection + the player's own prior-game windows; never the current game; missing/invalid ⇒ fails closed to the original `abs(edge)/line` rule |
| Grade thresholds | unchanged (above) |
| Prime rule | unchanged: `!thinData && !RED matchup && confShare ≥ 0.67 && edgeSignal ≥ 11%` |
| Final-grade pipeline | one function, `resolveFinalGrade`, for live **and** historical scoring (the in-app WNBA backtest scores `sport:'wnba'` with the live builders' inputs): Prime promotion (C/D → A), real-price cap, probability < 50% (A/B → C), probability < 44% (→ D), D with probability ≥ 58% (→ C); exposes `rawGrade`, `finalGrade`, `gradeAdjustmentReason` |
| Authority | WNBA probability and grade read only `WNBA_GRADE_CONFIG`; browser `localStorage` (`GRADE_CUTOFFS` / `PROB_CALIB`) cannot alter WNBA output; the in-app WNBA backtest is diagnostic-only and persists nothing |
| History integrity | `"--"` in the ESPN gamelog is a **missing** observation (WNBA parse), a recorded `0` stays a valid observed zero; missing/empty/seeded history ⇒ `INSUFFICIENT_DATA` (no projection/probability/grade/edge/Prime); the +EV list itself refuses insufficient / unsupported props |

**Canonical configuration fingerprint** (sha256 of the key-sorted JSON of version + feature set + `WNBA_GRADE_CONFIG` + `wnbaModelMeta()`):

`13ac5cf63275ce3271e98454679cb1884cc3c3ee7602217d170f1f6203e9cd59`

Reproduce with `node scripts/lib/wnbaSpecFingerprint.js`; `scripts/test-wnba-integrity.js` pins it, so any change to a spec value fails the test until a **new model version and a new hash** are recorded.

## Accepted calibration-gate exception (recorded decision)

The normal BETA gate requires the pooled calibration slope to be within `[0.7, 1.3]`. WNBA's identity calibration has a **pooled walk-forward slope of 1.38** (unseen seasons 2023–2026, 314,860 sides; Brier 0.23617, ECE 0.0247; by family PTS 1.46, PRA 1.84, BLK 1.89, STL 0.92, TOV 0.98, BLK+STL 0.99). **The exception is accepted** because:

- the direction is **under-confidence** (stated probabilities are conservative: A-grade stated 65.4% vs 68.9% hit), not over-confidence;
- the best alternative, a global 2-parameter logistic (candidate D), improved pooled Brier (−0.00094, CI excludes 0), slope (→ 1.008) and ECE (→ 0.0013) in all four test seasons **but materially worsened STL (+0.00156), TOV (+0.00121) and BLK+STL (+0.00113) Brier**; those families are not knowingly degraded to improve a pooled metric;
- the app's own monotone recalibration (candidate C) was worse than the identity (+0.00068 Brier).

D was **not** implemented, no further calibration search was run, and no family calibration layer was created. Family-aware calibration is deferred until stronger / real-line evidence justifies it. A residual **side bias** remains and is not corrected: on the pseudo-line, realized Over rate is 46.1% vs 49.4% stated and realized Under rate is 53.9% vs 50.1% stated (Unders hit materially more than Overs at every grade — see benchmark).

## predictiveSpreadSD caveat

`predictiveSpreadSD` is a **conservative scale/floor, NOT a precise WNBA per-player standard deviation.** Its coefficient-of-variation constants are NBA-derived; measured against observed WNBA error it runs **25–51% too wide** (mean SD / RMSE 1.25–1.51; 81–93% of outcomes fall within 1 SD vs ≈ 68% for a well-sized normal) and is only weakly rank-informative (Spearman with |error| 0.14–0.35). **The engine's 1.0 floor dominates many low-line observations: it binds 79% of BLK, 44% of STL, 44% of 3PM and 20% of TOV.** For those families `max(line, predictiveSpreadSD)` therefore behaves as `max(line, 1.0)` — a floor, not a per-player scale. The SD constants were **not** re-optimized (out of scope); do not describe the cap as a calibrated WNBA volatility model.

## Accepted validation benchmark (SYNTHETIC pseudo-line — player-stat prediction validation)

> **These are NOT sportsbook or DFS profitability claims, ROI, or real-market hit rates.** The "line" is the app's own pseudo-line (the half-point whose trailing over-rate is closest to 0.48), built from the player's own prior games. It cannot test protection against stale or bad market lines, real prices, vig, or closing-line value.

2021–2026 regular-season targets, strict as-of inputs built by the live window builders from strictly earlier games: 19,181 player-games, 227,976 prop records, **455,952 graded sides**, all 12 families (PTS, REB, AST, 3PM, STL, BLK, TOV, PRA, PR, PA, RA, BLK+STL). Final pipeline, Cap C, identity calibration:

| Grade | Hit rate | Coverage | Stated P̄ |
|---|---|---|---|
| A | 68.9% | 6.9% | 65.4% |
| B | 62.4% | 16.3% | 58.4% |
| C | 54.1% | 31.2% | 52.6% |
| D | 39.9% | 45.6% | 42.4% |
| **Prime** | **66.9%** (95% CI 66.5–67.3) | **12.84%** | 63.0% |

- All 12 families strictly monotone (A ≥ B ≥ C ≥ D); all six seasons monotone; Prime hit 66.1–68.0% in every season and 62.3–77.6% in every family (weakest: TOV 62.3%, BLK+STL 62.5%, STL 62.7%).
- **BLK** ordering restored: from 74.1 / 65.6 / 70.7 / 29.5 (original cap; B below C in 6/6 seasons) to **79.1 / 68.5 / 52.9 / 29.5**. The original `|edge|/line` rule capped 16.8% of all sides (BLK 49.8%, 3PM 35.4%, STL 33.3%); Cap C caps 1.3% (0.5–2.4% per family).
- Over/Under split (Cap C): A-grade Over 61.8% (19,484) vs Under 80.7% (11,804); B-grade Over 57.6% vs Under 69.4%; Prime Over 60.3% (31,815) vs Under 74.7% (26,740). Both sides are monotone; the gap is partly a base-rate artifact of the synthetic line (realized Over rate 46.1%) and cannot be separated from a model effect without real lines.
- The comparison that led to Cap C is a recorded **decision**: by the predeclared literal criteria no candidate was eligible because the symmetric Prime-hit test (e2) fired on an *improvement* (Prime 65.1% → 66.9%), which was rejected as a decision criterion; the original rule additionally failed the BLK ordering tests. Capped would-be-A/B sides did not regress on this pseudo-line (Cap C: 70.8% hit vs 64.4% uncapped) — the cap is kept as a guard against implausible gaps on genuine lines, which the pseudo-line cannot test.
- Evidence (not committed; regenerate with the scripts): `tmp/model-integrity/wnba-phase1/`, `tmp/model-integrity/wnba-final/results.json` + `report.md`, from `scripts/model-integrity/wnba-phase1-diagnostics.js`, `scripts/model-integrity/wnba-final-calibration-cap-validation.js`, `scripts/model-integrity/format-wnba-final-report.js`.

## Leakage test on the frozen configuration (`scripts/test-wnba-leakage.js`)

Real production scorer (`nbaBacktestSeries`, WNBA mode) on real `wnba_player_box` rows: 12 players × all 12 families = 142 series with a scored target. Mutating the target game's outcome, all later games' outcomes, or both (absurd highs and zeros) left **every** prediction at or before the target identical across 14,370 compared predictions (projection, `predictiveSpreadSD`, raw/final probability, cap state, thin flag, raw/final grade, Prime, confidence, edge, factors). Non-vacuity: mutating a prior game changed the target prediction in 142/142 series, and the target-game mutation changed the *next* game's prediction in 142/142. A row-index marker run over 10,176 scored predictions proved the per-game log, L5/L10 windows and season window contain exactly the strictly-earlier rows (never the target or a later row).

## Outstanding requirement (does not block the BETA freeze)

**REAL_LINE_VALIDATION = PENDING.** The existing WNBA line archive is insufficient: 13,939 provider rows from one capture window (2026-09-22), 9 events, 300 players; 239 prop snapshots from one day; **0 settled**. Once genuine WNBA lines and settled outcomes accumulate, this specification — in particular Cap C, the grade thresholds, the Prime rule, the identity calibration and the Over/Under side bias — **must be revalidated against those real lines**, kept strictly separate from the synthetic results above. Until then the model stays BETA and no profitability or edge-versus-market claim may be made.

## Scope boundaries

- NBA is frozen separately (`docs/NBA_MODEL_FREEZE_BETA_2026-10-06.md`, `nba-edge-2026.10-nodef-v1`); its behavior is unchanged (verified identical to the committed page).
- MLB, NFL and NCAAF behavior is unchanged (verified identical to the committed page); they still read browser-local `GRADE_CUTOFFS` / `PROB_CALIB`.
- The WNBA **period model** (first-half / quarter markets) is separate, uncommitted work with its own grade cutoffs; it is not part of this freeze.

## Tests

`scripts/test-wnba-integrity.js` (spec + fingerprint, Cap C active, live/backtest parity, localStorage isolation, `simdef` cannot affect output, zero observations vs observed zeros, `"--"` is missing, +EV containment, NBA / MLB / NFL / NCAAF identical to HEAD, period-model block untouched), `scripts/test-wnba-leakage.js`, plus `scripts/test-nba-defense-removed-and-parity.js`, `scripts/test-nba-grade-pipeline-parity.js`, `scripts/test-model-integrity-containment.js`, `scripts/test-e2e-model-parity-nba.js`, `scripts/test-nhl-main-line-integrity.js`.
