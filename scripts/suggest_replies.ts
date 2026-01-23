/**
 * インフルエンサーへのリプライ提案スクリプト（マルチLLM版）
 * 
 * 機能:
 *   - ベンチマークアカウントの最新投稿を取得
 *   - 関連性の高い投稿をピックアップ
 *   - GPT + Gemini のマルチLLMでリプライ案を推敲
 *   - 手動投稿用のリストを出力
 * 
 * 使い方:
 *   npx ts-node scripts/suggest_replies.ts
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

// 設定読み込み
const SETTINGS_FILE = path.join(__dirname, '../config/settings.yml');
const OUTPUT_FILE = path.join(__dirname, '../content/reply_suggestions.json');

interface Tweet {
  id: string;
  text: string;
  author: string;
  created_at: string;
  url: string;
  metrics?: {
    likes: number;
    retweets: number;
    replies: number;
  };
}

interface ReplySuggestion {
  tweet: Tweet;
  suggested_reply: string;
  alternative_replies: string[];
  relevance: 'high' | 'medium' | 'low';
  reason: string;
  quality_score: number;
  refinement_rounds: number;
  generated_at: string;
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

// ベンチマークアカウントの設定を読み込み
function loadBenchmarkAccounts(): string[] {
  if (!fs.existsSync(SETTINGS_FILE)) {
    return ['ai_jitan', 'Fujin_Metaverse', 'commte', 'akira_papa_IT'];
  }
  
  const settings = yaml.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  const accounts: string[] = [];
  
  if (settings.benchmark_accounts) {
    for (const tier of Object.values(settings.benchmark_accounts) as any[]) {
      for (const acc of tier) {
        accounts.push(acc.handle.replace('@', ''));
      }
    }
  }
  
  return accounts.length > 0 ? accounts : ['ai_jitan', 'Fujin_Metaverse'];
}

// ユーザーの最新ツイートを取得
async function getRecentTweets(client: any, handle: string, count: number = 5): Promise<Tweet[]> {
  try {
    const user = await client.v2.userByUsername(handle);
    if (!user.data?.id) return [];
    
    const timeline = await client.v2.userTimeline(user.data.id, {
      max_results: count,
      'tweet.fields': ['created_at', 'public_metrics'],
      exclude: ['retweets', 'replies']
    });
    
    const tweets: Tweet[] = [];
    for (const tweet of timeline.data?.data || []) {
      tweets.push({
        id: tweet.id,
        text: tweet.text,
        author: handle,
        created_at: tweet.created_at || new Date().toISOString(),
        url: `https://x.com/${handle}/status/${tweet.id}`,
        metrics: tweet.public_metrics ? {
          likes: tweet.public_metrics.like_count,
          retweets: tweet.public_metrics.retweet_count,
          replies: tweet.public_metrics.reply_count
        } : undefined
      });
    }
    
    return tweets;
  } catch (e) {
    console.error(`  ⚠️ Failed to get tweets for @${handle}:`, e);
    return [];
  }
}

// 関連性を判定
function checkRelevance(tweet: Tweet): { relevance: 'high' | 'medium' | 'low', reason: string } {
  const text = tweet.text.toLowerCase();
  
  // 高関連性キーワード
  const highKeywords = ['cursor', 'ai開発', 'claude', 'エージェント', 'ssot', 'バイブ', 'プロンプト'];
  for (const kw of highKeywords) {
    if (text.includes(kw)) {
      return { relevance: 'high', reason: `「${kw}」に関する投稿` };
    }
  }
  
  // 中関連性キーワード
  const mediumKeywords = ['ai', '自動化', '効率化', 'ツール', 'コード', '開発'];
  for (const kw of mediumKeywords) {
    if (text.includes(kw)) {
      return { relevance: 'medium', reason: `「${kw}」に関する投稿` };
    }
  }
  
  return { relevance: 'low', reason: '一般的な投稿' };
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
      max_tokens: 300
    })
  });

  if (!response.ok) throw new Error(`GPT API failed: ${response.status}`);
  const data = await response.json() as any;
  return data.choices[0].message.content.trim();
}

// ===== Gemini API呼び出し =====
async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not found');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 300 }
      })
    }
  );

  if (!response.ok) throw new Error(`Gemini API failed: ${response.status}`);
  const data = await response.json() as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

// ===== リプライ初稿生成（GPT） =====
async function generateInitialReply(tweet: Tweet): Promise<string> {
  const prompt = `あなたはAI開発ツール「dev-OS」の開発者です。
以下のツイートに対する自然なリプライを1つ生成してください。

ツイート投稿者: @${tweet.author}
ツイート内容: "${tweet.text}"

条件:
- 宣伝っぽくならない、自然な会話として
- 相手の内容に共感、質問、または建設的なコメント
- 必要に応じてdev-OSでの経験を軽く触れてもOK（押し付けはNG）
- 50-100文字程度
- 絵文字は控えめに（0-1個）
- リプライバトルにならないよう丁寧に

リプライ:`;

  return await callGPT(prompt);
}

// ===== Gemini による評価・改善案 =====
async function evaluateWithGemini(tweet: Tweet, reply: string): Promise<{ score: number; feedback: string; improved: string }> {
  const prompt = `以下のリプライを評価し、改善してください。

【元ツイート】
投稿者: @${tweet.author}
内容: "${tweet.text}"

【リプライ案】
"${reply}"

以下の観点で評価してください：
1. 自然さ（宣伝っぽくないか）
2. 共感度（相手に寄り添っているか）
3. 価値提供（相手にとって有益か）
4. 長さ（適切か）

JSON形式で回答してください：
{
  "score": 1-10の数値,
  "feedback": "改善点の説明",
  "improved": "改善版リプライ（50-100文字）"
}`;

  try {
    const response = await callGemini(prompt);
    
    // JSONを抽出
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        score: parsed.score || 5,
        feedback: parsed.feedback || '',
        improved: parsed.improved || reply
      };
    }
  } catch (e) {
    console.log('    ⚠️ Gemini評価パース失敗、元のリプライを使用');
  }

  return { score: 5, feedback: '', improved: reply };
}

// ===== GPT による最終推敲 =====
async function refineWithGPT(tweet: Tweet, reply: string, feedback: string): Promise<string> {
  const prompt = `以下のリプライを最終推敲してください。

【元ツイート】@${tweet.author}: "${tweet.text}"

【現在のリプライ案】
"${reply}"

【改善フィードバック】
${feedback}

条件:
- フィードバックを踏まえて改善
- 自然な会話を維持
- 50-100文字
- 絵文字は0-1個

最終リプライのみを出力:`;

  return await callGPT(prompt);
}

// ===== マルチLLMリプライ生成 =====
async function generateReplyMultiLLM(tweet: Tweet): Promise<{ reply: string; alternatives: string[]; score: number; rounds: number }> {
  console.log('    🤖 GPT: 初稿生成中...');
  
  let currentReply: string;
  try {
    currentReply = await generateInitialReply(tweet);
  } catch (e) {
    console.log('    ⚠️ GPT失敗、デフォルトリプライを使用');
    return {
      reply: 'なるほど、参考になります！',
      alternatives: [],
      score: 5,
      rounds: 0
    };
  }
  
  console.log(`    📝 初稿: "${currentReply.substring(0, 40)}..."`);
  
  const alternatives: string[] = [currentReply];
  let bestScore = 0;
  let bestReply = currentReply;
  let rounds = 1;

  // Gemini評価ループ（最大2回）
  for (let i = 0; i < 2; i++) {
    console.log(`    🔷 Gemini: 評価 ${i + 1}回目...`);
    
    try {
      const evaluation = await evaluateWithGemini(tweet, currentReply);
      console.log(`    📊 スコア: ${evaluation.score}/10`);
      
      if (evaluation.score > bestScore) {
        bestScore = evaluation.score;
        bestReply = currentReply;
      }
      
      // スコア8以上なら終了
      if (evaluation.score >= 8) {
        console.log('    ✅ 高品質リプライ達成');
        break;
      }
      
      // Geminiの改善案を採用
      if (evaluation.improved && evaluation.improved !== currentReply) {
        alternatives.push(evaluation.improved);
        
        // GPTで最終推敲
        console.log('    🔶 GPT: 最終推敲中...');
        const refined = await refineWithGPT(tweet, evaluation.improved, evaluation.feedback);
        currentReply = refined;
        alternatives.push(refined);
        rounds++;
      }
    } catch (e) {
      console.log('    ⚠️ Gemini評価スキップ');
      break;
    }
    
    // API負荷軽減
    await new Promise(r => setTimeout(r, 500));
  }

  // 最終スコア確認
  if (bestScore < 6 && currentReply !== bestReply) {
    bestReply = currentReply;
    bestScore = 6;
  }

  return {
    reply: bestReply,
    alternatives: [...new Set(alternatives)].filter(a => a !== bestReply).slice(0, 3),
    score: bestScore,
    rounds
  };
}

// メイン処理
async function main() {
  console.log('\n🔍 インフルエンサーリプライ提案生成（マルチLLM版）\n');
  console.log('📌 使用LLM: GPT-4o-mini + Gemini 2.0 Flash\n');
  
  const client = await getXClient();
  const accounts = loadBenchmarkAccounts();
  
  console.log(`📋 対象アカウント: ${accounts.length}件`);
  
  const allTweets: Tweet[] = [];
  
  for (const handle of accounts.slice(0, 5)) { // 最大5アカウント
    console.log(`\n👤 @${handle} の投稿を取得中...`);
    const tweets = await getRecentTweets(client, handle, 3);
    console.log(`   → ${tweets.length}件取得`);
    allTweets.push(...tweets);
    
    // レート制限対策
    await new Promise(r => setTimeout(r, 1000));
  }
  
  // 関連性でフィルタ
  const relevantTweets = allTweets.filter(t => checkRelevance(t).relevance !== 'low');
  console.log(`\n🎯 関連性のある投稿: ${relevantTweets.length}件\n`);
  
  const suggestions: ReplySuggestion[] = [];
  
  for (const tweet of relevantTweets.slice(0, 5)) { // 最大5件
    const { relevance, reason } = checkRelevance(tweet);
    
    console.log(`\n${'='.repeat(50)}`);
    console.log(`📝 @${tweet.author} へのリプライ生成`);
    console.log(`   関連度: ${relevance.toUpperCase()} - ${reason}`);
    console.log(`   投稿: "${tweet.text.substring(0, 60)}..."\n`);
    
    const result = await generateReplyMultiLLM(tweet);
    
    suggestions.push({
      tweet,
      suggested_reply: result.reply,
      alternative_replies: result.alternatives,
      relevance,
      reason,
      quality_score: result.score,
      refinement_rounds: result.rounds,
      generated_at: new Date().toISOString()
    });
    
    console.log(`\n    ✅ 最終リプライ: "${result.reply}"`);
    console.log(`    📊 品質スコア: ${result.score}/10 (${result.rounds}ラウンド推敲)`);
    
    // API負荷軽減
    await new Promise(r => setTimeout(r, 1000));
  }
  
  // 関連性・スコア順にソート
  suggestions.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    if (order[a.relevance] !== order[b.relevance]) {
      return order[a.relevance] - order[b.relevance];
    }
    return b.quality_score - a.quality_score;
  });
  
  // ファイルに保存
  const output = {
    generated_at: new Date().toISOString(),
    llm_used: ['GPT-4o-mini', 'Gemini 2.0 Flash'],
    total_suggestions: suggestions.length,
    suggestions
  };
  
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  
  // 結果表示
  console.log('\n' + '='.repeat(60));
  console.log('📋 リプライ提案サマリー\n');
  
  for (const s of suggestions) {
    const scoreEmoji = s.quality_score >= 8 ? '🌟' : s.quality_score >= 6 ? '✅' : '📝';
    console.log(`${scoreEmoji} [${s.relevance.toUpperCase()}] @${s.tweet.author} (スコア: ${s.quality_score}/10)`);
    console.log(`   提案: ${s.suggested_reply}`);
    if (s.alternative_replies.length > 0) {
      console.log(`   代替案: ${s.alternative_replies.length}件`);
    }
    console.log(`   URL: ${s.tweet.url}`);
    console.log('');
  }
  
  console.log(`\n✅ ${suggestions.length}件の高品質リプライ提案を生成しました`);
  console.log(`📁 保存先: ${OUTPUT_FILE}`);
  console.log('\n⚠️ 上記のURLを開いて手動でリプライしてください');
  console.log('💡 代替案もあるので、状況に応じて選択できます');
}

main().catch(console.error);
