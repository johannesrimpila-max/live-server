'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json({ limit: '1mb' }));

// In-memory live matches
// matchId -> latest snapshot
const matches = new Map();

// token -> Set of matchIds
const tokenToMatchIds = new Map();

// Live visibility TTL
const TTL_DAYS = Number(process.env.LIVE_TTL_DAYS || 7);
const TTL_MS = Number(process.env.LIVE_TTL_MS || TTL_DAYS * 24 * 60 * 60 * 1000);

// Persistent final results
const FINAL_DB_PATH =
  process.env.FINAL_DB_PATH || path.join(__dirname, 'data', 'final-results.sqlite');

const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();

fs.mkdirSync(path.dirname(FINAL_DB_PATH), { recursive: true });

const db = new sqlite3.Database(FINAL_DB_PATH);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function initDb() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS final_results (
      match_id TEXT PRIMARY KEY,
      token TEXT,
      home TEXT NOT NULL,
      away TEXT NOT NULL,
      score_home INTEGER NOT NULL DEFAULT 0,
      score_away INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_final_results_updated_at
    ON final_results(updated_at DESC)
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_final_results_deleted_at
    ON final_results(deleted_at)
  `);
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(str = '') {
  return String(str)
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildMatchId(obj = {}) {
  const home = slugify(obj.home || obj.homeTeam || 'koti');
  const away = slugify(obj.away || obj.awayTeam || 'vieras');
  return `${home}__${away}`;
}

function pickIncomingMatchId(req, body = {}) {
  const bodyMatchId = String(body.matchId || '').trim();
  const bodyMatchID = String(body.matchID || '').trim();
  const headerMatchId = String(req.headers['x-match-id'] || '').trim();

  return bodyMatchId || bodyMatchID || headerMatchId || buildMatchId(body);
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
    a = Math.max(0, 100 - h);
  }

  return { h, a };
}

function getStatus(rec = {}) {
  return rec.status || (rec.isEnded ? 'final' : (rec.isPaused ? 'paused' : 'live'));
}

function statusLabelFi(status) {
  if (status === 'final') return 'Lopputulos';
  if (status === 'paused') return 'Tauko';
  return 'Käynnissä';
}

function isFresh(rec) {
  if (!rec || !rec.updatedAt) return false;
  const t = Date.parse(rec.updatedAt);
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) < TTL_MS;
}

function attachMatchToToken(token, matchId) {
  if (!token) return;

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

function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.*)$/i);
  if (!m) return '';
  return String(m[1] || '').trim();
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: 'ADMIN_TOKEN is not configured' });
  }

  const token = getBearerToken(req);
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

function rowToRecord(row) {
  if (!row) return null;

  let snapshot = {};
  try {
    snapshot = JSON.parse(row.snapshot_json || '{}');
  } catch (e) {
    snapshot = {};
  }

  return {
    ...snapshot,
    token: row.token || snapshot.token || '',
    matchId: row.match_id,
    home: row.home,
    away: row.away,
    scoreHome: row.score_home ?? snapshot.scoreHome ?? 0,
    scoreAway: row.score_away ?? snapshot.scoreAway ?? 0,
    status: row.status || snapshot.status || 'final',
    isEnded: true,
    updatedAt: row.updated_at
  };
}

async function upsertFinalResult(rec) {
  const nowISO = new Date().toISOString();

  await dbRun(
    `
    INSERT INTO final_results (
      match_id,
      token,
      home,
      away,
      score_home,
      score_away,
      status,
      snapshot_json,
      updated_at,
      created_at,
      deleted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(match_id) DO UPDATE SET
      token = excluded.token,
      home = excluded.home,
      away = excluded.away,
      score_home = excluded.score_home,
      score_away = excluded.score_away,
      status = excluded.status,
      snapshot_json = excluded.snapshot_json,
      updated_at = excluded.updated_at,
      deleted_at = NULL
    `,
    [
      rec.matchId,
      rec.token || '',
      rec.home || 'Koti',
      rec.away || 'Vieras',
      Number(rec.scoreHome ?? 0),
      Number(rec.scoreAway ?? 0),
      'final',
      JSON.stringify({ ...rec, status: 'final', isEnded: true }),
      rec.updatedAt || nowISO,
      nowISO
    ]
  );
}

async function getPersistedFinalByMatchId(matchId) {
  const row = await dbGet(
    `
    SELECT *
    FROM final_results
    WHERE match_id = ?
      AND deleted_at IS NULL
    LIMIT 1
    `,
    [matchId]
  );

  return rowToRecord(row);
}

async function listPersistedFinals() {
  const rows = await dbAll(
    `
    SELECT
      match_id,
      token,
      home,
      away,
      score_home,
      score_away,
      status,
      updated_at
    FROM final_results
    WHERE deleted_at IS NULL
    ORDER BY datetime(updated_at) DESC
    `
  );

  return rows.map((row) => ({
    matchId: row.match_id,
    token: row.token || '',
    home: row.home || 'Koti',
    away: row.away || 'Vieras',
    scoreHome: row.score_home ?? 0,
    scoreAway: row.score_away ?? 0,
    status: row.status || 'final',
    updatedAt: row.updated_at
  }));
}

async function listVisibleMatches() {
  const liveItems = listFreshMatches();
  const persistedItems = await listPersistedFinals();

  const byId = new Map();

  for (const item of persistedItems) {
    byId.set(item.matchId, item);
  }

  for (const item of liveItems) {
    byId.set(item.matchId, item);
  }

  return Array.from(byId.values()).sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  );
}

async function softDeleteFinal(matchId) {
  const deletedAt = new Date().toISOString();

  const result = await dbRun(
    `
    UPDATE final_results
    SET deleted_at = ?
    WHERE match_id = ?
      AND deleted_at IS NULL
    `,
    [deletedAt, matchId]
  );

  return {
    changed: result.changes > 0,
    deletedAt
  };
}

// Cleanup old live matches every 15 min
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

  const refreshId = originalId || s.matchId;

  const homeName = s.home ?? 'Koti';
  const awayName = s.away ?? 'Vieras';

  const html = `<!DOCTYPE html>
<html lang="fi">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Liveseuranta – ${escapeHtml(homeName)} vs ${escapeHtml(awayName)}</title>
<style>
  :root {
    --glass-bg: rgba(255,255,255,0.7);
    --glass-border: rgba(0,0,0,0.08);
    --text: #111;
    --subtle: #666;
    --link: #0A66FF;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: linear-gradient(180deg, #f7f8fa, #eef3f7);
    color: var(--text);
  }
  .container {
    max-width: 860px;
    margin: 16px auto;
    padding: 16px;
  }
  .topbar {
    margin-bottom: 10px;
  }
  .topbar a {
    color: var(--link);
    text-decoration: none;
    font-size: 14px;
    font-weight: 600;
  }
  .card {
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    border-radius: 16px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.06);
    padding: 16px;
  }
  header {
    text-align: center;
    margin-bottom: 10px;
  }
  header .line {
    font-size: 24px;
    font-weight: 700;
  }
  header .status {
    margin-top: 4px;
    font-size: 13px;
    color: var(--subtle);
    min-height: 18px;
  }
  header .meta {
    margin-top: 6px;
    font-size: 12px;
    color: var(--subtle);
  }
  .possession {
    margin: 16px 0 8px;
  }
  .possession .bar {
    position: relative;
    height: 12px;
    background: rgba(0,0,0,0.1);
    border-radius: 999px;
    overflow: hidden;
  }
  .possession .fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: ${homePossessionPercent}%;
    background: ${homeHex}CC;
    border-radius: 999px;
    transition: width 0.3s ease;
  }
  .possession .legend {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    margin-top: 6px;
  }
  .stats-grid {
    display: flex;
    gap: 24px;
    margin-top: 14px;
  }
  .side {
    flex: 1 1 0;
  }
  .side h3 {
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 700;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: #222;
  }
  .item .val {
    margin-left: auto;
    font-weight: 600;
  }
  @media (max-width: 720px) {
    .stats-grid {
      flex-direction: column;
      gap: 12px;
    }
    .side[style*="text-align:right"] {
      text-align: left !important;
    }
  }
</style>
</head>
<body>
  <div class="container" role="main" aria-label="Match Quick Stats">
    <div class="topbar">
      <a href="/list">← Takaisin ottelulistaan</a>
    </div>

    <div class="card">
      <header>
        <div class="line">${escapeHtml(homeName)} ${Number(s.scoreHome ?? 0)} – ${Number(s.scoreAway ?? 0)} ${escapeHtml(awayName)}</div>
        <div class="status">${escapeHtml(statusText)}</div>
        <div class="meta">${escapeHtml(metaLine)}</div>
      </header>

      <section class="possession" aria-label="Pallonhallinta">
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${homePossessionPercent}">
          <div class="fill" id="posFill"></div>
        </div>
        <div class="legend">
          <span id="posHome">${escapeHtml(homeName)} ${homePossessionPercent}%</span>
          <span id="posAway">${escapeHtml(awayName)} ${awayPossessionPercent}%</span>
        </div>
      </section>

      <section class="stats-grid">
        <div class="side" style="color:${homeHex}">
          <h3>${escapeHtml(homeName)}</h3>
          <div class="item">🎯 xG <span class="val" id="homeXG">${Number(s.homeXG || 0).toFixed(2)}</span></div>
          <div class="item">⚽️ Laukaukset <span class="val" id="homeShots">${Number(s.homeShots ?? 0)}</span></div>
          <div class="item">🚩 Kulmapotkut <span class="val" id="homeCorners">${Number(s.homeCorners ?? 0)}</span></div>
        </div>
        <div class="side" style="text-align:right; color:${awayHex}">
          <h3>${escapeHtml(awayName)}</h3>
          <div class="item">🎯 xG <span class="val" id="awayXG">${Number(s.awayXG || 0).toFixed(2)}</span></div>
          <div class="item">⚽️ Laukaukset <span class="val" id="awayShots">${Number(s.awayShots ?? 0)}</span></div>
          <div class="item">🚩 Kulmapotkut <span class="val" id="awayCorners">${Number(s.awayCorners ?? 0)}</span></div>
        </div>
      </section>
    </div>
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

        if (res.status === 409) {
          window.location.reload();
          return;
        }

        if (res.status === 404) {
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
        fill.style.background = (data.homeColorHex || '#FF3B30') + 'CC';

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
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
}

function renderTokenSelectionPage(res, tokenMatches) {
  const html = `<!doctype html>
<html lang="fi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Valitse ottelu</title>
  <meta http-equiv="refresh" content="15" />
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f7f8fa;
      color: #111;
    }
    .wrap {
      max-width: 900px;
      margin: 20px auto;
      padding: 0 16px;
    }
    h1 {
      font-size: 22px;
      margin: 6px 0 12px;
    }
    .hint {
      color: #666;
      font-size: 13px;
      margin-bottom: 12px;
    }
    .card {
      background: #fff;
      border: 1px solid rgba(0,0,0,0.08);
      border-radius: 12px;
      padding: 14px;
      margin-bottom: 10px;
    }
    .line {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .meta {
      font-size: 13px;
      color: #666;
      margin-bottom: 8px;
    }
    a {
      font-size: 14px;
      color: #0A66FF;
      text-decoration: none;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Valitse ottelu</h1>
    <div class="hint">Tällä tokenilla on useita aktiivisia otteluita.</div>
    ${tokenMatches.map((s) => {
      const status = getStatus(s);
      const statusFi = statusLabelFi(status);
      return `<div class="card">
        <div class="line">${escapeHtml(s.home ?? 'Koti')} ${Number(s.scoreHome ?? 0)} – ${Number(s.scoreAway ?? 0)} ${escapeHtml(s.away ?? 'Vieras')}</div>
        <div class="meta">${escapeHtml(statusFi)}</div>
        <a href="/share/${encodeURIComponent(s.matchId)}">Avaa ottelu</a>
      </div>`;
    }).join('')}
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
}

// POST snapshot from app
app.post('/api/snapshot', asyncHandler(async (req, res) => {
  const token = getBearerToken(req);

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid token' });
  }

  const body = req.body || {};
  const home = String(body.home || body.homeTeam || '').trim();
  const away = String(body.away || body.awayTeam || '').trim();

  if (!home || !away) {
    return res.status(400).json({
      error: 'Missing team names: home and away are required'
    });
  }

  const matchId = pickIncomingMatchId(req, { ...body, home, away });
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

  const status = getStatus(record);
  if (status === 'final' || record.isEnded) {
    await upsertFinalResult({
      ...record,
      status: 'final',
      isEnded: true
    });
  }

  console.log('SNAPSHOT IN', {
    token,
    home,
    away,
    matchId
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
}));

// GET snapshot JSON by identifier
app.get('/api/snapshot/:id', asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').trim();

  if (matches.has(id)) {
    const rec = matches.get(id);
    if (rec && isFresh(rec)) {
      res.set('Cache-Control', 'no-store');
      return res.json(rec);
    }
  }

  const persisted = await getPersistedFinalByMatchId(id);
  if (persisted) {
    res.set('Cache-Control', 'no-store');
    return res.json(persisted);
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
}));

// GET snapshot JSON by query parameter (?matchId=... or ?token=...)
app.get('/api/snapshot', asyncHandler(async (req, res) => {
  const matchId = String(req.query.matchId || '').trim();
  const token = String(req.query.token || '').trim();

  if (matchId) {
    const rec = matches.get(matchId);
    if (rec && isFresh(rec)) {
      res.set('Cache-Control', 'no-store');
      return res.json(rec);
    }

    const persisted = await getPersistedFinalByMatchId(matchId);
    if (persisted) {
      res.set('Cache-Control', 'no-store');
      return res.json(persisted);
    }

    return res.status(404).json({ error: 'Snapshot not found' });
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
}));

// Alias JSON endpoint
app.get('/api/share/:id', asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').trim();

  if (matches.has(id)) {
    const rec = matches.get(id);
    if (rec && isFresh(rec)) {
      res.set('Cache-Control', 'no-store');
      return res.json(rec);
    }
  }

  const persisted = await getPersistedFinalByMatchId(id);
  if (persisted) {
    res.set('Cache-Control', 'no-store');
    return res.json(persisted);
  }

  const tokenMatches = getMatchesForToken(id);
  if (tokenMatches.length === 1) {
    res.set('Cache-Control', 'no-store');
    return res.json(tokenMatches[0]);
  }

  return res.status(404).json({ error: 'Snapshot not found' });
}));

app.get('/api/list', asyncHandler(async (req, res) => {
  const items = await listVisibleMatches();
  res.set('Cache-Control', 'no-store');
  res.json({ ttlMs: TTL_MS, nowISO: new Date().toISOString(), items });
}));

app.get('/', (req, res) => {
  res.redirect(302, '/list');
});

app.get('/health', (req, res) => {
  res.type('text/plain').send('OK');
});

// Share page
app.get('/share/:id', asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').trim();

  if (matches.has(id)) {
    const rec = matches.get(id);
    if (rec && isFresh(rec)) {
      return renderSharePage(res, rec, id);
    }
  }

  const persisted = await getPersistedFinalByMatchId(id);
  if (persisted) {
    return renderSharePage(res, persisted, id);
  }

  const tokenMatches = getMatchesForToken(id);

  if (tokenMatches.length === 0) {
    return res.status(404).send('Snapshot not found');
  }

  if (tokenMatches.length === 1) {
    return renderSharePage(res, tokenMatches[0], id);
  }

  return renderTokenSelectionPage(res, tokenMatches);
}));

// List page
app.get('/list', asyncHandler(async (req, res) => {
  const items = await listVisibleMatches();

  const html = `<!doctype html>
<html lang="fi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Liveseuranta – Ottelulista</title>
  <meta http-equiv="refresh" content="15" />
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f7f8fa;
      color: #111;
    }
    .wrap {
      max-width: 980px;
      margin: 20px auto;
      padding: 0 16px;
    }
    h1 {
      font-size: 22px;
      margin: 6px 0 12px;
    }
    .hint {
      color: #666;
      font-size: 13px;
      margin-bottom: 12px;
    }
    .footer-link {
      margin-top: 14px;
      font-size: 14px;
    }
    .footer-link a {
      color: #0A66FF;
      text-decoration: none;
      font-weight: 600;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: rgba(255,255,255,0.9);
      border: 1px solid rgba(0,0,0,0.08);
      border-radius: 12px;
      overflow: hidden;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid rgba(0,0,0,0.06);
      font-size: 14px;
      vertical-align: top;
    }
    th {
      background: rgba(0,0,0,0.04);
      text-align: left;
    }
    tr:last-child td {
      border-bottom: none;
    }
    .status {
      font-size: 12px;
      color: #666;
    }
    .links a {
      font-size: 13px;
      color: #0A66FF;
      text-decoration: none;
      font-weight: 600;
    }
    .empty {
      padding: 12px 0;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Liveseuranta – ottelut (${items.length})</h1>
    <div class="hint">Näytetään aktiiviset ottelut sekä tallennetut lopputulokset.</div>

    ${
      items.length === 0
        ? '<div class="empty">Otteluseurannassa ei ole käynnissä olevia otteluita eikä tallennettuja lopputuloksia.</div>'
        : `<table>
            <thead>
              <tr>
                <th>Ottelu</th>
                <th>Tulos</th>
                <th>Status</th>
                <th>Päivitetty</th>
                <th>Linkki</th>
              </tr>
            </thead>
            <tbody>
              ${items.map((i) => {
                const d = new Date(i.updatedAt);
                const dateStr = d.toLocaleString('fi-FI', {
                  dateStyle: 'short',
                  timeStyle: 'medium'
                });
                const score = `${Number(i.scoreHome ?? 0)} – ${Number(i.scoreAway ?? 0)}`;
                const statusFi = statusLabelFi(i.status);
                const mid = encodeURIComponent(i.matchId);

                return `<tr>
                  <td>${escapeHtml(i.home)} – ${escapeHtml(i.away)}</td>
                  <td>${score}</td>
                  <td class="status">${escapeHtml(statusFi)}</td>
                  <td class="status">${escapeHtml(dateStr)}</td>
                  <td class="links">
                    <a href="/share/${mid}">Seurantasivulle</a>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>`
    }

    <div class="footer-link">
      <a href="/privacy">Tietosuojaseloste</a>
    </div>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
}));

// Privacy Policy
app.get('/privacy', (req, res) => {
  const html = `<!doctype html>
<html lang="fi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tietosuojaseloste</title>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f7f8fa;
      color: #111;
      line-height: 1.65;
    }
    .wrap {
      max-width: 860px;
      margin: 32px auto;
      padding: 0 16px 40px;
    }
    .card {
      background: #fff;
      border: 1px solid rgba(0,0,0,0.08);
      border-radius: 16px;
      padding: 24px;
    }
    h1 {
      margin-top: 0;
      font-size: 28px;
    }
    h2 {
      margin-top: 28px;
      font-size: 20px;
    }
    p, li {
      font-size: 15px;
      color: #222;
    }
    .muted {
      color: #666;
      font-size: 14px;
    }
    a {
      color: #0A66FF;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Tietosuojaseloste</h1>
      <p class="muted">Viimeksi päivitetty: ${new Date().toISOString().slice(0, 10)}</p>

      <p>
        Tämä tietosuojaseloste koskee tätä live-seurantasovellusta ja siihen liittyvää verkkopalvelua.
      </p>

      <h2>1. Mitä tietoja sovellus käsittelee</h2>
      <p>
        Sovellus käsittelee vain otteluiden live-seurantaan liittyviä teknisiä ja sisällöllisiä tietoja,
        kuten joukkueiden nimet, tulokset, ottelun tilatiedot ja muut ottelutapahtumatiedot.
      </p>

      <h2>2. Henkilötiedot</h2>
      <p>
        Sovellus ei kerää, tallenna eikä käsittele henkilötietoja. Sovelluksessa ei ole käyttäjätilien
        luontia, kirjautumista eikä käyttäjäprofiileja.
      </p>

      <h2>3. Analytiikka ja seuranta</h2>
      <p>
        Sovellus ei käytä analytiikkaa, mainosseurantaa eikä muita käyttäjän käyttäytymistä seuraavia työkaluja.
      </p>

      <h2>4. Tietojen käyttötarkoitus</h2>
      <p>
        Käsiteltäviä tietoja käytetään ainoastaan sovelluksen ydintoimintojen toteuttamiseen, kuten
        live-otteluseurannan näyttämiseen ja otteluiden lopputulosten tallentamiseen.
      </p>

      <h2>5. Tietojen luovutus</h2>
      <p>
        Tietoja ei myydä eikä luovuteta kolmansille osapuolille muussa tarkoituksessa. Tietoja voidaan
        käsitellä vain siinä laajuudessa kuin palvelun tekninen ylläpito sitä edellyttää.
      </p>

      <h2>6. Tietoturva</h2>
      <p>
        Palvelun toiminnassa pyritään käyttämään asianmukaisia teknisiä ja organisatorisia suojatoimia.
      </p>

      <h2>7. Yhteydenotot</h2>
      <p>
        Jos sinulla on kysyttävää tästä tietosuojaselosteesta, voit ottaa yhteyttä sähköpostitse:
        <a href="mailto:johannes.rimpilainen@leasegreen.com">johannes.rimpilainen@leasegreen.com</a>
      </p>

      <p>
        <a href="/list">← Takaisin ottelulistaan</a>
      </p>
    </div>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
});

// Admin: list persisted finals
app.get('/api/admin/finals', requireAdmin, asyncHandler(async (req, res) => {
  const items = await listPersistedFinals();
  res.set('Cache-Control', 'no-store');
  res.json({ items });
}));

// Admin: delete persisted final
app.delete('/api/admin/finals/:matchId', requireAdmin, asyncHandler(async (req, res) => {
  const matchId = String(req.params.matchId || '').trim();

  if (!matchId) {
    return res.status(400).json({ error: 'Missing matchId' });
  }

  const existing = await getPersistedFinalByMatchId(matchId);
  if (!existing) {
    return res.status(404).json({ error: 'Final result not found' });
  }

  const result = await softDeleteFinal(matchId);

  const liveRec = matches.get(matchId);
  if (liveRec && (getStatus(liveRec) === 'final' || liveRec.isEnded)) {
    matches.delete(matchId);
    if (liveRec.token) {
      removeMatchFromToken(String(liveRec.token), matchId);
    }
  }

  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    matchId,
    deletedAt: result.deletedAt
  });
}));

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error('Unhandled error', err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 10000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
      console.log(`Final results DB: ${FINAL_DB_PATH}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
