// Real NFL player-game stats + real defensive interception facts, from
// nflverse's live `stats_player` release (the replacement for the now-
// deprecated `player_stats` release — that's why the previously-committed
// 2022-2024 data never grew past 2024: the old release stopped updating).
//
//   node scripts/ingest-nflverse-stats.js                  # 2025 (complete) + current season
//   node scripts/ingest-nflverse-stats.js --seasons 2024,2025,2026
//
// Idempotent — same unique index / PRIMARY KEYs as the original seed, so
// re-running (nightly, via cron/nflNightlyUpdate.js) just refreshes rows as
// more of the current season gets played. Never touches the pre-existing
// 2022-2024 rows unless those seasons are explicitly re-requested.
//
// Source: https://github.com/nflverse/nflverse-data/releases/tag/stats_player
// One CSV per season: stats_player_week_<season>.csv — REG+POST, every
// position on the field (this script keeps QB/RB/WR/TE for
// nfl_player_game_stats, matching what this app grades props on, and pulls
// `def_interceptions`/`attempts` from EVERY row for nfl_team_defense_game —
// see the comment on that table in lib/nflDb.js for why interceptions need
// a separate table). Verified live (this session): stats_player_week_2026.csv
// currently carries 2 completed games' worth of Week 1 — nflverse's own
// advanced-stat pipeline lags the raw box score by some days, so current-
// season coverage is genuinely thin right at the start of a week and fills
// in over the following nights as this script is re-run.

const path = require('path');
const https = require('https');
const { parse } = require('csv-parse/sync');
// node:sqlite's DatabaseSync (Node >= 22.5), NOT better-sqlite3/lib/nflDb.js
// — this process never loads better-sqlite3 at all. Verified live: even
// requiring lib/nflDb.js just for its schema setup and then closing it
// still crashed this script later with a native "Statement::`scalar
// deleting destructor`" assertion (same known issue already noted in
// scripts/ingest-hoopr-nba.js for NBA's bulk ingest — the prebuilt
// better-sqlite3 binary has a native cleanup bug on this box). node:sqlite
// opens the identical .db file fine and the schema logic (lib/nflSchema.js)
// has no better-sqlite3 dependency, so it runs unchanged against either handle.
const { DatabaseSync } = require('node:sqlite');
const { runNflMigrations } = require('../lib/nflSchema');
const DB_PATH = path.join(__dirname, '..', 'data', 'beatsedge.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
runNflMigrations(db);

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const now = new Date();
// NFL's "season year" is the year the season kicks off in (Sept), and covers
// through the following February — so during Jan/Feb the in-progress season
// is still last calendar year's number.
const inferredCurrent = now.getMonth() >= 1 ? now.getFullYear() : now.getFullYear() - 1;
const SEASONS = arg('seasons', `${inferredCurrent - 1},${inferredCurrent}`)
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);

const KEEP_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'beatsedge-backend' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchText(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
  });
}

const upsertPlayerGame = db.prepare(`
  INSERT INTO nfl_player_game_stats
    (season, week, season_type, game_date, player_id, player_name, position, team, opponent,
     pass_attempts, completions, passing_yards, passing_tds, interceptions,
     rush_attempts, rushing_yards, rushing_tds,
     receptions, targets, receiving_yards, receiving_tds, fantasy_points_ppr, source)
  VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nflverse-stats_player')
  ON CONFLICT(season, week, season_type, player_id) DO UPDATE SET
    game_date=excluded.game_date, player_name=excluded.player_name, position=excluded.position,
    team=excluded.team, opponent=excluded.opponent,
    pass_attempts=excluded.pass_attempts, completions=excluded.completions,
    passing_yards=excluded.passing_yards, passing_tds=excluded.passing_tds, interceptions=excluded.interceptions,
    rush_attempts=excluded.rush_attempts, rushing_yards=excluded.rushing_yards, rushing_tds=excluded.rushing_tds,
    receptions=excluded.receptions, targets=excluded.targets, receiving_yards=excluded.receiving_yards,
    receiving_tds=excluded.receiving_tds, fantasy_points_ppr=excluded.fantasy_points_ppr,
    source=excluded.source
`);

const upsertTeamDefenseGame = db.prepare(`
  INSERT INTO nfl_team_defense_game (season, week, season_type, team, opponent, interceptions_generated, pass_attempts_faced)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(season, week, season_type, team) DO UPDATE SET
    opponent=excluded.opponent,
    interceptions_generated=excluded.interceptions_generated,
    pass_attempts_faced=excluded.pass_attempts_faced
`);

(async () => {
  let totalPlayerRows = 0, totalDefenseGames = 0;
  for (const season of SEASONS) {
    const url = `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;
    process.stdout.write(`Fetching ${season} from ${url} ... `);
    let text;
    try {
      text = await fetchText(url);
    } catch (e) {
      console.log(`SKIP (${e.message})`);
      continue;
    }
    const rows = parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true });
    console.log(`${rows.length} rows`);

    // Per (season, week, season_type, team) — the defensive side. Any
    // position can log an interception (LB/CB/SAF/DE/DT/...); pass
    // attempts FACED comes from the opposing QB's own `attempts` on their
    // row (their opponent_team is this defense's team).
    const defenseGames = new Map(); // key: season|week|type|team -> {interceptions_generated, pass_attempts_faced, opponent}

    let playerRows = 0;
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        if (!r.season || !r.week || !r.team) continue;
        const seasonN = parseInt(r.season, 10), weekN = parseInt(r.week, 10);
        const seasonType = r.season_type || 'REG';

        // Defensive interceptions: any position, own team. Every row
        // contributes (even 0) so the game entry exists to be summed with
        // the pass-attempts-faced side below, whichever row order they land in.
        const defInt = num(r.def_interceptions);
        const dKey = `${seasonN}|${weekN}|${seasonType}|${r.team}`;
        const dCur = defenseGames.get(dKey) || { interceptions_generated: 0, pass_attempts_faced: 0, opponent: r.opponent_team || null };
        dCur.interceptions_generated += defInt;
        if (r.opponent_team) dCur.opponent = r.opponent_team;
        defenseGames.set(dKey, dCur);
        // Pass attempts faced: from the QB's own attempts, credited to the opponent's defense.
        if (r.position === 'QB' && r.opponent_team) {
          const oKey = `${seasonN}|${weekN}|${seasonType}|${r.opponent_team}`;
          const cur = defenseGames.get(oKey) || { interceptions_generated: 0, pass_attempts_faced: 0, opponent: r.team || null };
          cur.pass_attempts_faced += num(r.attempts);
          defenseGames.set(oKey, cur);
        }

        if (!KEEP_POSITIONS.has(r.position)) continue;
        if (!r.player_id || !r.player_display_name) continue;
        upsertPlayerGame.run(
          seasonN, weekN, seasonType,
          r.player_id, r.player_display_name, r.position, r.team, r.opponent_team || '',
          num(r.attempts), num(r.completions),
          num(r.passing_yards), num(r.passing_tds), num(r.passing_interceptions),
          num(r.carries), num(r.rushing_yards), num(r.rushing_tds),
          num(r.receptions), num(r.targets), num(r.receiving_yards), num(r.receiving_tds),
          num(r.fantasy_points_ppr)
        );
        playerRows++;
      }
      for (const [key, g] of defenseGames.entries()) {
        const [seasonN, weekN, seasonType, team] = key.split('|');
        upsertTeamDefenseGame.run(
          parseInt(seasonN, 10), parseInt(weekN, 10), seasonType,
          team, g.opponent || '', g.interceptions_generated, g.pass_attempts_faced
        );
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    console.log(`  -> ${playerRows} QB/RB/WR/TE rows, ${defenseGames.size} team-defense-game rows`);
    totalPlayerRows += playerRows;
    totalDefenseGames += defenseGames.size;
  }
  console.log(`\nDone. ${totalPlayerRows} player-game rows, ${totalDefenseGames} team-defense-game rows upserted across seasons [${SEASONS.join(', ')}].`);
})().catch(e => { console.error('Ingestion failed:', e); process.exit(1); });
