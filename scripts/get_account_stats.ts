/**
 * アカウント統計取得スクリプト
 * フォロワー数などの基本情報を取得
 */

import * as fs from 'fs';
import * as path from 'path';

// 環境変数読み込み
function loadEnvFile(): void {
  const envPath = path.join(__dirname, '../.env.api');
  if (fs.existsSync(envPath)) {
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
  }
}

loadEnvFile();

const OUTPUT_FILE = path.join(__dirname, '../content/account_stats.json');

interface AccountStats {
  followers_count: number;
  following_count: number;
  tweet_count: number;
  listed_count: number;
  username: string;
  name: string;
  description: string;
  updated_at: string;
}

async function getAccountStats(): Promise<AccountStats | null> {
  const { TwitterApi } = await import('twitter-api-v2');
  
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY!,
    appSecret: process.env.X_API_SECRET!,
    accessToken: process.env.X_ACCESS_TOKEN!,
    accessSecret: process.env.X_ACCESS_SECRET!,
  });

  try {
    const me = await client.v2.me({
      'user.fields': ['public_metrics', 'description', 'name', 'username']
    });

    if (!me.data) {
      console.error('Failed to get account info');
      return null;
    }

    const metrics = me.data.public_metrics || {};
    
    return {
      followers_count: metrics.followers_count || 0,
      following_count: metrics.following_count || 0,
      tweet_count: metrics.tweet_count || 0,
      listed_count: metrics.listed_count || 0,
      username: me.data.username || '',
      name: me.data.name || '',
      description: me.data.description || '',
      updated_at: new Date().toISOString()
    };
  } catch (e) {
    console.error('Error getting account stats:', e);
    return null;
  }
}

async function main() {
  console.log('📊 アカウント統計を取得中...\n');
  
  const stats = await getAccountStats();
  
  if (stats) {
    console.log(`👤 @${stats.username} (${stats.name})`);
    console.log(`📝 ${stats.description.substring(0, 50)}...`);
    console.log('');
    console.log(`👥 フォロワー: ${stats.followers_count.toLocaleString()}`);
    console.log(`👤 フォロー中: ${stats.following_count.toLocaleString()}`);
    console.log(`📝 ツイート数: ${stats.tweet_count.toLocaleString()}`);
    console.log(`📋 リスト: ${stats.listed_count.toLocaleString()}`);
    
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(stats, null, 2));
    console.log(`\n✅ 保存先: ${OUTPUT_FILE}`);
  } else {
    console.log('❌ 統計の取得に失敗しました');
  }
}

main().catch(console.error);
