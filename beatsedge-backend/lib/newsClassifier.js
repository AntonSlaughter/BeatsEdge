// News Intelligence — Phase 2C: source-grounded news classification.
//
// CLASSIFIES WHAT THE SOURCE SAYS. Never what we think will happen.
//
// A small, deterministic, rule-based engine (no LLM, no paid service, no
// new credential, no new provider) that reads the ALREADY-normalized
// title/summary text of an article Phase 1 already fetched and Phase 2A
// already linked to a player, and looks for EXPLICIT source language
// matching a fixed taxonomy. It never scans for player names itself
// (Phase 2A remains the only identity resolver -- see Step 11 of the
// phase spec) and never touches title/summary/url/source/publishedAt/
// playerId/playerName on the article it's given (Step 15 -- purely
// additive, read-only).
//
// Architecture (Step 16): computed at READ TIME, not persisted. The
// classifier only needs fields the API response already carries (title,
// summary, playerId), it's cheap (a few dozen regex tests per article),
// and read-time computation means a future rule change or bug fix applies
// retroactively to already-ingested articles for free, with zero migration
// and zero risk of serving a stale classification computed by an older
// rule set. Storing this in news_articles would require a schema change
// AND a backfill job for no real benefit given the cost is negligible
// (measured: <1ms for a 500-article page, see the live-validation report).
//
// One player per article (Step 11's constraint): Phase 2A's own resolver
// (lib/newsPlayerIdentity.js's resolvePlayerForArticle) attaches AT MOST
// ONE playerId to a given article row, chosen from ESPN's own single
// tagged athlete category or a single best name/team match. This module
// never second-guesses that -- an article with playerId === null gets
// ZERO classifications (Step 11: "do not attach the classification to a
// player"), never a best-effort guess at who the subject might be.
// Consequently, Step 9's two-player example ("With Player Y out, Player X
// is expected to take on a larger role") can only ever classify the ONE
// player Phase 2A actually resolved for that row (typically Player X, if
// ESPN tagged the article to X) -- Player Y's own AVAILABILITY/OUT fact,
// mentioned in the same sentence, is intentionally left unclassified
// rather than guessed at from free text, which would require exactly the
// new fuzzy player matcher Step 11 forbids. See the final report's
// "Multiple-classification handling" section.

const strOf = (v) => (v == null ? '' : String(v));

// ── Evidence extraction ────────────────────────────────────────────────
// `evidence` is always the literal matched substring from the article's
// own title/summary (never hand-written, never invented), trimmed to a
// short, bounded length. Regexes are deliberately written so their own
// full match IS already a short, readable phrase.
function clip(s, max = 100) {
  const t = String(s || '').trim();
  return t.length > max ? t.slice(0, max - 1).trim() + '…' : t;
}

// A rule: { category, subcategory, direction, regex, statusFor(match) }.
// `regex` runs case-insensitively directly against the article's own
// original-case text, so match[0] is a verbatim, correctly-cased
// substring usable as evidence with no extra bookkeeping.

// ── AVAILABILITY ──────────────────────────────────────────────────────
// AVAILABLE is checked before the bare status words on purpose: a
// sentence like "no longer questionable" or "off the injury report"
// contains the literal word "questionable" but reports the OPPOSITE
// status. Checking the compound, specific AVAILABLE phrases first (and
// short-circuiting the category once one status is found) avoids that
// false positive without any hand-authored negation logic.
const AVAILABILITY_RULES = [
  { status: 'AVAILABLE', direction: 'POSITIVE', re: /\b(?:is (?:now )?(?:listed as )?available|listed as available|cleared to play|off (?:the |this week'?s )?injury report|removed from (?:the )?injury report|no longer (?:questionable|doubtful|out))\b/i },
  { status: 'OUT', direction: 'NEGATIVE', re: /\b(?:ruled out|has been ruled out|is out (?:for|with|tonight|today)|will not play|won'?t play|listed as out)\b/i },
  { status: 'DOUBTFUL', direction: 'NEGATIVE', re: /\bdoubtful\b/i },
  { status: 'QUESTIONABLE', direction: 'NEGATIVE', re: /\bquestionable\b/i },
  { status: 'PROBABLE', direction: 'POSITIVE', re: /\bprobable\b/i },
  { status: 'LIMITED', direction: 'NEGATIVE', re: /\b(?:was |is )?limited (?:in|at) practice\b/i }
];
function classifyAvailability(text) {
  for (const rule of AVAILABILITY_RULES) {
    const m = text.match(rule.re);
    if (m) return { category: 'AVAILABILITY', subcategory: null, status: rule.status, direction: rule.direction, evidence: clip(m[0]) };
  }
  return null;
}

// ── STARTING_STATUS ───────────────────────────────────────────────────
const STARTING_RULES = [
  { status: 'STARTING', direction: 'POSITIVE', re: /\b(?:is|will|expected to|listed as|named)\s+(?:the\s+)?start(?:er|ing)\b|\bwill start\b|\bexpected to start\b|\bnamed (?:the )?starter\b|\bgets? the start\b|\bin the starting lineup\b|\bmakes? (?:his|her) (?:first|season) start\b/i },
  { status: 'NOT_STARTING', direction: 'NEGATIVE', re: /\bwill come off the bench\b|\bmoved to the bench\b|\bbenched\b|\bcomes? off the bench\b|\bout of the (?:starting )?lineup\b|\blate scratch\b|\bscratched\b/i }
];
function classifyStartingStatus(text) {
  for (const rule of STARTING_RULES) {
    const m = text.match(rule.re);
    if (m) return { category: 'STARTING_STATUS', subcategory: null, status: rule.status, direction: rule.direction, evidence: clip(m[0]) };
  }
  return null;
}

// ── OPPORTUNITY ────────────────────────────────────────────────────────
// Reserved for an EXPLICIT causal vacancy ("with ... out", "after/
// following a trade/injury/release/waiver/surgery") combined with
// EXPLICIT increased-role language, exactly per Step 9. Checked before
// ROLE_CHANGE so the same sentence isn't double-classified as both.
const OPPORTUNITY_CAUSE_RE = /\bwith\b[^.]{0,60}\bout\b|\b(?:after|following)\b[^.]{0,60}\b(?:trade|injury|release[d]?|waiver|surgery)\b/i;
const OPPORTUNITY_EFFECT_RE = /\b(?:is |will )?(?:expected to|is set to|is poised to)?\s*(?:take on|see|get|have)\s*(?:a |an )?(?:larger|bigger|increased|expanded)\s*role\b|\bmore (?:touches|opportunities|minutes|playing time)\b|\b(?:opportunity|chance) to (?:start|play more)\b/i;
function classifyOpportunity(text) {
  if (OPPORTUNITY_CAUSE_RE.test(text)) {
    const m = text.match(OPPORTUNITY_EFFECT_RE);
    if (m) return { category: 'OPPORTUNITY', subcategory: null, status: 'INCREASED_OPPORTUNITY', direction: 'POSITIVE', evidence: clip(m[0]) };
  }
  return null;
}

// ── ROLE_CHANGE ────────────────────────────────────────────────────────
const ROLE_RULES = [
  { status: 'INCREASED_ROLE', direction: 'POSITIVE', re: /\b(?:increased|expanded|bigger|larger) role\b|\brole (?:is expected to|will) (?:grow|expand|increase)\b|\bwill see (?:an )?(?:increased|expanded|bigger|larger) role\b/i },
  { status: 'REDUCED_ROLE', direction: 'NEGATIVE', re: /\b(?:reduced|diminished|smaller|shrinking) role\b|\brole (?:has been|is) (?:reduced|diminished|cut)\b|\bfewer (?:minutes|touches|reps|opportunities)\b/i }
];
function classifyRoleChange(text) {
  for (const rule of ROLE_RULES) {
    const m = text.match(rule.re);
    if (m) return { category: 'ROLE_CHANGE', subcategory: null, status: rule.status, direction: rule.direction, evidence: clip(m[0]) };
  }
  return null;
}

// ── MINUTES_RESTRICTION ───────────────────────────────────────────────
// subcategory carries the sport-specific flavor (Step 2: represent
// sport nuance via structured attributes, not separate categories).
const MINUTES_RULES = [
  { subcategory: 'PITCH_COUNT', re: /\bpitch[- ]count restriction\b|\bon a pitch count\b/i },
  { subcategory: 'SNAP_COUNT', re: /\bsnap[- ]count restriction\b|\bon a snap count\b/i },
  { subcategory: 'MINUTES_LIMIT', re: /\bminutes restriction\b|\bon a minutes (?:limit|restriction)\b|\blimited to (?:about )?\d+ minutes\b/i },
  { subcategory: 'WORKLOAD_MANAGEMENT', re: /\bworkload (?:restriction|management|managed)\b/i }
];
function classifyMinutesRestriction(text) {
  for (const rule of MINUTES_RULES) {
    const m = text.match(rule.re);
    if (m) return { category: 'MINUTES_RESTRICTION', subcategory: rule.subcategory, status: 'RESTRICTED', direction: 'NEGATIVE', evidence: clip(m[0]) };
  }
  return null;
}

// ── INJURY_STATUS ─────────────────────────────────────────────────────
// Fallback only -- an explicit injury EVENT reported without one of the
// formal AVAILABILITY designation words (caller only invokes this when
// classifyAvailability() found nothing, so "questionable with a hamstring
// strain" is reported as AVAILABILITY/QUESTIONABLE only, not doubled up).
// Never a diagnosis, never a severity estimate -- just "an injury was
// reported," which is what the source actually said.
const INJURY_EVENT_RE = /\b(?:suffered|sustained) an? [\w\s-]{0,25}(?:injury|strain|sprain|soreness)\b|\bleft (?:the |tonight'?s |last night'?s )?game with an? [\w\s-]{0,25}(?:injury|issue)\b|\bexited (?:the game )?with an? [\w\s-]{0,25}(?:injury|issue)\b|\bunderwent (?:an? )?(?:MRI|surgery)\b/i;
function classifyInjuryStatus(text) {
  const m = text.match(INJURY_EVENT_RE);
  if (m) return { category: 'INJURY_STATUS', subcategory: null, status: 'INJURED', direction: 'NEGATIVE', evidence: clip(m[0]) };
  return null;
}

// ── RETURN ─────────────────────────────────────────────────────────────
// "Returned to practice" is RETURNING only -- never auto-upgraded to
// STARTING or full-minutes/no-restriction (Step 5's explicit example).
const RETURN_RE = /\breturn(?:s|ed|ing)? to (?:practice|the team|action)\b|\bback (?:at|in) practice\b|\bmakes? (?:his|her) return\b|\breturns? from injury\b/i;
function classifyReturn(text) {
  const m = text.match(RETURN_RE);
  if (m) return { category: 'RETURN', subcategory: null, status: 'RETURNING', direction: 'POSITIVE', evidence: clip(m[0]) };
  return null;
}

// ── TRADE_TRANSACTION ─────────────────────────────────────────────────
// direction is null -- a trade/signing is a real event, but whether it's
// good or bad for THIS player's own availability/opportunity isn't
// something the bare transaction language itself supports (would require
// inferring the new team's depth chart, which is exactly the kind of
// speculation Step 5 forbids).
//
// Unlike AVAILABILITY/STARTING_STATUS (mutually-exclusive CURRENT
// states -- a player can't be both OUT and QUESTIONABLE right now), TRADE
// and SIGNED describe independent real EVENTS a single article can
// legitimately report together (e.g. "signed to an extension... after
// being acquired from [team] earlier this month" -- both actually
// happened). So this rule, unlike the single-winner groups above, returns
// every distinct status it finds rather than only the first.
const TRADE_RULES = [
  { status: 'TRADE', re: /\btraded? to\b|\bacquired? (?:from|via trade|in a trade)\b|\bin a trade (?:with|involving)\b|\btrade (?:sends|sending)\b/i },
  { status: 'SIGNED', re: /\bsign(?:s|ed)?\b[^.]{0,60}\b(?:contract|extension|deal)\b|\bagrees? to (?:a )?(?:contract|deal|extension)\b|\bsigned (?:with|by)\b/i }
];
function classifyTradeTransaction(text) {
  const out = [];
  for (const rule of TRADE_RULES) {
    const m = text.match(rule.re);
    if (m) out.push({ category: 'TRADE_TRANSACTION', subcategory: null, status: rule.status, direction: null, evidence: clip(m[0]) });
  }
  return out;
}

// ── ROSTER_MOVE ────────────────────────────────────────────────────────
const ROSTER_RULES = [
  { status: 'PLACED_ON_IL', direction: 'NEGATIVE', re: /\bplac(?:ed|es|ing)\b[^.]{0,40}\bon (?:the )?(?:\d+-day )?IL\b|\bplac(?:ed|es|ing)\b[^.]{0,40}\bon (?:the )?injured list\b/i },
  { status: 'PLACED_ON_IR', direction: 'NEGATIVE', re: /\bplac(?:ed|es|ing)\b[^.]{0,40}\bon (?:the )?IR\b|\bplac(?:ed|es|ing)\b[^.]{0,40}\bon (?:the )?injured reserve\b/i },
  { status: 'RETURNED_FROM_LIST', direction: 'POSITIVE', re: /\breturned from (?:the )?(?:IL|IR|injured list|injured reserve)\b|\bactivated from (?:the )?(?:IL|IR)\b/i },
  { status: 'ACTIVATED', direction: 'POSITIVE', re: /\bactivated (?:off|from)\b/i },
  { status: 'CALLED_UP', direction: 'POSITIVE', re: /\bcalled up\b|\brecalled\b/i },
  { status: 'OPTIONED', direction: 'NEGATIVE', re: /\boptioned (?:to|down)\b/i },
  { status: 'DESIGNATED', direction: 'NEGATIVE', re: /\bdesignated for assignment\b|\bDFA'?d\b/i },
  { status: 'WAIVED', direction: 'NEGATIVE', re: /\bwaived\b|\bplaced on waivers\b/i },
  { status: 'RELEASED', direction: 'NEGATIVE', re: /\breleased\b|\bhas been released\b/i }
];
function classifyRosterMove(text) {
  for (const rule of ROSTER_RULES) {
    const m = text.match(rule.re);
    if (m) return { category: 'ROSTER_MOVE', subcategory: null, status: rule.status, direction: rule.direction, evidence: clip(m[0]) };
  }
  return null;
}

// ── COACHING_ROTATION ─────────────────────────────────────────────────
const ROTATION_RULES = [
  { status: 'ROTATION_MOVED_UP', direction: 'POSITIVE', re: /\bmoved up (?:in|to) the rotation\b/i },
  { status: 'ROTATION_MOVED_DOWN', direction: 'NEGATIVE', re: /\bmoved down (?:in|to) the rotation\b|\bpushed back\b[^.]{0,20}\bstart\b|\bskipped (?:his|her) (?:next )?start\b/i },
  { status: 'ROTATION_CHANGE', direction: null, re: /\brotation (?:spot|order) (?:change|shuffle)\b/i }
];
function classifyCoachingRotation(text) {
  for (const rule of ROTATION_RULES) {
    const m = text.match(rule.re);
    if (m) return { category: 'COACHING_ROTATION', subcategory: null, status: rule.status, direction: rule.direction, evidence: clip(m[0]) };
  }
  return null;
}

// ── GAME_STATUS ────────────────────────────────────────────────────────
const GAME_STATUS_RE = /\bgame (?:has been |is )?(?:postponed|suspended|rescheduled|canceled|cancelled)\b|\bpostponed (?:until|to)\b/i;
function classifyGameStatus(text) {
  const m = text.match(GAME_STATUS_RE);
  if (m) return { category: 'GAME_STATUS', subcategory: null, status: 'POSTPONED_OR_SUSPENDED', direction: null, evidence: clip(m[0]) };
  return null;
}

// ── WEATHER ────────────────────────────────────────────────────────────
// Checked before GAME_STATUS's generic postponement language so a
// weather-caused postponement is labeled WEATHER, not the more generic
// GAME_STATUS.
const WEATHER_RE = /\b(?:rain|wind|snow|storm|lightning)\b[^.]{0,40}\b(?:delay|postpone|suspend)\w*\b|\b(?:delay|postpone|suspend)\w*\b[^.]{0,40}\b(?:rain|wind|snow|storm|weather)\b/i;
function classifyWeather(text) {
  const m = text.match(WEATHER_RE);
  if (m) return { category: 'WEATHER', subcategory: null, status: 'WEATHER_IMPACT', direction: null, evidence: clip(m[0]) };
  return null;
}

// ── RECAP ──────────────────────────────────────────────────────────────
// Purely informational -- status/direction stay null. A box-score recap
// ("Player X had 30 points last night") must never be read as an
// availability/role signal; RECAP exists so it gets an honest label
// instead of silently falling into ROLE_CHANGE or similar.
const RECAP_RE = /\b\d{1,3}-\d{1,3}\b|\b(?:beat|beats|defeat[s]?|holds? off|rallies? (?:past|to)|blanks?|edges?|tops?|routs?)\b/i;
function classifyRecap(text) {
  const m = text.match(RECAP_RE);
  if (m) return { category: 'RECAP', subcategory: null, status: null, direction: null, evidence: clip(m[0]) };
  return null;
}

// ── Orchestration ─────────────────────────────────────────────────────
// Order encodes precedence for cases where two rule groups could describe
// the same underlying fact (documented per-block above): OPPORTUNITY
// before ROLE_CHANGE, WEATHER before GAME_STATUS, AVAILABILITY before the
// INJURY_STATUS fallback.
function runRules(text) {
  const out = [];
  const push = (r) => { if (r) out.push(r); };

  const availability = classifyAvailability(text);
  push(availability);
  push(classifyStartingStatus(text));

  const opportunity = classifyOpportunity(text);
  push(opportunity);
  if (!opportunity) push(classifyRoleChange(text));

  push(classifyMinutesRestriction(text));
  if (!availability) push(classifyInjuryStatus(text));
  push(classifyReturn(text));
  classifyTradeTransaction(text).forEach(push);
  push(classifyRosterMove(text));
  push(classifyCoachingRotation(text));

  const weather = classifyWeather(text);
  push(weather);
  if (!weather) push(classifyGameStatus(text));

  push(classifyRecap(text));

  // De-dupe identical category+status pairs (Step 10) -- structurally
  // each classify* function above contributes at most one entry per
  // category already, but this keeps the guarantee explicit and holds
  // even if a future rule group is added without that property.
  const seen = new Set();
  return out.filter(c => {
    const key = `${c.category}:${c.status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// classifyArticle(article) -> { classifications: [...] }
//
// `article` is the already-normalized, already-identity-resolved shape
// lib/newsDb.js's toApiShape() (or the equivalent already-fetched
// frontend object) produces -- must carry at least { title, summary,
// playerId }. Never mutates its input (Step 15).
function classifyArticle(article) {
  if (!article || !article.playerId) {
    // Step 11: no safely-resolved player -- no classification is ever
    // attached, no matter how explicit the text looks. The article still
    // displays normally in the general News feed; it simply carries no
    // structured classification.
    return { classifications: [] };
  }
  const text = `${strOf(article.title)} ${strOf(article.summary)}`.trim();
  const classifications = runRules(text).map(c => ({ ...c, classificationSource: 'newsClassifier:rule-based' }));
  if (!classifications.length) {
    // Step 4/20: the source doesn't support any specific structured claim
    // -- say so honestly rather than guessing.
    classifications.push({ category: 'GENERAL_NEWS', subcategory: null, status: null, direction: null, evidence: null, classificationSource: 'newsClassifier:rule-based' });
  }
  return { classifications };
}

const TAXONOMY = [
  'AVAILABILITY', 'STARTING_STATUS', 'ROLE_CHANGE', 'MINUTES_RESTRICTION', 'INJURY_STATUS',
  'TRADE_TRANSACTION', 'ROSTER_MOVE', 'RETURN', 'COACHING_ROTATION', 'OPPORTUNITY',
  'GAME_STATUS', 'WEATHER', 'RECAP', 'GENERAL_NEWS', 'UNCLASSIFIED'
];

module.exports = { classifyArticle, TAXONOMY };
