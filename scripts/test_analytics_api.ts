import * as fs from 'fs';
import * as path from 'path';

// 環境変数読み込み
const envPath = path.join(__dirname, '..', '.env.api');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex !== -1) {
        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
      }
    }
  }
}

async function main() {
  const { TwitterApi } = await import('twitter-api-v2');
  
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY!,
    appSecret: process.env.X_API_SECRET!,
    accessToken: process.env.X_ACCESS_TOKEN!,
    accessSecret: process.env.X_ACCESS_SECRET!,
  });

  try {
    // Analytics endpoint test
    const result = await client.v2.get('tweets/analytics', {
      ids: '2015192230571712983',
      start_time: '2026-01-20T00:00:00Z',
      end_time: '2026-01-26T00:00:00Z',
      granularity: 'total'
    });
    console.log('Success:', JSON.stringify(result, null, 2));
  } catch (error: any) {
    console.log('Error:', error.message);
    if (error.data) {
      console.log('Data:', JSON.stringify(error.data, null, 2));
    }
    if (error.errors) {
      console.log('Errors:', JSON.stringify(error.errors, null, 2));
    }
  }
}

main();
