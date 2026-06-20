const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { logUsage } = require('./usage-logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const USERS_DIR = path.join(__dirname, '../../data/users');

// ── Profile / History IO ────────────────────────────────────────────────────

function userDir(code) { return path.join(USERS_DIR, code); }

function ensureDir(code) {
  const d = userDir(code);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function loadProfile(code) {
  try {
    const fp = path.join(userDir(code), 'profile.json');
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {}
  return null;
}

function saveProfile(code, updates) {
  ensureDir(code);
  const existing = loadProfile(code) || {};
  const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(userDir(code), 'profile.json'), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function loadHistory(code) {
  try {
    const fp = path.join(userDir(code), 'history.json');
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {}
  return [];
}

function saveHistory(code, history) {
  ensureDir(code);
  fs.writeFileSync(
    path.join(userDir(code), 'history.json'),
    JSON.stringify(history.slice(-30), null, 2),
    'utf8'
  );
}

// ── System prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(profile) {
  const hasTeam = profile?.teamName;

  const teamCtx = hasTeam ? `
【あなたが担当するチーム】
チーム名: ${profile.teamName}
年代: ${profile.ageGroup || '不明'}
人数: ${profile.players ? profile.players + '名' : '不明'}
レベル: ${profile.level || '不明'}
コンセプト: ${profile.concept || '未設定'}
強み: ${Array.isArray(profile.strengths) ? profile.strengths.join('、') : profile.strengths || '未設定'}
課題: ${Array.isArray(profile.weaknesses) ? profile.weaknesses.join('、') : profile.weaknesses || '未設定'}
前回テーマ: ${profile.lastTheme || 'なし'}
前回日: ${profile.lastSession || 'なし'}
累計セッション: ${profile.sessionCount || 0}回

今日のテーマを聞けばすぐ生成できる。課題や前回テーマを踏まえたテーマ提案も積極的にする。` :
`このユーザーはまだチームを登録していない。
チーム名・年代・今日のテーマを1〜2回のやり取りで確認してすぐ生成する。`;

  return `あなたはサッカーコーチ専属AIアシスタントです。
「ペップ君（総監督AI）」の戦術知識とユーザーのチームをつなぐ専属コーチです。
${teamCtx}

【最重要ミッション】
できるだけ早く、チームに最適な練習メニューを生成すること。
情報が少しでも揃えば迷わず生成する。深掘りは後でいい。

【会話ルール】
・1ターン1質問のみ（複数同時厳禁）
・感嘆詞・前置き禁止（「素晴らしい！」「なるほど！」禁止）
・簡潔・具体的に
・情報が揃ったら即座にGENERATE_PARAMSを出す

【生成の判断基準】
以下が揃えば迷わず生成する（全部揃わなくてよい）：
- チーム名 ✓
- 年代 ✓
- 今日のテーマ ✓
（人数・時間・レベルは不明でもデフォルト値で生成可）

【GENERATE_PARAMS】
生成準備ができたら返答末尾に付ける（JSONのみ・コメント禁止・末尾カンマ禁止）：
[GENERATE_PARAMS]{"teamName":"...","ageGroup":"U-12","players":16,"duration":90,"theme":"...","level":"中級","concept":"...","notes":""}[/GENERATE_PARAMS]

【PROFILE_UPDATE】
新情報を得たら返答末尾に付ける（変更項目のみ）：
[PROFILE_UPDATE]{"teamName":"...","ageGroup":"...","players":16,"level":"...","concept":"...","strengths":["..."],"weaknesses":["..."]}[/PROFILE_UPDATE]

【ペップ君の知識ベース（積極活用）】
- 風間八宏：止める・蹴るの技術的定義、ボールと体の正対
- ペップ・グアルディオラ：5レーン・ポジショナルプレー・偽9番
- クロップ：縦に速い・トランジション・ハイプレス・即時奪還
- オシム：考えながら走る・複数ポジション
- JFA年代別発達段階（U-8〜社会人）
テーマ提案や方向性のアドバイスにこの知識を使うこと。`;
}

// ── Tag extraction ──────────────────────────────────────────────────────────

function extractTag(text, tag) {
  const re = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`);
  const m = text.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim().replace(/,\s*([}\]])/g, '$1'));
  } catch { return null; }
}

function stripTags(text) {
  return text
    .replace(/\[GENERATE_PARAMS\][\s\S]*?\[\/GENERATE_PARAMS\]/g, '')
    .replace(/\[PROFILE_UPDATE\][\s\S]*?\[\/PROFILE_UPDATE\]/g, '')
    .trim();
}

// ── Main API ────────────────────────────────────────────────────────────────

async function coachChat(inviteCode, userMessage) {
  const profile = loadProfile(inviteCode);
  const history = loadHistory(inviteCode);

  const messages = [...history, { role: 'user', content: userMessage }];

  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: [{ type: 'text', text: buildSystemPrompt(profile), cache_control: { type: 'ephemeral' } }],
    messages,
  });

  logUsage('claude-haiku-4-5-20251001', resp.usage, 'coach');
  const raw = resp.content[0].text;

  const generateParams = extractTag(raw, 'GENERATE_PARAMS');
  const profileUpdate  = extractTag(raw, 'PROFILE_UPDATE');

  let updatedProfile = profile;
  if (profileUpdate) {
    updatedProfile = saveProfile(inviteCode, profileUpdate);
  }

  saveHistory(inviteCode, [
    ...history,
    { role: 'user', content: userMessage },
    { role: 'assistant', content: raw },
  ]);

  return {
    message: stripTags(raw),
    generateParams,
    profile: updatedProfile,
  };
}

function getProfile(code) { return loadProfile(code); }

function resetHistory(code) {
  ensureDir(code);
  saveHistory(code, []);
}

module.exports = { coachChat, getProfile, saveProfile, resetHistory };
