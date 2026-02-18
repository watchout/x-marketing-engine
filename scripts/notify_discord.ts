/**
 * Discord通知スクリプト
 *
 * テーマ候補の通知、承認リクエスト、日次レポートをDiscordに送信する
 *
 * 使い方:
 *   npx ts-node scripts/notify_discord.ts theme-candidates  # テーマ候補を通知
 *   npx ts-node scripts/notify_discord.ts daily-report       # 日次レポート
 *   npx ts-node scripts/notify_discord.ts weekly-review      # 週次振り返り
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://x-marketing-engine.vercel.app';

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  footer?: {
    text: string;
  };
  timestamp?: string;
}

async function sendDiscordMessage(content: string, embeds: DiscordEmbed[] = []) {
  if (!DISCORD_WEBHOOK_URL) {
    console.error('❌ DISCORD_WEBHOOK_URL が設定されていません');
    process.exit(1);
  }

  const body = JSON.stringify({
    content,
    embeds,
  });

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!response.ok) {
    console.error(`❌ Discord送信失敗: ${response.status} ${response.statusText}`);
    process.exit(1);
  }

  console.log('✅ Discord通知を送信しました');
}

// ===== テーマ候補通知 =====
async function notifyThemeCandidates() {
  // overseas_insights.json からトレンドを取得
  let trends: string[] = [];
  try {
    const insightsPath = path.join(process.cwd(), 'content/overseas_insights.json');
    const insights = JSON.parse(fs.readFileSync(insightsPath, 'utf-8'));
    if (insights.keywords_monitored) {
      trends = insights.keywords_monitored.slice(0, 5);
    }
  } catch (e) {
    trends = ['(トレンド情報取得失敗)'];
  }

  // pain_hypothesis_log.yml から蓄積された学びを取得
  let learnings: string[] = [];
  try {
    const logPath = path.join(process.cwd(), 'content/pain_hypothesis_log.yml');
    const log = yaml.load(fs.readFileSync(logPath, 'utf-8')) as any;
    learnings = (log.accumulated_learnings || []).slice(0, 3);
  } catch (e) {
    learnings = ['(学びデータ取得失敗)'];
  }

  // 投稿プールの残数を確認
  let poolCount = 0;
  try {
    const poolPath = path.join(process.cwd(), 'content/ab_test_pool.yml');
    const poolContent = fs.readFileSync(poolPath, 'utf-8');
    poolCount = (poolContent.match(/status: active/g) || []).length;
  } catch (e) {
    poolCount = 0;
  }

  // 直近の投稿テーマを確認（重複回避）
  let recentThemes: string[] = [];
  try {
    const historyPath = path.join(process.cwd(), 'content/post_history.json');
    const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    const themes = history.slice(0, 20).map((p: any) => p.theme).filter(Boolean);
    recentThemes = [...new Set(themes)] as string[];
  } catch (e) {
    recentThemes = [];
  }

  const embed: DiscordEmbed = {
    title: '📋 週次テーマ決定が必要です',
    description: [
      '新しい週のテーマを決定してください。',
      '',
      '**以下の情報を参考に、テーマを返信してください：**',
      '- テーマ名',
      '- 刺すペイン（ターゲットのどの痛みに触れるか）',
      '- アプローチ（解決/共感/発見/警告/実績）',
      '- ai-dev-frameworkとの関連（あれば）',
      '',
      `🔗 [ダッシュボードで詳細確認](${DASHBOARD_URL})`,
    ].join('\n'),
    color: 0x58a6ff, // blue
    fields: [
      {
        name: '📊 投稿プール残数',
        value: `${poolCount} 件`,
        inline: true,
      },
      {
        name: '🌍 海外トレンド',
        value: trends.map(t => `• ${t}`).join('\n') || 'なし',
        inline: false,
      },
      {
        name: '⚠️ 直近のテーマ（重複回避）',
        value: recentThemes.map(t => `• ${t}`).join('\n') || 'なし',
        inline: false,
      },
      {
        name: '💡 過去の学び',
        value: learnings.map(l => `• ${l}`).join('\n') || 'なし',
        inline: false,
      },
    ],
    footer: {
      text: 'X Marketing Engine - C0テーマ決定',
    },
    timestamp: new Date().toISOString(),
  };

  await sendDiscordMessage('', [embed]);
}

// ===== 日次レポート通知 =====
async function notifyDailyReport() {
  // 本日の投稿を取得
  const today = new Date().toISOString().split('T')[0];
  let todayPosts: any[] = [];
  try {
    const historyPath = path.join(process.cwd(), 'content/post_history.json');
    const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    todayPosts = history.filter((p: any) => p.posted_at && p.posted_at.startsWith(today));
  } catch (e) {
    todayPosts = [];
  }

  // アカウント情報
  let stats: any = {};
  try {
    const statsPath = path.join(process.cwd(), 'content/account_stats.json');
    stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
  } catch (e) {
    stats = { followers_count: '?', tweet_count: '?' };
  }

  // 投稿プール残数
  let poolCount = 0;
  try {
    const poolPath = path.join(process.cwd(), 'content/ab_test_pool.yml');
    const poolContent = fs.readFileSync(poolPath, 'utf-8');
    poolCount = (poolContent.match(/status: active/g) || []).length;
  } catch (e) {
    poolCount = 0;
  }

  const postsPreview = todayPosts.length > 0
    ? todayPosts.map((p, i) => `${i + 1}. [${p.slot}] ${p.content?.substring(0, 50)}...`).join('\n')
    : '本日の投稿はありません';

  const color = poolCount < 3 ? 0xf85149 : poolCount < 6 ? 0xd29922 : 0x3fb950;

  const embed: DiscordEmbed = {
    title: `📈 日次レポート (${today})`,
    description: `🔗 [ダッシュボード](${DASHBOARD_URL})`,
    color,
    fields: [
      {
        name: '👥 フォロワー',
        value: `${stats.followers_count || '?'}`,
        inline: true,
      },
      {
        name: '📝 総ツイート',
        value: `${stats.tweet_count || '?'}`,
        inline: true,
      },
      {
        name: '📦 プール残数',
        value: `${poolCount} 件 ${poolCount < 3 ? '⚠️ 補充が必要！' : ''}`,
        inline: true,
      },
      {
        name: '🐦 本日の投稿',
        value: postsPreview,
        inline: false,
      },
    ],
    footer: {
      text: 'X Marketing Engine',
    },
    timestamp: new Date().toISOString(),
  };

  await sendDiscordMessage('', [embed]);
}

// ===== 週次振り返り通知 =====
async function notifyWeeklyReview() {
  // 直近7日の投稿を集計
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  let weekPosts: any[] = [];
  try {
    const historyPath = path.join(process.cwd(), 'content/post_history.json');
    const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    weekPosts = history.filter((p: any) => {
      const d = new Date(p.posted_at);
      return d >= weekAgo && d <= now;
    });
  } catch (e) {
    weekPosts = [];
  }

  const withMetrics = weekPosts.filter(p => p.metrics);
  const totalImp = withMetrics.reduce((sum, p) => sum + (p.metrics?.impressions || 0), 0);
  const totalLikes = withMetrics.reduce((sum, p) => sum + (p.metrics?.likes || 0), 0);
  const avgER = withMetrics.length > 0
    ? (withMetrics.reduce((sum, p) => {
        const imp = p.metrics?.impressions || 0;
        const likes = p.metrics?.likes || 0;
        return sum + (imp > 0 ? likes / imp : 0);
      }, 0) / withMetrics.length * 100).toFixed(2)
    : 'N/A';

  const embed: DiscordEmbed = {
    title: '📊 週次振り返りレポート',
    description: [
      `期間: ${weekAgo.toISOString().split('T')[0]} 〜 ${now.toISOString().split('T')[0]}`,
      '',
      `🔗 [ダッシュボードで詳細確認](${DASHBOARD_URL})`,
      '',
      '**pain_hypothesis_log.yml の更新をお願いします：**',
      '- 今週のペイン仮説は正しかったか？',
      '- アプローチは最適だったか？',
      '- 次週に向けた学びは？',
    ].join('\n'),
    color: 0xa371f7, // purple
    fields: [
      {
        name: '📝 投稿数',
        value: `${weekPosts.length} 件`,
        inline: true,
      },
      {
        name: '👀 総インプレッション',
        value: `${totalImp}`,
        inline: true,
      },
      {
        name: '❤️ 総いいね',
        value: `${totalLikes}`,
        inline: true,
      },
      {
        name: '📊 平均ER',
        value: `${avgER}%`,
        inline: true,
      },
      {
        name: '📈 メトリクスあり',
        value: `${withMetrics.length} / ${weekPosts.length} 件`,
        inline: true,
      },
    ],
    footer: {
      text: 'X Marketing Engine - 週次レビュー',
    },
    timestamp: new Date().toISOString(),
  };

  await sendDiscordMessage('', [embed]);
}

// ===== メイン =====
async function main() {
  const action = process.argv[2];

  switch (action) {
    case 'theme-candidates':
      await notifyThemeCandidates();
      break;
    case 'daily-report':
      await notifyDailyReport();
      break;
    case 'weekly-review':
      await notifyWeeklyReview();
      break;
    default:
      console.log('使い方:');
      console.log('  npx ts-node scripts/notify_discord.ts theme-candidates');
      console.log('  npx ts-node scripts/notify_discord.ts daily-report');
      console.log('  npx ts-node scripts/notify_discord.ts weekly-review');
      process.exit(1);
  }
}

main().catch(console.error);
