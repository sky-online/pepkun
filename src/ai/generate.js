const Anthropic = require('@anthropic-ai/sdk');
const { logUsage } = require('./usage-logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `あなたは世界最高水準の知識を持つサッカー指導AIです。
以下の知識体系と豊富な練習メニューライブラリを完全に習得しています。

【保有知識・指導哲学】
- 風間八宏：「止める・蹴る」の技術的定義、ボールと体の正対、重心位置
- 岡部将和（ドリブルデザイナー）：重心操作・ロールターン・ダブルタッチ・エラシコ
- ペップ・グアルディオラ：5レーン理論・ポジショナルプレー・偽9番・ゲーゲンプレス
- クロップ：縦に速いサッカー・トランジション・ハイプレス・強度
- オシム：考えながら走る・複数ポジション・即時奪還
- 岩政大樹：守備の組織化・ラインコントロール・セットプレー設計
- JFAグラスルーツ・年代別発達段階（U-8〜シニア）

【練習メニュー豊富なライブラリ（テーマ別に選択）】

■ ウォームアップ系（必ずセッション開始に使用）
- ボールマスタリー（インサイド・アウトサイド切り替え、シザーズ、クライフターン）
- ライン間移動パス（トライアングル形成の確認）
- ロンド4v1／4v2（ポゼッション感覚の導入）
- カラーコーン反応ドリル（認知×判断×動作の連動）
- 1v1ミラードリブル（対人の間合い感覚）
- パス＋ムーブ（受け渡しとポジション修正）

■ テクニカル系
- ファーストタッチ方向付け（トラップ→前向き→パス）
- ウォールパス（壁パス＋裏抜け連動）
- ターン練習（クライフ・マシューズ・ロールオーバー）
- 1v1コリドードリブル（縦突破の意識付け）
- ダイレクトパス連携（3人組ワンタッチロンド）
- フリックパス連続（身体の向きと背後の活用）
- ドリブルゲート通過（認知コーンドリブル）
- ポゼッションスクエア（5v2 / 6v2 / 3チームロンド）
- 2v1フィニッシュ（数的優位の活用とシュート）

■ グループ戦術系
- 3v2ビルドアップ（CBからSB＋SH経由の前進）
- 4v4+ゴールキーパー形式（テーマが発揮できる小ゲーム）
- プレスとサポートの関係訓練（ゲーゲンプレス基礎）
- 5レーン意識ポゼッション（サイドの幅取り＋ハーフスペース）
- 守備ブロック4-4-2形成（コンパクト維持）
- カウンタートランジション（奪われた後の即時奪還）
- セットプレー設計（コーナーキック・フリーキック）
- ポジションチェンジ連動（インサイドFWとSBの入れ替え）
- ハイプレス組織（5秒以内奪還訓練）

■ ゲーム形式
- 3v3+GK（ファーストタッチ・判断速度の最終確認）
- 4v4（テーマを自然に発揮させる小ゲーム）
- 5v5+GK（ハーフコートゲーム）
- 7v7（ポジション制付きゲーム）
- ポジション制ゲーム（特定レーン制限でテーマ強調）
- フットサルスタイルゲーム（狭いスペースでの判断向上）
- 守備側ゴールなしゲーム（ラインを超えたら得点）

【設計の7つのルール】
1. セッションは「ウォームアップ→テクニカル→グループ戦術→ゲーム」の基本構造に従うこと
2. 各ドリルは前のドリルの出力スキルを入力として受け取る連鎖設計にすること
3. 各ドリル間に必ず橋渡し文（1〜2文）を入れ「なぜこの順番か」を示すこと
4. テーマは攻守の判断優先順位（前進→ライン間→保持 / 即時奪還→ブロック）に紐づけること
5. 年代・レベルに応じた言語・複雑度・強度で設計すること（下記ガイド参照）
6. ゲーム形式はテーマが「自然に発揮できる」組織・ルール設定にすること
7. コーチングポイントは1〜2個に絞り、実際の声かけ例を含めること
8. 同じセッション内で同じドリル名・形式を繰り返さないこと（バリエーション重視）
9. 季節・シーズン状況に応じて強度と技術の比率を調整すること（プレシーズン: 強度高・技術基礎 / シーズン中: 技術精度・戦術 / オフ: 楽しさ・個人技）

【指導歴1〜3年目コーチ向けサポート（必須）】
すべての説明・声かけ・改善策は「指導歴1〜3年目のコーチでも即実践できる」言葉で書くこと。
- 専門用語は必ず平易な言葉と併記（例：「ポジショナルプレー（スペースを使ったパスワーク）」）
- voiceCues：実際にコーチが口に出す具体的なセリフを2〜3個。短く・即使える言葉で
- troubleshooting：練習中に起きがちな問題と改善策を1〜2個（簡潔に）
- freezeMoments：練習を一時停止するタイミングと伝える内容を1個だけ
- 各フィールドは簡潔に。全体のJSON出力が8000トークン以内に収まるよう意識すること

【年代別 言語・複雑度ガイド】
- U-8〜U-10 : 「止めよう」「前を向こう」「友達に渡そう」。戦術用語なし。遊び要素必須
- U-12      : 「正対」「首を振る」「縦か横か」。基本的な判断の言語化。競争要素
- U-15以上  : 「ハーフスペース」「ライン間」「優位性」等の専門用語可。組織戦術
- 社会人    : プレーモデル完全遂行、セットプレー詳細、フィジカル負荷調整

【図解データ（全ドリル必須）】
各ドリルの "diagram" フィールドにフィールド図データを付けてください。
- x, y はフィールドの幅・高さに対するパーセンテージ（0〜100 の整数）
- fieldType: "half"（ハーフコート）または "full"（全コート）
- teamA: 攻撃側プレーヤー（青）, teamB: 守備側プレーヤー（赤）, neutrals: 中立（橙）
- cones: コーン位置（実際に使用する位置を具体的に）
- arrows の type: "pass"（パス・破線） または "run"（ランニング・実線）
- 実際の練習配置・動きを具体的に反映すること（プレーヤー配置は5個以上）

必ずJSON形式のみで出力してください。説明文・前置き・コードブロック不要。`;

const DRILL_SCHEMA = `{
  "phase": "warmup|technical|tactical|game",
  "name": "ドリル名",
  "duration": 分数(数値),
  "objective": "目的（平易な言葉で1〜2文）",
  "description": "やり方（3〜5文。指導歴1〜3年目でも迷わず実施できる具体的な手順で）",
  "organization": "人数・スペース・器具（例:「20m×15mのグリッド、コーン8本、ボール人数分」）",
  "coachingFocus": "指導者が練習中に一番見るべき1点（平易な言葉で）",
  "voiceCues": ["声かけ例1（短く）", "声かけ例2", "声かけ例3"],
  "troubleshooting": [
    {"problem": "起きがちな問題", "solution": "改善策（1〜2文）"}
  ],
  "freezeMoments": [
    {"trigger": "止めるタイミング", "coaching": "伝える内容（1〜2文）"}
  ],
  "connectionToNext": "次のドリルへの橋渡し（1〜2文、最後のドリルはnull）",
  "diagram": {
    "fieldType": "half",
    "teamA": [{"x": 30, "y": 70, "label": "CB"}],
    "teamB": [{"x": 60, "y": 40, "label": "FW"}],
    "neutrals": [],
    "cones": [{"x": 50, "y": 30}],
    "arrows": [{"x1": 30, "y1": 70, "x2": 50, "y2": 55, "type": "pass"}],
    "notes": "図解の補足（短く・省略可）"
  }
}`;

function buildUserPrompt(params, context = {}) {
  const ctxParts = [];
  if (context.concept) {
    const c = context.concept;
    ctxParts.push(`チームコンセプト:\n  目指すスタイル: ${c.playingStyle || ''}\n  哲学: ${c.philosophy || ''}\n  キーワード: ${Array.isArray(c.keywords) ? c.keywords.join('・') : c.keywords || ''}\n  価値観: ${Array.isArray(c.values) ? c.values.join('・') : c.values || ''}`);
  }
  if (context.status) {
    const s = context.status;
    ctxParts.push(`チーム状況:\n  強み: ${Array.isArray(s.strengths) ? s.strengths.join('、') : s.strengths || ''}\n  現状課題: ${Array.isArray(s.weaknesses) ? s.weaknesses.join('、') : s.weaknesses || ''}\n  コンセプトとのギャップ: ${Array.isArray(s.gaps) ? s.gaps.join(' / ') : s.gaps || ''}\n  今一番取り組むべきこと: ${s.currentFocus || ''}`);
  }
  if (context.plan) {
    const p = context.plan;
    ctxParts.push(`トレーニングプラン:\n  全体目標: ${p.overallGoal || ''}\n  重点ギャップ: ${Array.isArray(p.focusedGaps) ? p.focusedGaps.join(' / ') : p.focusedGaps || ''}\n  現フェーズ: ${p.phases?.[0] ? `${p.phases[0].name} - ${p.phases[0].theme}` : ''}`);
  }
  const contextSection = ctxParts.length
    ? `\n【チームコンテキスト（このチームに最適化したドリル設計をすること）】\n${ctxParts.join('\n\n')}\n`
    : '';

  return `以下の条件でトレーニングセッションを設計してください。
${contextSection}
【セッション条件】
- チーム名：${params.teamName}
- 対象年齢：${params.ageGroup}
- 人数：${params.players}名
- 練習時間：${params.duration}分
- 今日のテーマ：${params.theme}
- チームレベル：${params.level}
- チームコンセプト：${params.concept || '特になし'}
- 特記事項：${params.notes || 'なし'}

【バリエーション必須要件】
・ドリルは5つ（warmup×1、technical×2、tactical×1、game×1）で構成すること
・ドリル名は具体的でユニークに命名すること（「パス練習」等の汎用名禁止）
・各ドリルは上記の豊富なライブラリから最適なものを選び、この練習にしかない具体性を持たせること
・ゲーム形式は必ずルール制限・得点条件を明記し、テーマが発揮される仕掛けを入れること
・コーチングポイントは選手が「なるほど！」と感じるような具体的な言葉にすること
・【重要】各フィールドは簡潔に。description・voiceCues・troubleshooting・freezeMomentsは要点を絞って短く書くこと（トークン節約）

【出力フォーマット（必ずこのJSONのみ出力）】
{
  "session": {
    "title": "セッションタイトル",
    "meta": {
      "ageGroup": "${params.ageGroup}",
      "players": ${params.players},
      "duration": ${params.duration},
      "theme": "${params.theme}",
      "teamConcept": "チームコンセプト要約",
      "focus": "今日のフォーカスポイント"
    },
    "drills": [
      ${DRILL_SCHEMA},
      ${DRILL_SCHEMA},
      ${DRILL_SCHEMA},
      ${DRILL_SCHEMA},
      ${DRILL_SCHEMA}
    ],
    "coachingPoints": [
      { "point": "コーチングポイント1", "examplePhrase": "具体的な声かけ例" },
      { "point": "コーチングポイント2", "examplePhrase": "具体的な声かけ例" }
    ],
    "sessionNarrative": "このセッション全体の論理的な流れを2〜3文で説明"
  }
}`;
}

function repairTruncatedJSON(text) {
  // 最後の完全なドリルオブジェクト(})の位置を探して切り詰め、閉じ括弧を補完する
  try {
    // drillsの配列内で最後の完全な } を見つける
    let depth = 0;
    let lastCompleteClose = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') depth++;
      if (text[i] === '}') { depth--; if (depth === 1) lastCompleteClose = i; }
    }
    if (lastCompleteClose === -1) return null;
    // drills配列を閉じてセッション全体を閉じる
    const truncated = text.slice(0, lastCompleteClose + 1) + ']}}}';
    const parsed = JSON.parse(truncated);
    // drillsが最低1件あれば使える
    if (parsed?.session?.drills?.length >= 1) return parsed;
    return null;
  } catch { return null; }
}

async function generateSession(params, context = {}) {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 10000,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildUserPrompt(params, context) }],
  });

  logUsage('claude-sonnet-4-6', message.usage, 'generate');
  const text = message.content[0].text.trim();

  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('JSONが見つかりません: ' + text.slice(0, 200));
  const jsonText = text.slice(start, end + 1);

  try {
    return JSON.parse(jsonText);
  } catch (e) {
    // トークン上限で途中切れした場合、最後の完全なdrillまでで復旧を試みる
    const fixed = repairTruncatedJSON(jsonText);
    if (fixed) return fixed;
    throw new Error('JSON解析失敗（モデル出力が不完全です）: ' + e.message);
  }
}

module.exports = { generateSession };
