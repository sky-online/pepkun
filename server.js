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
const MONTHLY_DIR   = path.join(__dirname, 'data', 'monthly');
const SUBS_DIR      = path.join(__dirname, 'data', 'subscriptions');
const EMAILS_DIR    = path.join(__dirname, 'data', 'emails');
const USERS_DIR_ROOT = path.join(__dirname, 'data', 'users');

// 起動時にデータディレクトリを作成し、永続化されているか確認
[MONTHLY_DIR, SUBS_DIR, EMAILS_DIR, USERS_DIR_ROOT].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
const DATA_ROOT = path.join(__dirname, 'data');
const testFile = path.join(DATA_ROOT, '.startup');
fs.writeFileSync(testFile, new Date().toISOString(), 'utf8');
console.log('[startup] data dir:', DATA_ROOT, '/ volume:', fs.existsSync(testFile) ? 'OK' : 'WARN - ephemeral');

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

// ── /api/account/email ────────────────────────────────────────────────────────
app.post('/api/account/email', (req, res) => {
  let uid = getUserId(req);
  if (!uid) return res.status(401).json({ ok: false, error: '未認証' });
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: '有効なメールアドレスを入力してください' });
  }
  const key = Buffer.from(email.toLowerCase()).toString('base64url');
  if (!fs.existsSync(EMAILS_DIR)) fs.mkdirSync(EMAILS_DIR, { recursive: true });
  const emailFile = path.join(EMAILS_DIR, `${key}.json`);
  if (fs.existsSync(emailFile)) {
    const ex = JSON.parse(fs.readFileSync(emailFile, 'utf8'));
    if (ex.uid !== uid) return res.status(409).json({ ok: false, error: 'このメールアドレスはすでに登録済みです' });
  }
  fs.writeFileSync(emailFile, JSON.stringify({ uid, registeredAt: new Date().toISOString() }, null, 2), 'utf8');
  saveProfile(uid, { email });
  res.json({ ok: true });
});

// ── /api/account/restore ──────────────────────────────────────────────────────
app.post('/api/account/restore', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ ok: false, error: 'メールアドレスが必要です' });
  const key = Buffer.from(email.toLowerCase()).toString('base64url');
  const emailFile = path.join(EMAILS_DIR, `${key}.json`);
  if (!fs.existsSync(emailFile)) return res.status(404).json({ ok: false, error: 'このメールアドレスは登録されていません' });
  const { uid } = JSON.parse(fs.readFileSync(emailFile, 'utf8'));
  res.setHeader('Set-Cookie', `pepkun_uid=${uid}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`);
  res.json({ ok: true, uid });
});

// ── Admin ─────────────────────────────────────────────────────────────────────
const ADMIN_PASS    = process.env.ADMIN_PASSWORD || 'pepkun-admin';
const LOCK_LIMIT    = 10;
const LOCK_DURATION = 30 * 60 * 1000; // 30分
const adminFailMap  = new Map(); // ip → { count, lockedAt }

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function isAdminLocked(ip) {
  const rec = adminFailMap.get(ip);
  if (!rec) return false;
  if (rec.lockedAt && Date.now() - rec.lockedAt < LOCK_DURATION) return true;
  // ロック期限切れならリセット
  adminFailMap.delete(ip);
  return false;
}

function recordAdminFail(ip) {
  const rec = adminFailMap.get(ip) || { count: 0, lockedAt: null };
  rec.count++;
  if (rec.count >= LOCK_LIMIT) rec.lockedAt = Date.now();
  adminFailMap.set(ip, rec);
  return rec.count;
}

function resetAdminFail(ip) { adminFailMap.delete(ip); }

// 管理者セッション：パスワードから導出したトークンをhttpOnly Cookieに保存（URLにパスワードを出さない）
const ADMIN_TOKEN = crypto.createHmac('sha256', ADMIN_PASS).update('pepkun-admin-session').digest('hex');
function hasAdminCookie(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)pk_admin=([a-f0-9]+)/);
  return !!m && m[1].length === ADMIN_TOKEN.length &&
    crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(ADMIN_TOKEN));
}

app.all('/admin', (req, res) => {
  const ip = getClientIp(req);

  if (req.method === 'POST' && req.body && req.body.pass === ADMIN_PASS) {
    resetAdminFail(ip);
    res.setHeader('Set-Cookie', `pk_admin=${ADMIN_TOKEN}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${60 * 60 * 12}`);
    return res.redirect(303, '/admin');
  }

  if (isAdminLocked(ip)) {
    return res.status(429).send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>Admin</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f4f8}
.box{background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 16px rgba(0,0,0,.1);text-align:center;color:#bf360c}
</style></head><body><div class="box"><h2>アクセスがロックされています</h2>
<p style="margin-top:12px;font-size:14px">ログイン失敗が${LOCK_LIMIT}回を超えました。<br>30分後に再試行してください。</p></div></body></html>`);
  }

  if (!hasAdminCookie(req)) {
    const tried = (req.method === 'POST' && req.body && req.body.pass !== undefined) || req.query.pass !== undefined;
    const count = tried ? recordAdminFail(ip) : 0;
    const warn  = count > 0 ? `<p style="color:#bf360c;font-size:13px;margin-top:8px">パスワードが違います（${count}/${LOCK_LIMIT}回）</p>` : '';
    return res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>Admin</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f4f8}
.box{background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 16px rgba(0,0,0,.1);text-align:center}
input{border:1px solid #ddd;border-radius:6px;padding:10px 14px;font-size:14px;margin:12px 0;display:block;width:200px}
button{background:#1a1a6e;color:#fff;border:none;border-radius:6px;padding:10px 24px;cursor:pointer;font-size:14px}
</style></head><body><div class="box"><h2>⚽ ペップ君 Admin</h2>
<form method="POST" action="/admin"><input type="password" name="pass" placeholder="パスワード" autofocus>
<button type="submit">ログイン</button></form>${warn}</div></body></html>`);
  }

  resetAdminFail(ip);

  const logs  = readUsage();
  const total = logs.reduce((a, l) => ({
    input: a.input + l.input, output: a.output + l.output,
    cache_read: a.cache_read + l.cache_read, cost: a.cost + l.cost_usd, calls: a.calls + 1,
  }), { input:0, output:0, cache_read:0, cost:0, calls:0 });

  const monthFp = path.join(MONTHLY_DIR, `${getMonthKey()}.json`);
  let monthData = {};
  try { monthData = JSON.parse(fs.readFileSync(monthFp, 'utf8')); } catch {}
  const totalMonthly = Object.values(monthData).reduce((a, v) => a + v, 0);

  // 全ユーザーの詳細（プロフィール結合）
  const allUids = new Set([
    ...Object.keys(monthData),
    ...(fs.existsSync(USERS_DIR_ROOT) ? fs.readdirSync(USERS_DIR_ROOT).filter(d => /^[a-f0-9-]{36}$/.test(d)) : []),
  ]);

  const userDetails = [...allUids].map(uid => {
    try {
      const profileFile = path.join(USERS_DIR_ROOT, uid, 'profile.json');
      const profile = fs.existsSync(profileFile) ? JSON.parse(fs.readFileSync(profileFile, 'utf8')) : {};
      const used      = monthData[uid] || 0;
      const isPro     = isProUser(uid);
      const limit     = isPro ? PRO_LIMIT : FREE_LIMIT;
      const remaining = Math.max(0, limit - used);
      const returning = (profile.sessionCount || 0) > 1;
      return { uid, email: profile.email || '—', team: profile.teamName || '—',
               used, remaining, total: profile.sessionCount || 0,
               last: profile.lastSession || '—', isPro, returning };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.used - a.used || b.total - a.total);

  const totalUsers   = userDetails.length;
  const proUsers     = userDetails.filter(u => u.isPro).length;
  const returningUsers = userDetails.filter(u => u.returning).length;

  const userRows = userDetails.slice(0, 30).map(u => `
    <tr>
      <td>${u.email !== '—' ? `<a href="mailto:${esc(u.email)}" style="color:#1a1a6e">${esc(u.email)}</a>` : '<span style="color:#ccc">未登録</span>'}</td>
      <td>${esc(u.team)}</td>
      <td style="text-align:center"><strong>${u.used}</strong></td>
      <td style="text-align:center;color:${u.remaining===0?'#e63329':'#333'}">${u.remaining}</td>
      <td style="text-align:center">${u.total}</td>
      <td style="text-align:center">${u.last}</td>
      <td style="text-align:center">${u.returning ? '<span style="color:#4caf50;font-weight:700">継続</span>' : '初回'}</td>
      <td style="text-align:center">${u.isPro ? '<span style="background:#1a1a6e;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px">Pro</span>' : '<span style="color:#aaa">無料</span>'}</td>
    </tr>`).join('');

  const recentRows = [...logs].reverse().slice(0,15).map(l =>
    `<tr><td>${l.ts.replace('T',' ').slice(0,16)}</td><td>${l.type}</td><td>${l.model.replace('claude-','')}</td>
     <td style="text-align:right">$${l.cost_usd.toFixed(5)}</td></tr>`).join('');

  // メッセージスレッド（未読を上に）
  const nameOf = uid => { const u = userDetails.find(x => x.uid === uid); return u ? `${u.team}${u.email !== '—' ? '（' + u.email + '）' : ''}` : uid.slice(0, 8); };
  const threads = (fs.existsSync(MSG_DIR) ? fs.readdirSync(MSG_DIR) : [])
    .filter(f => /^[a-f0-9-]{36}\.json$/.test(f))
    .map(f => { const uid = f.slice(0, -5); const t = readJson(threadFile(uid), []);
      return { uid, t, unread: t.filter(m => m.from === 'user' && !m.read).length, last: t.length ? t[t.length - 1].at : '' }; })
    .filter(x => x.t.length)
    .sort((a, b) => b.unread - a.unread || b.last.localeCompare(a.last));
  const unreadTotal = threads.reduce((a, x) => a + x.unread, 0);
  const fmt = s => s.replace('T', ' ').slice(0, 16);
  const threadHtml = threads.map(x => `
    <div class="thread${x.unread ? ' unread' : ''}">
      <div class="th-head">${esc(nameOf(x.uid))}${x.unread ? ` <span class="badge">未読${x.unread}</span>` : ''}</div>
      ${x.t.slice(-10).map(m => `<div class="msg ${m.from}"><span class="meta">${m.from === 'user' ? esc(m.kind || '') : '運営'}・${fmt(m.at)}</span>${esc(m.text).replace(/\n/g, '<br>')}</div>`).join('')}
      <form method="POST" action="/admin/reply" class="reply"><input type="hidden" name="uid" value="${x.uid}">
        <textarea name="text" rows="2" placeholder="返信を書く"></textarea><button>返信</button></form>
    </div>`).join('');
  const announces = readJson(ANNOUNCE_FILE, []);
  const announceHtml = [...announces].reverse().map(a => `
    <div class="ann"><span class="meta">${fmt(a.at)}</span>${esc(a.text)}
      <form method="POST" action="/admin/announce" style="display:inline"><input type="hidden" name="delete" value="${a.id}"><button class="del">削除</button></form></div>`).join('');

  res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ペップ君 Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Hiragino Kaku Gothic Pro','Meiryo',sans-serif;background:#f0f4f8;padding:20px;font-size:13px}
h1{color:#1a1a6e;margin-bottom:16px;font-size:18px;font-weight:900}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.card{background:#fff;border-radius:10px;padding:14px 20px;box-shadow:0 1px 6px rgba(0,0,0,.08);min-width:120px}
.card-label{font-size:10px;color:#888;margin-bottom:4px;font-weight:600;letter-spacing:.05em}
.card-value{font-size:26px;font-weight:900;color:#1a1a6e}
.card-value.red{color:#e63329}.card-value.green{color:#4caf50}
h2{font-size:13px;font-weight:700;color:#1a1a6e;margin:20px 0 8px;border-left:3px solid #e63329;padding-left:8px}
table{width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 6px rgba(0,0,0,.07);border-collapse:collapse;margin-bottom:16px}
th{background:#1a1a6e;color:#fff;padding:8px 10px;font-size:11px;font-weight:600;text-align:left;white-space:nowrap}
td{padding:7px 10px;font-size:12px;border-bottom:1px solid #f2f2f2;color:#333;vertical-align:middle}
tr:last-child td{border-bottom:none}tr:hover td{background:#f8f9ff}
.footer{font-size:11px;color:#aaa;margin-top:12px}
.thread{background:#fff;border-radius:10px;padding:12px;margin-bottom:10px;box-shadow:0 1px 6px rgba(0,0,0,.07)}
.thread.unread{border-left:4px solid #e63329}
.th-head{font-weight:700;color:#1a1a6e;margin-bottom:8px}
.badge{background:#e63329;color:#fff;border-radius:10px;padding:1px 8px;font-size:11px}
.msg{padding:6px 10px;border-radius:8px;margin:4px 0;max-width:80%;line-height:1.5}
.msg.user{background:#f0f4f8}.msg.admin{background:#e8eaff;margin-left:auto}
.meta{display:block;font-size:10px;color:#888}
.reply,.annform{display:flex;gap:6px;margin-top:8px}
textarea{flex:1;border:1px solid #ddd;border-radius:6px;padding:6px;font:inherit}
button{background:#1a1a6e;color:#fff;border:none;border-radius:6px;padding:6px 14px;cursor:pointer}
button.del{background:none;color:#e63329;padding:0 6px;font-size:11px}
.ann{background:#fff;border-radius:8px;padding:8px 12px;margin-bottom:6px}
</style></head><body>
<h1>⚽ ペップ君 ダッシュボード</h1>
<div class="cards">
  <div class="card"><div class="card-label">今月ユーザー</div><div class="card-value">${totalUsers}</div></div>
  <div class="card"><div class="card-label">今月生成数</div><div class="card-value">${totalMonthly}</div></div>
  <div class="card"><div class="card-label">継続ユーザー</div><div class="card-value green">${returningUsers}</div></div>
  <div class="card"><div class="card-label">Proユーザー</div><div class="card-value">${proUsers}</div></div>
  <div class="card"><div class="card-label">累計APIコスト</div><div class="card-value red">$${total.cost.toFixed(2)}</div></div>
</div>
<h2 id="messages">ユーザーからのメッセージ${unreadTotal ? `（未読${unreadTotal}件）` : ''}</h2>
${threadHtml || '<p style="color:#aaa;margin-bottom:12px">まだメッセージはありません</p>'}
<h2>全員へのお知らせ（アプリ上部に表示）</h2>
<form method="POST" action="/admin/announce" class="annform"><textarea name="text" rows="2" placeholder="例：新機能を追加しました！"></textarea><button>掲載</button></form>
<div style="margin-top:8px">${announceHtml}</div>
<h2>ユーザー一覧（上位30件）</h2>
<table>
  <tr><th>メール</th><th>チーム</th><th>今月</th><th>残り</th><th>累計</th><th>最終利用</th><th>状況</th><th>プラン</th></tr>
  ${userRows || '<tr><td colspan="8" style="text-align:center;color:#aaa;padding:20px">データなし</td></tr>'}
</table>
<h2>直近API使用（15件）</h2>
<table><tr><th>日時</th><th>種類</th><th>モデル</th><th>コスト</th></tr>${recentRows}</table>
<div class="footer">最新の状態はページを再読み込みしてください</div>
</body></html>`);
});

// ── メッセージ（ユーザー⇔運営）・お知らせ ────────────────────────────────────
const MSG_DIR       = path.join(__dirname, 'data', 'messages');
const ANNOUNCE_FILE = path.join(__dirname, 'data', 'announcements.json');
if (!fs.existsSync(MSG_DIR)) fs.mkdirSync(MSG_DIR, { recursive: true });

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const readJson  = (fp, def) => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return def; } };
const writeJson = (fp, v) => fs.writeFileSync(fp, JSON.stringify(v, null, 2), 'utf8');
const threadFile = uid => path.join(MSG_DIR, `${uid}.json`);
const isUid = s => /^[a-f0-9-]{36}$/.test(s || '');

app.get('/api/messages', (req, res) => {
  const uid = getUserId(req);
  if (!uid) return res.json({ ok: true, messages: [], announcements: readJson(ANNOUNCE_FILE, []).slice(-5) });
  const thread = readJson(threadFile(uid), []);
  if (req.query.markRead && thread.some(m => m.from === 'admin' && !m.read)) {
    thread.forEach(m => { if (m.from === 'admin') m.read = true; });
    writeJson(threadFile(uid), thread);
  }
  res.json({ ok: true, messages: thread, announcements: readJson(ANNOUNCE_FILE, []).slice(-5) });
});

app.post('/api/messages', (req, res) => {
  const uid = getUserId(req);
  const text = String(req.body?.text || '').trim().slice(0, 2000);
  const kind = ['要望', '不具合', 'その他'].includes(req.body?.kind) ? req.body.kind : 'その他';
  if (!uid || !text) return res.status(400).json({ ok: false, error: 'メッセージを入力してください' });
  const thread = readJson(threadFile(uid), []);
  if (thread.filter(m => m.from === 'user' && Date.now() - new Date(m.at) < 3600e3).length >= 20)
    return res.status(429).json({ ok: false, error: '送信回数が多すぎます。少し時間をおいてください' });
  thread.push({ from: 'user', kind, text, at: new Date().toISOString(), read: false });
  writeJson(threadFile(uid), thread);
  res.json({ ok: true, messages: thread });
});

// 管理者：返信・お知らせ・既読
app.post('/admin/reply', (req, res) => {
  if (!hasAdminCookie(req)) return res.status(403).send('forbidden');
  const { uid, text } = req.body || {};
  if (isUid(uid) && String(text || '').trim()) {
    const thread = readJson(threadFile(uid), []);
    thread.forEach(m => { if (m.from === 'user') m.read = true; });
    thread.push({ from: 'admin', text: String(text).trim().slice(0, 2000), at: new Date().toISOString(), read: false });
    writeJson(threadFile(uid), thread);
  }
  res.redirect(303, '/admin#messages');
});

app.post('/admin/announce', (req, res) => {
  if (!hasAdminCookie(req)) return res.status(403).send('forbidden');
  const list = readJson(ANNOUNCE_FILE, []);
  if (req.body?.delete) {
    writeJson(ANNOUNCE_FILE, list.filter(a => a.id !== req.body.delete));
  } else if (String(req.body?.text || '').trim()) {
    list.push({ id: crypto.randomUUID(), text: String(req.body.text).trim().slice(0, 1000), at: new Date().toISOString() });
    writeJson(ANNOUNCE_FILE, list);
  }
  res.redirect(303, '/admin#messages');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n⚽ ペップ君 起動中`);
  console.log(`  PC      : http://localhost:${PORT}`);
  console.log(`  スマホ  : http://${ip}:${PORT}`);
  console.log(`  無料上限: 月${FREE_LIMIT}回 / Pro: 月${PRO_LIMIT}回\n`);
});
