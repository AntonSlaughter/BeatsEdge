# Data Attribution — nflverse

BeatsEdge's `nfl_player_game_stats` table (fields: `pass_attempts`, `completions`, `rush_attempts` for the 2022–2024 seasons, repaired 2026-09-28) uses data sourced from **nflverse-data**:

- Project: https://github.com/nflverse/nflverse-data
- Dataset: `stats_player_week_<season>.csv` (the `stats_player` release)
- License: **CC BY 4.0** (Creative Commons Attribution 4.0 International) — https://creativecommons.org/licenses/by/4.0/

nflverse-data is licensed under CC BY 4.0, which permits commercial use with attribution. This data is not created by BeatsEdge; it is sourced from and attributed to the nflverse project. BeatsEdge does not claim authorship of the underlying data, only of its own ingestion, storage, and downstream computation.

Ongoing/nightly ingestion of current-season NFL data (`scripts/ingest-nflverse-stats.js`) and this one-time historical repair (`scripts/repair-nfl-2022-2024-attempts.js`) both draw from the same nflverse `stats_player` release and are covered by this same attribution.
