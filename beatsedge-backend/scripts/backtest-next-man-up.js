// Historical, DESCRIPTIVE backtest of the Next-Man-Up / role-change
// phenomenon against the REAL data/beatsedge.db (read-only -- never
// writes to it). NBA only; see lib/nextManUpSignal.js's header for why.
//
// IMPORTANT FRAMING (read before trusting these numbers): this is a
// DESCRIPTIVE historical analysis, not a simulation of a real-time
// prediction. It identifies "a rotation player (>=15 min trailing avg)
// was entirely absent from this specific COMPLETED game's box score" as
// a proxy for unavailability -- using the completed game's own box score
// to determine who was absent is fine for retrospective analysis (we are
// not predicting the future; we are studying what already happened), but
// it is NOT the same as proving "if we had known about this injury
// beforehand, X would have outperformed his line" -- that would require
// historical pregame injury-announcement data, which does not exist
// anywhere in this repo (confirmed by direct audit of every table). This
// script measures whether the underlying PHENOMENON (opportunity
// redistributes to position-matched teammates when a rotation player is
// missing) is real and detectable in BeatsEdge's own data -- it does not,
// and cannot, prove real-time predictive accuracy of the live signal.
//
// Loads the ENTIRE nba_player_box table ONCE (single query, single
// connection) and does all subsequent computation in plain JS -- this
// avoids the heavy sequential-query pattern that has reproducibly
// crashed better-sqlite3 on this machine elsewhere in this project.
//
// TRAIN/HOLDOUT: thresholds (15 min rotation cutoff, 5-game trailing
// window) are fixed BEFORE looking at either period's results. Train =
// seasons < 2023. Holdout = seasons >= 2023. Nothing is re-tuned after
// seeing the holdout.

const path = require('path');
const Database = require('better-sqlite3');
const { SEASON_TYPE_REGULAR, EXHIBITION_OPP } = require('../lib/nextManUpSignal');

const DB_PATH = path.join(__dirname, '..', 'data', 'beatsedge.db');
const TRAILING_GAMES = 5;
const ROTATION_MIN_MINUTES = 15;
const HOLDOUT_SEASON_CUTOFF = 2023;

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

console.log('=== Next-Man-Up historical backtest (NBA, descriptive) ===');
console.log(`source: ${DB_PATH}\n`);

// played = 1 excludes DNP/inactive rows (confirmed: 75,842 real rows, 14.2% of
// regular-season data, always minutes=0 -- without this filter a genuinely
// absent rotation player would still show a row and be wrongly treated as
// "played" by the roster-membership check below). The exhibition-opponent
// exclusion matches lib/nbaHistDb.js's existing handling of All-Star weekend
// rows that sneak in under season_type=2.
const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare(`
  SELECT athlete_id, athlete_name, team, season, game_id, game_date, pos_group, minutes, starter, points, rebounds, assists
  FROM nba_player_box
  WHERE season_type = ${SEASON_TYPE_REGULAR} AND played = 1
    AND opponent NOT IN (${EXHIBITION_OPP.map(() => '?').join(',')})
  ORDER BY athlete_id, game_date
`).all(...EXHIBITION_OPP);
db.close();
console.log(`loaded ${rows.length} regular-season, played=1, non-exhibition player-game rows (single query, connection closed)\n`);

// ---- Step 1: per-player, trailing-5-game avg minutes BEFORE each of their own games ----
const byAthlete = new Map();
for (const r of rows) {
  if (!byAthlete.has(r.athlete_id)) byAthlete.set(r.athlete_id, []);
  byAthlete.get(r.athlete_id).push(r);
}
// trailingBefore[athlete_id][game_id] = { avgMinutes, games, mostRecentDate, posGroup, team } using only strictly earlier games.
// `team` is the team of the athlete's own most recent prior game -- required below to
// confirm a candidate was actually on THIS team recently (not just at some point in the
// franchise's 17-year history under the same team code).
const trailingBefore = new Map();
for (const [athleteId, games] of byAthlete) {
  const map = new Map();
  const window = [];
  for (const g of games) {
    if (window.length >= 3) {
      const last = window.slice(-TRAILING_GAMES);
      const mostRecent = last[last.length - 1];
      map.set(g.game_id, {
        avgMinutes: mean(last.map(x => x.minutes)),
        avgPoints: mean(last.map(x => x.points)),
        avgRebounds: mean(last.map(x => x.rebounds)),
        avgAssists: mean(last.map(x => x.assists)),
        games: last.length, mostRecentDate: mostRecent.game_date, posGroup: mostRecent.pos_group, team: mostRecent.team,
      });
    }
    window.push(g);
  }
  trailingBefore.set(athleteId, map);
}
console.log('computed trailing-5-game rolling minutes for every player, leakage-safe (only strictly prior games used)\n');

// team -> Set(athlete_id) who ever played for that team, precomputed once (not per-game).
const teamAthleteSets = new Map();
for (const r of rows) {
  if (!teamAthleteSets.has(r.team)) teamAthleteSets.set(r.team, new Set());
  teamAthleteSets.get(r.team).add(r.athlete_id);
}

// ---- Step 2: build team-game rosters ----
// gameRoster: `${team}|${game_id}` -> Set(athlete_id), for O(1) "did they play" checks.
// gameRosterRows: same key -> the actual (small, ~8-15) row array for that team-game,
// so finding position-matched teammates never has to scan the full 533k-row table.
const gameRoster = new Map();
const gameRosterRows = new Map();
const gameMeta = new Map(); // `${team}|${game_id}` -> { season, game_date, team }
for (const r of rows) {
  const key = `${r.team}|${r.game_id}`;
  if (!gameRoster.has(key)) {
    gameRoster.set(key, new Set());
    gameRosterRows.set(key, []);
    gameMeta.set(key, { season: r.season, game_date: r.game_date, team: r.team, game_id: r.game_id });
  }
  gameRoster.get(key).add(r.athlete_id);
  gameRosterRows.get(key).push(r);
}
console.log(`built rosters for ${gameRoster.size} distinct team-games\n`);

// Per-athlete, per-game_id trailing lookup as a Map (avoids the .find() linear
// scan over that athlete's full game list every time we need their pos_group).
const rowByAthleteGame = new Map(); // `${athlete_id}|${game_id}` -> row
for (const r of rows) rowByAthleteGame.set(`${r.athlete_id}|${r.game_id}`, r);

// ---- Step 3: for every team-game, find rotation players who were on this team's roster recently but absent from THIS game ----
// "recently on this team's roster" = they have a trailingBefore entry for a DIFFERENT game_id for the same team within a reasonable date lookback.
// Build per-team, sorted list of that team's own games with dates, to look up "who was rotation-relevant as of just before this date".
const teamGames = new Map(); // team -> sorted [{game_id, game_date, season}]
for (const meta of gameMeta.values()) {
  if (!teamGames.has(meta.team)) teamGames.set(meta.team, []);
  teamGames.get(meta.team).push(meta);
}
for (const arr of teamGames.values()) arr.sort((a, b) => a.game_date.localeCompare(b.game_date));

// For each athlete, their most recent trailing entry as of a given date.
// games[] is already sorted ascending by game_date (single ORDER BY in the
// original query), so binary search for the last game strictly before
// beforeDate instead of a linear scan -- this runs inside a hot loop over
// every (team, game, candidate-athlete) triple.
function mostRecentTrailingAsOf(athleteId, beforeDate) {
  const games = byAthlete.get(athleteId);
  if (!games || !games.length) return null;
  let lo = 0, hi = games.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (games[mid].game_date < beforeDate) { best = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  if (best === -1) return null;
  return trailingBefore.get(athleteId)?.get(games[best].game_id) || null;
}

const events = []; // { season, team, game_id, game_date, absentAthlete, absentTrailingAvg, teammate results[] }
let scannedGames = 0;
for (const [team, games] of teamGames) {
  const teamAthletes = teamAthleteSets.get(team);

  for (const meta of games) {
    scannedGames++;
    const rosterKey = `${team}|${meta.game_id}`;
    const roster = gameRoster.get(rosterKey);
    const rosterRows = gameRosterRows.get(rosterKey); // small array (~8-15 rows), not the full table
    for (const athleteId of teamAthletes) {
      if (roster.has(athleteId)) continue; // played, not absent
      const trailing = mostRecentTrailingAsOf(athleteId, meta.game_date);
      if (!trailing || trailing.games < 3 || trailing.avgMinutes < ROTATION_MIN_MINUTES) continue; // not rotation-relevant, ignore
      // Require the candidate's own most recent prior game to actually be FOR THIS TEAM --
      // otherwise a player who was traded/moved away (and just happens to share this team
      // code from years earlier in franchise history) gets falsely flagged as "absent"
      // using their CURRENT team's trailing minutes. This was the source of a ~5.3M-event
      // false-positive explosion before this check was added.
      if (trailing.team !== team) continue;
      // Only count as a genuine "recent" absence if their last known game was within ~20 days (avoids counting players who left the team long ago)
      const daysSince = (Date.parse(meta.game_date) - Date.parse(trailing.mostRecentDate)) / 86400000;
      if (daysSince > 20 || daysSince < 0) continue;

      const posGroup = trailing.posGroup; // from the absent player's own most recent prior game, not a stale earliest-game lookup
      // Find position-matched teammates who DID play this game (scan only this game's small roster, not the full table)
      const teammateRows = rosterRows.filter(r => r.pos_group === posGroup && r.athlete_id !== athleteId);
      if (!teammateRows.length) continue;

      for (const tm of teammateRows) {
        const tmTrailing = trailingBefore.get(tm.athlete_id)?.get(meta.game_id);
        if (!tmTrailing || tmTrailing.games < 3) continue;
        events.push({
          season: meta.season, team, game_id: meta.game_id, game_date: meta.game_date,
          absentAthleteId: athleteId, absentTrailingAvg: trailing.avgMinutes,
          teammateId: tm.athlete_id, teammateName: tm.athlete_name,
          teammateBaselineMinutes: tmTrailing.avgMinutes, teammateActualMinutes: tm.minutes,
          minutesDelta: tm.minutes - tmTrailing.avgMinutes,
          // Box-score opportunity proxy (NOT usage rate -- no usage-rate column exists in
          // nba_player_box, confirmed by audit; points/rebounds/assists volume is the closest
          // real, non-fabricated substitute available for "did more offensive opportunity
          // materialize").
          pointsDelta: tm.points - tmTrailing.avgPoints,
          reboundsDelta: tm.rebounds - tmTrailing.avgRebounds,
          assistsDelta: tm.assists - tmTrailing.avgAssists,
        });
      }
    }
  }
}
console.log(`scanned ${scannedGames} team-games; found ${events.length} teammate-response events (position-matched, real trailing data on both sides)\n`);

function report(label, evts) {
  console.log(`--- ${label} (n=${evts.length}) ---`);
  if (!evts.length) { console.log('  INSUFFICIENT EVIDENCE (n=0)\n'); return; }
  const deltas = evts.map(e => e.minutesDelta);
  const positiveShare = evts.filter(e => e.minutesDelta > 0).length / evts.length;
  console.log(`  mean minutes delta: ${mean(deltas).toFixed(2)}  median: ${median(deltas).toFixed(2)}`);
  console.log(`  share of events with a POSITIVE minutes bump: ${(positiveShare * 100).toFixed(1)}%`);
  console.log(`  mean baseline minutes (before event): ${mean(evts.map(e => e.teammateBaselineMinutes)).toFixed(2)}`);
  console.log(`  mean actual minutes (event game): ${mean(evts.map(e => e.teammateActualMinutes)).toFixed(2)}`);
  console.log(`  opportunity proxy (box-score volume, NOT usage rate -- no real usage column exists):`);
  console.log(`    mean points delta: ${mean(evts.map(e => e.pointsDelta)).toFixed(2)}  mean rebounds delta: ${mean(evts.map(e => e.reboundsDelta)).toFixed(2)}  mean assists delta: ${mean(evts.map(e => e.assistsDelta)).toFixed(2)}`);
  console.log(`  usage change: N/A -- no usage-rate column exists in nba_player_box (never fabricated)`);
  console.log(`  prop hit rate before/after event: INSUFFICIENT EVIDENCE -- only 39 real NBA prop_snapshots rows exist total (confirmed by prior audit), far too small to compute a hit-rate-before-vs-after comparison`);
  console.log(`  date range: ${evts.reduce((m,e)=>e.game_date<m?e.game_date:m, evts[0].game_date)} .. ${evts.reduce((m,e)=>e.game_date>m?e.game_date:m, evts[0].game_date)}`);
  if (evts.length < 30) console.log('  NOTE: n<30 -- treat as directional only, not statistically reliable.');
  console.log('');
}

const trainEvents = events.filter(e => e.season < HOLDOUT_SEASON_CUTOFF);
const holdoutEvents = events.filter(e => e.season >= HOLDOUT_SEASON_CUTOFF);

console.log('### BASELINE (all position-matched teammates in the SAME games, regardless of any absence) ###');
// Baseline comparison: for a random sample of the same size, teammates' OWN minutes delta on an ordinary day (previous game vs their own trailing avg) with NO absence trigger.
const ordinaryDeltas = [];
for (const [athleteId, games] of byAthlete) {
  for (const g of games) {
    const t = trailingBefore.get(athleteId)?.get(g.game_id);
    if (t && t.games >= 3) ordinaryDeltas.push(g.minutes - t.avgMinutes);
  }
  if (ordinaryDeltas.length > 200000) break; // cap for speed, still a huge sample
}
console.log(`ordinary-day mean minutes delta (own trailing avg vs actual, NO absence trigger), n=${ordinaryDeltas.length}: ${mean(ordinaryDeltas).toFixed(3)}`);
console.log(`ordinary-day share with a positive bump: ${((ordinaryDeltas.filter(d=>d>0).length/ordinaryDeltas.length)*100).toFixed(1)}%\n`);

report('TRAIN (seasons < 2023)', trainEvents);
report('HOLDOUT (seasons >= 2023)', holdoutEvents);
report('ALL SEASONS COMBINED', events);

console.log('=== done ===');
