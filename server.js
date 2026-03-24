'use strict';

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

// matchId -> latest snapshot for that match
const matches = new Map();

// token -> Set of matchIds
const tokenToMatchIds = new Map();

// Keep matches visible for last N hours
const TTL_HOURS = Number(process.env.LIVE_TTL_HOURS || 24);
const TTL_MS = Number(process.env.LIVE_TTL_MS || TTL_HOURS * 60 * 60 * 1000);

function slugify(str = '') {
  return String(str)
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Fallback Match ID (käytetään vain jos client ei toimita MatchID:tä)
function buildMatchId(obj = {}) {
  const home = slugify(obj.home || obj.homeTeam || 'koti');
  const away = slugify(obj.away || obj.awayTeam || 'vieras');
  return `${home}__${away}`;
}

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
  }

  h = Math.max(0, Math.min(100, Number(h)));
  a = Math.max(0, Math.min(100, Number(a)));

  if (h + a !== 100) {
    a = 100 - h;
  }

  return { h, a };
}

function getStatus(rec = {}) {
  return rec.status || (rec.isEnded ? 'final' : (rec.isPaused ? 'paused' : 'live'));
}

function isFresh(rec) {
  if (!rec || !rec.updatedAt) return false;
  const t = Date.parse(rec.updatedAt);
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) < TTL_MS;
}

function getMatchesForToken(token = '') {
  const key = String(token || '').trim();
  if (!key) return [];

  const ids = tokenToMatchIds.get(key);
  if (!ids || ids.size === 0) return [];

  const out = [];
  for (const matchId of ids) {
    const rec = matches.get(matchId);
    if (rec && isFresh(rec)) {
      out.push(rec);
    }
  }

  out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return out;
}

function getMatchByIdentifier(id = '') {
  const key = String(id || '').trim();
  if (!key) return null;

  if (matches.has(key)) {
    const rec = matches.get(key);
    return isFresh(rec) ? rec : null;
  }

  const tokenMatches = getMatchesForToken(key);
  if (tokenMatches.length === 1) {
    return tokenMatches[0];
  }

  return null;
}

function listFreshMatches() {
  const items = [];

  for (const [matchId, rec] of matches.entries()) {
    if (!isFresh(rec)) continue;

    items.push({
      matchId,
      token: rec.token || '',
      home: rec.home || rec.homeTeam || 'Koti',
      away: rec.away || rec.awayTeam || 'Vieras',
      scoreHome: rec.scoreHome ?? 0,
      scoreAway: rec.scoreAway ?? 0,
      status: getStatus(rec),
      updatedAt: rec.updatedAt
    });
  }

  items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return items;
}

function attachMatchToToken(token, matchId) {
  let ids = tokenToMatchIds.get(token);
  if (!ids) {
    ids = new Set();
    tokenToMatchIds.set(token, ids);
  }
  ids.add(matchId);
}

function removeMatchFromToken(token, matchId) {
  const ids = tokenToMatchIds.get(token);
  if (!ids) return;
  ids.delete(matchId);
  if (ids.size === 0) {
    tokenToMatchIds.delete(token);
  }
}

// Cleanup old matches every 15 min
setInterval(() => {
  for (const [matchId, rec] of matches.entries()) {
    if (!isFresh(rec)) {
      matches.delete(matchId);
      if (rec && rec.token) {
        removeMatchFromToken(rec.token, matchId);
      }
    }
  }

  for (const [token, ids] of tokenToMatchIds.entries()) {
    for (const matchId of ids) {
      const rec = matches.get(matchId);
      if (!rec || !isFresh(rec)) {
        ids.delete(matchId);
      }
    }
    if (ids.size === 0) {
      tokenToMatchIds.delete(token);
    }
  }
}, 15 * 60 * 1000);

function renderSharePage(res, s, originalId) {
  const { h: homePossessionPercent, a: awayPossessionPercent } = pickPossession(s);

  const secs = Number(s.matchSeconds ?? 0);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  const clockStr = `${mm}:${ss}`;

  const status = getStatus(s);
  const statusText = s.statusTextFi || (status === 'final' ? 'Lopputulos' : '');

  const homeHex = s.homeColorHex || '#FF3B30';
  const awayHex = s.awayColorHex || '#0A84FF';
  const metaLine = status === 'final' ? '' : `${s.half ?? 1}. puoliaika • ${clockStr}`;

  // Important:
  // - if user opened /share/<token>, keep refreshing by token
  // - if user opened /share/<matchId>, refresh by matchId
  const refreshId = originalId || s.matchId;

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

    const id = ${JSON.stringify(refreshId)};

    async function refresh() {
      try {
        const res = await fetch('/api/snapshot/' + encodeURIComponent(id), {
          cache: 'no-store'
        });

        // If token now has multiple matches, reload page so /share/<token>
        // becomes the selection page.
        if (res.status === 409) {
          window.location.reload();
          return;
        }

        // If current match/token no longer resolves, reload.
        if (res.status === 404) {
          window.location.reload();
          return;
        }

        if (!res.ok) return;

        const data = await res.json();

        document.querySelector('header .line').textContent =
          (data.home ?? 'Koti') + ' ' +
          (data.scoreHome ?? 0) + ' – ' +
          (data.scoreAway ?? 0) + ' ' +
          (data.away ?? 'Vieras');

        const status = data.status || (data.isEnded ? 'final' : (data.isPaused ? 'paused' : 'live'));
        const statusText = data.statusTextFi || (status === 'final' ? 'Lopputulos' : '');

        document.querySelector('header .status').textContent = statusText || '';
        document.querySelector('header .meta').textContent =
          status === 'final' ? '' : ((data.half ?? 1) + '. puoliaika • ' + mmss(data.matchSeconds ?? 0));

        const pct = pickPct(data);
        const homePct = Math.max(0, Math.min(100, pct.home | 0));
        const awayPct = Math.max(0, Math.min(100, pct.away | 0));

        const fill = document.getElementById('posFill');
        fill.style.width = homePct + '%';
        fill.style.background = (data.homeColorHex || '#0A84FF') + 'CC';

        document.getElementById('posHome').textContent = (data.home ?? 'Koti') + ' ' + homePct + '%';
        document.getElementById('posAway').textContent = (data.away ?? 'Vieras') + ' ' + awayPct + '%';

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
}

// POST snapshot from app
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
  const home = String(body.home || body.homeTeam || '').trim();
  const away = String(body.away || body.awayTeam || '').trim();

  if (!home || !away) {
    return res.status(400).json({
      error: 'Missing team names: home and away are required'
    });
  }

  // Prefer client-provided MatchID (header or body), fallback to slug
  const headerMatchId = String(req.headers['x-match-id'] || req.headers['x-matchid'] || '').trim();
  const bodyMatchId = String(body.matchID || body.matchId || '').trim();
  const providedMatchId = headerMatchId || bodyMatchId;

  const matchId = providedMatchId || buildMatchId({ ...body, home, away });
  const nowISO = new Date().toISOString();

  const prev = matches.get(matchId) || {};
  const prevToken = prev.token ? String(prev.token) : '';

  const record = {
    ...prev,
    ...body,
    home,
    away,
    token,
    matchId,
    updatedAt: nowISO
  };

  matches.set(matchId, record);

  if (prevToken && prevToken !== token) {
    removeMatchFromToken(prevToken, matchId);
  }

  attachMatchToToken(token, matchId);

  console.log('SNAPSHOT IN', {
    token,
    home,
    away,
    matchId,
    providedMatchId,
    headerMatchId
  });

  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    token,
    matchId,
    shareUrl: `/share/${matchId}`,
    tokenShareUrl: `/share/${token}`,
    updatedAt: nowISO
  });
});

// GET snapshot JSON by identifier
app.get('/api/snapshot/:id', (req, res) => {
  const id = String(req.params.id || '').trim();

  if (matches.has(id)) {
    const rec = matches.get(id);
    if (!rec || !isFresh(rec)) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }
    res.set('Cache-Control', 'no-store');
    return res.json(rec);
  }

  const tokenMatches = getMatchesForToken(id);

  if (tokenMatches.length === 1) {
    res.set('Cache-Control', 'no-store');
    return res.json(tokenMatches[0]);
  }

  if (tokenMatches.length > 1) {
    return res.status(409).json({
      error: 'Multiple matches found for token',
      items: tokenMatches.map((m) => ({
        matchId: m.matchId,
        home: m.home || 'Koti',
        away: m.away || 'Vieras',
        scoreHome: m.scoreHome ?? 0,
        scoreAway: m.scoreAway ?? 0,
        status: getStatus(m),
        updatedAt: m.updatedAt
      }))
    });
  }

  return res.status(404).json({ error: 'Snapshot not found' });
});

// GET snapshot JSON by query parameter (?matchId=... or ?token=...)
app.get('/api/snapshot', (req, res) => {
  const matchId = String(req.query.matchId || '').trim();
  const token = String(req.query.token || '').trim();

  if (matchId) {
    const rec = matches.get(matchId);
    if (!rec || !isFresh(rec)) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }
    res.set('Cache-Control', 'no-store');
    return res.json(rec);
  }

  if (token) {
    const tokenMatches = getMatchesForToken(token);

    if (tokenMatches.length === 1) {
      res.set('Cache-Control', 'no-store');
      return res.json(tokenMatches[0]);
    }

    if (tokenMatches.length > 1) {
      return res.status(409).json({
        error: 'Multiple matches found for token',
        items: tokenMatches.map((m) => ({
          matchId: m.matchId,
          home: m.home || 'Koti',
          away: m.away || 'Vieras',
          scoreHome: m.scoreHome ?? 0,
          scoreAway: m.scoreAway ?? 0,
          status: getStatus(m),
          updatedAt: m.updatedAt
        }))
      });
    }
  }

  return res.status(404).json({ error: 'Snapshot not found' });
});

// Alias JSON endpoint
app.get('/api/share/:id', (req, res) => {
  const rec = getMatchByIdentifier(req.params.id || '');
  if (!rec) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }
  res.set('Cache-Control', 'no-store');
  res.json(rec);
});

app.get('/api/list', (req, res) => {
  const items = listFreshMatches();
  res.set('Cache-Control', 'no-store');
  res.json({ ttlMs: TTL_MS, nowISO: new Date().toISOString(), items });
});

app.get('/', (req, res) => {
  res.redirect(302, '/list');
});

app.get('/health', (req, res) => {
  res.type('text/plain').send('OK');
});

// Share page
app.get('/share/:id', (req, res) => {
  const id = String(req.params.id || '').trim();

  // Direct matchId
  if (matches.has(id)) {
    const rec = matches.get(id);
    if (!rec || !isFresh(rec)) {
      return res.status(404).send('Snapshot not found');
    }
    return renderSharePage(res, rec, id);
  }

  // Token
  const tokenMatches = getMatchesForToken(id);

  if (tokenMatches.length === 0) {
    return res.status(404).send('Snapshot not found');
  }

  if (tokenMatches.length === 1) {
    return renderSharePage(res, tokenMatches[0], id);
  }

  // Multiple matches for token -> selection page
  const html = `<!doctype html>
<html lang="fi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Valitse ottelu</title>
  <meta http-equiv="refresh" content="15" />
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f7f8fa; color: #111; }
    .wrap { max-width: 900px; margin: 20px auto; padding: 0 16px; }
    h1 { font-size: 22px; margin: 6px 0 12px; }
    .hint { color: #666; font-size: 13px; margin-bottom: 12px; }
    .card { background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 12px; padding: 14px; margin-bottom: 10px; }
    .line { font-size: 18px; font-weight: 700; margin-bottom: 6px; }
    .meta { font-size: 13px; color: #666; margin-bottom: 8px; }
    a { font-size: 14px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Valitse ottelu</h1>
    <div class="hint">Tällä tokenilla on useita aktiivisia otteluita.</div>
    ${tokenMatches.map((s) => {
      const status = getStatus(s);
      const statusFi = status === 'final' ? 'Lopputulos' : (status === 'paused' ? 'Tauko' : 'Käynnissä');
      return `<div class="card">
        <div class="line">${s.home ?? 'Koti'} ${s.scoreHome ?? 0} – ${s.scoreAway ?? 0} ${s.away ?? 'Vieras'}</div>
        <div class="meta">${statusFi}</div>
        <a href="/share/${encodeURIComponent(s.matchId)}">Avaa ottelu</a>
      </div>`;
    }).join('')}
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
});

// List page
app.get('/list', (req, res) => {
  const items = listFreshMatches();

  const html = `<!doctype html>
<html lang="fi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Liveseuranta – Ottelulista</title>
  <meta http-equiv="refresh" content="15" />
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f7f8fa; color: #111; }
    .wrap { max-width: 980px; margin: 20px auto; padding: 0 16px; }
    h1 { font-size: 22px; margin: 6px 0 12px; }
    .hint { color: #666; font-size: 13px; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; background: rgba(255,255,255,0.9); border: 1px solid rgba(0,0,0,0.08); border-radius: 12px; overflow: hidden; }
    th, td { padding: 10px 12px; border-bottom: 1px solid rgba(0,0,0,0.06); font-size: 14px; vertical-align: top; }
    th { background: rgba(0,0,0,0.04); text-align: left; }
    tr:last-child td { border-bottom: none; }
    .status { font-size: 12px; color: #666; }
    .links a { margin-right: 8px; font-size: 13px; }
    .empty { padding: 12px 0; color: #666; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: #666; }
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
                const mid = encodeURIComponent(i.matchId);
                const tok = encodeURIComponent(i.token || '');

                return `<tr>
                  <td>
                    <div>${i.home} – ${i.away}</div>
                    <div class="mono">${i.matchId}</div>
                  </td>
                  <td>${score}</td>
                  <td class="status">${statusFi}</td>
                  <td class="status">${dateStr}</td>
                  <td class="links">
                    <a href="/share/${mid}">Share-sivu</a>
                    ${i.token ? `<a href="/share/${tok}">Token-sivu</a>` : ''}
                    <a href="/api/snapshot/${mid}">JSON</a>
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

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
