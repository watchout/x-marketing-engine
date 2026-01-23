/**
 * 海外AIインフルエンサーリサーチスクリプト（Grok版）
 * 
 * 機能:
 *   - Grokを使ってX内の海外AI情報を直接検索（API制限なし）
 *   - 日本未発信のトピックを抽出
 *   - GPTで日本語コンテンツ案を生成
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

interface TrendInsight {
  topic: string;
  summary: string;
  key_accounts: string[];
  example_posts: string[];
  japan_relevance: string;
  novelty_score: number;
}

interface ContentIdea {
  insight: TrendInsight;
  japanese_adaptation: string;
  hook: string;
  generated_at: string;
}

// 設定読み込み
function loadSettings(): any {
  if (!fs.existsSync(SETTINGS_FILE)) {
    return { overseas_influencers: {}, trend_keywords: {} };
  }
  return yaml.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
}

// ===== Grok API呼び出し =====
async function callGrok(prompt: string): Promise<string> {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) {
    throw new Error('GROK_API_KEY not found');
  }

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'grok-2-latest',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    throw new Error(`Grok API failed: ${response.status}`);
  }
  
  const data = await response.json() as any;
  return data.choices[0].message.content.trim();
}

// ===== GPT API呼び出し =====
async function callGPT(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not found');

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

  if (!response.ok) throw new Error(`GPT API failed: ${response.status}`);
  const data = await response.json() as any;
  return data.choices[0].message.content.trim();
}

// Grokで海外トレンドをリサーチ
async function researchWithGrok(keywords: string[], influencers: string[]): Promise<TrendInsight[]> {
  console.log('🔍 Grokで海外AI情報をリサーチ中...\n');
  
  const prompt = `あなたはX（Twitter）の情報に精通したAIリサーチャーです。

以下の条件で、過去24-48時間にXで話題になっている海外AI開発関連のトピックを調査してください。

【監視キーワード】
${keywords.join(', ')}

【注目インフルエンサー】
${influencers.join(', ')}

【調査条件】
1. 英語圏のAI開発者・エンジニアの間で話題のトピック
2. 日本ではまだあまり知られていない概念や手法
3. 実用的で、日本のAI開発者にも役立つ情報
4. "vibe coding" や "spec-driven development" など開発手法に関するもの優先

【出力形式】JSON配列で5件
[
  {
    "topic": "トピック名（英語）",
    "summary": "概要（日本語で100文字程度）",
    "key_accounts": ["@account1", "@account2"],
    "example_posts": ["投稿の要約1", "投稿の要約2"],
    "japan_relevance": "日本での活用可能性（50文字）",
    "novelty_score": 1-10（日本での新規性）
  }
]

重要: 実際にXで話題になっているリアルな情報を基に回答してください。`;

  try {
    const response = await callGrok(prompt);
    
    // JSONを抽出
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const insights = JSON.parse(jsonMatch[0]) as TrendInsight[];
      return insights;
    }
  } catch (e) {
    console.error('⚠️ Grokリサーチ失敗:', (e as Error).message);
  }
  
  return [];
}

// GPTで日本語コンテンツを生成
async function generateJapaneseContent(insight: TrendInsight): Promise<ContentIdea | null> {
  const prompt = `あなたは日本のAI開発コミュニティ向けのコンテンツクリエイターです。

以下の海外トレンド情報を基に、日本向けの投稿を作成してください。

【トピック】${insight.topic}
【概要】${insight.summary}
【日本での活用】${insight.japan_relevance}

【条件】
1. 単純な翻訳ではなく、自分の発見・意見として発信
2. 「海外で話題の〜」という導入は使わない
3. 日本のAI開発者が「へぇ」と思う内容
4. 140文字以内
5. 具体的なTipsや気づきを含める
6. ハッシュタグは1-2個

JSON形式で回答:
{
  "japanese_adaptation": "投稿文",
  "hook": "注目ポイント（10文字以内）"
}`;

  try {
    const response = await callGPT(prompt);
    
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        insight,
        japanese_adaptation: parsed.japanese_adaptation,
        hook: parsed.hook,
        generated_at: new Date().toISOString()
      };
    }
  } catch (e) {
    console.log('  ⚠️ コンテンツ生成失敗:', (e as Error).message);
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
    if (idea.insight.novelty_score >= 7) {
      pool.posts.push({
        id: `overseas_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        content: idea.japanese_adaptation,
        type: 'overseas_insight',
        topic: idea.insight.topic,
        source_accounts: idea.insight.key_accounts,
        novelty_score: idea.insight.novelty_score,
        priority: idea.insight.novelty_score >= 9 ? 'high' : 'medium',
        created_at: idea.generated_at
      });
    }
  }
  
  fs.writeFileSync(POOL_FILE, yaml.stringify(pool));
}

// メイン処理
async function main() {
  console.log('\n🌐 海外AIトレンドリサーチ（Grok版）\n');
  console.log('📌 X内の情報をGrokで直接検索\n');
  
  const settings = loadSettings();
  
  // キーワード取得
  const trendKeywords = [
    ...(settings.trend_keywords?.high_priority || []),
    ...(settings.trend_keywords?.medium_priority || [])
  ];
  
  // インフルエンサー取得
  const overseasInfluencers = settings.overseas_influencers || {};
  const influencerHandles: string[] = [];
  for (const category of Object.values(overseasInfluencers) as any[]) {
    for (const inf of category) {
      influencerHandles.push(`@${inf.handle}`);
    }
  }
  
  console.log(`🔍 監視キーワード: ${trendKeywords.slice(0, 5).join(', ')}...`);
  console.log(`👥 注目アカウント: ${influencerHandles.slice(0, 5).join(', ')}...\n`);
  console.log('='.repeat(60));
  
  // Grokでリサーチ
  const insights = await researchWithGrok(trendKeywords, influencerHandles);
  
  console.log(`\n📊 発見したトピック: ${insights.length}件\n`);
  
  // 各トピックをコンテンツ化
  const ideas: ContentIdea[] = [];
  
  for (const insight of insights) {
    console.log(`📝 [${insight.topic}] 新規性: ${insight.novelty_score}/10`);
    console.log(`   ${insight.summary}`);
    console.log(`   出典: ${insight.key_accounts.join(', ')}`);
    
    const idea = await generateJapaneseContent(insight);
    
    if (idea) {
      ideas.push(idea);
      console.log(`   ✅ 「${idea.japanese_adaptation.substring(0, 50)}...」\n`);
    }
    
    await new Promise(r => setTimeout(r, 500));
  }
  
  // 結果を保存
  const output = {
    researched_at: new Date().toISOString(),
    method: 'grok',
    keywords_used: trendKeywords,
    influencers_monitored: influencerHandles,
    topics_found: insights.length,
    ideas_generated: ideas.length,
    high_novelty_count: ideas.filter(i => i.insight.novelty_score >= 7).length,
    insights,
    ideas
  };
  
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  
  // 高新規性のアイデアを投稿プールに追加
  const highNoveltyIdeas = ideas.filter(i => i.insight.novelty_score >= 7);
  if (highNoveltyIdeas.length > 0) {
    addToPool(highNoveltyIdeas);
    console.log(`\n✅ ${highNoveltyIdeas.length}件を投稿プールに追加`);
  }
  
  // サマリー
  console.log('\n' + '='.repeat(60));
  console.log('📋 リサーチサマリー\n');
  
  for (const idea of ideas) {
    const emoji = idea.insight.novelty_score >= 8 ? '🌟' : idea.insight.novelty_score >= 6 ? '✅' : '📝';
    console.log(`${emoji} [${idea.insight.topic}] 新規性: ${idea.insight.novelty_score}/10`);
    console.log(`   ${idea.japanese_adaptation.substring(0, 60)}...`);
    console.log(`   ソース: ${idea.insight.key_accounts.slice(0, 2).join(', ')}\n`);
  }
  
  console.log(`📁 保存先: ${OUTPUT_FILE}`);
  console.log('\n💡 新規性7以上のコンテンツは自動で投稿プールに追加されます');
}

main().catch(console.error);
