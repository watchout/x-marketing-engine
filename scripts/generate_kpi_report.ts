/**
 * KPI自動レポート生成スクリプト
 * 
 * 機能:
 * - X APIからフォロワー数、投稿数を取得
 * - 投稿ログから週間の投稿実績を集計
 * - Markdownレポートを生成
 * 
 * 使い方:
 *   npx ts-node scripts/marketing/generate_kpi_report.ts
 * 
 * 環境変数ファイル（優先順位）:
 *   1. .env.api
 *   2. .env.local
 *   3. .env
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
      return;
    }
  }
  console.log('⚠️ No .env file found. Using system environment variables.');
}

// 起動時に環境変数を読み込み
loadEnvFile();

// 型定義
interface XMetrics {
  followers: number;
  following: number;
  tweetCount: number;
}

interface PostedLog {
  id: string;
  content: string;
  scheduledAt: string;
  status: string;
  postedAt?: string;
}

interface WeeklyKPI {
  weekStart: string;
  weekEnd: string;
  x: {
    postsCount: number;
    followers: number;
    followersChange: number;
  };
  articles: {
    published: number;
    titles: string[];
  };
  notes: string[];
}

// ディレクトリ設定
const REPORTS_DIR = path.join(__dirname, '../../docs/reports');
const POSTED_LOG_FILE = path.join(__dirname, '../../content/x_posted_log.json');
const KPI_HISTORY_FILE = path.join(__dirname, '../../content/kpi_history.json');

// X APIからメトリクスを取得
async function getXMetrics(): Promise<XMetrics | null> {
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;

  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    console.log('⚠️ X API credentials not found, using mock data');
    return null;
  }

  try {
    const { TwitterApi } = await import('twitter-api-v2');
    const client = new TwitterApi({
      appKey: apiKey,
      appSecret: apiSecret,
      accessToken: accessToken,
      accessSecret: accessSecret,
    });

    const me = await client.v2.me({
      'user.fields': ['public_metrics'],
    });

    return {
      followers: me.data.public_metrics?.followers_count || 0,
      following: me.data.public_metrics?.following_count || 0,
      tweetCount: me.data.public_metrics?.tweet_count || 0,
    };
  } catch (e) {
    console.error('Failed to get X metrics:', e);
    return null;
  }
}

// 投稿ログを読み込み
function getPostedLogs(): PostedLog[] {
  if (!fs.existsSync(POSTED_LOG_FILE)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(POSTED_LOG_FILE, 'utf-8'));
}

// KPI履歴を読み込み
function getKPIHistory(): { date: string; followers: number }[] {
  if (!fs.existsSync(KPI_HISTORY_FILE)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(KPI_HISTORY_FILE, 'utf-8'));
}

// KPI履歴を保存
function saveKPIHistory(history: { date: string; followers: number }[]): void {
  const dir = path.dirname(KPI_HISTORY_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(KPI_HISTORY_FILE, JSON.stringify(history, null, 2));
}

// 今週の投稿数を集計
function countWeeklyPosts(logs: PostedLog[]): number {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  
  return logs.filter(log => {
    if (!log.postedAt) return false;
    const postedDate = new Date(log.postedAt);
    return postedDate >= weekAgo && postedDate <= now;
  }).length;
}

// 公開された記事を検出
function findPublishedArticles(): { slug: string; title: string }[] {
  const articlesDir = path.join(__dirname, '../../articles');
  if (!fs.existsSync(articlesDir)) {
    return [];
  }
  
  const articles: { slug: string; title: string }[] = [];
  const files = fs.readdirSync(articlesDir).filter(f => f.endsWith('.md'));
  
  for (const file of files) {
    const content = fs.readFileSync(path.join(articlesDir, file), 'utf-8');
    if (content.includes('published: true')) {
      const titleMatch = content.match(/title:\s*"(.+)"/);
      articles.push({
        slug: file.replace('.md', ''),
        title: titleMatch ? titleMatch[1] : file,
      });
    }
  }
  
  return articles;
}

// レポートを生成
async function generateReport(): Promise<string> {
  const now = new Date();
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  
  // データ収集
  const xMetrics = await getXMetrics();
  const postedLogs = getPostedLogs();
  const kpiHistory = getKPIHistory();
  const articles = findPublishedArticles();
  
  // 週間投稿数
  const weeklyPosts = countWeeklyPosts(postedLogs);
  
  // フォロワー変化
  const lastWeekFollowers = kpiHistory.length > 0 
    ? kpiHistory[kpiHistory.length - 1].followers 
    : 0;
  const currentFollowers = xMetrics?.followers || lastWeekFollowers;
  const followersChange = currentFollowers - lastWeekFollowers;
  
  // 履歴に追加
  if (xMetrics) {
    kpiHistory.push({
      date: now.toISOString().split('T')[0],
      followers: xMetrics.followers,
    });
    saveKPIHistory(kpiHistory);
  }
  
  // レポート生成
  const report = `# 週次KPIレポート

**期間**: ${weekStart.toLocaleDateString('ja-JP')} 〜 ${now.toLocaleDateString('ja-JP')}  
**生成日時**: ${now.toLocaleString('ja-JP')}

---

## 📊 サマリー

| 指標 | 今週 | 前週比 | 目標 |
|------|------|--------|------|
| Xフォロワー | ${currentFollowers} | ${followersChange >= 0 ? '+' : ''}${followersChange} | 200 (M1) |
| X投稿数 | ${weeklyPosts} | - | 10-15 |
| 公開記事数 | ${articles.length} | - | 1/週 |

---

## 🐦 X（Twitter）詳細

### メトリクス
${xMetrics ? `
- フォロワー数: **${xMetrics.followers}**
- フォロー数: ${xMetrics.following}
- 総ツイート数: ${xMetrics.tweetCount}
` : `
⚠️ X API未設定のため、メトリクス取得不可
`}

### 今週の投稿実績

${weeklyPosts > 0 ? `
今週は **${weeklyPosts}件** の投稿を実施しました。

${postedLogs
  .filter(log => {
    if (!log.postedAt) return false;
    const postedDate = new Date(log.postedAt);
    return postedDate >= weekStart && postedDate <= now;
  })
  .map(log => `- ${new Date(log.postedAt!).toLocaleDateString('ja-JP')}: ${log.content.substring(0, 40)}...`)
  .join('\n')}
` : `
今週の自動投稿実績はありません。
`}

---

## 📝 記事

### 公開済み記事

${articles.length > 0 ? articles.map(a => `- [${a.title}](https://zenn.dev/iyasaka/articles/${a.slug})`).join('\n') : '公開済み記事なし'}

---

## 📈 トレンド

### フォロワー推移

${kpiHistory.length > 1 ? `
| 日付 | フォロワー | 増減 |
|------|-----------|------|
${kpiHistory.slice(-5).map((h, i, arr) => {
  const prev = i > 0 ? arr[i - 1].followers : h.followers;
  const change = h.followers - prev;
  return `| ${h.date} | ${h.followers} | ${change >= 0 ? '+' : ''}${change} |`;
}).join('\n')}
` : `
データ蓄積中（2週目以降に表示）
`}

---

## ✅ 今週のアクション

- [ ] 来週のコンテンツ準備
- [ ] エンゲージメントの高い投稿パターンを分析
- [ ] 記事のネタ出し

---

## 📌 メモ

（ここに気づきや振り返りを記入）

`;

  return report;
}

// レポートを保存
async function saveReport(): Promise<void> {
  const report = await generateReport();
  
  // ディレクトリ作成
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
  
  // ファイル名
  const now = new Date();
  const filename = `kpi_${now.toISOString().split('T')[0]}.md`;
  const filepath = path.join(REPORTS_DIR, filename);
  
  // 保存
  fs.writeFileSync(filepath, report);
  console.log(`✅ Report saved: ${filepath}`);
  
  // コンソールにも出力
  console.log('\n' + report);
}

// メイン
saveReport().catch(console.error);

