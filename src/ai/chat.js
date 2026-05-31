const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 会話履歴をメモリに保持
const conversations = new Map();

const DIALOGUE_BASE_PROMPT = `あなたは「ペップ君」——サッカー指導者専門のAIアシスタントです。
コーチが言葉にできていない「やりたいこと」を対話で整理し、最高の練習メニューを設計するのが役割です。

【ペップ君のキャラクター】
- 情熱的で親しみやすい。コーチの言葉を引き出す
- 専門知識は相手に合わせて使う
- 質問は1回1個だけ。多くの質問を一気に投げない

【チームコンテキストがある場合の進め方（最重要）】
チームのコンセプト・現状・プランが既に登録されている場合：
1. 年代・人数・レベル・コンセプトは「既に把握済み」として再度聞かない
2. チームの課題（gaps）・強み・弱みを把握した上で今日のテーマを提案する
3. 「今日何時間練習できますか？」「今日特に重点的に取り組みたいことは？」の2点だけ確認
4. 2〜3往復でGENERATE_PARAMSを出力する（チーム情報が揃っているので素早く進める）

【チームコンテキストがない場合の進め方】
フェーズ1: 年代・人数・レベルを確認
フェーズ2: 練習時間・今日の特記事項を確認
フェーズ3: テーマ掘り下げ（何を改善したいか）
フェーズ4: 3〜5往復後に要約して確認

【絶対禁止事項】
- 練習メニューの内容（ドリル名・やり方・時間・図解など）を直接チャットに書いてはいけない
- メニューの生成はシステムが行う。あなたはパラメータを収集してGENERATE_PARAMSを出力するだけ
- ドリルの提案・説明・リストアップを会話中に行わないこと

【生成パラメータの出力ルール】
- 確認メッセージには「✅ この方向でメニューを生成しますか？」を必ず含める
- コーチが同意したら返答末尾に以下タグを付ける（タグ後は不要）

[GENERATE_PARAMS]
{
  "teamName": "チーム名",
  "ageGroup": "U-8/U-10/U-12/U-15/U-18/社会人",
  "players": 人数（数値）,
  "duration": 練習時間分（数値）,
  "theme": "今日のメインテーマ",
  "level": "初心者/中級/上級",
  "concept": "チームコンセプト要約",
  "notes": "特記事項・今日の重点課題"
}
[/GENERATE_PARAMS]`;

function buildSystemPrompt(teamContext) {
  let sys = DIALOGUE_BASE_PROMPT;

  const hasConcept = teamContext?.concept && Object.values(teamContext.concept).some(v => v !== null);
  const hasStatus  = teamContext?.status  && Object.values(teamContext.status).some(v => v !== null);
  const hasPlan    = teamContext?.plan    && Object.values(teamContext.plan).some(v => v !== null);

  if (hasConcept || hasStatus || hasPlan) {
    sys += '\n\n【登録済みチーム情報（この情報を完全に把握した上で対話せよ）】';
    if (hasConcept) {
      const c = teamContext.concept;
      sys += `\n\n■ チームコンセプト\n目指すスタイル: ${c.playingStyle || ''}\n哲学: ${c.philosophy || ''}\nキーワード: ${Array.isArray(c.keywords) ? c.keywords.join('・') : c.keywords || ''}\n大切にしていること: ${Array.isArray(c.values) ? c.values.join('・') : c.values || ''}\n短期目標: ${c.shortTermGoal || ''}\n長期ビジョン: ${c.longTermGoal || ''}`;
    }
    if (hasStatus) {
      const s = teamContext.status;
      sys += `\n\n■ チーム状況\nチーム名: ${s.teamName || ''}\n年代: ${s.ageGroup || ''}\n人数: ${s.playerCount || ''}名\nレベル: ${s.level || ''}\n現状概要: ${s.overview || ''}\n強み: ${Array.isArray(s.strengths) ? s.strengths.join('、') : s.strengths || ''}\n課題: ${Array.isArray(s.weaknesses) ? s.weaknesses.join('、') : s.weaknesses || ''}\nコンセプトとのギャップ: ${Array.isArray(s.gaps) ? s.gaps.join(' / ') : s.gaps || '未設定'}\n今一番取り組むべきこと: ${s.currentFocus || ''}`;
    }
    if (hasPlan) {
      const p = teamContext.plan;
      sys += `\n\n■ トレーニングプラン\n計画期間: ${p.period || ''}\n全体目標: ${p.overallGoal || ''}\n重点ギャップ: ${Array.isArray(p.focusedGaps) ? p.focusedGaps.join(' / ') : p.focusedGaps || ''}`;
      if (p.phases?.length) {
        sys += `\n現在のフェーズ: ${p.phases[0].name} - ${p.phases[0].theme}`;
      }
    }

    sys += `\n\n【対話指示】
上記チーム情報を完全に把握しているので：
・チーム名・年代・人数・レベル・コンセプトは既知として扱い絶対に再度聞かない
・ギャップ・課題を踏まえ「今日このギャップに取り組みませんか？」と提案できる
・「今日の練習時間」と「今日特に重点的にやりたいこと（または承認）」の確認だけで十分
・notesフィールドには今日の重点課題とギャップを自動的に含めること
・2〜3往復でGENERATE_PARAMSを出力すること`;
  }

  return sys;
}

function getOrCreateConversation(conversationId) {
  if (!conversations.has(conversationId)) {
    conversations.set(conversationId, { messages: [], turnCount: 0 });
  }
  return conversations.get(conversationId);
}

function extractGenerateParams(text) {
  const match = text.match(/\[GENERATE_PARAMS\]([\s\S]*?)\[\/GENERATE_PARAMS\]/);
  if (!match) return null;
  try { return JSON.parse(match[1].trim()); } catch { return null; }
}

function stripGenerateParams(text) {
  return text.replace(/\[GENERATE_PARAMS\][\s\S]*?\[\/GENERATE_PARAMS\]/, '').trim();
}

async function chatMessage(conversationId, userMessage, teamContext = null) {
  const conv = getOrCreateConversation(conversationId);
  conv.messages.push({ role: 'user', content: userMessage });
  conv.turnCount++;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: [{ type: 'text', text: buildSystemPrompt(teamContext), cache_control: { type: 'ephemeral' } }],
    messages: conv.messages,
  });

  const rawText = response.content[0].text;
  const generateParams = extractGenerateParams(rawText);
  const displayText = stripGenerateParams(rawText);
  conv.messages.push({ role: 'assistant', content: rawText });

  return { message: displayText, turnCount: conv.turnCount, readyToGenerate: generateParams !== null, generateParams };
}

function clearConversation(conversationId) {
  conversations.delete(conversationId);
}

module.exports = { chatMessage, clearConversation };
