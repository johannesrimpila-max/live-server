import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const snapshots = new Map();

app.post("/api/snapshot", (req, res) => {
  const auth = req.headers["authorization"] || "";
  const prefix = "Bearer ";
  if (!auth.startsWith(prefix)) {
    return res.status(401).json({ error: "Unauthorized: missing or invalid token" });
  }
  const token = auth.slice(prefix.length).trim();
  const body = req.body || {};
  snapshots.set(token, { ...body, updatedAt: new Date().toISOString() });
  res.json({ ok: true });
});

app.get("/api/snapshot/:token", (req, res) => {
  const token = req.params.token;
  if (!snapshots.has(token)) {
    return res.status(404).json({ error: "Snapshot not found" });
  }
  res.json(snapshots.get(token));
});

app.get("/share/:token", (req, res) => {
  const token = req.params.token;
  if (!snapshots.has(token)) {
    return res.status(404).send("Snapshot not found");
  }
  const s = snapshots.get(token);

  const homePossessionPercent = Math.max(0, Math.min(100, Number(s.possessionHomePct ?? 0)));
  const awayPossessionPercent = 100 - homePossessionPercent;

  const secs = Number(s.matchSeconds ?? 0);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  const clockStr = `${mm}:${ss}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Quick Stats Share</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
    margin: 0;
    background: #fff;
    color: #222;
  }
  .container {
    max-width: 600px;
    margin: 16px auto;
    border: 1px solid #ccc;
    border-radius: 8px;
    padding: 16px;
  }
  header {
    text-align: center;
    margin-bottom: 12px;
  }
  header h1 {
    margin: 0;
    font-size: 1.5rem;
  }
  header .date {
    font-size: 0.9rem;
    color: #666;
    margin-top: 4px;
  }
  .teams {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 600;
    font-size: 1.3rem;
  }
  .score {
    font-size: 2rem;
    font-weight: 700;
  }
  .final-label { margin-top: 4px; }
  .clock {
    text-align: center;
    font-size: 1.1rem;
    margin-top: 8px;
    font-weight: 500;
  }
  .possession-bar {
    margin: 20px 0;
    height: 24px;
    background: #ddd;
    border-radius: 12px;
    overflow: hidden;
    display: flex;
  }
  .possession-home {
    height: 100%;
    background-color: ${s.homeColorHex};
    width: ${homePossessionPercent}%;
    transition: width 0.3s ease;
  }
  .possession-away {
    height: 100%;
    background-color: ${s.awayColorHex};
    width: ${awayPossessionPercent}%;
    transition: width 0.3s ease;
  }
  .stats-row {
    display: flex;
    justify-content: space-between;
    font-weight: 600;
    font-size: 1rem;
    margin-top: 12px;
  }
  .stats-row .label {
    flex: 1 1 33%;
    text-align: center;
    color: #444;
  }
  .stats-row .value {
    flex: 1 1 33%;
    text-align: center;
  }
  .stats-header {
    display: flex;
    justify-content: space-between;
    margin-top: 24px;
    font-weight: 600;
    font-size: 1rem;
  }
</style>
</head>
<body>
  <div class="container" role="main" aria-label="Match Quick Stats">
    <header>
      <h1>${s.home} vs ${s.away}</h1>
      <div class="date">${new Date(s.dateISO).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })}</div>
    </header>

    <div class="teams" aria-label="Teams and score">
      <div class="team home" style="color: ${s.homeColorHex}">${s.home}</div>
      <div class="score" aria-live="polite">${s.scoreHome} - ${s.scoreAway}</div>
      ${s.isEnded ? '<div class="final-label" style="text-align:center;color:#666;font-size:0.9rem;">Final</div>' : ''}
      <div class="team away" style="color: ${s.awayColorHex}">${s.away}</div>
    </div>
    <div class="clock" aria-live="polite" aria-atomic="true">${clockStr}</div>

    <div class="possession-bar" aria-label="Possession bar">
      <div
        class="possession-home"
        style="width:${homePossessionPercent}%;background-color:${s.homeColorHex}"
        aria-valuenow="${homePossessionPercent.toFixed(
          0
        )}" aria-valuemin="0" aria-valuemax="100" role="progressbar"
        aria-label="Home possession"
      ></div>
      <div
        class="possession-away"
        style="width:${awayPossessionPercent}%;background-color:${s.awayColorHex}"
        aria-label="Away possession"
      ></div>
    </div>

    <div class="stats-header" role="row">
      <div class="label" role="columnheader" aria-colindex="1">Statistic</div>
      <div class="label" role="columnheader" aria-colindex="2">${s.home}</div>
      <div class="label" role="columnheader" aria-colindex="3">${s.away}</div>
    </div>

    <div class="stats-row" role="row">
      <div class="label" role="cell">xG</div>
      <div class="value" role="cell">${s.homeXG.toFixed(2)}</div>
      <div class="value" role="cell">${s.awayXG.toFixed(2)}</div>
    </div>

    <div class="stats-row" role="row">
      <div class="label" role="cell">Shots</div>
      <div class="value" role="cell">${s.homeShots}</div>
      <div class="value" role="cell">${s.awayShots}</div>
    </div>

    <div class="stats-row" role="row">
      <div class="label" role="cell">Corners</div>
      <div class="value" role="cell">${s.homeCorners}</div>
      <div class="value" role="cell">${s.awayCorners}</div>
    </div>
  </div>

  <script>
    // Poll every 2 seconds to update stats
    function mmss(total) {
      total = Math.max(0, total|0);
      const m = String(Math.floor(total / 60)).padStart(2, '0');
      const s = String(total % 60).padStart(2, '0');
      return m + ':' + s;
    }
    const token = ${JSON.stringify(token)};
    async function fetchStats() {
      try {
        const res = await fetch('/api/snapshot/' + token);
        if (!res.ok) return;
        const data = await res.json();
        // Update DOM with any changed values

        document.querySelector('header h1').textContent = data.home + ' vs ' + data.away;
        document.querySelector('header .date').textContent = new Date(data.dateISO).toLocaleString(undefined, {dateStyle:'medium',timeStyle:'short'});
        document.querySelector('.teams .team.home').textContent = data.home;
        document.querySelector('.teams .team.home').style.color = data.homeColorHex;
        document.querySelector('.teams .team.away').textContent = data.away;
        document.querySelector('.teams .team.away').style.color = data.awayColorHex;
        document.querySelector('.score').textContent = (data.scoreHome ?? 0) + ' - ' + (data.scoreAway ?? 0);
        document.querySelector('.clock').textContent = mmss(data.matchSeconds ?? 0);

        // Possession calculation
        let homePossessionPercent = 50;
        if ((data.homeXG ?? 0) + (data.awayXG ?? 0) > 0) {
          homePossessionPercent = ((data.homeXG ?? 0) / ((data.homeXG ?? 0) + (data.awayXG ?? 0))) * 100;
        } else if ((data.homeShots ?? 0) + (data.awayShots ?? 0) > 0) {
          homePossessionPercent = ((data.homeShots ?? 0) / ((data.homeShots ?? 0) + (data.awayShots ?? 0))) * 100;
        }
        const awayPossessionPercent = 100 - homePossessionPercent;

        const possessionHomeEl = document.querySelector('.possession-home');
        const possessionAwayEl = document.querySelector('.possession-away');
        possessionHomeEl.style.width = homePossessionPercent + '%';
        possessionHomeEl.style.backgroundColor = data.homeColorHex;
        possessionHomeEl.setAttribute('aria-valuenow', homePossessionPercent.toFixed(0));
        possessionAwayEl.style.width = awayPossessionPercent + '%';
        possessionAwayEl.style.backgroundColor = data.awayColorHex;

        // Stats update
        const stats = [
          { label: 'xG', home: data.homeXG.toFixed(2), away: data.awayXG.toFixed(2) },
          { label: 'Shots', home: data.homeShots, away: data.awayShots },
          { label: 'Corners', home: data.homeCorners, away: data.awayCorners },
        ];

        const rows = document.querySelectorAll('.stats-row');
        stats.forEach((stat, i) => {
          rows[i].children[0].textContent = stat.label;
          rows[i].children[1].textContent = stat.home;
          rows[i].children[2].textContent = stat.away;
        });

      } catch (e) {
        // fail silently
      }
    }
    setInterval(fetchStats, 2000);
  </script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

// Render deploy expects port from env or default 10000
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
