/**
 * 海外AIインフルエンサーリサーチスクリプト
 * 
 * 機能:
 *   - 海外インフルエンサーの最新投稿を取得
 *   - 日本未発信のトピックを抽出
 *   - GPT/Geminiで日本語コンテンツ案を生成
 *   - 投稿プールに追加
 * 
 * 使い方:
 *   npx ts-node scripts/research_overseas.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

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

const SETTINGS_FILE = path.join(__dirname, '../config/settings.yml');
const OUTPUT_FILE = path.join(__dirname, '../content/overseas_insights.json');
const POOL_FILE = path.join(__dirname, '../content/ab_test_pool.yml');

interface OverseasTweet {
  author: string;
  text: string;
  url: string;
  engagement: number;
  topic: string;
}

interface ContentIdea {
  original_tweet: OverseasTweet;
  japanese_adaptation: string;
  hook: string;
  topic_category: string;
  novelty_score: number;
  generated_at: string;
}

// 設定読み込み
function loadSettings(): any {
  if (!fs.existsSync(SETTINGS_FILE)) {
    return { overseas_influencers: {}, trend_keywords: {} };
  }
  return yaml.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
}

// X API クライアント初期化
async function getXClient() {
  const { TwitterApi } = await import('twitter-api-v2');
  
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY!,
    appSecret: process.env.X_API_SECRET!,
    accessToken: process.env.X_ACCESS_TOKEN!,
    accessSecret: process.env.X_ACCESS_SECRET!,
  });
  
  return client;
}

// ユーザーの最新ツイートを取得
async function getRecentTweets(client: any, handle: string, count: number = 5): Promise<OverseasTweet[]> {
  try {
    const user = await client.v2.userByUsername(handle);
    if (!user.data?.id) return [];
    
    const timeline = await client.v2.userTimeline(user.data.id, {
      max_results: count,
      'tweet.fields': ['created_at', 'public_metrics'],
      exclude: ['retweets', 'replies']
    });
    
    const tweets: OverseasTweet[] = [];
    for (const tweet of timeline.data?.data || []) {
      const metrics = tweet.public_metrics;
      tweets.push({
        author: handle,
        text: tweet.text,
        url: `https://x.com/${handle}/status/${tweet.id}`,
        engagement: metrics ? (metrics.like_count + metrics.retweet_count * 2) : 0,
        topic: ''
      });
    }
    
    return tweets;
  } catch (e) {
    console.error(`  ⚠️ Failed to get tweets for @${handle}:`, (e as Error).message);
    return [];
  }
}

// GPTで日本語コンテンツ案を生成
async function generateJapaneseContent(tweet: OverseasTweet, trendKeywords: string[]): Promise<ContentIdea | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const prompt = `あなたは日本のAI開発コミュニティ向けのコンテンツクリエイターです。

以下の海外AIインフルエンサーの投稿を分析し、日本向けにローカライズしたコンテンツを作成してください。

【元の投稿】
@${tweet.author}: "${tweet.text}"

【注目キーワード】
${trendKeywords.join(', ')}

【条件】
1. 単純な翻訳ではなく、日本の文脈に合わせて再構成
2. 「海外で話題の〜」「最新トレンド〜」などの導入を使わない
3. 自分の発見・意見として発信するトーン
4. 日本でまだあまり知られていない概念を解説
5. 140文字以内
6. 実用的なTipsや気づきを含める

JSON形式で回答:
{
  "japanese_adaptation": "日本語の投稿文",
  "hook": "注目ポイント（10文字以内）",
  "topic_category": "vibe_coding|agents|productivity|other",
  "novelty_score": 1-10（日本での新規性）
}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.8,
        max_tokens: 500
      })
    });

    if (!response.ok) throw new Error(`API failed: ${response.status}`);
    const data = await response.json() as any;
    const content = data.choices[0].message.content;
    
    // JSONを抽出
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        original_tweet: tweet,
        japanese_adaptation: parsed.japanese_adaptation,
        hook: parsed.hook,
        topic_category: parsed.topic_category,
        novelty_score: parsed.novelty_score || 5,
        generated_at: new Date().toISOString()
      };
    }
  } catch (e) {
    console.log('  ⚠️ Content generation failed:', (e as Error).message);
  }
  
  return null;
}

// 投稿プールに追加
function addToPool(ideas: ContentIdea[]): void {
  let pool: any = { posts: [] };
  
  if (fs.existsSync(POOL_FILE)) {
    pool = yaml.parse(fs.readFileSync(POOL_FILE, 'utf-8')) || { posts: [] };
  }
  
  for (const idea of ideas) {
    if (idea.novelty_score >= 7) {
      pool.posts.push({
        id: `overseas_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        content: idea.japanese_adaptation,
        type: 'overseas_insight',
        source: idea.original_tweet.author,
        source_url: idea.original_tweet.url,
        topic: idea.topic_category,
        priority: idea.novelty_score >= 9 ? 'high' : 'medium',
        created_at: idea.generated_at
      });
    }
  }
  
  fs.writeFileSync(POOL_FILE, yaml.stringify(pool));
}

// メイン処理
async function main() {
  console.log('\n🌐 海外AIインフルエンサーリサーチ\n');
  
  const settings = loadSettings();
  const overseasInfluencers = settings.overseas_influencers || {};
  const trendKeywords = [
    ...(settings.trend_keywords?.high_priority || []),
    ...(settings.trend_keywords?.medium_priority || [])
  ];
  
  // 全カテゴリからインフルエンサーを収集
  const allInfluencers: any[] = [];
  for (const category of Object.values(overseasInfluencers) as any[]) {
    allInfluencers.push(...category);
  }
  
  console.log(`📋 対象インフルエンサー: ${allInfluencers.length}名`);
  console.log(`🔍 監視キーワード: ${trendKeywords.slice(0, 5).join(', ')}...\n`);
  
  const client = await getXClient();
  const allTweets: OverseasTweet[] = [];
  
  // 各インフルエンサーの投稿を取得（APIレート制限のため3名まで）
  for (const influencer of allInfluencers.slice(0, 3)) {
    console.log(`👤 @${influencer.handle} (${influencer.name})`);
    console.log(`   Focus: ${influencer.focus}`);
    
    const tweets = await getRecentTweets(client, influencer.handle, 3);
    console.log(`   → ${tweets.length}件取得\n`);
    
    // トピック情報を付加
    for (const tweet of tweets) {
      tweet.topic = influencer.topics?.[0] || 'general';
    }
    
    allTweets.push(...tweets);
    
    // レート制限対策
    await new Promise(r => setTimeout(r, 2000));
  }
  
  // エンゲージメント順にソート
  allTweets.sort((a, b) => b.engagement - a.engagement);
  
  console.log(`\n📊 取得した投稿: ${allTweets.length}件\n`);
  console.log('='.repeat(60));
  
  // 上位5件をコンテンツ化
  const ideas: ContentIdea[] = [];
  
  for (const tweet of allTweets.slice(0, 5)) {
    console.log(`\n📝 @${tweet.author} (エンゲージメント: ${tweet.engagement})`);
    console.log(`   "${tweet.text.substring(0, 60)}..."`);
    
    const idea = await generateJapaneseContent(tweet, trendKeywords);
    
    if (idea) {
      ideas.push(idea);
      console.log(`   ✅ 新規性スコア: ${idea.novelty_score}/10`);
      console.log(`   📝 「${idea.japanese_adaptation.substring(0, 50)}...」`);
    }
    
    await new Promise(r => setTimeout(r, 1000));
  }
  
  // 結果を保存
  const output = {
    researched_at: new Date().toISOString(),
    influencers_checked: allInfluencers.slice(0, 3).map((i: any) => i.handle),
    total_tweets_analyzed: allTweets.length,
    ideas_generated: ideas.length,
    high_novelty_count: ideas.filter(i => i.novelty_score >= 7).length,
    ideas
  };
  
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  
  // 高新規性のアイデアを投稿プールに追加
  const highNoveltyIdeas = ideas.filter(i => i.novelty_score >= 7);
  if (highNoveltyIdeas.length > 0) {
    addToPool(highNoveltyIdeas);
    console.log(`\n✅ ${highNoveltyIdeas.length}件を投稿プールに追加`);
  }
  
  // サマリー
  console.log('\n' + '='.repeat(60));
  console.log('📋 リサーチサマリー\n');
  
  for (const idea of ideas) {
    const emoji = idea.novelty_score >= 8 ? '🌟' : idea.novelty_score >= 6 ? '✅' : '📝';
    console.log(`${emoji} [${idea.topic_category}] 新規性: ${idea.novelty_score}/10`);
    console.log(`   ${idea.japanese_adaptation.substring(0, 60)}...`);
    console.log(`   元: @${idea.original_tweet.author}\n`);
  }
  
  console.log(`📁 保存先: ${OUTPUT_FILE}`);
  console.log('\n💡 新規性7以上のコンテンツは自動で投稿プールに追加されます');
}

main().catch(console.error);
