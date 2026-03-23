'use strict';

// server.js (CommonJS)
// Live server for FootballTracker snapshots + share & list pages

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

// In-memory snapshot store: token -> snapshot (last one wins)
const snapshots = new Map();

// Retention: keep matches visible for last N hours (default 24h)
const TTL_HOURS = Number(process.env.LIVE_TTL_HOURS || 24);
const TTL_MS = Number(process.env.LIVE_TTL_MS || TTL_HOURS * 60 * 60 * 1000);

// Helper: possession picker (supports old/new keys)
function pickPossession(obj = {}) {
  let h = 0;
  let a = 0;

  if (
    typeof obj.possessionHomePct === 'number' &&
    typeof obj.possessionAwayPct === 'number'
  ) {
    h = obj.possessionHomePct;
    a = obj.possessionAwayPct;
  } else if (
    obj.possession &&
    typeof obj.possession.homePct === 'number' &&
    typeof obj.possession.awayPct === 'number'
  ) {
    h = obj.possession.homePct;
    a = obj.possession.awayPct;
  } else if (
    typeof obj.possessionHome === 'number' &&
    typeof obj.possessionAway === 'number'
  ) {
    h = obj.possessionHome;
    a = obj.possessionAway;
  } else {
    h = 0;
    a = 0;
  }

  h = Math.max(0, Math.min(100, Number(h)));
  a = Math.max(0, Math.min(100, Number(a)));

  if (h + a !== 100) {
    a = 100 - h; // simple normalization
  }

  return { h, a };
}

function isFresh(rec) {
  if (!rec || !rec.updatedAt) return false;
  const t = Date.parse(rec.updatedAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < TTL_MS;
}

// Periodic cleanup to avoid unbounded growth
setInterval(() => {
  for (const [token, rec] of snapshots.entries()) {
    if (!isFresh(rec)) {
      snapshots.delete(token);
    }
  }
}, 15 * 60 * 1000); // every 15 minutes

// POST snapshot from the app (Bearer <token>)
app.post('/api/snapshot', (req, res) => {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.*)$/i);

  if (!m) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid token' });
  }

  const token = String(m[1] || '').trim();

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: empty token' });
  }

  const body = req.body || {};
  const nowISO = new Date().toISOString();
  const record = { ...body, updatedAt: nowISO };

  snapshots.set(token, record);

  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, updatedAt: nowISO });
});

// GET snapshot JSON by path parameter
app.get('/api/snapshot/:token', (req, res) => {
  const token = String(req.params.token || '').trim();
  const rec = snapshots.get(token);

  if (!rec) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }

  res.set('Cache-Control', 'no-store');
  res.json(rec);
});

// GET snapshot JSON by query parameter (?token=...)
app.get('/api/snapshot', (req, res) => {
  const token = String(req.query.token || '').trim();
  const rec = snapshots.get(token);

  if (!token || !rec) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }

  res.set('Cache-Control', 'no-store');
  res.json(rec);
});

// Alias JSON endpoint for share (optional)
app.get('/api/share/:token', (req, res) => {
  const token = String(req.params.token || '').trim();
  const rec = snapshots.get(token);

  if (!rec) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }

  res.set('Cache-Control', 'no-store');
  res.json(rec);
});

// API: list matches updated within TTL (default 24h)
app.get('/api/list', (req, res) => {
  const items = [];

  for (const [token, rec] of snapshots.entries()) {
    if (!isFresh(rec)) continue;

    const status = rec.status || (rec.isEnded ? 'final' : rec.isPaused ? 'paused' : 'live');

    items.push({
      token,
      home: rec.home || 'Koti',
      away: rec.away || 'Vieras',
      scoreHome: rec.scoreHome ?? 0,
      scoreAway: rec.scoreAway ?? 0,
      status,
      updatedAt: rec.updatedAt
    });
  }

  items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  res.set('Cache-Control', 'no-store');
  res.json({ ttlMs: TTL_MS, nowISO: new Date().toISOString(), items });
});

// Root -> redirect to /list for convenience
app.get('/', (req, res) => {
  res.redirect(302, '/list');
});

// Simple health endpoint
app.get('/health', (req, res) => {
  res.type('text/plain').send('OK');
});

// Share page with proper possession bar and 'Lopputulos' label
app.get('/share/:token', (req, res) => {
  const token = String(req.params.token || '').trim();
  const s = snapshots.get(token);

  if (!s) {
    return res.status(404).send('Snapshot not found');
  }

  const { h: homePossessionPercent, a: awayPossessionPercent } = pickPossession(s);

  const secs = Number(s.matchSeconds ?? 0);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  const clockStr = `${mm}:${ss}`;

  const status = s.status || (s.isEnded ? 'final' : s.isPaused ? 'paused' : 'live');
  const statusText = s.statusTextFi || (status === 'final' ? 'Lopputulos' : '');

  const homeHex = s.homeColorHex || '#FF3B30';
  const awayHex = s.awayColorHex || '#0A84FF';

  const metaLine = status === 'final' ? '' : `${s.half ?? 1}. puoliaika • ${clockStr}`;

  const html = `<!DOCTYPE html>
<html lang="fi">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Liveseuranta</title>
<style>
  :root { --glass-bg: rgba(255,255,255,0.7); --glass-border: rgba(0,0,0,0.08); --text:#111; --subtle:#666; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: linear-gradient(180deg, #f7f8fa, #eef3f7); color: var(--text); }
  .container { max-width: 860px; margin: 16px auto; padding: 16px; background: var(--glass-bg); border: 1px solid var(--glass-border); border-radius: 16px; box-shadow: 0 6px 20px rgba(0,0,0,0.06); }
  header { text-align: center; margin-bottom: 10px; }
  header .line { font-size: 24px; font-weight: 700; }
  header .status { margin-top: 4px; font-size: 13px; color: var(--subtle); min-height: 18px; }
  header .meta { margin-top: 6px; font-size: 12px; color: var(--subtle); }
  .possession { margin: 16px 0 8px; }
  .possession .bar { position: relative; height: 12px; background: rgba(0,0,0,0.1); border-radius: 999px; overflow: hidden; }
  .possession .fill { position: absolute; left: 0; top: 0; bottom: 0; width: ${homePossessionPercent}%; background: ${homeHex}CC; border-radius: 999px; transition: width 0.3s ease; }
  .possession .legend { display: flex; justify-content: space-between; font-size: 12px; margin-top: 6px; }
  .stats-grid { display: flex; gap: 24px; margin-top: 14px; }
  .side { flex: 1 1 0; }
  .side h3 { margin: 0 0 6px; font-size: 15px; font-weight: 700; }
  .item { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #222; }
  .item .val { margin-left: auto; font-weight: 600; }
</style>
</head>
<body>
  <div class="container" role="main" aria-label="Match Quick Stats">
    <header>
      <div class="line">${s.home ?? 'Koti'} ${s.scoreHome ?? 0} – ${s.scoreAway ?? 0} ${s.away ?? 'Vieras'}</div>
      <div class="status">${statusText}</div>
      <div class="meta">${metaLine}</div>
    </header>

    <section class="possession" aria-label="Pallonhallinta">
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${homePossessionPercent}">
        <div class="fill" id="posFill"></div>
      </div>
      <div class="legend">
        <span id="posHome">${s.home ?? 'Koti'} ${homePossessionPercent}%</span>
        <span id="posAway">${s.away ?? 'Vieras'} ${awayPossessionPercent}%</span>
      </div>
    </section>

    <section class="stats-grid">
      <div class="side" style="color:${homeHex}">
        <h3>${s.home ?? 'Koti'}</h3>
        <div class="item">🎯 xG <span class="val" id="homeXG">${Number(s.homeXG || 0).toFixed(2)}</span></div>
        <div class="item">⚽️ Laukaukset <span class="val" id="homeShots">${s.homeShots ?? 0}</span></div>
        <div class="item">🚩 Kulmapotkut <span class="val" id="homeCorners">${s.homeCorners ?? 0}</span></div>
      </div>
      <div class="side" style="text-align:right; color:${awayHex}">
        <h3>${s.away ?? 'Vieras'}</h3>
        <div class="item">🎯 xG <span class="val" id="awayXG">${Number(s.awayXG || 0).toFixed(2)}</span></div>
        <div class="item">⚽️ Laukaukset <span class="val" id="awayShots">${s.awayShots ?? 0}</span></div>
        <div class="item">🚩 Kulmapotkut <span class="val" id="awayCorners">${s.awayCorners ?? 0}</span></div>
      </div>
    </section>
  </div>

  <script>
    function pad(n) {
      return String(n).padStart(2, '0');
    }

    function mmss(sec) {
      sec = Math.max(0, sec | 0);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return pad(m) + ':' + pad(s);
    }

    function pickPct(obj) {
      if (typeof obj.possessionHomePct === 'number' && typeof obj.possessionAwayPct === 'number') {
        return { home: obj.possessionHomePct, away: obj.possessionAwayPct };
      }
      if (obj.possession && typeof obj.possession.homePct === 'number' && typeof obj.possession.awayPct === 'number') {
        return { home: obj.possession.homePct, away: obj.possession.awayPct };
      }
      if (typeof obj.possessionHome === 'number' && typeof obj.possessionAway === 'number') {
        return { home: obj.possessionHome, away: obj.possessionAway };
      }
      return { home: 0, away: 0 };
    }

    const token = ${JSON.stringify(token)};

    async function refresh() {
      try {
        const res = await fetch('/api/snapshot/' + encodeURIComponent(token));
        if (!res.ok) return;

        const data = await res.json();

        // Scoreline & status
        document.querySelector('header .line').textContent =
          (data.home ?? 'Koti') + ' ' +
          (data.scoreHome ?? 0) + ' – ' +
          (data.scoreAway ?? 0) + ' ' +
          (data.away ?? 'Vieras');

        const status = data.status || (data.isEnded ? 'final' : data.isPaused ? 'paused' : 'live');
        const statusText = data.statusTextFi || (status === 'final' ? 'Lopputulos' : '');

        document.querySelector('header .status').textContent = statusText || '';
        document.querySelector('header .meta').textContent =
          status === 'final' ? '' : ((data.half ?? 1) + '. puoliaika • ' + mmss(data.matchSeconds ?? 0));

        // Possession
        const pct = pickPct(data);
        const homePct = Math.max(0, Math.min(100, pct.home | 0));
        const awayPct = Math.max(0, Math.min(100, pct.away | 0));

        const fill = document.getElementById('posFill');
        fill.style.width = homePct + '%';
        fill.style.background = (data.homeColorHex || '#0A84FF') + 'CC';

        document.getElementById('posHome').textContent = (data.home ?? 'Koti') + ' ' + homePct + '%';
        document.getElementById('posAway').textContent = (data.away ?? 'Vieras') + ' ' + awayPct + '%';

        // Quick stats
        document.getElementById('homeXG').textContent = Number(data.homeXG || 0).toFixed(2);
        document.getElementById('awayXG').textContent = Number(data.awayXG || 0).toFixed(2);
        document.getElementById('homeShots').textContent = String(data.homeShots ?? '0');
        document.getElementById('awayShots').textContent = String(data.awayShots ?? '0');
        document.getElementById('homeCorners').textContent = String(data.homeCorners ?? '0');
        document.getElementById('awayCorners').textContent = String(data.awayCorners ?? '0');
      } catch (e) {
        // ignore
      }
    }

    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
});

// List page: shows matches updated within TTL (default 24h)
app.get('/list', (req, res) => {
  const items = [];

  for (const [token, rec] of snapshots.entries()) {
    if (!isFresh(rec)) continue;

    const status = rec.status || (rec.isEnded ? 'final' : rec.isPaused ? 'paused' : 'live');

    items.push({
      token,
      home: rec.home || 'Koti',
      away: rec.away || 'Vieras',
      scoreHome: rec.scoreHome ?? 0,
      scoreAway: rec.scoreAway ?? 0,
      status,
      updatedAt: rec.updatedAt
    });
  }

  items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const html = `<!doctype html>
<html lang="fi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Liveseuranta – Ottelulista</title>
  <meta http-equiv="refresh" content="15" />
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f7f8fa; color: #111; }
    .wrap { max-width: 900px; margin: 20px auto; padding: 0 16px; }
    h1 { font-size: 22px; margin: 6px 0 12px; }
    .hint { color: #666; font-size: 13px; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; background: rgba(255,255,255,0.9); border: 1px solid rgba(0,0,0,0.08); border-radius: 12px; overflow: hidden; }
    th, td { padding: 10px 12px; border-bottom: 1px solid rgba(0,0,0,0.06); font-size: 14px; }
    th { background: rgba(0,0,0,0.04); text-align: left; }
    tr:last-child td { border-bottom: none; }
    .status { font-size: 12px; color: #666; }
    .links a { margin-right: 8px; font-size: 13px; }
    .empty { padding: 12px 0; color: #666; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Liveseuranta – ottelut (${items.length})</h1>
    <div class="hint">Näytetään ottelut, joita on päivitetty viimeisen ${TTL_HOURS} tunnin aikana.</div>
    ${
      items.length === 0
        ? '<div class="empty">Ei aktiivisia otteluita. Päivitä sivu hetken päästä tai aloita uusi liveseuranta sovelluksesta.</div>'
        : `<table>
            <thead>
              <tr>
                <th>Ottelu</th>
                <th>Tulos</th>
                <th>Status</th>
                <th>Päivitetty</th>
                <th>Linkit</th>
              </tr>
            </thead>
            <tbody>
              ${items.map((i) => {
                const d = new Date(i.updatedAt);
                const dateStr = d.toLocaleString('fi-FI', { dateStyle: 'short', timeStyle: 'medium' });
                const score = `${i.scoreHome} – ${i.scoreAway}`;
                const statusFi = i.status === 'final' ? 'Lopputulos' : (i.status === 'paused' ? 'Tauko' : 'Käynnissä');
                const tok = encodeURIComponent(i.token);

                return `<tr>
                  <td>${i.home} – ${i.away}</td>
                  <td>${score}</td>
                  <td class="status">${statusFi}</td>
                  <td class="status">${dateStr}</td>
                  <td class="links">
                    <a href="/share/${tok}">Share-sivu</a>
                    <a href="/api/snapshot/${tok}">JSON</a>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>`
    }
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
});

// Optional: serve static assets if you add a /public folder later
app.use(express.static(path.join(__dirname, 'public')));

// Port (Render.com usually provides PORT)
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
