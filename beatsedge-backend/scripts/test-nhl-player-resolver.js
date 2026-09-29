// NHL unlock project -- player resolver collision audit + fail-closed
// regression, against the REAL 1,362-player historical dataset (no
// synthetic names). Mirrors the exact resolution algorithm in
// BeatsEdge.html's fetchNhlPropLines (Node port for testability, since
// the browser can't run a Node test harness against its own inline
// function).
//
//   node --env-file=.env scripts/test-nhl-player-resolver.js

const store = require('../lib/historicalStore');

function nhlMatchKey(name) {
  if (!name) return null;
  const parts = String(name).trim().split(/\s+/);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1].toLowerCase().replace(/[^a-z'-]/g, '');
  const initial = parts[0].replace(/[^A-Za-z]/g, '').charAt(0).toLowerCase();
  if (!last || !initial) return null;
  return `${initial}.${last}`;
}

// Exact mirror of BeatsEdge.html's resolution algorithm.
function resolvePlayerId(candidates, gameTeamAbbrs) {
  const distinctPlayerIds = [...new Set(candidates.map(c => c.playerId))];
  if (distinctPlayerIds.length === 1) return { resolved: distinctPlayerIds[0], reason: 'unique' };
  if (distinctPlayerIds.length > 1 && gameTeamAbbrs.length) {
    const matchingIds = [...new Set(candidates.filter(c => gameTeamAbbrs.includes(c.team)).map(c => c.playerId))];
    if (matchingIds.length === 1) return { resolved: matchingIds[0], reason: 'teamCorroborated' };
    if (matchingIds.length === 0) return { resolved: null, reason: 'noTeamMatch' };
    return { resolved: null, reason: 'sameTeamCollision' };
  }
  return { resolved: null, reason: 'ambiguousNoTeamData' };
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

(async () => {
  const rows = await store.query('SELECT DISTINCT player_id, player_name, team FROM nhl_player_box WHERE player_name IS NOT NULL');
  const totalRealPlayers = new Set(rows.map(r => r.player_id)).size;
  console.log(`Real dataset: ${totalRealPlayers} distinct real player_ids, ${rows.length} (player_id, team) real rows.\n`);

  const byKey = new Map();
  for (const r of rows) {
    const k = nhlMatchKey(r.player_name);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, new Map());
    byKey.get(k).set(r.player_id, { name: r.player_name, team: r.team });
  }
  const collisions = [...byKey.entries()].filter(([, m]) => m.size > 1);

  console.log(`REAL COLLISION AUDIT: ${collisions.length} matchKeys map to >1 distinct real player_id (out of ${byKey.size} total matchKeys).\n`);

  let sameTeamCount = 0, teamResolvableCount = 0;
  for (const [key, m] of collisions) {
    const candidates = [...m.entries()].map(([playerId, v]) => ({ playerId, team: v.team, name: v.name }));
    const teams = new Set(candidates.map(c => c.team));
    const sameTeam = teams.size < candidates.length;
    if (sameTeam) sameTeamCount++; else teamResolvableCount++;
    console.log(`  ${key}: ${candidates.map(c => `${c.name}(${c.team})`).join(' vs ')} -- ${sameTeam ? 'SAME TEAM, remains ambiguous even with real game context' : 'different teams, real game context can disambiguate'}`);
  }
  console.log(`\n${teamResolvableCount} of ${collisions.length} collisions are resolvable via real team context; ${sameTeamCount} remain genuinely ambiguous (same real team) and must FAIL CLOSED regardless of context.\n`);

  // ---- regression: exact real collisions behave correctly ----
  for (const [key, m] of collisions) {
    const candidates = [...m.entries()].map(([playerId, v]) => ({ playerId, team: v.team }));
    const teams = [...new Set(candidates.map(c => c.team))];
    if (teams.length === candidates.length) {
      // different teams -- real game context (using the FIRST candidate's own team as the "real" game) should resolve to exactly that candidate
      const r = resolvePlayerId(candidates, [candidates[0].team]);
      check(`${key}: real game context (${candidates[0].team}) resolves to the correct real player_id, not the other one`,
        r.resolved === candidates[0].playerId && r.reason === 'teamCorroborated');
    } else {
      // same team -- must fail closed even with that team as context
      const r = resolvePlayerId(candidates, [candidates[0].team]);
      check(`${key}: same-team collision FAILS CLOSED (no model output attached) even with matching real game context`,
        r.resolved === null && r.reason === 'sameTeamCollision');
    }
  }

  // ---- regression: no game-team-context at all also fails closed for any real collision ----
  {
    const [, m] = collisions[0];
    const candidates = [...m.entries()].map(([playerId, v]) => ({ playerId, team: v.team }));
    const r = resolvePlayerId(candidates, []);
    check('a real collision with NO real game-team context available fails closed (never guesses)',
      r.resolved === null && r.reason === 'ambiguousNoTeamData');
  }

  // ---- regression: the overwhelming common case (unique real name) is unaffected ----
  {
    const uniqueEntry = [...byKey.entries()].find(([, m]) => m.size === 1);
    const [, m] = uniqueEntry;
    const [playerId] = [...m.keys()];
    const r = resolvePlayerId([{ playerId, team: [...m.values()][0].team }], []);
    check('a unique real player name resolves correctly with zero team context needed (unaffected by the collision guard)',
      r.resolved === playerId && r.reason === 'unique');
  }

  console.log(`\n${failures === 0 ? 'ALL PLAYER RESOLVER TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
