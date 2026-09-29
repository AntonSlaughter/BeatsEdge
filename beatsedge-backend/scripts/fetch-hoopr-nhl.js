// Fetch free historical NHL data from the sportsdataverse bulk release repo
// (fastRhockey-nhl-data, MIT license: https://github.com/sportsdataverse/
// fastRhockey-nhl-data -- release assets hosted on sportsdataverse-data,
// confirmed live 2026-09-29). Same organization/hosting pattern BeatsEdge
// already trusts for NBA/WNBA's hoopR data (scripts/fetch-hoopr-nba.js/
// fetch-hoopr-wnba.js) -- not a new kind of trust decision, just a new sport.
//
// No API key, no rate limit. NHL player/team ids in this dataset are the
// NHL's own numeric ids (api-web.nhle.com's ids), NOT ESPN ids -- unlike
// hoopR's NBA/WNBA data. This matters: BeatsEdge's LIVE NHL tables
// (nhl_skater_game_stats etc., populated by cron/nhlNightlyUpdate.js via
// lib/nhlProxy.js, also api-web.nhle.com-sourced) already use these SAME
// NHL numeric ids -- so this research dataset's player_id/team/game_id
// line up 1:1 with the live tables' ids, with no separate identity-
// resolution step needed.
//
//   node scripts/fetch-hoopr-nhl.js                          # player_box + team_box, 2022..cur, CSV
//   node scripts/fetch-hoopr-nhl.js --seasons 2022,2023,2024,2025,2026
//   node scripts/fetch-hoopr-nhl.js --sets player_box
//
// Files land in  data/hoopr-nhl/<set>/<set>_<season>.csv  (gitignored).
// season = the ENDING year of the season (2026 = the 2025-26 season),
// matching the source repo's own convention exactly.
//
// player_box columns (real, verified live): home_away, team_id,
// team_abbrev, player_id, player_name, sweater_number, position, goals,
// assists, points, plus_minus, pim, hits, power_play_goals, shots_on_goal,
// faceoff_winning_pctg, toi, blocked_shots, shifts, giveaways, takeaways,
// game_id, season, game_date, even_strength_shots_against,
// power_play_shots_against, shorthanded_shots_against, save_shots_against,
// save_pctg, even_strength_goals_against, power_play_goals_against,
// shorthanded_goals_against, goals_against, starter, decision,
// shots_against, saves -- skaters and goalies share one file; goalie-only
// columns are blank for skater rows and vice versa.
//
// team_box columns (real, verified live): home_away, team_id, team_abbrev,
// team_name, goals, shots_on_goal, pim, hits, blocked_shots, giveaways,
// takeaways, power_play_goals, faceoff_win_pctg, saves, save_pctg,
// goals_against, game_id, season, game_date.

const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download';
const TAGS = {
  player_box: 'nhl_player_boxscores',
  team_box: 'nhl_team_boxscores',
};

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// Default: current season + 4 prior complete seasons (5 total) -- enough
// for a real chronological train/validation/untouched-holdout split
// without ingesting all 16 available seasons the source actually has.
// NHL regular season starts in October -- before that, "this year's" season
// (by ending-year convention) is still LAST year's (e.g. Sept 2026 is
// preseason for season-end-year 2027, but season-end-year 2026's real
// 2025-26 season is the most recently COMPLETE one). getMonth() >= 9 is
// October (0-indexed).
const CUR_SEASON_END = new Date().getMonth() >= 9 ? new Date().getFullYear() + 1 : new Date().getFullYear();
const SEASONS = arg('seasons', null)
  ? arg('seasons').split(',').map(s => parseInt(s.trim(), 10))
  : [CUR_SEASON_END - 4, CUR_SEASON_END - 3, CUR_SEASON_END - 2, CUR_SEASON_END - 1, CUR_SEASON_END];
const SETS = arg('sets', 'player_box,team_box').split(',').map(s => s.trim()).filter(Boolean);
const FORCE = process.argv.includes('--force');
const DEST = path.join(__dirname, '..', 'data', 'hoopr-nhl');

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
    for (const season of SEASONS) {
      const fname = `${set}_${season}.csv`;
      const out = path.join(dir, fname);
      if (!FORCE && fs.existsSync(out) && fs.statSync(out).size > 1024) { skip++; continue; }
      const url = `${BASE}/${tag}/${fname}`;
      try {
        const size = await download(url, out);
        bytes += size;
        ok++;
        console.log(`ok   ${set}/${fname}  ${(size / 1e6).toFixed(2)} MB`);
      } catch (e) {
        fail++;
        try { fs.unlinkSync(out); } catch (_) {}
        try { fs.unlinkSync(out + '.part'); } catch (_) {}
        console.log(`FAIL ${set}/${fname}  ${e.message}`);
      }
    }
  }
  console.log(`\ndone  downloaded=${ok} kept=${skip} failed=${fail}  (+${(bytes / 1e6).toFixed(1)} MB)  ->  ${DEST}`);
  console.log(`Source: https://github.com/sportsdataverse/fastRhockey-nhl-data (MIT license), release assets via sportsdataverse-data.`);
})();
