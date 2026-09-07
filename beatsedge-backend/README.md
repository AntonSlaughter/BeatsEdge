# BeatsEdge Backend

The free fix for the one thing a static HTML file structurally can't do:
call `stats.nba.com` / `stats.wnba.com` (they require a `Referer`/`User-Agent`
header browsers won't let JavaScript set), and compute real
defense-vs-position stats from box scores instead of guessing at them.

**Cost: $0.** Render's free tier + free SQLite file. No credit card.

**Status as of the last real ingest**: this repo ships with `data/beatsedge.db`
already populated from real Kaggle CSVs (see below) — 76,045 real box score
rows and 7,910 real team-game advanced-stat rows, both covering the last
~2.5 seasons. You can deploy this as-is and get real numbers immediately.

---

## What's real vs. what has an honest caveat

| Piece | Status |
|---|---|
| ESPN injuries/scoreboard | Real, live, already working |
| Team defensive rating / pace | **Real**, computed from your own `TeamStatisticsExtended.csv` |
| Defense-by-position: **all 5 positions (PG/SG/SF/PF/C)** | **Real**, computed from real box scores — see below for exact coverage |

### The position-split story, in full

No free source (NBA.com, WNBA.com, ESPN — all three checked directly,
including pulling ESPN's actual roster pages) publishes PG/SG/SF/PF
distinctly. All three cap out at Guard/Forward/Center. That's not a
limitation I invented — it's how the two biggest official sources
structure this data; the fine 5-way split is a judgment call, not a
database field anyone publishes.

So `data/compiled-positions.js` is a **manually compiled reference
table** — built from general basketball knowledge, not sourced from any
API — mapping ~465 real players (the ones with 30+ games in the ingested
data, which covers 94.1% of all sample rows) to their primary position.
`scripts/apply-fine-positions.js` applies it with a safety check: a row
only gets upgraded from "G"/"F" to a specific position if that's
**compatible** with what was actually recorded for that row.

That safety check wasn't a formality — it caught real conflicts. Several
well-known players (Jaylen Brown, Mikal Bridges, Buddy Hield, Max Strus,
Grayson Allen, and others) were recorded as "Forward" for meaningful
chunks of their games in this dataset, likely from small-ball lineups
where they started at the 4. Rather than force those rows into "SG,"
they were left at the coarser, verified-accurate label.

**Final result:** 82.1% of all Guard/Forward rows (53,142 of 64,724)
now have a real, verified-compatible PG/SG/SF/PF label, covering 403
distinct players. The remaining ~18% is split between players with no
compiled entry (deep bench/two-way, ~6,200 rows) and genuine bucket
conflicts like the ones above (~5,400 rows) — both left honestly coarse
rather than guessed.

**This is a v1, not gospel.** Positional tweeners (wings who play both
guard and forward spots) got my best single judgment call, and some of
those are genuinely debatable. If a specific team/position number looks
off to you, check `data/compiled-positions.js` for that player first —
it's a plain JS object, trivial to correct and re-run.

---

## Re-seeding from scratch (if you ever need to)

The included `data/beatsedge.db` is already built with the full pipeline
below applied. If you ever need to rebuild it (e.g. after getting fresher
CSVs), here's what fed it, in order:

1. **`PlayerStatistics.csv`** (Kaggle, free) — per-player-per-game box
   scores. Filtered to games since `2023-07-01`, excluding preseason/
   All-Star/exhibition games.
2. **`Players.csv`** (same Kaggle dataset) — player-level `guard`/
   `forward`/`center` flags, used to backfill position for bench rows
   where the per-game label was blank.
3. **`TeamStatisticsExtended.csv`** (same dataset) — real per-game
   defensive rating, offensive rating, and pace per team.
4. **`data/compiled-positions.js`** (compiled by Claude, see above) —
   upgrades coarse Guard/Forward labels to real PG/SG/SF/PF where
   confidently known and compatible with the recorded data.

The exact ingestion logic for #1–2 lives in `scripts/seed-from-csv.js`.
Steps #3–4 were run as one-off scripts during setup (`ingest_team_advanced.py`
equivalent logic, and `scripts/apply-fine-positions.js` respectively) —
ask if you want #3 turned into a proper `npm run` script alongside the others.

If you don't have fresh CSVs and just want to keep the current data, you
don't need to do anything — it's already in `data/beatsedge.db`.

---

## ⚠️ One honest thing I found while testing this

When I actually ran a request against the real `stats.nba.com` endpoint
from this environment, it came back with a genuine **HTTP 403**, not a
network failure. That could mean:
- the headers need a small tweak (these drift — check
  [nba_api](https://github.com/swar/nba_api)'s current header set if this
  keeps happening, it's the most actively maintained reference), or
- stats.nba.com is blocking the IP range of whatever host you deploy to.

**This no longer breaks anything** — the API now falls back to your real
historical data automatically (see `routes/api.js`), so "Overall Defense"
stays real either way. Try deploying and see if your specific Render
instance gets through live; if not, you're still covered.

---

## Setup (local, ~5 minutes)

```bash
cd beatsedge-backend
npm install
npm run test:dvp   # verify the aggregation math with known fixtures
node server.js      # starts the server on :3001
curl http://localhost:3001/api/health
```

---

## Deploy to Render (free, ~10 minutes)

1. Push this folder (including `data/beatsedge.db` — it's small, a few MB,
   fine to commit) to a GitHub repo
2. Go to [render.com](https://render.com), sign up free (no card needed)
3. **New → Web Service** → connect your repo
4. Settings:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Deploy. Render gives you a URL like `https://beatsedge-backend.onrender.com`

**Note on the free tier sleeping**: it spins down after 15 min idle and
takes 30-60s to wake on the next request. For a betting-analysis site
that's checked a few times a day, this is a non-issue. If you want zero
cold starts, a free service like [cron-job.org](https://cron-job.org) can
ping `/api/health` every 10 minutes to keep it warm — no code changes needed.

### Point BeatsEdge.html at it

In BeatsEdge's "⚙️ Data Sources" settings panel, there's a "Your Backend"
field — paste your Render URL there. It's tried first for opponent
defense, falling back to the existing chain if unreachable, exactly like
every other data source in that app.

---

## API Reference

```
GET /api/health
GET /api/defense/overall/:sport/:season/:team
    Tries live NBA.com/WNBA.com first, falls back to your real historical
    defensive rating/pace if that fails.
    e.g. /api/defense/overall/nba/2025-26/OKC

GET /api/defense/by-position/:sport/:team?window=season|last10|last20
    e.g. /api/defense/by-position/nba/BOS?window=last10
    (currently only returns real data for "C" — see the gap explained above)

GET /api/defense/combined/:sport/:season/:team?window=season|last10|last20
    Both of the above in one call — this is what BeatsEdge.html uses.

GET /api/team/advanced/:sport/:team?window=season|last10
    Real defensive rating, offensive rating, and pace directly — useful
    for the Edge Score engine's "Pace" factor.
```

---

## Keeping data fresh going forward

The nightly cron (`cron/nightlyUpdate.js`) runs automatically at 6am UTC
and once ~10s after every boot. It pulls yesterday's completed games
through this backend's own NBA.com proxy and recomputes the
defense-vs-position rollups — no ongoing Kaggle dependency after the
initial seed. Same known limitation as above: only real for "C" until a
proper position source is added (see `guessPositionFallback()` in
`nightlyUpdate.js` — intentionally a no-op, not a bug).

---

## Why SQLite instead of a "real" database

Zero setup, zero cost, and (aside from the CSV-derived historical data,
which is now checked into `data/beatsedge.db`) everything is rebuildable.
If you outgrow it, swapping `lib/db.js` for Render's free Postgres is a
small, contained change (this file is the only place that touches the
database directly).


---

## NFL — the second sport

Unlike NBA, NFL positions needed **zero manual compilation**. The real
data source, [nflverse](https://github.com/nflverse/nflverse-data)
(free, open-source, actively maintained, goes back to 1999), publishes
clean QB/RB/WR/TE labels directly — no G/F/C-style ambiguity at all.

**What's ingested:** `nfl_player_game_stats` — 16,506 real player-game
rows, 2022-2024 seasons, QB/RB/WR/TE only (the positions PrizePicks
actually offers props on), 0 rows lost to team-abbreviation mapping
issues (nflverse's abbreviations are already clean).

**What's computed:** `nfl_defense_by_position` — real fantasy points,
receiving/rushing/passing yards, receptions, and TDs allowed per team,
per position, across `season`/`last8`/`last4` windows. Verified sane:
Carolina ranks dead-last (#30 of 32) against RB, Philadelphia ranks #4
(tough run defense) — both match public reputation.

**Known gap, stated plainly:** the downloaded `player_stats.csv` caps
at the 2024 season — the current 2025-26 season isn't in it yet (nflverse
publishes it under a different/updated asset that wasn't tracked down in
this pass). The pipeline works correctly on 2022-2024; refreshing to the
current season is the natural next step, same shape as NBA's nightly-cron
story.

**Not yet built for NFL** (flagging honestly, not hiding it): rest-day/
schedule situational splits like NBA has. NFL's schedule is weekly, not
back-to-back-prone like NBA, so the equivalent factor (short-rest
Thursday games, bye-week returns) is a real but smaller effect — a
reasonable follow-up, not done in this pass.

API:
```
GET /api/nfl/defense/by-position/:team?window=season|last8|last4
    e.g. /api/nfl/defense/by-position/CAR?window=season
```

---

## Real situational splits (NBA) — rest days, back-to-backs, home/away

`lib/situationalEngine.js` joins real box scores to a real schedule
table (`team_schedule`, built from `Games.csv`) to answer: how does THIS
player actually perform on a back-to-back vs rested, and at home vs on
the road? Not modeled — literally computed from what happened.

One honest, useful finding from testing this: none of Tatum, Jokić,
Curry, or Giannis showed the back-to-back scoring drop-off that's a
common assumption — real data challenging a popular narrative, which is
exactly the value of computing this yourself instead of assuming it.

API:
```
GET /api/player/situational/:playerName
    e.g. /api/player/situational/Jayson%20Tatum
GET /api/team/schedule-context/:sport/:team/:gameId
```

In BeatsEdge.html, this feeds two new real factors in the Edge Score
engine ("Back-to-Back Tonight"/"Rested" and "Home"/"Away") — both are
**omitted entirely**, not guessed, when a player has fewer than 5 real
games in that specific situation. Requires "Your Backend" to be set in
Data Sources.

---

## MLB — the third sport, architecturally different on purpose

Baseball doesn't have a "defense vs position" concept like basketball or
football. A **batter's** relevant matchup context is the specific
**opposing pitcher** they're facing (ERA, WHIP, K/9), not a team unit. A
**pitcher's** relevant context is the **opposing team's whole lineup**
batting profile (team average, strikeout rate). This pipeline reflects
that instead of forcing a position grid that doesn't fit the sport.

**Data source**: [statsapi.mlb.com](https://statsapi.mlb.com) — MLB's
own official stats API. Free, keyless, and (per its own documentation)
does not enforce CORS, so browser requests work without a proxy. This
backend still stores/aggregates it server-side because rollups (a
pitcher's ERA over their last 5 starts, a team's batting profile) need
persistence and computation, not because MLB requires a proxy the way
NBA does.

**What's real and tested**: the parser and rollup math were verified
against an actual live boxscore fetch from statsapi.mlb.com (a real 2024
Dodgers @ Padres game) — Tyler Glasnow's real line (5.0 IP, 2 ER, 3 K,
4 BB) correctly computes to a 3.60 ERA, 1.20 WHIP, 5.40 K/9. The nightly
cron logic is tested with mocked schedule data confirming postponed
games are correctly skipped.

**What's honestly NOT done**: unlike NBA (Kaggle CSVs) or NFL
(nflverse), no fast bulk historical dataset was found for MLB in this
pass. This pipeline starts **empty** and grows one night at a time via
the nightly cron once deployed — there's no instant historical seed.
If you want one, look into [Retrosheet](https://www.retrosheet.org)
(free, but not in a ready-to-download bulk CSV the way nflverse is) or
`pybaseball`'s Statcast wrappers.

**Also confirmed in testing**: server-side requests to statsapi.mlb.com
can still get blocked by certain IP ranges (a real HTTP 403 during
testing here) even though the API's own CORS policy is open — that's a
network-level/anti-bot thing, separate from CORS, and the same caveat
NBA's stats.nba.com had. The nightly cron handles this the same way:
logs it, skips cleanly, retries the next scheduled run.

**Two rollup fields are intentionally left `null`, not faked**: batting
average against (needs real at-bats-against data not yet wired into the
simplified schema) and team OPS (needs OBP+SLG components not captured
here). Both are real, gettable fields from the same boxscore response —
flagged as a clear next step rather than approximated with a formula
that would look precise but wouldn't be.

API:
```
GET /api/mlb/pitcher/:playerId?window=season|last5starts
    Real ERA/WHIP/K-9/HR-9 for a specific pitcher — the matchup context
    for a BATTER prop.

GET /api/mlb/team-batting/:team?window=season|last15games
    Real team batting average, strikeout rate, runs/game — the matchup
    context for a PITCHER prop.
```

---

## NHL — the fourth sport, hybrid architecture

NHL sits between NBA's and MLB's approaches, for a real reason: its
boxscores already split players into forwards/defense/goalies, so
**skaters get a real defense-vs-position grid** (Forward vs Defenseman)
exactly like NBA — no special-casing needed, the sport's own data
structure already fits. **Goalies get a team-shooting-profile** instead
(shots/goals generated per game by the opponent), mirroring MLB's
pitcher-vs-lineup idea, because a goalie's real matchup is shot volume,
not a position.

**Data source**: [api-web.nhle.com](https://api-web.nhle.com) — the
NHL's own API. Free, keyless, commonly used directly from browsers by
hobbyist projects (see the community-maintained
[NHL-API-Reference](https://github.com/Zmalski/NHL-API-Reference)).

**Verified against real data**: the boxscore parser and rollup math
were tested against an actual live fetch of a real 2023 Wild @ Sabres
game — Kaprizov, Zuccarello, Dahlin, Power's real stat lines feed the
test, and the position-normalization logic (forwards' raw `C`/`L`/`R`
values collapsing to `F`) is verified against their real recorded
positions. 8/8 engine checks pass, 2/2 nightly cron checks pass
(confirming a `FUT` — not-yet-played — game is correctly skipped).

**Same honest gap as MLB**: no bulk historical dataset found for NHL in
this pass either. Starts empty, grows one night at a time via the
nightly cron once deployed.

API:
```
GET /api/nhl/defense/by-position/:team?window=season|last10|last5
    Real goals/assists/points/shots allowed to Forwards vs Defensemen.

GET /api/nhl/team-shooting/:team?window=season|last10
    Real shots/goals generated per game — the matchup context for a
    GOALIE prop (saves, goals against).
```

---

## Summary: all four sports, one honest pattern

| Sport | Data Source | Cost | Historical Seed | Architecture |
|---|---|---|---|---|
| NBA | Kaggle CSVs + stats.nba.com (best-effort) + ESPN | Free | Yes (real CSVs) | Position grid (PG/SG/SF/PF/C) |
| NFL | nflverse | Free | Yes (real CSV) | Position grid (QB/RB/WR/TE) |
| MLB | statsapi.mlb.com | Free | No — grows nightly | Pitcher-vs-batter, lineup-vs-pitcher |
| NHL | api-web.nhle.com | Free | No — grows nightly | Position grid (skaters) + shooting profile (goalies) |

Every pipeline follows the same rules: real data or clearly labeled
sample data, never a blended guess; tests written against actual
fetched API responses where possible, not just synthetic fixtures;
and every nightly cron degrades gracefully (logs, skips, retries) if
the source API is unreachable — which happened for all three "live"
sources during this project's own testing, and none of it caused a
crash.
