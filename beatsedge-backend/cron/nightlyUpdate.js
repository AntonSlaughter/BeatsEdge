// Runs once a day. Pulls box scores for games that finished yesterday
// (via our own stats.nba.com proxy — no external data cost), adds them
// to box_scores, then recomputes the defense-vs-position rollups.
//
// This is what keeps the DvP numbers current after the one-time Kaggle
// seed — the dataset grows on its own, for free, forever, as long as
// this server is running (Render free tier sleeps when idle but a cron
// tick will wake it; see README for the free "keep it ticking" note).

const db = require('../lib/db');
const { fetchScoreboardForDate, fetchBoxScoreTraditional } = require('../lib/statsProxy');
const { recomputeDefenseByPosition } = require('../lib/dvpEngine');

// Position lookup: stats.nba.com's boxscoretraditionalv2 does NOT include
// position in its player rows, so we maintain a small local override map
// for players it's ambiguous for, and fall back to a rough starter-slot
// heuristic otherwise. This is the one place a real backend would ideally
// pull from a proper roster/position feed (e.g. a `commonteamroster`
// call, cached) rather than guess — left as a documented TODO because it
// needs a second network round-trip per team we don't want to force on
// every single nightly run.
function guessPositionFallback() {
  // Intentionally conservative: without a roster lookup we cannot know
  // real position, so unmapped players are SKIPPED rather than guessed —
  // wrong positional data is worse than missing data for this stat.
  return null;
}

async function pullBoxScoresForDate(sport, dateStr) {
  const scoreboard = await fetchScoreboardForDate(sport, dateStr);
  const gameHeader = scoreboard.resultSets.find(rs => rs.name === 'GameHeader');
  if (!gameHeader) return { gamesFound: 0, rowsInserted: 0 };

  const gameIdIdx = gameHeader.headers.indexOf('GAME_ID');
  const gameIds = gameHeader.rowSet.map(r => r[gameIdIdx]);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO box_scores
      (sport, game_date, game_id, player_name, position, team, opponent, points, rebounds, assists, minutes, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nba-stats-nightly')
  `);

  let rowsInserted = 0;

  for (const gameId of gameIds) {
    try {
      const box = await fetchBoxScoreTraditional(sport, gameId);
      const playerStats = box.resultSets.find(rs => rs.name === 'PlayerStats');
      if (!playerStats) continue;

      const h = playerStats.headers;
      const idx = {
        team: h.indexOf('TEAM_ABBREVIATION'),
        player: h.indexOf('PLAYER_NAME'),
        pts: h.indexOf('PTS'),
        reb: h.indexOf('REB'),
        ast: h.indexOf('AST'),
        min: h.indexOf('MIN'),
        startPosition: h.indexOf('START_POSITION')
      };

      // Two teams present in one game's PlayerStats — figure out each
      // player's opponent by finding the other team abbreviation in this set.
      const teamsInGame = [...new Set(playerStats.rowSet.map(r => r[idx.team]))];

      playerStats.rowSet.forEach(row => {
        const team = row[idx.team];
        const opponent = teamsInGame.find(t => t !== team);
        if (!opponent) return;

        // START_POSITION is only populated for starters (G/F/C, coarse).
        // Bench players have blank position here — real deployments should
        // resolve this via a cached roster lookup. For now we only record
        // rows where we have a usable position, same "don't guess" policy
        // as the seed script.
        let position = row[idx.startPosition];
        if (position === 'G') position = null; // too coarse — see guessPositionFallback note
        else if (position === 'F') position = null;
        else if (position === 'C') position = 'C';
        else position = guessPositionFallback();

        if (!position) return;

        insert.run(
          sport, dateStr, gameId, row[idx.player], position, team, opponent,
          row[idx.pts] || 0, row[idx.reb] || 0, row[idx.ast] || 0, 0
        );
        rowsInserted++;
      });
    } catch (err) {
      console.warn(`[nightly] Failed box score for game ${gameId}:`, err.message);
    }
  }

  return { gamesFound: gameIds.length, rowsInserted };
}

async function runNightlyUpdate() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10);

  console.log(`[nightly] Starting update for ${dateStr}...`);
  let totalRows = 0;

  for (const sport of ['nba']) { // wnba scoreboardv2 path differs by season schedule; add once verified live
    try {
      const { gamesFound, rowsInserted } = await pullBoxScoresForDate(sport, dateStr);
      console.log(`[nightly] ${sport}: ${gamesFound} games, ${rowsInserted} player rows added`);
      totalRows += rowsInserted;
    } catch (err) {
      console.error(`[nightly] ${sport} pull failed (will retry next run):`, err.message);
    }
  }

  console.log('[nightly] Recomputing defense-vs-position aggregates...');
  const summary = recomputeDefenseByPosition('nba');
  console.log('[nightly] Recompute summary:', summary);

  db.prepare(`INSERT INTO ingest_log (run_type, rows_added, notes) VALUES ('nightly', ?, ?)`)
    .run(totalRows, `Date: ${dateStr}`);

  console.log('[nightly] Done.');
}

module.exports = { runNightlyUpdate, pullBoxScoresForDate };
