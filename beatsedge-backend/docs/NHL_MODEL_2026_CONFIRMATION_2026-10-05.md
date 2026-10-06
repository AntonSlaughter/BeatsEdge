# NHL Model — One-Time Frozen 2026 Confirmation (Phase 3B)

**Date:** 2026-10-05 · **Production reference:** `b67957a` — `lib/nhlProjectionEngine.js` **not modified**; nothing integrated, committed, pushed or deployed.

| Item | SHA-256 |
|---|---|
| Phase 3A frozen config (`frozen-config.json`) | `0527985d73ff2b49798be29838b4eeaf29585d1c4f14e3e22f7abad9461b42f5` |
| Phase 3A frozen research manifest | `893d717a22688e9f83c0e7009318c65f0b404423d873eb761aa2a44a2118c678` |
| Confirmation code (`confirm.js` + `guard.js`), pre-registered before the run | `b4eff2b9365f937a69429ddf26690e9a279fab72db6fa2d0d054e5800cbf2345` |
| &nbsp;&nbsp;`confirm.js` | `227a1c5bfdda7024bcc6fc3425202ce7e255569eb94061fbcaa676b4da6a803b` |
| &nbsp;&nbsp;`guard.js` | `403dbfdc9113c185aca7c39a881d5cf221fd520fdb2d7a4fa26f272e64510bd9` |
| Result file `tmp/nhl-phase3b/confirmation.json` | `e2dfe755076b6bdbd02fc25a54d071adaffb0edaf3592ba578a10a28692d3a92` |
| Console output `run-output.txt` | `2c56de4617dbf7bba39beb46e3c66fe36b11068f4c3fdba0ca5c7c23409180f8` |

The Phase 3A frozen specification (`docs/NHL_MODEL_CANDIDATES_FROZEN_2026-10-05.md`, `scripts/research/nhl-phase3a/*`) was **not modified**; `verify-frozen.js` reported `FROZEN SPEC INTACT` immediately before the run and again inside `confirm.js`, which aborts otherwise.

## 1. Verdicts

| Family | N (2026) | Production | Candidate | Δ abs | Δ rel | 99% CI (rel) | Pass-rule conditions (CI<0 · ≥0.25% · calibration) | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Shots on Goal** (S1) | 48,909 | MAE 1.0364 | MAE 1.0286 | -0.0078 | **-0.753%** | [-0.944%, -0.562%] | ✓ · ✓ · ✓ | **PASS — PROMOTE** |
| **Goalie Saves** (V5) | 2,854 | MAE 5.9684 | MAE 5.8116 | -0.1568 | **-2.627%** | [-3.667%, -1.586%] | ✓ · ✓ · ✓ | **PASS — PROMOTE** |
| **Goal >=1** (B2) | 48,314 | Brier 0.12460 | Brier 0.12361 | -0.00099 | **-0.795%** | [-0.960%, -0.630%] | ✓ · ✓ · ✓ | **PASS — PROMOTE** |
| **Assist >=1** (B2) | 48,314 | Brier 0.17545 | Brier 0.17468 | -0.00077 | **-0.439%** | [-0.557%, -0.321%] | ✓ · ✓ · ✓ | **PASS — PROMOTE** |
| **Point >=1** (B3) | 48,314 | Brier 0.20848 | Brier 0.20779 | -0.00069 | **-0.331%** | [-0.569%, -0.093%] | ✓ · ✓ · ✓ | **PASS — PROMOTE** |

**All five frozen candidates pass the pre-registered rule as written; none was re-tuned, re-specified, or judged against a relaxed threshold.** Point ≥1 passes with the least margin (−0.331% against the −0.25% bar; 99% CI upper bound −0.093%). Its standard was not lowered.

## 2. What this is — and is not

- **Prediction quality against actual NHL outcomes only.** It does **not** show profitability or edge against PrizePicks or sportsbook lines: genuine historical provider-line validation is still incomplete (no readable NHL line archive; NHL absent from archive health). No betting claim is made or implied.
- **A pre-registered 2026 confirmation — not a pristine-from-inception holdout.** Earlier exploratory work and the Oct 1 audit had visibility into some 2026 results, and the candidate *ideas* (opponent shot environment, team-saves pooling, EB shrinkage) originate from earlier work that evaluated 2025 and 2026 together. What *is* clean: every parameter, window, K, strength and the pass rule were fixed on TRAIN (2024) / VALIDATION (2025) and hash-frozen before any 2026 outcome was evaluated in this phase.
- **Effect sizes are small** (0.3%–2.6% relative). NHL props are noise-dominated.

## 3. Procedure (fixed before the run)

1. `verify-frozen.js` must report intact (else abort, no repair/regeneration). 2. `confirm.js` + `guard.js` hashes must equal the pre-registered value (`register-hash.js`, run before `confirm.js`). 3. Guard: only `season IN (2024,2025,2026)`; season 2027 and dates after 2026-07-31 refused (guard totals: {"queries":6,"rowsSeen":620823,"allowedSeasons":[2024,2025,2026],"maxDate":"2026-07-31"}). 4. **Pipeline control:** with the 2026 rows in memory, the same pipeline must reproduce the Phase 3A VALIDATION(2025) production and candidate losses exactly — it did, for all five families (sog n=49008, saves n=2839, goal n=48422, assist n=48422, point n=48422), which also shows later rows cannot influence earlier predictions. 5. Formulas/parameters read from `frozen-config.json` and the hash-locked `tuned.json`, never retyped. 6. **One run:** `confirm.js` refuses to run if `confirmation.json` exists. 7. Features are strictly as-of (history, league average, opponent L15, μ priors all use only rows dated before the target game; unchanged from the Phase 3A leakage-checked construction).

**Pass rule (frozen in Phase 3A):** two-sided 99% CI (z = 2.576; Bonferroni across 5 families; SE clustered by game date) upper bound < 0 **and** relative improvement ≤ −0.25% **and** (binary) ECE not worse by more than 0.005 **or** (continuous) |bias| not worse by more than 0.05 × mean(actual). **Verdict definitions (written in `confirm.js` before the run):** PASS — PROMOTE = all conditions hold; FAIL — KEEP PRODUCTION = point estimate not improved, or 99% CI lower bound > 0, or calibration condition violated; INCONCLUSIVE — KEEP PRODUCTION = point estimate improves and calibration is fine but the 99% CI includes 0 or the gain is under 0.25%. Stability slices never feed a verdict.

## 4. Primary metrics

### 4.1 Shots on Goal and Goalie Saves (loss = absolute error)

| | N | game-dates | prod MAE | cand MAE | Δ abs | Δ rel | SE (rel) | 99% CI | 95% CI | prod bias | cand bias | prod RMSE | cand RMSE |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Shots on Goal | 48909 | 211 | 1.0364 | 1.0286 | -0.00780 | -0.753% | 0.074% | [-0.944%, -0.562%] | [-0.898%, -0.608%] | -0.0436 | 0.0154 | 1.3383 | 1.3366 |
| Goalie Saves | 2854 | 211 | 5.9684 | 5.8116 | -0.15678 | -2.627% | 0.404% | [-3.667%, -1.586%] | [-3.418%, -1.835%] | -0.7072 | -0.3975 | 7.6518 | 7.4781 |

Error distribution (error = actual − projection):

| | model | P10 | P50 | P90 | \|err\| P90 | ±1 | ±2 | % over-projected | mean pred | mean actual |
|---|---|---|---|---|---|---|---|---|---|---|
| Shots on Goal | production | -1.5 | -0.22 | 1.73 | 2.08 | 56.9% | 88.7% | 57.0% | 1.604 | 1.56 |
| Shots on Goal | candidate | -1.43 | -0.16 | 1.78 | 2.08 | 57.8% | 88.8% | 55.1% | 1.545 | 1.56 |
| Goalie Saves | production | -9.91 | -0.56 | 8.78 | 12.7 | 11.0% | 20.8% | 52.7% | 24.243 | 23.536 |
| Goalie Saves | candidate | -9.47 | -0.25 | 8.58 | 12.28 | 11.0% | 22.2% | 51.3% | 23.933 | 23.536 |

Calibration by projection quintile (mean projection → mean actual):

- **Shots on Goal — production:** Q1 0.766→0.835 (n=9781) · Q2 1.123→1.114 (n=9782) · Q3 1.462→1.413 (n=9782) · Q4 1.908→1.841 (n=9782) · Q5 2.76→2.598 (n=9782)
- **Shots on Goal — candidate:** Q1 0.726→0.822 (n=9781) · Q2 1.075→1.125 (n=9782) · Q3 1.403→1.419 (n=9782) · Q4 1.834→1.847 (n=9782) · Q5 2.687→2.588 (n=9782)
- **Goalie Saves — production:** Q1 21.349→21.886 (n=570) · Q2 23.202→23.384 (n=571) · Q3 24.262→23.594 (n=571) · Q4 25.359→23.562 (n=571) · Q5 27.037→25.25 (n=571)
- **Goalie Saves — candidate:** Q1 21.601→21.467 (n=570) · Q2 22.993→22.76 (n=571) · Q3 23.867→23.326 (n=571) · Q4 24.796→24.468 (n=571) · Q5 26.405→25.655 (n=571)

Bias condition: Shots on Goal |bias| 0.0436 → 0.0154 (limit on worsening 0.07801) — ok; Goalie Saves |bias| 0.7072 → 0.3975 (limit on worsening 1.17679) — ok. Absolute bias falls by 65% for Shots on Goal (0.0436 → 0.0154) and 44% for Saves (0.7072 → 0.3975).

### 4.2 Goal ≥1, Assist ≥1, Point ≥1 (loss = Brier)

| | N | prod Brier | cand Brier | Δ abs | Δ rel | SE (rel) | 99% CI | 95% CI | prod ECE | cand ECE | prod LogLoss | cand LogLoss | prod skill | cand skill |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Goal >=1 | 48314 | 0.1246 | 0.12361 | -0.00099 | -0.795% | 0.064% | [-0.960%, -0.630%] | [-0.920%, -0.670%] | 0.0223 | 0.0084 | 0.4196 | 0.4038 | 4.32% | 5.08% |
| Assist >=1 | 48314 | 0.17545 | 0.17468 | -0.00077 | -0.439% | 0.046% | [-0.557%, -0.321%] | [-0.529%, -0.350%] | 0.0267 | 0.0138 | 0.5413 | 0.5305 | 4.91% | 5.32% |
| Point >=1 | 48314 | 0.20848 | 0.20779 | -0.00069 | -0.331% | 0.093% | [-0.569%, -0.093%] | [-0.512%, -0.150%] | 0.0231 | 0.0163 | 0.61 | 0.6046 | 8.55% | 8.85% |

Base rate / mean predicted probability (calibration-in-the-large): Goal >=1 base 0.1539, production 0.1521, candidate 0.1564; Assist >=1 base 0.2441, production 0.2407, candidate 0.2464; Point >=1 base 0.3516, production 0.3484, candidate 0.3435. **Note:** the candidates shift the mean slightly (Goal/Assist now very slightly high, Point now 0.8 pt low); ECE and Brier improve, but Point's calibration-in-the-large gap is larger than production's — disclosed, not gated by the pre-registered rule.

Probability-decile calibration (predicted → actual, n):

- **Goal >=1 — production:** 0.0-0.1 0.0491→0.0791 (19087) · 0.1-0.2 0.1464→0.1472 (14841) · 0.2-0.3 0.2446→0.2288 (8603) · 0.3-0.4 0.3431→0.2947 (4353) · 0.4-0.5 0.4396→0.3468 (1286) · 0.5-0.6 0.5274→0.3121 (141) · 0.6-0.7 0.6073→0.6667 (3)
- **Goal >=1 — candidate:** 0.0-0.1 0.0585→0.0675 (15891) · 0.1-0.2 0.1479→0.1457 (18549) · 0.2-0.3 0.2435→0.2387 (9412) · 0.3-0.4 0.3402→0.308 (3682) · 0.4-0.5 0.4321→0.3638 (745) · 0.5-0.6 0.5215→0.2857 (35)
- **Assist >=1 — production:** 0.0-0.1 0.0679→0.1292 (6593) · 0.1-0.2 0.1509→0.1727 (14761) · 0.2-0.3 0.247→0.2396 (12757) · 0.3-0.4 0.3454→0.3246 (7865) · 0.4-0.5 0.4434→0.3993 (4137) · 0.5-0.6 0.5406→0.4923 (1627) · 0.6-0.7 0.6357→0.5761 (493) · 0.7-0.8 0.7319→0.5375 (80) · 0.8-0.9 0.8059→1 (1)
- **Assist >=1 — candidate:** 0.0-0.1 0.0859→0.1151 (2884) · 0.1-0.2 0.1531→0.1643 (17131) · 0.2-0.3 0.2457→0.2361 (14780) · 0.3-0.4 0.3449→0.3366 (8047) · 0.4-0.5 0.4423→0.4126 (3757) · 0.5-0.6 0.5399→0.5111 (1346) · 0.6-0.7 0.6368→0.5552 (326) · 0.7-0.8 0.7279→0.6512 (43)
- **Point >=1 — production:** 0.0-0.1 0.0709→0.1629 (1878) · 0.1-0.2 0.156→0.196 (8485) · 0.2-0.3 0.2508→0.2619 (10843) · 0.3-0.4 0.3477→0.3289 (9825) · 0.4-0.5 0.4479→0.4329 (7468) · 0.5-0.6 0.5463→0.5399 (5492) · 0.6-0.7 0.643→0.6145 (3227) · 0.7-0.8 0.738→0.6884 (953) · 0.8-0.9 0.8309→0.7552 (143)
- **Point >=1 — candidate:** 0.0-0.1 0.0855→0.1315 (844) · 0.1-0.2 0.1575→0.1916 (8487) · 0.2-0.3 0.2504→0.2596 (12533) · 0.3-0.4 0.3478→0.3365 (10409) · 0.4-0.5 0.4477→0.4559 (7544) · 0.5-0.6 0.5461→0.5621 (5093) · 0.6-0.7 0.6422→0.6236 (2609) · 0.7-0.8 0.7363→0.6999 (693) · 0.8-0.9 0.8296→0.7549 (102)

## 5. Probability sanity — did shrinkage correct the audit's overconfidence?

Bands by predicted probability (gap = predicted − actual; negative = under-predicting, positive = over-predicting):

| Family | Band | Production n · pred · actual · gap | Candidate n · pred · actual · gap | |gap| change |
|---|---|---|---|---|
| Goal >=1 | low tail P<0.10 | 19087 · 0.0491 · 0.0791 · -0.0299 | 15891 · 0.0585 · 0.0675 · -0.009 | smaller ✓ |
| Goal >=1 | 0.10-0.20 | 14841 · 0.1464 · 0.1472 · -0.0007 | 18549 · 0.1479 · 0.1457 · +0.0022 | larger ✗ |
| Goal >=1 | middle 0.20-0.40 | 12956 · 0.2777 · 0.2509 · +0.0268 | 13094 · 0.2707 · 0.2582 · +0.0125 | smaller ✓ |
| Goal >=1 | high tail P>=0.40 | 1430 · 0.4487 · 0.3441 · +0.1046 | 780 · 0.4361 · 0.3603 · +0.0759 | smaller ✓ |
| Assist >=1 | low tail P<0.10 | 6593 · 0.0679 · 0.1292 · -0.0613 | 2884 · 0.0859 · 0.1151 · -0.0292 | smaller ✓ |
| Assist >=1 | 0.10-0.20 | 14761 · 0.1509 · 0.1727 · -0.0217 | 17131 · 0.1531 · 0.1643 · -0.0112 | smaller ✓ |
| Assist >=1 | middle 0.20-0.40 | 20622 · 0.2846 · 0.272 · +0.0125 | 22827 · 0.2807 · 0.2715 · +0.0091 | smaller ✓ |
| Assist >=1 | high tail P>=0.40 | 6338 · 0.487 · 0.4388 · +0.0482 | 5472 · 0.4801 · 0.4472 · +0.0329 | smaller ✓ |
| Point >=1 | low tail P<0.10 | 1878 · 0.0709 · 0.1629 · -0.092 | 844 · 0.0855 · 0.1315 · -0.046 | smaller ✓ |
| Point >=1 | 0.10-0.20 | 8485 · 0.156 · 0.196 · -0.04 | 8487 · 0.1575 · 0.1916 · -0.0341 | smaller ✓ |
| Point >=1 | middle 0.20-0.40 | 20668 · 0.2969 · 0.2937 · +0.0031 | 22942 · 0.2946 · 0.2945 · +0.0001 | smaller ✓ |
| Point >=1 | high tail P>=0.40 | 17283 · 0.5347 · 0.5176 · +0.0172 | 16041 · 0.5255 · 0.5293 · -0.0039 | smaller ✓ |

**Reading:** yes, in the direction the audit predicted, but only partly.
- **Low-probability tails** (the model was too pessimistic) improve substantially — the P<0.10 gap roughly halves or better for Goal (−3.0 → −0.9 pt), Assist (−6.1 → −2.9 pt) and Point (−9.2 → −4.6 pt) — yet Point and Assist still under-predict their lowest bucket.
- **High-probability tails** (too confident) shrink: Goal P≥0.40 gap +10.5 → +7.6 pt (still clearly over-confident: 43.6% predicted vs 36.0% actual, on only 780 rows), Assist +4.8 → +3.3 pt, Point +1.7 → −0.4 pt (now centred).
- **Middle buckets** stay well calibrated (Point 0.20–0.40 gap +0.3 → +0.0 pt).
- The shrinkage is therefore a real calibration improvement (ECE falls 62% for Goal, 48% for Assist, 29% for Point) but **not a complete fix**; Goal ≥1 in particular is still over-confident at the top. No recalibration was applied or fitted on 2026.

## 6. Stability — DIAGNOSTIC ONLY (relative Brier/MAE change vs production; negative = candidate better)

Slices were not used to change any verdict or formula.

| Family | early (Oct–Dec 2025) | middle (Jan–Feb 2026) | late (Mar–Jun 2026) | Forwards | Defence | history n<40 / 40–99 / ≥100 (goalies <30 / 30–79 / ≥80) | home | away |
|---|---|---|---|---|---|---|---|---|
| Shots on Goal | -0.581% (n=21891) | -0.928% (n=11162) | -0.87% (n=15856) | -0.768% (n=32484) | -0.719% (n=16425) | -0.725% / -0.881% / -0.741% | -0.787% (n=24452) | -0.719% (n=24457) |
| Goalie Saves | -3.262% (n=1267) | -1.207% (n=652) | -2.74% (n=935) | n/a | n/a | -0.424% / -2.71% / -2.851% | -2.535% (n=1431) | -2.718% (n=1423) |
| Goal >=1 | -0.862% (n=21522) | -0.755% (n=11068) | -0.733% (n=15724) | -0.746% (n=32069) | -1.011% (n=16245) | -2.399% / -1.431% / -0.657% | -0.782% (n=24177) | -0.808% (n=24137) |
| Assist >=1 | -0.525% (n=21522) | -0.398% (n=11068) | -0.349% (n=15724) | -0.409% (n=32069) | -0.501% (n=16245) | -1.269% / -0.975% / -0.342% | -0.458% (n=24177) | -0.42% (n=24137) |
| Point >=1 | -0.269% (n=21522) | -0.076% (n=11068) | -0.596% (n=15724) | -0.282% (n=32069) | -0.44% (n=16245) | -1.668% / -0.824% / -0.196% | -0.41% (n=24177) | -0.251% (n=24137) |

Every slice of every family has the candidate ahead of production (all values negative). Home/away data are fully populated for these seasons (coverage 1/1/1/1/1), nothing filled in. Honest caveats from the slices: **Point ≥1**'s gain is weakest where most data live — −0.196% for established players (history ≥100 games, 83% of rows), −0.076% in the Jan–Feb block, both below the 0.25% bar taken alone; the overall −0.331% is carried by short-history players (−1.7% for <40 games). Saves' gain is smallest for goalies with <30 games (−0.4%, n=200) and in Jan–Feb (−1.2%). These are descriptions, not grounds to alter anything.

## 7. Decisions

| Family | Decision |
|---|---|
| Shots on Goal (S1) | **PASS — PROMOTE** |
| Goalie Saves (V5) | **PASS — PROMOTE** |
| Goal >=1 (B2) | **PASS — PROMOTE** |
| Assist >=1 (B2) | **PASS — PROMOTE** |
| Point >=1 (B3) | **PASS — PROMOTE** |

**PASS — PROMOTE here means "eligible to be implemented as an explicit, versioned production change", nothing more.** Nothing was integrated. Before any integration: (1) the opponent-aware plumbing described in Phase 3A §8 must be built (the materializer is opponent-agnostic today); (2) before/after output comparison on production data; (3) the copy must not use "confidence"/"edge" language for the binary families; (4) real-line validation remains a DATA GAP and still blocks any profitability claim.

## 8. Reproduce

`node scripts/research/nhl-phase3a/verify-frozen.js` → `node scripts/research/nhl-phase3b/register-hash.js` (already registered; idempotent) → `node scripts/research/nhl-phase3b/confirm.js` (refuses a second run) → `node scripts/research/nhl-phase3b/mkdoc.js`. Evidence: `tmp/nhl-phase3b/confirmation.json`, `run-output.txt` (untracked).

