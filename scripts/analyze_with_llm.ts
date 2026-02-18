/**
 * マルチLLM分析エンジン
 * 
 * 分析担当:
 *   - Grok: Xカルチャー・トレンド分析（なぜバズった/バズらなかったか）
 *   - Gemini: ロジック・パターン分析（構造的な勝ち/負けパターン抽出）
 * 
 * 出力:
 *   - content/llm_analysis.json: 分析結果
 *   - content/winning_patterns.yml: 勝ちパターン更新（LLMインサイト含む）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// ===== 型定義 =====

interface PostMetrics {
  impressions: number;
  likes: number;
  retweets: number;
  replies: number;
  bookmarks?: number;
  profile_clicks?: number;
  url_clicks?: number;
  collected_at: string;
}

interface PostHistory {
  id: string;
  content: string;
  tweet_id: string;
  posted_at: string;
  slot: string;
  theme: string;
  type?: string;
  variant?: string;
  metrics?: PostMetrics;
}

interface LLMAnalysis {
  analyzed_at: string;
  total_posts_analyzed: number;
  
  // Grokの分析（Xカルチャー視点）
  grok_insights: {
    why_top_performed: string[];      // トップ投稿がバズった理由
    why_bottom_failed: string[];      // 低パフォーマンス投稿の敗因
    x_culture_recommendations: string[]; // X文化に合わせた改善提案
    trending_elements: string[];       // 今取り入れるべきトレンド要素
  };
  
  // Geminiの分析（ロジック視点）
  gemini_insights: {
    structural_patterns: {
      winning: string[];               // 勝ちパターンの構造的特徴
      losing: string[];                // 負けパターンの構造的特徴
    };
    optimal_elements: {
      hooks: string[];                 // 効果的なフック
      structures: string[];            // 効果的な構造
      ctas: string[];                  // 効果的なCTA
    };
    data_driven_recommendations: string[]; // データに基づく改善提案
  };
  
  // 統合インサイト
  combined_action_items: string[];      // 次回投稿への具体的アクション
}

// ===== ファイルパス =====

const PROJECT_ROOT = path.join(__dirname, '..');
const HISTORY_FILE = path.join(PROJECT_ROOT, 'content/post_history.json');
const WINNING_PATTERNS_FILE = path.join(PROJECT_ROOT, 'content/winning_patterns.yml');
const LLM_ANALYSIS_FILE = path.join(PROJECT_ROOT, 'content/llm_analysis.json');

// ===== LLM呼び出し =====

async function callGrok(prompt: string): Promise<string> {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ GROK_API_KEY not found, using GPT as fallback');
    return callGPT(prompt);
  }
  
  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'grok-3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.warn(`⚠️ Grok API error: ${error}, using GPT as fallback`);
      return callGPT(prompt);
    }
    
    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0].message.content;
  } catch (e) {
    console.warn(`⚠️ Grok error: ${e}, using GPT as fallback`);
    return callGPT(prompt);
  }
}

async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ GOOGLE_AI_API_KEY not found, using GPT as fallback');
    return callGPT(prompt);
  }
  
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );
    
    if (!response.ok) {
      const error = await response.text();
      console.warn(`⚠️ Gemini API error: ${error}, using GPT as fallback`);
      return callGPT(prompt);
    }
    
    const data = await response.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    return data.candidates[0].content.parts[0].text;
  } catch (e) {
    console.warn(`⚠️ Gemini error: ${e}, using GPT as fallback`);
    return callGPT(prompt);
  }
}

async function callGPT(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not found');
  }
  
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    })
  });
  
  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content;
}

// ===== データ読み込み =====

function loadHistory(): PostHistory[] {
  if (!fs.existsSync(HISTORY_FILE)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
}

function calculateEngagementRate(metrics: PostMetrics): number {
  if (!metrics.impressions) return 0;
  return (metrics.likes + metrics.retweets * 2 + metrics.replies) / metrics.impressions;
}

// ===== Grok分析 =====

async function analyzeWithGrok(topPosts: PostHistory[], bottomPosts: PostHistory[]): Promise<LLMAnalysis['grok_insights']> {
  console.log('\n🔥 Grok分析: Xカルチャー・トレンド視点...');
  
  const topPostsText = topPosts.map((p, i) => 
    `【${i+1}位】Imp:${p.metrics?.impressions} Like:${p.metrics?.likes} ER:${(calculateEngagementRate(p.metrics!) * 100).toFixed(2)}%\n${p.content}`
  ).join('\n\n');
  
  const bottomPostsText = bottomPosts.map((p, i) => 
    `【ワースト${i+1}】Imp:${p.metrics?.impressions} Like:${p.metrics?.likes}\n${p.content}`
  ).join('\n\n');
  
  const prompt = `
あなたはXのプロフェッショナルマーケターです。AI開発者向けアカウントの投稿パフォーマンスを分析してください。

【ターゲット】
- 30-50代のAIで開発を効率化したいマネージャー・経営者
- 「バイブコーディング」に課題を感じている開発者

【トップパフォーマンス投稿】
${topPostsText}

【低パフォーマンス投稿】
${bottomPostsText}

【分析依頼】
Xカルチャーの視点から分析し、以下のJSON形式で回答してください:

{
  "why_top_performed": ["トップ投稿がバズった理由を3つ"],
  "why_bottom_failed": ["低パフォーマンス投稿の敗因を3つ"],
  "x_culture_recommendations": ["X文化に合わせた改善提案を3つ"],
  "trending_elements": ["今のXで取り入れるべきトレンド要素を2つ"]
}

JSONのみを出力してください。
`;

  const response = await callGrok(prompt);
  console.log('  ✓ Grok分析完了');
  
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.warn('  ⚠️ Grok JSON parse error');
  }
  
  return {
    why_top_performed: ['分析結果のパースに失敗'],
    why_bottom_failed: [],
    x_culture_recommendations: [],
    trending_elements: []
  };
}

// ===== Gemini分析 =====

async function analyzeWithGemini(topPosts: PostHistory[], bottomPosts: PostHistory[]): Promise<LLMAnalysis['gemini_insights']> {
  console.log('\n🧠 Gemini分析: ロジック・パターン視点...');
  
  const topPostsText = topPosts.map((p, i) => 
    `【${i+1}位】Imp:${p.metrics?.impressions} Like:${p.metrics?.likes} ER:${(calculateEngagementRate(p.metrics!) * 100).toFixed(2)}%\n${p.content}`
  ).join('\n\n');
  
  const bottomPostsText = bottomPosts.map((p, i) => 
    `【ワースト${i+1}】Imp:${p.metrics?.impressions} Like:${p.metrics?.likes}\n${p.content}`
  ).join('\n\n');
  
  const prompt = `
あなたはコンテンツマーケティングのデータアナリストです。投稿の構造的パターンを論理的に分析してください。

【トップパフォーマンス投稿】
${topPostsText}

【低パフォーマンス投稿】
${bottomPostsText}

【分析依頼】
構造的・論理的な視点から分析し、以下のJSON形式で回答してください:

{
  "structural_patterns": {
    "winning": ["勝ちパターンの構造的特徴を3つ（例：冒頭で問題提起→解決策提示→具体例）"],
    "losing": ["負けパターンの構造的特徴を3つ"]
  },
  "optimal_elements": {
    "hooks": ["効果的だったフック（冒頭）を2つ抽出"],
    "structures": ["効果的だった構造を2つ"],
    "ctas": ["効果的だったCTA（行動喚起）を2つ"]
  },
  "data_driven_recommendations": ["データに基づく具体的な改善提案を3つ"]
}

JSONのみを出力してください。
`;

  const response = await callGemini(prompt);
  console.log('  ✓ Gemini分析完了');
  
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.warn('  ⚠️ Gemini JSON parse error');
  }
  
  return {
    structural_patterns: { winning: [], losing: [] },
    optimal_elements: { hooks: [], structures: [], ctas: [] },
    data_driven_recommendations: []
  };
}

// ===== 統合アクション生成 =====

async function generateCombinedActions(
  grokInsights: LLMAnalysis['grok_insights'],
  geminiInsights: LLMAnalysis['gemini_insights']
): Promise<string[]> {
  console.log('\n📋 統合アクション生成...');
  
  const prompt = `
以下の2つのLLM分析結果を統合し、次回投稿への具体的なアクションリストを作成してください。

【Grok分析（Xカルチャー視点）】
- バズった理由: ${grokInsights.why_top_performed.join(', ')}
- 失敗理由: ${grokInsights.why_bottom_failed.join(', ')}
- X文化に合わせた提案: ${grokInsights.x_culture_recommendations.join(', ')}
- 取り入れるべきトレンド: ${grokInsights.trending_elements.join(', ')}

【Gemini分析（ロジック視点）】
- 勝ちパターン構造: ${geminiInsights.structural_patterns.winning.join(', ')}
- 負けパターン構造: ${geminiInsights.structural_patterns.losing.join(', ')}
- 効果的フック: ${geminiInsights.optimal_elements.hooks.join(', ')}
- データ基づく提案: ${geminiInsights.data_driven_recommendations.join(', ')}

【依頼】
これらを統合し、次回投稿で実践すべき具体的なアクションを5つ、優先度順にリストアップしてください。
JSON配列形式で出力: ["アクション1", "アクション2", ...]
`;

  const response = await callGPT(prompt);
  
  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.warn('  ⚠️ Action parse error');
  }
  
  return ['分析結果を参考に投稿内容を改善する'];
}

// ===== 勝ちパターン更新 =====

function updateWinningPatterns(analysis: LLMAnalysis): void {
  let existingData: Record<string, any> = {};
  
  if (fs.existsSync(WINNING_PATTERNS_FILE)) {
    existingData = yaml.load(fs.readFileSync(WINNING_PATTERNS_FILE, 'utf-8')) as Record<string, any>;
  }
  
  // LLMインサイトを追加
  existingData.llm_insights = {
    last_analyzed: analysis.analyzed_at,
    grok_recommendations: analysis.grok_insights.x_culture_recommendations,
    gemini_recommendations: analysis.gemini_insights.data_driven_recommendations,
    trending_elements: analysis.grok_insights.trending_elements,
    effective_hooks: analysis.gemini_insights.optimal_elements.hooks,
    effective_structures: analysis.gemini_insights.optimal_elements.structures,
    action_items: analysis.combined_action_items
  };
  
  fs.writeFileSync(WINNING_PATTERNS_FILE, yaml.dump(existingData, { lineWidth: -1 }));
  console.log('\n✅ winning_patterns.yml にLLMインサイトを追加');
}

// ===== メイン =====

async function main() {
  console.log('🤖 マルチLLM分析エンジン起動');
  console.log('='.repeat(60));
  
  const history = loadHistory();
  const postsWithMetrics = history.filter(h => h.metrics);
  
  if (postsWithMetrics.length < 5) {
    console.log('⚠️ 分析に必要な投稿数が不足しています（最低5件必要）');
    console.log(`  現在: ${postsWithMetrics.length}件`);
    return;
  }
  
  // パフォーマンス順にソート
  const sorted = [...postsWithMetrics].sort((a, b) => 
    calculateEngagementRate(b.metrics!) - calculateEngagementRate(a.metrics!)
  );
  
  // トップ5とワースト5を抽出
  const topPosts = sorted.slice(0, 5);
  const bottomPosts = sorted.slice(-5).reverse();
  
  console.log(`\n📊 分析対象: ${postsWithMetrics.length}件`);
  console.log(`  トップ5 ER範囲: ${(calculateEngagementRate(topPosts[0].metrics!) * 100).toFixed(2)}% - ${(calculateEngagementRate(topPosts[4].metrics!) * 100).toFixed(2)}%`);
  console.log(`  ワースト5 ER範囲: ${(calculateEngagementRate(bottomPosts[0].metrics!) * 100).toFixed(2)}% - ${(calculateEngagementRate(bottomPosts[4].metrics!) * 100).toFixed(2)}%`);
  
  // マルチLLM分析
  const [grokInsights, geminiInsights] = await Promise.all([
    analyzeWithGrok(topPosts, bottomPosts),
    analyzeWithGemini(topPosts, bottomPosts)
  ]);
  
  // 統合アクション生成
  const combinedActions = await generateCombinedActions(grokInsights, geminiInsights);
  
  // 分析結果を構築
  const analysis: LLMAnalysis = {
    analyzed_at: new Date().toISOString(),
    total_posts_analyzed: postsWithMetrics.length,
    grok_insights: grokInsights,
    gemini_insights: geminiInsights,
    combined_action_items: combinedActions
  };
  
  // 保存
  fs.writeFileSync(LLM_ANALYSIS_FILE, JSON.stringify(analysis, null, 2));
  console.log(`\n✅ 分析結果保存: ${LLM_ANALYSIS_FILE}`);
  
  // 勝ちパターン更新
  updateWinningPatterns(analysis);
  
  // サマリー表示
  console.log('\n' + '='.repeat(60));
  console.log('📋 分析サマリー');
  console.log('='.repeat(60));
  
  console.log('\n【Grok分析: Xカルチャー視点】');
  console.log('  バズった理由:');
  grokInsights.why_top_performed.forEach(r => console.log(`    - ${r}`));
  console.log('  取り入れるべきトレンド:');
  grokInsights.trending_elements.forEach(r => console.log(`    - ${r}`));
  
  console.log('\n【Gemini分析: ロジック視点】');
  console.log('  勝ちパターン構造:');
  geminiInsights.structural_patterns.winning.forEach(r => console.log(`    - ${r}`));
  console.log('  効果的フック:');
  geminiInsights.optimal_elements.hooks.forEach(r => console.log(`    - ${r}`));
  
  console.log('\n【次回投稿へのアクション】');
  combinedActions.forEach((a, i) => console.log(`  ${i+1}. ${a}`));
}

main().catch(console.error);
