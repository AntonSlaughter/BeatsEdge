# NHL model — Phase 3A frozen reference (do not edit)

This directory is the **hash-frozen reference** that `scripts/test-nhl-model-parity.js` compares production against.
Human-readable spec: `docs/NHL_MODEL_CANDIDATES_FROZEN_2026-10-05.md`.

| Path | Role |
|---|---|
| `frozen-config.json` | the exact frozen candidate configuration (SHA-256 recorded in `frozen-hash.txt` and in `lib/nhlModel.js`) |
| `frozen-manifest.json`, `frozen-hash.txt` | SHA-256 of the config and of every locked file below |
| `guard.js`, `lib.js`, `run.js`, `leakcheck.js`, `prodcheck.js` | the locked research implementation (the "frozen research implementation" the parity test reproduces) |
| `evidence/` | the immutable Phase 3A evidence the manifest locks: `tuned.json` (TRAIN-chosen parameters), `validation.json`, `leakcheck.json`, `prodcheck.json` |
| `verify-frozen.js` | recomputes every hash; exit 0 = intact. `node scripts/research/nhl-phase3a/verify-frozen.js` |

Notes
- **Nothing here may change** without a new frozen specification and a new confirmation (the manifest hashes would no longer match).
- `run.js` (locked) writes scratch stage output under `tmp/nhl-phase3a/` (scratch, never committed) if its baseline/tune/validate stages are run; nothing committed reads from `tmp/`. Requiring `run.js` creates that empty scratch folder.
- `prodcheck.js` is historical evidence that the v1 production path equalled the research replay; it compares against v1 numbers and is **not** meant to be re-run against model v2 (the v2 parity proof is `scripts/test-nhl-model-parity.js`).
- The research/parity side needs the local NHL history database (`data/beatsedge.db`, git-ignored). Without it the parity test skips sections B–D and exits **3** (environment, not a pass).
