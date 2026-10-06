# NHL Model Candidates — FROZEN before the 2026 holdout (Phase 3A)

**Date:** 2026-10-05 · **Production reference:** `b67957a` (no production code changed) · **Split:** TRAIN = 2024, VALIDATION = 2025, **HOLDOUT = 2026 (not accessed)**

> **Frozen-config SHA-256:** `0527985d73ff2b49798be29838b4eeaf29585d1c4f14e3e22f7abad9461b42f5`  
> **Manifest SHA-256 (code + evidence):** `893d717a22688e9f83c0e7009318c65f0b404423d873eb761aa2a44a2118c678`  
> Re-check with `node scripts/research/nhl-phase3a/verify-frozen.js` before any holdout run; it fails if anything changed.

## 1. Result in one table

| Family | Frozen candidate | Validation loss (prod → cand) | Δ | 95% CI | z | Class |
|---|---|---|---|---|---|---|
| Shots on Goal | **S1** — opponent shots-allowed environment | MAE 1.0467 → 1.0374 | -0.89% | [-1.07%, -0.70%] | 9.2 | HOLDOUT CANDIDATE |
| Goalie Saves | **V5** — EB shrinkage toward the league goalie prior (K=40) + opponent shots-for factor (g=0.5); TRAIN chose the V3 structure inside V5 | MAE 5.9769 → 5.8129 | -2.74% | [-3.58%, -1.91%] | 6.5 | HOLDOUT CANDIDATE |
| Goal ≥1 | **B2** — sample-size-aware shrinkage toward as-of position prior | Brier 0.12307 → 0.12195 | -0.91% | [-1.05%, -0.78%] | 13.2 | HOLDOUT CANDIDATE |
| Assist ≥1 | **B2** — sample-size-aware shrinkage toward as-of position prior | Brier 0.17413 → 0.17307 | -0.61% | [-0.70%, -0.51%] | 12.8 | HOLDOUT CANDIDATE |
| Point ≥1 | **B3** — EB shrinkage + opponent environment | Brier 0.20753 → 0.20642 | -0.53% | [-0.73%, -0.34%] | 5.5 | HOLDOUT CANDIDATE |

All five frozen candidates clear the pre-declared promotion standard (§5). Effect sizes are **small (0.5%–2.7%)** — NHL props are noise-dominated and none of this is evidence of profit against a market line (real-line validation remains a DATA GAP). **Point ≥1 is marginal** (passes the 0.5% bar by 0.034 pt; its simpler EB-only variant did not pass).

## 2. Holdout integrity — read this

- Every query in this phase went through `guard.js`, which refuses any SQL lacking `season IN (2024,2025)`, any year literal outside 2024–2025, and aborts if a returned row has season ∉ {2024, 2025} or a date after 2025-07-31. Guard totals for the validation run: {"queries":6,"rowsSeen":414364,"allowedSeasons":[2024,2025],"maxDate":"2025-07-31"}. The production-equivalence check built a temp DB from `season IN (2024,2025) AND game_date <= 2025-02-28` only and asserted `max(season) <= 2025`. **2026 holdout accessed in Phase 3A: NO.**
- **Disclosures (not hidden):** (a) the Oct 1 audit document I was told to read already contains 2026 *baseline* numbers from the earlier audit — I did not derive, query or use any 2026 outcome in this phase; (b) the *ideas* (opponent shot environment, team-saves pooling, EB shrinkage) originate from earlier work — and the older `research-nhl-features.js` evaluated 2025 and 2026 together. So the 2026 holdout is **pristine for this phase's parameters and selection, but not pristine as a source of candidate ideas.** Treat a holdout pass as strong-but-not-perfect evidence.

## 3. Production baseline reproduced (item 1)

**Exact path equivalence.** The real production compute path (`lib/nhlProjectionEngine.computeAllProjections`, its SQL included) was run against a temp DB containing only 2024–2025 rows ≤ 2025-02-28 and compared player-by-player with this harness's as-of replay:

| Family | players (replay / production) | max abs diff | players with any diff | gamesSampled mismatches | exact |
|---|---|---|---|---|---|
| shots_on_goal | 871 / 871 | 0 | 0 | 0 | true |
| goalie_saves | 85 / 85 | 0 | 0 | 0 | true |
| goals_at_least_1 | 833 / 833 | 0 | 0 | 0 | true |
| assists_at_least_1 | 833 / 833 | 0 | 0 | 0 | true |
| points_at_least_1 | 833 / 833 | 0 | 0 | 0 | true |

The replay also reproduces the Oct 1 audit's validation figures (SOG n=49,008 MAE 1.0467; Saves n=2,839 MAE 5.977; Goal/Assist/Point Brier .1231/.1741/.2075; ECE .0241/.0311/.0247).

### 3.1 Continuous families (production formula, as-of)

| | split | n | MAE | RMSE | bias (actual−pred) | % over-projected | ±1 | ±2 | mean pred | mean actual |
|---|---|---|---|---|---|---|---|---|---|---|
| Shots on Goal | TRAIN(2024) | 42087 | 1.0783 | 1.3896 | -0.0308 | 55.9% | 55.2% | 87.2% | 1.729 | 1.698 |
| Shots on Goal | VALIDATION(2025) | 49008 | 1.0467 | 1.3469 | -0.0527 | 57.4% | 56.0% | 88.4% | 1.636 | 1.583 |
| Goalie Saves | TRAIN(2024) | 2295 | 6.3106 | 8.1963 | -0.3161 | 49.0% | 11.6% | 21.3% | 25.766 | 25.45 |
| Goalie Saves | VALIDATION(2025) | 2839 | 5.9769 | 7.7179 | -0.8182 | 53.8% | 11.2% | 22.0% | 24.812 | 23.994 |

Calibration by projection quintile (VALIDATION, production):

**Shots on Goal** — Q1: pred 0.764 / actual 0.864 (n=9801, MAE 0.765) · Q2: pred 1.139 / actual 1.123 (n=9802, MAE 0.868) · Q3: pred 1.491 / actual 1.429 (n=9801, MAE 1.041) · Q4: pred 1.954 / actual 1.888 (n=9802, MAE 1.158) · Q5: pred 2.83 / actual 2.611 (n=9802, MAE 1.4)

**Goalie Saves** — Q1: pred 21.725 / actual 22.402 (n=567, MAE 5.907) · Q2: pred 23.735 / actual 23.743 (n=568, MAE 6.002) · Q3: pred 24.891 / actual 23.905 (n=568, MAE 5.795) · Q4: pred 25.972 / actual 24.826 (n=568, MAE 5.737) · Q5: pred 27.73 / actual 25.09 (n=568, MAE 6.443)

SOG by position (VALIDATION): F: n=32470 MAE 1.0971 bias -0.0709 · D: n=16538 MAE 0.9477 bias -0.0171

### 3.2 Binary families (production Poisson, as-of)

| | split | n | base rate | mean pred | Brier | skill vs const | LogLoss | ECE | P≥.40 pred→act | P<.10 pred→act |
|---|---|---|---|---|---|---|---|---|---|---|
| Goal ≥1 | TRAIN(2024) | 38306 | 0.1548 | 0.1551 | 0.12575 | 3.9% | 0.4699 | 0.0324 | 0.462→0.343 (n=1757) | 0.043→0.082 (n=15342) |
| Goal ≥1 | VALIDATION(2025) | 48422 | 0.1522 | 0.1501 | 0.12307 | 4.6% | 0.4187 | 0.0241 | 0.452→0.361 (n=1492) | 0.047→0.077 (n=19729) |
| Assist ≥1 | TRAIN(2024) | 38306 | 0.2438 | 0.2446 | 0.17671 | 4.2% | 0.5587 | 0.0404 | 0.497→0.418 (n=5906) | 0.057→0.129 (n=6210) |
| Assist ≥1 | VALIDATION(2025) | 48422 | 0.2401 | 0.2381 | 0.17413 | 4.6% | 0.5362 | 0.0311 | 0.488→0.43 (n=6358) | 0.065→0.127 (n=7397) |
| Point ≥1 | TRAIN(2024) | 38306 | 0.3523 | 0.3536 | 0.21051 | 7.7% | 0.6196 | 0.0341 | 0.546→0.508 (n=14388) | 0.064→0.155 (n=2199) |
| Point ≥1 | VALIDATION(2025) | 48422 | 0.3476 | 0.3446 | 0.20753 | 8.5% | 0.6069 | 0.0247 | 0.535→0.509 (n=17153) | 0.07→0.135 (n=2420) |

Probability-bucket calibration (VALIDATION, production):

**Goal ≥1** — 0.0-0.1: 0.0466→0.077 (n=19729) · 0.1-0.2: 0.1461→0.1485 (n=14308) · 0.2-0.3: 0.2458→0.2277 (n=8617) · 0.3-0.4: 0.3423→0.2862 (n=4276) · 0.4-0.5: 0.4399→0.365 (n=1296) · 0.5-0.6: 0.5282→0.3368 (n=193) · 0.6-0.7: 0.6068→0 (n=3)

**Assist ≥1** — 0.0-0.1: 0.0651→0.1267 (n=7397) · 0.1-0.2: 0.1508→0.1751 (n=14304) · 0.2-0.3: 0.2476→0.239 (n=12784) · 0.3-0.4: 0.3456→0.3159 (n=7579) · 0.4-0.5: 0.4443→0.3976 (n=4122) · 0.5-0.6: 0.5398→0.4601 (n=1680) · 0.6-0.7: 0.6393→0.5702 (n=456) · 0.7-0.8: 0.7307→0.6526 (n=95) · 0.8-0.9: 0.8095→0.4 (n=5)

**Point ≥1** — 0.0-0.1: 0.0696→0.1347 (n=2420) · 0.1-0.2: 0.155→0.2006 (n=8639) · 0.2-0.3: 0.25→0.2613 (n=10419) · 0.3-0.4: 0.3478→0.3393 (n=9791) · 0.4-0.5: 0.4475→0.4252 (n=7486) · 0.5-0.6: 0.5468→0.5303 (n=5367) · 0.6-0.7: 0.6429→0.5982 (n=3178) · 0.7-0.8: 0.7373→0.6972 (n=961) · 0.8-0.9: 0.827→0.795 (n=161)

## 4. Candidate variants actually tested

**22 variants on VALIDATION (5 are the production baselines → 17 candidates):** SOG 4 (S0–S3), Saves 6 (V0–V5), Goal/Assist/Point 4 each (B0–B3). Two collapse by construction: SOG-S2 (TRAIN chose K=0, i.e. no shrinkage helps → identical to production) and SOG-S3 (= S1). **TRAIN-only tuning evaluations: 63** grid points (never evaluated on 2025). VALIDATION was evaluated twice with identical numbers: the second run only added a tie-break comparison (V5 vs its V3 component) that the first run's code omitted. Nothing was tuned on VALIDATION; no window or weight was searched beyond the grids below.

| Tunable | Grid | Selected on TRAIN |
|---|---|---|
| EB strength K (SOG / Goal / Assist / Point / Saves) | 0,10,20,40,80,160,320 | 0 / 40 / 20 / 10 / 40 |
| Opponent-env strength g (SOG / Goal / Assist / Point) | 0.5, 1.0 (0 = off) | 1 / 1 / 1 / 1 |
| Saves: pool weight w2 / opp-offence g3 / joint (w4,g4) / V5 structure | 0.25,0.5,0.75 / 0.5,1.0 / 6 combos / V2,V3,V4 | 0.25 / 0.5 / (0.5, 1) / V3 |

Fixed a priori (not tuned): player L5 + k=8 inside `shrinkageFive` (production); team windows L15 (shots) / L10 (saves); minimum opponent history 10 team-games; league average needs ≥200 team-games; prior pools need ≥2000 (skater) / ≥200 (goalie) rows.

TRAIN grids (loss on 2024; lower is better):

- **Shots on Goal** (TRAIN n=42087, production loss 1.07834): opp_env_strength_g: 0→1.07834, 0.5→1.07448, 1→1.07422 | EB_K: 0→1.07834, 10→1.07846, 20→1.08912, 40→1.10797, 80→1.13147, 160→1.15374, 320→1.17089
- **Goalie Saves** (TRAIN n=2295, production loss 6.3106): EB_K_league_goalie: 0→6.3106, 10→6.22233, 20→6.20807, 40→6.20756, 80→6.22178, 160→6.23831, 320→6.25176 | pool_weight_w (V2 alone): 0→6.3106, 0.25→6.27307, 0.5→6.27758, 0.75→6.3246 | opp_offence_strength_g (V3 alone): 0→6.3106, 0.5→6.1835, 1→6.22624 | V4_joint_w_g: 0.25→0.5→6.21841, 0.25→1→6.17935, 0.5→0.5→6.18334, 0.5→1→6.14195, 0.75→0.5→6.20208, 0.75→1→6.18546 | V5_structure_choice: V2→6.19373, V3→6.05848, V4→6.06468
- **Goal ≥1** (TRAIN n=38306, production loss 0.12575): opp_env_strength_g: 0→0.12575, 0.5→0.12555, 1→0.12544 | EB_K: 0→0.12575, 10→0.12417, 20→0.12371, 40→0.12365, 80→0.12413, 160→0.12497, 320→0.12583
- **Assist ≥1** (TRAIN n=38306, production loss 0.17671): opp_env_strength_g: 0→0.17671, 0.5→0.17637, 1→0.1762 | EB_K: 0→0.17671, 10→0.17476, 20→0.17451, 40→0.17508, 80→0.17664, 160→0.17878, 320→0.1808
- **Point ≥1** (TRAIN n=38306, production loss 0.21051): opp_env_strength_g: 0→0.21051, 0.5→0.20996, 1→0.20969 | EB_K: 0→0.21051, 10→0.20882, 20→0.20918, 40→0.21083, 80→0.21382, 160→0.21741, 320→0.22064

## 5. Promotion standard (pre-declared in code) and VALIDATION results

A candidate is a **HOLDOUT CANDIDATE** only if ALL hold: relative loss improvement ≤ −0.5%; 95% date-clustered CI excludes 0; improves in all three VALIDATION time blocks; improves for both forwards and defencemen (skaters); no history-size stratum worse by more than +0.25%; ≥90% feature coverage; n ≥ 2000. **Tie-break:** a combined variant must beat each passing simpler constituent by ≥0.25% with CI excluding 0, otherwise the simpler one wins. CONTEXT ONLY = CI excludes 0 but fails a bar above; DROP = no reliable improvement; DATA GAP = not testable from stored data.

### Shots on Goal (n=49008)

| id | description | loss | Δ vs production | 95% CI | blocks (Oct–Dec / Jan–Feb / Mar–Jun) | F / D | history strata | coverage | class |
|---|---|---|---|---|---|---|---|---|---|
| S0 | production baseline: shrinkageFive(all prior) | MAE 1.0467 | — | — | — | — | — | 1 | BASELINE |
| S1 | opponent shots-allowed environment | MAE 1.0374 | -0.89% | [-1.07%, -0.70%] | -0.69 / -0.97 / -1.08 | -0.95 / -0.74 | -1.36 / -0.67 / -0.96 | 0.997 | HOLDOUT CANDIDATE |
| S2 | sample-size-aware shrinkage toward as-of position prior | MAE 1.0467 | 0.00% | [0.00%, 0.00%] | 0 / 0 / 0 | 0 / 0 | 0 / 0 / 0 | 1 | DROP |
| S3 | EB shrinkage + opponent environment | MAE 1.0374 | -0.89% | [-1.07%, -0.70%] | -0.69 / -0.97 / -1.08 | -0.95 / -0.74 | -1.36 / -0.67 / -0.96 | 0.997 | SUPERSEDED BY SIMPLER (S1) |

Tie-break comparisons: S3_vs_S1: 0.00% [0, 0] (not clearly better) · S3_vs_S2: -0.89% [-1.074, -0.697] (clearly better)

### Goalie Saves (n=2839)

| id | description | loss | Δ vs production | 95% CI | blocks (Oct–Dec / Jan–Feb / Mar–Jun) | F / D | history strata | coverage | class |
|---|---|---|---|---|---|---|---|---|---|
| V0 | production baseline | MAE 5.9769 | — | — | — | — | — | 1 | BASELINE |
| V1 | EB shrinkage toward as-of league goalie prior | MAE 5.8975 | -1.33% | [-1.94%, -0.72%] | -1.62 / -1.34 / -0.96 | — | -2.52 / -1.22 / -1.15 | 1 | HOLDOUT CANDIDATE |
| V2 | team-saves pooling: (1-w)*base + w*teamSavesL10 | MAE 5.9546 | -0.37% | [-0.73%, -0.01%] | -0.22 / -0.63 / -0.37 | — | -1.7 / -0.13 / -0.4 | 0.996 | CONTEXT ONLY |
| V3 | opponent offence environment (shots-for L15 / league) | MAE 5.8938 | -1.39% | [-2.04%, -0.74%] | -1.2 / -1.56 / -1.5 | — | -0.83 / -2.03 / -0.39 | 0.996 | HOLDOUT CANDIDATE |
| V4 | pooling x opponent offence: (1-w)*base + w*teamSavesL10*(1+g(offense-1)) | MAE 5.8695 | -1.80% | [-2.71%, -0.88%] | -1.5 / -2.43 / -1.69 | — | -3.43 / -2.09 / -0.73 | 0.993 | SUPERSEDED BY SIMPLER (V3) |
| V5 | EB shrinkage + best-of(V2,V3,V4) chosen on TRAIN | MAE 5.8129 | -2.74% | [-3.58%, -1.91%] | -2.53 / -3.07 / -2.77 | — | -3.78 / -3.13 / -1.7 | 1 | HOLDOUT CANDIDATE |

Tie-break comparisons: V4_vs_V2: -1.43% [-2.177, -0.68] (clearly better) · V4_vs_V3: -0.41% [-1.054, 0.23] (not clearly better) · V5_vs_V1: -1.44% [-2.106, -0.763] (clearly better) · V5_vs_V3: -1.37% [-1.978, -0.769] (clearly better)

_V1 and V3 each pass individually and are the two components of V5; V5 beats both clearly, so **only V5 is frozen**. V4 is not better than V3 (CI includes 0)._

### Goal ≥1 (n=48422)

| id | description | loss | Δ vs production | 95% CI | blocks (Oct–Dec / Jan–Feb / Mar–Jun) | F / D | history strata | coverage | class |
|---|---|---|---|---|---|---|---|---|---|
| B0 | production baseline: shrinkageFive(all prior) | Brier 0.12307 (ECE 0.0241) | — | — | — | — | — | 1 | BASELINE |
| B1 | opponent shots-allowed environment | Brier 0.12284 (ECE 0.0224) | -0.18% | [-0.29%, -0.08%] | -0.11 / -0.33 / -0.18 | -0.17 / -0.26 | -0.36 / -0.1 / -0.22 | 0.997 | CONTEXT ONLY |
| B2 | sample-size-aware shrinkage toward as-of position prior | Brier 0.12195 (ECE 0.0061) | -0.91% | [-1.05%, -0.78%] | -1.03 / -0.82 / -0.83 | -0.8 / -1.41 | -1.51 / -1.05 / -0.8 | 1 | HOLDOUT CANDIDATE |
| B3 | EB shrinkage + opponent environment | Brier 0.12184 (ECE 0.0058) | -1.00% | [-1.19%, -0.81%] | -1.04 / -1.05 / -0.91 | -0.88 / -1.54 | -1.96 / -1.11 / -0.88 | 0.997 | SUPERSEDED BY SIMPLER (B2) |

Tie-break comparisons: B3_vs_B1: -0.82% [-0.95, -0.682] (clearly better) · B3_vs_B2: -0.09% [-0.185, 0.012] (not clearly better)

### Assist ≥1 (n=48422)

| id | description | loss | Δ vs production | 95% CI | blocks (Oct–Dec / Jan–Feb / Mar–Jun) | F / D | history strata | coverage | class |
|---|---|---|---|---|---|---|---|---|---|
| B0 | production baseline: shrinkageFive(all prior) | Brier 0.17413 (ECE 0.0311) | — | — | — | — | — | 1 | BASELINE |
| B1 | opponent shots-allowed environment | Brier 0.17369 (ECE 0.0283) | -0.25% | [-0.38%, -0.12%] | -0.19 / -0.25 / -0.34 | -0.22 / -0.33 | -0.44 / -0.25 / -0.24 | 0.997 | CONTEXT ONLY |
| B2 | sample-size-aware shrinkage toward as-of position prior | Brier 0.17307 (ECE 0.0128) | -0.61% | [-0.70%, -0.51%] | -0.69 / -0.51 / -0.57 | -0.55 / -0.72 | -1.17 / -0.69 / -0.52 | 1 | HOLDOUT CANDIDATE |
| B3 | EB shrinkage + opponent environment | Brier 0.17271 (ECE 0.0094) | -0.82% | [-0.97%, -0.66%] | -0.83 / -0.73 / -0.87 | -0.73 / -0.99 | -1.95 / -0.94 / -0.67 | 0.997 | SUPERSEDED BY SIMPLER (B2) |

Tie-break comparisons: B3_vs_B1: -0.56% [-0.658, -0.473] (clearly better) · B3_vs_B2: -0.21% [-0.345, -0.08] (not clearly better)

_B3 vs B2: the opponent increment is −0.21% (CI excludes 0) but below the 0.25% materiality bar, so the simpler B2 is frozen._

### Point ≥1 (n=48422)

| id | description | loss | Δ vs production | 95% CI | blocks (Oct–Dec / Jan–Feb / Mar–Jun) | F / D | history strata | coverage | class |
|---|---|---|---|---|---|---|---|---|---|
| B0 | production baseline: shrinkageFive(all prior) | Brier 0.20753 (ECE 0.0247) | — | — | — | — | — | 1 | BASELINE |
| B1 | opponent shots-allowed environment | Brier 0.20709 (ECE 0.0214) | -0.21% | [-0.39%, -0.03%] | -0.15 / -0.21 / -0.3 | -0.17 / -0.3 | -0.49 / -0.19 / -0.2 | 0.997 | CONTEXT ONLY |
| B2 | sample-size-aware shrinkage toward as-of position prior | Brier 0.20687 (ECE 0.0125) | -0.32% | [-0.40%, -0.25%] | -0.37 / -0.18 / -0.35 | -0.26 / -0.45 | -0.97 / -0.37 / -0.24 | 1 | CONTEXT ONLY |
| B3 | EB shrinkage + opponent environment | Brier 0.20642 (ECE 0.0112) | -0.53% | [-0.73%, -0.34%] | -0.51 / -0.41 / -0.66 | -0.44 / -0.74 | -1.74 / -0.59 / -0.4 | 0.997 | HOLDOUT CANDIDATE |

Tie-break comparisons: B3_vs_B1: -0.32% [-0.395, -0.25] (clearly better) · B3_vs_B2: -0.21% [-0.397, -0.033] (not clearly better)

_B3 vs B2: the increment is also −0.21%, but here B2 itself does **not** pass the 0.5% bar (−0.32%, CONTEXT ONLY), so B3 is the only Point variant that qualifies. Marginal._

**Multiplicity.** 17 candidate-vs-production comparisons were made on VALIDATION. A Bonferroni threshold for 17 tests is |z| ≥ 3.0; the promoted candidates' z-scores are Shots on Goal 9.2, Goalie Saves 6.5, Goal ≥1 13.2, Assist ≥1 12.8, Point ≥1 5.5 — all clear it. (The date-clustered SE is the only dependence correction; this is a validation-season statement, not a holdout one.)

## 6. Sanity: does it make hockey sense?

Dose-response on VALIDATION — actual ÷ production prediction by opponent-environment quintile (monotone in every family: facing a shot-hungry opponent really does produce more shots/saves/goals/assists/points than production predicts):

- sog:allowed: Q1 factor 0.841 → y/base 0.902 · Q2 factor 0.909 → y/base 0.958 · Q3 factor 0.953 → y/base 0.973 · Q4 factor 0.995 → y/base 0.983 · Q5 factor 1.082 → y/base 1.022
- saves:offense: Q1 factor 0.841 → y/base 0.926 · Q2 factor 0.909 → y/base 0.949 · Q3 factor 0.951 → y/base 0.948 · Q4 factor 0.996 → y/base 0.984 · Q5 factor 1.073 → y/base 1.03
- goal:allowed: Q1 factor 0.841 → y/base 0.933 · Q2 factor 0.909 → y/base 0.993 · Q3 factor 0.953 → y/base 1.01 · Q4 factor 0.995 → y/base 1.034 · Q5 factor 1.082 → y/base 1.097
- assist:allowed: Q1 factor 0.841 → y/base 0.922 · Q2 factor 0.909 → y/base 0.966 · Q3 factor 0.953 → y/base 1.006 · Q4 factor 0.995 → y/base 1.044 · Q5 factor 1.082 → y/base 1.103
- point:allowed: Q1 factor 0.841 → y/base 0.932 · Q2 factor 0.909 → y/base 0.978 · Q3 factor 0.953 → y/base 1.002 · Q4 factor 0.995 → y/base 1.035 · Q5 factor 1.082 → y/base 1.093

The realised response is gentler than the factor spread at the extremes (e.g. SOG Q1 factor 0.84 vs realised 0.90), i.e. g=1.0 slightly over-corrects the tails; TRAIN preferred 1.0 over 0.5 by a hair (1.07422 vs 1.07448) and the frozen rule is not revisited.

Calibration before → after (VALIDATION):

- **Shots on Goal**: MAE 1.0467 → 1.0374; bias -0.0527 → 0.018; over-projected 57.4% → 55.2%
- **Goalie Saves**: MAE 5.9769 → 5.8129; bias -0.8182 → -0.405; over-projected 53.8% → 50.7%
- **Goal ≥1**: Brier 0.12307 → 0.12195; ECE 0.0241 → 0.0061; LogLoss 0.4187 → 0.3991; skill 4.6% → 5.5%; P≥.40 pred→act 0.452→0.361 (n=1492) → 0.433→0.393 (n=563); P<.10 pred→act 0.047→0.077 → 0.058→0.063
- **Assist ≥1**: Brier 0.17413 → 0.17307; ECE 0.0311 → 0.0128; LogLoss 0.5362 → 0.5266; skill 4.6% → 5.1%; P≥.40 pred→act 0.488→0.43 (n=6358) → 0.476→0.448 (n=5129); P<.10 pred→act 0.065→0.127 → 0.086→0.106
- **Point ≥1**: Brier 0.20753 → 0.20642; ECE 0.0247 → 0.0112; LogLoss 0.6069 → 0.601; skill 8.5% → 9.0%; P≥.40 pred→act 0.535→0.509 (n=17153) → 0.521→0.524 (n=15705); P<.10 pred→act 0.07→0.135 → 0.086→0.111

The binary candidates mostly fix the audit's known **tail over-confidence** (high-P buckets over-predict, low-P buckets under-predict) and the hot-start amplification, which is exactly what sample-size-aware shrinkage is for.

## 7. Leakage check (item 3)

Every promoted feature is a function of rows dated **strictly before** the target game's date. Construction (timestamps/lookbacks):

- **Player history:** the player's stored games with `game_date < D`, all seasons, ascending (n = count). Production semantics, unchanged.
- **League average L(D):** mean team shots over all team-games with `game_date < D` (≥200 required).
- **Opponent environment:** opponent's team-games with `game_date < D` (≥10 required), last ≤15 → `sa15`/`sf15`; ratio to L(D). A team plays at most once per date, so no same-day leakage; cross-season history is continuous (no reset), identically in live use.
- **Position / goalie prior μ:** mean of the stat over all player-games with `game_date < D` in the position group (≥2000 / ≥200 rows).
- **Team shot totals** are *derived from `nhl_player_box`* (Σ skater SOG; Σ goalie saves), not `nhl_team_box` (which live sync never writes). Derived SF equals the stored team box in 5,575 / 5,596 team-games (21 differ by exactly 1 shot); saves match 5,596 / 5,596.
- **No season-final aggregates, no TOI, no future schedule, no closing lines.** Tunables were fixed on TRAIN before VALIDATION was evaluated (`tuned.json` hash-locked before the validation run; `run.js validate` refuses to run if it changed).

**Tests** (`leakcheck.js`): (A) independent re-derivation of every feature from scratch with plain `d < D` filters for 3500 seeded-random target games (700 per family, 2024+2025): **0 mismatches**; (B) poison test — all outcomes and team totals dated ≥ D overwritten with 999 for 8 random dates, everything rebuilt, 3405 game rows on those dates compared (λ0, μ, opponent ratios, team saves): **0 mismatches**. **Negative control:** letting same-day data into the league average makes test A fail (3,499 / 3,500 mismatches), so the test can detect leakage. Result: **PASS**.

## 8. Data availability / live implementability

- **Implementable from stored data:** all five frozen formulas need only `nhl_player_box` columns that the nightly sync already writes (`player_id, game_date, team, opponent, position, goals, assists, points, shots_on_goal, saves, shots_against`). Live rows lack `home_away`, `toi_seconds` and team box, none of which are used.
- **Implementation note (for a later phase, not done here):** the current materializer computes opponent-agnostic per-player rows. The opponent factor needs the player's *upcoming* opponent (the provider board already carries home/away team, as `fetchNhlPropLines` uses) — so live use means materializing the EB-shrunk λ per player plus a small per-team table (sa15, sf15, league average) and applying the opponent factor at join time. EB priors/team tables must be recomputed nightly from history.
- **DATA GAP (unchanged, not re-tested):** power-play usage (no PP TOI/points/opportunities); injuries, line combinations, confirmed starting goalie and opposing-goalie quality; shot quality/xG; live TOI / home-away / team box; goalie back-to-back (TRAIN sample under the harness floor); real provider-line validation.
- **Not re-tested on purpose (audit found weak/worse; premise unchanged):** TOI trend / TOI rate (worse), rest/B2B (noise), own-team shot environment and home/away (context-only, tiny), Platt recalibration (worse). SOG position-prior shrinkage WAS re-tested (S2): TRAIN selected K=0, so it collapses to production.

## 9. FROZEN FORMULAS (exact — no parameter may change after the holdout is opened)

Shared definitions (`frozen-config.json › common_definitions`):

- **history** — All stored nhl_player_box rows for the player with game_date STRICTLY BEFORE the target game date, all seasons, ordered by game_date ASC; stat value non-null (goalies: saves non-null AND shots_against > 0). n = number of such rows.
- **base_lambda** — lambda0 = shrinkageFive(values, k=8) = (n5*mean(last5) + 8*mean(all prior)) / (n5 + 8), n5 = min(5, n)  [lib/nhlProjectionEngine.js, unchanged]
- **team_game_table** — Per (game_id, team): sf = SUM(skater shots_on_goal), sv = SUM(goalie saves); sa = the OTHER team's sf in the same game; only games with exactly two team rows. Derived from nhl_player_box ONLY (no nhl_team_box).
- **league_avg** — L(D) = mean(sf) over ALL team-games dated strictly before D; unavailable (null) if fewer than 200 team-games.
- **opponent_context** — For opponent team O at date D: O's team-games dated strictly before D; unavailable if fewer than 10. sa15 = mean(sa) of the last <=15 of them; sf15 = mean(sf) of the last <=15 of them.
- **r_allowed** — r_allowed = sa15(O) / L(D)  (opponent shots-allowed environment); null if either input unavailable
- **r_offense** — r_offense = sf15(O) / L(D)  (opponent shots-for environment); null if either input unavailable
- **position_group** — 'D' if nhl_player_box.position == 'D', else 'F' (C, L, R)
- **mu_pos** — mean of the SAME stat over ALL skater player-games (any player, any season) dated strictly before D within the target player's position group; null if fewer than 2000 such rows
- **mu_goalie** — mean saves over ALL goalie appearances (saves non-null, shots_against > 0) dated strictly before D; null if fewer than 200 such rows
- **eb** — eb(lambda, n, mu, K) = (n*lambda + K*mu) / (n + K); if mu is null or K == 0 returns lambda unchanged
- **opp** — opp(lambda, r, g) = lambda * (1 + g*(r - 1)); if r is null or g == 0 returns lambda unchanged
- **probability_transform** — P(stat >= 1) = 1 - exp(-max(0, lambda))  (unchanged Poisson transform)
- **edge** — Edge = projection - providerLine for SOG and Saves only, exactly as in production; no edge for binary families (unchanged)

Minimum history (unchanged production gates): {"shots_on_goal":10,"goalie_saves":8,"goals_at_least_1":15,"assists_at_least_1":15,"points_at_least_1":15,"note":"unchanged production gates; denominators identical to production"}

Fallback: If ANY candidate input is unavailable for a game (opponent <10 prior games, league <200 team-games, prior pool too small), that input's adjustment is skipped and the production value for that component is used; no game is dropped. If all adjustments are skipped the output equals production exactly.

| Family | Id | Formula | Frozen parameters | Window |
|---|---|---|---|---|
| shots_on_goal | S1 | `projection = opp(lambda0, r_allowed, g)` | `{"g":1}` | opponent last <=15 team-games, >=10 required |
| goalie_saves | V5 | `lambda1 = eb(lambda0, n, mu_goalie, K1);  projection = opp(lambda1, r_offense, g3)` | `{"K1":40,"g3":0.5}` | opponent last <=15 team-games, >=10 required |
| goals_at_least_1 | B2 | `lambda = eb(lambda0, n, mu_pos, K);  P = 1 - exp(-lambda)` | `{"K":40}` | — |
| assists_at_least_1 | B2 | `lambda = eb(lambda0, n, mu_pos, K);  P = 1 - exp(-lambda)` | `{"K":20}` | — |
| points_at_least_1 | B3 | `lambda = opp(eb(lambda0, n, mu_pos, K), r_allowed, g);  P = 1 - exp(-lambda)` | `{"K":10,"g":1}` | opponent last <=15 team-games, >=10 required |

Worked form of each frozen candidate (λ0 = production `shrinkageFive`):

- **SOG (S1):** projection = λ0 × r_allowed. (g=1, so the factor is r_allowed itself.)
- **Saves (V5):** λ1 = (n·λ0 + 40·μ_goalie)/(n + 40); projection = λ1 × (1 + 0.5·(r_offense − 1)).
- **Goal ≥1 (B2):** λ = (n·λ0 + 40·μ_pos)/(n + 40); P = 1 − e^−λ.
- **Assist ≥1 (B2):** same with K = 20.
- **Point ≥1 (B3):** λ = [(n·λ0 + 10·μ_pos)/(n + 10)] × (1 + g·(r_allowed − 1)), g = 1; P = 1 − e^−λ.

## 10. Pre-registered holdout protocol (Phase 3B — only after explicit approval)

- **run_once** — true
- **retuning_after_opening** — FORBIDDEN -- every parameter above is final; a failing family stays on production and is not re-tuned or re-specified
- **data** — season=2026 rows only for outcomes (history for features includes all earlier stored games, strictly as-of); same eligibility gates and denominators as production
- **metric** — {"shots_on_goal":"MAE","goalie_saves":"MAE","binary":"Brier"}
- **inference** — paired per-row loss difference vs production, SE clustered by game date; Bonferroni across the 5 families -> two-sided 99% CI (z=2.576)
- **pass_rule** — PASS iff 99% CI upper bound < 0 AND relative improvement <= -0.25% (half the promotion bar) AND (binary) ECE not worse by more than 0.005 AND (continuous) |bias| not worse by more than 0.05*mean(actual)
- **consistency_reported_not_gated** — time blocks, F/D, history strata

## 11. Limitations

- Effect sizes are 0.5%–2.7%; NHL props are noise-dominated. No claim about profitability or edge against a market line is made or supported.
- Saves has n≈2.8k per season (wider CIs, but all three blocks and all three history strata agree). Parameters for Saves were tuned on only 2,295 TRAIN rows.
- TRAIN predictions rest on short histories (data begins Oct 2023), so tuned K values describe a shorter-history regime than 2026 will have; how that transfers to the longer histories available in 2026 is untested (the EB weight n/(n+K) already adapts to history length, which is why K is expressed in games).
- Point ≥1 (B3) is marginal; the opponent component adds only −0.215% over EB alone (CI excludes 0 but below the 0.25% materiality bar). It is frozen because it is the only Point variant that clears the pre-declared bar — not because it is strong.
- The older candidate ideas were seen against 2026 in earlier work (§2).
- Live use needs the opponent-aware plumbing described in §8.

## 12. Reproduce / evidence

`node scripts/research/nhl-phase3a/prodcheck.js` · `run.js baseline|tune|validate` · `leakcheck.js` (set `LEAK_NEG=1` for the negative control) · `sanity.js` · `freeze.js` · `verify-frozen.js`. Evidence JSON lives in `tmp/nhl-phase3a/` (untracked). Manifest:

| file | sha256 |
|---|---|
| frozen-config.json | `0527985d73ff2b49798be29838b4eeaf29585d1c4f14e3e22f7abad9461b42f5` |
| guard.js | `b801aba8c70bd435590a08a1ff51aa3da6f57415e683ff5d115383c59bae497a` |
| lib.js | `1c4378549e47cb47d156a243c248fec76b57367251189df6d55b047947e6327c` |
| run.js | `bd0a58df33625635863ac1afa51d68b2310c518b2100dc97a928c41037d81325` |
| leakcheck.js | `340f4a1983e21c99be27d7f57196e396c18d8bd872ec7982053f2ca9c57bb099` |
| prodcheck.js | `b369ca25f6f8f592ebc87c0552409615fac90f28cab562d637dd328a8bf633a6` |
| tuned.json | `9a398db93a28e4ca19a0e59ffa7b7323e947649a12f3bea322d6f3c0888cce26` |
| validation.json | `c79f9bb24b3bc79f65d70d523fc2c5da93cd218fc20973a8b01dd9760345cec5` |
| leakcheck.json | `7667e04a328d68ab5d9a7f827f24e46b136e39c155ac2c487ddb432ad0d53547` |
| prodcheck.json | `4405717e802c951c4b7001dae4ef408785541d05e690abd2c68a4193470dbe4f` |
