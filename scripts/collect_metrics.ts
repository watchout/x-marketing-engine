/**
 * メトリクス収集スクリプト
 *
 * 機能:
 *   - 過去24-48時間の投稿のメトリクスを取得
 *   - public_metrics: いいね/RT/インプレッション/リプライ/ブックマーク
 *   - non_public_metrics: プロフィールクリック/URLクリック（OAuth 1.0a時のみ）
 *   - post_history.json を更新
 *
 * メトリクス取得戦略:
 *   - Bearer Token: public_metrics のみ（bookmark_count含む）
 *   - OAuth 1.0a: public_metrics + non_public_metrics（自分の投稿のみ、30日以内）
 *   → XAS (X Algorithm-Aligned Score) の全6指標を取得するにはOAuth 1.0a推奨
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
interface PostMetrics {
  impressions: number;
  likes: number;
  retweets: number;
  replies: number;
  bookmarks?: number;        // public_metrics.bookmark_count（Bearer/OAuth両方で取得可）
  profile_clicks?: number;   // non_public_metrics.user_profile_clicks（OAuth 1.0aのみ）
  url_clicks?: number;       // non_public_metrics.url_link_clicks（OAuth 1.0aのみ）
  collected_at: string;
}

// 認証方式（取得可能メトリクスが異なる）
type AuthMode = 'bearer' | 'oauth1a';

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

// 履歴を読み込み
function loadHistory(): PostHistory[] {
  if (!fs.existsSync(HISTORY_FILE)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
}

// 履歴を保存
function saveHistory(history: PostHistory[]): void {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// X API クライアント
// メトリクス収集では OAuth 1.0a を優先（non_public_metrics が取得可能）
// OAuth 1.0a がなければ Bearer Token にフォールバック（public_metricsのみ）
async function getXClient(): Promise<{ client: any; authMode: AuthMode }> {
  const { TwitterApi } = await import('twitter-api-v2').catch(() => {
    throw new Error('twitter-api-v2 not installed. Run: npm install twitter-api-v2');
  });

  // OAuth 1.0a を優先（non_public_metrics 取得のため）
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;

  if (apiKey && apiSecret && accessToken && accessSecret) {
    console.log('📡 Using OAuth 1.0a (user context) → public_metrics + non_public_metrics');
    const client = new TwitterApi({
      appKey: apiKey,
      appSecret: apiSecret,
      accessToken: accessToken,
      accessSecret: accessSecret,
    });
    return { client, authMode: 'oauth1a' };
  }

  // フォールバック: Bearer Token（public_metricsのみ）
  const bearerToken = process.env.X_BEARER_TOKEN;
  if (bearerToken) {
    console.log('📡 Using Bearer token (app context) → public_metrics only');
    console.log('   ⚠️ non_public_metrics (profile_clicks, url_clicks) は OAuth 1.0a が必要です');
    const client = new TwitterApi(bearerToken);
    return { client, authMode: 'bearer' };
  }

  throw new Error('X API credentials not found. Set OAuth 1.0a keys or X_BEARER_TOKEN');
}

// ツイートのメトリクスをバルク取得（最大100件を1回のAPIで取得）
//
// 取得するメトリクス:
//   public_metrics (Bearer/OAuth両方):
//     impression_count, like_count, retweet_count, reply_count, quote_count, bookmark_count
//   non_public_metrics (OAuth 1.0a + 自分の投稿 + 30日以内):
//     url_link_clicks, user_profile_clicks
async function getTweetMetricsBulk(tweetIds: string[]): Promise<Map<string, PostMetrics>> {
  const results = new Map<string, PostMetrics>();

  if (tweetIds.length === 0) return results;

  try {
    const { client, authMode } = await getXClient();

    // リクエストするフィールドを認証方式で分岐
    const tweetFields: string[] = ['public_metrics', 'created_at'];
    if (authMode === 'oauth1a') {
      // OAuth 1.0a なら non_public_metrics も取得可能（自分の投稿のみ）
      tweetFields.push('non_public_metrics');
      console.log('   📊 Requesting: public_metrics + non_public_metrics');
    } else {
      console.log('   📊 Requesting: public_metrics only (Bearer token)');
    }

    // v2 API でバルク取得（最大100件）
    const tweets = await client.v2.tweets(tweetIds, {
      'tweet.fields': tweetFields,
    });

    if (!tweets.data) {
      console.log('⚠️ No data returned from bulk API');
      return results;
    }

    for (const tweet of tweets.data) {
      if (tweet.public_metrics) {
        const pub = tweet.public_metrics;
        const nonPub = (tweet as any).non_public_metrics;

        const metrics: PostMetrics = {
          impressions: pub.impression_count || 0,
          likes: pub.like_count || 0,
          retweets: pub.retweet_count || 0,
          replies: pub.reply_count || 0,
          bookmarks: pub.bookmark_count || 0,
          collected_at: new Date().toISOString(),
        };

        // non_public_metrics が取れた場合（OAuth 1.0a + 自分の投稿）
        if (nonPub) {
          metrics.profile_clicks = nonPub.user_profile_clicks || 0;
          metrics.url_clicks = nonPub.url_link_clicks || 0;
        }

        results.set(tweet.id, metrics);
      }
    }

    // 取得結果のサマリー
    const hasNonPublic = Array.from(results.values()).some(m => m.profile_clicks !== undefined);
    console.log(`✅ Bulk API: ${results.size}/${tweetIds.length} tweets retrieved`);
    if (hasNonPublic) {
      console.log('   ✅ non_public_metrics (profile_clicks, url_clicks) acquired');
    } else if (authMode === 'oauth1a') {
      console.log('   ⚠️ non_public_metrics not returned (tweets may be >30 days old or not owned)');
    }
    return results;

  } catch (error: any) {
    const code = error.code || error.status || error.statusCode;
    if (code === 429) {
      console.log('⚠️ Rate limited. Try again later.');
      console.log(`   Reset: ${error.rateLimit?.reset ? new Date(error.rateLimit.reset * 1000).toISOString() : 'unknown'}`);
    } else if (code === 403) {
      // non_public_metricsが403の場合、public_metricsだけでリトライ
      console.log('⚠️ 403 Forbidden for non_public_metrics. Retrying with public_metrics only...');
      return await getTweetMetricsPublicOnly(tweetIds);
    } else {
      console.error(`❌ Bulk API error:`, error.message || JSON.stringify(error));
      console.error(`   Code: ${code}, Details:`, error.data || error.errors || 'none');
    }
    return results;
  }
}

// フォールバック: public_metrics のみ取得（non_public_metrics が403の場合）
async function getTweetMetricsPublicOnly(tweetIds: string[]): Promise<Map<string, PostMetrics>> {
  const results = new Map<string, PostMetrics>();

  try {
    const { client } = await getXClient();

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

    console.log(`✅ Fallback (public_metrics only): ${results.size}/${tweetIds.length} tweets retrieved`);
    console.log('   ⚠️ profile_clicks, url_clicks are unavailable in this mode');
    return results;

  } catch (error: any) {
    console.error(`❌ Fallback API error:`, error.message || JSON.stringify(error));
    return results;
  }
}

// メトリクス収集（24時間以上経過した投稿）
// バルクAPIで最大100件を1回のAPI呼び出しで取得（月100回制限対策）
async function collectMetrics(): Promise<void> {
  console.log('\n📊 Collecting metrics (Bulk API)...\n');
  
  const history = loadHistory();
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEK_MS = 7 * DAY_MS;
  
  // 24時間以上経過 & メトリクス未取得 & 直近7日以内の投稿を抽出
  // （月100回制限があるため、古すぎる投稿は優先度を下げる）
  const pending = history.filter(h => {
    const postedAt = new Date(h.posted_at).getTime();
    const age = now - postedAt;
    return age >= DAY_MS && age <= WEEK_MS && !h.metrics;
  });
  
  if (pending.length === 0) {
    console.log('✅ No pending metrics to collect (within 7 days)');
    return;
  }
  
  console.log(`📝 Found ${pending.length} posts needing metrics (within 7 days)\n`);
  
  // バルクAPI用にIDを抽出（最大100件）
  const tweetIds = pending.slice(0, 100).map(p => p.tweet_id);
  console.log(`📡 Fetching ${tweetIds.length} tweets in single API call...`);
  
  const metricsMap = await getTweetMetricsBulk(tweetIds);
  
  let collected = 0;
  
  for (const post of pending) {
    const metrics = metricsMap.get(post.tweet_id);
    if (metrics) {
      post.metrics = metrics;
      collected++;
      const parts = [
        `❤️ ${metrics.likes}`,
        `🔁 ${metrics.retweets}`,
        `🔖 ${metrics.bookmarks || 0}`,
        `👁️ ${metrics.impressions}`,
      ];
      if (metrics.profile_clicks !== undefined) {
        parts.push(`👤 ${metrics.profile_clicks}`);
        parts.push(`🔗 ${metrics.url_clicks || 0}`);
      }
      console.log(`  ✅ ${post.tweet_id}: ${parts.join(' | ')}`);
    }
  }
  
  saveHistory(history);
  
  console.log(`\n✅ Collected metrics for ${collected} posts`);
}

// 週次レポート生成
function generateWeeklyReport(): void {
  console.log('\n📊 Weekly Report\n');
  console.log('================\n');
  
  const history = loadHistory();
  const now = Date.now();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  
  // 過去7日間の投稿
  const weekPosts = history.filter(h => {
    const postedAt = new Date(h.posted_at).getTime();
    return now - postedAt <= WEEK_MS && h.metrics;
  });
  
  if (weekPosts.length === 0) {
    console.log('No posts with metrics in the past week');
    return;
  }
  
  // 全体統計
  const totalImpressions = weekPosts.reduce((sum, h) => sum + (h.metrics?.impressions || 0), 0);
  const totalLikes = weekPosts.reduce((sum, h) => sum + (h.metrics?.likes || 0), 0);
  const totalRetweets = weekPosts.reduce((sum, h) => sum + (h.metrics?.retweets || 0), 0);
  const totalBookmarks = weekPosts.reduce((sum, h) => sum + (h.metrics?.bookmarks || 0), 0);
  const totalProfileClicks = weekPosts.reduce((sum, h) => sum + (h.metrics?.profile_clicks || 0), 0);
  const totalUrlClicks = weekPosts.reduce((sum, h) => sum + (h.metrics?.url_clicks || 0), 0);

  console.log('📈 Overall Stats (Past 7 Days)');
  console.log('------------------------------');
  console.log(`Posts: ${weekPosts.length}`);
  console.log(`Total Impressions: ${totalImpressions.toLocaleString()}`);
  console.log(`Total Likes: ${totalLikes}`);
  console.log(`Total Retweets: ${totalRetweets}`);
  console.log(`Total Bookmarks: ${totalBookmarks}`);
  if (totalProfileClicks > 0) {
    console.log(`Total Profile Clicks: ${totalProfileClicks}`);
    console.log(`Total URL Clicks: ${totalUrlClicks}`);
  }
  console.log(`Avg Engagement Rate: ${totalImpressions > 0 ? ((totalLikes + totalRetweets + totalBookmarks) / totalImpressions * 100).toFixed(2) : '0.00'}%`);
  console.log('');
  
  // スロット別統計
  console.log('📊 By Time Slot');
  console.log('---------------');
  
  for (const slot of ['morning', 'noon', 'night']) {
    const slotPosts = weekPosts.filter(h => h.slot === slot);
    if (slotPosts.length === 0) continue;
    
    const avgLikes = slotPosts.reduce((sum, h) => sum + (h.metrics?.likes || 0), 0) / slotPosts.length;
    const avgImpressions = slotPosts.reduce((sum, h) => sum + (h.metrics?.impressions || 0), 0) / slotPosts.length;
    
    console.log(`${slot.toUpperCase()}: ${slotPosts.length} posts | Avg Likes: ${avgLikes.toFixed(1)} | Avg Impressions: ${avgImpressions.toFixed(0)}`);
  }
  console.log('');
  
  // A/B比較
  console.log('🔬 A/B Test Results');
  console.log('-------------------');
  
  const variantA = weekPosts.filter(h => h.variant === 'A');
  const variantB = weekPosts.filter(h => h.variant === 'B');
  
  if (variantA.length > 0 && variantB.length > 0) {
    const avgLikesA = variantA.reduce((sum, h) => sum + (h.metrics?.likes || 0), 0) / variantA.length;
    const avgLikesB = variantB.reduce((sum, h) => sum + (h.metrics?.likes || 0), 0) / variantB.length;
    
    console.log(`Variant A: ${variantA.length} posts | Avg Likes: ${avgLikesA.toFixed(1)}`);
    console.log(`Variant B: ${variantB.length} posts | Avg Likes: ${avgLikesB.toFixed(1)}`);
    
    const winner = avgLikesA > avgLikesB ? 'A' : 'B';
    const diff = Math.abs(avgLikesA - avgLikesB);
    console.log(`\n🏆 Current Winner: Variant ${winner} (+${diff.toFixed(1)} avg likes)`);
  }
  console.log('');
  
  // トップ投稿
  console.log('🌟 Top Posts');
  console.log('------------');
  
  const sorted = [...weekPosts].sort((a, b) => 
    (b.metrics?.likes || 0) - (a.metrics?.likes || 0)
  );
  
  for (const post of sorted.slice(0, 3)) {
    console.log(`❤️ ${post.metrics?.likes} | ${post.theme} (${post.variant})`);
    console.log(`   ${post.content.substring(0, 50)}...`);
    console.log('');
  }
  
  // レポートをファイルに保存
  const reportDir = path.join(METRICS_DIR);
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  
  const reportDate = new Date().toISOString().split('T')[0];
  const reportPath = path.join(reportDir, `weekly_${reportDate}.json`);
  
  const reportData = {
    generated_at: new Date().toISOString(),
    period: '7 days',
    stats: {
      total_posts: weekPosts.length,
      total_impressions: totalImpressions,
      total_likes: totalLikes,
      total_retweets: totalRetweets,
      total_bookmarks: totalBookmarks,
      total_profile_clicks: totalProfileClicks,
      total_url_clicks: totalUrlClicks,
    },
    by_slot: {
      morning: weekPosts.filter(h => h.slot === 'morning').length,
      noon: weekPosts.filter(h => h.slot === 'noon').length,
      night: weekPosts.filter(h => h.slot === 'night').length,
    },
    ab_test: {
      variant_a_posts: variantA.length,
      variant_b_posts: variantB.length,
      variant_a_avg_likes: variantA.length > 0 
        ? variantA.reduce((sum, h) => sum + (h.metrics?.likes || 0), 0) / variantA.length 
        : 0,
      variant_b_avg_likes: variantB.length > 0 
        ? variantB.reduce((sum, h) => sum + (h.metrics?.likes || 0), 0) / variantB.length 
        : 0,
    },
    top_posts: sorted.slice(0, 5).map(p => ({
      theme: p.theme,
      variant: p.variant,
      likes: p.metrics?.likes,
      retweets: p.metrics?.retweets,
      bookmarks: p.metrics?.bookmarks,
      impressions: p.metrics?.impressions,
      profile_clicks: p.metrics?.profile_clicks,
      url_clicks: p.metrics?.url_clicks,
    })),
  };
  
  fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));
  console.log(`📁 Report saved: ${reportPath}`);
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'collect':
      await collectMetrics();
      break;

    case 'report':
      generateWeeklyReport();
      break;

    case 'help':
    default:
      console.log(`
メトリクス収集スクリプト

使い方:
  npx ts-node scripts/marketing/collect_metrics.ts <command>

コマンド:
  collect    メトリクス収集（24時間以上経過した投稿）
  report     週次レポート生成

例:
  npx ts-node scripts/marketing/collect_metrics.ts collect
  npx ts-node scripts/marketing/collect_metrics.ts report
      `);
  }
}

main().catch(console.error);
