# MLB model — FROZEN BETA specification: `mlb-edge-2026.10-v1`

Frozen 2026-10-07. **State: BETA.** **REAL_LINE_VALIDATION = PENDING / DATA GAP.**
**Future MLB model changes require a new model version** (and start again at BETA): any change to a formula, feature, threshold, calibration value, the Prime rule, the wild-gap rule, the rare-event recipes / blend / grade policy, the low-line policy, the confluence treatment or the history semantics below. This specification must never be altered silently.

> **Historical results below use PSEUDO-LINES (the app's own market-typical fixed half-point lines; no genuine historical MLB sportsbook / DFS lines or settlements exist). They are NOT evidence of real sportsbook or DFS profitability, ROI, edge-versus-market or closing-line value.** No such claim may be made until real-line validation is done.

## Frozen specification

| Item | Frozen value |
|---|---|
| Model version | `mlb-edge-2026.10-v1` |
| State | `BETA` (UI gating by state is not implemented; grades are shown, except for the rare-event markets, which are probability-only) |
| Feature set | `mlb-window-blend-v1` — the live MLB window builders (`mlbComputeWindows` / `mlbBuildGameList` / `mlbMergeWindows`: season, last-10 and last-5 windows over the previous season + current, built from real game logs) |
| Projection / history architecture | **Unchanged from the Phase-2 cleaned model:** `projection = 0.35·L5 + 0.25·season + 0.25·L10 + 0.15·vsOpp`, L5 / L10 shrunk toward season (k = 8), vsOpp shrunk (k = 10). Probability = distribution (normal CDF, or the quantile model for TB / outs / RBI / walks, or the Poisson recipe for the rare four) → regression toward 50% (shrink = min(.80, .45 + min(games, 40)/40·.35)) → generic history blend (game-log EB rate, last-10 rate; **not** for the rare four, see R1) → factor nudge (none for MLB: only the two in-projection factors) → raw clamp. No weight was retuned. |
| Calibration | **IDENTITY** — `probCalib: null`, id `mlb-v1-identity-2026-10-07`. No curve, no family layer. (A pooled monotone / logistic curve improved pooled non-rare Brier by 0.0004 but damaged `pitching_outs` / `pitching_runs` and did not fix the Over/Under asymmetry; not adopted.) |
| Grade thresholds | **Unchanged:** `gradeScore = 0.25·confidence + 0.75·edgeComponent`; A ≥ 0.86 & confidence ≥ 80, B ≥ 0.68 & confidence ≥ 50, C ≥ 0.46, else D; RED-matchup and thin-data caps unchanged |
| Wild-gap rule | **Cap C:** `abs(edge) / max(line, predictiveSpreadSD) > 0.50` (`wildGapRule: 'floored'`, spec string `abs(edge) / max(line, predictiveSpreadSD) > 0.50`). Threshold exactly 0.50, no family values; an invalid / missing / non-positive spread fails closed to the original `abs(edge)/line` rule. The **thin-history protection (`sampleGames < 3` ⇒ thin ⇒ A/B → C) is kept separately and unchanged.** |
| predictiveSpreadSD caveat | **`predictiveSpreadSD` is used only as a conservative scale / floor. It is NOT validated as a true per-player standard deviation.** See "predictiveSpreadSD caveat" below. |
| Prime rule | **Unchanged:** `!thinData && !RED matchup && confShare ≥ 0.67 && edgeSignal ≥ 11%` |
| Final-grade pipeline | one function, `resolveFinalGrade` (Prime promotion, real-price cap, probability < 50% → C, < 44% → D, D with ≥ 58% → C), used by the live card, the board and every historical scorer; exposes `rawGrade`, `finalGrade`, `gradeAdjustmentReason` |
| Confluence | **F0 retained exactly:** confluence (recent form + season; 2 model factors, confidence 0 / 50 / 100) stays inside the grade. It is **not** context-only. (Phase 4: moving it to context-only widened A+B to 192k sides, lowered the A+B lift by 0.62 pt (z −3.7), added a `pitching_outs` inversion and damaged `total_bases` / `pitching_outs`.) |
| Rare-event recipes | **Frozen priors: HR 0.129, 2B 0.162, 3B 0.016, SB 0.077** (2022–2025 TRAIN P(stat ≥ 1)). Poisson count model (λ = projection), shrink/regression toward the frozen league rate, calibration curve bypassed, raw band 0.03–0.97, eligibility = `sport === 'mlb' && line < 1.0 && stat in priors`. **Unchanged.** |
| **R1 — rare history-blend bypass** | The four rare-event recipes **bypass the generic history probability blend entirely** (`rareEventBlend: 'bypass-history'`): no game-log EB prior, no last-10 prior. Their probability is the frozen Poisson/shrink recipe probability, clamped to 0.03–0.97. Evidence: the blend inflated Over probabilities by +2.4 to +3.6 pt (last-10 prior +2.28, game-log prior +0.61 pooled); the recipe alone was within ±0.7 pt. Every non-rare market keeps its blend. |
| **P2 — rare grade policy** | **HR / 2B / 3B / SB are probability-only** (`rareEventGradePolicy: 'probability-only'`): the real provider line, the model probability, the projection / edge / context are shown; **NO A/B/C/D letter (grade, rawGrade, finalGrade, gradeScore, gradeAdjustmentReason are `null`), NO Prime**; excluded from Best Plays, Prime Plays, +EV, Smart Parlay and every ranking surface (`rankingEligible: false`, `gradePolicy: 'RARE_EVENT_PROBABILITY_ONLY'`); never a board headline grade; sorted after every graded prop. They are **modeled** (not "unsupported"); they are simply ungraded rare-event probabilities. |
| Low-line policy (Phase 2, unchanged) | HR / 2B / 3B / SB on a sub-1 line use the validated rare-event recipe. **Hits 0.5 and Batter Strikeouts 0.5 remain modeled by their documented generic path** (not a validated recipe; Phase-1 gaps +0.6 / +1.5 pt). **Every other MLB line < 1 (runs, RBIs, singles, batter walks, total bases, earned runs, pitcher walks, …) is `NOT_YET_MODELED`** (real line shown; no probability, grade, Prime, Best Plays, +EV or Smart Parlay). |
| Matchup / splits | **CONTEXT ONLY** (`edge.context`, labeled "context only"): opposing starter WHIP / lineup K-rate, batter-vs-starter, platoon and home/road splits cannot reach the projection, probability, confluence, grade or Prime. The platoon / bvp ±12% / ±10% projection multiplier was removed in Phase 2. |
| Parser / combo semantics | a recorded `0` is a valid observation; **all-zero recorded history is valid history**; `"--"`, blank, null, undefined, NaN are **missing** (never zero); a combo (H+R+RBI, singles, hitter fantasy, pitcher fantasy) missing any component is a missing observation; innings-pitched notation (5.1 IP = 16 outs) parsed exactly, an explicit outs value is never overridden. A stat with zero recorded observations has no window → INSUFFICIENT_DATA. |
| Board / card / backtest parity | One authoritative scoring path: the collapsed board loads the same real game logs (`warmMlbSlateForm`) and builds the same windows as the expanded card; the in-app validation (`mlbBacktestInputs` / `mlbBacktestSeries`) uses the same production builders and the same `calculateEdgeScore`. A seeded placeholder window **never** yields a probability, grade or Prime (INSUFFICIENT_DATA until real history loads; fails closed if it cannot). Exact field-for-field and probability-step-for-probability-step parity is pinned by tests. |
| Strict temporal behavior | History for a target = games with date **strictly earlier** than the target date (previous season + current season); same-day games are excluded; a doubleheader date is never a target. Mutating the target game, later games, or both cannot change a prediction; mutating a prior game can. |
| Downstream gates | Best Plays, Prime, +EV (list **and** the +EV flag attachment) and Smart Parlay refuse NOT_YET_MODELED, INSUFFICIENT_DATA and model-unsupported props (`isModelEligibleProp` / `isModelEligibleEdge`), and **additionally refuse probability-only edges** (`isRankingEligibleEdge`: `rankingEligible !== false && grade != null`). Smart Parlay needs a real game-log hit rate and refuses probability-only edges. No ranking formula was changed. |
| Authority | MLB probability and grade read only `MLB_GRADE_CONFIG`; browser `localStorage` (`GRADE_CUTOFFS` / `PROB_CALIB`) and in-memory writes cannot alter MLB output; the in-app MLB backtests are diagnostic-only and persist nothing. Ungraded rare-event sides are tallied in `acc.rareProbOnly` only, never in a letter / Prime / confluence table. |
| Metadata | every MLB edge carries `modelMeta`: `modelVersion`, `state` / `modelState` = `BETA`, `calibration` = `identity`, `defenseMatchup` = `context-only`, `wildGapRule` = `floored` (+ spec string and spread caveat), `rareEventBlend` = `bypass-history`, `rareEventGradePolicy` = `probability-only`, `confluence` = `IN_GRADE`, `rareEventPriors`, `lowLineRecipes`, `lowLineCalibratedNoRecipe`, `realLineValidation` = `PENDING`; copied into the archived row's `dataQuality` JSON (with `gradeTrace.gradePolicy`). |

**Canonical configuration fingerprint** (sha256 of the key-sorted JSON of version + feature set + `MLB_GRADE_CONFIG` + `mlbModelMeta()` + the rare-event recipe constants):

`bf61c4760877b838d57c4349cc0ea2a9b9250385587914ceb6a30acc732745a6`

Reproduce with `node scripts/lib/mlbSpecFingerprint.js`. `scripts/test-mlb-beta-v1.js` and `scripts/test-mlb-integrity.js` pin it, so any change to a spec value fails the tests until a **new model version and a new hash** are recorded.

## Historical dataset (pseudo-line validation)

Real statsapi game logs (460 players), seasons **2022–2026**, **52,386 targets** (42,469 batter, 9,917 pitcher; doubleheader-date targets skipped), every target scored strictly as-of through the cleaned production-shaped card path with S2 market-typical pseudo-lines (the modal provider half-point line per stat: hits .5, TB 1.5, HR/2B/3B/SB .5, batter K .5, H+R+RBI 1.5, fantasy 5.5, K 3.5, ER 2.5, hits allowed 4.5, outs 15.5, pitcher fantasy 24.5). **863,358 scored sides** (non-rare 523,670; rare-event 339,688); 340,006 records withheld (28.3%: runs / RBIs / singles / batter walks at .5 `NOT_YET_MODELED` 339,688; INSUFFICIENT_DATA 318). Offline candidate evaluation was verified exactly against the real engine under sandbox transforms (0 mismatches in probability, grade, Prime and wild-gap flag).

## Approved pseudo-line results — final composition (identity + Cap C + R1 + P2 + F0)

**Non-rare grades (523,670 sides):**

| Grade | Hit | N | Coverage | Stated P |
|---|---|---|---|---|
| A | **60.0%** | 105,666 | 20.2% | 60% |
| B | **59.4%** | 40,097 | 7.7% | 57% |
| C | **55.8%** | 123,723 | 23.6% | 55% |
| D | **41.5%** | 254,184 | 48.5% | 42% |

Lift over each stat×direction base rate: A +5.2, B +4.5, C +2.1, D −3.9 pt. Batter A 59.5 / B 59.2 / C 55.4 / D 42.1; pitcher A 65.2 / B 59.6 / C 57.4 / D 38.9. By season (A / B / C / D): 2022 59.4 / 59.5 / 56.1 / 41.7 · 2023 59.3 / 59.3 / 55.8 / 41.9 · 2024 60.0 / 58.5 / 55.0 / 42.1 · 2025 60.4 / 59.7 / 56.2 / 41.0 · 2026 61.0 / 60.2 / 55.9 / 40.9. Over A 57.3 / B 55.2 / C 53.0 / D 35.8; Under A 70.5 / B 63.4 / C 60.0 / D 44.4. Non-rare probability (identity): Brier 0.23648, ECE 1.67 pt.

**Prime (rule unchanged; rare four excluded by policy):** **N 148,122, coverage 28.3%, hit 58.6%, stated 58.1%** (gap +0.5, lift +5.0 pt); batter 58.0% vs 57.7%; pitcher 62.3% vs 60.4%; Over 55.5% vs 56.9%; Under 67.7% vs 61.7%; season gaps +0.1 / +0.2 / +0.3 / +0.8 / +1.0.

**Rare-event probability under R1 (Over rows, actual − stated):** **HR −0.71 pt, 2B −0.17 pt, 3B −1.84 pt, SB −1.16 pt** (before R1: −3.29 / −2.58 / −3.25 / −3.64). Pooled Brier 0.07416 vs 0.07501 (paired bootstrap by target −8.5e-4, 95% CI [−9.2e-4, −7.8e-4]); 2026 holdout 0.06884 vs 0.06991. The residual 3B / SB gap is the frozen .03 raw floor / .97 ceiling and was not changed. **Rare events receive no letter grade and no Prime.**

## Decisions recorded

- **R1** won the predeclared rule among R0 (full blend), R1 (bypass), R2 (recipe + EB only), R3 (recipe + last-10 only). R2 was the close runner-up (Brier 3.3e-5 better, AUC 0.722 vs 0.715) but failed the calibration screen (HR 1.23 pt, SB 1.25 pt > 1.0). **R1 gives up some rare-event ranking information** (pooled AUC 0.715 vs 0.720). Disclosed amendment: the calibration screen was applied to the unclamped probability, decided after viewing R0/R1 and before any R2/R3 result.
- **P2** was chosen over P0 (normal grade + Prime), P1 (capped C, no Prime) and P3 (letter only where prior-season lift was significant). Rare Unders graded A at exactly the stat's base rate (graded-set lift +0.00 [±0.2–0.3]; miss-rate ratio 1.000). P3 passed a literal pooled significance test (+0.32 pt) but its miss-rate ratio was 0.967 (bar 0.80) and the lift was sign-unstable (−0.57 / −0.04 / +0.63 / +0.98), so it communicates the base rate, not discrimination.
- **Ranking edge exists but is not graded:** a ranking edge is demonstrated for HR (Over and Under) and SB (Over and Under) in the top quintile by model probability (e.g. HR Under 92.5% vs 88.8% base, SB Under 97.8% vs 94.1%) and **not** for doubles or triples. A letter cannot express it (the grade is built from edge ÷ line, which saturates at a 0.5 line). A rank-tier display would be a new candidate and a new version.
- **Confluence F0 retained:** it adds no demonstrable information beyond probability and edge (pooled held-out Brier change +9e-7, CI [−1.8e-5, +1.8e-5]; material only for `pitching_outs`), but removing it from the grade (F1) was worse on the predeclared rule.
- **Calibration identity** (a pooled monotone or logistic curve was not adopted, see above).
- **Disclosed amendment:** the Over-side materiality bar for the rare ranking-edge test was mirrored (≥ 20% relative hit-rate gain) after seeing results.

## predictiveSpreadSD caveat

`predictiveSpreadSD` is a **conservative scale / floor, NOT a validated MLB per-player standard deviation.** It equals the engine's 1.0 floor on 99.6–100% of HR / 2B / 3B / SB sides (so Cap C never fires on the rare four), on 45.7% of Hits and 57.9% of Batter-K sides, and is only weakly related to realized absolute error within a stat (Spearman 0.01–0.17; negative for pitcher outs, −0.18); it is wider than the realized RMSE for most stats (SD/RMSE about 1.1–1.6 for the non-rare stats, 2.5–8.3 for the rare four). Its constants were **not** re-optimized. Cap C divides by `max(line, predictiveSpreadSD)` only to avoid capping low-line stats on a relative rule that has no scale.

## Known limitations (Phase 4; documented, not repaired)

- **Three family inversions remain, driven by Cap C itself at the S2 pseudo-lines:** `hitting_volume` B<C (−3.5 pt), `batter_discipline` B<C (−5.3), `pitching_strikeout` B<C (−12.4). C contains the sides the wild-gap cap demoted from A/B (hit 67.9% / 72.8% / 83.1%, lift +9.8 / +13.5 / +11.6), and they out-hit B. They persist when confluence is made context-only. `hitter_combo` A<B (53.2 vs 56.8) is a direction-mix artifact (A is 81% Over, B 42% Over; within each direction A > B, and A lift +8.0 > B +5.6).
- **Non-rare direction bias is stat-specific, not a universal Over bias** (and no Over penalty was added): Over is over-stated on `hitsRunsRbis` (−7.0 pt) and `fantasy` (−8.5), driven by the normal-CDF distribution shape; `totalBases` (−5.1) by the generic pull toward 50% at a 33%-Over line; `earnedRuns` (−2.6) by shape; Over is under-stated on `hitsAllowed` (+4.9, projection under-bias +0.28) and `pitcherFantasy` (+2.9).
- **Pitcher-strikeout Over under-confidence (+9.8 pt at the 3.5 pseudo-line) is a line-construction artifact:** at as-of book-like lines (nearest half-point to the 20-game mean) it is −1.0 pt. It is stable across seasons and pitcher history sizes at S2; no probability increase was made. The book-like lines are a diagnostic construction, not market data.
- Rare-event residual gap from the frozen floor / ceiling (3B −1.84, SB −1.16); R1 loses some rare ranking information.
- Pooled non-rare probabilities are under-confident (slope ≈ 1.22); the conservative direction, documented, not corrected.
- Prime is weak in `pitching_strikeout` (lift −1.2), `hitting_volume` (+1.9) and `batter_discipline` (+2.2).
- Lines below 1 without a recipe are not modeled (28.3% of pseudo-line records).
- A rendered UI card for an ungraded rare-event market was **not** exercised with live provider data in a browser; the page compiles and renders without console errors, and the behavior is pinned at the engine / gate level.

## Real-line validation

**REAL_LINE_VALIDATION = PENDING / DATA GAP.** No genuine historical MLB lines or settlements exist (`mlb` provider-line archive 0 rows; `prop_snapshots` thin, Over-only, board-path). Once genuine MLB lines and settled outcomes accumulate this entire specification — Cap C, the grade rules, the Prime rule, identity calibration, R1, P2, the low-line policy and the Over/Under skew — **must be revalidated against those real lines**, kept strictly separate from the pseudo-line results above. Until then the model stays BETA and **no profitability, ROI or edge-versus-market claim may be made.**

## Scope boundaries

NBA (`nba-edge-2026.10-nodef-v1`), WNBA (`wnba-edge-2026.10-nodef-v1`) and NFL (`nfl-edge-2026.10-nodef-v1`) are frozen separately and unchanged; NCAAF (including its 4-factor A rule) and NHL are unchanged; the WNBA period-model work is separate and not part of this freeze. The MLB parser, builders and gates introduced in Phase 2 are part of this version.

## Tests and evidence

- `scripts/test-mlb-beta-v1.js` — model version/state/metadata, identity calibration, Cap C formula (+ fail-closed), rare priors, rare Poisson recipe, R1 bypass, rare probability available, rare grade absent, rare Prime false, rare excluded from Best Plays / Prime / +EV / Smart Parlay / headline grade / ordering, low-line fail-closed, Hits 0.5 and Batter K 0.5 still modeled, parser and combo semantics, board / card / historical parity, strict temporal history, localStorage isolation, context-only matchup/splits, fingerprint reproducibility; each behavior test has a non-vacuous control (a loader transform that undoes the feature must fail it).
- `scripts/test-mlb-integrity.js` — the Phase-2 integrity suite (updated for BETA v1), including NBA / WNBA / NFL / NCAAF / NHL scoring and pick finders identical to the pre-cleanup page.
- Regression: `test-nba-defense-removed-and-parity`, `test-nba-grade-pipeline-parity`, `test-wnba-integrity`, `test-wnba-leakage`, `test-nfl-integrity`, `test-nfl-leakage`, `test-model-integrity-containment`, `test-nhl-main-line-integrity`, `test-nhl-model-parity`, `test-e2e-model-parity-nba`.
- Decision studies (not committed; regenerate with the scripts): `scripts/model-integrity/mlb-phase3-*.js`, `mlb-phase4-*.js`, evidence `tmp/model-integrity/mlb-phase3/`, `tmp/model-integrity/mlb-phase4/`. They describe the **pre-v1** page (several hook anchors, e.g. the Phase-3 `--cap` switch and the blend `priors` expression, no longer exist unmodified) and are not expected to run unmodified against this one; the implementation patch is `tmp/model-integrity/mlb-v1/patch-page.js`.
