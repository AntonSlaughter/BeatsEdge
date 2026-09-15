// Phase 10D -- PropLine provider-#2 normalization/policy layer.
//
// NOT WIRED IN. Nothing in server.js/routes/api.js/BeatsEdge.html calls
// this module. It exists as a proven, tested DESIGN for a future
// integration phase's use -- built and validated with real PropLine
// responses this phase, per the phase's own instruction to "produce a
// proposed policy" (not to activate it). No frontend key, no live call,
// no provider-routing change; purely pure functions over data already in
// hand.
//
// SPORT-BY-SPORT player_id FINDING (verified live this phase, real
// examples): PropLine's real player_id is a genuinely different space
// per sport --
//   MLB:  "mlb:641680"  === BeatsEdge's own MLB Stats API person.id
//         (confirmed: person 641680 really is Jonah Heim, the same
//         player PropLine attached that id to).
//   NFL:  "espn:5123663" === BeatsEdge's own ESPN athlete id directly
//         (confirmed: ESPN athlete 5123663 really is Isaac TeSlaa).
//   CFB:  "espn:5208095" === same ESPN athlete-id space (confirmed).
//   NBA:  "nba:1628369"  -- NBA.com personId, NOT BeatsEdge's own ESPN
//         athlete id for the same real player (Jayson Tatum's real ESPN
//         id is 3136195 -- confirmed live, a completely different
//         number). Requires the SAME name+team fallback Phase 10A
//         already built and proved safe for ParlayAPI (which has no
//         player id at all) -- not a new trust level, parity with today.
//   WNBA: "wnba:1628277" -- same NBA.com-family personId convention,
//         NOT BeatsEdge's own ESPN id (confirmed: Allisha Gray's real
//         ESPN id is 3058901). Same name+team fallback as NBA.

const EXACT_ID_SPORTS = new Set(['mlb', 'nfl', 'ncaaf']);

// Parse a real PropLine player_id ("sportPrefix:rawId") into its parts.
function parsePropLinePlayerId(playerId) {
  if (!playerId || typeof playerId !== 'string' || playerId.indexOf(':') === -1) return null;
  const idx = playerId.indexOf(':');
  return { prefix: playerId.slice(0, idx), rawId: playerId.slice(idx + 1) };
}

// Turn a Phase-10A-style resolver result ({chosen, reason, candidates})
// into one of the required classifications. Checked BEFORE assuming
// unresolved just means "give up" -- a collision or team mismatch is a
// distinct, more specific outcome than a bare UNRESOLVED, and callers
// need to be able to tell them apart (Section 5's own required list).
function classifyResolverResult(res) {
  if (!res) return { method: 'UNRESOLVED', beatsEdgeId: null };
  if (!res.chosen) {
    if (res.reason === 'collision') return { method: 'COLLISION', beatsEdgeId: null };
    if (res.reason === 'teamMismatch') return { method: 'TEAM_MISMATCH', beatsEdgeId: null };
    return { method: 'UNRESOLVED', beatsEdgeId: null };
  }
  const method = (Array.isArray(res.candidates) && res.candidates.length > 1) ? 'NAME_TEAM' : 'UNIQUE_NAME';
  return { method, beatsEdgeId: res.chosen.id };
}

// Classify how a PropLine row's player_id relates to BeatsEdge's own
// roster identity for that sport. Never guesses -- returns exactly one
// of the required classifications. `rosterLookup(rawId)` is a caller-
// supplied function: for an EXACT_ID sport, look up a BeatsEdge roster
// record by the SAME id space (MLB person.id / ESPN athlete id) directly;
// may return null if that id isn't on today's roster (a real, honest
// "not found" case, not an error).
function classifyPlayerIdentity(sport, propLineRow, rosterLookup, nameTeamResolve) {
  const parsed = parsePropLinePlayerId(propLineRow.player_id);
  if (!parsed) {
    // No usable id at all -- fall back to the same name+team resolution
    // Phase 10A already proved safe (never guesses; fails closed).
    return classifyResolverResult(nameTeamResolve ? nameTeamResolve(propLineRow) : null);
  }
  const sportKey = (sport || '').toLowerCase();
  const isExactSport = EXACT_ID_SPORTS.has(sportKey) && (parsed.prefix === sportKey || parsed.prefix === 'espn');
  if (isExactSport) {
    const hit = rosterLookup ? rosterLookup(parsed.rawId) : null;
    if (hit) return { method: 'EXACT_ID', beatsEdgeId: hit.id };
    // A real, valid id that just isn't on today's live roster slice --
    // honest UNRESOLVED, never a guess.
    return { method: 'UNRESOLVED', beatsEdgeId: null };
  }
  // NBA/WNBA (or anything else using a non-ESPN, non-league-matching id
  // space) -- the id exists but is NOT BeatsEdge's own id space, so it
  // cannot be used directly. Fall back to the same proven name+team
  // resolver, same as if no id existed at all.
  const classified = classifyResolverResult(nameTeamResolve ? nameTeamResolve(propLineRow) : null);
  return classified.beatsEdgeId ? { ...classified, propLineIdRequiresMapping: true } : classified;
}

// Normalize one raw PropLine outcome (real field names, verified live
// this phase) into BeatsEdge's own prop-object shape. Never invents a
// value: any field PropLine doesn't supply stays null, never
// backfilled from a projection or another source.
function normalizePropLineOutcome({ sport, eventId, homeTeam, awayTeam, bookmakerKey, marketKey, outcome, marketLastUpdate, eventLastUpdate }) {
  return {
    provider: 'propline',
    source: bookmakerKey,
    player: outcome.description || null,
    playerId: outcome.player_id || null,
    sport,
    eventId,
    homeTeam, awayTeam,
    market: marketKey,
    line: outcome.point != null ? outcome.point : null,
    side: outcome.name || null,
    odds: outcome.price != null ? outcome.price : null,
    timestamp: outcome.last_change_at || outcome.last_seen_at || marketLastUpdate || eventLastUpdate || null,
    outcomeId: outcome.outcome_id || outcome.book_outcome_id || null, // real fields; commonly null, never fabricated
    // modelProjection / modelEdge are DELIBERATELY not fields on this
    // object -- normalization only ever produces a SOURCE line. Any
    // caller that wants a projection/edge computes and attaches it
    // separately, never here.
  };
}

// Canonical dedup key -- sport+event+player+market+provider+source, per
// Section 10's explicit requirement that the key must not collapse two
// real, distinct lines just because player/stat names match. Two
// providers quoting the SAME book (e.g. ParlayAPI PrizePicks 20.5 and
// PropLine PrizePicks 20.5 for the same real player/event/market) DO
// share this key -- see resolveDuplicate() for what happens next; this
// function only decides "these two rows are claiming to describe the
// same real market," never "these two rows have the same value."
function dedupeKey(prop) {
  return [prop.sport, prop.eventId, prop.playerId || prop.player, prop.market, prop.source].join('|');
}

// Deterministic priority resolution for two rows that share a dedupeKey
// (Section 11/13). Never averages. Never lets a stale response overwrite
// a fresher one merely because it arrived later -- compares real
// timestamps, not arrival order. If timestamps are missing or equal,
// falls back to a fixed provider priority (ParlayAPI primary, per
// Section 11's proposed policy: PropLine is a secondary/gap-filler, not
// a co-equal source) -- but this is a PROPOSED default, not something
// this module enforces silently; the priority list is a parameter so a
// future integration can override it explicitly rather than inherit an
// undocumented default.
function resolveDuplicate(existing, incoming, providerPriority = ['parlayapi', 'propline']) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const exT = Date.parse(existing.timestamp || '') || 0;
  const inT = Date.parse(incoming.timestamp || '') || 0;
  if (exT && inT && exT !== inT) return inT > exT ? incoming : existing;
  const exRank = providerPriority.indexOf(existing.provider);
  const inRank = providerPriority.indexOf(incoming.provider);
  if (exRank === -1 && inRank === -1) return existing; // unknown providers -- never arrival-order guess, keep existing
  if (exRank === -1) return incoming;
  if (inRank === -1) return existing;
  return inRank < exRank ? incoming : existing;
}

// Merge a batch of normalized props from potentially multiple providers
// into one map, applying resolveDuplicate() only within the SAME
// dedupeKey -- rows with different keys (different books, different
// lines, different providers quoting DIFFERENT source data) are never
// touched, always kept distinct (Section 10's "without data loss").
function mergeProps(propsList, providerPriority) {
  const byKey = {};
  propsList.forEach(p => {
    const k = dedupeKey(p);
    byKey[k] = resolveDuplicate(byKey[k], p, providerPriority);
  });
  return Object.values(byKey);
}

module.exports = { parsePropLinePlayerId, classifyPlayerIdentity, normalizePropLineOutcome, dedupeKey, resolveDuplicate, mergeProps, EXACT_ID_SPORTS };
