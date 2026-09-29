// Read-only derivation helpers over wnba_pbp (historical WNBA play-by-play
// -- see scripts/ingest-hoopr-wnba-pbp.js). Phase 2I-E: this module derives
// historical period-level LABELS (1Q/1H/2H) for validation/reconciliation
// against wnba_player_box only. It is NOT a feature store, is NOT wired to
// any live ParlayAPI prop, and computes no probability/hit-rate/calibration
// of any kind -- those are explicitly out of scope for this phase.
//
// DERIVATION RULES (Phase 2I-E audit findings -- see the Phase 2I-E report
// for the full evidence; summarized here so the code and its own
// justification stay together):
//
//   POINTS      -- SUPPORTED, pure structured fields. Every scoring event
//                  has scoring_play=1 and a numeric score_value (1 = free
//                  throw, 2/3 = field goal, verified against
//                  points_attempted with zero mismatches in a full real
//                  season). Credited to athlete_id_1. No text parsing.
//                  ONE documented exception: type_text "No Shot (Default
//                  Shot)" is a rare (3 of 101,501 rows in the full 2024
//                  season, all three in the same one game) upstream
//                  duplicate-logging artifact -- each one sits a few
//                  seconds of game clock away from a second, properly-
//                  typed made-shot row for the SAME player (e.g. "Ezi
//                  Magbegor makes 1-foot shot" at 9:28 immediately next to
//                  "...makes 1-foot layup" at 9:25 for the same player).
//                  Counting both double-credits the basket. Verified via a
//                  real full-game reconciliation mismatch (4 players'
//                  derived points were exactly +2 over their box total
//                  until this was excluded). Excluded from every
//                  derivation, not just points.
//   OREB / DREB -- SUPPORTED, pure structured field. type_text is exactly
//                  "Offensive Rebound" or "Defensive Rebound" (verified:
//                  these are the ONLY two rebound-shaped type_text values
//                  in a full real season). Credited to athlete_id_1.
//   REB         -- SUPPORTED, trivial sum of OREB + DREB.
//   ASSISTS     -- SUPPORTED, structured field + one verified text check.
//                  Made-field-goal rows (scoring_play=1, score_value IN
//                  (2,3)) where `text` contains "assists" credit the
//                  assist to athlete_id_2. Verified against a full real
//                  season: 0 assisted rows missing athlete_id_2, 0 rows
//                  where the assister id equals the scorer id.
//   TURNOVERS   -- SUPPORTED, structured field match + one documented
//                  exception. type_text contains "Turnover" (case-
//                  insensitive substring -- some real values embed a
//                  literal newline, e.g. "Bad Pass\nTurnover", which a
//                  plain regex still matches correctly), OR type_text is
//                  exactly "Traveling" -- verified by a real full-game
//                  reconciliation mismatch (Phase 2I-E: two real players'
//                  derived turnover counts were off by exactly 1 each
//                  until this was added; "Traveling" is always a turnover
//                  under basketball rules but its type_text, unlike every
//                  other turnover-causing violation, does not contain the
//                  word "Turnover"). "Kicked Ball" was checked and
//                  deliberately excluded: it is a clock/possession
//                  violation, not itself a credited turnover stat, and
//                  adding it was not needed to resolve any mismatch.
//                  Credited to athlete_id_1.
//   STEALS      -- PARTIAL. There is no dedicated "Steal" type_text at all
//                  (verified: zero rows in a full real season). A steal is
//                  only recoverable by reading INSIDE a turnover-type row's
//                  free-text `text` field for "(X steals)" and crediting
//                  athlete_id_2 -- deterministic and zero-anomaly in the
//                  season checked, but dependent on free-text phrasing
//                  rather than its own structured field, so it is graded
//                  one notch below points/rebounds/assists/turnovers.
//   BLOCKS      -- PARTIAL, same reasoning as steals: no dedicated "Block"
//                  type_text exists; a block is only recoverable from a
//                  missed-shot row's `text` containing "blocks", crediting
//                  athlete_id_2.
//   FANTASY PTS -- NOT derived this phase. No explicit fantasy-points field
//                  exists in the source; per Phase 2I-E instructions, no
//                  scoring formula is invented here. If needed later, the
//                  required inputs are exactly the stats above (points,
//                  rebounds, assists, steals, blocks, turnovers).
//
// PERIOD BOUNDARIES (verified against a full real season):
//   qtr: 1,2,3,4 = regulation quarters, 5 = OT, 6 = 2OT.
//   half: 1 or 2 only. ALL overtime rows are tagged half=2 (verified: 629/
//   629 real OT rows in the season checked). So a "2H" derived from
//   half==2 INCLUDES any overtime scoring for that game. This is the
//   correct direct-classification answer per Phase 2I-E's instruction not
//   to derive 2H as (full game - 1H) when a direct half field exists --
//   but whether a live sportsbook's "2nd half" prop settles inclusive or
//   exclusive of OT is unverified and must be checked before any future
//   promotion; this module does not resolve that question, only flags it.

const db = require('./db');

function hasData() {
  try { return db.prepare(`SELECT 1 FROM wnba_pbp LIMIT 1`).get() != null; }
  catch (e) { return false; }
}

function gamePlays(gameId) {
  return db.prepare(`SELECT * FROM wnba_pbp WHERE game_id = ? ORDER BY sequence_number`).all(String(gameId));
}

// Empty per-period stat bucket.
function emptyBucket() {
  return { points: 0, oreb: 0, dreb: 0, rebounds: 0, assists: 0, turnovers: 0, steals: 0, blocks: 0 };
}

// Derive every tracked player's period-level stats for one game, from raw
// plays already in wnba_pbp. Returns:
//   { "<athleteId>": { q1, q2, q3, q4, ot, h1, h2, full } }
// where ot sums qtr>=5 (any/all overtime periods combined -- WNBA OT
// periods are 5 minutes each, same shape as regulation quarters, so they
// are kept as their own bucket rather than folded into "4Q").
function derivePeriodStats(gameId) {
  return derivePeriodStatsFromPlays(gamePlays(gameId));
}

// Pure, DB-agnostic core: given plays already fetched for ONE game (any
// source -- the legacy per-game gamePlays() query, or a bulk historicalStore
// fetch grouped in memory, see lib/wnbaPeriodGamelogs.js's Phase 4 bulk
// path), derives the same per-player period stats. Extracted so the bulk
// path can supply plays without an extra per-game query.
function derivePeriodStatsFromPlays(plays) {
  const players = {};
  const ensure = id => players[id] || (players[id] = { q1: emptyBucket(), q2: emptyBucket(), q3: emptyBucket(), q4: emptyBucket(), ot: emptyBucket(), h1: emptyBucket(), h2: emptyBucket() });

  const qKey = qtr => qtr === 1 ? 'q1' : qtr === 2 ? 'q2' : qtr === 3 ? 'q3' : qtr === 4 ? 'q4' : qtr >= 5 ? 'ot' : null;
  const hKey = half => half === 1 ? 'h1' : half === 2 ? 'h2' : null;

  for (const p of plays) {
    const qk = qKey(p.qtr);
    const hk = hKey(p.half);
    if (!qk && !hk) continue;
    // Rare upstream duplicate-logging artifact (see header comment) --
    // excluded from every derivation, not just points.
    if (p.type_text === 'No Shot (Default Shot)') continue;

    const text = p.text || '';
    const typeText = p.type_text || '';

    const add = (athleteId, field, amt) => {
      if (!athleteId) return;
      const rec = ensure(athleteId);
      if (qk) rec[qk][field] += amt;
      if (hk) rec[hk][field] += amt;
    };

    // POINTS -- structured, no text parsing.
    if (p.scoring_play && p.score_value) {
      add(p.athlete_id_1, 'points', p.score_value);
    }

    // OREB / DREB -- structured type_text match.
    if (typeText === 'Offensive Rebound') { add(p.athlete_id_1, 'oreb', 1); add(p.athlete_id_1, 'rebounds', 1); }
    if (typeText === 'Defensive Rebound') { add(p.athlete_id_1, 'dreb', 1); add(p.athlete_id_1, 'rebounds', 1); }

    // ASSISTS -- made FG (2 or 3 pt) + "assists" in text -> athlete_id_2.
    if (p.scoring_play && (p.score_value === 2 || p.score_value === 3) && /assists/i.test(text) && p.athlete_id_2) {
      add(p.athlete_id_2, 'assists', 1);
    }

    // TURNOVERS -- type_text contains "Turnover", or is "Traveling" (the
    // one verified real exception -- see header comment). -> athlete_id_1.
    if (/turnover/i.test(typeText) || typeText === 'Traveling') {
      add(p.athlete_id_1, 'turnovers', 1);
    }

    // STEALS (PARTIAL) -- turnover-type row, text contains "steals" -> athlete_id_2.
    if (/turnover/i.test(typeText) && /steals/i.test(text) && p.athlete_id_2) {
      add(p.athlete_id_2, 'steals', 1);
    }

    // BLOCKS (PARTIAL) -- missed shooting play, text contains "blocks" -> athlete_id_2.
    if (p.shooting_play && !p.scoring_play && /blocks/i.test(text) && p.athlete_id_2) {
      add(p.athlete_id_2, 'blocks', 1);
    }
  }

  const sumBuckets = (...bs) => {
    const out = emptyBucket();
    for (const b of bs) for (const k of Object.keys(out)) out[k] += b[k];
    return out;
  };
  for (const id of Object.keys(players)) {
    players[id].full = sumBuckets(players[id].q1, players[id].q2, players[id].q3, players[id].q4, players[id].ot);
  }
  return players;
}

// Phase 2I-P -- additive only, does not touch derivePeriodStats above (the
// live 1H-assists enrichment path keeps using that exact function
// unchanged). Delegates to the same shared lib/periodStatsCore.js used by
// lib/nbaPbpDb.js, adding tpm/tpa to the bucket shape (3PM/3PA derivation,
// Phase 2I-G-validated) for the historical-data-layer build only.
const { deriveFullPeriodStats } = require('./periodStatsCore');
function deriveFullStats(gameId) {
  return deriveFullPeriodStats(gamePlays(gameId));
}

module.exports = { hasData, gamePlays, derivePeriodStats, derivePeriodStatsFromPlays, emptyBucket, deriveFullStats };
