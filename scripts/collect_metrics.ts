/**
 * メトリクス収集スクリプト
 *
 * 機能:
 *   - ユーザータイムラインAPIで自分の投稿のメトリクスを取得
 *   - public_metrics: いいね/RT/インプレッション/リプライ/ブックマーク
 *   - post_history.json を更新
 *
 * X API Free tier対応:
 *   - GET /2/tweets (ID lookup) は Free tier で使用不可（429エラー）
 *   - GET /2/users/:id/tweets (timeline) は Free tier で 1 req/15min
 *   - GET /2/users/me は Free tier で 25 req/24h
 *   → timeline APIで最大100件の自分のツイート+メトリクスを1回で取得
 *
 * 使い方:
 *   npx ts-node scripts/collect_metrics.ts collect
 *   npx ts-node scripts/collect_metrics.ts report
 */

import * as fs from 'fs';
import * as path from 'path';

// 環境変数読み込み
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

// 型定義
interface PostMetrics {
  impressions: number;
  likes: number;
  retweets: number;
  replies: number;
  bookmarks?: number;
  profile_clicks?: number;
  url_clicks?: number;
  collected_at: string;
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
  metrics?: PostMetrics;
}

// ファイルパス
const HISTORY_FILE = path.join(__dirname, '../content/post_history.json');
const METRICS_DIR = path.join(__dirname, '../content/metrics');

function loadHistory(): PostHistory[] {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
}

function saveHistory(history: PostHistory[]): void {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// X API クライアント取得
async function getXClient(): Promise<any> {
  const { TwitterApi } = await import('twitter-api-v2').catch(() => {
    throw new Error('twitter-api-v2 not installed. Run: npm install twitter-api-v2');
  });

  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;

  if (apiKey && apiSecret && accessToken && accessSecret) {
    console.log('📡 Using OAuth 1.0a (user context)');
    return new TwitterApi({
      appKey: apiKey,
      appSecret: apiSecret,
      accessToken: accessToken,
      accessSecret: accessSecret,
    });
  }

  const bearerToken = process.env.X_BEARER_TOKEN;
  if (bearerToken) {
    console.log('📡 Using Bearer token');
    return new TwitterApi(bearerToken);
  }

  throw new Error('X API credentials not found');
}

// ===== メトリクス取得: User Timeline API (Free tier対応) =====
//
// GET /2/users/:id/tweets は Free tier で 1 req/15min 使える
// GET /2/tweets (lookup) は Free tier で使用不可（毎回429エラー）
//
// 手順:
//   1. GET /2/users/me でユーザーIDを取得
//   2. GET /2/users/:id/tweets で直近100件のツイートを取得（public_metrics含む）
//   3. post_historyのtweet_idとマッチしてメトリクスを抽出

async function getMetricsViaTimeline(pendingTweetIds: Set<string>): Promise<Map<string, PostMetrics>> {
  const results = new Map<string, PostMetrics>();

  const client = await getXClient();

  // 1. ユーザーID取得
  console.log('   📡 Getting user ID via /2/users/me...');
  let userId: string;
  try {
    const me = await client.v2.me();
    userId = me.data.id;
    console.log(`   ✅ User: @${me.data.username} (ID: ${userId})`);
  } catch (error: any) {
    console.error(`   ❌ /2/users/me failed:`, error.message);
    throw error;
  }

  // 2. ユーザータイムラインからツイート+メトリクスを取得
  console.log('   📡 Fetching timeline with public_metrics (max 100 tweets)...');
  try {
    const timeline = await client.v2.userTimeline(userId, {
      max_results: 100,
      'tweet.fields': 'public_metrics,created_at',
    });

    // twitter-api-v2 の paginator から tweets を取得
    const tweets = timeline.tweets || [];

    if (tweets.length === 0) {
      console.log('   ⚠️ No tweets returned from timeline');
      return results;
    }

    console.log(`   📊 Timeline returned ${tweets.length} tweets`);

    // 3. pendingTweetIdsとマッチしてメトリクスを抽出
    for (const tweet of tweets) {
      if (pendingTweetIds.has(tweet.id) && tweet.public_metrics) {
        const pub = tweet.public_metrics;
        results.set(tweet.id, {
          impressions: pub.impression_count || 0,
          likes: pub.like_count || 0,
          retweets: pub.retweet_count || 0,
          replies: pub.reply_count || 0,
          bookmarks: pub.bookmark_count || 0,
          collected_at: new Date().toISOString(),
        });
      }
    }

    console.log(`   ✅ Matched ${results.size} tweets with pending metrics`);

  } catch (error: any) {
    const code = error.code || error.status || error.statusCode;
    const errorData = error.data || error;
    const isUsageCap = errorData?.title === 'UsageCapExceeded' ||
                       (typeof errorData === 'string' && errorData.includes('UsageCapExceeded'));
    if (isUsageCap || (code === 429 && JSON.stringify(errorData).includes('UsageCapExceeded'))) {
      console.log('   ⚠️ X API月間使用量上限に到達しています');
      console.log('   💡 月初にリセットされます。それまでメトリクス収集はスキップされます。');
    } else if (code === 429) {
      console.log(`   ⚠️ Timeline API rate limited. Reset: ${error.rateLimit?.reset ? new Date(error.rateLimit.reset * 1000).toISOString() : 'unknown'}`);
      console.log('   💡 Free tier: 1 req/15min. Will retry on next run.');
    } else {
      console.error(`   ❌ Timeline API error (${code}):`, error.message);
    }
  }

  return results;
}

// ===== フォールバック: Tweet ID Lookup (Basic tier以上) =====
async function getMetricsViaLookup(tweetIds: string[]): Promise<Map<string, PostMetrics>> {
  const results = new Map<string, PostMetrics>();
  if (tweetIds.length === 0) return results;

  try {
    const client = await getXClient();
    const tweets = await client.v2.tweets(tweetIds, {
      'tweet.fields': ['public_metrics', 'created_at'],
    });

    if (!tweets.data) return results;

    for (const tweet of tweets.data) {
      if (tweet.public_metrics) {
        const pub = tweet.public_metrics;
        results.set(tweet.id, {
          impressions: pub.impression_count || 0,
          likes: pub.like_count || 0,
          retweets: pub.retweet_count || 0,
          replies: pub.reply_count || 0,
          bookmarks: pub.bookmark_count || 0,
          collected_at: new Date().toISOString(),
        });
      }
    }
    console.log(`   ✅ Lookup: ${results.size}/${tweetIds.length} tweets`);
  } catch (error: any) {
    const code = error.code || error.status || error.statusCode;
    if (code === 429) {
      console.log('   ⚠️ Lookup API rate limited (Free tier does not support this endpoint)');
    } else {
      console.error(`   ❌ Lookup API error (${code}):`, error.message);
    }
  }

  return results;
}

// ===== メトリクス収集メイン =====
async function collectMetrics(): Promise<void> {
  console.log('\n📊 Collecting metrics...\n');

  const history = loadHistory();
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MONTH_MS = 30 * DAY_MS;

  // メトリクス未取得 & 24時間以上経過 & 30日以内の投稿を抽出
  // （30日以内に拡大：Free tierだとレート制限で取りこぼすため）
  const pending = history.filter(h => {
    if (!h.tweet_id) return false;
    const postedAt = new Date(h.posted_at).getTime();
    const age = now - postedAt;
    return age >= DAY_MS && age <= MONTH_MS && !h.metrics;
  });

  if (pending.length === 0) {
    console.log('✅ No pending metrics to collect');
    return;
  }

  console.log(`📝 Found ${pending.length} posts needing metrics\n`);

  const pendingIds = new Set(pending.map(p => p.tweet_id));

  // Strategy 1: User Timeline API (Free tier対応)
  console.log('🔄 Strategy 1: User Timeline API (Free tier)...');
  let metricsMap = await getMetricsViaTimeline(pendingIds);

  // Strategy 2: Timeline で取れなかった場合、Lookup にフォールバック
  if (metricsMap.size === 0) {
    console.log('\n🔄 Strategy 2: Tweet Lookup API (Basic tier+)...');
    const tweetIds = pending.slice(0, 100).map(p => p.tweet_id);
    metricsMap = await getMetricsViaLookup(tweetIds);
  }

  // 結果をpost_historyに反映
  let collected = 0;
  for (const post of pending) {
    const metrics = metricsMap.get(post.tweet_id);
    if (metrics) {
      post.metrics = metrics;
      collected++;
      console.log(`  ✅ ${post.tweet_id}: ❤️${metrics.likes} 🔁${metrics.retweets} 🔖${metrics.bookmarks || 0} 👁️${metrics.impressions}`);
    }
  }

  if (collected > 0) {
    saveHistory(history);
    console.log(`\n✅ Collected metrics for ${collected}/${pending.length} posts`);
  } else {
    console.log('\n⚠️ Could not collect any metrics');
    console.log('   Possible causes:');
    console.log('   - X API Free tier rate limit (1 req/15min for timeline)');
    console.log('   - API credentials issue');
    console.log('   - Tweets may have been deleted');
    console.log('   Will retry on next run.');
  }
}

// ===== 週次レポート =====
function generateWeeklyReport(): void {
  console.log('\n📊 Weekly Report\n');
  console.log('================\n');

  const history = loadHistory();
  const now = Date.now();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  const weekPosts = history.filter(h => {
    const postedAt = new Date(h.posted_at).getTime();
    return now - postedAt <= WEEK_MS && h.metrics;
  });

  if (weekPosts.length === 0) {
    console.log('No posts with metrics in the past week');
    return;
  }

  const totalImpressions = weekPosts.reduce((sum, h) => sum + (h.metrics?.impressions || 0), 0);
  const totalLikes = weekPosts.reduce((sum, h) => sum + (h.metrics?.likes || 0), 0);
  const totalRetweets = weekPosts.reduce((sum, h) => sum + (h.metrics?.retweets || 0), 0);
  const totalBookmarks = weekPosts.reduce((sum, h) => sum + (h.metrics?.bookmarks || 0), 0);

  console.log('📈 Overall Stats (Past 7 Days)');
  console.log('------------------------------');
  console.log(`Posts: ${weekPosts.length}`);
  console.log(`Total Impressions: ${totalImpressions.toLocaleString()}`);
  console.log(`Total Likes: ${totalLikes}`);
  console.log(`Total Retweets: ${totalRetweets}`);
  console.log(`Total Bookmarks: ${totalBookmarks}`);
  console.log(`Avg Engagement Rate: ${totalImpressions > 0 ? ((totalLikes + totalRetweets + totalBookmarks) / totalImpressions * 100).toFixed(2) : '0.00'}%`);
  console.log('');

  // スロット別
  for (const slot of ['morning', 'noon', 'night']) {
    const slotPosts = weekPosts.filter(h => h.slot === slot);
    if (slotPosts.length === 0) continue;
    const avgLikes = slotPosts.reduce((sum, h) => sum + (h.metrics?.likes || 0), 0) / slotPosts.length;
    const avgImpressions = slotPosts.reduce((sum, h) => sum + (h.metrics?.impressions || 0), 0) / slotPosts.length;
    console.log(`${slot.toUpperCase()}: ${slotPosts.length} posts | Avg Likes: ${avgLikes.toFixed(1)} | Avg Impressions: ${avgImpressions.toFixed(0)}`);
  }
  console.log('');

  // A/B比較
  const variantA = weekPosts.filter(h => h.variant === 'A');
  const variantB = weekPosts.filter(h => h.variant === 'B');
  if (variantA.length > 0 && variantB.length > 0) {
    const avgA = variantA.reduce((sum, h) => sum + (h.metrics?.likes || 0), 0) / variantA.length;
    const avgB = variantB.reduce((sum, h) => sum + (h.metrics?.likes || 0), 0) / variantB.length;
    console.log(`Variant A: ${variantA.length} posts | Avg Likes: ${avgA.toFixed(1)}`);
    console.log(`Variant B: ${variantB.length} posts | Avg Likes: ${avgB.toFixed(1)}`);
  }

  // レポート保存
  if (!fs.existsSync(METRICS_DIR)) {
    fs.mkdirSync(METRICS_DIR, { recursive: true });
  }
  const reportDate = new Date().toISOString().split('T')[0];
  const reportPath = path.join(METRICS_DIR, `weekly_${reportDate}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    period: '7 days',
    stats: { total_posts: weekPosts.length, total_impressions: totalImpressions, total_likes: totalLikes, total_retweets: totalRetweets, total_bookmarks: totalBookmarks },
    by_slot: { morning: weekPosts.filter(h => h.slot === 'morning').length, noon: weekPosts.filter(h => h.slot === 'noon').length, night: weekPosts.filter(h => h.slot === 'night').length },
  }, null, 2));
  console.log(`📁 Report saved: ${reportPath}`);
}

// CLI
async function main() {
  const command = process.argv[2] || 'collect';

  switch (command) {
    case 'collect':
      await collectMetrics();
      break;
    case 'report':
      generateWeeklyReport();
      break;
    default:
      console.log('Usage: npx ts-node scripts/collect_metrics.ts <collect|report>');
  }
}

main().catch(console.error);
