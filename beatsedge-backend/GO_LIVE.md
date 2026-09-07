# Going Live — Exact Checklist

I've done all the code work possible. Everything below this point requires
your own accounts and clicks — I have no browser access and can't create
accounts or push to GitHub on your behalf. This is the exact, minimal path.

**Total time: ~15 minutes.**

---

## Step 1 — Push the backend to GitHub (~3 min)

You need a place for Render to pull code from.

```bash
cd beatsedge-backend
git init
git add .
git commit -m "Initial commit"
```

Then on [github.com](https://github.com): New repository → don't
initialize with a README (you already have one) → copy the commands it
shows you under "…or push an existing repository":

```bash
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

## Step 2 — Deploy to Render (~5 min, free, no card)

1. Go to [render.com](https://render.com) → sign up (GitHub login is fastest)
2. **New +** → **Web Service** → connect the repo you just pushed
3. Settings:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
4. Click **Create Web Service**. Render will build and deploy — takes
   2-3 minutes the first time.
5. When it's done, copy the URL at the top of the page. It looks like:
   `https://beatsedge-backend-xxxx.onrender.com`

## Step 3 — Point BeatsEdge.html at it (~30 seconds)

1. Open `BeatsEdge.html` in your browser
2. Click **⚙️ Data Sources** in the header
3. Paste your Render URL into **"Your Backend"**
4. Click **Save & Refresh**

That's it. The app will now call your live backend for NBA/NFL/MLB/NHL
defense and matchup data instead of sample numbers.

## Step 4 — Optional: add your BallDontLie key too (~1 min)

Same settings panel, paste your free BallDontLie key into that field
too. Powers real NBA season/L5/L10 stat averages.

---

## What to expect immediately after deploying

- **NBA and NFL**: real data right away — both have historical seeds
  already baked into the committed `data/beatsedge.db`.
- **MLB and NHL**: start closer to empty. No bulk historical dataset was
  available for either in this project, so their `defense-by-position`
  and rollup numbers fill in gradually as the nightly cron ingests real
  games — meaningful data within the first week, fuller after a few.
- **The nightly cron runs automatically** at 6am UTC, plus once ~10
  seconds after every boot (so a fresh deploy doesn't wait a full day
  for its first attempt).

## One real thing to watch for

During my own testing, `stats.nba.com` and `statsapi.mlb.com` both
returned genuine HTTP 403s when called from this sandbox — not a CORS
issue, an IP-reputation thing some hosts apply to cloud/datacenter
ranges. **Render's IP might hit the same wall, or it might not** — I
can't test that from here. If you check `/api/health` after deploying
and `lastIngest` keeps showing 0 rows added, that's what's happening.

**It won't break anything either way** — every source in this app has a
tested fallback (ESPN, ESPN scoreboard, or sample data), so the app
stays usable regardless. If you do hit this wall and want it fixed,
tell me the exact error from Render's logs and I'll help adjust the
approach (a common fix is trying a different header set, or routing
through a residential-IP proxy service).

## How to check it's actually working

Once deployed, visit these directly in your browser (replace with your
real Render URL):

```
https://your-app.onrender.com/api/health
```
Should show `{"ok":true, "lastIngest": {...}}`. If `lastIngest` is null,
the server booted but the first cron pass hasn't run yet — wait ~15 seconds
and refresh.

```
https://your-app.onrender.com/api/defense/by-position/nba/BOS?window=season
```
Should return real Boston Celtics defensive numbers immediately (this
data is already seeded, doesn't depend on the nightly cron working).

---

## If something doesn't work

Send me:
1. What you see at `/api/health`
2. Any error text from Render's deploy logs (Render's dashboard has a
   "Logs" tab)
3. What BeatsEdge.html's Data Sources panel shows for each source pill

That's enough for me to diagnose without needing to see it myself.
