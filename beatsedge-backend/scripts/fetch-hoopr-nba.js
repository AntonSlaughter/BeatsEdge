// Fetch free historical NBA data from the sportsdataverse / hoopR bulk
// release repo. No API key, no rate limit, ESPN-sourced so the ids line
// up 1:1 with the ESPN endpoints BeatsEdge already uses
// (`athlete_id` = ESPN athlete id, `game_id` = ESPN event id).
//
//   node scripts/fetch-hoopr-nba.js            # player_box + team_box, 2016..cur, CSV
//   node scripts/fetch-hoopr-nba.js --from 2002 --format parquet
//   node scripts/fetch-hoopr-nba.js --sets player_box
//
// Files land in  data/hoopr/<set>/<set>_<seasonEndYear>.<ext>  (gitignored).
// seasonEndYear: 2026 = the 2025-26 season.
//
// player_box columns (CSV/parquet identical): game_id, season, season_type,
// game_date, athlete_id, athlete_display_name, team_id, team_abbreviation,
// minutes, field_goals_made/attempted, three_point_field_goals_made/attempted,
// free_throws_made/attempted, offensive_rebounds, defensive_rebounds,
// rebounds, assists, steals, blocks, turnovers, fouls, plus_minus, points,
// starter, did_not_play, reason, athlete_position_abbreviation, home_away,
// team_score, opponent_team_id, opponent_team_abbreviation, opponent_team_score.

const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download';
const TAGS = {
  player_box: 'espn_nba_player_boxscores',
  team_box: 'espn_nba_team_boxscores',
  pbp: 'espn_nba_pbp',
  shots: 'espn_nba_shots',
};

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const CUR_SEASON_END = new Date().getMonth() >= 9 ? new Date().getFullYear() + 1 : new Date().getFullYear();
const FROM = parseInt(arg('from', '2016'), 10);
const TO = parseInt(arg('to', String(CUR_SEASON_END)), 10);
const FORMAT = arg('format', 'csv'); // csv | parquet | rds
const SETS = arg('sets', 'player_box,team_box').split(',').map(s => s.trim()).filter(Boolean);
const DEST = path.join(__dirname, '..', 'data', 'hoopr');

function download(url, out) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, out).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const tmp = out + '.part';
      const f = fs.createWriteStream(tmp);
      res.pipe(f);
      f.on('finish', () => f.close(() => { fs.renameSync(tmp, out); resolve(fs.statSync(out).size); }));
      f.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('timeout')));
  });
}

(async () => {
  fs.mkdirSync(DEST, { recursive: true });
  let ok = 0, skip = 0, fail = 0, bytes = 0;
  for (const set of SETS) {
    const tag = TAGS[set];
    if (!tag) { console.log(`skip unknown set "${set}"`); continue; }
    const dir = path.join(DEST, set);
    fs.mkdirSync(dir, { recursive: true });
    for (let yr = FROM; yr <= TO; yr++) {
      const fname = `${set}_${yr}.${FORMAT}`;
      const out = path.join(dir, fname);
      if (fs.existsSync(out) && fs.statSync(out).size > 1024) { skip++; continue; }
      const url = `${BASE}/${tag}/${fname}`;
      try {
        const size = await download(url, out);
        bytes += size;
        ok++;
        console.log(`ok   ${set}/${fname}  ${(size / 1e6).toFixed(1)} MB`);
      } catch (e) {
        fail++;
        try { fs.unlinkSync(out); } catch (_) {}
        try { fs.unlinkSync(out + '.part'); } catch (_) {}
        console.log(`FAIL ${set}/${fname}  ${e.message}`);
      }
    }
  }
  console.log(`\ndone  downloaded=${ok} kept=${skip} failed=${fail}  (+${(bytes / 1e6).toFixed(1)} MB)  ->  ${DEST}`);
})();
