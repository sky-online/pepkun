require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { generateSession } = require('./src/ai/generate');
const { chatMessage, clearConversation } = require('./src/ai/chat');
const { sectionChat, getDoc, clearHistory } = require('./src/ai/section-chat');

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
app.use(express.static(path.join(__dirname, 'public')));

const SESSIONS_DIR = path.join(__dirname, 'data', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ── セクション対話 ────────────────────────────────────────────────
// POST /api/section/:type/chat   type = concept | status | plan
app.post('/api/section/:type/chat', async (req, res) => {
  const { type } = req.params;
  const { message } = req.body;

  if (!['concept', 'status', 'plan'].includes(type)) {
    return res.status(400).json({ ok: false, error: 'Invalid section type' });
  }
  if (!message) {
    return res.status(400).json({ ok: false, error: 'message は必須です' });
  }

  try {
    const result = await sectionChat(type, message);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(`[section/${type} error]`, err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/section/:type/doc   現在のドキュメントを返す
app.get('/api/section/:type/doc', (req, res) => {
  const { type } = req.params;
  if (!['concept', 'status', 'plan'].includes(type)) {
    return res.status(400).json({ ok: false, error: 'Invalid section type' });
  }
  const doc = getDoc(type);
  res.json({ ok: true, doc });
});

// DELETE /api/section/:type/history   会話履歴をリセット
app.delete('/api/section/:type/history', (req, res) => {
  const { type } = req.params;
  if (['concept', 'status', 'plan'].includes(type)) {
    clearHistory(type);
  }
  res.json({ ok: true });
});

// ── 練習メニュー対話 ──────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { conversationId, message } = req.body;
    if (!conversationId || !message) {
      return res.status(400).json({ ok: false, error: 'conversationId と message は必須です' });
    }
    // チームコンテキストをリアルタイムで渡す
    const teamContext = {
      concept: getDoc('concept'),
      status:  getDoc('status'),
      plan:    getDoc('plan'),
    };
    const result = await chatMessage(conversationId, message, teamContext);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[chat error]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── メニュー生成 ──────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  try {
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

    // チームコンテキストを注入（concept / status / plan 全て活用）
    const context = {
      concept: getDoc('concept'),
      status:  getDoc('status'),
      plan:    getDoc('plan'),
    };

    console.log('[generate]', params);
    const result = await generateSession(params, context);

    if (req.body.conversationId) {
      clearConversation(req.body.conversationId);
    }

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error('[generate error]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── セッション保存 ────────────────────────────────────────────────
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

// ── セッション一覧 ────────────────────────────────────────────────
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

// ── セッション詳細 ────────────────────────────────────────────────
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n⚽ ペップ君 起動中`);
  console.log(`  PC      : http://localhost:${PORT}`);
  console.log(`  スマホ  : http://${ip}:${PORT}  ← 同じWiFiで開いてください`);
  console.log(`  ※Androidで接続できない場合: Windowsファイアウォールでポート${PORT}を許可\n`);
});
