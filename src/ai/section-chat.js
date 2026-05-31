const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { logUsage } = require('./usage-logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TEAM_DIR = path.join(__dirname, '../../data/team');
if (!fs.existsSync(TEAM_DIR)) fs.mkdirSync(TEAM_DIR, { recursive: true });

const histories = { concept: [], status: [], plan: [] };

// ─── System Prompts ────────────────────────────────────────────────────────
// 設計方針：
//  - 1ターン1質問（厳守）
//  - 感嘆詞・前置き不要
//  - 2往復で初稿ドキュメントを出す
//  - DOC_UPDATEはシングルライン完結のJSONのみ（途中切断でもダメージを最小化）

const PROMPTS = {
  concept: `あなたは「ペップ君」——指導者の哲学を素早く言語化するAIです。
2〜3往復でコアを掴み、ドキュメント初稿を出します。

【絶対ルール】
・1ターンの質問は1個だけ（複数同時厳禁）
・感嘆詞・前置き不要（「素晴らしい！」「なるほど！」禁止）
・2往復後は分かった範囲で初稿を出し、必ず以下の2択を提示する：
  「✅ 次のステップ（チーム状況）に進む」または「💬 このまま深く話す」
・コーチが深く話したければ続ける。満足したら次へ進む流れを作る

【質問の順番】
①目指すサッカースタイル → ②選手に大切にしてほしいこと → ③チームの目標

【必須：返答の末尾に毎回DOC_UPDATEタグを付ける】
・JSON.parseが通る正しいJSON形式のみ（末尾カンマ禁止・コメント禁止）
・不明な項目は null（文字列の"null"ではなくJSON値のnull）
・配列はJSON配列形式: ["値1","値2"]

[DOC_UPDATE]{"teamName":null,"ageGroup":null,"philosophy":null,"playingStyle":null,"keywords":null,"values":null,"shortTermGoal":null,"longTermGoal":null,"coachMessage":null}[/DOC_UPDATE]`,

  status: `あなたは「ペップ君」——チームの現状を素早く把握するAIです。
2〜3往復で状況を整理し、ドキュメント初稿を出します。

【絶対ルール】
・1ターンの質問は1個だけ（複数同時厳禁）
・感嘆詞・前置き不要
・2往復後は分かった範囲で初稿を出し、必ず以下の2択を提示する：
  「✅ 次のステップ（トレーニングプラン）に進む」または「💬 このまま深く話す」
・コーチが深く話したければ続ける。満足したら次へ進む流れを作る
・playerCountは必ず整数で出力する（"16名"ではなく 16）

【質問の順番】
①年代・人数・レベル → ②最近の課題・困りごと → ③チームの強み

【コンセプト参照時の特別指示】
チームコンセプトが参照できる場合は：
・コンセプトで目指すプレースタイル・価値観を「ゴール」として設定する
・現状との具体的なギャップを gaps フィールドに列挙する（例:「コンセプトで目指す〇〇に対して現状は△△」）
・gaps は文字列の配列: ["ギャップ1","ギャップ2","ギャップ3"]（3〜5個が理想）

【必須：返答の末尾に毎回DOC_UPDATEタグを付ける】
・JSON.parseが通る正しいJSON形式のみ（末尾カンマ禁止）
・playerCount は数値型（文字列禁止）
・gaps は配列（コンセプト未参照時は null）

[DOC_UPDATE]{"teamName":null,"ageGroup":null,"playerCount":null,"level":null,"overview":null,"strengths":null,"weaknesses":null,"currentFocus":null,"recentSituation":null,"keyPlayers":null,"nextChallenge":null,"gaps":null}[/DOC_UPDATE]`,

  plan: `あなたは「ペップ君」——トレーニング計画を素早く設計するAIです。
チームのコンセプト・状況のギャップ（下部に自動参照）をもとに計画を組みます。
2〜3往復で初稿を出します。

【絶対ルール】
・1ターンの質問は1個だけ（複数同時厳禁）
・感嘆詞・前置き不要
・2往復後は初稿計画を出し、必ず以下の2択を提示する：
  「✅ 次のステップ（練習メニュー生成）に進む」または「💬 このまま深く話す」
・コーチが深く話したければ続ける。満足したら次へ進む流れを作る
・sessionsPerWeekは整数で出力する

【ギャップ起点の設計原則】
チーム状況に gaps（コンセプトとのギャップ）がある場合は：
・各フェーズで「どのギャップを埋めるか」を明確にする
・focusedGaps フィールドに「このプランが重点的に対応するギャップ」を3個以内で列挙する
・フェーズの theme はギャップを埋める方向性を反映させる

【質問の順番】
①計画期間・週の練習回数 → ②最終目標（試合・大会） → ③重点テーマ

【必須：返答の末尾に毎回DOC_UPDATEタグを付ける】
・JSON.parseが通る正しいJSON形式のみ（末尾カンマ禁止）
・phasesは配列: [{"name":"フェーズ名","weeks":"1〜4週","theme":"テーマ","focus":["フォーカス1"],"keyDrill":"代表メニュー"}]
・focusedGaps は配列または null

[DOC_UPDATE]{"period":null,"sessionsPerWeek":null,"overallGoal":null,"focusedGaps":null,"phases":null,"milestones":null,"notes":null}[/DOC_UPDATE]`,
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function readDoc(type) {
  try {
    const fp = path.join(TEAM_DIR, `${type}.json`);
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { /* ignore */ }
  return null;
}

function writeDoc(type, doc) {
  fs.writeFileSync(
    path.join(TEAM_DIR, `${type}.json`),
    JSON.stringify({ updatedAt: new Date().toISOString(), doc }, null, 2),
    'utf8'
  );
}

function extractDocUpdate(text) {
  const m = text.match(/\[DOC_UPDATE\]([\s\S]*?)\[\/DOC_UPDATE\]/);
  if (!m) return null;

  let jsonStr = m[1].trim()
    // コードブロック除去
    .replace(/^```json?\s*/i, '').replace(/\s*```$/, '')
    // 末尾カンマ除去（JSONの最も多い構文エラー）
    .replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('[DOC_UPDATE parse error]', e.message, '| raw:', jsonStr.slice(0, 200));
    return null;
  }
}

function stripDocUpdate(text) {
  return text.replace(/\[DOC_UPDATE\][\s\S]*?\[\/DOC_UPDATE\]/, '').trim();
}

// ─── Main API ─────────────────────────────────────────────────────────────

async function sectionChat(type, userMessage) {
  const hist = histories[type];
  if (!hist) throw new Error('Unknown section: ' + type);

  // Build system prompt with cross-section context
  let sys = PROMPTS[type];

  const existing = readDoc(type);
  if (existing?.doc) {
    sys += `\n\n【これまでの整理内容（参照用）】\n${JSON.stringify(existing.doc)}`;
  }

  // plan: concept + status を参照、status: concept を参照
  if (type === 'plan' || type === 'status') {
    const concept = readDoc('concept');
    if (concept?.doc) sys += `\n\n【チームコンセプト（参照用）】\n${JSON.stringify(concept.doc)}`;
  }
  if (type === 'plan') {
    const status = readDoc('status');
    if (status?.doc) sys += `\n\n【チーム状況（参照用）】\n${JSON.stringify(status.doc)}`;
  }

  // ★ バグ修正: APIが失敗したとき履歴が壊れないよう、
  //   成功確認後にのみ履歴を更新する
  const messages = [...hist, { role: 'user', content: userMessage }];

  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  logUsage('claude-haiku-4-5-20251001', resp.usage, `section-${type}`);
  const raw = resp.content[0].text;
  const docDelta = extractDocUpdate(raw);
  const message  = stripDocUpdate(raw);

  // 成功後にのみ履歴を更新
  hist.push({ role: 'user', content: userMessage });
  hist.push({ role: 'assistant', content: raw });

  // ドキュメントのマージ
  const saved = readDoc(type);
  const merged = saved?.doc || {};
  if (docDelta) {
    const ARR_FIELDS = new Set(['strengths','weaknesses','gaps','keywords','values','focusedGaps','milestones','focus','keyPlayers']);
    for (const [k, v] of Object.entries(docDelta)) {
      if (v !== null && v !== undefined) {
        if ((k === 'playerCount' || k === 'sessionsPerWeek') && typeof v === 'string') {
          const n = parseInt(v, 10);
          merged[k] = isNaN(n) ? null : n;
        } else if (ARR_FIELDS.has(k) && typeof v === 'string') {
          // AIが配列の代わりに文字列で返した場合を正規化
          merged[k] = v.split(/[,、・\n]+/).map(s => s.trim()).filter(Boolean);
        } else {
          merged[k] = v;
        }
      }
    }
    writeDoc(type, merged);
  }

  return { message, doc: merged };
}

function getDoc(type) {
  const saved = readDoc(type);
  return saved?.doc || null;
}

function clearHistory(type) {
  if (histories[type]) histories[type] = [];
}

module.exports = { sectionChat, getDoc, clearHistory };
