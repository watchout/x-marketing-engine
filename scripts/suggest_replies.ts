/**
 * インフルエンサーへのリプライ提案スクリプト
 * 
 * 機能:
 *   - ベンチマークアカウントの最新投稿を取得
 *   - 関連性の高い投稿をピックアップ
 *   - AIがリプライ案を生成
 *   - 手動投稿用のリストを出力
 * 
 * 使い方:
 *   npx ts-node scripts/suggest_replies.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

// 環境変数読み込み
function loadEnvFile(): void {
  const envPath = path.join(__dirname, '../.env.api');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const cleanedLine = trimmed.replace(/^export\s+/, '');
      const match = cleanedLine.match(/^([^=]+)=(.*)$/);
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
  }
}

loadEnvFile();

// 設定読み込み
const SETTINGS_FILE = path.join(__dirname, '../config/settings.yml');
const OUTPUT_FILE = path.join(__dirname, '../content/reply_suggestions.json');

interface Tweet {
  id: string;
  text: string;
  author: string;
  created_at: string;
  url: string;
  metrics?: {
    likes: number;
    retweets: number;
    replies: number;
  };
}

interface ReplySuggestion {
  tweet: Tweet;
  suggested_reply: string;
  relevance: 'high' | 'medium' | 'low';
  reason: string;
  generated_at: string;
}

// X API クライアント初期化
async function getXClient() {
  const { TwitterApi } = await import('twitter-api-v2');
  
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY!,
    appSecret: process.env.X_API_SECRET!,
    accessToken: process.env.X_ACCESS_TOKEN!,
    accessSecret: process.env.X_ACCESS_SECRET!,
  });
  
  return client;
}

// ベンチマークアカウントの設定を読み込み
function loadBenchmarkAccounts(): string[] {
  if (!fs.existsSync(SETTINGS_FILE)) {
    return ['ai_jitan', 'Fujin_Metaverse', 'commte', 'akira_papa_IT'];
  }
  
  const settings = yaml.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  const accounts: string[] = [];
  
  if (settings.benchmark_accounts) {
    for (const tier of Object.values(settings.benchmark_accounts) as any[]) {
      for (const acc of tier) {
        accounts.push(acc.handle.replace('@', ''));
      }
    }
  }
  
  return accounts.length > 0 ? accounts : ['ai_jitan', 'Fujin_Metaverse'];
}

// ユーザーの最新ツイートを取得
async function getRecentTweets(client: any, handle: string, count: number = 5): Promise<Tweet[]> {
  try {
    const user = await client.v2.userByUsername(handle);
    if (!user.data?.id) return [];
    
    const timeline = await client.v2.userTimeline(user.data.id, {
      max_results: count,
      'tweet.fields': ['created_at', 'public_metrics'],
      exclude: ['retweets', 'replies']
    });
    
    const tweets: Tweet[] = [];
    for (const tweet of timeline.data?.data || []) {
      tweets.push({
        id: tweet.id,
        text: tweet.text,
        author: handle,
        created_at: tweet.created_at || new Date().toISOString(),
        url: `https://x.com/${handle}/status/${tweet.id}`,
        metrics: tweet.public_metrics ? {
          likes: tweet.public_metrics.like_count,
          retweets: tweet.public_metrics.retweet_count,
          replies: tweet.public_metrics.reply_count
        } : undefined
      });
    }
    
    return tweets;
  } catch (e) {
    console.error(`  ⚠️ Failed to get tweets for @${handle}:`, e);
    return [];
  }
}

// 関連性を判定
function checkRelevance(tweet: Tweet): { relevance: 'high' | 'medium' | 'low', reason: string } {
  const text = tweet.text.toLowerCase();
  
  // 高関連性キーワード
  const highKeywords = ['cursor', 'ai開発', 'claude', 'エージェント', 'ssot', 'バイブ', 'プロンプト'];
  for (const kw of highKeywords) {
    if (text.includes(kw)) {
      return { relevance: 'high', reason: `「${kw}」に関する投稿` };
    }
  }
  
  // 中関連性キーワード
  const mediumKeywords = ['ai', '自動化', '効率化', 'ツール', 'コード', '開発'];
  for (const kw of mediumKeywords) {
    if (text.includes(kw)) {
      return { relevance: 'medium', reason: `「${kw}」に関する投稿` };
    }
  }
  
  return { relevance: 'low', reason: '一般的な投稿' };
}

// リプライ案を生成（GPT使用）
async function generateReplyDraft(tweet: Tweet): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return `興味深い視点ですね！dev-OSでも似たアプローチを試しています。`;
  }
  
  try {
    const prompt = `あなたはAI開発ツール「dev-OS」の開発者です。
以下のツイートに対する自然なリプライを1つ生成してください。

ツイート: "${tweet.text}"

条件:
- 宣伝っぽくならない、自然な会話
- 相手の内容に共感または質問
- 必要に応じてdev-OSでの経験を軽く触れる
- 50-100文字程度
- 絵文字は控えめに（0-1個）

リプライ:`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.8,
        max_tokens: 150
      })
    });
    
    if (!response.ok) throw new Error('API failed');
    const data = await response.json() as any;
    return data.choices[0].message.content.trim();
  } catch (e) {
    return `なるほど、参考になります！`;
  }
}

// メイン処理
async function main() {
  console.log('\n🔍 インフルエンサーリプライ提案生成\n');
  
  const client = await getXClient();
  const accounts = loadBenchmarkAccounts();
  
  console.log(`📋 対象アカウント: ${accounts.length}件`);
  
  const allTweets: Tweet[] = [];
  
  for (const handle of accounts.slice(0, 5)) { // 最大5アカウント
    console.log(`\n👤 @${handle} の投稿を取得中...`);
    const tweets = await getRecentTweets(client, handle, 3);
    console.log(`   → ${tweets.length}件取得`);
    allTweets.push(...tweets);
    
    // レート制限対策
    await new Promise(r => setTimeout(r, 1000));
  }
  
  // 関連性でソート
  const suggestions: ReplySuggestion[] = [];
  
  for (const tweet of allTweets) {
    const { relevance, reason } = checkRelevance(tweet);
    
    // 低関連性はスキップ
    if (relevance === 'low') continue;
    
    console.log(`\n📝 リプライ案生成中: @${tweet.author}`);
    const suggestedReply = await generateReplyDraft(tweet);
    
    suggestions.push({
      tweet,
      suggested_reply: suggestedReply,
      relevance,
      reason,
      generated_at: new Date().toISOString()
    });
  }
  
  // 関連性順にソート
  suggestions.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.relevance] - order[b.relevance];
  });
  
  // ファイルに保存
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(suggestions, null, 2));
  
  // 結果表示
  console.log('\n' + '='.repeat(60));
  console.log('📋 リプライ提案一覧\n');
  
  for (const s of suggestions.slice(0, 5)) {
    console.log(`[${s.relevance.toUpperCase()}] @${s.tweet.author}`);
    console.log(`投稿: ${s.tweet.text.substring(0, 80)}...`);
    console.log(`提案: ${s.suggested_reply}`);
    console.log(`URL: ${s.tweet.url}`);
    console.log('');
  }
  
  console.log(`\n✅ ${suggestions.length}件の提案を生成しました`);
  console.log(`📁 保存先: ${OUTPUT_FILE}`);
  console.log('\n⚠️ 上記のURLを開いて手動でリプライしてください');
}

main().catch(console.error);
