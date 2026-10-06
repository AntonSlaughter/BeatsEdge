# NBA model — FROZEN BETA specification: `nba-edge-2026.10-nodef-v1`

Frozen 2026-10-06. **State: BETA.** **REAL_LINE_VALIDATION = PENDING.**
Any future change to anything below — a formula, a feature, a threshold, a calibration value, the Prime rule, the wild-gap rule, the defense treatment — **must create a new model version** (and start again at BETA). This specification must never be altered silently.

## Frozen specification

| Item | Frozen value |
|---|---|
| Model version | `nba-edge-2026.10-nodef-v1` |
| State | `BETA` (UI gating by state is not implemented; grades are shown) |
| Feature set | `nba-window-blend-v1` — L5 / L10 / season / vs-opponent windows, empirical-Bayes shrinkage blend, factor confluence (recent form, season average, minutes trend, clears-this-line, vs-opponent, rest, home/road, line-vs-market when a real line exists) |
| Opponent defense | **`NONE`** — no NBA opponent-defense input reaches the projection, probability, confidence, grade or Prime (DvP and the similar-defense split are presentation-only `edge.context`, labeled "context only") |
| Calibration id | `nba-defaults-2026-10-06` — `gradeCutoffs: null` (built-in thresholds A ≥ 0.86 & conf ≥ 80, B ≥ 0.68 & conf ≥ 50, C ≥ 0.46), `probCalib: null` (identity probability curve), shipped Prime family layer |
| Wild-gap rule | `abs(edge) / max(line, predictiveSpreadSD) > 0.50` (`wildGapRule: 'floored'`) |
| Predictive spread | `projStdDev(projection, statKey, windows)` — as-of projection + the player's own prior-game windows; never the current game; missing/invalid ⇒ fails closed to the original `abs(edge)/line` rule |
| Grade thresholds | unchanged (above) |
| Prime rule | unchanged: `!thinData && !RED matchup && confShare ≥ 0.67 && edgeSignal ≥ 11%` |
| Final-grade pipeline | one function, `resolveFinalGrade`, for live **and** historical scoring: Prime promotion (C/D → A), real-price cap, probability < 50% (A/B → C), probability < 44% (→ D), D with probability ≥ 58% (→ C); exposes `rawGrade`, `finalGrade`, `gradeAdjustmentReason` |
| Authority | NBA probability and grade read only `NBA_GRADE_CONFIG`; browser `localStorage` (`GRADE_CUTOFFS` / `PROB_CALIB`) cannot alter NBA output |
| Containment (kept) | missing/empty/seeded history ⇒ `INSUFFICIENT_DATA` (no projection/probability/grade/edge/Prime); Smart Parlay needs a real game-log hit rate |

Spec fingerprint (sha256 of the canonical JSON of version + feature set + `NBA_GRADE_CONFIG` + `nbaModelMeta()`): `0e259f391c03d69d584817973397b0fb5cc4fb50fae3fa88afd698c34b523fde`.

## Accepted validation benchmark (SYNTHETIC pseudo-line — player-stat prediction validation)

> **These are NOT sportsbook or DFS profitability claims.** The "line" is the app's own pseudo-line (the half-point whose trailing over-rate is closest to 0.48), built from the player's own history. It cannot test protection against stale or bad market lines, real prices, vig, or closing-line value.

2021–2025 regular seasons, 955,988 graded sides (both sides of each prop), live-shaped inputs built by the live window builders from strictly earlier games, all 12 prop families (PTS, REB, AST, 3PM, STL, BLK, TOV, PRA, PR, PA, RA, BLK+STL):

| Grade | Hit rate | Coverage |
|---|---|---|
| A | 68.5% | 5.24% |
| B | 63.3% | 16.24% |
| C | 54.6% | 33.40% |
| D | 39.7% | 45.12% |
| Prime | 65.8% | 12.82% |

- All 12 families monotone (A ≥ B ≥ C ≥ D); all five seasons monotone.
- Calibration (walk-forward on unseen seasons 2023–2025): default `nba-defaults-2026-10-06` kept; the app's own recalibration curve improved slope (1.32 → 1.14) but worsened Brier by 0.00066 in all three seasons and was rejected.
- Defense: the previous model (generic points-rank nudge + stat-specific multiplier) was worse than no defense on every family in every season; prop-specific allowance features improved MAE by only 0.08–0.27% and were not adopted (BLK candidate kept as a research candidate only).
- Wild-gap rule: candidate D accepted by explicit decision. By the predeclared criteria no candidate passed (criterion (2) was mis-specified); the decision stands as a decision, recorded as such. D restores BLK ordering (B 67.0% ≥ C 53.8%).
- Evidence (not committed; regenerate with the scripts in `scripts/model-integrity/`): `tmp/model-integrity/nba-defense/`, `nba-defense-replacement/`, `nba-full-validation/`, `nba-calibration-grade-prime/`, `nba-grade-decomposition/`, `nba-cap-validation/`.

## Outstanding requirement (does not block the freeze)

**REAL_LINE_VALIDATION = PENDING.** No genuine archived NBA provider lines exist locally (`nba_provider_line_archive`: 0 rows; 39 unsettled archived predictions). Once genuine NBA lines and settled outcomes accumulate, this specification — in particular the wild-gap rule D, the grade thresholds, the Prime rule and the probability calibration — **must be revalidated against those real lines**, kept strictly separate from the synthetic results above. Until then the model stays BETA and no profitability or edge-versus-market claim may be made.

## Scope boundaries

- WNBA is **unchanged** and **REQUIRES SEPARATE VALIDATION** (it still shares the engine's generic-defense path code, which is dormant only because `wnbaDvpFor` returns `null`, and the opponent-rank-keyed `simdef` factor is still a live model factor for WNBA).
- MLB, NFL and NCAAF behavior is unchanged (verified identical to the pre-change page).
- NBA localStorage isolation does **not** cover other sports.

## Tests

`scripts/test-nba-grade-pipeline-parity.js`, `scripts/test-nba-defense-removed-and-parity.js`, `scripts/test-model-integrity-containment.js`, `scripts/test-nhl-main-line-integrity.js` (+ the existing repo suites). A few checks `SKIP` when the untracked `tmp/` evidence is absent.
