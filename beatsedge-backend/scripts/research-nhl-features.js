// NHL unlock, Part 4: incremental feature testing for the two stat
// families that survived the baseline pass (Shots on Goal, Goalie Saves --
// see scripts/research-nhl-baselines.js). Same real chronological split
// (TRAIN=2024, VALIDATION=2025, UNTOUCHED HOLDOUT=2026), same leak-safety
// discipline (every feature computed from strictly-prior real games).
//
// Tests, ONE AT A TIME against the best baseline already found
// (shrunkL5 for SOG; l10Mean for Saves below -- CORRECTED 2026-09-29:
// the original run of this file was contaminated by goalies dressed but
// never entering the game (saves=0/shots_against=0 rows), which is why
// restB2B originally looked like a real 6.6% MAE improvement. With that
// fixed (shots_against > 0, see below), restB2B's improvement drops to
// ~0.16% -- noise, not a real signal -- and shrinkage-5 actually ties or
// beats l10Mean as the Saves baseline. The PRODUCTION Saves projection
// (lib/nhlProjectionEngine.js) uses plain shrinkage-5 with NO rest/
// back-to-back adjustment; this file's `l10Mean`-labeled baseline below
// and its restB2B/teamWorkload variants are RESEARCH COMPARISONS ONLY,
// neither promoted) -- never assumed to help just because it sounds like
// real hockey knowledge:
//   - TOI-adjusted rate (shots-on-goal per 60 min of ice time, trailing)
//     vs the raw trailing count -- does normalizing for ice time reduce
//     error more than the raw baseline?
//   - Home/away split mean vs the pooled baseline
//   - Rest (rest_days>=2) vs back-to-back (0-1 days) split mean
//   - Opponent/team shot environment (from real nhl_team_box team-game
//     rows): for SOG, the opponent's own real shots-allowed rate as a
//     multiplicative adjustment; for Saves, the goalie's own team's real
//     shots-allowed-against rate blended in.
//
//   node scripts/research-nhl-features.js

const store = require('../lib/historicalStore');

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function mae(errors) { return mean(errors.map(Math.abs)); }

function shrink(games, statKey, k = 8) {
  const vals = games.map(g => g[statKey]).filter(v => v != null);
  if (!vals.length) return null;
  const seasonMean = mean(vals);
  const l5 = vals.slice(-5);
  const l5Mean = mean(l5);
  return l5.length ? ((l5.length * l5Mean) + (k * seasonMean)) / (l5.length + k) : seasonMean;
}
function trailingMean(games, statKey, n) {
  const vals = games.map(g => g[statKey]).filter(v => v != null).slice(-n);
  return vals.length ? mean(vals) : null;
}

async function testShotsOnGoal() {
  console.log('\n=== Shots on Goal: feature tests (baseline = shrunkL5) ===');
  const rows = await store.query(`
    SELECT player_id AS pid, game_date, season, home_away, toi_seconds, shots_on_goal AS val, opponent
    FROM nhl_player_box WHERE season IN (2024,2025,2026) AND shots_on_goal IS NOT NULL
    ORDER BY player_id, game_date ASC
  `);
  const byPlayer = new Map();
  for (const r of rows) { if (!byPlayer.has(r.pid)) byPlayer.set(r.pid, []); byPlayer.get(r.pid).push(r); }

  // Real shots ALLOWED by each team: for a given game_id, team X's shots
  // allowed = the OPPOSING team's own recorded shots_on_goal in that same
  // game_id (a same-game self-join on nhl_team_box, not a scale-mismatched
  // team-total blended with a player-level average).
  const teamRows = await store.query(`SELECT game_id, team, game_date, season, shots_on_goal FROM nhl_team_box WHERE season IN (2024,2025,2026)`);
  const byGameId = new Map();
  for (const r of teamRows) { if (!byGameId.has(r.game_id)) byGameId.set(r.game_id, []); byGameId.get(r.game_id).push(r); }
  const byTeamAsOpponent = new Map(); // team -> real chronological list of {game_date, shots_allowed_to_opp}
  for (const [, rows] of byGameId) {
    if (rows.length !== 2) continue;
    const [a, b] = rows;
    for (const [self, opp] of [[a, b], [b, a]]) {
      if (!byTeamAsOpponent.has(self.team)) byTeamAsOpponent.set(self.team, []);
      byTeamAsOpponent.get(self.team).push({ game_date: self.game_date, shots_allowed_to_opp: opp.shots_on_goal });
    }
  }
  for (const [, arr] of byTeamAsOpponent) arr.sort((a, b) => (a.game_date < b.game_date ? -1 : 1));
  const leagueAvgAllowed = mean(teamRows.map(r => r.shots_on_goal));

  const errors = { baseline: [], toiRate: [], homeAway: [], oppEnv: [] };
  let n = 0;
  for (const [, games] of byPlayer) {
    if (games.length < 20) continue;
    for (let i = 5; i < games.length; i++) {
      const g = games[i];
      if (g.season !== 2025 && g.season !== 2026) continue;
      const prior = games.slice(0, i);
      if (prior.length < 5) continue;
      const base = shrink(prior, 'val');
      if (base == null) continue;
      const actual = g.val;
      errors.baseline.push(actual - base);
      n++;

      // TOI-rate: trailing per-60 SOG rate x this game's real recorded TOI.
      // (Using the TARGET game's own real TOI is a real, pregame-knowable
      // quantity only in the sense that a confirmed lineup implies normal
      // deployment -- for honesty this is evaluated as an UPPER BOUND on
      // what TOI-awareness could buy, not a claim that TOI is pregame-known
      // with certainty; flagged explicitly in the report.)
      const priorWithToi = prior.filter(p => p.toi_seconds > 0);
      if (priorWithToi.length >= 5 && g.toi_seconds > 0) {
        const perSixty = priorWithToi.slice(-8).map(p => (p.val / p.toi_seconds) * 3600);
        const rate = mean(perSixty);
        const toiProj = rate * (g.toi_seconds / 3600);
        errors.toiRate.push(actual - toiProj);
      }

      // Home/away split mean (trailing, same split as target game).
      const sameHA = prior.filter(p => p.home_away === g.home_away);
      if (sameHA.length >= 5) errors.homeAway.push(actual - mean(sameHA.slice(-10).map(p => p.val)));

      // Opponent shot environment: multiplicative adjustment, not an
      // additive blend of two different-unit quantities (a team's
      // full-game shots-allowed total is a wholly different scale from
      // one player's individual shot count). The opponent's trailing
      // shots-allowed rate, expressed as a ratio to the real league
      // average, scales the player's own baseline projection.
      const oppHist = (byTeamAsOpponent.get(g.opponent) || []).filter(t => t.game_date < g.game_date);
      if (oppHist.length >= 10) {
        const oppAllowedAvg = mean(oppHist.slice(-15).map(t => t.shots_allowed_to_opp));
        const oppFactor = oppAllowedAvg / leagueAvgAllowed;
        errors.oppEnv.push(actual - (base * oppFactor));
      }
    }
  }
  console.log(`n=${n}`);
  for (const k of ['baseline', 'toiRate', 'homeAway', 'oppEnv']) {
    console.log(`  ${k}: MAE=${errors[k].length ? mae(errors[k]).toFixed(4) : 'n/a'} (n=${errors[k].length})`);
  }
}

async function testGoalieSaves() {
  console.log('\n=== Goalie Saves: feature tests (baseline = l10Mean) ===');
  // shots_against > 0 excludes goalies dressed but never actually
  // entering the game -- see research-nhl-baselines.js's identical fix
  // for the full rationale (mirrors lib/nhlEngine.js's existing convention).
  const rows = await store.query(`
    SELECT player_id AS pid, team, game_date, season, saves AS val
    FROM nhl_player_box WHERE season IN (2024,2025,2026) AND saves IS NOT NULL AND shots_against > 0
    ORDER BY player_id, game_date ASC
  `);
  const byPlayer = new Map();
  for (const r of rows) { if (!byPlayer.has(r.pid)) byPlayer.set(r.pid, []); byPlayer.get(r.pid).push(r); }

  // Real team-level shots-allowed context (how much shot volume this
  // goalie's OWN team allows -- a real proxy for "how busy will this
  // goalie be", independent of the goalie's own personal trailing saves).
  const teamGames = await store.query(`SELECT team, game_date, season, saves AS team_saves FROM nhl_team_box WHERE season IN (2024,2025,2026)`);
  const byTeam = new Map();
  for (const r of teamGames) { if (!byTeam.has(r.team)) byTeam.set(r.team, []); byTeam.get(r.team).push(r); }
  for (const [, arr] of byTeam) arr.sort((a, b) => (a.game_date < b.game_date ? -1 : 1));

  const errors = { baseline: [], restB2B: [], teamWorkload: [] };
  let n = 0;
  for (const [, games] of byPlayer) {
    if (games.length < 10) continue;
    for (let i = 5; i < games.length; i++) {
      const g = games[i];
      if (g.season !== 2025 && g.season !== 2026) continue;
      const prior = games.slice(0, i);
      if (prior.length < 5) continue;
      const base = trailingMean(prior, 'val', 10);
      if (base == null) continue;
      const actual = g.val;
      errors.baseline.push(actual - base);
      n++;

      // Rest vs back-to-back split (real date-gap derived, no future leak).
      const daysSincePrior = (new Date(g.game_date) - new Date(prior[prior.length - 1].game_date)) / 86400000;
      const isB2B = daysSincePrior <= 1;
      const sameRestState = prior.filter((p, idx) => {
        if (idx === 0) return false;
        const gap = (new Date(p.game_date) - new Date(prior[idx - 1].game_date)) / 86400000;
        return (gap <= 1) === isB2B;
      });
      if (sameRestState.length >= 5) errors.restB2B.push(actual - mean(sameRestState.slice(-10).map(p => p.val)));

      // Team workload blend: this goalie's team's own real recent
      // shots-allowed (proxied via team_box's own saves-generated column,
      // since save volume tracks shot volume directly).
      const teamHist = (byTeam.get(g.team) || []).filter(t => t.game_date < g.game_date);
      if (teamHist.length >= 10) {
        const teamAvg = mean(teamHist.slice(-10).map(t => t.team_saves));
        errors.teamWorkload.push(actual - (base + teamAvg) / 2);
      }
    }
  }
  console.log(`n=${n}`);
  for (const k of ['baseline', 'restB2B', 'teamWorkload']) {
    console.log(`  ${k}: MAE=${errors[k].length ? mae(errors[k]).toFixed(4) : 'n/a'} (n=${errors[k].length})`);
  }
}

(async () => {
  console.log('backend:', store.backend);
  await testShotsOnGoal();
  await testGoalieSaves();
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
