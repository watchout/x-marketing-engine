/**
 * 自動投稿スクリプト（ABテスト対応）
 * 
 * 機能:
 *   - ABテストプールから投稿を選択
 *   - ランダムでA/Bを選択
 *   - X APIで投稿
 *   - 投稿履歴を記録
 * 
 * 使い方:
 *   npx ts-node scripts/marketing/auto_post.ts post <slot>
 *   npx ts-node scripts/marketing/auto_post.ts post morning
 *   npx ts-node scripts/marketing/auto_post.ts post noon
 *   npx ts-node scripts/marketing/auto_post.ts post night
 *   npx ts-node scripts/marketing/auto_post.ts test  # ドライラン
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
        
        // 'export KEY=value' 形式に対応
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

// 型定義
interface Variant {
  content: string;
  hook_type: string;
}

interface Post {
  id: string;
  week: number;
  day: number;
  slot: 'morning' | 'noon' | 'night';
  theme: string;
  type: string;
  variants: {
    A: Variant;
    B: Variant;
  };
  status: string;
  scheduled_date: string;
}

interface ABTestPool {
  metadata: any;
  time_slots: any;
  posts: Post[];
  stats: any;
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
  type?: string;  // 'overseas_insight' | 'academic_insight' | 投稿型名 → source_type判定に使用
  image_path?: string;
  metrics?: {
    impressions: number;
    likes: number;
    retweets: number;
    replies: number;
    bookmarks?: number;
    profile_clicks?: number;
    url_clicks?: number;
    collected_at: string;
  };
}

// ファイルパス（scriptsディレクトリからの相対パス）
const POOL_FILE = path.join(__dirname, '../content/ab_test_pool.yml');
const HISTORY_FILE = path.join(__dirname, '../content/post_history.json');
const LEARNING_STATE_FILE = path.join(__dirname, '../content/learning_state.json');
const RECOMMENDATION_FILE = path.join(__dirname, '../content/next_recommendation.json');

// Thompson Sampling 用の型定義
interface BetaParams {
  alpha: number;
  beta: number;
  trials: number;
  mean: number;
}

interface LearningState {
  theme_scores: Record<string, BetaParams>;
  [key: string]: any;
}

// Beta分布からサンプリング（Jöhnk's beta generator）
function sampleBeta(alpha: number, beta: number): number {
  // 特殊ケース
  if (alpha <= 0 || beta <= 0) return 0.5;

  // Gamma分布からサンプリングしてBeta分布を構成
  const gammaA = sampleGamma(alpha);
  const gammaB = sampleGamma(beta);

  if (gammaA + gammaB === 0) return 0.5;
  return gammaA / (gammaA + gammaB);
}

// Gamma分布からサンプリング（Marsaglia and Tsang's method）
function sampleGamma(shape: number): number {
  if (shape < 1) {
    // shape < 1 の場合の補正
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1.0 / shape);
  }

  const d = shape - 1.0 / 3.0;
  const c = 1.0 / Math.sqrt(9.0 * d);

  while (true) {
    let x: number, v: number;
    do {
      x = normalRandom();
      v = 1.0 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = Math.random();

    if (u < 1.0 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1.0 - v + Math.log(v))) return d * v;
  }
}

// 標準正規分布からサンプリング（Box-Muller変換）
function normalRandom(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// プールを読み込み
function loadPool(): ABTestPool {
  if (!fs.existsSync(POOL_FILE)) {
    throw new Error(`Pool file not found: ${POOL_FILE}`);
  }
  const content = fs.readFileSync(POOL_FILE, 'utf-8');
  return yaml.load(content) as ABTestPool;
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
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// 今日の日付を取得（JST）
function getTodayJST(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().split('T')[0];
}

// 今日の投稿を取得
function getTodayPosts(pool: ABTestPool, slot: string): Post[] {
  const today = getTodayJST();
  return pool.posts.filter(p => 
    p.scheduled_date === today && 
    p.slot === slot && 
    p.status === 'active'
  );
}

// 未投稿の投稿を取得（今日以前で未投稿のもの）
function getPendingPosts(pool: ABTestPool, history: PostHistory[], slot: string): Post[] {
  const today = getTodayJST();
  const postedIds = new Set(history.map(h => `${h.post_id}_${h.posted_at.split('T')[0]}`));

  return pool.posts.filter(p => {
    const key = `${p.id}_${p.scheduled_date}`;
    return p.scheduled_date <= today &&
           p.slot === slot &&
           p.status === 'active' &&
           !postedIds.has(key);
  });
}

// learning_state.json 読み込み
function loadLearningState(): LearningState | null {
  try {
    if (!fs.existsSync(LEARNING_STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(LEARNING_STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

// next_recommendation.json 読み込み（分析エンジンの推薦結果）
interface Recommendation {
  generated_at: string;
  recommended: {
    theme: string;
    approach: string;
    text_features: {
      length: string;
      emoji: string;
      hook: string;
      sentiment: string;
    };
  };
  theme_ranking: Array<{ name: string; sample: number; mean: number; trials: number }>;
  slot_ranking: Array<{ name: string; mean: number; trials: number }>;
  accumulated_learnings: string[];
}

function loadRecommendation(): Recommendation | null {
  try {
    if (!fs.existsSync(RECOMMENDATION_FILE)) return null;
    const rec = JSON.parse(fs.readFileSync(RECOMMENDATION_FILE, 'utf-8'));
    // 7日以上前の推薦は古いので無視
    const age = Date.now() - new Date(rec.generated_at).getTime();
    if (age > 7 * 24 * 60 * 60 * 1000) {
      console.log('   ⚠️ 推薦データが7日以上前のため無視');
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

// テーマレベル Thompson Sampling で投稿を選択
// 推薦結果があればテーマランキングのブースト情報としてログ出力
function selectPostByThompsonSampling(
  pendingPosts: Post[],
  learningState: LearningState | null
): Post {
  // 推薦ファイルがあればログ表示（テーマ選択自体はThompson Samplingが行う）
  const recommendation = loadRecommendation();
  if (recommendation) {
    console.log(`\n📋 分析エンジン推薦 (${recommendation.generated_at.split('T')[0]}):`);
    console.log(`   推薦テーマ: ${recommendation.recommended.theme}`);
    console.log(`   推薦アプローチ: ${recommendation.recommended.approach}`);
    console.log(`   推薦文体: ${recommendation.recommended.text_features.length}文字, ${recommendation.recommended.text_features.hook}フック`);
    if (recommendation.accumulated_learnings.length > 0) {
      console.log(`   蓄積された学び (${recommendation.accumulated_learnings.length}件):`);
      for (const l of recommendation.accumulated_learnings.slice(-3)) {
        console.log(`     • ${l}`);
      }
    }
  }
  // テーマごとにグループ化
  const themeGroups = new Map<string, Post[]>();
  for (const post of pendingPosts) {
    const theme = post.theme || '一般';
    if (!themeGroups.has(theme)) {
      themeGroups.set(theme, []);
    }
    themeGroups.get(theme)!.push(post);
  }

  const themes = Array.from(themeGroups.keys());

  // テーマが1つだけなら従来通り
  if (themes.length <= 1) {
    return pendingPosts[0];
  }

  // 各テーマの Beta パラメータを取得してサンプリング
  const themeScores = learningState?.theme_scores || {};
  const defaultPrior: BetaParams = { alpha: 0.3, beta: 0.7, trials: 0, mean: 0.3 };

  let bestTheme = themes[0];
  let bestSample = -1;

  console.log(`\n🎰 Thompson Sampling テーマ選択:`);

  for (const theme of themes) {
    const params = themeScores[theme] || defaultPrior;
    const sample = sampleBeta(params.alpha, params.beta);

    console.log(`   ${theme}: α=${params.alpha.toFixed(2)}, β=${params.beta.toFixed(2)}, ` +
      `mean=${params.mean.toFixed(3)}, sample=${sample.toFixed(4)}, ` +
      `pending=${themeGroups.get(theme)!.length}件`);

    if (sample > bestSample) {
      bestSample = sample;
      bestTheme = theme;
    }
  }

  console.log(`   → 選択: 「${bestTheme}」(sample=${bestSample.toFixed(4)})`);

  // 選択されたテーマの中から最も古い未投稿を選択
  const themePosts = themeGroups.get(bestTheme)!;
  themePosts.sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
  return themePosts[0];
}

// A/Bをランダム選択（勝者がいる場合は70/30で勝者を優先）
function selectVariant(postId: string, history: PostHistory[]): 'A' | 'B' {
  // この投稿のA/Bの過去実績を集計
  const postHistory = history.filter(h => h.post_id === postId && h.metrics);
  
  const statsA = postHistory.filter(h => h.variant === 'A');
  const statsB = postHistory.filter(h => h.variant === 'B');
  
  // 両方10回以上の投稿がある場合、勝者を70%で選択
  if (statsA.length >= 10 && statsB.length >= 10) {
    const avgLikesA = statsA.reduce((sum, h) => sum + (h.metrics?.likes || 0), 0) / statsA.length;
    const avgLikesB = statsB.reduce((sum, h) => sum + (h.metrics?.likes || 0), 0) / statsB.length;
    
    const winner = avgLikesA > avgLikesB ? 'A' : 'B';
    return Math.random() < 0.7 ? winner : (winner === 'A' ? 'B' : 'A');
  }
  
  // まだデータが不十分な場合は50/50
  return Math.random() < 0.5 ? 'A' : 'B';
}

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
    throw new Error('twitter-api-v2 not installed. Run: npm install twitter-api-v2');
  }
}

// 画像付き投稿実行
async function postTweet(content: string, imagePath?: string): Promise<string> {
  const client = await getXClient();
  
  let mediaId: string | undefined;
  
  // 画像がある場合はアップロード
  if (imagePath && fs.existsSync(imagePath)) {
    console.log(`📸 Uploading image: ${imagePath}`);
    try {
      // v1 APIで画像をアップロード
      const mediaData = fs.readFileSync(imagePath);
      const mediaUpload = await client.v1.uploadMedia(mediaData, {
        mimeType: 'image/png',
      });
      mediaId = mediaUpload;
      console.log(`✅ Image uploaded: ${mediaId}`);
    } catch (e) {
      console.error(`⚠️ Image upload failed, posting without image:`, e);
    }
  }
  
  // ツイート投稿
  const tweetOptions: any = { text: content };
  if (mediaId) {
    tweetOptions.media = { media_ids: [mediaId] };
  }
  
  const result = await client.v2.tweet(tweetOptions);
  return result.data.id;
}

// 画像生成オプション
interface AutoPostOptions {
  slot: string;
  dryRun?: boolean;
  withImage?: boolean;
  imageProvider?: 'gemini' | 'flux' | 'dalle';
  imageStyle?: 'infographic' | 'code' | 'contrast' | 'tech' | 'minimal';
}

// メイン処理
async function autoPost(options: AutoPostOptions | string, dryRun: boolean = false): Promise<void> {
  // 後方互換性: 文字列で呼ばれた場合
  const opts: AutoPostOptions = typeof options === 'string' 
    ? { slot: options, dryRun } 
    : options;
  
  console.log(`\n🤖 Auto Post - Slot: ${opts.slot} ${opts.dryRun ? '(DRY RUN)' : ''}\n`);
  if (opts.withImage) {
    console.log(`🎨 Image generation enabled: ${opts.imageProvider || 'gemini'} / ${opts.imageStyle || 'infographic'}`);
  }
  
  const pool = loadPool();
  const history = loadHistory();
  
  // 未投稿の投稿を取得
  const pendingPosts = getPendingPosts(pool, history, opts.slot);

  if (pendingPosts.length === 0) {
    console.log(`✅ No pending posts for slot: ${opts.slot}`);
    return;
  }

  // Thompson Sampling でテーマを選択し、そのテーマの投稿をピック
  const learningState = loadLearningState();
  const post = selectPostByThompsonSampling(pendingPosts, learningState);
  
  console.log(`📝 Selected post: ${post.id}`);
  console.log(`   Theme: ${post.theme}`);
  console.log(`   Date: ${post.scheduled_date}`);
  
  // A/B選択
  const variant = selectVariant(post.id, history);
  const content = post.variants[variant].content.trim();
  
  console.log(`   Variant: ${variant} (${post.variants[variant].hook_type})`);
  console.log(`   Content preview: ${content.substring(0, 50)}...`);
  
  // 画像生成
  let imagePath: string | undefined;
  if (opts.withImage) {
    try {
      const { generateImage } = await import('./generate_image');
      const result = await generateImage({
        text: content,
        style: opts.imageStyle || 'infographic',
        provider: opts.imageProvider || 'gemini',
      });
      
      if (result.success && result.imagePath) {
        imagePath = result.imagePath;
        console.log(`🎨 Image generated: ${imagePath}`);
      } else {
        console.warn(`⚠️ Image generation failed: ${result.error}`);
      }
    } catch (e) {
      console.warn(`⚠️ Image generation module error:`, e);
    }
  }
  
  if (opts.dryRun) {
    console.log('\n🔍 DRY RUN - Not posting');
    console.log('---');
    console.log(content);
    if (imagePath) {
      console.log(`[Image: ${imagePath}]`);
    }
    console.log('---');
    return;
  }
  
  // 投稿実行
  try {
    const tweetId = await postTweet(content, imagePath);
    console.log(`\n✅ Posted! Tweet ID: ${tweetId}`);
    
    // 履歴に記録
    // post.id と post.type を保存 → analyze_hypothesis.ts の source_type 判定に使用
    const record: PostHistory = {
      id: post.id.startsWith('overseas_') ? post.id : `hist_${Date.now()}`,
      post_id: post.id,
      variant: variant,
      content: content,
      tweet_id: tweetId,
      posted_at: new Date().toISOString(),
      slot: opts.slot,
      theme: post.theme,
      type: post.type || undefined,
      image_path: imagePath,
    };
    
    history.unshift(record);  // 新しい投稿を先頭に追加
    saveHistory(history);
    
    console.log(`📊 History saved: ${record.id}`);
    
  } catch (error) {
    console.error(`❌ Failed to post:`, error);
    throw error;
  }
}

// 履歴表示
function showHistory(): void {
  const history = loadHistory();
  
  if (history.length === 0) {
    console.log('📭 No post history');
    return;
  }
  
  console.log('\n📊 Post History:\n');
  
  for (const h of history.slice(-10)) {
    const date = new Date(h.posted_at).toLocaleString('ja-JP');
    const metrics = h.metrics 
      ? `❤️${h.metrics.likes} 🔁${h.metrics.retweets} 👁️${h.metrics.impressions}`
      : '(metrics pending)';
    
    console.log(`[${date}] ${h.slot.toUpperCase()}`);
    console.log(`  Theme: ${h.theme} | Variant: ${h.variant}`);
    console.log(`  ${metrics}`);
    console.log(`  Tweet: https://x.com/i/web/status/${h.tweet_id}`);
    console.log('');
  }
}

// 統計表示
function showStats(): void {
  const history = loadHistory();
  const withMetrics = history.filter(h => h.metrics);
  
  if (withMetrics.length === 0) {
    console.log('📊 No metrics collected yet');
    return;
  }
  
  console.log('\n📊 AB Test Stats:\n');
  
  // 投稿IDごとに集計
  const byPostId = new Map<string, { A: PostHistory[], B: PostHistory[] }>();
  
  for (const h of withMetrics) {
    if (!byPostId.has(h.post_id)) {
      byPostId.set(h.post_id, { A: [], B: [] });
    }
    byPostId.get(h.post_id)![h.variant].push(h);
  }
  
  for (const [postId, data] of byPostId) {
    const avgLikesA = data.A.length > 0 
      ? data.A.reduce((sum, h) => sum + (h.metrics?.likes || 0), 0) / data.A.length 
      : 0;
    const avgLikesB = data.B.length > 0 
      ? data.B.reduce((sum, h) => sum + (h.metrics?.likes || 0), 0) / data.B.length 
      : 0;
    
    const winner = data.A.length >= 3 && data.B.length >= 3
      ? (avgLikesA > avgLikesB ? 'A' : 'B')
      : 'TBD';
    
    console.log(`${postId}:`);
    console.log(`  A: ${data.A.length} posts, avg likes: ${avgLikesA.toFixed(1)}`);
    console.log(`  B: ${data.B.length} posts, avg likes: ${avgLikesB.toFixed(1)}`);
    console.log(`  Winner: ${winner}`);
    console.log('');
  }
}

// CLI引数パース
function parseArgs(args: string[]): {
  command: string;
  slot?: string;
  withImage: boolean;
  imageProvider?: 'gemini' | 'flux' | 'dalle';
  imageStyle?: 'infographic' | 'code' | 'contrast' | 'tech' | 'minimal';
} {
  const result = {
    command: args[0] || 'help',
    slot: undefined as string | undefined,
    withImage: false,
    imageProvider: undefined as 'gemini' | 'flux' | 'dalle' | undefined,
    imageStyle: undefined as 'infographic' | 'code' | 'contrast' | 'tech' | 'minimal' | undefined,
  };
  
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--with-image') {
      result.withImage = true;
    } else if (arg === '--provider' && args[i + 1]) {
      result.imageProvider = args[++i] as any;
    } else if (arg === '--style' && args[i + 1]) {
      result.imageStyle = args[++i] as any;
    } else if (!arg.startsWith('--') && !result.slot) {
      result.slot = arg;
    }
  }
  
  return result;
}

// CLI
async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  switch (parsed.command) {
    case 'post':
      if (!parsed.slot || !['morning', 'mid_morning', 'noon', 'evening', 'night'].includes(parsed.slot)) {
        console.error('Usage: auto_post.ts post <morning|mid_morning|noon|evening|night> [--with-image] [--provider gemini|flux|dalle] [--style infographic|code|contrast|tech|minimal]');
        process.exit(1);
      }
      await autoPost({
        slot: parsed.slot,
        dryRun: false,
        withImage: parsed.withImage,
        imageProvider: parsed.imageProvider,
        imageStyle: parsed.imageStyle,
      });
      break;

    case 'test':
      const testSlot = parsed.slot || 'noon';
      await autoPost({
        slot: testSlot,
        dryRun: true,
        withImage: parsed.withImage,
        imageProvider: parsed.imageProvider,
        imageStyle: parsed.imageStyle,
      });
      break;

    case 'history':
      showHistory();
      break;

    case 'stats':
      showStats();
      break;

    case 'help':
    default:
      console.log(`
自動投稿スクリプト（ABテスト対応 + 画像生成）

使い方:
  npx ts-node scripts/marketing/auto_post.ts <command> [options]

コマンド:
  post <slot>    投稿実行（morning/noon/night）
  test [slot]    ドライラン
  history        投稿履歴を表示
  stats          ABテスト統計を表示

オプション:
  --with-image              画像を自動生成して添付
  --provider <provider>     画像生成プロバイダー: gemini, flux, dalle
  --style <style>           画像スタイル: infographic, code, contrast, tech, minimal

例:
  npx ts-node scripts/marketing/auto_post.ts post noon
  npx ts-node scripts/marketing/auto_post.ts post noon --with-image
  npx ts-node scripts/marketing/auto_post.ts post morning --with-image --provider flux --style tech
  npx ts-node scripts/marketing/auto_post.ts test noon --with-image
      `);
  }
}

main().catch(console.error);
