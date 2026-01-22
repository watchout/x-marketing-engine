/**
 * Grok APIを使ったX投稿文自動生成スクリプト
 * 
 * 使い方:
 *   npm run marketing:grok:weekly     # 週間投稿を一括生成
 *   npm run marketing:grok:buzz       # バズ狙い投稿を生成
 *   npm run marketing:grok:tips "ネタ" # Tipsを生成
 * 
 * 必要な環境変数:
 *   GROK_API_KEY
 */

import * as fs from 'fs';
import * as path from 'path';

// 環境変数ファイルを読み込み
function loadEnvFile(): void {
  const envFiles = ['.env.api', '.env.local', '.env'];
  const projectRoot = path.join(__dirname, '..');
  
  for (const envFile of envFiles) {
    const envPath = path.join(projectRoot, envFile);
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        
        const match = trimmed.match(/^([^=]+)=(.*)$/);
        if (match) {
          const key = match[1].trim();
          let value = match[2].trim();
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
      return;
    }
  }
}

loadEnvFile();

// API設定（OpenRouter または xAI直接）
// 複数のキー名に対応
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTERT_KEY || process.env.OPENROUTER_KEY;
const USE_OPENROUTER = !!OPENROUTER_KEY;
const API_URL = USE_OPENROUTER 
  ? 'https://openrouter.ai/api/v1/chat/completions'
  : 'https://api.x.ai/v1/chat/completions';

// OpenRouterで利用可能なモデル
// Grok 4.1 Fast: 最新のエージェント機能・ツール利用に最適化
// Grok 4: 高度な推論能力を持つフラッグシップモデル
// Grok 3: 汎用性の高い旧フラッグシップ
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'x-ai/grok-3';  // コスパ重視でGrok 3を使用
const MODEL = USE_OPENROUTER ? OPENROUTER_MODEL : 'grok-2-latest';

// プロンプトテンプレート
const PROMPTS = {
  weekly: `あなたはAI開発ツール「dev-OS」のマーケティング担当です。

【プロダクト概要】
- AI開発の品質管理OS
- 「AIで作ったコード、結局自分で直してませんか？」という課題を解決
- SSOT（Single Source of Truth）で仕様を整え、AIの出力品質を安定させる
- ターゲット: スタートアップのCTO/テックリード、個人開発者

【今週の投稿を作成してください】
月曜〜土曜の6投稿を作成:

| 曜日 | 時間 | タイプ |
|------|------|--------|
| 月 | 12:00 | Build in Public（開発進捗） |
| 火 | 19:00 | Tips（Cursor/AI開発） |
| 水 | 12:00 | Build in Public（学び・気づき） |
| 木 | 19:00 | Tips（SaaS開発のコツ） |
| 金 | 12:00 | バズ狙い（問いかけ・共感） |
| 土 | 10:00 | 週次振り返り |

【フォーマット】
各投稿を以下のJSON形式で出力:

\`\`\`json
[
  {
    "day": "monday",
    "time": "12:00",
    "type": "build_in_public",
    "content": "投稿文（280文字以内、ハッシュタグ含む）"
  },
  ...
]
\`\`\`

【ルール】
- 各投稿は280文字以内
- ハッシュタグは2-3個
- 絵文字は控えめ（0-2個）
- 宣伝色を出さない（価値提供が目的）
- 具体的なエピソードや数字を入れる`,

  buzz: `あなたはAI開発ツール「dev-OS」のマーケティング担当です。

【プロダクト概要】
dev-OSは「AIで作ったコード、結局自分で直してませんか？」という課題を解決するAI開発品質管理OSです。

【依頼】
開発者の共感を呼ぶ「バズ狙い」投稿を5パターン作成してください。

【切り口】
- AI開発の「あるある」な失敗
- Cursor/Copilotを使っていて感じるモヤモヤ
- プロトタイプは早いが本番品質にならない問題

【フォーマット】
JSON配列で出力:
\`\`\`json
[
  {"type": "question", "content": "投稿文"},
  {"type": "aruaru", "content": "投稿文"},
  ...
]
\`\`\`

【ルール】
- 280文字以内
- ハッシュタグ2-3個
- dev-OSの宣伝は入れない`,

  tips: `あなたはAI開発ツール「dev-OS」のマーケティング担当です。

【今週のネタ】
{topic}

【依頼】
これを元に、開発者向けのTips投稿を3パターン作成してください。

【フォーマット】
JSON配列で出力:
\`\`\`json
[
  {"format": "simple", "content": "投稿文"},
  {"format": "before_after", "content": "投稿文"},
  {"format": "discovery", "content": "投稿文"}
]
\`\`\`

【ルール】
- 280文字以内
- 具体的で再現可能
- ハッシュタグ2-3個`
};

// LLM APIを呼び出し（OpenRouter または xAI直接）
async function callGrokAPI(prompt: string): Promise<string> {
  const apiKey = USE_OPENROUTER 
    ? OPENROUTER_KEY 
    : process.env.GROK_API_KEY;
  
  if (!apiKey) {
    const keyName = USE_OPENROUTER ? 'OPENROUTER_API_KEY' : 'GROK_API_KEY';
    throw new Error(`${keyName} が設定されていません。.env.api に追加してください。`);
  }
  
  console.log(`🔌 Using: ${USE_OPENROUTER ? 'OpenRouter' : 'xAI直接'} (${MODEL})`);
  
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  
  // OpenRouter用の追加ヘッダー
  if (USE_OPENROUTER) {
    headers['HTTP-Referer'] = 'https://dev-os.iyasaka.co.jp';
    headers['X-Title'] = 'dev-OS Marketing';
  }
  
  const response = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: 'あなたはSNSマーケティングの専門家です。日本語で回答してください。'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.8,
      max_tokens: 2000,
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Grok API error: ${response.status} - ${error}`);
  }
  
  const data = await response.json() as {
    choices: Array<{
      message: {
        content: string;
      };
    }>;
  };
  
  return data.choices[0].message.content;
}

// JSONを抽出
function extractJSON(text: string): unknown {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (match) {
    return JSON.parse(match[1]);
  }
  // JSONブロックがない場合は全体をパース試行
  return JSON.parse(text);
}

// 週間投稿を生成
async function generateWeeklyPosts(): Promise<void> {
  console.log('📝 Grokで週間投稿を生成中...\n');
  
  try {
    const response = await callGrokAPI(PROMPTS.weekly);
    console.log('='.repeat(60));
    console.log('📅 生成された週間投稿');
    console.log('='.repeat(60));
    
    try {
      const posts = extractJSON(response) as Array<{
        day: string;
        time: string;
        type: string;
        content: string;
      }>;
      
      posts.forEach((post, i) => {
        console.log(`\n【${post.day} ${post.time}】${post.type}`);
        console.log('─'.repeat(40));
        console.log(post.content);
      });
      
      // ファイルに保存
      const outputPath = path.join(__dirname, '../content/grok_generated/weekly_posts.json');
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(outputPath, JSON.stringify(posts, null, 2));
      console.log(`\n✅ 保存先: ${outputPath}`);
      
    } catch {
      // JSONパース失敗時はそのまま表示
      console.log(response);
    }
    
  } catch (error) {
    console.error('❌ エラー:', error);
  }
}

// バズ狙い投稿を生成
async function generateBuzzPosts(): Promise<void> {
  console.log('🔥 Grokでバズ狙い投稿を生成中...\n');
  
  try {
    const response = await callGrokAPI(PROMPTS.buzz);
    console.log('='.repeat(60));
    console.log('🔥 生成されたバズ狙い投稿');
    console.log('='.repeat(60));
    
    try {
      const posts = extractJSON(response) as Array<{
        type: string;
        content: string;
      }>;
      
      posts.forEach((post, i) => {
        console.log(`\n【パターン${i + 1}: ${post.type}】`);
        console.log('─'.repeat(40));
        console.log(post.content);
      });
      
    } catch {
      console.log(response);
    }
    
  } catch (error) {
    console.error('❌ エラー:', error);
  }
}

// Tips投稿を生成
async function generateTipsPosts(topic: string): Promise<void> {
  console.log(`💡 Grokで「${topic}」のTips投稿を生成中...\n`);
  
  const prompt = PROMPTS.tips.replace('{topic}', topic);
  
  try {
    const response = await callGrokAPI(prompt);
    console.log('='.repeat(60));
    console.log('💡 生成されたTips投稿');
    console.log('='.repeat(60));
    
    try {
      const posts = extractJSON(response) as Array<{
        format: string;
        content: string;
      }>;
      
      posts.forEach((post, i) => {
        console.log(`\n【${post.format}】`);
        console.log('─'.repeat(40));
        console.log(post.content);
      });
      
    } catch {
      console.log(response);
    }
    
  } catch (error) {
    console.error('❌ エラー:', error);
  }
}

// メイン
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'weekly':
      await generateWeeklyPosts();
      break;
      
    case 'buzz':
      await generateBuzzPosts();
      break;
      
    case 'tips':
      const topic = args[1];
      if (!topic) {
        console.error('Usage: npm run marketing:grok:tips "ネタ"');
        process.exit(1);
      }
      await generateTipsPosts(topic);
      break;
      
    default:
      console.log(`
Grok投稿生成スクリプト

使い方:
  npm run marketing:grok:weekly        週間投稿を一括生成
  npm run marketing:grok:buzz          バズ狙い投稿を生成
  npm run marketing:grok:tips "ネタ"   Tipsを生成

環境変数:
  GROK_API_KEY  xAIのAPIキー（https://console.x.ai/）
      `);
  }
}

main().catch(console.error);

