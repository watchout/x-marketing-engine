/**
 * マーケティング自動化ログシステム
 * 
 * 全ての処理フローを記録し、後から分析可能にする
 */

import * as fs from 'fs';
import * as path from 'path';

// ===== 型定義 =====

export interface LogEntry {
  id: string;
  timestamp: string;
  type: 'generation' | 'posting' | 'metrics' | 'analysis' | 'influencer_watch';
  status: 'started' | 'completed' | 'failed';
  duration_ms?: number;
  data: any;
  error?: string;
}

export interface GenerationLog {
  session_id: string;
  started_at: string;
  completed_at?: string;
  rounds: RoundLog[];
  final_result?: {
    content_a: string;
    content_b: string;
    total_score: number;
    scores: any;
  };
  status: 'in_progress' | 'completed' | 'failed';
  error?: string;
}

export interface RoundLog {
  round: number;
  name: string;
  started_at: string;
  completed_at: string;
  llm_calls: LLMCallLog[];
  input: any;
  output: any;
}

export interface LLMCallLog {
  llm: 'gpt' | 'gemini' | 'grok';
  started_at: string;
  completed_at: string;
  duration_ms: number;
  prompt_preview: string;
  response_preview: string;
  tokens_used?: number;
  error?: string;
}

export interface PostingLog {
  post_id: string;
  timestamp: string;
  content: string;
  variant: 'A' | 'B';
  tweet_id?: string;
  status: 'success' | 'failed';
  error?: string;
  generation_session_id?: string;
}

export interface MetricsLog {
  timestamp: string;
  posts_checked: number;
  metrics_collected: {
    post_id: string;
    tweet_id: string;
    impressions: number;
    likes: number;
    retweets: number;
    engagement_rate: number;
  }[];
}

export interface AnalysisLog {
  timestamp: string;
  period: string;
  summary: {
    total_posts: number;
    avg_impressions: number;
    avg_likes: number;
    avg_er: number;
    best_performing: string[];
    worst_performing: string[];
  };
  insights: string[];
  patterns_updated: number;
}

// ===== ログファイルパス =====

const PROJECT_ROOT = path.join(__dirname, '..');
const LOGS_DIR = path.join(PROJECT_ROOT, 'content/logs/marketing');

const LOG_FILES = {
  generation: path.join(LOGS_DIR, 'generation_logs.json'),
  posting: path.join(LOGS_DIR, 'posting_logs.json'),
  metrics: path.join(LOGS_DIR, 'metrics_logs.json'),
  analysis: path.join(LOGS_DIR, 'analysis_logs.json'),
  influencer: path.join(LOGS_DIR, 'influencer_logs.json'),
  daily: (date: string) => path.join(LOGS_DIR, `daily/${date}.json`),
};

// ===== ユーティリティ =====

function ensureLogDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
  const dailyDir = path.join(LOGS_DIR, 'daily');
  if (!fs.existsSync(dailyDir)) {
    fs.mkdirSync(dailyDir, { recursive: true });
  }
}

function loadLogFile<T>(filepath: string): T[] {
  if (!fs.existsSync(filepath)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function saveLogFile<T>(filepath: string, data: T[]): void {
  ensureLogDir();
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

// ===== ロガークラス =====

export class MarketingLogger {
  private sessionId: string;
  private currentLog: GenerationLog | null = null;
  private startTime: number = 0;
  
  constructor() {
    this.sessionId = generateSessionId();
  }
  
  // セッションID取得
  getSessionId(): string {
    return this.sessionId;
  }
  
  // ===== 生成ログ =====
  
  startGeneration(): void {
    this.startTime = Date.now();
    this.currentLog = {
      session_id: this.sessionId,
      started_at: new Date().toISOString(),
      rounds: [],
      status: 'in_progress'
    };
    console.log(`📝 Session started: ${this.sessionId}`);
  }
  
  logRound(round: number, name: string, input: any, output: any, llmCalls: LLMCallLog[]): void {
    if (!this.currentLog) return;
    
    this.currentLog.rounds.push({
      round,
      name,
      started_at: llmCalls[0]?.started_at || new Date().toISOString(),
      completed_at: llmCalls[llmCalls.length - 1]?.completed_at || new Date().toISOString(),
      llm_calls: llmCalls,
      input,
      output
    });
  }
  
  completeGeneration(contentA: string, contentB: string, scores: any): void {
    if (!this.currentLog) return;
    
    this.currentLog.completed_at = new Date().toISOString();
    this.currentLog.status = 'completed';
    this.currentLog.final_result = {
      content_a: contentA,
      content_b: contentB,
      total_score: scores.total,
      scores
    };
    
    // ファイルに保存
    const logs = loadLogFile<GenerationLog>(LOG_FILES.generation);
    logs.unshift(this.currentLog);
    // 最大100件保持
    saveLogFile(LOG_FILES.generation, logs.slice(0, 100));
    
    // 日次ログにも追加
    this.appendToDailyLog('generation', this.currentLog);
    
    const duration = Date.now() - this.startTime;
    console.log(`✅ Generation logged (${duration}ms): ${this.sessionId}`);
  }
  
  failGeneration(error: string): void {
    if (!this.currentLog) return;
    
    this.currentLog.completed_at = new Date().toISOString();
    this.currentLog.status = 'failed';
    this.currentLog.error = error;
    
    const logs = loadLogFile<GenerationLog>(LOG_FILES.generation);
    logs.unshift(this.currentLog);
    saveLogFile(LOG_FILES.generation, logs.slice(0, 100));
    
    this.appendToDailyLog('generation_failed', this.currentLog);
  }
  
  // ===== 投稿ログ =====
  
  logPosting(log: PostingLog): void {
    const logs = loadLogFile<PostingLog>(LOG_FILES.posting);
    logs.unshift(log);
    saveLogFile(LOG_FILES.posting, logs.slice(0, 500));
    
    this.appendToDailyLog('posting', log);
    console.log(`📤 Posting logged: ${log.post_id}`);
  }
  
  // ===== メトリクスログ =====
  
  logMetrics(log: MetricsLog): void {
    const logs = loadLogFile<MetricsLog>(LOG_FILES.metrics);
    logs.unshift(log);
    saveLogFile(LOG_FILES.metrics, logs.slice(0, 100));
    
    this.appendToDailyLog('metrics', log);
    console.log(`📊 Metrics logged: ${log.posts_checked} posts`);
  }
  
  // ===== 分析ログ =====
  
  logAnalysis(log: AnalysisLog): void {
    const logs = loadLogFile<AnalysisLog>(LOG_FILES.analysis);
    logs.unshift(log);
    saveLogFile(LOG_FILES.analysis, logs.slice(0, 100));
    
    this.appendToDailyLog('analysis', log);
    console.log(`🔍 Analysis logged: ${log.insights.length} insights`);
  }
  
  // ===== インフルエンサー監視ログ =====
  
  logInfluencerWatch(data: any): void {
    const logs = loadLogFile<any>(LOG_FILES.influencer);
    logs.unshift({
      timestamp: new Date().toISOString(),
      ...data
    });
    saveLogFile(LOG_FILES.influencer, logs.slice(0, 100));
    
    this.appendToDailyLog('influencer_watch', data);
  }
  
  // ===== 日次ログ =====
  
  private appendToDailyLog(type: string, data: any): void {
    const today = new Date().toISOString().split('T')[0];
    const filepath = LOG_FILES.daily(today);
    
    let dailyLog: any = { date: today, events: [] };
    if (fs.existsSync(filepath)) {
      try {
        dailyLog = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
      } catch (e) {
        // 無視
      }
    }
    
    dailyLog.events.push({
      timestamp: new Date().toISOString(),
      type,
      data
    });
    
    ensureLogDir();
    fs.writeFileSync(filepath, JSON.stringify(dailyLog, null, 2));
  }
  
  // ===== ログ取得 =====
  
  static getGenerationLogs(limit: number = 10): GenerationLog[] {
    return loadLogFile<GenerationLog>(LOG_FILES.generation).slice(0, limit);
  }
  
  static getPostingLogs(limit: number = 20): PostingLog[] {
    return loadLogFile<PostingLog>(LOG_FILES.posting).slice(0, limit);
  }
  
  static getMetricsLogs(limit: number = 10): MetricsLog[] {
    return loadLogFile<MetricsLog>(LOG_FILES.metrics).slice(0, limit);
  }
  
  static getAnalysisLogs(limit: number = 10): AnalysisLog[] {
    return loadLogFile<AnalysisLog>(LOG_FILES.analysis).slice(0, limit);
  }
  
  static getDailyLog(date: string): any {
    const filepath = LOG_FILES.daily(date);
    if (!fs.existsSync(filepath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  }
  
  // ===== サマリー出力 =====
  
  static printSummary(days: number = 7): void {
    console.log('\n📊 Marketing Automation Summary\n');
    console.log('='.repeat(50));
    
    const generationLogs = this.getGenerationLogs(50);
    const postingLogs = this.getPostingLogs(50);
    const metricsLogs = this.getMetricsLogs(10);
    
    // 期間フィルタ
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString();
    
    const recentGenerations = generationLogs.filter(g => g.started_at >= cutoffStr);
    const recentPostings = postingLogs.filter(p => p.timestamp >= cutoffStr);
    
    console.log(`\n📝 過去${days}日間の生成:`);
    console.log(`   総生成回数: ${recentGenerations.length}`);
    console.log(`   成功: ${recentGenerations.filter(g => g.status === 'completed').length}`);
    console.log(`   失敗: ${recentGenerations.filter(g => g.status === 'failed').length}`);
    
    const avgScore = recentGenerations
      .filter(g => g.final_result)
      .reduce((sum, g) => sum + (g.final_result?.total_score || 0), 0) / 
      (recentGenerations.filter(g => g.final_result).length || 1);
    console.log(`   平均スコア: ${avgScore.toFixed(1)}点`);
    
    console.log(`\n📤 過去${days}日間の投稿:`);
    console.log(`   総投稿数: ${recentPostings.length}`);
    console.log(`   成功: ${recentPostings.filter(p => p.status === 'success').length}`);
    console.log(`   失敗: ${recentPostings.filter(p => p.status === 'failed').length}`);
    
    if (metricsLogs.length > 0) {
      const latestMetrics = metricsLogs[0];
      console.log(`\n📈 最新メトリクス (${latestMetrics.timestamp.split('T')[0]}):`);
      console.log(`   収集対象: ${latestMetrics.posts_checked}件`);
      
      if (latestMetrics.metrics_collected.length > 0) {
        const avgImp = latestMetrics.metrics_collected.reduce((s, m) => s + m.impressions, 0) / latestMetrics.metrics_collected.length;
        const avgLikes = latestMetrics.metrics_collected.reduce((s, m) => s + m.likes, 0) / latestMetrics.metrics_collected.length;
        console.log(`   平均インプ: ${avgImp.toFixed(0)}`);
        console.log(`   平均いいね: ${avgLikes.toFixed(1)}`);
      }
    }
    
    console.log('\n' + '='.repeat(50));
  }
}

// ===== LLM呼び出しラッパー =====

export function createLLMCallLog(
  llm: 'gpt' | 'gemini' | 'grok',
  startTime: number,
  prompt: string,
  response: string,
  error?: string
): LLMCallLog {
  return {
    llm,
    started_at: new Date(startTime).toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    prompt_preview: prompt.substring(0, 200) + '...',
    response_preview: response.substring(0, 200) + '...',
    error
  };
}

// ===== CLI =====

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'summary':
      const days = parseInt(args[1]) || 7;
      MarketingLogger.printSummary(days);
      break;
      
    case 'daily':
      const date = args[1] || new Date().toISOString().split('T')[0];
      const dailyLog = MarketingLogger.getDailyLog(date);
      if (dailyLog) {
        console.log(JSON.stringify(dailyLog, null, 2));
      } else {
        console.log(`No logs for ${date}`);
      }
      break;
      
    case 'generations':
      const genLogs = MarketingLogger.getGenerationLogs(parseInt(args[1]) || 5);
      for (const log of genLogs) {
        console.log(`\n[${log.started_at}] ${log.session_id}`);
        console.log(`  Status: ${log.status}`);
        console.log(`  Rounds: ${log.rounds.length}`);
        if (log.final_result) {
          console.log(`  Score: ${log.final_result.total_score}`);
          console.log(`  Content: ${log.final_result.content_a.substring(0, 50)}...`);
        }
      }
      break;
      
    default:
      console.log(`
マーケティングログシステム

使い方:
  npx ts-node scripts/marketing/logger.ts <command>

コマンド:
  summary [days]      過去N日間のサマリーを表示（デフォルト7日）
  daily [date]        指定日の詳細ログを表示
  generations [n]     直近N件の生成ログを表示

例:
  npx ts-node scripts/marketing/logger.ts summary 14
  npx ts-node scripts/marketing/logger.ts daily 2026-01-20
  npx ts-node scripts/marketing/logger.ts generations 10
      `);
  }
}
