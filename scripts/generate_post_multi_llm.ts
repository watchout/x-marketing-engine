/**
 * マルチLLM推敲ループによる投稿生成スクリプト
 * 
 * 複数のLLMが何周も確認・修正を繰り返し、
 * インプの取れる高品質な投稿を生成する
 * 
 * 使い方:
 *   npx ts-node scripts/marketing/generate_post_multi_llm.ts generate
 *   npx ts-node scripts/marketing/generate_post_multi_llm.ts generate --dry-run
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
      console.log(`📁 Loading environment from: ${envFile}`);
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
      return;
    }
  }
}

loadEnvFile();

// ===== 型定義 =====

interface QualityScore {
  hook_strength: number;      // フックの強さ（0-25）
  persona_fit: number;        // ペルソナへの刺さり度（0-25）
  x_culture_fit: number;      // X文化への適合度（0-25）
  specificity: number;        // 具体性（0-15）
  credibility: number;        // 信頼性（0-10）
  total: number;              // 合計（0-100）
  feedback: string;           // 改善フィードバック
}

interface GeneratedPost {
  content: string;
  hook_type: string;
  theme: string;
  scores: QualityScore;
  rounds: number;
}

interface WinningPattern {
  id: string;
  hook_type: string;
  structure: string;
  key_elements: string[];
}

// ===== ペルソナ定義 =====

const TARGET_PERSONA = {
  name: "バイブコーディング脱却希望者",
  pain_points: [
    "AIに「いい感じにやって」と言っても結果がブレる",
    "複雑になると手戻りが多すぎる",
    "何を指示すればいいかわからない",
    "品質が安定しない",
    "AIの出力をレビューするのに時間がかかりすぎる"
  ],
  desires: [
    "再現性のあるAI開発がしたい",
    "仕様を決めれば自動で動く仕組みがほしい",
    "時間を無駄にしたくない",
    "プロダクション品質のコードを素早く作りたい"
  ],
  keywords: ["バイブコーディング", "Cursor", "AI開発", "SSOT", "dev-OS"]
};

// ===== ファイルパス =====

const PROJECT_ROOT = path.join(__dirname, '..');
const WINNING_PATTERNS_FILE = path.join(PROJECT_ROOT, 'apps/platform/ssot/winning_patterns.yml');
const AB_TEST_POOL_FILE = path.join(PROJECT_ROOT, 'content/ab_test_pool.yml');
const CONTENT_STRATEGY_FILE = path.join(PROJECT_ROOT, 'apps/platform/ssot/x_content_strategy.yml');
const OVERSEAS_INSIGHTS_FILE = path.join(PROJECT_ROOT, 'content/overseas_insights.json');

// 海外インサイトを読み込み（鮮度と日本普及度を考慮）
function loadOverseasInsights(): { 
  topic: string; 
  summary: string; 
  persona_fit: number; 
  freshness: number;
  japan_spread: number;
  priority_score: number;
  japanese_adaptation: string;
  researched_at: string;
}[] {
  try {
    if (!fs.existsSync(OVERSEAS_INSIGHTS_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(OVERSEAS_INSIGHTS_FILE, 'utf-8'));
    if (!data.ideas || !Array.isArray(data.ideas)) return [];
    
    const researchedAt = data.researched_at || new Date().toISOString();
    const hoursAgo = (Date.now() - new Date(researchedAt).getTime()) / (1000 * 60 * 60);
    
    // リサーチから24時間以上経過していたら鮮度を下げる
    const freshnessDecay = Math.max(0, Math.min(5, Math.floor(hoursAgo / 24)));
    
    return data.ideas
      .filter((idea: any) => idea.insight?.persona_fit >= 7)
      .map((idea: any) => {
        const freshness = Math.max(1, (idea.insight?.freshness || 5) - freshnessDecay);
        const japanSpread = idea.insight?.japan_spread || 5;
        const personaFit = idea.insight?.persona_fit || 0;
        const priorityScore = Math.round((freshness * (10 - japanSpread) * personaFit) / 10);
        
        return {
          topic: idea.insight?.topic || '',
          summary: idea.insight?.summary || '',
          persona_fit: personaFit,
          freshness,
          japan_spread: japanSpread,
          priority_score: priorityScore,
          japanese_adaptation: idea.japanese_adaptation || '',
          researched_at: researchedAt
        };
      })
      .filter((i: any) => i.priority_score >= 20) // 優先度20以上のみ
      .sort((a: any, b: any) => b.priority_score - a.priority_score);
  } catch (e) {
    console.log('⚠️ 海外インサイト読み込み失敗');
    return [];
  }
}

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
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'grok-3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.8
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.warn(`⚠️ Grok API error: ${error}, using GPT as fallback`);
      return callGPT(prompt);
    }
    
    const data = await response.json() as any;
    return data.choices[0].message.content;
  } catch (e) {
    console.warn(`⚠️ Grok error: ${e}, using GPT as fallback`);
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
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GPT API error: ${error}`);
  }
  
  const data = await response.json() as any;
  return data.choices[0].message.content;
}

async function callClaude(prompt: string): Promise<string> {
  // Gemini を Claude の代わりに使用（Anthropic APIキーがないため）
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ GOOGLE_AI_API_KEY not found, using GPT as fallback');
    return callGPT(prompt);
  }
  
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7 }
        })
      }
    );
    
    if (!response.ok) {
      const error = await response.text();
      console.warn(`⚠️ Gemini API error: ${error}, using GPT as fallback`);
      return callGPT(prompt);
    }
    
    const data = await response.json() as any;
    return data.candidates[0].content.parts[0].text;
  } catch (e) {
    console.warn(`⚠️ Gemini error: ${e}, using GPT as fallback`);
    return callGPT(prompt);
  }
}

// ===== 勝ちパターン読み込み =====

function loadWinningPatterns(): WinningPattern[] {
  if (!fs.existsSync(WINNING_PATTERNS_FILE)) {
    return [];
  }
  
  const content = fs.readFileSync(WINNING_PATTERNS_FILE, 'utf-8');
  const data = yaml.load(content) as any;
  
  return data?.patterns || [];
}

// ===== Round 1: ネタ選定 =====

async function selectTopic(): Promise<{ topic: string; reason: string }> {
  console.log('\n📝 Round 1: ネタ選定...');
  
  const patterns = loadWinningPatterns();
  const patternSummary = patterns.slice(0, 5).map(p => 
    `- ${p.hook_type}: ${p.key_elements?.join(', ') || 'なし'}`
  ).join('\n');
  
  // Grok: トレンド・ネタ提案
  // 海外インサイトを読み込み（優先度順）
  const overseasInsights = loadOverseasInsights();
  let overseasSection = '';
  
  if (overseasInsights.length > 0) {
    const hoursAgo = Math.round((Date.now() - new Date(overseasInsights[0].researched_at).getTime()) / (1000 * 60 * 60));
    overseasSection = `
【海外AIトレンド（${hoursAgo}時間前にリサーチ）】
${overseasInsights.slice(0, 3).map((i, idx) => {
  const urgency = i.freshness >= 8 ? '🔥今すぐ発信価値あり' : 
                  i.freshness >= 5 ? '⏰早めに発信推奨' : '📅発信可能';
  return `${idx + 1}. ${i.topic}: ${i.summary}
   鮮度: ${i.freshness}/10 | 日本普及度: ${i.japan_spread}/10 | 優先度: ${i.priority_score}
   ${urgency}`;
}).join('\n')}

※鮮度が高く日本で広まっていないものを優先してください。
※海外トレンドから最低1つは必ずネタに含めてください。`;
  }

  const grokPrompt = `
あなたはXで日本のAI開発者向けにバズる投稿を分析する専門家です。

【ターゲット】
${TARGET_PERSONA.name}
ペイン: ${TARGET_PERSONA.pain_points.join('、')}

【最近の勝ちパターン】
${patternSummary || '（データなし）'}
${overseasSection}

【依頼】
今のXトレンドと上記の海外トレンドを踏まえ、ターゲットに刺さるネタを3つ提案してください。
※海外トレンドから1つは必ず含めてください（日本で先取り発信する価値があります）

各ネタについて、なぜ刺さるかの理由も添えてください。

出力形式:
1. [ネタ1]
   理由: [理由]
   海外参照: [あり/なし]
2. [ネタ2]
   理由: [理由]
   海外参照: [あり/なし]
3. [ネタ3]
   理由: [理由]
   海外参照: [あり/なし]
`;
  
  const grokResponse = await callGrok(grokPrompt);
  console.log('  Grok: ネタ3つ提案 ✓');
  
  // Claude(Gemini): 最適なネタを選定
  const claudePrompt = `
あなたはdev-OS（AI開発の仕様管理ツール）のマーケティング担当です。

【ターゲットペルソナ】
名前: ${TARGET_PERSONA.name}
ペイン:
${TARGET_PERSONA.pain_points.map(p => `- ${p}`).join('\n')}

欲しいもの:
${TARGET_PERSONA.desires.map(d => `- ${d}`).join('\n')}

【Grokの提案】
${grokResponse}

【依頼】
上記3つのネタから、最もターゲットのペインに刺さり、dev-OSの価値を伝えられるものを1つ選んでください。

出力形式（JSON）:
{
  "selected": 1,
  "topic": "選んだネタの要約",
  "reason": "選んだ理由"
}
`;
  
  const claudeResponse = await callClaude(claudePrompt);
  console.log('  Claude(Gemini): ネタ選定 ✓');
  
  // JSONパース
  try {
    const jsonMatch = claudeResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return { topic: result.topic, reason: result.reason };
    }
  } catch (e) {
    // パース失敗時はそのまま使用
  }
  
  return { topic: claudeResponse.substring(0, 200), reason: '自動選定' };
}

// ===== Round 2: 初稿生成 =====

async function generateDraft(topic: string): Promise<string> {
  console.log('\n✏️ Round 2: 初稿生成...');
  
  const patterns = loadWinningPatterns();
  const latestPattern = patterns[0];
  
  const prompt = `
あなたはXでバズる投稿を作成する専門家です。

【テーマ】
${topic}

【ターゲット】
${TARGET_PERSONA.name}
ペイン: ${TARGET_PERSONA.pain_points.slice(0, 3).join('、')}

【成功パターン参考】
${latestPattern ? `
フック: ${latestPattern.hook_type}
構造: ${latestPattern.structure}
要素: ${latestPattern.key_elements?.join('、')}
` : '「正直、」で始まり、問題提起→解決策→行動促進の構造'}

【要件】
1. 280文字以内
2. 冒頭で注意を引くフック（「正直、」「断言します」等）
3. ターゲットのペインに刺さる内容
4. dev-OSやSSOTの価値を間接的に伝える
5. ハッシュタグは2-3個

【出力】
投稿文のみを出力してください（説明不要）
`;
  
  const draft = await callClaude(prompt);
  console.log('  初稿生成 ✓');
  
  return draft.trim();
}

// ===== Round 3-5: 批評・改善ループ =====

async function evaluateAndScore(content: string, evaluator: string): Promise<QualityScore> {
  const prompt = `
あなたはXマーケティングの専門家として、以下の投稿を評価してください。

【投稿】
${content}

【ターゲット】
${TARGET_PERSONA.name}
ペイン: ${TARGET_PERSONA.pain_points.join('、')}

【評価基準】
1. hook_strength（0-25）: 最初の1行で読者が止まるか
2. persona_fit（0-25）: ターゲットのペインに刺さるか
3. x_culture_fit（0-25）: Xの投稿として自然か、嘘っぽくないか
4. specificity（0-15）: 具体的な価値が伝わるか
5. credibility（0-10）: 信頼できる内容か

【出力形式（JSON）】
{
  "hook_strength": 20,
  "persona_fit": 18,
  "x_culture_fit": 22,
  "specificity": 12,
  "credibility": 8,
  "total": 80,
  "feedback": "改善すべき点や提案"
}
`;
  
  let response: string;
  switch (evaluator) {
    case 'grok':
      response = await callGrok(prompt);
      break;
    case 'gpt':
      response = await callGPT(prompt);
      break;
    default:
      response = await callClaude(prompt);
  }
  
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const score = JSON.parse(jsonMatch[0]);
      score.total = (score.hook_strength || 0) + (score.persona_fit || 0) + 
                    (score.x_culture_fit || 0) + (score.specificity || 0) + 
                    (score.credibility || 0);
      return score;
    }
  } catch (e) {
    // パース失敗
  }
  
  return {
    hook_strength: 15,
    persona_fit: 15,
    x_culture_fit: 15,
    specificity: 10,
    credibility: 5,
    total: 60,
    feedback: response.substring(0, 200)
  };
}

async function improveContent(content: string, feedbacks: string[]): Promise<string> {
  const prompt = `
あなたはXでバズる投稿を作成する専門家です。

【現在の投稿】
${content}

【改善フィードバック】
${feedbacks.map((f, i) => `${i + 1}. ${f}`).join('\n')}

【要件】
- 280文字以内を維持
- フィードバックを反映して改善
- フックは強くする
- 自然なX投稿にする

【出力】
改善した投稿文のみを出力（説明不要）
`;
  
  const improved = await callClaude(prompt);
  return improved.trim();
}

async function refinementLoop(draft: string, maxRounds: number = 3): Promise<{ content: string; scores: QualityScore; rounds: number }> {
  console.log('\n🔄 Round 3-5: 批評・改善ループ...');
  
  let content = draft;
  let bestScore: QualityScore = { hook_strength: 0, persona_fit: 0, x_culture_fit: 0, specificity: 0, credibility: 0, total: 0, feedback: '' };
  const THRESHOLD = 75;
  
  for (let round = 1; round <= maxRounds; round++) {
    console.log(`\n  ラウンド ${round}/${maxRounds}:`);
    
    // 各LLMで評価
    const [gptScore, claudeScore, grokScore] = await Promise.all([
      evaluateAndScore(content, 'gpt'),
      evaluateAndScore(content, 'claude'),
      evaluateAndScore(content, 'grok')
    ]);
    
    console.log(`    GPT: ${gptScore.total}点`);
    console.log(`    Claude: ${claudeScore.total}点`);
    console.log(`    Grok: ${grokScore.total}点`);
    
    // 平均スコア計算
    const avgScore: QualityScore = {
      hook_strength: Math.round((gptScore.hook_strength + claudeScore.hook_strength + grokScore.hook_strength) / 3),
      persona_fit: Math.round((gptScore.persona_fit + claudeScore.persona_fit + grokScore.persona_fit) / 3),
      x_culture_fit: Math.round((gptScore.x_culture_fit + claudeScore.x_culture_fit + grokScore.x_culture_fit) / 3),
      specificity: Math.round((gptScore.specificity + claudeScore.specificity + grokScore.specificity) / 3),
      credibility: Math.round((gptScore.credibility + claudeScore.credibility + grokScore.credibility) / 3),
      total: 0,
      feedback: [gptScore.feedback, claudeScore.feedback, grokScore.feedback].filter(f => f).join(' | ')
    };
    avgScore.total = avgScore.hook_strength + avgScore.persona_fit + avgScore.x_culture_fit + 
                     avgScore.specificity + avgScore.credibility;
    
    console.log(`    → 平均: ${avgScore.total}点`);
    bestScore = avgScore;
    
    // 閾値超えたら終了
    if (avgScore.total >= THRESHOLD) {
      console.log(`  ✅ 閾値(${THRESHOLD})クリア！`);
      return { content, scores: avgScore, rounds: round };
    }
    
    // 改善
    if (round < maxRounds) {
      console.log(`    → 改善中...`);
      const feedbacks = [gptScore.feedback, claudeScore.feedback, grokScore.feedback].filter(f => f);
      content = await improveContent(content, feedbacks);
    }
  }
  
  return { content, scores: bestScore, rounds: maxRounds };
}

// ===== Round 6: A/B生成 =====

async function generateVariantB(contentA: string): Promise<string> {
  console.log('\n🔀 Round 6: A/Bバリアント生成...');
  
  const prompt = `
あなたはXでバズる投稿を作成する専門家です。

【元の投稿（Aパターン）】
${contentA}

【依頼】
同じ内容・メッセージを伝えつつ、別のフックやアプローチでBパターンを作成してください。

変更例:
- フックを変える（「正直、」→「断言します」等）
- 構成を変える（問題提起→具体例→結論）
- トーンを変える（挑発的→共感的）

【要件】
- 280文字以内
- 伝えるメッセージは同じ
- フックやアプローチは明確に異なる

【出力】
Bパターンの投稿文のみを出力（説明不要）
`;
  
  const variantB = await callClaude(prompt);
  console.log('  Bパターン生成 ✓');
  
  return variantB.trim();
}

// ===== メイン処理 =====

async function generatePost(dryRun: boolean = false): Promise<void> {
  console.log('\n🚀 マルチLLM推敲ループ開始\n');
  console.log('='.repeat(50));
  
  // Round 1: ネタ選定
  const { topic, reason } = await selectTopic();
  console.log(`\n選定ネタ: ${topic}`);
  console.log(`理由: ${reason}`);
  
  // Round 2: 初稿生成
  const draft = await generateDraft(topic);
  console.log(`\n--- 初稿 ---\n${draft}\n-----------`);
  
  // Round 3-5: 批評・改善ループ
  const { content: contentA, scores, rounds } = await refinementLoop(draft);
  console.log(`\n--- 最終版A (${rounds}ラウンド, ${scores.total}点) ---\n${contentA}\n-----------`);
  
  // Round 6: A/B生成
  const contentB = await generateVariantB(contentA);
  console.log(`\n--- Bパターン ---\n${contentB}\n-----------`);
  
  // スコア内訳
  console.log('\n📊 スコア内訳:');
  console.log(`  フック強度: ${scores.hook_strength}/25`);
  console.log(`  ペルソナ適合: ${scores.persona_fit}/25`);
  console.log(`  X文化適合: ${scores.x_culture_fit}/25`);
  console.log(`  具体性: ${scores.specificity}/15`);
  console.log(`  信頼性: ${scores.credibility}/10`);
  console.log(`  合計: ${scores.total}/100`);
  
  if (dryRun) {
    console.log('\n🔍 DRY RUN - 投稿プールへの追加をスキップ');
    return;
  }
  
  // 投稿プールに追加
  const postEntry = {
    id: `post_${Date.now()}`,
    generated_at: new Date().toISOString(),
    topic: topic,
    theme: 'バイブコーディングの限界',
    type: 'problem_statement',
    quality_score: scores.total,
    refinement_rounds: rounds,
    variants: {
      A: {
        content: contentA,
        hook_type: 'フック型A'
      },
      B: {
        content: contentB,
        hook_type: 'フック型B'
      }
    },
    scores: scores,
    status: 'pending'
  };
  
  // YAMLに追加
  let pool: any = { posts: [] };
  if (fs.existsSync(AB_TEST_POOL_FILE)) {
    pool = yaml.load(fs.readFileSync(AB_TEST_POOL_FILE, 'utf-8')) as any || { posts: [] };
  }
  
  pool.posts = pool.posts || [];
  pool.posts.unshift(postEntry);
  
  // 最大50件まで保持
  pool.posts = pool.posts.slice(0, 50);
  
  fs.writeFileSync(AB_TEST_POOL_FILE, yaml.dump(pool, { lineWidth: -1 }));
  console.log(`\n✅ 投稿プールに追加: ${AB_TEST_POOL_FILE}`);
  
  console.log('\n='.repeat(50));
  console.log('🎉 生成完了！');
}

// ===== CLI =====

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const dryRun = args.includes('--dry-run');
  
  switch (command) {
    case 'generate':
      await generatePost(dryRun);
      break;
      
    case 'help':
    default:
      console.log(`
マルチLLM推敲ループ投稿生成スクリプト

使い方:
  npx ts-node scripts/marketing/generate_post_multi_llm.ts <command>

コマンド:
  generate          投稿を生成してプールに追加
  generate --dry-run 投稿を生成（プールには追加しない）

例:
  npx ts-node scripts/marketing/generate_post_multi_llm.ts generate
  npx ts-node scripts/marketing/generate_post_multi_llm.ts generate --dry-run
      `);
  }
}

main().catch(console.error);
