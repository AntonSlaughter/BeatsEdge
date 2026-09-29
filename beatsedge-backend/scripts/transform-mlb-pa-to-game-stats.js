// Deterministic transform: real MLB plate-appearance-level data
// (data/flame-mlb.db, MLB Stats API-sourced, 2022-2024, ~549,877 PAs) ->
// the FACTUAL game-level schema production already expects
// (mlb_batter_game_stats / mlb_pitcher_game_stats). Source provenance:
// lib/flame/flameMlbDb.js's flame_mlb_plate_appearances table, itself
// ingested by scripts/flame/ingest-mlb-season.js from
// statsapi.mlb.com's live feed (gameData/liveData.plays.allPlays[]) --
// this is Flame Intelligence's own RAW DATA SOURCE, reused here purely as
// a data source. Does NOT reuse or rerun any of Flame's hypothesis-testing
// code (shrinkage.js, hitsDataset.js) and does NOT write anywhere near
// Flame's own tables.
//
// Only FACTUAL fields directly computable from the PA-level record are
// derived. Two mlb_batter_game_stats/mlb_pitcher_game_stats columns
// (`runs`, `earned_runs`) are NOT derivable from PA-level data alone --
// both require full inning-by-inning baserunner reconstruction (who
// scored, on whose plate appearance, whether earned per the official
// scorer) that this source does not carry. Left NULL, never fabricated,
// reported explicitly in the validation output.
//
// Pitcher Outs discipline (explicitly required): derived DIRECTLY from
// each PA's outs_after - outs_before (correctly crediting a double play as
// 2 outs on the SAME plate appearance), summed per (pitcher, game) --
// never inferred by multiplying a decimal innings-pitched value. innings_
// pitched is then DISPLAY-DERIVED from that real outs total via the
// standard floor(outs/3) + (outs%3)/10 baseball notation, the correct
// direction (outs -> innings), never innings -> outs.
//
//   node scripts/transform-mlb-pa-to-game-stats.js --dry-run
//   node scripts/transform-mlb-pa-to-game-stats.js --apply

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { BEATSEDGE_DB_PATH, DATA_DIR } = require('../lib/dataPaths');

const APPLY = process.argv.includes('--apply');
const FLAME_MLB_DB_PATH = path.join(DATA_DIR, 'flame-mlb.db');

const HIT_TOTAL_BASES = { single: 1, double: 2, triple: 3, home_run: 4 };
const isStrikeout = (eventType) => typeof eventType === 'string' && eventType.startsWith('strikeout');
const isWalk = (eventType) => eventType === 'walk' || eventType === 'intent_walk';

function outsToInningsPitched(outs) {
  return Math.floor(outs / 3) + (outs % 3) / 10;
}

(async () => {
  const flameDb = new DatabaseSync(FLAME_MLB_DB_PATH);
  const destDb = new DatabaseSync(BEATSEDGE_DB_PATH);
  destDb.exec('PRAGMA journal_mode = WAL');

  console.log('Loading real games (flame_mlb_games)...');
  const games = flameDb.prepare(`SELECT game_pk, season, game_date, home_team_abbr, away_team_abbr, status FROM flame_mlb_games WHERE status = 'Final'`).all();
  const gameByPk = new Map(games.map(g => [g.game_pk, g]));
  console.log(`  ${games.length} completed real games, seasons: ${[...new Set(games.map(g => g.season))].sort().join(', ')}`);

  console.log('Loading real player identities (flame_mlb_players)...');
  const players = flameDb.prepare(`SELECT player_id, full_name FROM flame_mlb_players`).all();
  const nameById = new Map(players.map(p => [p.player_id, p.full_name]));
  const nameFor = (id) => nameById.get(id) || `MLB Player ${id}`; // real id-derived fallback, never a fabricated name, only used for the rare id missing from flame_mlb_players
  console.log(`  ${players.length} real player identities loaded`);

  console.log('Loading real plate appearances (flame_mlb_plate_appearances)...');
  const paRows = flameDb.prepare(`
    SELECT game_pk, at_bat_index, half_inning, batter_id, pitcher_id, event_type, rbi,
           outs_before, outs_after, is_hit, is_at_bat
    FROM flame_mlb_plate_appearances
    ORDER BY game_pk, at_bat_index
  `).all();
  console.log(`  ${paRows.length} real plate appearances`);

  // ---------- BATTER aggregation ----------
  const batterGames = new Map(); // "gamePk|batterId" -> accumulator
  for (const pa of paRows) {
    if (pa.batter_id == null) continue;
    const key = `${pa.game_pk}|${pa.batter_id}`;
    if (!batterGames.has(key)) {
      batterGames.set(key, {
        game_pk: pa.game_pk, player_id: pa.batter_id, half_inning_sample: pa.half_inning,
        at_bats: 0, hits: 0, total_bases: 0, rbi: 0, home_runs: 0, walks: 0, strikeouts: 0,
        first_pa_index: pa.at_bat_index, opposing_pitcher_id: pa.pitcher_id,
      });
    }
    const b = batterGames.get(key);
    if (pa.at_bat_index < b.first_pa_index) { b.first_pa_index = pa.at_bat_index; b.opposing_pitcher_id = pa.pitcher_id; }
    b.at_bats += pa.is_at_bat ? 1 : 0;
    b.hits += pa.is_hit ? 1 : 0;
    b.total_bases += HIT_TOTAL_BASES[pa.event_type] || 0;
    b.rbi += pa.rbi || 0;
    b.home_runs += pa.event_type === 'home_run' ? 1 : 0;
    b.walks += isWalk(pa.event_type) ? 1 : 0;
    b.strikeouts += isStrikeout(pa.event_type) ? 1 : 0;
  }

  // ---------- PITCHER aggregation (outs FIRST, innings derived from outs) ----------
  const pitcherGames = new Map(); // "gamePk|pitcherId" -> accumulator
  for (const pa of paRows) {
    if (pa.pitcher_id == null) continue;
    const key = `${pa.game_pk}|${pa.pitcher_id}`;
    if (!pitcherGames.has(key)) {
      pitcherGames.set(key, {
        game_pk: pa.game_pk, player_id: pa.pitcher_id, half_inning_sample: pa.half_inning,
        outs: 0, strikeouts: 0, walks_allowed: 0, hits_allowed: 0, home_runs_allowed: 0,
      });
    }
    const p = pitcherGames.get(key);
    // Real outs recorded on THIS plate appearance -- correctly credits a
    // double play (2 outs on one PA) or a K (1 out), never a decimal-innings
    // inference. Clamped at >=0 defensively; source data was not found to
    // ever produce a negative delta in this dataset.
    const outsThisPa = Math.max(0, (pa.outs_after || 0) - (pa.outs_before || 0));
    p.outs += outsThisPa;
    p.strikeouts += isStrikeout(pa.event_type) ? 1 : 0;
    p.walks_allowed += isWalk(pa.event_type) ? 1 : 0;
    p.hits_allowed += pa.is_hit ? 1 : 0;
    p.home_runs_allowed += pa.event_type === 'home_run' ? 1 : 0;
  }

  // ---------- team attribution (same convention as lib/finalAudit/mlbAuditData.js) ----------
  function teamsFor(gamePk, battingIsHome) {
    const g = gameByPk.get(gamePk);
    if (!g) return { team: null, opponent: null, game_date: null, season: null };
    return battingIsHome
      ? { team: g.home_team_abbr, opponent: g.away_team_abbr, game_date: g.game_date, season: g.season }
      : { team: g.away_team_abbr, opponent: g.home_team_abbr, game_date: g.game_date, season: g.season };
  }

  const batterRowsOut = [];
  let batterMissingGame = 0;
  for (const [, b] of batterGames) {
    const t = teamsFor(b.game_pk, b.half_inning_sample === 'bottom');
    if (!t.team) { batterMissingGame++; continue; }
    batterRowsOut.push({
      game_date: t.game_date, game_pk: String(b.game_pk), player_id: String(b.player_id), player_name: nameFor(b.player_id),
      team: t.team, opponent: t.opponent, opposing_pitcher_id: String(b.opposing_pitcher_id), opposing_pitcher_name: nameFor(b.opposing_pitcher_id),
      at_bats: b.at_bats, hits: b.hits, total_bases: b.total_bases, runs: null /* DATA GAP: not derivable from PA-level data */,
      rbi: b.rbi, home_runs: b.home_runs, walks: b.walks, strikeouts: b.strikeouts,
      source: 'flame-mlb-pa-transform',
    });
  }

  const pitcherRowsOut = [];
  let pitcherMissingGame = 0;
  for (const [, p] of pitcherGames) {
    // Pitching team = the OTHER side from the half-inning the PA was recorded in
    // (pitcher pitches when the OTHER team bats): half_inning='top' means away
    // bats -> home pitches; 'bottom' means home bats -> away pitches.
    const t = teamsFor(p.game_pk, p.half_inning_sample === 'top');
    if (!t.team) { pitcherMissingGame++; continue; }
    pitcherRowsOut.push({
      game_date: t.game_date, game_pk: String(p.game_pk), player_id: String(p.player_id), player_name: nameFor(p.player_id),
      team: t.team, opponent: t.opponent,
      innings_pitched: outsToInningsPitched(p.outs), strikeouts: p.strikeouts, walks_allowed: p.walks_allowed,
      hits_allowed: p.hits_allowed, earned_runs: null /* DATA GAP: not derivable from PA-level data */,
      home_runs_allowed: p.home_runs_allowed,
      _outs: p.outs, // internal, for validation output only -- not a destination column
      source: 'flame-mlb-pa-transform',
    });
  }

  console.log(`\nTransform summary: ${batterRowsOut.length} batter-game rows (${batterMissingGame} skipped, no matching completed game), ${pitcherRowsOut.length} pitcher-game rows (${pitcherMissingGame} skipped)`);

  // ---------- dry-run / apply against mlb_batter_game_stats / mlb_pitcher_game_stats ----------
  const selectBatter = destDb.prepare(`SELECT at_bats, hits, total_bases, rbi, home_runs, walks, strikeouts FROM mlb_batter_game_stats WHERE game_pk = ? AND player_id = ?`);
  const selectPitcher = destDb.prepare(`SELECT innings_pitched, strikeouts, walks_allowed, hits_allowed, home_runs_allowed FROM mlb_pitcher_game_stats WHERE game_pk = ? AND player_id = ?`);
  const insertBatter = destDb.prepare(`INSERT INTO mlb_batter_game_stats (game_date, game_pk, player_id, player_name, team, opponent, opposing_pitcher_id, opposing_pitcher_name, at_bats, hits, total_bases, runs, rbi, home_runs, walks, strikeouts, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertPitcher = destDb.prepare(`INSERT INTO mlb_pitcher_game_stats (game_date, game_pk, player_id, player_name, team, opponent, innings_pitched, strikeouts, walks_allowed, hits_allowed, earned_runs, home_runs_allowed, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const report = { batter: { wouldInsert: 0, conflicts: 0, unchanged: 0, conflictSamples: [] }, pitcher: { wouldInsert: 0, conflicts: 0, unchanged: 0, conflictSamples: [] } };

  for (const r of batterRowsOut) {
    const existing = selectBatter.get(r.game_pk, r.player_id);
    if (existing) {
      const differs = existing.at_bats !== r.at_bats || existing.hits !== r.hits || existing.total_bases !== r.total_bases || existing.rbi !== r.rbi || existing.home_runs !== r.home_runs || existing.walks !== r.walks || existing.strikeouts !== r.strikeouts;
      if (differs) { report.batter.conflicts++; if (report.batter.conflictSamples.length < 5) report.batter.conflictSamples.push({ game_pk: r.game_pk, player_id: r.player_id, existing, transformed: r }); }
      else report.batter.unchanged++;
      continue;
    }
    report.batter.wouldInsert++;
    if (APPLY) insertBatter.run(r.game_date, r.game_pk, r.player_id, r.player_name, r.team, r.opponent, r.opposing_pitcher_id, r.opposing_pitcher_name, r.at_bats, r.hits, r.total_bases, r.runs, r.rbi, r.home_runs, r.walks, r.strikeouts, r.source);
  }
  for (const r of pitcherRowsOut) {
    const existing = selectPitcher.get(r.game_pk, r.player_id);
    if (existing) {
      const differs = Math.abs((existing.innings_pitched || 0) - r.innings_pitched) > 0.05 || existing.strikeouts !== r.strikeouts || existing.walks_allowed !== r.walks_allowed || existing.hits_allowed !== r.hits_allowed || existing.home_runs_allowed !== r.home_runs_allowed;
      if (differs) { report.pitcher.conflicts++; if (report.pitcher.conflictSamples.length < 5) report.pitcher.conflictSamples.push({ game_pk: r.game_pk, player_id: r.player_id, existing, transformed: r }); }
      else report.pitcher.unchanged++;
      continue;
    }
    report.pitcher.wouldInsert++;
    if (APPLY) insertPitcher.run(r.game_date, r.game_pk, r.player_id, r.player_name, r.team, r.opponent, r.innings_pitched, r.strikeouts, r.walks_allowed, r.hits_allowed, r.earned_runs, r.home_runs_allowed, r.source);
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}:`);
  console.log('  batter:', JSON.stringify({ wouldInsert: report.batter.wouldInsert, conflicts: report.batter.conflicts, unchanged: report.batter.unchanged }));
  console.log('  pitcher:', JSON.stringify({ wouldInsert: report.pitcher.wouldInsert, conflicts: report.pitcher.conflicts, unchanged: report.pitcher.unchanged }));

  const outPath = path.join(__dirname, '..', 'tmp', `mlb-pa-transform-${APPLY ? 'applied' : 'dryrun'}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    sourcePaRows: paRows.length, sourceGames: games.length,
    batterGameRowsProduced: batterRowsOut.length, pitcherGameRowsProduced: pitcherRowsOut.length,
    batterMissingGame, pitcherMissingGame,
    dateRange: { min: games.length ? games.reduce((m, g) => g.game_date < m ? g.game_date : m, games[0].game_date) : null, max: games.length ? games.reduce((m, g) => g.game_date > m ? g.game_date : m, games[0].game_date) : null },
    seasons: [...new Set(games.map(g => g.season))].sort(),
    distinctBatters: new Set(batterRowsOut.map(r => r.player_id)).size,
    distinctPitchers: new Set(pitcherRowsOut.map(r => r.player_id)).size,
    report,
  }, null, 2));
  console.log(`\nWritten to ${outPath}`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
