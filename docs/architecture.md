# ペップ君 — アーキテクチャ設計書

> 最終更新：2026-05-28（Phase 0 初版）

---

## システム全体像

```
┌────────────────────────────────────────────────┐
│                  ユーザー（コーチ）                │
│              Web / モバイルアプリ                  │
└───────────────────────┬────────────────────────┘
                        │ HTTPS
┌───────────────────────▼────────────────────────┐
│              フロントエンド                        │
│           Next.js（Vercel）                      │
│   - 入力フォーム                                  │
│   - メニュー表示                                  │
│   - 保存・履歴管理                                │
└───────────────────────┬────────────────────────┘
                        │ REST API
┌───────────────────────▼────────────────────────┐
│              バックエンド API                      │
│          Node.js + TypeScript（Railway）         │
│   - 入力バリデーション                             │
│   - プロンプト構築                                │
│   - Claude API呼び出し                           │
│   - レスポンス整形                                │
└───────┬───────────────────────────┬────────────┘
        │                           │
┌───────▼──────┐          ┌────────▼────────────┐
│  Claude API  │          │    Supabase          │
│ (Anthropic)  │          │  - ユーザー管理        │
│  メニュー生成  │          │  - メニュー履歴保存    │
│              │          │  - ドリルライブラリDB   │
└──────────────┘          └─────────────────────┘
```

---

## コンポーネント詳細

### AIエンジン（最重要）

**役割**: サッカートレーニングメニューの生成

**設計方針**:
- System Prompt: サッカー指導の専門知識を注入
- User Prompt: コーチが入力した条件を構造化
- レスポンス形式: Structured Output（JSON）で後処理を容易に

**プロンプト構成**:
```
[System]
あなたはJFA公認S級ライセンスを持つトップコーチです。
サッカーの最新指導理論を熟知し、年齢・レベル・目的に応じた
最適なトレーニングメニューを設計できます。

[User]
以下の条件でトレーニングメニューを作成してください：
- 対象：{age_group}
- 人数：{players}
- 時間：{duration}分
- テーマ：{theme}
- レベル：{level}
...
```

---

## データモデル（初期設計）

```typescript
// TrainingMenu
interface TrainingMenu {
  id: string;
  userId: string;
  createdAt: Date;
  params: TrainingParams;
  content: MenuContent;
}

// 入力パラメータ
interface TrainingParams {
  ageGroup: 'U8' | 'U10' | 'U12' | 'U15' | 'adult';
  players: number;
  duration: number; // 分
  theme: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  equipment: string[];
  venue: string;
  notes?: string;
}

// 生成メニュー
interface MenuContent {
  title: string;
  warmup: Drill[];
  technical: Drill[];
  tactical: Drill[];
  game: Drill[];
  cooldown: Drill[];
  coachingPoints: string[];
}

// ドリル
interface Drill {
  name: string;
  duration: number;
  objective: string;
  description: string;
  variations?: string[];
}
```

---

## 開発ロードマップ

### Phase 1: AIコアエンジン（CLI MVP）
- プロンプトエンジニアリング
- Claude API統合
- 出力品質検証

### Phase 2: Web API化
- Express/Fastify APIサーバー
- Supabase接続
- 認証（Supabase Auth）

### Phase 3: Webフロントエンド
- Next.js アプリ
- 入力フォームUI
- メニュー表示・保存UI

### Phase 4: モバイル
- React Native
- iOS / Android対応

### Phase 5: 販売
- Stripe課金
- プレミアムプラン

---

*このドキュメントはクロップが随時更新する*
