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
  persona_fit: number;  // ターゲットペルソナへの適合度
  freshness: number;    // 鮮度 (1-10: 10=24時間以内, 1=1週間以上前)
  japan_spread: number; // 日本での普及度 (1-10: 1=ほぼ未知, 10=すでに広まっている)
  priority_score?: number; // 総合優先度スコア
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
      model: 'grok-3',
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

// ペルソナ情報を取得
function getPersonaContext(settings: any): string {
  const persona = settings.persona || {};
  return `
【ターゲットペルソナ】
名前: ${persona.name || 'AI開発者'}
ペインポイント:
${(persona.pain_points || []).map((p: string) => `- ${p}`).join('\n')}
求めているもの:
${(persona.desires || []).map((d: string) => `- ${d}`).join('\n')}
関心キーワード: ${(persona.keywords || []).join(', ')}
`;
}

// Grokで海外トレンドをリサーチ（ペルソナフィルタリング付き）
async function researchWithGrok(keywords: string[], influencers: string[], settings: any): Promise<TrendInsight[]> {
  console.log('🔍 Grokで海外AI情報をリサーチ中...\n');
  
  const personaContext = getPersonaContext(settings);
  
  const prompt = `あなたはX（Twitter）の情報に精通したAIリサーチャーです。

以下の条件で、過去24-48時間にXで話題になっている海外AI開発関連のトピックを調査してください。

${personaContext}

【監視キーワード】
${keywords.join(', ')}

【注目インフルエンサー】
${influencers.join(', ')}

【重要な調査条件】
1. 上記ペルソナの「ペインポイント」を解決する情報を優先
2. 「バイブコーディングの限界」「仕様駆動開発」「AI開発の品質向上」に関連するもの
3. 日本ではまだあまり知られていない概念や手法
4. 実用的で、すぐに試せるTipsやアプローチ
5. 曖昧な開発から脱却し、再現性のある開発を実現する情報

【出力形式】JSON配列で5件
[
  {
    "topic": "トピック名（英語）",
    "summary": "概要（日本語で100文字程度）",
    "key_accounts": ["@account1", "@account2"],
    "example_posts": ["投稿の要約1", "投稿の要約2"],
    "japan_relevance": "日本での活用可能性（50文字）",
    "novelty_score": 1-10（日本での新規性）,
    "persona_fit": 1-10（ターゲットペルソナへの適合度）,
    "freshness": 1-10（鮮度: 10=24時間以内に話題, 7=3日以内, 5=1週間以内, 3=1ヶ月以内, 1=それ以上前）,
    "japan_spread": 1-10（日本での普及度: 1=日本でほぼ未知, 5=一部で話題, 10=すでに広く知られている）
  }
]

【重要な評価基準】
- freshness × (10 - japan_spread) で「今発信する価値」を判断
  → 鮮度が高く、日本でまだ広まっていない = 最優先
  → 鮮度が低くても、日本で全く知られていない = 発信価値あり
  → 鮮度が高くても、日本ですでに広まっている = 価値低
- ペルソナの課題を解決する情報を優先
- 実際にXで話題になっているリアルな情報を基に回答
- persona_fitが7未満のトピックは含めない`;

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

// 投稿プールに追加（優先度スコアでフィルタリング）
function addToPool(ideas: ContentIdea[]): number {
  let pool: any = { posts: [] };
  
  if (fs.existsSync(POOL_FILE)) {
    pool = yaml.parse(fs.readFileSync(POOL_FILE, 'utf-8')) || { posts: [] };
  }
  
  let addedCount = 0;
  
  for (const idea of ideas) {
    const novelty = idea.insight.novelty_score || 0;
    const personaFit = idea.insight.persona_fit || 0;
    const freshness = idea.insight.freshness || 5;
    const japanSpread = idea.insight.japan_spread || 5;
    const priorityScore = idea.insight.priority_score || 0;
    
    // 条件: 新規性7+ かつ ペルソナ適合7+ かつ 優先度スコア30+
    if (novelty >= 7 && personaFit >= 7 && priorityScore >= 30) {
      const priority = priorityScore >= 60 ? 'high' : priorityScore >= 40 ? 'medium' : 'low';
      
      pool.posts.push({
        id: `overseas_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        content: idea.japanese_adaptation,
        type: 'overseas_insight',
        topic: idea.insight.topic,
        source_accounts: idea.insight.key_accounts,
        novelty_score: novelty,
        persona_fit: personaFit,
        freshness: freshness,
        japan_spread: japanSpread,
        priority_score: priorityScore,
        priority,
        created_at: idea.generated_at,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7日後に期限切れ
      });
      addedCount++;
    }
  }
  
  // 古いoverseasインサイトを削除（7日以上経過）
  const now = new Date();
  pool.posts = pool.posts.filter((p: any) => {
    if (p.type !== 'overseas_insight') return true;
    if (!p.expires_at) return true;
    return new Date(p.expires_at) > now;
  });
  
  fs.writeFileSync(POOL_FILE, yaml.stringify(pool));
  return addedCount;
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
  
  // Grokでリサーチ（ペルソナ情報を渡す）
  const insights = await researchWithGrok(trendKeywords, influencerHandles, settings);
  
  console.log(`\n📊 発見したトピック: ${insights.length}件\n`);
  
  // 各トピックをコンテンツ化
  const ideas: ContentIdea[] = [];
  
  for (const insight of insights) {
    const personaFit = insight.persona_fit || 5;
    const freshness = insight.freshness || 5;
    const japanSpread = insight.japan_spread || 5;
    
    // 優先度スコア計算: 鮮度 × (10 - 日本普及度) × ペルソナ適合度 / 100
    const priorityScore = Math.round((freshness * (10 - japanSpread) * personaFit) / 10);
    insight.priority_score = priorityScore;
    
    const fitEmoji = personaFit >= 8 ? '🎯' : personaFit >= 6 ? '✓' : '△';
    const freshEmoji = freshness >= 8 ? '🔥' : freshness >= 5 ? '⏰' : '📅';
    const spreadEmoji = japanSpread <= 3 ? '🆕' : japanSpread <= 6 ? '📢' : '📣';
    
    console.log(`📝 [${insight.topic}]`);
    console.log(`   鮮度: ${freshEmoji} ${freshness}/10 | 日本普及: ${spreadEmoji} ${japanSpread}/10`);
    console.log(`   ペルソナ適合: ${fitEmoji} ${personaFit}/10 | 優先度: ⭐ ${priorityScore}`);
    console.log(`   ${insight.summary}`);
    console.log(`   出典: ${insight.key_accounts.join(', ')}`);
    
    // フィルタリング条件
    // 1. ペルソナ適合度6未満はスキップ
    // 2. 日本で既に広まっている(8+)かつ鮮度が低い(5未満)はスキップ
    if (personaFit < 6) {
      console.log(`   ⏭️ ペルソナ適合度が低いためスキップ\n`);
      continue;
    }
    if (japanSpread >= 8 && freshness < 5) {
      console.log(`   ⏭️ 日本で既に広まっており鮮度も低いためスキップ\n`);
      continue;
    }
    
    const idea = await generateJapaneseContent(insight);
    
    if (idea) {
      ideas.push(idea);
      console.log(`   ✅ 「${idea.japanese_adaptation.substring(0, 50)}...」\n`);
    }
    
    await new Promise(r => setTimeout(r, 500));
  }
  
  // 優先度順にソート
  ideas.sort((a, b) => (b.insight.priority_score || 0) - (a.insight.priority_score || 0));
  
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
  
  // 高品質アイデアを投稿プールに追加（新規性 & ペルソナ適合度でフィルタ）
  const addedCount = addToPool(ideas);
  if (addedCount > 0) {
    console.log(`\n✅ ${addedCount}件を投稿プールに追加（新規性7+ & ペルソナ適合7+）`);
  } else {
    console.log(`\n⚠️ 条件を満たすコンテンツがありませんでした`);
  }
  
  // サマリー
  console.log('\n' + '='.repeat(60));
  console.log('📋 リサーチサマリー\n');
  
  for (const idea of ideas) {
    const novelty = idea.insight.novelty_score || 0;
    const personaFit = idea.insight.persona_fit || 0;
    const freshness = idea.insight.freshness || 5;
    const japanSpread = idea.insight.japan_spread || 5;
    const priorityScore = idea.insight.priority_score || 0;
    
    const emoji = priorityScore >= 60 ? '🔥' : priorityScore >= 40 ? '⭐' : '📝';
    console.log(`${emoji} [${idea.insight.topic}] 優先度: ${priorityScore}`);
    console.log(`   鮮度: ${freshness}/10 | 日本普及: ${japanSpread}/10 | ペルソナ: ${personaFit}/10`);
    console.log(`   ${idea.japanese_adaptation.substring(0, 60)}...`);
    console.log(`   ソース: ${idea.insight.key_accounts.slice(0, 2).join(', ')}\n`);
  }
  
  console.log(`📁 保存先: ${OUTPUT_FILE}`);
  console.log('\n💡 新規性7以上のコンテンツは自動で投稿プールに追加されます');
}

main().catch(console.error);
