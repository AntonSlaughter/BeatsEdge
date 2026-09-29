// Phase 2I-P -- sport-agnostic core: derive per-period player stats from an
// array of already-fetched PBP play rows. Shared by lib/nbaPbpDb.js and
// lib/wnbaPbpDb.js (each supplies its own gamePlays(gameId) query against
// its own pbp table; the derivation logic itself is identical because
// both nba_pbp and wnba_pbp are ingested from the same sportsdataverse
// release family with the same column shape). This is "the reusable
// foundation built once" -- never a second, disconnected copy per sport.
//
// DERIVATION RULES (carried over unmodified from lib/wnbaPbpDb.js's
// Phase 2I-E-validated methodology, extended with 3PM/3PA per the
// Phase 2I-G-validated methodology -- see those modules' history for the
// full evidence trail):
//
//   POINTS      -- scoring_play=1, credited by score_value to athlete_id_1.
//                  Excludes the single documented "No Shot (Default Shot)"
//                  duplicate-logging artifact. FALLBACK: some seasons record
//                  made free throws with score_value=0 (confirmed bug, e.g.
//                  WNBA 2013-2019); a made free throw (type_text/text
//                  contains "Free Throw") is credited 1 point in that case,
//                  since it is unambiguously always worth exactly 1 point.
//   OREB / DREB -- type_text exactly "Offensive Rebound" / "Defensive
//                  Rebound", credited to athlete_id_1. REB = OREB + DREB.
//   ASSISTS     -- made FG (score_value 2 or 3) where text contains
//                  "assists", credited to athlete_id_2.
//   TURNOVERS   -- type_text contains "Turnover" (case-insensitive) or is
//                  exactly "Traveling", credited to athlete_id_1.
//   STEALS      -- PARTIAL confidence: turnover-type row, text contains
//                  "steals", credited to athlete_id_2. No dedicated
//                  structured field exists in the source.
//   BLOCKS      -- PARTIAL confidence: missed-shot row, text contains
//                  "blocks", credited to athlete_id_2. No dedicated
//                  structured field exists in the source.
//   3PM         -- scoring_play=1 AND score_value=3, credited to
//                  athlete_id_1. Fully structured.
//   3PA         -- shooting_play=1 AND (points_attempted=3 OR
//                  (points_attempted IS NULL AND text contains "three
//                  point")). The NULL-fallback branch is a known,
//                  quantified approximation for seasons where the source
//                  omits points_attempted (confirmed for WNBA 2023; NBA
//                  seasons are checked independently by the ingest
//                  script's own reconciliation report, never assumed).
//
// PERIOD BOUNDARIES: qtr 1-4 = regulation, >=5 = OT (kept as its own "OT"
// bucket, not folded into Q4). half 1/2 only; OT rows are tagged half=2,
// so H2 includes any overtime scoring -- a direct read of the source's
// own half field, never a derived (full - H1) approximation.

function emptyFullBucket() {
  return { points: 0, oreb: 0, dreb: 0, rebounds: 0, assists: 0, turnovers: 0, steals: 0, blocks: 0, tpm: 0, tpa: 0 };
}

function qKeyOf(qtr) { return qtr === 1 ? 'q1' : qtr === 2 ? 'q2' : qtr === 3 ? 'q3' : qtr === 4 ? 'q4' : qtr >= 5 ? 'ot' : null; }
function hKeyOf(half) { return half === 1 ? 'h1' : half === 2 ? 'h2' : null; }

// plays: array of raw pbp rows for ONE game, any order (sorted internally
// is not required since every derivation only reads the current row).
// Returns { "<athleteId>": { q1,q2,q3,q4,ot,h1,h2,full: <bucket> } }
function deriveFullPeriodStats(plays) {
  const players = {};
  const ensure = id => players[id] || (players[id] = {
    q1: emptyFullBucket(), q2: emptyFullBucket(), q3: emptyFullBucket(), q4: emptyFullBucket(),
    ot: emptyFullBucket(), h1: emptyFullBucket(), h2: emptyFullBucket(),
  });

  for (const p of plays) {
    if (p.type_text === 'No Shot (Default Shot)') continue; // documented duplicate-logging artifact
    const qk = qKeyOf(p.qtr), hk = hKeyOf(p.half);
    if (!qk && !hk) continue;
    const text = p.text || '';
    const typeText = p.type_text || '';

    const add = (athleteId, field, amt) => {
      if (!athleteId) return;
      const rec = ensure(athleteId);
      if (qk) rec[qk][field] += amt;
      if (hk) rec[hk][field] += amt;
    };

    // POINTS + 3PM
    // score_value is the primary signal, but some seasons record made free
    // throws with score_value=0 instead of 1 (a confirmed source data bug).
    // A made free throw is unambiguously worth exactly 1 point, so fall back
    // to 1 specifically for that case rather than trusting score_value blindly.
    if (p.scoring_play) {
      const isFreeThrow = /free throw/i.test(typeText) || /free throw/i.test(text);
      const pts = p.score_value ? p.score_value : (isFreeThrow ? 1 : 0);
      if (pts) {
        add(p.athlete_id_1, 'points', pts);
        if (pts === 3) add(p.athlete_id_1, 'tpm', 1);
      }
    }
    // 3PA
    const is3ptAttempt = p.shooting_play && (p.points_attempted === 3 || (p.points_attempted == null && /three point/i.test(text)));
    if (is3ptAttempt) add(p.athlete_id_1, 'tpa', 1);

    // OREB / DREB
    if (typeText === 'Offensive Rebound') { add(p.athlete_id_1, 'oreb', 1); add(p.athlete_id_1, 'rebounds', 1); }
    if (typeText === 'Defensive Rebound') { add(p.athlete_id_1, 'dreb', 1); add(p.athlete_id_1, 'rebounds', 1); }

    // ASSISTS
    if (p.scoring_play && (p.score_value === 2 || p.score_value === 3) && /assists/i.test(text) && p.athlete_id_2) {
      add(p.athlete_id_2, 'assists', 1);
    }

    // TURNOVERS
    if (/turnover/i.test(typeText) || typeText === 'Traveling') {
      add(p.athlete_id_1, 'turnovers', 1);
    }

    // STEALS (PARTIAL)
    if (/turnover/i.test(typeText) && /steals/i.test(text) && p.athlete_id_2) {
      add(p.athlete_id_2, 'steals', 1);
    }

    // BLOCKS (PARTIAL)
    if (p.shooting_play && !p.scoring_play && /blocks/i.test(text) && p.athlete_id_2) {
      add(p.athlete_id_2, 'blocks', 1);
    }
  }

  const sumBuckets = (...bs) => {
    const out = emptyFullBucket();
    for (const b of bs) for (const k of Object.keys(out)) out[k] += b[k];
    return out;
  };
  for (const id of Object.keys(players)) {
    players[id].full = sumBuckets(players[id].q1, players[id].q2, players[id].q3, players[id].q4, players[id].ot);
  }
  return players;
}

module.exports = { emptyFullBucket, deriveFullPeriodStats, qKeyOf, hKeyOf };
