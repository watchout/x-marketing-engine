/**
 * X API 接続テスト
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

async function testConnection() {
  console.log('\n🔌 Testing X API connection...\n');
  
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;
  
  console.log('Environment variables:');
  console.log(`  X_API_KEY: ${apiKey ? '✅ Set (' + apiKey.substring(0, 8) + '...)' : '❌ Missing'}`);
  console.log(`  X_API_SECRET: ${apiSecret ? '✅ Set' : '❌ Missing'}`);
  console.log(`  X_ACCESS_TOKEN: ${accessToken ? '✅ Set' : '❌ Missing'}`);
  console.log(`  X_ACCESS_SECRET: ${accessSecret ? '✅ Set' : '❌ Missing'}`);
  
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    console.log('\n❌ Missing required environment variables');
    return;
  }
  
  try {
    const { TwitterApi } = await import('twitter-api-v2');
    const client = new TwitterApi({
      appKey: apiKey,
      appSecret: apiSecret,
      accessToken: accessToken,
      accessSecret: accessSecret,
    });
    
    console.log('\n📡 Fetching account info...');
    const me = await client.v2.me({
      'user.fields': ['public_metrics', 'description'],
    });
    
    console.log('\n✅ Connection successful!\n');
    console.log('Account Info:');
    console.log(`  Username: @${me.data.username}`);
    console.log(`  Name: ${me.data.name}`);
    console.log(`  Followers: ${me.data.public_metrics?.followers_count || 0}`);
    console.log(`  Following: ${me.data.public_metrics?.following_count || 0}`);
    console.log(`  Tweets: ${me.data.public_metrics?.tweet_count || 0}`);
    
    console.log('\n🎉 X API is ready to use!');
    
  } catch (e: any) {
    console.log('\n❌ Connection failed!');
    console.log(`Error: ${e.message}`);
    
    if (e.code === 401) {
      console.log('\n💡 Hint: Check if your API keys are correct and have Read/Write permissions.');
    } else if (e.code === 403) {
      console.log('\n💡 Hint: Your app may not have the required permissions. Check Developer Portal settings.');
    }
  }
}

testConnection();

