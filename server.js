'use strict';

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

// matchId -> latest snapshot for that match
const matches = new Map();

// token -> Set of matchIds
const tokenToMatchIds = new Map();

// Keep matches visible for last N days
const TTL_DAYS = Number(process.env.LIVE_TTL_DAYS || 7);
const TTL_MS = Number(process.env.LIVE_TTL_MS || TTL_DAYS * 24 * 60 * 60 * 1000);

const I18N = {
  fi: {
    shareTitle: 'Liveseuranta',
    listTitle: 'Liveseuranta – ottelut',
    selectMatch: 'Valitse ottelu',
    multiMatches: 'Tällä tokenilla on useita aktiivisia otteluita.',
    noMatches: 'Otteluseurannassa ei ole käynnissä olevia otteluita.',
    daysHint: 'Näytetään ottelut, joita on päivitetty viimeisen {days} päivän aikana.',
    statusFinal: 'Lopputulos',
    statusPaused: 'Tauko',
    statusLive: 'Käynnissä',
    possession: 'Pallonhallinta',
    shots: 'Laukaukset',
    corners: 'Kulmapotkut',
    match: 'Ottelu',
    score: 'Tulos',
    status: 'Status',
    links: 'Linkki',
    sharePage: 'Seurantasivulle',
    openMatch: 'Avaa ottelu',
    backToList: 'Takaisin ottelulistaan'
  },
  en: {
    shareTitle: 'Live match tracker',
    listTitle: 'Live match tracker – matches',
    selectMatch: 'Select match',
    multiMatches: 'This token has multiple active matches.',
    noMatches: 'There are no active matches in the match tracker.',
    daysHint: 'Showing matches updated during the last {days} days.',
    statusFinal: 'Final',
    statusPaused: 'Half-time',
    statusLive: 'Live',
    possession: 'Possession',
    shots: 'Shots',
    corners: 'Corners',
    match: 'Match',
    score: 'Score',
    status: 'Status',
    links: 'Link',
    sharePage: 'To tracking page',
    openMatch: 'Open match',
    backToList: 'Back to match list'
  },
  sv: {
    shareTitle: 'Liveuppföljning',
    listTitle: 'Liveuppföljning – matcher',
    selectMatch: 'Välj match',
    multiMatches: 'Den här tokenen har flera aktiva matcher.',
    noMatches: 'Det finns inga pågående matcher i matchuppföljningen.',
    daysHint: 'Visar matcher som har uppdaterats under de senaste {days} dagarna.',
    statusFinal: 'Slutresultat',
    statusPaused: 'Paus',
    statusLive: 'Pågår',
    possession: 'Bollinnehav',
    shots: 'Skott',
    corners: 'Hörnor',
    match: 'Match',
    score: 'Resultat',
    status: 'Status',
    links: 'Länk',
    sharePage: 'Till matchsidan',
    openMatch: 'Öppna match',
    backToList: 'Tillbaka till matchlistan'
  }
};

const I18N_JSON = JSON.stringify(I18N);

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

// Fallback Match ID (käytetään vain jos client ei toimita MatchID:tä)
function buildMatchId(obj = {}) {
  const home = slugify(obj.home || obj.homeTeam || 'koti');
  const away = slugify(obj.away || obj.awayTeam || 'vieras');
  return home + '__' + away;
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

function renderLangSwitcher() {
  return `
    <div class="topbar">
      <div class="lang-switch" role="group" aria-label="Language">
        <button type="button" class="lang-btn" data-lang="fi">FI</button>
        <button type="button" class="lang-btn" data-lang="en">EN</button>
        <button type="button" class="lang-btn" data-lang="sv">SV</button>
      </div>
    </div>
  `;
}

function renderSharedClientHelpers(extraScript = '') {
  return `<script>
    const I18N = ${I18N_JSON};
    const TTL_DAYS = ${JSON.stringify(TTL_DAYS)};
    const DEFAULT_LANG = 'fi';

    function getDictionary(lang) {
      return I18N[lang] || I18N[DEFAULT_LANG];
    }

    function getCurrentLang() {
      try {
        return localStorage.getItem('live_lang') || DEFAULT_LANG;
      } catch (e) {
        return DEFAULT_LANG;
      }
    }

    function setCurrentLang(lang) {
      const next = I18N[lang] ? lang : DEFAULT_LANG;
      try {
        localStorage.setItem('live_lang', next);
      } catch (e) {
        // ignore
      }
      document.documentElement.lang = next;
      document.querySelectorAll('.lang-btn').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.lang === next);
      });
      return next;
    }

    function formatText(text, vars) {
      return String(text).replace(/\\{(\\w+)\\}/g, function (_, key) {
        return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : '';
      });
    }

    function getStatusText(status, lang) {
      const dict = getDictionary(lang);
      if (status === 'final') return dict.statusFinal;
      if (status === 'paused') return dict.statusPaused;
      return dict.statusLive;
    }

    function getHalfText(half, lang) {
      const n = Number(half || 1);
      if (lang === 'fi') return n + '. puoliaika';
      if (lang === 'sv') return n + '. halvlek';
      if (n === 1) return '1st half';
      if (n === 2) return '2nd half';
      if (n === 3) return '3rd half';
      return n + 'th half';
    }

    function wireLanguageButtons(applyPageLanguage) {
      document.querySelectorAll('.lang-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          setCurrentLang(btn.dataset.lang);
          applyPageLanguage();
        });
      });

      setCurrentLang(getCurrentLang());
      applyPageLanguage();
    }

    ${extraScript}
  </script>`;
}

function renderNoMatchesPage(res) {
  const html = `<!doctype html>
<html lang="fi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Liveseuranta</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f7f8fa; color: #111; }
    .wrap { max-width: 820px; margin: 20px auto; padding: 0 16px; }
    .topbar { display: flex; justify-content: flex-end; margin-bottom: 12px; }
    .lang-switch { display: inline-flex; gap: 8px; }
    .lang-btn { border: 1px solid rgba(0,0,0,0.12); background: #fff; border-radius: 10px; padding: 8px 10px; cursor: pointer; font-size: 13px; }
    .lang-btn.active { background: #111; color: #fff; }
    .card { background: rgba(255,255,255,0.9); border: 1px solid rgba(0,0,0,0.08); border-radius: 16px; padding: 24px; box-shadow: 0 6px 20px rgba(0,0,0,0.06); }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0 0 14px; color: #666; }
    a { color: #0a58ca; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrap">
    ${renderLangSwitcher()}
    <div class="card">
      <h1 id="pageTitle">Liveseuranta</h1>
      <p id="emptyText">Otteluseurannassa ei ole käynnissä olevia otteluita.</p>
      <a href="/list" id="backLink">Takaisin ottelulistaan</a>
    </div>
  </div>
  ${renderSharedClientHelpers(`
    function applyPageLanguage() {
      const lang = getCurrentLang();
      const dict = getDictionary(lang);
      document.title = dict.shareTitle;
      document.getElementById('pageTitle').textContent = dict.shareTitle;
      document.getElementById('emptyText').textContent = dict.noMatches;
      document.getElementById('backLink').textContent = dict.backToList;
    }

    wireLanguageButtons(applyPageLanguage);
  `)}
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(404).send(html);
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
  const possession = pickPossession(s);
  const homePossessionPercent = possession.h;
  const awayPossessionPercent = possession.a;

  const secs = Number(s.matchSeconds ?? 0);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  const clockStr = mm + ':' + ss;

  const homeHex = s.homeColorHex || '#FF3B30';
  const awayHex = s.awayColorHex || '#0A84FF';

  // if user opened /share/<token>, keep refreshing by token
  // if user opened /share/<matchId>, refresh by matchId
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
  .page { max-width: 860px; margin: 16px auto; padding: 0 16px; }
  .topbar { display: flex; justify-content: flex-end; margin-bottom: 12px; }
  .lang-switch { display: inline-flex; gap: 8px; }
  .lang-btn { border: 1px solid rgba(0,0,0,0.12); background: #fff; border-radius: 10px; padding: 8px 10px; cursor: pointer; font-size: 13px; }
  .lang-btn.active { background: #111; color: #fff; }
  .container { max-width: 860px; padding: 16px; background: var(--glass-bg); border: 1px solid var(--glass-border); border-radius: 16px; box-shadow: 0 6px 20px rgba(0,0,0,0.06); }
  header { text-align: center; margin-bottom: 10px; }
  header .line { font-size: 24px; font-weight: 700; }
  header .status { margin-top: 4px; font-size: 13px; color: var(--subtle); min-height: 18px; }
  header .meta { margin-top: 6px; font-size: 12px; color: var(--subtle); }
  .section-title { font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--subtle); margin-bottom: 6px; }
  .possession { margin: 16px 0 8px; }
  .possession .bar { position: relative; height: 12px; background: rgba(0,0,0,0.1); border-radius: 999px; overflow: hidden; }
  .possession .fill { position: absolute; left: 0; top: 0; bottom: 0; width: ${homePossessionPercent}%; background: ${homeHex}CC; border-radius: 999px; transition: width 0.3s ease; }
  .possession .legend { display: flex; justify-content: space-between; font-size: 12px; margin-top: 6px; }
  .stats-grid { display: flex; gap: 24px; margin-top: 14px; }
  .side { flex: 1 1 0; }
  .side h3 { margin: 0 0 6px; font-size: 15px; font-weight: 700; }
  .item { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #222; margin-bottom: 4px; }
  .item .val { margin-left: auto; font-weight: 600; }
  .label { white-space: nowrap; }
  @media (max-width: 700px) {
    .stats-grid { flex-direction: column; gap: 14px; }
  }
</style>
</head>
<body>
  <div class="page">
    ${renderLangSwitcher()}
    <div class="container" role="main" aria-label="Match Quick Stats">
      <header>
        <div class="line" id="scoreLine">${escapeHtml(s.home ?? 'Koti')} ${escapeHtml(String(s.scoreHome ?? 0))} – ${escapeHtml(String(s.scoreAway ?? 0))} ${escapeHtml(s.away ?? 'Vieras')}</div>
        <div class="status" id="statusText"></div>
        <div class="meta" id="metaLine"></div>
      </header>

      <section class="possession" aria-label="Pallonhallinta">
        <div class="section-title" id="possessionTitle">Pallonhallinta</div>
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${homePossessionPercent}">
          <div class="fill" id="posFill"></div>
        </div>
        <div class="legend">
          <span id="posHome">${escapeHtml(s.home ?? 'Koti')} ${escapeHtml(String(homePossessionPercent))}%</span>
          <span id="posAway">${escapeHtml(s.away ?? 'Vieras')} ${escapeHtml(String(awayPossessionPercent))}%</span>
        </div>
      </section>

      <section class="stats-grid">
        <div class="side" style="color:${escapeHtml(homeHex)}">
          <h3 id="homeTitle">${escapeHtml(s.home ?? 'Koti')}</h3>
          <div class="item"><span class="label">🎯 xG</span><span class="val" id="homeXG">${escapeHtml(Number(s.homeXG || 0).toFixed(2))}</span></div>
          <div class="item"><span class="label shots-label">⚽️ Laukaukset</span><span class="val" id="homeShots">${escapeHtml(String(s.homeShots ?? 0))}</span></div>
          <div class="item"><span class="label corners-label">🚩 Kulmapotkut</span><span class="val" id="homeCorners">${escapeHtml(String(s.homeCorners ?? 0))}</span></div>
        </div>
        <div class="side" style="text-align:right; color:${escapeHtml(awayHex)}">
          <h3 id="awayTitle">${escapeHtml(s.away ?? 'Vieras')}</h3>
          <div class="item"><spanieras')}</h3>
          <div class="item"><span class="label">🎯 xG</span><span class="val" id="awayXG">${escapeHtml(Number(s.awayXG || 0).toFixed(2))}</span></div>
          <div class="item"><span class="label shots-label">⚽️ Laukaukset</span><span class="val" id="awayShots">${escapeHtml(String(s.awayShots ?? 0))}</span></div>
          <div class="item"><span class="label corners-label">🚩 Kulmapotkut</span><span class="val" id="awayCorners">${escapeHtml(String(s.awayCorners ?? 0))}</span></div>
        </div>
      </section>
    </div>
  </div>

  ${renderSharedClientHelpers(`
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
    let latestData = ${JSON.stringify(s)};

    function renderFromData(data) {
      latestData = data || latestData;
      const lang = getCurrentLang();
      const dict = getDictionary(lang);

      const status = latestData.status || (latestData.isEnded ? 'final' : (latestData.isPaused ? 'paused' : 'live'));
      const pct = pickPct(latestData);
      const homePct = Math.max(0, Math.min(100, pct.home | 0));
      const awayPct = Math.max(0, Math.min(100, pct.away | 0));

      document.title = dict.shareTitle;
      document.getElementById('scoreLine').textContent =
        (latestData.home ?? 'Koti') + ' ' +
        (latestData.scoreHome ?? 0) + ' – ' +
        (latestData.scoreAway ?? 0) + ' ' +
        (latestData.away ?? 'Vieras');

      document.getElementById('statusText').textContent = getStatusText(status, lang);
      document.getElementById('metaLine').textContent =
        status === 'final' ? '' : (getHalfText(latestData.half ?? 1, lang) + ' • ' + mmss(latestData.matchSeconds ?? 0));

      document.getElementById('possessionTitle').textContent = dict.possession;
      document.getElementById('homeTitle').textContent = latestData.home ?? 'Koti';
      document.getElementById('awayTitle').textContent = latestData.away ?? 'Vieras';

      document.querySelectorAll('.shots-label').forEach(function (el) {
        el.textContent = '⚽️ ' + dict.shots;
      });

      document.querySelectorAll('.corners-label').forEach(function (el) {
        el.textContent = '🚩 ' + dict.corners;
      });

      const fill = document.getElementById('posFill');
      fill.style.width = homePct + '%';
      fill.style.background = (latestData.homeColorHex || '#FF3B30') + 'CC';

      document.getElementById('posHome').textContent = (latestData.home ?? 'Koti') + ' ' + homePct + '%';
      document.getElementById('posAway').textContent = (latestData.away ?? 'Vieras') + ' ' + awayPct + '%';

      document.getElementById('homeXG').textContent = Number(latestData.homeXG || 0).toFixed(2);
      document.getElementById('awayXG').textContent = Number(latestData.awayXG || 0).toFixed(2);
      document.getElementById('homeShots').textContent = String(latestData.homeShots ?? '0');
      document.getElementById('awayShots').textContent = String(latestData.awayShots ?? '0');
      document.getElementById('homeCorners').textContent = String(latestData.homeCorners ?? '0');
      document.getElementById('awayCorners').textContent = String(latestData.awayCorners ?? '0');
    }

    function applyPageLanguage() {
      renderFromData(latestData);
    }

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
          window.location.href = '/list';
          return;
        }

        if (!res.ok) return;

        const data = await res.json();
        renderFromData(data);
      } catch (e) {
        // ignore
      }
    }

    wireLanguageButtons(applyPageLanguage);
    renderFromData(latestData);
    refresh();
    setInterval(refresh, 2000);
  `)}
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
}

function renderSelectionPage(res, tokenMatches) {
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
    .topbar { display: flex; justify-content: flex-end; margin-bottom: 12px; }
    .lang-switch { display: inline-flex; gap: 8px; }
    .lang-btn { border: 1px solid rgba(0,0,0,0.12); background: #fff; border-radius: 10px; padding: 8px 10px; cursor: pointer; font-size: 13px; }
    .lang-btn.active { background: #111; color: #fff; }
    h1 { font-size: 22px; margin: 6px 0 12px; }
    .hint { color: #666; font-size: 13px; margin-bottom: 12px; }
    .card { background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 12px; padding: 14px; margin-bottom: 10px; }
    .line { font-size: 18px; font-weight: 700; margin-bottom: 6px; }
    .meta { font-size: 13px; color: #666; margin-bottom: 8px; }
    a { font-size: 14px; color: #0a58ca; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrap">
    ${renderLangSwitcher()}
    <h1 id="selectionTitle">Valitse ottelu</h1>
    <div class="hint" id="selectionHint">Tällä tokenilla on useita aktiivisia otteluita.</div>
    ${tokenMatches.map((s) => {
      const status = getStatus(s);
      return `<div class="card">
        <div class="line">${escapeHtml(s.home ?? 'Koti')} ${escapeHtml(String(s.scoreHome ?? 0))} – ${escapeHtml(String(s.scoreAway ?? 0))} ${escapeHtml(s.away ?? 'Vieras')}</div>
        <div class="meta" data-status="${escapeHtml(status)}"></div>
        <a href="/share/${encodeURIComponent(s.matchId)}" class="open-match-link">Avaa ottelu</a>
      </div>`;
    }).join('')}
  </div>

  ${renderSharedClientHelpers(`
    function applyPageLanguage() {
      const lang = getCurrentLang();
      const dict = getDictionary(lang);

      document.title = dict.selectMatch;
      document.getElementById('selectionTitle').textContent = dict.selectMatch;
      document.getElementById('selectionHint').textContent = dict.multiMatches;

      document.querySelectorAll('[data-status]').forEach(function (el) {
        el.textContent = getStatusText(el.dataset.status, lang);
      });

      document.querySelectorAll('.open-match-link').forEach(function (el) {
        el.textContent = dict.openMatch;
      });
    }

    wireLanguageButtons(applyPageLanguage);
  `)}
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
    shareUrl: '/share/' + matchId,
    tokenShareUrl: '/share/' + token,
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
      return renderNoMatchesPage(res);
    }
    return renderSharePage(res, rec, id);
  }

  // Token
  const tokenMatches = getMatchesForToken(id);

  if (tokenMatches.length === 0) {
    return renderNoMatchesPage(res);
  }

  if (tokenMatches.length === 1) {
    return renderSharePage(res, tokenMatches[0], id);
  }

  return renderSelectionPage(res, tokenMatches);
});

// List page
app.get('/list', (req, res) => {
  const items = listFreshMatches();

  const html = `<!doctype html>
<html lang="fi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Liveseuranta – ottelut</title>
  <meta http-equiv="refresh" content="15" />
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f7f8fa; color: #111; }
    .wrap { max-width: 980px; margin: 20px auto; padding: 0 16px; }
    .topbar { display: flex; justify-content: flex-end; margin-bottom: 12px; }
    .lang-switch { display: inline-flex; gap: 8px; }
    .lang-btn { border: 1px solid rgba(0,0,0,0.12); background: #fff; border-radius: 10px; padding: 8px 10px; cursor: pointer; font-size: 13px; }
    .lang-btn.active { background: #111; color: #fff; }
    h1 { font-size: 22px; margin: 6px 0 12px; }
    .hint { color: #666; font-size: 13px; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; background: rgba(255,255,255,0.9); border: 1px solid rgba(0,0,0,0.08); border-radius: 12px; overflow: hidden; }
    th, td { padding: 10px 12px; border-bottom: 1px solid rgba(0,0,0,0.06); font-size: 14px; vertical-align: top; }
    th { background: rgba(0,0,0,0.04); text-align: left; }
    tr:last-child td { border-bottom: none; }
    .status { font-size: 12px; color: #666; }
    .links a { font-size: 13px; color: #0a58ca; text-decoration: none; }
    .empty { padding: 16px; color: #666; background: rgba(255,255,255,0.9); border: 1px solid rgba(0,0,0,0.08); border-radius: 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    ${renderLangSwitcher()}
    <h1 id="listTitle">Liveseuranta – ottelut (${items.length})</h1>
    <div class="hint" id="listHint">Näytetään ottelut, joita on päivitetty viimeisen ${TTL_DAYS} päivän aikana.</div>
    ${
      items.length === 0
        ? '<div class="empty" id="emptyText">Otteluseurannassa ei ole käynnissä olevia otteluita.</div>'
        : `<table>
            <thead>
              <tr>
                <th id="thMatch">Ottelu</th>
                <th id="thScore">Tulos</th>
                <th id="thStatus">Status</th>
                <th id="thLinks">Linkki</th>
              </tr>
            </thead>
            <tbody>
              ${items.map((i) => {
                const score = String(i.scoreHome ?? 0) + ' – ' + String(i.scoreAway ?? 0);
                const mid = encodeURIComponent(i.matchId);

                return `<tr>
                  <td>${escapeHtml(i.home)} – ${escapeHtml(i.away)}</td>
                  <td>${escapeHtml(score)}</td>
                  <td class="status" data-status="${escapeHtml(i.status)}"></td>
                  <td class="links">
                    <a href="/share/${mid}" class="share-link">Seurantasivulle</a>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>`
    }
  </div>

  ${renderSharedClientHelpers(`
    const count = ${JSON.stringify(items.length)};

    function applyPageLanguage() {
      const lang = getCurrentLang();
      const dict = getDictionary(lang);

      document.title = dict.listTitle;
      document.getElementById('listTitle').textContent = dict.listTitle + ' (' + count + ')';
      document.getElementById('listHint').textContent = formatText(dict.daysHint, { days: TTL_DAYS });

      const empty = document.getElementById('emptyText');
      if (empty) {
        empty.textContent = dict.noMatches;
      }

      const thMatch = document.getElementById('thMatch');
      const thScore = document.getElementById('thScore');
      const thStatus = document.getElementById('thStatus');
      const thLinks = document.getElementById('thLinks');

      if (thMatch) thMatch.textContent = dict.match;
      if (thScore) thScore.textContent = dict.score;
      if (thStatus) thStatus.textContent = dict.status;
      if (thLinks) thLinks.textContent = dict.links;

      document.querySelectorAll('[data-status]').forEach(function (el) {
        el.textContent = getStatusText(el.dataset.status, lang);
      });

      document.querySelectorAll('.share-link').forEach(function (el) {
        el.textContent = dict.sharePage;
      });
    }

    wireLanguageButtons(applyPageLanguage);
  `)}
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('Server listening on port ' + PORT);
});
