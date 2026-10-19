// NHL unlock project -- keeps lib/nhlProjectionEngine.js's validated
// model history (nhl_player_box) current automatically, by extending the
// EXISTING, already-live NHL nightly pipeline (cron/nhlNightlyUpdate.js,
// lib/nhlEngine.js's real api-web.nhle.com boxscore parsing) rather than
// re-downloading/reprocessing the SportsDataverse historical dataset.
//
// Does NOT modify lib/nhlEngine.js's existing parseBoxscore/
// insertBoxscoreAsync functions at all -- reuses parseBoxscore exactly
// as-is (a pure function; its own callers/output shape are completely
// unchanged) and maps its real output onto nhl_player_box/nhl_team_box's
// EXISTING schema (the same tables the SportsDataverse historical rows
// already live in). parseBoxscore already excludes goalies who never
// entered the game (`if (!g.shotsAgainst || g.shotsAgainst === 0)
// return;`), the SAME corrected convention this project's Saves research
// required -- inherited for free by reusing it, not reimplemented.
//
// STAT DEFINITION EQUIVALENCE (verified live, 2026-09-29, real completed
// game 2026010008 fetched directly from api-web.nhle.com): the live
// boxscore's goals/assists/points/sog fields and the SportsDataverse
// fastRhockey CSV's goals/assists/points/shots_on_goal columns are the
// same standard, unambiguous NHL box-score counting stats (goals,
// assists, points, shots on goal, saves, shots against all have a single
// accepted real-world definition in hockey, unlike sport stats that can
// have provider-specific variants) -- both ultimately sourced from the
// NHL's own official game data. No temporally-overlapping game exists
// between the two sources to do an exact same-game numeric cross-check
// (SportsDataverse's most recent complete season ends June 2026; the
// live table starts 2026-09-20) -- flagged honestly as a real limit of
// this equivalence check, not glossed over. Real player names in the
// live feed are ALSO abbreviated to first-initial + last name (e.g.
// "P. Engvall", confirmed live) -- the same format as the SportsDataverse
// source, so nhlMatchKey's last-initial matching (BeatsEdge.html) works
// identically against rows from either source with no extra handling.
//
// Idempotent: same (game_id, player_id) PRIMARY KEY + INSERT OR IGNORE
// nhl_player_box already uses for the SportsDataverse rows. A failure
// here is caught by the caller and never touches/deletes/updates
// anything already written -- append-only, existing history stays intact.

const { parseBoxscore } = require('./nhlEngine');
const store = require('./historicalStore');

// Real field on every api-web.nhle.com boxscore response, e.g.
// 20262027 -> 2027 (confirmed live). Ending-year convention, matching
// nhl_player_box's existing `season` column exactly (2024/2025/2026 for
// the SportsDataverse-ingested seasons).
function seasonEndYear(boxscore) {
  const s = boxscore && boxscore.season;
  if (!s) return null;
  return parseInt(String(s).slice(4), 10) || null;
}

// Source-provided fields parseBoxscore does not carry (parseBoxscore is shared with the live rollups and is left untouched): home / away,
// time on ice ("mm:ss" -> whole seconds, the same unit as the bulk history) and plus/minus (skaters only; the API gives goalies none).
// A field the response does not provide stays NULL -- never 0.
function toiSeconds(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,3}):([0-5]\d)$/.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function sourceFields(boxscore) {
  const out = new Map();
  for (const side of ['awayTeam', 'homeTeam']) {
    const stats = boxscore.playerByGameStats && boxscore.playerByGameStats[side];
    if (!stats) continue;
    for (const group of ['forwards', 'defense', 'goalies']) {
      for (const p of stats[group] || []) {
        out.set(String(p.playerId), {
          home_away: side === 'homeTeam' ? 'home' : 'away',
          toi_seconds: toiSeconds(p.toi),
          plus_minus: group !== 'goalies' && typeof p.plusMinus === 'number' && Number.isFinite(p.plusMinus) ? p.plusMinus : null,
        });
      }
    }
  }
  return out;
}

// Repeat syncs of a game fill only columns that are still NULL (COALESCE keeps any value already stored, from the bulk history or an earlier sync) and
// change no other column: DO UPDATE touches exactly these three.
const FILL_NULLS = 'ON CONFLICT(game_id, player_id) DO UPDATE SET home_away = COALESCE(nhl_player_box.home_away, excluded.home_away), toi_seconds = COALESCE(nhl_player_box.toi_seconds, excluded.toi_seconds), plus_minus = COALESCE(nhl_player_box.plus_minus, excluded.plus_minus)';

async function syncBoxscoreToPlayerBox(boxscore, gameDate, gameId) {
  const season = seasonEndYear(boxscore);
  if (!season) return { skaterRows: 0, goalieRows: 0, skipped: 'no real season field on boxscore' };
  const { skaterRows, goalieRows } = parseBoxscore(boxscore, gameDate, gameId);
  const src = sourceFields(boxscore);
  const extra = (r) => { const s = src.get(r.player_id) || {}; return [s.home_away == null ? null : s.home_away, s.toi_seconds == null ? null : s.toi_seconds, s.plus_minus == null ? null : s.plus_minus]; };

  const skaterCols = ['game_id', 'player_id', 'player_name', 'season', 'game_date', 'team', 'opponent', 'position', 'goals', 'assists', 'points', 'hits', 'shots_on_goal', 'blocked_shots', 'home_away', 'toi_seconds', 'plus_minus'];
  const skaterSql = `INSERT INTO nhl_player_box (${skaterCols.join(', ')}) VALUES (${skaterCols.map(() => '?').join(', ')}) ${FILL_NULLS}`;
  const skaterParams = skaterRows.map(r => [
    r.game_id, r.player_id, r.player_name, season, r.game_date, r.team, r.opponent, r.position,
    r.goals, r.assists, r.points, r.hits, r.shots_on_goal, r.blocked_shots, ...extra(r),
  ]);

  const goalieCols = ['game_id', 'player_id', 'player_name', 'season', 'game_date', 'team', 'opponent', 'shots_against', 'saves', 'goals_against', 'save_pctg', 'starter', 'home_away', 'toi_seconds', 'plus_minus'];
  const goalieSql = `INSERT INTO nhl_player_box (${goalieCols.join(', ')}) VALUES (${goalieCols.map(() => '?').join(', ')}) ${FILL_NULLS}`;
  const goalieParams = goalieRows.map(r => [
    r.game_id, r.player_id, r.player_name, season, r.game_date, r.team, r.opponent,
    r.shots_against, r.saves, r.goals_against, r.save_pct, r.is_starter, ...extra(r),
  ]);

  if (skaterParams.length) await store.batchInsert(skaterSql, skaterParams);
  if (goalieParams.length) await store.batchInsert(goalieSql, goalieParams);

  return { skaterRows: skaterParams.length, goalieRows: goalieParams.length, season };
}

module.exports = { syncBoxscoreToPlayerBox, seasonEndYear, toiSeconds, sourceFields };
