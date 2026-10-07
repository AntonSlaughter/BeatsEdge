# NCAAF model — FROZEN BETA specification: `ncaaf-edge-2026.10-nodef-v1`

Frozen 2026-10-07. **State: BETA.** **REAL-LINE VALIDATION: DATA GAP (`realLineValidation = PENDING`).**
**Every performance number below is `PSEUDO-LINE VALIDATION — NOT REAL MARKET PERFORMANCE`.** There are no ROI, profit or "beats the market" claims anywhere in this document.
**Future NCAAF model changes require a new model version** (and start again at BETA): any change to a formula, feature, threshold, calibration value, the Prime rule, the wild-gap rule, the A-grade rules, the defense treatment, the low-line policy, the history semantics, the thin-history prior, or any market's state below. This specification must never be altered silently.

## Frozen specification

| Item | Frozen value |
|---|---|
| Model version | `ncaaf-edge-2026.10-nodef-v1` |
| State | `BETA` (UI gating by state is not implemented; graded markets show their grades) |
| Feature set | `ncaaf-window-blend-v1` — the live window builders shared with NFL (`nflComputeWindows`; L5 / L10 / season / vs-opponent windows over the target season and the two before, empirical-Bayes shrinkage blend). Projection and weights are **unchanged**. |
| Calibration | **IDENTITY** — `probCalib: null`, id `ncaaf-defaults-2026-10-07`. Grade thresholds unchanged (A ≥ 0.86 & confidence ≥ 80, B ≥ 0.68 & confidence ≥ 50, C ≥ 0.46, else D). |
| Authority | NCAAF probability and grade read only `NCAAF_GRADE_CONFIG`; browser `localStorage` (`GRADE_CUTOFFS` / `PROB_CALIB`) cannot alter NCAAF output; the NCAAF in-app backtest is diagnostic-only and persists nothing. |
| Wild-gap | **`wildGapRule: 'none'`** — no wild-gap grade cap at all, and the **small-sample wild-gap clause is removed**. The separate `thinData` cap (< 4 season games → A/B become C) and the separate **"A needs ≥ 6 season games" guard are unchanged**. (The NFL clause is untouched.) |
| Defense | **`defenseFeature: 'context-only'`** — can never alter projection, probability, confluence, grade or Prime; shown as labeled context only when information exists. |
| Four-factor A rule | **Removed** (an A needs no minimum number of supporting factors). |
| Low lines | **Every NCAAF line < 1 is `NOT_YET_MODELED`** (fail closed): no probability, projection, edge, grade, Prime, Best Plays, +EV or Smart Parlay; the provider line stays visible. |
| Zero / missing | A numeric `0` is valid. `"--"`, blank, `null`, `undefined`, `NaN`, `Infinity` and absent fields are **missing** (the game is excluded, never counted as 0). A legitimate all-zero recorded history is valid history. A stat that was never recorded has no window → `INSUFFICIENT_DATA`. |
| Combos | `passRushYds` and `rushRecYds` **require every component**; a game missing a component is excluded; zero is never substituted. |
| Thin-history prior | **`none`** — the synthetic `estHitRate` prior (weight 0.20, fewer than 5 logged games) is **removed for NCAAF and not replaced**. (The placeholder `prop.hitRate` field is no longer read by the NCAAF engine.) |
| Count events | `rushTds`, `recTds`, `interceptions` → **`NOT_YET_MODELED`** at every line (provider line kept). `passTds` → **`PROBABILITY_ONLY`** (line ≥ 1). |
| Longest play | `longRec` → **fully graded BETA**. `longRush` → **`PROBABILITY_ONLY`**. |
| Unsupported / provider-only | `targets`, `kickingPts`, `fgMade` → `NOT_YET_MODELED` (no historical outcome field). |
| `PROBABILITY_ONLY` state | A genuine engine state (`MODEL_STATE_PROBABILITY_ONLY`), not a label. The engine edge **and** the prop carry `modelState: 'PROBABILITY_ONLY'`; projection, model probability and edge exist; `grade`, `rawGrade`, `finalGrade`, `gradeScore`, `gradeAdjustmentReason` are `null`; `prime` is `false`; `rankingEligible: false`; `gradePolicy: 'NCAAF_PROBABILITY_ONLY'`. `isModelEligibleProp`, `isModelEligibleEdge`, `isRankingEligibleEdge`, `findTopPicks`, `findPrimePicks`, `findResearchPicks`, `findPlusEVPicks`, the +EV attach step, `smartParlayHitRate` / `smartParlayEligibility` and the generic backtest tally all reject it, on the prop flag **and independently on the edge** (defense in depth). |
| Prime | Only graded NCAAF markets (passing, rushing, receiving, `flex_combo`, `qb_combo`, `longRec`) can be Prime. Withheld and probability-only markets cannot. Prime rule itself is unchanged. |
| One scorer | `cfbParseGamelog → cfbWindowsFor → cfbBuildProps → cfbRefreshProps → calculateEdgeScore`, shared by the live board, the expanded card and `ncaafBacktestInputs` / `ncaafBacktestSeries`. History for a target is strictly `date < target date`. |

**Canonical configuration fingerprint** (sha256 of the key-sorted JSON of version + feature set + `NCAAF_GRADE_CONFIG` + `ncaafModelMeta()` + the unsupported-stat table + the source-pinned grade thresholds, A ≥ 6-game guard, gap-rule line, NFL-only clause and prior guard):

`d9cef0988881861311422a201faf64269a58ea194c175c7cc35a89bc9d5b3118`

Reproduce with `node scripts/lib/ncaafSpecFingerprint.js`. `scripts/test-ncaaf-beta-v1.js` pins it and mutates 20 material spec values (each must yield a distinct hash), so any change fails the test until a **new model version and a new hash** are recorded.

## Approved Phase-3 evidence — PSEUDO-LINE VALIDATION — NOT REAL MARKET PERFORMANCE

Data: 4,424 athletes, ESPN college-football game logs (2022–2026), 347,108 scored sides (2024–2026 targets, line ≥ 1), 135,722 sides withheld as line < 1. Pseudo-line = the in-app scale-aware rule (the value closest to a 48% as-of Over rate), built from strictly earlier games. Standard errors are clustered by athlete. "Lift" = hit rate minus the same stat / direction / season's own base rate.

**No wild-gap cap, no clause — pooled ladder (all graded and withheld-at-≥1 markets, 347,108 sides):**

| Grade | Hit | N | Coverage | Stated P | Gap | Lift |
|---|---|---|---|---|---|---|
| A | **64.5%** | **10,873** | 3.1% | 61% | +3.9 | +11.1 |
| B | **61.9%** | **77,266** | 22.3% | 56% | +5.9 | +8.8 |
| C | **55.4%** | **88,157** | 25.4% | 55% | +0.7 | +4.5 |
| D | **40.9%** | **170,812** | 49.2% | 43% | −2.2 | −7.0 |

Prime (all markets, no cap): 62.3% (n = 23,377, 6.7%). Strictly monotone A > B > C > D, with no significant inversion.

**Final eligible Prime (failed markets excluded, graded markets only):** **N = 20,221, coverage 6.57%, hit 62.6%, stated 59.5%** (gap +3.1, lift +11.5 over each side's own base rate). Seasons 62.7 / 62.9 / 62.0%. By family: passing 65.0, rushing 65.1, receiving 61.6, flex_combo 62.8, qb_combo 67.3 (n = 321), `longRec` 60.0. Over 63.5% (n = 12,705), Under 61.1% (n = 7,516).
Final graded set ladder (excluding `rushTds`, `recTds`, `interceptions`, `passTds`, `longRush`; 307,866 sides): A 65.7% (9,054) · B 62.3% (68,414) · C 55.1% (78,956) · D 40.9% (151,442) — monotone in every season, on Over and Under, and in every non-rare family.

**Season ladder (no cap, A / B / C / D, all markets):**

| Season | A | B | C | D | Prime |
|---|---|---|---|---|---|
| 2024 | 63.5 | 61.3 | 56.0 | 41.0 | 62.4 |
| 2025 | 65.3 | 62.3 | 54.8 | 40.8 | 62.7 |
| 2026 (partial) | 64.1 | 61.8 | 55.6 | 40.9 | 61.7 |

### Why each decision was taken

- **Wild-gap removed.** The three predeclared candidates were compared on the same sides: the current relative rule fires on 27.5% of sides and gives A 61.3 / B 58.5 / C 58.8 / D 40.9 (a B<C inversion; flex_combo, longest-play and passing_td inversions are significant); floored Cap C (`abs(edge) / max(line, SD) > 0.50`) fires on 17.6% and is monotone but weaker (62.7 / 59.7 / 58.0 / 40.9); no cap is monotone and strongest. The cap's demotions removed the best sides (sides demoted out of A/B hit 68.7%). The no-cap ladder survives in every season and in every season × major non-rare family cell (two non-significant exceptions at tiny n: flex_combo 2024 A<B by 0.7 pt, n = 358; qb_combo 2026, n = 31).
- **Small-sample clause removed.** Under no cap the clause demotes 8,229 sides out of A/B that hit **65.2%** (lift +10.4) versus 62.0% for the A/B sides it keeps — it removes above-average sides. Under the floored rule the demoted sides hit 59.5% vs 60.1% kept (no value). The `thinData` cap (< 4 games) and the ≥ 6-game A guard still protect genuinely thin players.
- **Thin-history synthetic prior removed.** On the 89,792 sides where it was used (25.9%): Brier 0.2360 with the prior vs 0.2371 without (−0.0011, z −3.7; −0.0026 at 1–2 games; **+0.0006 at 3–4 games**, not significant), AUC 0.635 vs 0.633, and the **grade changed on 2 of 89,792 sides**. It does not clearly improve out-of-sample behavior and is an unvalidated synthetic input, so it is removed (cost ≈ 0.001 Brier on thin sides) and not replaced or retuned.
- **`rushTds`, `recTds`, `interceptions` withheld (`NOT_YET_MODELED`).** At lines ≥ 1 the generic Normal model puts ≈ 41% on the Over against Over base rates of 4–15%; AUC 0.30–0.59 (mostly < 0.55); Brier skill vs the prior-season base −41% to −367%; grade lift negative or inverted; calibration slopes 4–9. The apparent grade "hit rates" are the stat's Under base rate (≈ 85–98%), not discrimination.
- **`passTds` probability-only.** AUC 0.575–0.603 in every season × direction and weak positive skill (+1.4 to +2.3%), so the probability carries some signal; but calibration bias is large (Over gap −11 / −6 / −3 pts, Under +12 / +6 / +4) and the grade ladder inverts significantly on Unders (B<C), vanishing only at ≥ 6 games of history. Letter grade and Prime would mislead; the probability is shown labeled BETA.
- **`longRush` probability-only.** Probability is well calibrated (gaps ≤ 2 pts, slopes 0.82–1.09, AUC 0.58–0.60 in all 6 season × direction cells), but the top grade does not discriminate: A < B in all three seasons (A 54–58%, B 57–60%) under every cap setting and every history length.
- **`longRec` remains graded.** Probability calibration stable (slopes 0.99–1.06, gaps ≤ 2 pts, AUC 0.59 in all cells) and grades monotone under no cap in all 9 season × direction cells (A 61–93%, B 56–64%, C 50–58%).
- **Identity calibration kept.** A systematic, stable under-confidence exists (pooled slope 1.28; 1.20 / 1.31 / 1.30 by season; the 55–60 stated bucket hits ≈ 62–65%). A pooled temporal logit (slope + intercept) trained on prior seasons improved the next season's Brier by only 0.0005 / 0.0006 with no change in the worst family gap, and per-family slopes range 1.01–1.74 (4–9 for the rare-event stats), so family calibration is unstable. The under-confidence is the conservative direction, documented and not corrected (the same accepted exception as NFL / WNBA).

## Remaining limitations (Phase 3)

- Everything is on the **pseudo-line**, which fixes the as-of Over rate near 48%; real books price differently, so ladders, calibration and the Over/Under mix may shift. **No real-line validation exists** (the snapshot table holds only 455 PrizePicks Over-only rows from 2 dates).
- Part of the A/B/C vs D gap is **side selection** (D is largely the opposite side of the pairs A/B/C picked); the within-A/B/C ordering is the stronger evidence. Over-side grade C sits at its own base rate (lift −0.6): a mid-grade Over is not an edge.
- Probabilities are **under-confident** (grade B's stated 56% vs 61.9% hit).
- Clustering is by athlete only (no date / game clustering); the 2026 season is partial; the A grade is very thin in some cells (e.g. qb_combo 2026, n = 31); the withheld count-event verdicts rest on ≤ ~1,800 sides per stat.
- `flex_combo` 2024 and `recYds` / `longRush` show non-significant top-grade (A ≈ B) flattening.
- `PROBABILITY_ONLY` is new in the NCAAF engine; its UI is limited to the existing "Probability only" badge and detail text.

## Verification

- `scripts/test-ncaaf-beta-v1.js` (52 checks): the 26 required proofs — board / card / historical parity, strict as-of leakage, zero / missing, combo completeness, line < 1 fail-closed, `rushTds` / `recTds` / `interceptions` NOT_YET_MODELED, `passTds` / `longRush` PROBABILITY_ONLY, `longRec` graded, `targets` / `kickingPts` / `fgMade` NOT_YET_MODELED, probability-only blocked from letter / Prime / Best Plays / +EV / Smart Parlay, no wild-gap cap, no clause, ≥ 6-game A guard, no 4-factor rule, no thin prior, context-only defense, localStorage isolation, fingerprint reproducibility and mutation — each "absent" claim with a non-vacuous control that re-introduces the old behavior via a loader-only transform.
- `scripts/test-ncaaf-integrity.js` (50 checks, the Phase-2 cleanup suite, updated for the BETA).
- Frozen-sport regression: NFL, NBA (parity, defense), WNBA, MLB (integrity, beta v1), NHL (main-line integrity, model parity) and the containment suite all pass unchanged in behavior; their tests were edited only where NCAAF served as the "unchanged / still reads localStorage" control (now an unlisted sport).
- Evidence scripts (not committed output; they describe the pre-implementation page and are not expected to run unmodified against this one): `scripts/model-integrity/ncaaf-phase1-*.js`, `ncaaf-phase2-measure.js` / `-report.js`, `ncaaf-phase3-collect.js` / `-analyze.js`, outputs under `tmp/model-integrity/ncaaf-p2/` and `ncaaf-p3/`.
