/**
 * X（Twitter）投稿スクリプト
 * 
 * 使い方:
 *   npx ts-node scripts/marketing/post_to_x.ts post "投稿内容"
 *   npx ts-node scripts/marketing/post_to_x.ts schedule "投稿内容" "2026-01-10T12:00:00"
 *   npx ts-node scripts/marketing/post_to_x.ts from-calendar
 * 
 * 環境変数ファイル（優先順位）:
 *   1. .env.api
 *   2. .env.local
 *   3. .env
 * 
 * 必要な環境変数:
 *   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
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
          // クォートを除去
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
      return; // 最初に見つかったファイルのみ読み込み
    }
  }
  console.log('⚠️ No .env file found. Using system environment variables.');
}

// 起動時に環境変数を読み込み
loadEnvFile();

// 型定義
interface ScheduledPost {
  id: string;
  content: string;
  scheduledAt: string;  // ISO 8601
  status: 'pending' | 'posted' | 'failed';
  postedAt?: string;
  error?: string;
}

interface ContentCalendarEntry {
  date: string;
  type: string;
  content: string;
  hashtags: string[];
}

// 設定
const SCHEDULE_FILE = path.join(__dirname, '../content/x_schedule.json');
const POSTED_LOG_FILE = path.join(__dirname, '../content/x_posted_log.json');

// X API クライアント（twitter-api-v2 を使用）
async function getXClient() {
  // 環境変数チェック
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;

  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    throw new Error(
      'X API credentials not found. Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET'
    );
  }

  // 動的インポート（インストールされている場合のみ）
  try {
    const { TwitterApi } = await import('twitter-api-v2');
    return new TwitterApi({
      appKey: apiKey,
      appSecret: apiSecret,
      accessToken: accessToken,
      accessSecret: accessSecret,
    });
  } catch (e) {
    throw new Error(
      'twitter-api-v2 not installed. Run: npm install twitter-api-v2'
    );
  }
}

// 投稿を実行
async function postTweet(content: string): Promise<{ id: string; text: string }> {
  const client = await getXClient();
  const result = await client.v2.tweet({ text: content });
  
  console.log(`✅ Posted: ${result.data.id}`);
  console.log(`   Content: ${content.substring(0, 50)}...`);
  
  return {
    id: result.data.id,
    text: result.data.text,
  };
}

// スケジュールを保存
function saveSchedule(posts: ScheduledPost[]): void {
  const dir = path.dirname(SCHEDULE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(posts, null, 2));
}

// スケジュールを読み込み
function loadSchedule(): ScheduledPost[] {
  if (!fs.existsSync(SCHEDULE_FILE)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf-8'));
}

// 投稿ログを保存
function logPosted(post: ScheduledPost): void {
  const dir = path.dirname(POSTED_LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  let log: ScheduledPost[] = [];
  if (fs.existsSync(POSTED_LOG_FILE)) {
    log = JSON.parse(fs.readFileSync(POSTED_LOG_FILE, 'utf-8'));
  }
  log.push(post);
  fs.writeFileSync(POSTED_LOG_FILE, JSON.stringify(log, null, 2));
}

// 予約投稿を追加
function schedulePost(content: string, scheduledAt: string): void {
  const posts = loadSchedule();
  const newPost: ScheduledPost = {
    id: `post_${Date.now()}`,
    content,
    scheduledAt,
    status: 'pending',
  };
  posts.push(newPost);
  saveSchedule(posts);
  
  console.log(`📅 Scheduled: ${scheduledAt}`);
  console.log(`   Content: ${content.substring(0, 50)}...`);
}

// 予約投稿を実行（cron等で定期実行）
async function processScheduledPosts(): Promise<void> {
  const posts = loadSchedule();
  const now = new Date();
  
  let updated = false;
  
  for (const post of posts) {
    if (post.status !== 'pending') continue;
    
    const scheduledTime = new Date(post.scheduledAt);
    if (scheduledTime > now) continue;
    
    console.log(`⏰ Processing scheduled post: ${post.id}`);
    
    try {
      await postTweet(post.content);
      post.status = 'posted';
      post.postedAt = new Date().toISOString();
      logPosted(post);
      updated = true;
    } catch (e) {
      post.status = 'failed';
      post.error = e instanceof Error ? e.message : String(e);
      console.error(`❌ Failed: ${post.error}`);
      updated = true;
    }
  }
  
  if (updated) {
    // 投稿済み・失敗を除外して保存
    const remaining = posts.filter(p => p.status === 'pending');
    saveSchedule(remaining);
  }
  
  console.log(`✅ Processed. Remaining: ${posts.filter(p => p.status === 'pending').length}`);
}

// コンテンツカレンダーから読み込み
function loadContentCalendar(): ContentCalendarEntry[] {
  const calendarPath = path.join(__dirname, '../content/x_calendar.json');
  
  if (!fs.existsSync(calendarPath)) {
    console.log('📝 Creating sample calendar...');
    const sample: ContentCalendarEntry[] = [
      {
        date: "2026-01-06T12:00:00+09:00",
        type: "build_in_public",
        content: "dev-OS 開発開始します 🚀\n\n「AIで作ったコード、結局自分で直してませんか？」\n\nこの問題を解決するために、開発OSを作っています。\n\n開発過程を Build in Public で共有していきます。\n\n#dev-OS #AI開発 #BuildInPublic",
        hashtags: ["dev-OS", "AI開発", "BuildInPublic"]
      },
      {
        date: "2026-01-07T19:00:00+09:00",
        type: "tips",
        content: "Cursor Tips 💡\n\nプロンプトに「このAPIはマルチテナントです」と書くだけで、\n生成されるコードに organization_id の WHERE 句が自動で入るようになる。\n\n一言添えるだけで、品質が変わる。\n\n#Cursor #Tips",
        hashtags: ["Cursor", "Tips"]
      }
    ];
    
    const dir = path.dirname(calendarPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(calendarPath, JSON.stringify(sample, null, 2));
    return sample;
  }
  
  return JSON.parse(fs.readFileSync(calendarPath, 'utf-8'));
}

// カレンダーからスケジュールに追加
function importFromCalendar(): void {
  const calendar = loadContentCalendar();
  const existingPosts = loadSchedule();
  const existingDates = new Set(existingPosts.map(p => p.scheduledAt));
  
  let added = 0;
  for (const entry of calendar) {
    if (existingDates.has(entry.date)) continue;
    
    schedulePost(entry.content, entry.date);
    added++;
  }
  
  console.log(`📅 Imported ${added} posts from calendar`);
}

// 予約一覧を表示
function listScheduled(): void {
  const posts = loadSchedule();
  
  if (posts.length === 0) {
    console.log('📭 No scheduled posts');
    return;
  }
  
  console.log('\n📅 Scheduled Posts:\n');
  for (const post of posts.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))) {
    const date = new Date(post.scheduledAt);
    console.log(`[${date.toLocaleString('ja-JP')}]`);
    console.log(`  ${post.content.substring(0, 60)}...`);
    console.log('');
  }
}

// メイン
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'post':
      // 即時投稿
      if (!args[1]) {
        console.error('Usage: post "content"');
        process.exit(1);
      }
      await postTweet(args[1]);
      break;

    case 'schedule':
      // 予約投稿
      if (!args[1] || !args[2]) {
        console.error('Usage: schedule "content" "2026-01-10T12:00:00"');
        process.exit(1);
      }
      schedulePost(args[1], args[2]);
      break;

    case 'process':
      // 予約実行（cron用）
      await processScheduledPosts();
      break;

    case 'from-calendar':
      // カレンダーからインポート
      importFromCalendar();
      break;

    case 'list':
      // 予約一覧
      listScheduled();
      break;

    case 'help':
    default:
      console.log(`
X投稿スクリプト

使い方:
  npx ts-node scripts/marketing/post_to_x.ts <command>

コマンド:
  post "内容"                    即時投稿
  schedule "内容" "日時"         予約投稿
  process                        予約実行（cron用）
  from-calendar                  カレンダーからインポート
  list                           予約一覧

環境変数:
  X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET

例:
  npx ts-node scripts/marketing/post_to_x.ts post "Hello World!"
  npx ts-node scripts/marketing/post_to_x.ts schedule "予約投稿" "2026-01-10T12:00:00"
      `);
  }
}

main().catch(console.error);

