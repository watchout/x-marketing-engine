/**
 * Grokベース コンテンツ分析エンジン
 * 
 * X API制限を回避し、投稿内容の質的分析で改善提案を生成
 * メトリクスがなくても、コンテンツパターンからPDCAを回す
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// 環境変数読み込み
function loadEnvFile(): void {
  const envFiles = ['.env.api', '.env.local', '.env'];
  const projectRoot = path.join(__dirname, '..');
  
  for (const envFile of envFiles) {
    const envPath = path.join(projectRoot, envFile);
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
            if (!process.env[key]) {
              process.env[key] = value;
            }
          }
        }
      }
      break;
    }
  }
}

loadEnvFile();

// ===== 型定義 =====

interface PostHistory {
  id: string;
  content: string;
  posted_at: string;
  slot: string;
  theme: string;
  metrics?: {
    impressions: number;
    likes: number;
    retweets: number;
  };
}

interface ContentAnalysis {
  analyzed_at: string;
  posts_analyzed: number;
  
  // Grok分析結果
  pattern_analysis: {
    strongest_posts: string[];      // 最も効果的と予測される投稿
    weakest_posts: string[];        // 改善が必要な投稿
    common_patterns: string[];      // 共通パターン
  };
  
  improvements: {
    immediate_actions: string[];    // 今すぐできる改善
    structural_changes: string[];   // 構造的な改善
    experimental_ideas: string[];   // 試してみるべきアイデア
  };
  
  next_post_template: string;       // 次回投稿のテンプレート
}

// ===== ファイルパス =====

const PROJECT_ROOT = path.join(__dirname, '..');
const HISTORY_FILE = path.join(PROJECT_ROOT, 'content/post_history.json');
const ANALYSIS_FILE = path.join(PROJECT_ROOT, 'content/grok_content_analysis.json');
const WINNING_PATTERNS_FILE = path.join(PROJECT_ROOT, 'content/winning_patterns.yml');

// ===== Grok呼び出し =====

async function callGrok(prompt: string): Promise<string> {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) {
    throw new Error('GROK_API_KEY not found');
  }
  
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
    throw new Error(`Grok API error: ${error}`);
  }
  
  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content;
}

// ===== データ読み込み =====

function loadHistory(): PostHistory[] {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
}

// ===== メイン分析 =====

async function analyzeContent(): Promise<void> {
  console.log('🔥 Grokベース コンテンツ分析');
  console.log('='.repeat(60));
  
  const history = loadHistory();
  
  // 直近7日間の投稿を取得
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentPosts = history
    .filter(h => new Date(h.posted_at).getTime() > weekAgo)
    .slice(0, 10);
  
  if (recentPosts.length < 3) {
    console.log('⚠️ 分析に必要な投稿数が不足しています（最低3件必要）');
    return;
  }
  
  console.log(`\n📝 分析対象: 直近${recentPosts.length}件の投稿`);
  
  // メトリクスがある投稿とない投稿を分離
  const withMetrics = recentPosts.filter(p => p.metrics);
  const withoutMetrics = recentPosts.filter(p => !p.metrics);
  
  // プロンプト作成
  let postsText = recentPosts.map((p, i) => {
    let metricsInfo = '';
    if (p.metrics) {
      metricsInfo = ` [Imp:${p.metrics.impressions}, Like:${p.metrics.likes}, RT:${p.metrics.retweets}]`;
    }
    return `投稿${i+1}${metricsInfo}:\n${p.content}`;
  }).join('\n\n');
  
  const prompt = `
あなたはXマーケティングの専門家です。以下の投稿を分析し、改善提案を行ってください。

【ターゲット】
- 30-50代のAIで開発を効率化したいマネージャー・経営者
- 「バイブコーディング」に課題を感じている開発者

【分析対象の投稿】
${postsText}

【分析依頼】
以下のJSON形式で回答してください:

{
  "pattern_analysis": {
    "strongest_posts": ["最も効果的と予測される投稿番号と理由を2つ"],
    "weakest_posts": ["改善が必要な投稿番号と理由を2つ"],
    "common_patterns": ["全投稿に共通するパターンを3つ"]
  },
  "improvements": {
    "immediate_actions": ["今すぐできる改善を3つ"],
    "structural_changes": ["投稿構造の改善を2つ"],
    "experimental_ideas": ["試してみるべき新しいアイデアを2つ"]
  },
  "next_post_template": "次回投稿のテンプレート（具体的な例文）"
}

JSONのみを出力してください。
`;

  console.log('\n🤖 Grok分析中...');
  
  try {
    const response = await callGrok(prompt);
    
    // JSONパース
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('❌ JSON parse error');
      console.log('Response:', response.substring(0, 500));
      return;
    }
    
    const analysisResult = JSON.parse(jsonMatch[0]);
    
    // 分析結果を構築
    const analysis: ContentAnalysis = {
      analyzed_at: new Date().toISOString(),
      posts_analyzed: recentPosts.length,
      pattern_analysis: analysisResult.pattern_analysis,
      improvements: analysisResult.improvements,
      next_post_template: analysisResult.next_post_template
    };
    
    // 保存
    fs.writeFileSync(ANALYSIS_FILE, JSON.stringify(analysis, null, 2));
    console.log(`\n✅ 分析結果保存: ${ANALYSIS_FILE}`);
    
    // winning_patterns.ymlに改善提案を追加
    updateWinningPatterns(analysis);
    
    // サマリー表示
    console.log('\n' + '='.repeat(60));
    console.log('📋 分析サマリー');
    console.log('='.repeat(60));
    
    console.log('\n【効果的な投稿の特徴】');
    analysis.pattern_analysis.strongest_posts.forEach(p => console.log(`  ✅ ${p}`));
    
    console.log('\n【改善が必要な点】');
    analysis.pattern_analysis.weakest_posts.forEach(p => console.log(`  ⚠️ ${p}`));
    
    console.log('\n【今すぐできる改善】');
    analysis.improvements.immediate_actions.forEach((a, i) => console.log(`  ${i+1}. ${a}`));
    
    console.log('\n【次回投稿テンプレート】');
    console.log(`  ${analysis.next_post_template}`);
    
  } catch (error: any) {
    console.error('❌ 分析エラー:', error.message);
  }
}

function updateWinningPatterns(analysis: ContentAnalysis): void {
  let existingData: Record<string, any> = {};
  
  if (fs.existsSync(WINNING_PATTERNS_FILE)) {
    existingData = yaml.load(fs.readFileSync(WINNING_PATTERNS_FILE, 'utf-8')) as Record<string, any>;
  }
  
  // Grokコンテンツ分析を追加
  existingData.grok_content_analysis = {
    last_analyzed: analysis.analyzed_at,
    immediate_actions: analysis.improvements.immediate_actions,
    structural_changes: analysis.improvements.structural_changes,
    experimental_ideas: analysis.improvements.experimental_ideas,
    next_post_template: analysis.next_post_template
  };
  
  fs.writeFileSync(WINNING_PATTERNS_FILE, yaml.dump(existingData, { lineWidth: -1 }));
  console.log('\n✅ winning_patterns.yml を更新');
}

// ===== CLI =====

async function main() {
  await analyzeContent();
}

main().catch(console.error);
