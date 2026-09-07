// api-web.nhle.com is free, keyless, and commonly used directly from
// browsers by hobbyist projects (see NHL-API-Reference on GitHub). This
// module exists for the same reason MLB's does: computing rollups needs
// server-side storage, not because the API itself requires a proxy.

const BASE = 'https://api-web.nhle.com/v1';

async function fetchSchedule(dateStr /* YYYY-MM-DD */) {
  const url = `${BASE}/schedule/${dateStr}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NHL schedule fetch failed: HTTP ${res.status}`);
  return res.json();
}

async function fetchBoxscore(gameId) {
  const url = `${BASE}/gamecenter/${gameId}/boxscore`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NHL boxscore fetch failed: HTTP ${res.status}`);
  return res.json();
}

module.exports = { fetchSchedule, fetchBoxscore };
