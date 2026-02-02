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

import * as yaml from 'js-yaml';

// winning_patternsを読み込んでプロンプトに追加する情報を生成
function loadWinningPatterns(): string {
  try {
    const patternsPath = path.join(__dirname, '../content/winning_patterns.yml');
    if (!fs.existsSync(patternsPath)) return '';
    
    const patterns = yaml.load(fs.readFileSync(patternsPath, 'utf-8')) as any;
    
    // 最もパフォーマンスの良い投稿タイプを特定
    const typePerf = patterns.type_performance || {};
    const sortedTypes = Object.entries(typePerf)
      .filter(([_, v]: [string, any]) => v.avg_impressions > 0)
      .sort((a: any, b: any) => b[1].avg_impressions - a[1].avg_impressions);
    
    if (sortedTypes.length === 0) return '';
    
    const bestType = sortedTypes[0];
    const insights: string[] = [];
    
    insights.push(`【過去の分析結果から学んだこと】`);
    insights.push(`- 最もインプレッションが高い投稿タイプ: ${bestType[0]} (平均${bestType[1].avg_impressions}インプ)`);
    
    // 時間帯パフォーマンス
    const slotPerf = patterns.slot_performance || {};
    const bestSlot = Object.entries(slotPerf)
      .filter(([_, v]: [string, any]) => v.avg_impressions > 0)
      .sort((a: any, b: any) => b[1].avg_impressions - a[1].avg_impressions)[0];
    
    if (bestSlot) {
      insights.push(`- 最もエンゲージメントが高い時間帯: ${bestSlot[0]}`);
    }
    
    // 推奨事項
    if (patterns.recommendations?.length > 0) {
      insights.push(`- 推奨: ${patterns.recommendations[0]}`);
    }
    
    insights.push(`- 重要: ハッシュタグは使わない（Xアルゴリズム的に不利）`);
    
    return '\n' + insights.join('\n') + '\n';
  } catch (e) {
    console.log('Failed to load winning patterns:', e);
    return '';
  }
}

// 感情駆動プロンプトテンプレート
const PROMPTS = {
  weekly: `あなたは感情を動かすコピーライターです。
読者のスクロールを止め、心を揺さぶる投稿を作成してください。

【ターゲットの痛み】
- AIに「いい感じにやって」と頼んだら全然違うものができた
- Cursorの出力が毎回違って困っている
- 手戻りで深夜2時まで作業した
- チームメンバーのAIコードをレビューで全部書き直した
- プロトは1日で完成、本番品質にするのに2週間

【感情を動かす投稿の型】

■ 痛み共感型（「わかる...」と思わせる）
- 具体的な失敗シーンを描写
- 数字や時間でリアリティを出す
- 一人語りで感情を込める

■ 不安・焦り型（「やばい...」と思わせる）
- 周りとの差を意識させる
- 知らないことへの危機感を煽る
- 未来の自分を想像させる

■ 発見・転換型（「そうだったのか」と思わせる）
- 痛みからの解放を匂わせる
- 解決策をチラ見せ（売り込みはNG）

【今週の6投稿を作成】
| 曜日 | 感情の型 |
|------|----------|
| 月 | 痛み共感 |
| 火 | 不安・焦り |
| 水 | 痛み共感 |
| 木 | 発見・転換 |
| 金 | 痛み共感（最も刺さるやつ） |
| 土 | 発見・転換 |

【出力形式】JSON配列
\`\`\`json
[
  {"day": "monday", "emotion_type": "pain", "content": "投稿文"},
  ...
]
\`\`\`

【絶対ルール】
- 280文字以内
- ハッシュタグ禁止（絶対に使わない）
- 製品名（dev-OS等）禁止
- 絵文字は1個まで
- 「情報提供」ではなく「感情」を動かす
- 開発者が「俺のことだ...」と思う内容に`,

  buzz: `あなたは開発者の心を揺さぶるコピーライターです。

【ターゲットの痛み】
- AIに丸投げしたら3時間溶けた
- Cursorの出力が安定しなくて発狂しかけた
- 深夜2時にAIの手戻りでキレた
- チームメンバーのAIコードを全部書き直した
- プロトは速いが本番品質にならない

【依頼】
開発者が「わかる...」「やばい...」と思う投稿を5つ作成してください。

【感情の型】
1. 痛み共感（失敗談・苦労話）
2. 痛み共感（あるある）
3. 不安・焦り（このままでいいのか？）
4. 不安・焦り（周りとの差）
5. 発見・転換（解決の兆し）

【出力形式】JSON配列
\`\`\`json
[
  {"emotion": "pain", "content": "投稿文"},
  ...
]
\`\`\`

【絶対ルール】
- 280文字以内
- ハッシュタグ禁止
- 製品名禁止
- 絵文字は1個まで
- 「俺のことだ...」と思わせる`,

  tips: `あなたは開発者の感情を動かすコピーライターです。

【今週のネタ】
{topic}

【依頼】
このネタを「感情駆動」で3パターン作成してください。

■ パターン1: 痛み共感
- 「わかる...」と思わせる失敗談から始める
- 解決のヒントをチラ見せ

■ パターン2: 不安・焦り
- 「知らないとやばい」と思わせる
- 周りとの差を意識させる

■ パターン3: 発見・転換
- 「そうだったのか」と思わせる
- 世界が変わった瞬間を描写

【出力形式】JSON配列
\`\`\`json
[
  {"emotion": "pain", "content": "投稿文"},
  {"emotion": "fear", "content": "投稿文"},
  {"emotion": "discovery", "content": "投稿文"}
]
\`\`\`

【絶対ルール】
- 280文字以内
- ハッシュタグ禁止
- 製品名禁止
- 絵文字は1個まで`
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
  
  // 過去の分析結果を読み込み
  const winningInsights = loadWinningPatterns();
  
  const response = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: `あなたはSNSマーケティングの専門家です。日本語で回答してください。
${winningInsights}`
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

