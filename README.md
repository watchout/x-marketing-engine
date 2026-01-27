# X Marketing Engine

AI-powered X (Twitter) marketing automation with multi-LLM refinement.

## 🚀 Features

- **マルチLLM推敲ループ**: GPT-4o + Gemini + Grok で投稿を何周も改善
- **インフルエンサー監視**: バズ投稿のパターンを自動抽出・学習
- **A/Bテスト**: 2パターン生成で効果検証
- **自動投稿**: GitHub Actionsで毎日自動投稿
- **詳細ログ**: 全フローを記録・分析可能

## 📦 Setup

```bash
# 依存関係インストール
npm install

# 環境変数設定
cp .env.api.example .env.api
# .env.api を編集してAPIキーを設定
```

## 🔑 Required API Keys

| Key | Description |
|-----|-------------|
| `X_API_KEY` | X API Key |
| `X_API_SECRET` | X API Secret |
| `X_ACCESS_TOKEN` | X Access Token |
| `X_ACCESS_SECRET` | X Access Secret |
| `OPENAI_API_KEY` | OpenAI API Key (GPT-4o) |
| `GOOGLE_AI_API_KEY` | Google AI API Key (Gemini) |
| `GROK_API_KEY` | Grok API Key (optional) |

## 🛠 Commands

```bash
# 投稿生成（マルチLLM推敲）
npm run generate

# 投稿生成（ドライラン）
npm run generate:dry

# 投稿実行
npm run post:morning
npm run post:night

# インフルエンサー監視
npm run watch

# メトリクス収集
npm run metrics

# パフォーマンス分析
npm run analyze

# タイムライン同期
npm run sync

# ログ確認
npm run log:summary
npm run log:daily
```

## 📊 Architecture

```
┌─────────────────────────────────────────────────────┐
│                    監視層                           │
│  watch_influencers.ts → winning_patterns抽出       │
└─────────────────────┬───────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────┐
│                    生成層                           │
│  generate_post_multi_llm.ts                        │
│  ・Grok: ネタ提案                                   │
│  ・Gemini: ペルソナ分析・初稿                       │
│  ・GPT: フック評価                                  │
│  → 推敲ループ → A/B生成                            │
└─────────────────────┬───────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────┐
│                    投稿層                           │
│  auto_post.ts → X API投稿                          │
└─────────────────────┬───────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────┐
│                    分析層                           │
│  collect_metrics.ts → analyze_performance.ts       │
│  → 勝ちパターン更新 → 監視層へフィードバック        │
└─────────────────────────────────────────────────────┘
```

## 📅 GitHub Actions Schedule

| Time (JST) | Job | 投稿タイプ |
|------------|-----|-----------|
| 06:00 | メトリクス収集 + 分析 | - |
| 08:00 | マルチLLM投稿生成 | - |
| 09:00 | 朝投稿 | Tips型 |
| 12:00 | 昼投稿 | バズ狙い型 |
| 20:00 | 夜投稿 | 物語型 |

## 📊 Dashboard

ブラウザでダッシュボードを開く:

```bash
npm run dashboard
# または直接
open dashboard/index.html
```

ダッシュボードで確認できる情報:
- 📊 投稿数・インプレッション・いいね・ER
- ⏰ 投稿スケジュール
- 👤 ベンチマークアカウント（Tier1-3）
- 📝 最新投稿一覧
- 📋 アクティビティログ

## 🌐 Vercel デプロイ

### 1. Vercelにデプロイ

```bash
vercel --prod
```

### 2. 必要な環境変数（Vercel管理画面で設定）

| 環境変数 | 説明 | 必須 |
|----------|------|------|
| `DASHBOARD_PASSWORD` | ダッシュボードのパスワード | ✅ |
| `VERCEL_API_TOKEN` | Vercel APIトークン（環境変数管理用） | ✅ |
| `VERCEL_PROJECT_ID` | VercelプロジェクトID | ✅ |
| `GITHUB_TOKEN` | GitHub PAT（Secrets同期用） | ✅ |
| `GITHUB_REPO` | リポジトリ名（例: `user/repo`） | ✅ |
| `X_API_KEY` | X API Key | ✅ |
| `X_API_SECRET` | X API Secret | ✅ |
| `X_ACCESS_TOKEN` | X Access Token | ✅ |
| `X_ACCESS_SECRET` | X Access Secret | ✅ |
| `OPENAI_API_KEY` | OpenAI API Key | ✅ |
| `GROK_API_KEY` | Grok API Key | 推奨 |
| `GOOGLE_AI_API_KEY` | Google AI API Key | 推奨 |

### 3. GitHub Personal Access Token の取得

1. https://github.com/settings/tokens/new にアクセス
2. 以下の権限を付与:
   - `repo` (Full control of private repositories)
   - `workflow` (Update GitHub Action workflows)
3. 生成されたトークンをVercel環境変数 `GITHUB_TOKEN` に設定

### 4. Vercel API Token の取得

1. https://vercel.com/account/tokens にアクセス
2. トークンを作成
3. Vercel環境変数 `VERCEL_API_TOKEN` に設定

### 5. Project ID の取得

1. Vercel管理画面でプロジェクトを開く
2. Settings → General → Project ID をコピー
3. Vercel環境変数 `VERCEL_PROJECT_ID` に設定

### ダッシュボード設定画面

`https://your-app.vercel.app/settings.html` から:
- X API認証情報の設定
- AI API Keyの設定
- GitHub Secretsへの同期

## 📁 Directory Structure

```
x-marketing-engine/
├── scripts/              # 各種スクリプト
├── config/               # 設定ファイル
│   └── settings.yml      # アカウント・ペルソナ設定
├── content/              # コンテンツ・ログ
│   ├── ab_test_pool.yml  # 投稿プール
│   ├── post_history.json # 投稿履歴
│   ├── logs/             # 詳細ログ
│   └── cache/            # キャッシュ
└── .github/workflows/    # GitHub Actions
```

## 📜 License

Private
