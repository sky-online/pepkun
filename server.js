require('dotenv').config();
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const crypto   = require('crypto');
const { generateSession }                        = require('./src/ai/generate');
const { coachChat, getProfile, saveProfile, resetHistory } = require('./src/ai/coach');
const { readUsage }                              = require('./src/ai/usage-logger');
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const app = express();

// Stripe webhook needs raw body — must be registered before express.json()
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) return res.status(500).json({ error: 'Stripe not configured' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[webhook] signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const uid     = session.client_reference_id;
    if (uid) {
      if (!fs.existsSync(SUBS_DIR)) fs.mkdirSync(SUBS_DIR, { recursive: true });
      const validUntil = new Date();
      validUntil.setMonth(validUntil.getMonth() + 1);
      fs.writeFileSync(
        path.join(SUBS_DIR, `${uid}.json`),
        JSON.stringify({ isPro: true, validUntil: validUntil.toISOString(), stripeSessionId: session.id, createdAt: new Date().toISOString() }, null, 2),
        'utf8'
      );
      console.log('[webhook] Pro activated:', uid);
    }
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── ユーザー識別（UUID Cookie）────────────────────────────────────────────────
const FREE_LIMIT  = parseInt(process.env.FREE_LIMIT  || '5',  10);
const PRO_LIMIT   = parseInt(process.env.PRO_LIMIT   || '20', 10);
const MONTHLY_DIR = path.join(__dirname, 'data', 'monthly');
const SUBS_DIR    = path.join(__dirname, 'data', 'subscriptions');

function getUserId(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/pepkun_uid=([a-f0-9-]{36})/);
  return m ? m[1] : null;
}

function issueUserId(res) {
  const uid = crypto.randomUUID();
  res.setHeader('Set-Cookie', `pepkun_uid=${uid}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`);
  return uid;
}

function getMonthKey() {
  return new Date().toISOString().slice(0, 7); // "2026-06"
}

function getMonthlyCount(uid) {
  const fp = path.join(MONTHLY_DIR, `${getMonthKey()}.json`);
  try { return JSON.parse(fs.readFileSync(fp, 'utf8'))[uid] || 0; } catch { return 0; }
}

function incrementMonthlyCount(uid) {
  if (!fs.existsSync(MONTHLY_DIR)) fs.mkdirSync(MONTHLY_DIR, { recursive: true });
  const fp = path.join(MONTHLY_DIR, `${getMonthKey()}.json`);
  let data = {};
  try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
  data[uid] = (data[uid] || 0) + 1;
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
  return data[uid];
}

function isProUser(uid) {
  try {
    const fp = path.join(SUBS_DIR, `${uid}.json`);
    if (!fs.existsSync(fp)) return false;
    const sub = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return sub.isPro && new Date(sub.validUntil) > new Date();
  } catch { return false; }
}

function getLimit(uid) { return isProUser(uid) ? PRO_LIMIT : FREE_LIMIT; }

// 初回アクセス時にUUID Cookieを自動発行
app.use((req, res, next) => {
  if (!getUserId(req) && !req.path.startsWith('/api/')) issueUserId(res);
  next();
});

// ── 静的ファイル ─────────────────────────────────────────────────────────────
const SESSIONS_DIR = path.join(__dirname, 'data', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, 'public')));

// ── /api/me ──────────────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  let uid = getUserId(req);
  if (!uid) { uid = issueUserId(res); }
  const used      = getMonthlyCount(uid);
  const isPro     = isProUser(uid);
  const limit     = getLimit(uid);
  const remaining = Math.max(0, limit - used);
  res.json({ ok: true, uid, used, limit, isPro, remaining });
});

// ── /api/chat ─────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    let uid = getUserId(req);
    if (!uid) uid = issueUserId(res);
    const { message } = req.body;
    if (!message) return res.status(400).json({ ok: false, error: 'message は必須です' });
    const result = await coachChat(uid, message);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[chat error]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── /api/profile ──────────────────────────────────────────────────────────────
app.get('/api/profile', (req, res) => {
  let uid = getUserId(req);
  if (!uid) uid = issueUserId(res);
  const profile = getProfile(uid);
  res.json({ ok: true, profile });
});

// ── /api/profile/setup ────────────────────────────────────────────────────────
app.post('/api/profile/setup', (req, res) => {
  let uid = getUserId(req);
  if (!uid) uid = issueUserId(res);
  const allowed = ['coachName', 'userCoachName', 'soccerStyle', 'coachingStyle'];
  const updates = { setupDone: true };
  allowed.forEach(k => { if (req.body[k]) updates[k] = req.body[k]; });
  const profile = saveProfile(uid, updates);
  res.json({ ok: true, profile });
});

// ── /api/coach/history ────────────────────────────────────────────────────────
app.delete('/api/coach/history', (req, res) => {
  const uid = getUserId(req);
  if (uid) resetHistory(uid);
  res.json({ ok: true });
});

// ── /api/generate ─────────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  try {
    let uid = getUserId(req);
    if (!uid) uid = issueUserId(res);

    const used  = getMonthlyCount(uid);
    const isPro = isProUser(uid);
    const limit = getLimit(uid);

    if (used >= limit) {
      return res.status(429).json({
        ok: false,
        limitReached: true,
        isPro,
        used,
        limit,
        error: isPro
          ? `今月の上限（${limit}回）に達しました。来月リセットされます。`
          : `今月の無料枠（${FREE_LIMIT}回）を使い切りました。Proプラン（月500円）で月${PRO_LIMIT}回まで使えます。`,
      });
    }

    const params = {
      teamName: req.body.teamName || '未設定',
      ageGroup: req.body.ageGroup || 'U-12',
      players:  parseInt(req.body.players)  || 16,
      duration: parseInt(req.body.duration) || 90,
      theme:    req.body.theme    || 'ビルドアップ',
      level:    req.body.level    || '中級',
      concept:  req.body.concept  || '',
      notes:    req.body.notes    || '',
    };

    const profile = getProfile(uid);
    const context = profile ? {
      concept: {
        playingStyle: profile.concept || profile.soccerStyle || null,
        keywords: Array.isArray(profile.keywords) ? profile.keywords : null,
        values:   Array.isArray(profile.values)   ? profile.values   : null,
      },
      status: {
        strengths:    profile.strengths    || null,
        weaknesses:   profile.weaknesses   || null,
        currentFocus: profile.currentFocus || null,
      },
    } : {};

    if (profile) {
      const styleNotes = [
        profile.soccerStyle   ? `目指すスタイル: ${profile.soccerStyle}`   : null,
        profile.coachingStyle ? `指導方針: ${profile.coachingStyle}` : null,
      ].filter(Boolean).join(' / ');
      if (styleNotes) params.notes = [styleNotes, params.notes].filter(Boolean).join('。');
    }

    console.log('[generate]', params);
    const result = await generateSession(params, context);

    const newUsed = incrementMonthlyCount(uid);
    const remaining = Math.max(0, limit - newUsed);

    saveProfile(uid, {
      teamName:     profile?.teamName || params.teamName,
      ageGroup:     profile?.ageGroup || params.ageGroup,
      players:      profile?.players  || params.players,
      level:        profile?.level    || params.level,
      lastTheme:    params.theme,
      lastSession:  new Date().toISOString().split('T')[0],
      sessionCount: (profile?.sessionCount || 0) + 1,
    });

    res.json({ ok: true, data: result, used: newUsed, limit, remaining });
  } catch (err) {
    console.error('[generate error]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── /api/sessions ─────────────────────────────────────────────────────────────
app.post('/api/sessions', (req, res) => {
  try {
    const { params, session } = req.body;
    const now = new Date();
    const ts  = now.toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const safeName = (params.teamName || '未設定').replace(/[^\w぀-鿿]/g, '_');
    const filename = `${ts}-${safeName}.json`;
    const record   = { id: filename, savedAt: now.toISOString(), params, session };
    fs.writeFileSync(path.join(SESSIONS_DIR, filename), JSON.stringify(record, null, 2), 'utf8');
    res.json({ ok: true, id: filename });
  } catch (err) {
    console.error('[sessions save error]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/sessions', (req, res) => {
  try {
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json')).sort().reverse().slice(0, 50);
    const list = files.map(f => {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
        return { id: rec.id, savedAt: rec.savedAt, title: rec.session?.title || '(タイトルなし)', teamName: rec.params?.teamName || '', ageGroup: rec.params?.ageGroup || '', theme: rec.params?.theme || '' };
      } catch { return null; }
    }).filter(Boolean);
    res.json({ ok: true, sessions: list });
  } catch (err) {
    console.error('[sessions list error]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/sessions/:id', (req, res) => {
  try {
    const fp = path.join(SESSIONS_DIR, req.params.id);
    if (!fs.existsSync(fp)) return res.status(404).json({ ok: false, error: '見つかりません' });
    res.json({ ok: true, data: JSON.parse(fs.readFileSync(fp, 'utf8')) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'pepkun-admin';

app.get('/admin', (req, res) => {
  if (req.query.pass !== ADMIN_PASS) {
    return res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>Admin</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f4f8}
.box{background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 16px rgba(0,0,0,.1);text-align:center}
input{border:1px solid #ddd;border-radius:6px;padding:10px 14px;font-size:14px;margin:12px 0;display:block;width:200px}
button{background:#1a1a6e;color:#fff;border:none;border-radius:6px;padding:10px 24px;cursor:pointer;font-size:14px}
</style></head><body><div class="box"><h2>⚽ ペップ君 Admin</h2>
<form method="GET"><input type="password" name="pass" placeholder="パスワード" autofocus>
<button type="submit">ログイン</button></form></div></body></html>`);
  }

  const logs  = readUsage();
  const total = logs.reduce((a, l) => ({
    input: a.input + l.input, output: a.output + l.output,
    cache_read: a.cache_read + l.cache_read, cost: a.cost + l.cost_usd, calls: a.calls + 1,
  }), { input:0, output:0, cache_read:0, cost:0, calls:0 });

  const byType = {};
  logs.forEach(l => {
    if (!byType[l.type]) byType[l.type] = { calls:0, cost:0 };
    byType[l.type].calls++;
    byType[l.type].cost += l.cost_usd;
  });

  // 今月のユーザー数
  const monthFp = path.join(MONTHLY_DIR, `${getMonthKey()}.json`);
  let monthData = {};
  try { monthData = JSON.parse(fs.readFileSync(monthFp, 'utf8')); } catch {}
  const totalUsers   = Object.keys(monthData).length;
  const totalMonthly = Object.values(monthData).reduce((a, v) => a + v, 0);

  const userRows = Object.entries(monthData)
    .sort(([,a],[,b]) => b - a).slice(0, 20)
    .map(([uid, cnt]) => {
      const isPro = isProUser(uid);
      return `<tr><td style="font-size:10px;color:#888">${uid.slice(0,8)}...</td>
        <td>${cnt}</td><td>${isPro ? '⭐ Pro' : '無料'}</td></tr>`;
    }).join('');

  const typeRows   = Object.entries(byType).map(([t,v]) =>
    `<tr><td>${t}</td><td>${v.calls}</td><td>$${v.cost.toFixed(4)}</td></tr>`).join('');
  const recentRows = [...logs].reverse().slice(0,20).map(l =>
    `<tr><td>${l.ts.replace('T',' ').slice(0,19)}</td><td>${l.type}</td><td>${l.model.replace('claude-','')}</td>
     <td>${l.input}</td><td>${l.output}</td><td>$${l.cost_usd.toFixed(5)}</td></tr>`).join('');

  res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta http-equiv="refresh" content="30"><title>ペップ君 Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Hiragino Kaku Gothic Pro','Meiryo',sans-serif;background:#f0f4f8;padding:24px}
h1{color:#1a1a6e;margin-bottom:20px;font-size:20px}
.cards{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:24px}
.card{background:#fff;border-radius:10px;padding:16px 22px;box-shadow:0 1px 6px rgba(0,0,0,.08);min-width:140px}
.card-label{font-size:11px;color:#888;margin-bottom:4px}
.card-value{font-size:24px;font-weight:900;color:#1a1a6e}
.card-value.cost{color:#e63329}
h2{font-size:14px;color:#1a1a6e;margin:20px 0 10px;border-left:3px solid #e63329;padding-left:8px}
table{width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 6px rgba(0,0,0,.08);border-collapse:collapse;margin-bottom:20px}
th{background:#1a1a6e;color:#fff;padding:8px 12px;font-size:12px;text-align:left}
td{padding:7px 12px;font-size:12px;border-bottom:1px solid #f0f0f0;color:#333}
tr:last-child td{border-bottom:none}tr:hover td{background:#f8f9ff}
.footer{font-size:11px;color:#aaa;margin-top:16px}
</style></head><body>
<h1>⚽ ペップ君 — 使用量ダッシュボード</h1>
<div class="cards">
  <div class="card"><div class="card-label">今月のユーザー数</div><div class="card-value">${totalUsers}</div></div>
  <div class="card"><div class="card-label">今月の総生成回数</div><div class="card-value">${totalMonthly}</div></div>
  <div class="card"><div class="card-label">総APIコール</div><div class="card-value">${total.calls}</div></div>
  <div class="card"><div class="card-label">推定総コスト</div><div class="card-value cost">$${total.cost.toFixed(4)}</div></div>
</div>
<h2>今月のユーザー別（上位20件）</h2>
<table><tr><th>UID</th><th>生成回数</th><th>プラン</th></tr>${userRows || '<tr><td colspan="3">今月のデータなし</td></tr>'}</table>
<h2>種類別集計</h2>
<table><tr><th>種類</th><th>コール数</th><th>推定コスト</th></tr>${typeRows}</table>
<h2>直近20件</h2>
<table><tr><th>日時</th><th>種類</th><th>モデル</th><th>入力</th><th>出力</th><th>コスト</th></tr>${recentRows}</table>
<div class="footer">30秒ごとに自動更新 | /admin?pass=${ADMIN_PASS}</div>
</body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n⚽ ペップ君 起動中`);
  console.log(`  PC      : http://localhost:${PORT}`);
  console.log(`  スマホ  : http://${ip}:${PORT}`);
  console.log(`  無料上限: 月${FREE_LIMIT}回 / Pro: 月${PRO_LIMIT}回\n`);
});
