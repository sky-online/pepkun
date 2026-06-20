require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { generateSession } = require('./src/ai/generate');
const { coachChat, getProfile, saveProfile, resetHistory } = require('./src/ai/coach');
const { readUsage } = require('./src/ai/usage-logger');

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── 招待コード認証 ──────────────────────────────────────────────────────────
const RAW_CODES = process.env.INVITE_CODES || '';
const INVITE_CODES = new Set(
  RAW_CODES.split(',').map(s => s.trim()).filter(Boolean)
);

const AUTH_ENABLED = INVITE_CODES.size > 0;
const GENERATE_LIMIT = parseInt(process.env.GENERATE_LIMIT || '5', 10);

const USAGE_COUNT_FILE = path.join(__dirname, 'data', 'invite-counts.json');

function loadCounts() {
  try { return JSON.parse(fs.readFileSync(USAGE_COUNT_FILE, 'utf8')); } catch { return {}; }
}
function saveCounts(counts) {
  try {
    const dir = path.dirname(USAGE_COUNT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(USAGE_COUNT_FILE, JSON.stringify(counts, null, 2), 'utf8');
  } catch (e) { console.error('[counts]', e.message); }
}
function getInviteCode(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/invite=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// 開発モード（AUTH無効）の場合は'dev'をデフォルトコードとして使用
function effectiveCode(req) {
  return AUTH_ENABLED ? getInviteCode(req) : 'dev';
}

function requireInvite(req, res, next) {
  if (!AUTH_ENABLED) return next();
  if (req.path.startsWith('/admin') || req.path.startsWith('/invite')) return next();
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/invite=([^;]+)/);
  const code = match ? decodeURIComponent(match[1]) : null;
  if (code && INVITE_CODES.has(code)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: '招待コードが必要です' });
  res.redirect('/invite.html');
}

app.use(requireInvite);
app.use(express.static(path.join(__dirname, 'public')));

// 招待コード認証
app.post('/invite/auth', (req, res) => {
  const { code } = req.body;
  if (!AUTH_ENABLED || INVITE_CODES.has(code)) {
    res.setHeader('Set-Cookie', `invite=${encodeURIComponent(code)}; Path=/; HttpOnly; Max-Age=${60*60*24*90}`);
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: '招待コードが正しくありません' });
});

const SESSIONS_DIR = path.join(__dirname, 'data', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ── コーチチャット ──────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ ok: false, error: 'message は必須です' });
    const code = effectiveCode(req);
    if (!code) return res.status(401).json({ ok: false, error: '招待コードが必要です' });

    const result = await coachChat(code, message);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[chat error]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── プロフィール取得 ────────────────────────────────────────────────────────
app.get('/api/profile', (req, res) => {
  const code = effectiveCode(req);
  const profile = code ? getProfile(code) : null;
  res.json({ ok: true, profile });
});

// ── 会話履歴リセット ────────────────────────────────────────────────────────
app.delete('/api/coach/history', (req, res) => {
  const code = effectiveCode(req);
  if (code) resetHistory(code);
  res.json({ ok: true });
});

// ── メニュー生成 ────────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  try {
    const code = effectiveCode(req);

    // 生成回数チェック
    if (AUTH_ENABLED && code) {
      const counts = loadCounts();
      const used = counts[code] || 0;
      if (used >= GENERATE_LIMIT) {
        return res.status(429).json({
          ok: false,
          error: `テスト枠を使い切りました（${GENERATE_LIMIT}回/${GENERATE_LIMIT}回）。フィードバックをお送りください！`,
          limitReached: true,
        });
      }
    }

    const params = {
      teamName: req.body.teamName || '未設定',
      ageGroup:  req.body.ageGroup  || 'U-12',
      players:   parseInt(req.body.players)  || 16,
      duration:  parseInt(req.body.duration) || 90,
      theme:     req.body.theme    || 'ビルドアップ',
      level:     req.body.level    || '中級',
      concept:   req.body.concept  || '',
      notes:     req.body.notes    || '',
    };

    // プロフィールからコンテキストを注入
    const profile = code ? getProfile(code) : null;
    const context = profile ? {
      concept: {
        playingStyle: profile.concept || null,
        keywords: Array.isArray(profile.keywords) ? profile.keywords : null,
        values: Array.isArray(profile.values) ? profile.values : null,
      },
      status: {
        strengths: profile.strengths || null,
        weaknesses: profile.weaknesses || null,
        currentFocus: profile.currentFocus || null,
      },
    } : {};

    console.log('[generate]', params);
    const result = await generateSession(params, context);

    // 生成成功後にカウントアップ＆プロフィール更新
    if (AUTH_ENABLED && code) {
      const counts = loadCounts();
      counts[code] = (counts[code] || 0) + 1;
      saveCounts(counts);
    }
    if (code) {
      saveProfile(code, {
        teamName: profile?.teamName || params.teamName,
        ageGroup: profile?.ageGroup || params.ageGroup,
        players: profile?.players || params.players,
        level: profile?.level || params.level,
        lastTheme: params.theme,
        lastSession: new Date().toISOString().split('T')[0],
        sessionCount: (profile?.sessionCount || 0) + 1,
      });
    }

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error('[generate error]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── セッション保存 ──────────────────────────────────────────────────────────
app.post('/api/sessions', (req, res) => {
  try {
    const { params, session } = req.body;
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const safeName = (params.teamName || '未設定').replace(/[^\w぀-鿿]/g, '_');
    const filename = `${ts}-${safeName}.json`;
    const record = { id: filename, savedAt: now.toISOString(), params, session };
    fs.writeFileSync(path.join(SESSIONS_DIR, filename), JSON.stringify(record, null, 2), 'utf8');
    res.json({ ok: true, id: filename });
  } catch (err) {
    console.error('[sessions save error]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── セッション一覧 ──────────────────────────────────────────────────────────
app.get('/api/sessions', (req, res) => {
  try {
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort().reverse().slice(0, 50);

    const list = files.map(f => {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
        return {
          id: rec.id,
          savedAt: rec.savedAt,
          title: rec.session?.title || '(タイトルなし)',
          teamName: rec.params?.teamName || '',
          ageGroup: rec.params?.ageGroup || '',
          theme: rec.params?.theme || '',
        };
      } catch { return null; }
    }).filter(Boolean);

    res.json({ ok: true, sessions: list });
  } catch (err) {
    console.error('[sessions list error]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── セッション詳細 ──────────────────────────────────────────────────────────
app.get('/api/sessions/:id', (req, res) => {
  try {
    const fp = path.join(SESSIONS_DIR, req.params.id);
    if (!fs.existsSync(fp)) return res.status(404).json({ ok: false, error: '見つかりません' });
    res.json({ ok: true, data: JSON.parse(fs.readFileSync(fp, 'utf8')) });
  } catch (err) {
    console.error('[sessions get error]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Admin 管理画面 ──────────────────────────────────────────────────────────
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'pepkun-admin';

app.get('/admin', (req, res) => {
  if (req.query.pass !== ADMIN_PASS) {
    return res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>Admin</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f4f8}
.box{background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 16px rgba(0,0,0,.1);text-align:center}
input{border:1px solid #ddd;border-radius:6px;padding:10px 14px;font-size:14px;margin:12px 0;display:block;width:200px}
button{background:#1a1a6e;color:#fff;border:none;border-radius:6px;padding:10px 24px;cursor:pointer;font-size:14px}</style>
</head><body><div class="box"><h2>⚽ ペップ君 Admin</h2>
<form method="GET"><input type="password" name="pass" placeholder="パスワード" autofocus>
<button type="submit">ログイン</button></form></div></body></html>`);
  }

  const logs = readUsage();
  const total = logs.reduce((a, l) => ({
    input: a.input + l.input, output: a.output + l.output,
    cache_read: a.cache_read + l.cache_read, cache_write: a.cache_write + l.cache_write,
    cost: a.cost + l.cost_usd, calls: a.calls + 1,
  }), { input:0, output:0, cache_read:0, cache_write:0, cost:0, calls:0 });

  const byType = {};
  logs.forEach(l => {
    if (!byType[l.type]) byType[l.type] = { calls:0, cost:0 };
    byType[l.type].calls++;
    byType[l.type].cost += l.cost_usd;
  });

  const recent = [...logs].reverse().slice(0, 20);
  const counts = loadCounts();
  const codeRows = AUTH_ENABLED
    ? [...INVITE_CODES].map(c =>
        `<tr><td>${c}</td><td>${counts[c] || 0} / ${GENERATE_LIMIT}</td>
         <td><div style="background:#e0e6f0;border-radius:4px;height:8px;width:100px;display:inline-block;vertical-align:middle">
         <div style="background:#1a1a6e;border-radius:4px;height:8px;width:${Math.min(100,(counts[c]||0)/GENERATE_LIMIT*100)}px"></div></div></td></tr>`
      ).join('')
    : '<tr><td colspan="3">認証無効（開発モード）</td></tr>';

  const typeRows = Object.entries(byType).map(([t, v]) =>
    `<tr><td>${t}</td><td>${v.calls}</td><td>$${v.cost.toFixed(4)}</td></tr>`).join('');
  const recentRows = recent.map(l =>
    `<tr><td>${l.ts.replace('T',' ').slice(0,19)}</td><td>${l.type}</td><td>${l.model.replace('claude-','')}</td>
     <td>${l.input}</td><td>${l.output}</td><td>${l.cache_read}</td><td>$${l.cost_usd.toFixed(5)}</td></tr>`).join('');

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
.card.warn .card-value{color:#e65100}
h2{font-size:14px;color:#1a1a6e;margin:20px 0 10px;border-left:3px solid #e63329;padding-left:8px}
table{width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 6px rgba(0,0,0,.08);border-collapse:collapse;margin-bottom:20px}
th{background:#1a1a6e;color:#fff;padding:8px 12px;font-size:12px;text-align:left}
td{padding:7px 12px;font-size:12px;border-bottom:1px solid #f0f0f0;color:#333}
tr:last-child td{border-bottom:none}
tr:hover td{background:#f8f9ff}
.footer{font-size:11px;color:#aaa;margin-top:16px}
</style></head><body>
<h1>⚽ ペップ君 — 使用量ダッシュボード</h1>
<div class="cards">
  <div class="card"><div class="card-label">総APIコール数</div><div class="card-value">${total.calls}</div></div>
  <div class="card"><div class="card-label">入力トークン計</div><div class="card-value">${(total.input/1000).toFixed(1)}K</div></div>
  <div class="card"><div class="card-label">出力トークン計</div><div class="card-value">${(total.output/1000).toFixed(1)}K</div></div>
  <div class="card"><div class="card-label">キャッシュ読込</div><div class="card-value">${(total.cache_read/1000).toFixed(1)}K</div></div>
  <div class="card warn"><div class="card-label">推定総コスト</div><div class="card-value cost">$${total.cost.toFixed(4)}</div></div>
</div>
<h2>招待コード別 生成回数（上限${GENERATE_LIMIT}回）</h2>
<table><tr><th>コード</th><th>使用回数</th><th>進捗</th></tr>${codeRows}</table>
<h2>種類別集計</h2>
<table><tr><th>種類</th><th>コール数</th><th>推定コスト</th></tr>${typeRows}</table>
<h2>直近20件</h2>
<table><tr><th>日時</th><th>種類</th><th>モデル</th><th>入力</th><th>出力</th><th>キャッシュ</th><th>コスト</th></tr>
${recentRows}</table>
<div class="footer">30秒ごとに自動更新 | /admin?pass=${ADMIN_PASS}</div>
</body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n⚽ ペップ君 起動中`);
  console.log(`  PC      : http://localhost:${PORT}`);
  console.log(`  スマホ  : http://${ip}:${PORT}  ← 同じWiFiで開いてください`);
  console.log(`  ※Androidで接続できない場合: Windowsファイアウォールでポート${PORT}を許可\n`);
});
