/**
 * インフルエンサー監視スクリプト
 * 
 * AI開発系インフルエンサーの投稿を監視し、
 * バズ投稿のパターンを分析してwinning_patterns.ymlに追記する
 * 
 * 使い方:
 *   npx ts-node scripts/marketing/watch_influencers.ts watch
 *   npx ts-node scripts/marketing/watch_influencers.ts analyze
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

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
      return;
    }
  }
}

loadEnvFile();

// ===== 型定義 =====

interface Influencer {
  handle: string;
  user_id?: string;
  category: string;
  min_likes_threshold: number;
}

interface Tweet {
  id: string;
  text: string;
  author_id: string;
  author_handle: string;
  created_at: string;
  public_metrics: {
    impression_count: number;
    like_count: number;
    retweet_count: number;
    reply_count: number;
  };
}

interface PatternAnalysis {
  hook_type: string;
  structure: string;
  visual: string;
  key_elements: string[];
  why_it_works: string;
}

interface WinningPattern {
  id: string;
  source: string;
  original_tweet_id: string;
  original_text: string;
  metrics: {
    impressions: number;
    likes: number;
    retweets: number;
  };
  analysis: PatternAnalysis;
  extracted_at: string;
}

// ===== 監視対象アカウント =====

const INFLUENCERS: Influencer[] = [
  { handle: 'ai_jitan', category: 'ツール活用', min_likes_threshold: 500 },
  { handle: 'masahirochaen', category: 'AIニュース', min_likes_threshold: 300 },
  { handle: 'Fujin_Metaverse', category: 'AIエージェント', min_likes_threshold: 200 },
  { handle: 'commte', category: 'Claude Code', min_likes_threshold: 100 },
  { handle: 'akira_papa_IT', category: 'エンジニア実践', min_likes_threshold: 100 },
  { handle: 'shota7180', category: 'AI活用', min_likes_threshold: 300 },
];

// ===== ファイルパス =====

const PROJECT_ROOT = path.join(__dirname, '..');
const WINNING_PATTERNS_FILE = path.join(PROJECT_ROOT, 'apps/platform/ssot/winning_patterns.yml');
const INFLUENCER_CACHE_FILE = path.join(PROJECT_ROOT, 'content/cache/influencer_tweets.json');

// ===== X API =====

async function getXClient() {
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;

  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    throw new Error('X API credentials not found');
  }

  const { TwitterApi } = await import('twitter-api-v2');
  return new TwitterApi({
    appKey: apiKey,
    appSecret: apiSecret,
    accessToken: accessToken,
    accessSecret: accessSecret,
  });
}

// ユーザーIDを取得
async function getUserId(client: any, handle: string): Promise<string | null> {
  try {
    const user = await client.v2.userByUsername(handle);
    return user.data?.id || null;
  } catch (e) {
    console.error(`  ⚠️ Failed to get user ID for @${handle}:`, e);
    return null;
  }
}

// ユーザーのタイムラインを取得
async function getUserTweets(client: any, userId: string, maxResults: number = 10): Promise<Tweet[]> {
  try {
    const timeline = await client.v2.userTimeline(userId, {
      max_results: maxResults,
      'tweet.fields': ['created_at', 'public_metrics', 'author_id'],
      exclude: ['retweets', 'replies'],
    });
    
    const tweets: Tweet[] = [];
    for await (const tweet of timeline) {
      tweets.push({
        id: tweet.id,
        text: tweet.text,
        author_id: tweet.author_id,
        author_handle: '',
        created_at: tweet.created_at || new Date().toISOString(),
        public_metrics: tweet.public_metrics || {
          impression_count: 0,
          like_count: 0,
          retweet_count: 0,
          reply_count: 0
        }
      });
    }
    
    return tweets;
  } catch (e) {
    console.error(`  ⚠️ Failed to get tweets for user ${userId}:`, e);
    return [];
  }
}

// ===== Grok分析 =====

async function analyzeWithGrok(tweet: Tweet): Promise<PatternAnalysis> {
  const apiKey = process.env.GROK_API_KEY;
  
  const prompt = `
あなたはXでバズる投稿を分析する専門家です。

以下の投稿がなぜバズったのか分析してください。

【投稿】
${tweet.text}

【メトリクス】
いいね: ${tweet.public_metrics.like_count}
RT: ${tweet.public_metrics.retweet_count}
インプレッション: ${tweet.public_metrics.impression_count}

【分析項目】
1. hook_type: 冒頭のフックの種類（「正直、」「断言します」「嘘みたいだけど」等）
2. structure: 投稿の構造（問題提起→解決策、ステップ形式、比較等）
3. visual: ビジュアル要素（動画、スクショ、なし等）
4. key_elements: バズった要因（再現可能、数字で証明、感情的等）の配列
5. why_it_works: なぜこの投稿が刺さるのか（1-2文）

【出力形式（JSON）】
{
  "hook_type": "正直、",
  "structure": "問題提起→解決策→手順",
  "visual": "操作動画",
  "key_elements": ["再現可能", "コピペだけ", "数字で証明"],
  "why_it_works": "ターゲットのペインを明確に突いており、具体的な解決策を提示している"
}
`;

  try {
    let response: string;
    
    if (apiKey) {
      const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'grok-2-latest',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.5
        })
      });
      
      if (res.ok) {
        const data = await res.json();
        response = data.choices[0].message.content;
      } else {
        throw new Error('Grok API failed');
      }
    } else {
      // Fallback to GPT
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) throw new Error('No API keys available');
      
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.5
        })
      });
      
      if (!res.ok) throw new Error('GPT API failed');
      const data = await res.json();
      response = data.choices[0].message.content;
    }
    
    // JSONパース
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error('  ⚠️ Analysis failed:', e);
  }
  
  // デフォルト値
  return {
    hook_type: '不明',
    structure: '不明',
    visual: 'なし',
    key_elements: [],
    why_it_works: '分析失敗'
  };
}

// ===== 勝ちパターン保存 =====

function loadWinningPatterns(): WinningPattern[] {
  if (!fs.existsSync(WINNING_PATTERNS_FILE)) {
    return [];
  }
  
  try {
    const content = fs.readFileSync(WINNING_PATTERNS_FILE, 'utf-8');
    const data = yaml.load(content) as any;
    return data?.patterns || [];
  } catch (e) {
    return [];
  }
}

function saveWinningPatterns(patterns: WinningPattern[]): void {
  const dir = path.dirname(WINNING_PATTERNS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const data = {
    version: '2.0',
    last_updated: new Date().toISOString(),
    description: 'インフルエンサーのバズ投稿から抽出した勝ちパターン',
    patterns: patterns
  };
  
  fs.writeFileSync(WINNING_PATTERNS_FILE, yaml.dump(data, { lineWidth: -1 }));
}

// ===== キャッシュ管理 =====

interface TweetCache {
  last_checked: Record<string, string>;
  processed_tweets: string[];
}

function loadCache(): TweetCache {
  if (!fs.existsSync(INFLUENCER_CACHE_FILE)) {
    return { last_checked: {}, processed_tweets: [] };
  }
  
  try {
    return JSON.parse(fs.readFileSync(INFLUENCER_CACHE_FILE, 'utf-8'));
  } catch (e) {
    return { last_checked: {}, processed_tweets: [] };
  }
}

function saveCache(cache: TweetCache): void {
  const dir = path.dirname(INFLUENCER_CACHE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  // 処理済みツイートは最大500件まで保持
  cache.processed_tweets = cache.processed_tweets.slice(-500);
  fs.writeFileSync(INFLUENCER_CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ===== メイン処理 =====

async function watchInfluencers(): Promise<void> {
  console.log('\n📡 インフルエンサー監視開始\n');
  console.log('='.repeat(50));
  
  const client = await getXClient();
  const cache = loadCache();
  const existingPatterns = loadWinningPatterns();
  const newPatterns: WinningPattern[] = [];
  
  for (const influencer of INFLUENCERS) {
    console.log(`\n👤 @${influencer.handle} (${influencer.category})`);
    
    // ユーザーID取得
    let userId = influencer.user_id;
    if (!userId) {
      userId = await getUserId(client, influencer.handle);
      if (!userId) {
        console.log('  ⚠️ ユーザーIDを取得できませんでした');
        continue;
      }
    }
    
    // ツイート取得
    const tweets = await getUserTweets(client, userId, 20);
    console.log(`  📝 ${tweets.length}件のツイートを取得`);
    
    // バズツイートをフィルタ
    const buzzTweets = tweets.filter(t => 
      t.public_metrics.like_count >= influencer.min_likes_threshold &&
      !cache.processed_tweets.includes(t.id)
    );
    
    console.log(`  🔥 ${buzzTweets.length}件のバズツイートを検出（いいね${influencer.min_likes_threshold}+）`);
    
    // 各バズツイートを分析
    for (const tweet of buzzTweets.slice(0, 3)) {
      console.log(`\n  分析中: ${tweet.text.substring(0, 50)}...`);
      console.log(`    ❤️ ${tweet.public_metrics.like_count} | 🔁 ${tweet.public_metrics.retweet_count}`);
      
      const analysis = await analyzeWithGrok(tweet);
      
      const pattern: WinningPattern = {
        id: `pattern_${Date.now()}_${tweet.id.slice(-6)}`,
        source: `@${influencer.handle}`,
        original_tweet_id: tweet.id,
        original_text: tweet.text.substring(0, 200),
        metrics: {
          impressions: tweet.public_metrics.impression_count,
          likes: tweet.public_metrics.like_count,
          retweets: tweet.public_metrics.retweet_count
        },
        analysis: analysis,
        extracted_at: new Date().toISOString()
      };
      
      newPatterns.push(pattern);
      cache.processed_tweets.push(tweet.id);
      
      console.log(`    ✅ パターン抽出: ${analysis.hook_type} / ${analysis.structure}`);
      
      // レート制限対策
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    cache.last_checked[influencer.handle] = new Date().toISOString();
  }
  
  // 保存
  if (newPatterns.length > 0) {
    const allPatterns = [...newPatterns, ...existingPatterns].slice(0, 100);
    saveWinningPatterns(allPatterns);
    console.log(`\n✅ ${newPatterns.length}件の新パターンを追加`);
  } else {
    console.log('\n📭 新しいバズツイートはありませんでした');
  }
  
  saveCache(cache);
  
  console.log('\n='.repeat(50));
  console.log('🎉 監視完了！');
}

// 既存パターンの表示
function showPatterns(): void {
  const patterns = loadWinningPatterns();
  
  if (patterns.length === 0) {
    console.log('📭 パターンがありません');
    return;
  }
  
  console.log(`\n📊 勝ちパターン (${patterns.length}件)\n`);
  
  for (const p of patterns.slice(0, 10)) {
    console.log(`[${p.source}] ${p.analysis.hook_type}`);
    console.log(`  構造: ${p.analysis.structure}`);
    console.log(`  要素: ${p.analysis.key_elements?.join(', ') || 'なし'}`);
    console.log(`  ❤️ ${p.metrics.likes} | Tweet: ${p.original_text.substring(0, 50)}...`);
    console.log('');
  }
}

// ===== CLI =====

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'watch':
      await watchInfluencers();
      break;
      
    case 'show':
    case 'patterns':
      showPatterns();
      break;
      
    case 'help':
    default:
      console.log(`
インフルエンサー監視スクリプト

使い方:
  npx ts-node scripts/marketing/watch_influencers.ts <command>

コマンド:
  watch     インフルエンサーの投稿を監視し、バズパターンを抽出
  show      保存されている勝ちパターンを表示

例:
  npx ts-node scripts/marketing/watch_influencers.ts watch
  npx ts-node scripts/marketing/watch_influencers.ts show
      `);
  }
}

main().catch(console.error);
