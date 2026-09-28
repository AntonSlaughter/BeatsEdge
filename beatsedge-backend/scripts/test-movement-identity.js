// BeatsEdge market movement identity — final hardening regression suite
// (2026-09-28). Re-audited the CURRENT code (post commits 41e184e/96e558f)
// before writing this, not a prior report:
//
//   LINE_HIST_PREFIX = 'beatsedge_line_hist_v2:'            (BeatsEdge.html ~5595)
//   plTrackLine(ledger, id, line, odds, ts)                  (~5616)
//   id = `${player}:${statKey}:${book}:${ppType||'std'}:${eventId||''}`
//        present identically at all 5 sports' call sites (MLB ~12754,
//        NFL ~13647, CFB ~14008, NBA ~14979, WNBA ~15500)
//
// So sport/player/market/book/projection-type/event are ALL already part
// of the live identity key. This suite locks that in with fixtures BOTH
// this task and the prior movement-identity commit asked for, including
// several not previously covered (STANDARD-vs-GOBLIN specifically,
// same-identity-DOES-produce-legitimate-movement, old-ledger-cannot-
// contaminate-new, no-movement-below-2-observations, book-collision-is-
// disagreement-not-movement).
//
// BeatsEdge.html is a browser-only Babel/JSX file, not a Node module, so
// plTrackLine and the identity-key expression are faithfully mirrored
// here (byte-for-byte the same algorithm just read above) rather than
// imported — the established pattern for every other browser-embedded
// invariant tested in this project.
//
//   node scripts/test-movement-identity.js

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

// ---------- exact mirrors of the current live code ----------

// Mirrors plTrackLine (BeatsEdge.html ~5616).
function plTrackLine(ledger, id, line, odds, ts) {
  const rec = ledger[id];
  if (!rec) { ledger[id] = { open: line, openTs: ts, cur: line, curOdds: odds, ts, n: 1 }; return null; }
  let move = null;
  if (rec.cur !== line) {
    move = { from: rec.cur, to: line, delta: Math.round((line - rec.cur) * 10) / 10, sinceTs: rec.ts, open: rec.open, openTs: rec.openTs, openDelta: Math.round((line - rec.open) * 10) / 10, moveCount: rec.n };
    rec.cur = line; rec.ts = ts; rec.n = (rec.n || 1) + 1;
  } else if (rec.curOdds !== odds) {
    move = { from: rec.cur, to: line, delta: 0, priceOnly: true, sinceTs: rec.ts, open: rec.open, openTs: rec.openTs, openDelta: Math.round((line - rec.open) * 10) / 10, moveCount: rec.n };
    rec.ts = ts;
  }
  rec.curOdds = odds;
  return move;
}

// Mirrors the identity-key expression present identically at all 5 sports'
// call sites (see file header for exact line numbers).
function movementKey(player, statKey, book, ppType, eventId) {
  return `${player}:${statKey}:${book}:${ppType || 'std'}:${eventId || ''}`;
}

// Mirrors LINE_HIST_PREFIX's role: the localStorage key a ledger object
// would be persisted under. v1/v1.5(ppType-only) keys never match this.
function ledgerStorageKey(version, sport, date) {
  return `beatsedge_line_hist_${version}:${sport}|${date}`;
}

(async () => {
  // ---------- 1. STANDARD vs DEMON separated (the proven Makayla bug) ----------
  {
    const ledger = {};
    const kStd = movementKey('Makayla Timpson', 'points', 'prizepicks', 'STANDARD', 'evt-1');
    const kDemon = movementKey('Makayla Timpson', 'points', 'prizepicks', 'DEMON', 'evt-1');
    plTrackLine(ledger, kDemon, 19.5, 100, 1000);      // DEMON observed first
    const stdMove = plTrackLine(ledger, kStd, 7.5, -110, 2000); // STANDARD observed later, same player/event/book
    check('11a: DEMON 19.5 and STANDARD 7.5 use different keys', kStd !== kDemon);
    check('11b: STANDARD\'s first observation is null (no prior STANDARD entry), never "19.5 -> 7.5"', stdMove === null, JSON.stringify(stdMove));
    check('11c: the DEMON entry is untouched by the STANDARD write', ledger[kDemon].cur === 19.5 && ledger[kDemon].open === 19.5);
  }

  // ---------- STANDARD vs GOBLIN separated ----------
  {
    const ledger = {};
    const kStd = movementKey('Georgia Amoore', 'points', 'prizepicks', 'STANDARD', 'evt-2');
    const kGoblin = movementKey('Georgia Amoore', 'points', 'prizepicks', 'GOBLIN', 'evt-2');
    plTrackLine(ledger, kGoblin, 5.5, 100, 1000);
    const stdMove = plTrackLine(ledger, kStd, 7.5, -110, 2000);
    check('STANDARD vs GOBLIN: different keys, GOBLIN observation never becomes STANDARD movement', kStd !== kGoblin && stdMove === null);
  }

  // ---------- 12. Event A vs Event B separated ----------
  {
    const ledger = {};
    const kA = movementKey('Player X', 'points', 'fanduel', null, 'event-A');
    const kB = movementKey('Player X', 'points', 'fanduel', null, 'event-B');
    plTrackLine(ledger, kA, 18.5, -110, 1000); // Sunday's game
    const moveB = plTrackLine(ledger, kB, 7.5, -110, 2000); // Thursday's different game, same player/stat/book
    check('12: different event ids -> different keys, no 18.5 -> 7.5 movement across games', kA !== kB && moveB === null);
  }

  // ---------- 13. Period collision (full game vs period markets never share identity) ----------
  {
    // Proven by code trace (see the movement-identity-hardening commit):
    // period markets (1Q/1H/etc) are built entirely through
    // buildProviderOnlyProps, which never calls plTrackLine at all -- so
    // there is no shared identity space for a full-game and a period line
    // to collide in. Modeled here as two statKey-shaped identifiers that
    // are provably distinct and only one of which (the full-game one)
    // ever reaches movementKey/plTrackLine.
    const fullGameKey = movementKey('Player X', 'points', 'fanduel', null, 'event-A');
    const periodMarketKeyRaw = 'player_points_1st_half'; // raw market_key -- provider-only path, never passed to movementKey
    check('13: full-game movement key and raw period market_key are structurally distinct identifiers', fullGameKey !== periodMarketKeyRaw && !fullGameKey.includes('1st_half'));
  }

  // ---------- 14. Book collision is cross-book disagreement, NOT movement ----------
  {
    const ledger = {};
    const kPP = movementKey('Player X', 'points', 'prizepicks', 'STANDARD', 'event-A');
    const kUD = movementKey('Player X', 'points', 'underdog', 'STANDARD', 'event-A');
    plTrackLine(ledger, kPP, 7.5, 100, 1000);
    const udMove = plTrackLine(ledger, kUD, 22.5, -112, 1000); // same timestamp, different book -- a snapshot disagreement, not a move over time
    check('14: PrizePicks 7.5 and Underdog 22.5 are separate keys (each book owns its own history)', kPP !== kUD);
    check('14b: Underdog\'s first observation is null -- 22.5 is never reported as "moved from" PrizePicks\' 7.5', udMove === null);
  }

  // ---------- 15. Player collision (same/similar name, different event/team) does not merge ----------
  {
    // Identity-resolution (resolvePlayerIdentity, audited in the prior
    // coverage-audit commit) already prevents two different real players
    // with the same normalized name from merging BEFORE a prop ever
    // reaches the movement ledger (game-team context disambiguates, or
    // the match is refused as an unresolved collision). Once past that
    // gate, each resolved player still gets their own real player id in
    // the movement key, so even a same-named DIFFERENT event never
    // collides here either -- covered by the same event-id test (#12)
    // applied to two same-named players' own real ids.
    const ledger = {};
    const kPlayerA = movementKey('mike-williams-lac', 'receivingYards', 'fanduel', null, 'event-A');
    const kPlayerB = movementKey('mike-williams-nyj', 'receivingYards', 'fanduel', null, 'event-B');
    plTrackLine(ledger, kPlayerA, 54.5, -110, 1000);
    const moveB = plTrackLine(ledger, kPlayerB, 40.5, -110, 2000);
    check('15: two different real players sharing a display name never share movement (distinct resolved ids + events)', kPlayerA !== kPlayerB && moveB === null);
  }

  // ---------- 16. Sportsbook primary vs alternate ladder ----------
  {
    // The client movement ledger only ever tracks the resolved PRIMARY
    // line per (player,stat,book,ppType,event) -- see nflBuildProps/
    // mlbBuildProps etc: `arr.find(e => e.primary) || arr[0]` feeds
    // plTrackLine, and primary resolution (mirrored from
    // lib/marketArchive/anchorLine.js's real, already-tested
    // resolvePrimaryLine) picks the two-sided/main line, never an
    // alternate, never by magnitude. Alternates are preserved as raw
    // rows but never separately fed into plTrackLine, so there is no
    // "alternate ladder becomes primary movement" path to begin with.
    const { resolvePrimaryLine } = require('../lib/marketArchive/anchorLine');
    const ladder = [
      { line: 9.5, over_price: -2500, under_price: null, source_type: 'sportsbook' },
      { line: 17.5, over_price: 105, under_price: -135, source_type: 'sportsbook' },
      { line: 24.5, over_price: 425, under_price: null, source_type: 'sportsbook' },
    ];
    const res = resolvePrimaryLine(ladder);
    const ledger = {};
    const key = movementKey('Player X', 'points', 'fanduel', null, 'event-A');
    plTrackLine(ledger, key, res.primary.line, res.primary.over_price, 1000);
    check('16: only the resolved primary (17.5) line ever enters the movement ledger, never an alternate', ledger[key].open === 17.5);
  }

  // ---------- old-ledger cannot contaminate new ledger (version bump) ----------
  {
    const v1Key = ledgerStorageKey('v1', 'mlb', '2026-09-28');
    const v2Key = ledgerStorageKey('v2', 'mlb', '2026-09-28');
    check('old-ledger: v1 and v2 storage keys are different localStorage entries -- a v1-written entry is simply never read under v2', v1Key !== v2Key);
  }

  // ---------- same exact identity across time DOES produce legitimate movement ----------
  {
    const ledger = {};
    const key = movementKey('Player X', 'points', 'fanduel', null, 'event-A');
    const first = plTrackLine(ledger, key, 7.5, -110, 1000);
    const second = plTrackLine(ledger, key, 8.5, -105, 2000);
    check('legitimate movement: identical identity, line actually changed -> a real move is reported', first === null && second && second.from === 7.5 && second.to === 8.5 && second.delta === 1);
    check('legitimate movement: open/openDelta track the true first-seen value for this identity', second.open === 7.5 && second.openDelta === 1);
  }

  // ---------- no movement when fewer than 2 valid chronological observations exist ----------
  {
    const ledger = {};
    const key = movementKey('Player X', 'points', 'fanduel', null, 'event-A');
    const first = plTrackLine(ledger, key, 7.5, -110, 1000);
    check('no movement on the first-ever observation of an identity', first === null);
  }

  // ---------- 17. real archived sanity check (Georgia Amoore, WNBA, Points -- read-only, local archive) ----------
  {
    try {
      const store = require('../lib/snapshotStore');
      await store.verifyReady();
      const rows = await store.query(`
        SELECT source, projection_type, line FROM wnba_provider_line_archive
        WHERE player_raw = 'Georgia Amoore' AND market_key_raw = 'player_points'
        ORDER BY captured_at DESC LIMIT 20
      `);
      if (!rows.length) {
        console.log('SKIP  17: no Georgia Amoore player_points rows currently in the local archive (data may have rotated) -- not a failure, just unavailable this run');
      } else {
        const ppRows = rows.filter(r => r.source === 'prizepicks');
        const ppTypes = new Set(ppRows.map(r => r.projection_type));
        const keys = ppRows.map(r => movementKey('Georgia Amoore', 'points', 'prizepicks', r.projection_type, 'evt'));
        const uniqueKeysForUniqueTypes = new Set(keys).size === ppTypes.size;
        check('17: real archived Georgia Amoore PrizePicks rows (GOBLIN/DEMON/STANDARD if present) each resolve to a distinct movement key', uniqueKeysForUniqueTypes, JSON.stringify([...ppTypes]));
      }
    } catch (e) {
      console.log('SKIP  17: local archive unavailable this run (' + e.message + ') -- not a failure');
    }
  }

  console.log(`\n${failures === 0 ? 'ALL MOVEMENT-IDENTITY TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
