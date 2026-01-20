/**
 * X（Twitter）タイムライン同期スクリプト
 * 
 * 実際のアカウントから投稿履歴を取得し、post_history.jsonを更新する
 * 
 * 使い方:
 *   npx ts-node scripts/marketing/sync_x_timeline.ts fetch
 *   npx ts-node scripts/marketing/sync_x_timeline.ts sync
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
      console.log(`📁 Loading environment from: ${envFile}`);
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

// 型定義
interface Tweet {
  id: string;
  text: string;
  created_at: string;
  public_metrics?: {
    impression_count: number;
    like_count: number;
    retweet_count: number;
    reply_count: number;
  };
}

interface PostHistory {
  id: string;
  post_id: string;
  variant: 'A' | 'B';
  content: string;
  tweet_id: string;
  posted_at: string;
  slot: string;
  theme: string;
  type?: string;
  metrics?: {
    impressions: number;
    likes: number;
    retweets: number;
    replies: number;
    collected_at: string;
  };
}

// ファイルパス
const HISTORY_FILE = path.join(__dirname, '../../content/post_history.json');
const PLATFORM_HISTORY_FILE = path.join(__dirname, '../../apps/platform/content/post_history.json');

// X API クライアント
async function getXClient() {
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;

  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    throw new Error('X API credentials not found');
  }

  try {
    const { TwitterApi } = await import('twitter-api-v2');
    return new TwitterApi({
      appKey: apiKey,
      appSecret: apiSecret,
      accessToken: accessToken,
      accessSecret: accessSecret,
    });
  } catch (e) {
    throw new Error('twitter-api-v2 not installed');
  }
}

// 時間帯を判定
function detectSlot(date: Date): string {
  const hour = date.getHours();
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'noon';
  return 'night';
}

// 投稿タイプを推定
function detectPostType(text: string): string {
  if (text.includes('？') || text.includes('じゃないですか')) return 'problem_statement';
  if (text.includes('×') && text.includes('○')) return 'before_after';
  if (text.includes('したら') && text.includes('なった')) return 'discovery';
  if (text.includes('Tips') || text.includes('コツ') || text.includes('💡')) return 'tips';
  if (text.includes('開発') && text.includes('進捗')) return 'story';
  if (text.includes('vs') || text.includes('比較')) return 'comparison';
  if (text.includes('🧵') || text.includes('/')) return 'thread';
  return 'unknown';
}

// テーマを推定
function detectTheme(text: string): string {
  if (text.includes('バイブ') || text.includes('vibe')) return 'バイブコーディングの限界';
  if (text.includes('SSOT')) return 'SSOTの価値';
  if (text.includes('Cursor')) return 'Cursor活用';
  if (text.includes('品質')) return 'AI開発の品質';
  if (text.includes('dev-OS')) return 'dev-OS開発';
  return '一般';
}

// 履歴を読み込み
function loadHistory(): PostHistory[] {
  if (!fs.existsSync(HISTORY_FILE)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
}

// 履歴を保存
function saveHistory(history: PostHistory[]): void {
  // 両方のファイルに保存
  const jsonContent = JSON.stringify(history, null, 2);
  fs.writeFileSync(HISTORY_FILE, jsonContent);
  console.log(`✅ Saved: ${HISTORY_FILE}`);
  
  // apps/platform/content/ にも保存
  const platformDir = path.dirname(PLATFORM_HISTORY_FILE);
  if (!fs.existsSync(platformDir)) {
    fs.mkdirSync(platformDir, { recursive: true });
  }
  fs.writeFileSync(PLATFORM_HISTORY_FILE, jsonContent);
  console.log(`✅ Saved: ${PLATFORM_HISTORY_FILE}`);
}

// ユーザーのタイムラインを取得
async function fetchUserTimeline(maxResults: number = 100): Promise<Tweet[]> {
  console.log('\n📥 Fetching user timeline...\n');
  
  const client = await getXClient();
  
  // 自分のユーザーIDを取得
  const me = await client.v2.me();
  console.log(`👤 User: @${me.data.username} (${me.data.id})`);
  
  // タイムラインを取得
  const timeline = await client.v2.userTimeline(me.data.id, {
    max_results: Math.min(maxResults, 100),
    'tweet.fields': ['created_at', 'public_metrics', 'text'],
    exclude: ['retweets', 'replies'],
  });
  
  const tweets: Tweet[] = [];
  
  for await (const tweet of timeline) {
    tweets.push({
      id: tweet.id,
      text: tweet.text,
      created_at: tweet.created_at || new Date().toISOString(),
      public_metrics: tweet.public_metrics,
    });
  }
  
  console.log(`📝 Fetched ${tweets.length} tweets\n`);
  
  return tweets;
}

// タイムラインと履歴を同期
async function syncTimeline(): Promise<void> {
  console.log('\n🔄 Syncing X timeline with post history...\n');
  
  const tweets = await fetchUserTimeline(100);
  const existingHistory = loadHistory();
  const existingIds = new Set(existingHistory.map(h => h.tweet_id));
  
  let added = 0;
  let updated = 0;
  
  for (const tweet of tweets) {
    const postedAt = new Date(tweet.created_at);
    
    if (existingIds.has(tweet.id)) {
      // 既存の投稿: メトリクスを更新
      const existing = existingHistory.find(h => h.tweet_id === tweet.id);
      if (existing && tweet.public_metrics) {
        existing.metrics = {
          impressions: tweet.public_metrics.impression_count,
          likes: tweet.public_metrics.like_count,
          retweets: tweet.public_metrics.retweet_count,
          replies: tweet.public_metrics.reply_count,
          collected_at: new Date().toISOString(),
        };
        updated++;
      }
    } else {
      // 新規投稿: 履歴に追加
      const newPost: PostHistory = {
        id: `hist_${Date.now()}_${tweet.id.slice(-6)}`,
        post_id: `synced_${tweet.id}`,
        variant: Math.random() > 0.5 ? 'A' : 'B',  // 不明なのでランダム
        content: tweet.text,
        tweet_id: tweet.id,
        posted_at: tweet.created_at,
        slot: detectSlot(postedAt),
        theme: detectTheme(tweet.text),
        type: detectPostType(tweet.text),
        metrics: tweet.public_metrics ? {
          impressions: tweet.public_metrics.impression_count,
          likes: tweet.public_metrics.like_count,
          retweets: tweet.public_metrics.retweet_count,
          replies: tweet.public_metrics.reply_count,
          collected_at: new Date().toISOString(),
        } : undefined,
      };
      
      existingHistory.push(newPost);
      added++;
    }
  }
  
  // 日付順にソート（新しい順）
  existingHistory.sort((a, b) => 
    new Date(b.posted_at).getTime() - new Date(a.posted_at).getTime()
  );
  
  saveHistory(existingHistory);
  
  console.log('\n📊 Sync Summary:');
  console.log(`   Added: ${added} new posts`);
  console.log(`   Updated: ${updated} existing posts`);
  console.log(`   Total: ${existingHistory.length} posts in history`);
}

// 取得のみ（履歴への保存なし）
async function fetchOnly(): Promise<void> {
  console.log('\n📥 Fetching timeline (preview only)...\n');
  
  const tweets = await fetchUserTimeline(20);
  
  console.log('='.repeat(60));
  console.log('Recent Tweets:');
  console.log('='.repeat(60));
  
  for (const tweet of tweets.slice(0, 10)) {
    const date = new Date(tweet.created_at);
    const metrics = tweet.public_metrics;
    
    console.log(`\n[${date.toLocaleString('ja-JP')}]`);
    console.log(`ID: ${tweet.id}`);
    console.log(`👁️ ${metrics?.impression_count || 0} | ❤️ ${metrics?.like_count || 0} | 🔁 ${metrics?.retweet_count || 0}`);
    console.log(`${tweet.text.substring(0, 100)}...`);
    console.log('-'.repeat(60));
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'fetch':
      await fetchOnly();
      break;

    case 'sync':
      await syncTimeline();
      break;

    case 'help':
    default:
      console.log(`
Xタイムライン同期スクリプト

使い方:
  npx ts-node scripts/marketing/sync_x_timeline.ts <command>

コマンド:
  fetch    タイムラインを取得してプレビュー（履歴には保存しない）
  sync     タイムラインを取得して履歴に同期

例:
  npx ts-node scripts/marketing/sync_x_timeline.ts fetch
  npx ts-node scripts/marketing/sync_x_timeline.ts sync
      `);
  }
}

main().catch(console.error);
