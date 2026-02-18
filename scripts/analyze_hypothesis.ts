/**
 * 仮説検証 × 学習エンジン
 *
 * 学術的根拠:
 *   - X Algorithm Heavy Ranker の公開重み付け係数（2023 OSS公開）
 *   - RecSys 2020 Challenge: Target Encoding + 特徴量クロス (NVIDIA 優勝)
 *   - TweetGage (2023): テキスト特徴 > グラフ特徴 (F1=0.89)
 *   - Kim & Hwang (2025): 感情×時間特徴でlikes R²=0.98
 *   - Dynamic Prior Thompson Sampling (2026): コールドスタート探索の事前分布最適化
 *
 * 機能:
 *   analyze   - 全投稿にXAS+7軸帰属分析を実行
 *   verify    - pain_hypothesis_log.ymlの仮説を検証し学習を蓄積
 *   recommend - Thompson Samplingで次回投稿パラメータを推薦
 *   report    - 人間向けサマリーレポートを生成
 *
 * 使い方:
 *   npx ts-node scripts/analyze_hypothesis.ts analyze
 *   npx ts-node scripts/analyze_hypothesis.ts verify
 *   npx ts-node scripts/analyze_hypothesis.ts recommend
 *   npx ts-node scripts/analyze_hypothesis.ts report
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const PROJECT_ROOT = path.join(__dirname, '..');
const HISTORY_FILE = path.join(PROJECT_ROOT, 'content/post_history.json');
const HYPOTHESIS_LOG = path.join(PROJECT_ROOT, 'content/pain_hypothesis_log.yml');
const LEARNING_STATE = path.join(PROJECT_ROOT, 'content/learning_state.json');
const ANALYSIS_OUTPUT = path.join(PROJECT_ROOT, 'content/hypothesis_analysis.json');
const RECOMMENDATION_FILE = path.join(PROJECT_ROOT, 'content/next_recommendation.json');

// ========== 型定義 ==========

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
  type?: string;
  metrics?: PostMetrics;
}

interface TextFeatures {
  char_count: number;
  line_count: number;
  emoji_count: number;
  has_numbers: boolean;
  has_question: boolean;
  has_exclamation: boolean;
  has_ellipsis: boolean;
  hashtag_count: number;
  mention_count: number;
  url_count: number;
  first_line_length: number;
  hook_pattern: string;
  sentiment: string;
}

interface XASResult {
  raw_xas: number;
  normalized_xas: number;  // per 1000 impressions
  engagement_rate: number;
  amplification_rate: number;
  conversation_rate: number;
  save_rate: number;
  growth_score: number;
}

interface Attribution {
  theme: string;
  approach: string;
  text_features: TextFeatures;
  slot: string;
  day_of_week: number;
  variant: string;
  theme_freshness: number;
  days_since_same_theme: number;
  source_type: string;  // 'domestic' | 'overseas_trend' | 'academic_paper' | 'unknown'
}

interface AnalyzedPost {
  post_id: string;
  tweet_id: string;
  posted_at: string;
  content: string;
  xas: XASResult;
  attribution: Attribution;
}

// Thompson Sampling の Beta 分布パラメータ
interface BetaParams {
  alpha: number;
  beta: number;
  trials: number;
  mean: number;
}

interface LearningState {
  version: string;
  last_updated: string;
  // テーマ別のBeta分布
  theme_scores: Record<string, BetaParams>;
  // アプローチ別のBeta分布
  approach_scores: Record<string, BetaParams>;
  // スロット別のBeta分布
  slot_scores: Record<string, BetaParams>;
  // バリアント別のBeta分布
  variant_scores: Record<string, BetaParams>;
  // テキスト特徴別のBeta分布
  feature_scores: Record<string, BetaParams>;
  // 情報ソース種別のBeta分布（8軸目: 海外 vs 国内 の仮説検証用）
  source_type_scores: Record<string, BetaParams>;
  // 全体統計
  global_stats: {
    total_analyzed: number;
    avg_xas: number;
    avg_impressions: number;
    best_xas_post: string | null;
    worst_xas_post: string | null;
  };
}

// ========== X Algorithm-Aligned Score (XAS) ==========
// 根拠: X公式OSS (github.com/twitter/the-algorithm) Heavy Ranker

function calculateXAS(metrics: PostMetrics): XASResult {
  const replies = metrics.replies || 0;
  const bookmarks = metrics.bookmarks || 0;
  const retweets = metrics.retweets || 0;
  const likes = metrics.likes || 0;
  const profile_clicks = metrics.profile_clicks || 0;
  const url_clicks = metrics.url_clicks || 0;
  const impressions = Math.max(metrics.impressions, 1);

  // X Algorithm Heavy Ranker 重み付け
  // 返信 ×13.5 (著者応答+75は取得不可のため13.5で統一)
  // ブックマーク ×10.0
  // RT ×1.0 (内部スコアでは×20だが公開APIの重みは×1.0)
  // いいね ×0.5
  // プロフィールクリック ×12.0
  // URLクリック ×5.0 (推定値)
  const raw_xas =
    (replies * 13.5) +
    (bookmarks * 10.0) +
    (retweets * 1.0) +
    (likes * 0.5) +
    (profile_clicks * 12.0) +
    (url_clicks * 5.0);

  const normalized_xas = (raw_xas / impressions) * 1000;

  const total_engagements = likes + retweets + replies + bookmarks;
  const engagement_rate = total_engagements / impressions;
  const amplification_rate = retweets / impressions;
  const conversation_rate = replies / impressions;
  const save_rate = bookmarks / impressions;

  // Growth Score: 24フォロワー規模はリーチ最優先
  const growth_score =
    (impressions * 0.4) +
    (normalized_xas * 0.3) +
    (profile_clicks * 0.2) +
    (total_engagements * 0.1);

  return {
    raw_xas: Math.round(raw_xas * 100) / 100,
    normalized_xas: Math.round(normalized_xas * 100) / 100,
    engagement_rate: Math.round(engagement_rate * 10000) / 10000,
    amplification_rate: Math.round(amplification_rate * 10000) / 10000,
    conversation_rate: Math.round(conversation_rate * 10000) / 10000,
    save_rate: Math.round(save_rate * 10000) / 10000,
    growth_score: Math.round(growth_score * 100) / 100,
  };
}

// ========== テキスト特徴抽出 ==========
// 根拠: TweetGage(2023) テキスト特徴が精度87%で最重要
// 根拠: Kim&Hwang(2025) 感情特徴でlikes R²=0.98

function extractTextFeatures(content: string): TextFeatures {
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const firstLine = lines[0] || '';

  // 絵文字カウント
  const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}]/gu;
  const emojis = content.match(emojiRegex);

  // 数字の有無（具体的数値: 3倍、50%、100万等）
  const hasNumbers = /\d+[%％倍万億件時間分秒日月年回個]|\d+x|\$\d+/.test(content);

  // フックパターン判定
  let hookPattern = 'neutral';
  if (/^[「『]|みんな|あるある|わかる|つらい/.test(firstLine)) hookPattern = 'empathy';
  else if (/[？?]$|[？?]\n/.test(firstLine)) hookPattern = 'question';
  else if (/\d+[%％倍]|[0-9]+[万億]/.test(firstLine)) hookPattern = 'data';
  else if (/vs|VS|比較|違い|どっち/.test(firstLine)) hookPattern = 'contrast';
  else if (/実は|知ら[なれ]|意外|驚/.test(firstLine)) hookPattern = 'discovery';
  else if (/正直|ぶっちゃけ|マジで|ヤバ/.test(firstLine)) hookPattern = 'confession';

  // 簡易感情判定（Kim & Hwang 2025のvalence概念を簡略化）
  let sentiment = 'neutral';
  const positiveWords = /嬉しい|楽し|最高|素晴|すごい|便利|効率|改善|成功|達成|✨|🎉|🚀|💡/;
  const negativeWords = /辛い|苦し|失敗|問題|悩|困|不安|怖|😩|😭|💀|❌/;
  if (positiveWords.test(content) && !negativeWords.test(content)) sentiment = 'positive';
  else if (negativeWords.test(content) && !positiveWords.test(content)) sentiment = 'negative';
  else if (positiveWords.test(content) && negativeWords.test(content)) sentiment = 'mixed'; // 共感→解決型

  return {
    char_count: content.length,
    line_count: lines.length,
    emoji_count: emojis ? emojis.length : 0,
    has_numbers: hasNumbers,
    has_question: /[？?]/.test(content),
    has_exclamation: /[！!]/.test(content),
    has_ellipsis: /[…]|\.\.\./.test(content),
    hashtag_count: (content.match(/#\S+/g) || []).length,
    mention_count: (content.match(/@\S+/g) || []).length,
    url_count: (content.match(/https?:\/\/\S+/g) || []).length,
    first_line_length: firstLine.length,
    hook_pattern: hookPattern,
    sentiment: sentiment,
  };
}

// ========== テーマ鮮度（シーケンス帰属） ==========

function calculateThemeFreshness(
  postDate: string,
  theme: string,
  allPosts: PostHistory[]
): { freshness: number; days_since: number } {
  const postTime = new Date(postDate).getTime();

  // 同テーマの直前の投稿を探す
  const samethemePosts = allPosts
    .filter(p => p.theme === theme && new Date(p.posted_at).getTime() < postTime)
    .sort((a, b) => new Date(b.posted_at).getTime() - new Date(a.posted_at).getTime());

  if (samethemePosts.length === 0) {
    return { freshness: 1.0, days_since: 999 };
  }

  const lastSameTheme = new Date(samethemePosts[0].posted_at).getTime();
  const daysSince = (postTime - lastSameTheme) / (1000 * 60 * 60 * 24);

  // 鮮度ペナルティ: 連続同テーマほど低い
  // 7日以上空いていれば鮮度1.0
  // 1日で0.85、同日で0.70
  const freshness = Math.min(1.0, 0.70 + (daysSince / 7) * 0.30);

  return {
    freshness: Math.round(freshness * 100) / 100,
    days_since: Math.round(daysSince * 10) / 10,
  };
}

// ========== Thompson Sampling ==========
// 根拠: Stanford TS Tutorial (Russo et al.)
// 根拠: Dynamic Prior TS (2026) - コールドスタート事前分布

function initBetaParams(): BetaParams {
  // Dynamic Prior: Beta(1, 1) ではなく控えめな事前分布
  // 新パラメータの初期成功率を30%に設定（過度な楽観を防ぐ）
  return { alpha: 0.3, beta: 0.7, trials: 0, mean: 0.3 };
}

function updateBeta(params: BetaParams, score: number, maxScore: number): BetaParams {
  // スコアを0-1に正規化して成功/失敗としてBeta分布を更新
  const normalizedScore = Math.min(1.0, Math.max(0.0, score / Math.max(maxScore, 1)));

  const newAlpha = params.alpha + normalizedScore;
  const newBeta = params.beta + (1 - normalizedScore);
  const newTrials = params.trials + 1;
  const newMean = newAlpha / (newAlpha + newBeta);

  return {
    alpha: Math.round(newAlpha * 1000) / 1000,
    beta: Math.round(newBeta * 1000) / 1000,
    trials: newTrials,
    mean: Math.round(newMean * 1000) / 1000,
  };
}

function sampleBeta(params: BetaParams): number {
  // Beta分布からサンプリング（Jöhnk's algorithm簡略版）
  // 本来はjstat等を使うが、依存を増やさないために近似
  const { alpha, beta } = params;
  if (alpha <= 0 || beta <= 0) return 0.5;

  // 平均 + 分散ベースの正規近似（十分なtrialsがある場合）
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const stddev = Math.sqrt(variance);

  // Box-Muller変換で正規分布サンプル
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

  const sample = mean + z * stddev;
  return Math.min(1.0, Math.max(0.0, sample));
}

// ========== 学習状態の管理 ==========

function loadLearningState(): LearningState {
  if (fs.existsSync(LEARNING_STATE)) {
    return JSON.parse(fs.readFileSync(LEARNING_STATE, 'utf-8'));
  }
  return {
    version: '2.1',
    last_updated: new Date().toISOString(),
    theme_scores: {},
    approach_scores: {},
    slot_scores: {},
    variant_scores: {},
    feature_scores: {},
    source_type_scores: {},
    global_stats: {
      total_analyzed: 0,
      avg_xas: 0,
      avg_impressions: 0,
      best_xas_post: null,
      worst_xas_post: null,
    },
  };
}

function saveLearningState(state: LearningState): void {
  state.last_updated = new Date().toISOString();
  fs.writeFileSync(LEARNING_STATE, JSON.stringify(state, null, 2));
  console.log('✅ learning_state.json を更新しました');
}

// ========== メイン分析 ==========

function analyze(): void {
  console.log('\n📊 XAS + 7軸帰属分析を実行\n');

  const history: PostHistory[] = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  const withMetrics = history.filter(h => h.metrics);

  if (withMetrics.length === 0) {
    console.log('⚠️ メトリクス付き投稿がありません');
    return;
  }

  console.log(`📝 分析対象: ${withMetrics.length} 件（メトリクスあり）`);

  const state = loadLearningState();
  const results: AnalyzedPost[] = [];

  let totalXAS = 0;
  let totalImp = 0;
  let bestXAS = { score: -1, id: '' };
  let worstXAS = { score: Infinity, id: '' };
  let maxXAS = 0;

  // Phase 1: 全投稿のXASを計算
  for (const post of withMetrics) {
    const xas = calculateXAS(post.metrics!);
    const textFeatures = extractTextFeatures(post.content);
    const { freshness, days_since } = calculateThemeFreshness(
      post.posted_at, post.theme, history
    );

    const dayOfWeek = new Date(post.posted_at).getDay();

    // ソース種別の判定（投稿IDパターンまたはtype情報から推定）
    let sourceType = 'unknown';
    if (post.id.startsWith('overseas_') || (post as any).type === 'overseas_insight') {
      sourceType = 'overseas_trend';
    } else if ((post as any).type === 'academic_insight') {
      sourceType = 'academic_paper';
    } else if (post.id.startsWith('hist_') || post.id.startsWith('pool_')) {
      sourceType = 'domestic';
    }

    results.push({
      post_id: post.id,
      tweet_id: post.tweet_id,
      posted_at: post.posted_at,
      content: post.content,
      xas,
      attribution: {
        theme: post.theme,
        approach: post.type || 'unknown',
        text_features: textFeatures,
        slot: post.slot,
        day_of_week: dayOfWeek,
        variant: post.variant,
        theme_freshness: freshness,
        days_since_same_theme: days_since,
        source_type: sourceType,
      },
    });

    totalXAS += xas.normalized_xas;
    totalImp += post.metrics!.impressions;

    if (xas.normalized_xas > bestXAS.score) {
      bestXAS = { score: xas.normalized_xas, id: post.id };
    }
    if (xas.normalized_xas < worstXAS.score) {
      worstXAS = { score: xas.normalized_xas, id: post.id };
    }
    if (xas.normalized_xas > maxXAS) {
      maxXAS = xas.normalized_xas;
    }
  }

  // Phase 2: Thompson Sampling 更新
  for (const result of results) {
    const score = result.xas.normalized_xas;
    const attr = result.attribution;

    // テーマ
    if (!state.theme_scores[attr.theme]) state.theme_scores[attr.theme] = initBetaParams();
    state.theme_scores[attr.theme] = updateBeta(state.theme_scores[attr.theme], score, maxXAS);

    // アプローチ
    if (!state.approach_scores[attr.approach]) state.approach_scores[attr.approach] = initBetaParams();
    state.approach_scores[attr.approach] = updateBeta(state.approach_scores[attr.approach], score, maxXAS);

    // スロット
    if (!state.slot_scores[attr.slot]) state.slot_scores[attr.slot] = initBetaParams();
    state.slot_scores[attr.slot] = updateBeta(state.slot_scores[attr.slot], score, maxXAS);

    // バリアント
    if (!state.variant_scores[attr.variant]) state.variant_scores[attr.variant] = initBetaParams();
    state.variant_scores[attr.variant] = updateBeta(state.variant_scores[attr.variant], score, maxXAS);

    // テキスト特徴（離散化してキーに）
    const charBucket = attr.text_features.char_count < 120 ? 'short' : attr.text_features.char_count < 200 ? 'medium' : 'long';
    if (!state.feature_scores[`len_${charBucket}`]) state.feature_scores[`len_${charBucket}`] = initBetaParams();
    state.feature_scores[`len_${charBucket}`] = updateBeta(state.feature_scores[`len_${charBucket}`], score, maxXAS);

    const emojiKey = attr.text_features.emoji_count === 0 ? 'emoji_none' : attr.text_features.emoji_count <= 2 ? 'emoji_few' : 'emoji_many';
    if (!state.feature_scores[emojiKey]) state.feature_scores[emojiKey] = initBetaParams();
    state.feature_scores[emojiKey] = updateBeta(state.feature_scores[emojiKey], score, maxXAS);

    if (!state.feature_scores[`hook_${attr.text_features.hook_pattern}`]) state.feature_scores[`hook_${attr.text_features.hook_pattern}`] = initBetaParams();
    state.feature_scores[`hook_${attr.text_features.hook_pattern}`] = updateBeta(state.feature_scores[`hook_${attr.text_features.hook_pattern}`], score, maxXAS);

    if (!state.feature_scores[`sentiment_${attr.text_features.sentiment}`]) state.feature_scores[`sentiment_${attr.text_features.sentiment}`] = initBetaParams();
    state.feature_scores[`sentiment_${attr.text_features.sentiment}`] = updateBeta(state.feature_scores[`sentiment_${attr.text_features.sentiment}`], score, maxXAS);

    const hashtagKey = attr.text_features.hashtag_count === 0 ? 'hashtag_none' : 'hashtag_yes';
    if (!state.feature_scores[hashtagKey]) state.feature_scores[hashtagKey] = initBetaParams();
    state.feature_scores[hashtagKey] = updateBeta(state.feature_scores[hashtagKey], score, maxXAS);

    const numberKey = attr.text_features.has_numbers ? 'has_numbers' : 'no_numbers';
    if (!state.feature_scores[numberKey]) state.feature_scores[numberKey] = initBetaParams();
    state.feature_scores[numberKey] = updateBeta(state.feature_scores[numberKey], score, maxXAS);

    // ソース種別（8軸目: 海外情報 vs 国内の仮説検証）
    if (!state.source_type_scores) state.source_type_scores = {};
    if (!state.source_type_scores[attr.source_type]) state.source_type_scores[attr.source_type] = initBetaParams();
    state.source_type_scores[attr.source_type] = updateBeta(state.source_type_scores[attr.source_type], score, maxXAS);
  }

  // グローバル統計
  state.global_stats = {
    total_analyzed: results.length,
    avg_xas: Math.round((totalXAS / results.length) * 100) / 100,
    avg_impressions: Math.round(totalImp / results.length),
    best_xas_post: bestXAS.id,
    worst_xas_post: worstXAS.id,
  };

  // 保存
  saveLearningState(state);
  fs.writeFileSync(ANALYSIS_OUTPUT, JSON.stringify(results, null, 2));
  console.log(`✅ hypothesis_analysis.json に ${results.length} 件の分析結果を保存`);

  // サマリー出力
  console.log('\n📈 分析サマリー:');
  console.log(`   分析件数: ${results.length}`);
  console.log(`   平均XAS: ${state.global_stats.avg_xas}`);
  console.log(`   平均imp: ${state.global_stats.avg_impressions}`);
  console.log(`   ベストXAS: ${bestXAS.id} (${bestXAS.score})`);
  console.log(`   ワーストXAS: ${worstXAS.id} (${worstXAS.score})`);
}

// ========== 仮説検証 ==========

function verify(): void {
  console.log('\n🔬 仮説検証を実行\n');

  if (!fs.existsSync(HYPOTHESIS_LOG)) {
    console.log('⚠️ pain_hypothesis_log.yml が見つかりません');
    return;
  }
  if (!fs.existsSync(ANALYSIS_OUTPUT)) {
    console.log('⚠️ 先に analyze を実行してください');
    return;
  }

  const log = yaml.load(fs.readFileSync(HYPOTHESIS_LOG, 'utf-8')) as any;
  const results: AnalyzedPost[] = JSON.parse(fs.readFileSync(ANALYSIS_OUTPUT, 'utf-8'));

  if (!log.weeks || log.weeks.length === 0) {
    console.log('⚠️ 週次ログがありません');
    return;
  }

  let updated = false;

  for (const week of log.weeks) {
    if (week.result && week.result.avg_imp !== null) {
      console.log(`⏭️ ${week.week} は検証済み。スキップ。`);
      continue;
    }

    // このテーマの投稿を抽出
    const themePosts = results.filter(r => r.attribution.theme === week.theme);

    if (themePosts.length === 0) {
      console.log(`⚠️ ${week.week} (${week.theme}) のメトリクス付き投稿がありません`);
      continue;
    }

    // メトリクス集計
    const avgXAS = themePosts.reduce((s, p) => s + p.xas.normalized_xas, 0) / themePosts.length;
    const avgImp = themePosts.reduce((s, p) => s + p.xas.growth_score, 0) / themePosts.length;
    const avgER = themePosts.reduce((s, p) => s + p.xas.engagement_rate, 0) / themePosts.length;

    // ベスト/ワースト投稿
    const sorted = [...themePosts].sort((a, b) => b.xas.normalized_xas - a.xas.normalized_xas);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];

    // 結果を記入
    week.result = {
      posts_count: themePosts.length,
      avg_imp: Math.round(avgImp * 100) / 100,
      avg_xas: Math.round(avgXAS * 100) / 100,
      avg_er: Math.round(avgER * 10000) / 10000,
      best_post: best?.post_id || null,
      worst_post: worst?.post_id || null,
    };

    // 自動検証ロジック
    const state = loadLearningState();
    const themeScore = state.theme_scores[week.theme];
    const approachScore = state.approach_scores[week.approach];

    week.verification = {
      pain_accurate: avgXAS > (state.global_stats.avg_xas || 0) ? true : false,
      approach_effective: approachScore && approachScore.mean > 0.5 ? true : false,
      expression_worked: best ? best.xas.normalized_xas > avgXAS * 1.2 : null,
      framework_link_value: week.framework_link?.matched ? avgXAS > (state.global_stats.avg_xas || 0) * 0.8 : null,
    };

    // 学びの自動生成
    const learnings: string[] = [];

    if (week.verification.pain_accurate) {
      learnings.push(`テーマ「${week.theme}」のペイン分析は正確だった（XAS ${Math.round(avgXAS)} > 平均${Math.round(state.global_stats.avg_xas || 0)}）`);
    } else {
      learnings.push(`テーマ「${week.theme}」のXASは平均以下（${Math.round(avgXAS)} < ${Math.round(state.global_stats.avg_xas || 0)}）。ペインの刺し方を再検討`);
    }

    if (best) {
      const bestFeatures = best.attribution.text_features;
      learnings.push(`ベスト投稿: ${bestFeatures.char_count}字, hook=${bestFeatures.hook_pattern}, sentiment=${bestFeatures.sentiment}`);
    }

    // テーマ鮮度の影響
    const avgFreshness = themePosts.reduce((s, p) => s + p.attribution.theme_freshness, 0) / themePosts.length;
    if (avgFreshness < 0.85) {
      learnings.push(`テーマ鮮度が低い（${Math.round(avgFreshness * 100)}%）。次週は異なるテーマを推奨`);
    }

    week.learning = learnings.join('。');
    week.next_action = avgXAS > (state.global_stats.avg_xas || 0)
      ? `テーマ「${week.theme}」は有効。同系統のペインで深掘り可能`
      : `テーマ変更を検討。accumulated_learningsに追加`;

    updated = true;
    console.log(`✅ ${week.week} (${week.theme}) を検証完了`);
    console.log(`   XAS: ${Math.round(avgXAS)}, ER: ${Math.round(avgER * 10000) / 100}%`);
    console.log(`   学び: ${week.learning}`);
  }

  if (updated) {
    // accumulated_learningsに新しい学びを追加
    const newLearnings = log.weeks
      .filter((w: any) => w.learning && w.learning.length > 0)
      .map((w: any) => w.learning)
      .slice(-3); // 直近3件

    for (const learning of newLearnings) {
      if (!log.accumulated_learnings.includes(learning)) {
        // 10件超えたら古いものを削除
        if (log.accumulated_learnings.length >= 12) {
          log.accumulated_learnings.shift();
        }
        log.accumulated_learnings.push(learning);
      }
    }

    log.last_updated = new Date().toISOString().split('T')[0];

    const header = `# ペイン仮説検証ログ
# 毎週のテーマ決定→結果→学びを蓄積する
# C0テーマ決定エージェントが過去の学びを参照する

`;
    const yamlContent = yaml.dump(log, { lineWidth: -1, noRefs: true });
    fs.writeFileSync(HYPOTHESIS_LOG, header + yamlContent);
    console.log('\n✅ pain_hypothesis_log.yml を更新しました');
  }
}

// ========== Thompson Sampling 推薦 ==========

function recommend(): void {
  console.log('\n🎯 Thompson Sampling 推薦\n');

  const state = loadLearningState();

  if (state.global_stats.total_analyzed === 0) {
    console.log('⚠️ 先に analyze を実行してください');
    return;
  }

  // 各パラメータからサンプリングしてランキング
  console.log('📊 テーマ別スコア（Thompson Sampling）:');
  const themeSamples: Array<{ name: string; sample: number; mean: number; trials: number }> = [];
  for (const [name, params] of Object.entries(state.theme_scores)) {
    const sample = sampleBeta(params);
    themeSamples.push({ name, sample, mean: params.mean, trials: params.trials });
  }
  themeSamples.sort((a, b) => b.sample - a.sample);
  for (const t of themeSamples) {
    const bar = '█'.repeat(Math.round(t.sample * 20));
    console.log(`   ${bar} ${t.name}: ${Math.round(t.sample * 100)}% (平均${Math.round(t.mean * 100)}%, n=${t.trials})`);
  }

  console.log('\n📊 アプローチ別スコア:');
  const approachSamples: Array<{ name: string; sample: number; mean: number; trials: number }> = [];
  for (const [name, params] of Object.entries(state.approach_scores)) {
    const sample = sampleBeta(params);
    approachSamples.push({ name, sample, mean: params.mean, trials: params.trials });
  }
  approachSamples.sort((a, b) => b.sample - a.sample);
  for (const a of approachSamples) {
    const bar = '█'.repeat(Math.round(a.sample * 20));
    console.log(`   ${bar} ${a.name}: ${Math.round(a.sample * 100)}% (平均${Math.round(a.mean * 100)}%, n=${a.trials})`);
  }

  console.log('\n📊 スロット別スコア:');
  for (const [name, params] of Object.entries(state.slot_scores)) {
    const sample = sampleBeta(params);
    const bar = '█'.repeat(Math.round(sample * 20));
    console.log(`   ${bar} ${name}: ${Math.round(sample * 100)}% (平均${Math.round(params.mean * 100)}%, n=${params.trials})`);
  }

  console.log('\n📊 テキスト特徴別スコア:');
  const featureSamples: Array<{ name: string; sample: number; mean: number; trials: number }> = [];
  for (const [name, params] of Object.entries(state.feature_scores)) {
    const sample = sampleBeta(params);
    featureSamples.push({ name, sample, mean: params.mean, trials: params.trials });
  }
  featureSamples.sort((a, b) => b.sample - a.sample);
  for (const f of featureSamples) {
    const bar = '█'.repeat(Math.round(f.sample * 20));
    console.log(`   ${bar} ${f.name}: ${Math.round(f.sample * 100)}% (平均${Math.round(f.mean * 100)}%, n=${f.trials})`);
  }

  // ソース種別（海外 vs 国内 仮説検証）
  if (state.source_type_scores && Object.keys(state.source_type_scores).length > 0) {
    console.log('\n📊 ソース種別スコア（海外 vs 国内 仮説検証）:');
    const sourceTypeSamples: Array<{ name: string; sample: number; mean: number; trials: number }> = [];
    for (const [name, params] of Object.entries(state.source_type_scores)) {
      const sample = sampleBeta(params);
      sourceTypeSamples.push({ name, sample, mean: params.mean, trials: params.trials });
    }
    sourceTypeSamples.sort((a, b) => b.sample - a.sample);
    for (const s of sourceTypeSamples) {
      const bar = '█'.repeat(Math.round(s.sample * 20));
      console.log(`   ${bar} ${s.name}: ${Math.round(s.sample * 100)}% (平均${Math.round(s.mean * 100)}%, n=${s.trials})`);
    }

    // 仮説検証の判定
    const overseas = sourceTypeSamples.find(s => s.name === 'overseas_trend');
    const academic = sourceTypeSamples.find(s => s.name === 'academic_paper');
    const domestic = sourceTypeSamples.find(s => s.name === 'domestic');

    if (overseas && domestic && overseas.trials >= 5 && domestic.trials >= 5) {
      const diff = overseas.mean - domestic.mean;
      if (Math.abs(diff) > 0.05) {
        console.log(`\n   ⚖️ 仮説判定: 海外トレンド(${Math.round(overseas.mean * 100)}%) vs 国内(${Math.round(domestic.mean * 100)}%)`);
        console.log(`   → ${diff > 0 ? '海外ソースの方がXASが高い傾向' : '国内ソースの方がXASが高い傾向'}（差: ${Math.round(Math.abs(diff) * 100)}pt）`);
      } else {
        console.log(`\n   ⚖️ 仮説判定: ソース種別によるXAS差は現時点で有意ではない（差: ${Math.round(Math.abs(diff) * 100)}pt）`);
      }
    } else {
      console.log(`\n   ⏳ 仮説検証にはデータ不足。最低各5件のデータが必要`);
      console.log(`     海外トレンド: ${overseas?.trials || 0}件, 論文: ${academic?.trials || 0}件, 国内: ${domestic?.trials || 0}件`);
    }
  }

  // 最適な組み合わせを推薦
  const bestTheme = themeSamples[0]?.name || '新テーマ推奨';
  const bestApproach = approachSamples[0]?.name || 'discovery';
  const bestLength = featureSamples.find(f => f.name.startsWith('len_'))?.name.replace('len_', '') || 'short';
  const bestEmoji = featureSamples.find(f => f.name.startsWith('emoji_'))?.name.replace('emoji_', '') || 'few';
  const bestHook = featureSamples.find(f => f.name.startsWith('hook_'))?.name.replace('hook_', '') || 'confession';
  const bestSentiment = featureSamples.find(f => f.name.startsWith('sentiment_'))?.name.replace('sentiment_', '') || 'mixed';

  console.log('\n🏆 次回投稿の推薦パラメータ:');
  console.log(`   テーマ候補: ${bestTheme}`);
  console.log(`   アプローチ: ${bestApproach}`);
  console.log(`   文字数: ${bestLength}`);
  console.log(`   絵文字: ${bestEmoji}`);
  console.log(`   フック: ${bestHook}`);
  console.log(`   感情: ${bestSentiment}`);

  // 推薦結果をJSONに永続化（auto_post.ts, C0テーマ決定が参照）
  const recommendation = {
    generated_at: new Date().toISOString(),
    based_on: {
      total_analyzed: state.global_stats.total_analyzed,
      avg_xas: state.global_stats.avg_xas,
    },
    recommended: {
      theme: bestTheme,
      approach: bestApproach,
      text_features: {
        length: bestLength,
        emoji: bestEmoji,
        hook: bestHook,
        sentiment: bestSentiment,
      },
    },
    theme_ranking: themeSamples.map(t => ({
      name: t.name,
      sample: Math.round(t.sample * 1000) / 1000,
      mean: Math.round(t.mean * 1000) / 1000,
      trials: t.trials,
    })),
    approach_ranking: approachSamples.map(a => ({
      name: a.name,
      sample: Math.round(a.sample * 1000) / 1000,
      mean: Math.round(a.mean * 1000) / 1000,
      trials: a.trials,
    })),
    slot_ranking: Object.entries(state.slot_scores).map(([name, params]) => ({
      name,
      mean: Math.round(params.mean * 1000) / 1000,
      trials: params.trials,
    })).sort((a, b) => b.mean - a.mean),
    accumulated_learnings: [] as string[],
  };

  // accumulated_learnings も一緒に保存（C0が一括参照できるように）
  if (fs.existsSync(HYPOTHESIS_LOG)) {
    try {
      const log = yaml.load(fs.readFileSync(HYPOTHESIS_LOG, 'utf-8')) as any;
      if (log?.accumulated_learnings) {
        recommendation.accumulated_learnings = log.accumulated_learnings;
      }
    } catch { /* ignore */ }
  }

  fs.writeFileSync(RECOMMENDATION_FILE, JSON.stringify(recommendation, null, 2));
  console.log(`\n📁 推薦結果を保存: content/next_recommendation.json`);
}

// ========== レポート生成 ==========

function report(): void {
  console.log('\n📋 人間向け分析レポート\n');

  const state = loadLearningState();

  if (state.global_stats.total_analyzed === 0) {
    console.log('⚠️ 先に analyze を実行してください');
    return;
  }

  console.log('═══════════════════════════════════════');
  console.log('  X Marketing Engine 分析レポート');
  console.log(`  生成日: ${new Date().toISOString().split('T')[0]}`);
  console.log('═══════════════════════════════════════\n');

  console.log(`📊 全体統計:`);
  console.log(`   分析件数: ${state.global_stats.total_analyzed}`);
  console.log(`   平均XAS: ${state.global_stats.avg_xas} (1000imp当たり)`);
  console.log(`   平均imp: ${state.global_stats.avg_impressions}`);

  // テーマ別ランキング
  console.log('\n🏆 テーマ別パフォーマンス（Thompson Sampling平均）:');
  const themes = Object.entries(state.theme_scores)
    .sort((a, b) => b[1].mean - a[1].mean);
  for (const [name, params] of themes) {
    const indicator = params.mean > 0.5 ? '🟢' : params.mean > 0.3 ? '🟡' : '🔴';
    console.log(`   ${indicator} ${name}: ${Math.round(params.mean * 100)}% (n=${params.trials})`);
  }

  // テキスト特徴の発見
  console.log('\n💡 テキスト特徴の発見:');
  const features = Object.entries(state.feature_scores)
    .sort((a, b) => b[1].mean - a[1].mean);
  for (const [name, params] of features.slice(0, 8)) {
    const indicator = params.mean > 0.5 ? '🟢' : params.mean > 0.3 ? '🟡' : '🔴';
    console.log(`   ${indicator} ${name}: ${Math.round(params.mean * 100)}% (n=${params.trials})`);
  }

  // ソース種別の仮説検証状況
  if (state.source_type_scores && Object.keys(state.source_type_scores).length > 0) {
    console.log('\n⚖️ ソース種別 仮説検証（海外 vs 国内）:');
    const sources = Object.entries(state.source_type_scores)
      .sort((a, b) => b[1].mean - a[1].mean);
    for (const [name, params] of sources) {
      const indicator = params.trials >= 5 ? (params.mean > 0.5 ? '🟢' : params.mean > 0.3 ? '🟡' : '🔴') : '⏳';
      const label = name === 'domestic' ? '国内' : name === 'overseas_trend' ? '海外トレンド' : name === 'academic_paper' ? '学術論文' : name;
      console.log(`   ${indicator} ${label}: ${Math.round(params.mean * 100)}% (n=${params.trials}) ${params.trials < 5 ? '← データ不足' : ''}`);
    }
    console.log('   ※ 各5件以上で仮説判定が可能。現時点では探索フェーズ。');
  }

  // 仮説ログのサマリー
  if (fs.existsSync(HYPOTHESIS_LOG)) {
    const log = yaml.load(fs.readFileSync(HYPOTHESIS_LOG, 'utf-8')) as any;
    if (log.accumulated_learnings) {
      console.log('\n📚 蓄積された学び:');
      for (const learning of log.accumulated_learnings) {
        console.log(`   • ${learning}`);
      }
    }
  }

  console.log('\n═══════════════════════════════════════');
}

// ========== CLI ==========

function main() {
  const command = process.argv[2] || 'help';

  switch (command) {
    case 'analyze':
      analyze();
      break;
    case 'verify':
      verify();
      break;
    case 'recommend':
      recommend();
      break;
    case 'report':
      report();
      break;
    case 'all':
      analyze();
      verify();
      recommend();
      report();
      break;
    case 'help':
    default:
      console.log(`
仮説検証 × 学習エンジン

使い方:
  npx ts-node scripts/analyze_hypothesis.ts <command>

コマンド:
  analyze    全投稿にXAS+7軸帰属分析を実行
  verify     pain_hypothesis_log.ymlの仮説を検証し学習を蓄積
  recommend  Thompson Samplingで次回投稿パラメータを推薦
  report     人間向けサマリーレポートを生成
  all        上記すべてを順に実行

学術的根拠:
  - X Algorithm Heavy Ranker (OSS公開)
  - RecSys 2020 Challenge (ACM, NVIDIA優勝)
  - TweetGage GNN (2023, F1=0.89)
  - Kim & Hwang 感情×時間 (2025, R²=0.98)
  - Dynamic Prior Thompson Sampling (2026)
      `);
  }
}

main();
