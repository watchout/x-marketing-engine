/**
 * X投稿パフォーマンス分析エンジン
 * 
 * 機能:
 *   - 型別パフォーマンス分析
 *   - 勝ちパターン抽出
 *   - KPI達成率計算
 *   - アラート判定
 * 
 * 使い方:
 *   npx ts-node scripts/marketing/analyze_performance.ts analyze
 *   npx ts-node scripts/marketing/analyze_performance.ts update-winning
 *   npx ts-node scripts/marketing/analyze_performance.ts kpi-check
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

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
  type?: string;  // 投稿型
  metrics?: PostMetrics;
}

interface TypePerformance {
  total_posts: number;
  avg_impressions: number;
  avg_engagement_rate: number;
  avg_likes: number;
  avg_retweets: number;
  best_post_id: string | null;
}

interface WinningPattern {
  id: string;
  type: string;
  theme: string;
  content: string;
  metrics: PostMetrics;
  posted_at: string;
  variant: string;
}

interface KPITargets {
  daily_targets: {
    impressions: number;
    likes: number;
    retweets: number;
    posts: number;
  };
  weekly_targets: {
    impressions: number;
    likes: number;
    retweets: number;
    new_followers: number;
  };
  alert_thresholds: {
    warning: number;
    critical: number;
  };
}

// ファイルパス
const HISTORY_FILE = path.join(__dirname, '../content/post_history.json');
const WINNING_PATTERNS_FILE = path.join(__dirname, '../content/winning_patterns.yml');
const KPI_FILE = path.join(__dirname, '../config/marketing_kpi.yml');
const CONTENT_STRATEGY_FILE = path.join(__dirname, '../config/x_content_strategy.yml');

// 履歴を読み込み
function loadHistory(): PostHistory[] {
  // 複数の場所を探す
  const paths = [
    HISTORY_FILE,
    path.join(__dirname, '../content/post_history.json'),
  ];
  
  for (const p of paths) {
    if (fs.existsSync(p)) {
      console.log(`📁 Loading history from: ${p}`);
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  }
  
  console.log('⚠️ No history file found');
  return [];
}

// YAMLファイルを読み込み
function loadYaml<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    console.log(`⚠️ File not found: ${filePath}`);
    return null;
  }
  return yaml.load(fs.readFileSync(filePath, 'utf-8')) as T;
}

// YAMLファイルを保存
function saveYaml(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, yaml.dump(data, { lineWidth: -1, quotingType: '"' }));
  console.log(`✅ Saved: ${filePath}`);
}

// エンゲージメント率を計算
function calculateEngagementRate(metrics: PostMetrics): number {
  if (metrics.impressions === 0) return 0;
  return (metrics.likes + metrics.retweets) / metrics.impressions;
}

// 型別パフォーマンス分析
function analyzeTypePerformance(history: PostHistory[]): Record<string, TypePerformance> {
  const types = [
    'problem_statement', 'before_after', 'discovery', 'tips',
    'story', 'comparison', 'trend', 'thread', 'unknown'
  ];
  
  const result: Record<string, TypePerformance> = {};
  
  for (const type of types) {
    const posts = history.filter(h => (h.type || 'unknown') === type && h.metrics);
    
    if (posts.length === 0) {
      result[type] = {
        total_posts: 0,
        avg_impressions: 0,
        avg_engagement_rate: 0,
        avg_likes: 0,
        avg_retweets: 0,
        best_post_id: null,
      };
      continue;
    }
    
    const totalImpressions = posts.reduce((sum, p) => sum + (p.metrics?.impressions || 0), 0);
    const totalLikes = posts.reduce((sum, p) => sum + (p.metrics?.likes || 0), 0);
    const totalRetweets = posts.reduce((sum, p) => sum + (p.metrics?.retweets || 0), 0);
    const avgEngagement = posts.reduce((sum, p) => 
      sum + calculateEngagementRate(p.metrics!), 0) / posts.length;
    
    // ベスト投稿を特定
    const bestPost = posts.reduce((best, current) => {
      const currentScore = (current.metrics?.likes || 0) + (current.metrics?.retweets || 0) * 2;
      const bestScore = (best.metrics?.likes || 0) + (best.metrics?.retweets || 0) * 2;
      return currentScore > bestScore ? current : best;
    });
    
    result[type] = {
      total_posts: posts.length,
      avg_impressions: Math.round(totalImpressions / posts.length),
      avg_engagement_rate: Math.round(avgEngagement * 10000) / 10000,
      avg_likes: Math.round(totalLikes / posts.length * 10) / 10,
      avg_retweets: Math.round(totalRetweets / posts.length * 10) / 10,
      best_post_id: bestPost.id,
    };
  }
  
  return result;
}

// 勝ちパターンを抽出
function extractWinningPatterns(history: PostHistory[]): WinningPattern[] {
  const MIN_IMPRESSIONS = 1000;
  const MIN_ENGAGEMENT_RATE = 0.03;
  
  const postsWithMetrics = history.filter(h => h.metrics);
  
  return postsWithMetrics
    .filter(p => {
      const er = calculateEngagementRate(p.metrics!);
      return p.metrics!.impressions >= MIN_IMPRESSIONS || er >= MIN_ENGAGEMENT_RATE;
    })
    .map(p => ({
      id: p.id,
      type: p.type || 'unknown',
      theme: p.theme,
      content: p.content,
      metrics: p.metrics!,
      posted_at: p.posted_at,
      variant: p.variant,
    }))
    .sort((a, b) => calculateEngagementRate(b.metrics) - calculateEngagementRate(a.metrics));
}

// KPI達成率を計算
function calculateKPIAchievement(history: PostHistory[]): {
  daily: Record<string, number>;
  weekly: Record<string, number>;
  alerts: string[];
} {
  const kpiData = loadYaml<{ daily_targets: Record<string, number>; weekly_targets: Record<string, number>; alert_thresholds: { warning: number; critical: number } }>(KPI_FILE);
  
  if (!kpiData) {
    return { daily: {}, weekly: {}, alerts: ['KPIファイルが見つかりません'] };
  }
  
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  
  // 日次実績
  const todayPosts = history.filter(h => h.posted_at.startsWith(today) && h.metrics);
  const dailyImpressions = todayPosts.reduce((sum, p) => sum + (p.metrics?.impressions || 0), 0);
  const dailyLikes = todayPosts.reduce((sum, p) => sum + (p.metrics?.likes || 0), 0);
  
  // 週次実績
  const weekPosts = history.filter(h => h.posted_at >= weekAgo && h.metrics);
  const weeklyImpressions = weekPosts.reduce((sum, p) => sum + (p.metrics?.impressions || 0), 0);
  const weeklyLikes = weekPosts.reduce((sum, p) => sum + (p.metrics?.likes || 0), 0);
  
  const dailyTargets = kpiData.daily_targets || { impressions: 7000, likes: 70, posts: 3 };
  const weeklyTargets = kpiData.weekly_targets || { impressions: 50000, likes: 500 };
  const thresholds = kpiData.alert_thresholds || { warning: 0.7, critical: 0.5 };
  
  const daily: Record<string, number> = {
    impressions: dailyImpressions / dailyTargets.impressions,
    likes: dailyLikes / dailyTargets.likes,
    posts: todayPosts.length / dailyTargets.posts,
  };
  
  const weekly: Record<string, number> = {
    impressions: weeklyImpressions / weeklyTargets.impressions,
    likes: weeklyLikes / weeklyTargets.likes,
  };
  
  // アラート判定
  const alerts: string[] = [];
  
  for (const [metric, achievement] of Object.entries(weekly)) {
    if (achievement < thresholds.critical) {
      alerts.push(`🚨 CRITICAL: 週次${metric}が目標の${Math.round(achievement * 100)}%（50%未満）`);
    } else if (achievement < thresholds.warning) {
      alerts.push(`⚠️ WARNING: 週次${metric}が目標の${Math.round(achievement * 100)}%（70%未満）`);
    }
  }
  
  return { daily, weekly, alerts };
}

// 分析レポートを表示
function showAnalysisReport(): void {
  console.log('\n📊 X投稿パフォーマンス分析レポート');
  console.log('='.repeat(60));
  
  const history = loadHistory();
  
  if (history.length === 0) {
    console.log('⚠️ 投稿履歴がありません');
    return;
  }
  
  console.log(`\n📝 総投稿数: ${history.length}`);
  console.log(`📈 メトリクス取得済み: ${history.filter(h => h.metrics).length}`);
  
  // 型別パフォーマンス
  console.log('\n📊 型別パフォーマンス');
  console.log('-'.repeat(60));
  
  const typePerf = analyzeTypePerformance(history);
  
  for (const [type, perf] of Object.entries(typePerf)) {
    if (perf.total_posts === 0) continue;
    
    console.log(`\n【${type}】`);
    console.log(`  投稿数: ${perf.total_posts}`);
    console.log(`  平均Imp: ${perf.avg_impressions.toLocaleString()}`);
    console.log(`  平均Like: ${perf.avg_likes}`);
    console.log(`  平均RT: ${perf.avg_retweets}`);
    console.log(`  平均ER: ${(perf.avg_engagement_rate * 100).toFixed(2)}%`);
  }
  
  // KPI達成率
  console.log('\n📈 KPI達成率');
  console.log('-'.repeat(60));
  
  const kpi = calculateKPIAchievement(history);
  
  console.log('\n【日次】');
  for (const [metric, rate] of Object.entries(kpi.daily)) {
    const status = rate >= 1 ? '✅' : rate >= 0.7 ? '⚠️' : '🚨';
    console.log(`  ${status} ${metric}: ${Math.round(rate * 100)}%`);
  }
  
  console.log('\n【週次】');
  for (const [metric, rate] of Object.entries(kpi.weekly)) {
    const status = rate >= 1 ? '✅' : rate >= 0.7 ? '⚠️' : '🚨';
    console.log(`  ${status} ${metric}: ${Math.round(rate * 100)}%`);
  }
  
  // アラート
  if (kpi.alerts.length > 0) {
    console.log('\n🚨 アラート');
    console.log('-'.repeat(60));
    for (const alert of kpi.alerts) {
      console.log(alert);
    }
  }
}

// 勝ちパターンDBを更新
function updateWinningPatterns(): void {
  console.log('\n🏆 勝ちパターンDB更新');
  console.log('='.repeat(60));
  
  const history = loadHistory();
  const winningPatterns = extractWinningPatterns(history);
  const typePerf = analyzeTypePerformance(history);
  
  // 既存のYAMLを読み込み
  let existingData = loadYaml<Record<string, unknown>>(WINNING_PATTERNS_FILE) || {};
  
  // 更新
  existingData = {
    ...existingData,
    version: '1.0',
    last_updated: new Date().toISOString(),
    auto_updated: true,
    type_performance: typePerf,
    winning_patterns: winningPatterns,
    update_log: [
      ...(existingData.update_log as unknown[] || []),
      {
        timestamp: new Date().toISOString(),
        action: 'auto_update',
        patterns_count: winningPatterns.length,
      },
    ].slice(-100), // 最新100件のみ保持
  };
  
  saveYaml(WINNING_PATTERNS_FILE, existingData);
  
  console.log(`\n✅ ${winningPatterns.length}件の勝ちパターンを更新しました`);
  
  // トップ3を表示
  if (winningPatterns.length > 0) {
    console.log('\n🌟 トップ3投稿:');
    for (const pattern of winningPatterns.slice(0, 3)) {
      const er = calculateEngagementRate(pattern.metrics);
      console.log(`  ❤️ ${pattern.metrics.likes} | 👁️ ${pattern.metrics.impressions} | ER ${(er * 100).toFixed(2)}%`);
      console.log(`     ${pattern.content.substring(0, 50)}...`);
    }
  }
}

// KPIチェックとアラート
function checkKPI(): void {
  console.log('\n📊 KPIチェック');
  console.log('='.repeat(60));
  
  const history = loadHistory();
  const kpi = calculateKPIAchievement(history);
  
  // 結果表示
  console.log('\n【週次KPI達成率】');
  for (const [metric, rate] of Object.entries(kpi.weekly)) {
    const bar = '█'.repeat(Math.min(10, Math.round(rate * 10))) + '░'.repeat(Math.max(0, 10 - Math.round(rate * 10)));
    console.log(`  ${metric}: [${bar}] ${Math.round(rate * 100)}%`);
  }
  
  // アラート
  if (kpi.alerts.length > 0) {
    console.log('\n🚨 要対応:');
    for (const alert of kpi.alerts) {
      console.log(`  ${alert}`);
    }
    
    // 対策提案
    console.log('\n💡 推奨アクション:');
    if (kpi.weekly.impressions < 0.7) {
      console.log('  - 投稿頻度を1.5倍に増加');
      console.log('  - バズ狙い型（問題提起型）の投稿比率を上げる');
      console.log('  - トレンド便乗型を追加');
    }
    if (kpi.weekly.likes < 0.7) {
      console.log('  - Tips型・発見共有型の投稿を増やす');
      console.log('  - 過去の高Like投稿をリライトして再投稿');
    }
  } else {
    console.log('\n✅ KPIは順調です');
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'analyze':
      showAnalysisReport();
      break;

    case 'update-winning':
      updateWinningPatterns();
      break;

    case 'kpi-check':
      checkKPI();
      break;

    case 'all':
      showAnalysisReport();
      updateWinningPatterns();
      checkKPI();
      break;

    case 'help':
    default:
      console.log(`
X投稿パフォーマンス分析エンジン

使い方:
  npx ts-node scripts/marketing/analyze_performance.ts <command>

コマンド:
  analyze         型別パフォーマンス分析
  update-winning  勝ちパターンDB更新
  kpi-check       KPI達成率チェック
  all             全分析を実行

例:
  npx ts-node scripts/marketing/analyze_performance.ts analyze
  npx ts-node scripts/marketing/analyze_performance.ts all
      `);
  }
}

main().catch(console.error);
