const express = require('express');
const app = express();

app.use(express.json());

const snapshots = new Map();

function getTokenFromAuth(req) {
  const h = req.headers['authorization'] || '';
  const prefix = 'Bearer ';
  if (!h.startsWith(prefix)) return null;
  return h.slice(prefix.length).trim();
}

app.post('/api/snapshot', (req, res) => {
  const token = getTokenFromAuth(req);
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid token' });
  }
  const body = req.body || {};
  snapshots.set(token, { ...body, updatedAt: new Date().toISOString() });
  res.json({ ok: true });
});

app.get('/api/snapshot/:token', (req, res) => {
  const token = req.params.token;
  const data = snapshots.get(token);
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

app.get('/share/:token', (req, res) => {
  const token = req.params.token;
  const html = `<!doctype html>
<html lang="fi"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Live: ${token}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; margin: 20px; color: #111; }
  .card { max-width: 520px; border: 1px solid #ddd; border-radius: 12px; padding: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  .title { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
  .row { display: flex; justify-content: space-between; margin: 6px 0; }
  .muted { color: #666; font-size: 13px; }
  .score { font-size: 28px; font-weight: 800; text-align: center; margin: 10px 0; }
  .pill { display: inline-block; padding: 4px 10px; border-radius: 999px; background: #f2f2f7; font-size: 12px; }
</style></head>
<body>
  <div class="card">
    <div class="title">Live-ottelu</div>
    <div id="teams" class="row muted">Ladataan...</div>
    <div id="score" class="score">–</div>
    <div class="row">
      <div class="pill" id="half">–</div>
      <div class="pill" id="clock">–:–</div>
    </div>
    <div style="height: 8px;"></div>
    <div class="row"><div>Koti pallonhallinta</div><div id="homePoss">–</div></div>
    <div class="row"><div>Vieras pallonhallinta</div><div id="awayPoss">–</div></div>
    <div class="row muted"><div>Viimeksi päivitetty</div><div id="updated">–</div></div>
  </div>
<script>
const token = ${JSON.stringify(token)};
function mmss(total) {
  total = Math.max(0, total|0);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return m + ':' + s;
}
async function refresh() {
  try {
    const r = await fetch('/api/snapshot/' + encodeURIComponent(token), { cache: 'no-store' });
    if (!r.ok) throw new Error('not ok');
    const d = await r.json();
    document.getElementById('teams').textContent = (d.home || 'Koti') + ' vs ' + (d.away || 'Vieras');
    document.getElementById('score').textContent = (d.scoreHome ?? 0) + ' – ' + (d.scoreAway ?? 0);
    document.getElementById('half').textContent = (d.half ? (d.half + '. puoliaika') : '–');
    document.getElementById('clock').textContent = mmss(d.matchSeconds ?? 0);
    document.getElementById('homePoss').textContent = (d.possessionHomePct ?? 0) + '%';
    document.getElementById('awayPoss').textContent = (d.possessionAwayPct ?? 0) + '%';
    document.getElementById('updated').textContent = new Date(d.updatedAt || Date.now()).toLocaleTimeString('fi-FI');
  } catch(e) {
    document.getElementById('teams').textContent = 'Odottaa dataa...';
  }
}
setInterval(refresh, 2000);
refresh();
</script>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('Live server listening on http://localhost:' + port);
});
