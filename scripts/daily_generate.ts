/**
 * 日次自動投稿生成スクリプト
 *
 * 毎朝JST 06:00にGH Actionsで実行。
 * overseas_insights + learning_state から Thompson Sampling でテーマを選び、
 * LLMで3投稿（morning/noon/night）を自動生成してプールに投入する。
 *
 * 使い方:
 *   npx ts-node scripts/daily_generate.ts              # 通常実行
 *   npx ts-node scripts/daily_generate.ts --dry-run    # プール書き込みなし
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// ===== 環境変数読み込み =====
function loadEnvFile(): void {
  const envFiles = ['.env.api', '.env.local', '.env'];
  const projectRoot = path.join(__dirname, '..');
  for (const envFile of envFiles) {
    const envPath = path.join(projectRoot, envFile);
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
      return;
    }
  }
}
loadEnvFile();

// ===== 定数 =====
const PROJECT_ROOT = path.join(__dirname, '..');
const OVERSEAS_INSIGHTS_FILE = path.join(PROJECT_ROOT, 'content/overseas_insights.json');
const LEARNING_STATE_FILE = path.join(PROJECT_ROOT, 'content/learning_state.json');
const RECOMMENDATION_FILE = path.join(PROJECT_ROOT, 'content/next_recommendation.json');
const PAIN_HYPOTHESIS_FILE = path.join(PROJECT_ROOT, 'content/pain_hypothesis_log.yml');
const PERSONA_FILE = path.join(PROJECT_ROOT, 'config/target_persona.yml');
const POOL_FILE = path.join(PROJECT_ROOT, 'content/ab_test_pool.yml');
const HISTORY_FILE = path.join(PROJECT_ROOT, 'content/post_history.json');
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://x-marketing-engine.vercel.app';

const SLOTS = ['morning', 'noon', 'night'] as const;

// ハルシネーション防止：既知ツール名ホワイトリスト
const KNOWN_TOOLS = new Set([
  'ChatGPT', 'GPT-4', 'GPT-4o', 'GPT-4.5', 'GPT-5',
  'Claude', 'Claude Code', 'Claude 3', 'Claude 3.5', 'Claude 4',
  'Cursor', 'Copilot', 'GitHub Copilot',
  'Gemini', 'Grok', 'Llama', 'Mistral', 'DeepSeek',
  'Xcode', 'VS Code', 'Windsurf', 'Cline', 'Aider', 'Continue',
  'LangChain', 'LangGraph', 'LangSmith', 'LlamaIndex',
  'MCP', 'Model Context Protocol',
  'Vercel', 'Supabase', 'Firebase', 'AWS', 'Azure', 'GCP',
  'React', 'Next.js', 'TypeScript', 'Python', 'Rust',
  'Stable Diffusion', 'Midjourney', 'DALL-E', 'Sora',
  'Perplexity', 'Replit', 'v0', 'Bolt', 'Lovable',
  'OpenAI', 'Anthropic', 'Google', 'Meta', 'Apple', 'NVIDIA',
  'Hugging Face', 'arXiv', 'Notion', 'Slack', 'Discord',
  'Docker', 'Kubernetes', 'Terraform',
  'Structured Outputs', 'JSON', 'REST', 'GraphQL', 'WebSocket',
  'Prompt Caching', 'RAG', 'Fine-tuning', 'RLHF', 'LoRA',
  'Agent', 'Agentic', 'Tool Use', 'Function Calling',
  'Transformer', 'Attention', 'Embedding',
  'Orchestration', 'Pipeline', 'Workflow', 'Framework',
]);

// ===== 型定義 =====
interface BetaParams {
  alpha: number;
  beta: number;
  trials: number;
  mean: number;
}

interface LearningState {
  theme_scores: Record<string, BetaParams>;
  approach_scores: Record<string, BetaParams>;
  slot_scores: Record<string, BetaParams>;
  [key: string]: any;
}

interface OverseasInsight {
  topic: string;
  summary: string;
  persona_fit: number;
  freshness: number;
  japan_spread: number;
  priority_score: number;
  japanese_adaptation: string;
}

interface ThemeCandidate {
  name: string;
  source: 'overseas' | 'learning' | 'recommendation';
  insight?: OverseasInsight;
  tsParams: BetaParams;
  sample: number;
  boosted: number;
}

interface GeneratedPost {
  id: string;
  generated_at: string;
  scheduled_date: string;
  slot: string;
  topic: string;
  theme: string;
  type: string;
  quality_score: number;
  refinement_rounds: number;
  variants: {
    A: { content: string; hook_type: string };
    B: { content: string; hook_type: string };
  };
  scores: {
    hook_strength: number;
    persona_fit: number;
    x_culture_fit: number;
    specificity: number;
    credibility: number;
    total: number;
    feedback: string;
  };
  status: string;
  source: string;
}

interface QualityScore {
  hook_strength: number;
  persona_fit: number;
  x_culture_fit: number;
  specificity: number;
  credibility: number;
  total: number;
  feedback: string;
}

// ===== Thompson Sampling（auto_post.ts L129-172 から移植）=====

function sampleBeta(alpha: number, beta: number): number {
  if (alpha <= 0 || beta <= 0) return 0.5;
  const gammaA = sampleGamma(alpha);
  const gammaB = sampleGamma(beta);
  if (gammaA + gammaB === 0) return 0.5;
  return gammaA / (gammaA + gammaB);
}

function sampleGamma(shape: number): number {
  if (shape < 1) {
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1.0 / shape);
  }
  const d = shape - 1.0 / 3.0;
  const c = 1.0 / Math.sqrt(9.0 * d);
  while (true) {
    let x: number, v: number;
    do {
      x = normalRandom();
      v = 1.0 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1.0 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1.0 - v + Math.log(v))) return d * v;
  }
}

function normalRandom(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ===== データ読み込み =====

function loadOverseasInsights(): OverseasInsight[] {
  try {
    if (!fs.existsSync(OVERSEAS_INSIGHTS_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(OVERSEAS_INSIGHTS_FILE, 'utf-8'));
    if (!data.insights && !data.ideas) return [];

    const items = data.ideas || data.insights || [];
    const researchedAt = data.researched_at || new Date().toISOString();
    const hoursAgo = (Date.now() - new Date(researchedAt).getTime()) / (1000 * 60 * 60);
    const freshnessDecay = Math.max(0, Math.min(5, Math.floor(hoursAgo / 24)));

    return items
      .filter((item: any) => {
        const insight = item.insight || item;
        return (insight.persona_fit || 0) >= 7;
      })
      .map((item: any) => {
        const insight = item.insight || item;
        const freshness = Math.max(1, (insight.freshness || 5) - freshnessDecay);
        const japanSpread = insight.japan_spread || 5;
        const personaFit = insight.persona_fit || 0;
        const priorityScore = Math.round((freshness * (10 - japanSpread) * personaFit) / 10);
        return {
          topic: insight.topic || '',
          summary: insight.summary || '',
          persona_fit: personaFit,
          freshness,
          japan_spread: japanSpread,
          priority_score: priorityScore,
          japanese_adaptation: item.japanese_adaptation || insight.japanese_adaptation || '',
        };
      })
      .filter((i: OverseasInsight) => i.priority_score >= 20)
      .sort((a: OverseasInsight, b: OverseasInsight) => b.priority_score - a.priority_score);
  } catch (e) {
    console.log('⚠️ overseas_insights.json 読み込み失敗');
    return [];
  }
}

function loadLearningState(): LearningState | null {
  try {
    if (!fs.existsSync(LEARNING_STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(LEARNING_STATE_FILE, 'utf-8'));
  } catch { return null; }
}

function loadRecommendation(): any | null {
  try {
    if (!fs.existsSync(RECOMMENDATION_FILE)) return null;
    const rec = JSON.parse(fs.readFileSync(RECOMMENDATION_FILE, 'utf-8'));
    const age = Date.now() - new Date(rec.generated_at).getTime();
    if (age > 7 * 24 * 60 * 60 * 1000) return null;
    return rec;
  } catch { return null; }
}

function loadAccumulatedLearnings(): string[] {
  try {
    if (!fs.existsSync(PAIN_HYPOTHESIS_FILE)) return [];
    const data = yaml.load(fs.readFileSync(PAIN_HYPOTHESIS_FILE, 'utf-8')) as any;
    return data.accumulated_learnings || [];
  } catch { return []; }
}

function loadPersonaSummary(): string {
  try {
    if (!fs.existsSync(PERSONA_FILE)) return '';
    const data = yaml.load(fs.readFileSync(PERSONA_FILE, 'utf-8')) as any;
    const surfacePains = (data.psychology?.surface_pain || []).slice(0, 4).join('\n- ');
    const desires = (data.psychology?.desire || []).slice(0, 3).join('\n- ');
    return `ターゲット: ${data.who || ''}\n表面の悩み:\n- ${surfacePains}\n本当に欲しいもの:\n- ${desires}`;
  } catch { return ''; }
}

function loadPool(): any {
  try {
    if (!fs.existsSync(POOL_FILE)) return { posts: [] };
    return yaml.load(fs.readFileSync(POOL_FILE, 'utf-8')) as any;
  } catch { return { posts: [] }; }
}

function loadHistory(): any[] {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch { return []; }
}

function getTodayJST(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().split('T')[0];
}

// ===== LLM呼び出し（generate_post_multi_llm.ts L205-301 から移植）=====

async function callGrok(prompt: string): Promise<string> {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) throw new Error('GROK_API_KEY not found');

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
    throw new Error(`Grok API error: ${error}`);
  }

  const data = await response.json() as any;
  return data.choices[0].message.content;
}

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
        generationConfig: { temperature: 0.7 }
      })
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${error}`);
  }

  const data = await response.json() as any;
  return data.candidates[0].content.parts[0].text;
}

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

async function callBestLLM(prompt: string): Promise<string> {
  const attempts: Array<{ name: string; fn: () => Promise<string> }> = [
    { name: 'Grok', fn: () => callGrok(prompt) },
    { name: 'Gemini', fn: () => callGemini(prompt) },
    { name: 'GPT', fn: () => callGPT(prompt) },
  ];

  for (const attempt of attempts) {
    try {
      const result = await attempt.fn();
      console.log(`  ✅ ${attempt.name} で生成成功`);
      return result;
    } catch (e: any) {
      console.log(`  ⚠️ ${attempt.name} 失敗: ${e.message?.slice(0, 80)}`);
    }
  }
  throw new Error('全LLM API呼び出し失敗');
}

// ===== テーマ選定 =====

function selectThemes(
  insights: OverseasInsight[],
  learningState: LearningState | null,
  history: any[],
  count: number = 3
): ThemeCandidate[] {
  const defaultPrior: BetaParams = { alpha: 0.3, beta: 0.7, trials: 0, mean: 0.3 };
  const themeScores = learningState?.theme_scores || {};

  // 候補を集める
  const candidates: ThemeCandidate[] = [];

  // 1. overseas insights からテーマ候補
  for (const insight of insights.slice(0, 5)) {
    const name = insight.topic;
    const params = themeScores[name] || defaultPrior;
    const sample = sampleBeta(params.alpha, params.beta);
    candidates.push({
      name,
      source: 'overseas',
      insight,
      tsParams: params,
      sample,
      boosted: sample,
    });
  }

  // 2. learning_state の既知テーマから候補（既にoverseasにあるものは除外）
  const overseasNames = new Set(candidates.map(c => c.name));
  for (const [name, params] of Object.entries(themeScores)) {
    if (overseasNames.has(name)) continue;
    if (name === 'バイブコーディングの限界') continue; // 学びから明示的に除外
    const sample = sampleBeta(params.alpha, params.beta);
    candidates.push({
      name,
      source: 'learning',
      tsParams: params,
      sample,
      boosted: sample,
    });
  }

  // 3. 推薦テーマがあればそれも候補に
  const rec = loadRecommendation();
  if (rec?.recommended?.theme) {
    const recTheme = rec.recommended.theme;
    if (!candidates.find(c => c.name === recTheme)) {
      const params = themeScores[recTheme] || defaultPrior;
      const sample = sampleBeta(params.alpha, params.beta);
      candidates.push({
        name: recTheme,
        source: 'recommendation',
        tsParams: params,
        sample,
        boosted: sample,
      });
    }
  }

  // ブースト＆ペナルティ適用
  const today = getTodayJST();
  const twoDaysAgo = new Date(new Date(today).getTime() - 2 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];

  // 過去2日間に使用されたテーマを取得
  const recentThemes = new Set(
    history
      .filter(h => h.posted_at && h.posted_at.split('T')[0] >= twoDaysAgo)
      .map(h => h.theme)
      .filter(Boolean)
  );

  for (const c of candidates) {
    // トレンドブースト: freshness >= 8 & japan_spread <= 3
    if (c.insight && c.insight.freshness >= 8 && c.insight.japan_spread <= 3) {
      c.boosted = Math.min(1.0, c.sample * 1.5);
    }

    // 繰り返しペナルティ: 過去2日間に使用したテーマ
    if (recentThemes.has(c.name)) {
      c.boosted *= 0.3;
    }
  }

  // ソートして上位 count 件を選出
  candidates.sort((a, b) => b.boosted - a.boosted);

  console.log('\n🎰 Thompson Sampling テーマ選定:');
  for (const c of candidates.slice(0, 8)) {
    const boost = c.boosted !== c.sample ? ` → boosted=${c.boosted.toFixed(4)}` : '';
    const recent = recentThemes.has(c.name) ? ' [繰返ペナルティ]' : '';
    console.log(`  ${c.source === 'overseas' ? '🌐' : '📊'} ${c.name}: ` +
      `α=${c.tsParams.alpha.toFixed(2)}, β=${c.tsParams.beta.toFixed(2)}, ` +
      `sample=${c.sample.toFixed(4)}${boost}${recent}`);
  }

  // 重複テーマを避けて上位 count 件選出
  const selected: ThemeCandidate[] = [];
  for (const c of candidates) {
    if (selected.length >= count) break;
    if (!selected.find(s => s.name === c.name)) {
      selected.push(c);
    }
  }

  console.log(`\n✅ 選定テーマ (${selected.length}件):`);
  for (let i = 0; i < selected.length; i++) {
    console.log(`  ${SLOTS[i]}: 「${selected[i].name}」(boosted=${selected[i].boosted.toFixed(4)}, source=${selected[i].source})`);
  }

  return selected;
}

// ===== アプローチ選定 =====

function selectApproach(learningState: LearningState | null): string {
  const approachScores = learningState?.approach_scores || {};
  const defaultPrior: BetaParams = { alpha: 0.3, beta: 0.7, trials: 0, mean: 0.3 };

  // thread, discovery, problem_statement, tips, empathy, warning, solution
  const approaches = ['thread', 'discovery', 'problem_statement', 'warning', 'empathy', 'solution', 'tips'];
  let bestApproach = 'discovery';
  let bestSample = -1;

  for (const approach of approaches) {
    const params = approachScores[approach] || defaultPrior;
    const sample = sampleBeta(params.alpha, params.beta);
    if (sample > bestSample) {
      bestSample = sample;
      bestApproach = approach;
    }
  }

  return bestApproach;
}

// ===== 投稿生成 =====

async function generatePost(
  theme: ThemeCandidate,
  slot: string,
  approach: string,
  persona: string,
  learnings: string[]
): Promise<{ variantA: string; variantB: string }> {
  const insightContext = theme.insight
    ? `\n【今日のトレンド情報】\nトピック: ${theme.insight.topic}\n要約: ${theme.insight.summary}\n日本向け翻案: ${theme.insight.japanese_adaptation}\n`
    : '';

  const learningsText = learnings.length > 0
    ? `\n【過去の学び（必ず守ること）】\n${learnings.map(l => `- ${l}`).join('\n')}\n`
    : '';

  const approachGuide: Record<string, string> = {
    thread: '体験談・ストーリー形式で読者を引き込む。「〜した結果」「〜だった」',
    discovery: '「知ってた？」「意外な事実」型。新発見を伝える驚きのフック',
    problem_statement: '問題提起型。「〜で困ってない？」読者の悩みに刺さるフック',
    warning: '警告型。「〜しないとヤバい」危機感で行動を促す',
    empathy: '共感型。「わかる」「自分もそうだった」読者の気持ちに寄り添う',
    solution: '解決策型。「〜したら解決した」具体的なHow-toを示す',
    tips: 'Tips型。「これ試してみて」実践的なテクニックを共有',
  };

  const prompt = `あなたはAIトレンドに詳しいXインフルエンサーです。
フォロワー24人のアカウントが成長するための投稿を作成してください。

【テーマ】${theme.name}
${insightContext}
【ペルソナ】
${persona}

【アプローチ】${approach}: ${approachGuide[approach] || approachGuide.discovery}

${learningsText}

【最重要ルール：文字数】
投稿は必ず200文字以上280文字以下にしてください。
短すぎると情報不足、長すぎるとスクロールされます。
X Premium対応のため、旧来の140文字制限は撤廃されています。
200-280文字の範囲で、深みのある内容を書いてください。

【その他のルール】
1. 具体的な数字を必ず1つ以上含める
2. 絵文字を1〜2個含める（多すぎない）
3. ハッシュタグは絶対に使わない
4. 存在しないツール名は絶対に使わない
5. 「フォローして」「〜しましょう」「断言します」「試してみて」は使わない
6. 自然な一人語り・つぶやきトーン
7. 実体験ベースで語る（「触ってみたら」「使ってみた結果」）

【出力】
Variant A（感情型・カジュアル体験談風）の投稿文のみを出力してください。
説明やメタ情報は不要です。投稿文だけを書いてください。
必ず200文字以上にしてください。`;

  const variantA = (await callBestLLM(prompt)).trim()
    .replace(/^["「]/, '').replace(/["」]$/, '')
    .replace(/^Variant\s*A[：:]\s*/i, '')
    .replace(/^【.*?】\s*/, '')
    .trim();

  const promptB = `以下のX投稿を「丁寧で知的な語り口」にトーン変換してください。
内容は同じまま、ですます調ではなく「〜だ」「〜だろう」の硬質な語り口にしてください。
必ず200文字以上280文字以下に収めてください。投稿文のみ出力してください。

元の投稿:
${variantA}`;

  const variantB = (await callBestLLM(promptB)).trim()
    .replace(/^["「]/, '').replace(/["」]$/, '')
    .replace(/^Variant\s*B[：:]\s*/i, '')
    .replace(/^【.*?】\s*/, '')
    .trim();

  return { variantA, variantB };
}

// ===== 品質評価 =====

async function evaluatePost(content: string): Promise<QualityScore> {
  const prompt = `以下のX投稿を評価してください。JSONのみ出力してください。

【投稿】
${content}

【評価基準】
- hook_strength (0-25): スクロールを止める力
- persona_fit (0-25): AIに興味のあるエンジニア・ビジネスパーソンに刺さるか
- x_culture_fit (0-25): X文化に適合しているか（売り込み臭なし、ハッシュタグなし）
- specificity (0-15): 具体的な数字・ツール名・事例があるか
- credibility (0-10): 信じられる内容か（ハルシネーションがないか）

【出力形式】JSONのみ:
{"hook_strength":N,"persona_fit":N,"x_culture_fit":N,"specificity":N,"credibility":N,"total":N,"feedback":"改善点"}`;

  try {
    const result = await callBestLLM(prompt);
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { hook_strength: 15, persona_fit: 15, x_culture_fit: 15, specificity: 10, credibility: 7, total: 62, feedback: 'JSON解析失敗' };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      hook_strength: parsed.hook_strength || 0,
      persona_fit: parsed.persona_fit || 0,
      x_culture_fit: parsed.x_culture_fit || 0,
      specificity: parsed.specificity || 0,
      credibility: parsed.credibility || 0,
      total: parsed.total || (parsed.hook_strength + parsed.persona_fit + parsed.x_culture_fit + parsed.specificity + parsed.credibility),
      feedback: parsed.feedback || '',
    };
  } catch {
    return { hook_strength: 15, persona_fit: 15, x_culture_fit: 15, specificity: 10, credibility: 7, total: 62, feedback: '評価エラー' };
  }
}

// ===== ハルシネーションチェック =====

function checkHallucination(content: string): string[] {
  // 英語の固有名詞（大文字始まり2語以上、またはCamelCase）を抽出
  const toolPattern = /(?:[A-Z][a-z]+(?:\s[A-Z][a-z]+)*|[A-Z][a-zA-Z]+\d*(?:\.\d+)?)/g;
  const matches = content.match(toolPattern) || [];

  const suspicious: string[] = [];
  for (const match of matches) {
    const normalized = match.trim();
    if (normalized.length < 3) continue;
    // ホワイトリストに含まれていないかチェック
    let found = false;
    for (const known of KNOWN_TOOLS) {
      if (known.toLowerCase() === normalized.toLowerCase() ||
          known.toLowerCase().includes(normalized.toLowerCase()) ||
          normalized.toLowerCase().includes(known.toLowerCase())) {
        found = true;
        break;
      }
    }
    // 一般的な英単語は除外
    const commonWords = new Set(['The', 'This', 'That', 'What', 'How', 'Why', 'When', 'Where', 'With', 'From', 'Into', 'Over', 'Under', 'After', 'Before', 'During', 'Between', 'Through', 'About', 'Against', 'Among', 'Around', 'Behind', 'Below', 'Beyond', 'But', 'For', 'Like', 'Near', 'Since', 'Until', 'Upon', 'Within', 'Without', 'API', 'SDK', 'CLI', 'IDE', 'OSS', 'SaaS', 'Dev', 'Pro', 'Max', 'Air', 'Ultra']);
    if (commonWords.has(normalized)) continue;

    if (!found && normalized.length >= 4) {
      suspicious.push(normalized);
    }
  }

  return suspicious;
}

// ===== プールクリーンアップ =====

function getDateStr(val: any): string {
  if (!val) return '';
  if (typeof val === 'string') return val.split('T')[0];
  if (val instanceof Date) return val.toISOString().split('T')[0];
  return String(val).split('T')[0];
}

function cleanupPool(pool: any, history: any[]): number {
  const today = getTodayJST();
  const threeDaysAgo = new Date(new Date(today).getTime() - 3 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];

  const postedIds = new Set(history.map(h => h.post_id));
  const originalCount = pool.posts.length;

  // 3日前以前 & 投稿済み → 削除
  pool.posts = pool.posts.filter((p: any) => {
    const dateStr = getDateStr(p.scheduled_date);
    if (dateStr < threeDaysAgo && postedIds.has(p.id)) {
      return false;
    }
    return true;
  });

  // active上限30件（古いものから削除）
  const activePosts = pool.posts.filter((p: any) => p.status === 'active');
  if (activePosts.length > 30) {
    const toRemove = activePosts
      .sort((a: any, b: any) => getDateStr(a.scheduled_date).localeCompare(getDateStr(b.scheduled_date)))
      .slice(0, activePosts.length - 30);
    const removeIds = new Set(toRemove.map((p: any) => p.id));
    pool.posts = pool.posts.filter((p: any) => !removeIds.has(p.id));
  }

  return originalCount - pool.posts.length;
}

// ===== Discord通知 =====

async function notifyDiscord(
  themes: ThemeCandidate[],
  posts: GeneratedPost[],
  poolRemaining: number,
  warnings: string[]
): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) {
    console.log('⚠️ DISCORD_WEBHOOK_URL未設定、通知スキップ');
    return;
  }

  const postPreviews = posts.map((p, i) =>
    `**${p.slot}** (${p.theme}) [${p.quality_score}点]\n${p.variants.A.content.slice(0, 80)}...`
  ).join('\n\n');

  const warningText = warnings.length > 0
    ? `\n⚠️ **警告:**\n${warnings.join('\n')}`
    : '';

  const body = {
    content: `🤖 **日次自動投稿生成完了** (${getTodayJST()})`,
    embeds: [{
      title: '📝 本日の投稿',
      description: `${postPreviews}${warningText}`,
      color: warnings.length > 0 ? 0xff9900 : 0x00cc66,
      fields: [
        {
          name: '🎯 選定テーマ',
          value: themes.map(t => `${t.name} (${t.source})`).join('\n'),
          inline: true,
        },
        {
          name: '📦 プール残数',
          value: `${poolRemaining}件`,
          inline: true,
        },
      ],
      footer: { text: `Dashboard: ${DASHBOARD_URL}` },
      timestamp: new Date().toISOString(),
    }],
  };

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) {
      console.log('✅ Discord通知送信完了');
    } else {
      console.log(`⚠️ Discord通知失敗: ${response.status}`);
    }
  } catch (e) {
    console.log(`⚠️ Discord通知エラー: ${e}`);
  }
}

// ===== メイン処理 =====

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const slotCount = (() => {
    const idx = process.argv.indexOf('--slots');
    return idx >= 0 ? parseInt(process.argv[idx + 1]) || 3 : 3;
  })();

  console.log('='.repeat(60));
  console.log('🤖 日次自動投稿生成');
  console.log(`📅 ${getTodayJST()} | スロット数: ${slotCount} | ${isDryRun ? 'DRY RUN' : '本番'}`);
  console.log('='.repeat(60));

  // 1. データ読み込み
  console.log('\n📂 データ読み込み...');
  const insights = loadOverseasInsights();
  const learningState = loadLearningState();
  const persona = loadPersonaSummary();
  const learnings = loadAccumulatedLearnings();
  const pool = loadPool();
  const history = loadHistory();

  console.log(`  overseas insights: ${insights.length}件`);
  console.log(`  learning_state: ${learningState ? 'OK' : 'なし'}`);
  console.log(`  accumulated_learnings: ${learnings.length}件`);
  console.log(`  pool: ${pool.posts?.length || 0}件`);
  console.log(`  history: ${history.length}件`);

  // テーマ候補が少なすぎる場合のフォールバック
  if (insights.length === 0 && (!learningState || Object.keys(learningState.theme_scores).length === 0)) {
    console.log('\n⚠️ テーマ候補なし。overseas insightsもlearning stateも空です。');
    console.log('   既存プールの投稿で運用を継続します。');
    return;
  }

  // 2. テーマ選定
  const selectedThemes = selectThemes(insights, learningState, history, slotCount);

  if (selectedThemes.length === 0) {
    console.log('\n⚠️ テーマ選定失敗。候補がありません。');
    return;
  }

  // 3. 投稿生成
  console.log('\n📝 投稿生成開始...');
  const generatedPosts: GeneratedPost[] = [];
  const warnings: string[] = [];
  const today = getTodayJST();

  for (let i = 0; i < Math.min(selectedThemes.length, slotCount); i++) {
    const theme = selectedThemes[i];
    const slot = SLOTS[i];
    const approach = selectApproach(learningState);

    console.log(`\n--- ${slot} ---`);
    console.log(`  テーマ: ${theme.name}`);
    console.log(`  アプローチ: ${approach}`);

    // 生成
    let variantA: string, variantB: string;
    try {
      const result = await generatePost(theme, slot, approach, persona, learnings);
      variantA = result.variantA;
      variantB = result.variantB;
    } catch (e: any) {
      console.error(`  ❌ 生成失敗: ${e.message}`);
      warnings.push(`${slot}: 生成失敗 (${theme.name})`);
      continue;
    }

    // 文字数チェック
    if (variantA.length < 100 || variantA.length > 300) {
      console.log(`  ⚠️ 文字数異常 (${variantA.length}字), 再生成...\n`);
      try {
        const retry = await generatePost(theme, slot, approach, persona, learnings);
        variantA = retry.variantA;
        variantB = retry.variantB;
      } catch (e: any) {
        console.log(`  ⚠️ 再生成も失敗: ${e.message}`);
      }
    }

    console.log(`  Variant A (${variantA.length}字): ${variantA.slice(0, 60)}...`);
    console.log(`  Variant B (${variantB.length}字): ${variantB.slice(0, 60)}...`);

    // ハルシネーションチェック
    const suspicious = checkHallucination(variantA);
    if (suspicious.length > 0) {
      console.log(`  ⚠️ 不明なツール名検出: ${suspicious.join(', ')}`);
      warnings.push(`${slot}: 不明なツール名 [${suspicious.join(', ')}] — 要確認`);
    }

    // 品質評価
    let scores: QualityScore;
    try {
      scores = await evaluatePost(variantA);
      console.log(`  品質スコア: ${scores.total}/100 (hook=${scores.hook_strength}, persona=${scores.persona_fit})`);
    } catch {
      scores = { hook_strength: 15, persona_fit: 15, x_culture_fit: 15, specificity: 10, credibility: 7, total: 62, feedback: '評価スキップ' };
      console.log(`  ⚠️ 品質評価スキップ、デフォルトスコア使用`);
    }

    // total < 65 なら1回再生成
    if (scores.total < 65) {
      console.log(`  ⚠️ 品質スコア低 (${scores.total}), 再生成...\n`);
      try {
        const retry = await generatePost(theme, slot, approach, persona, learnings);
        variantA = retry.variantA;
        variantB = retry.variantB;
        scores = await evaluatePost(variantA);
        console.log(`  再評価スコア: ${scores.total}/100`);
      } catch {
        console.log(`  ⚠️ 再生成失敗、元の投稿を使用`);
      }
      if (scores.total < 65) {
        warnings.push(`${slot}: 品質スコア低 (${scores.total}点)`);
      }
    }

    // プールエントリ作成
    const post: GeneratedPost = {
      id: `daily_${today.replace(/-/g, '')}_${slot}`,
      generated_at: new Date().toISOString(),
      scheduled_date: today,
      slot,
      topic: theme.insight?.topic || theme.name,
      theme: theme.name,
      type: approach,
      quality_score: scores.total,
      refinement_rounds: 1,
      variants: {
        A: { content: variantA, hook_type: '感情型' },
        B: { content: variantB, hook_type: '丁寧型' },
      },
      scores,
      status: 'active',
      source: 'daily_auto',
    };

    generatedPosts.push(post);
  }

  if (generatedPosts.length === 0) {
    console.log('\n❌ 投稿を1件も生成できませんでした。');
    return;
  }

  // 4. プール更新
  console.log(`\n📦 プール更新...`);

  // クリーンアップ
  const removedCount = cleanupPool(pool, history);
  if (removedCount > 0) {
    console.log(`  🧹 ${removedCount}件の古いエントリを削除`);
  }

  // 今日の同じスロットの既存daily_autoエントリを上書き
  for (const post of generatedPosts) {
    pool.posts = pool.posts.filter((p: any) =>
      !(p.id === post.id || (p.source === 'daily_auto' && p.scheduled_date === today && p.slot === post.slot))
    );
    pool.posts.push(post);
  }

  const activeCount = pool.posts.filter((p: any) => p.status === 'active').length;
  console.log(`  📦 プール残数: ${activeCount}件 (新規${generatedPosts.length}件追加)`);

  if (!isDryRun) {
    fs.writeFileSync(POOL_FILE, yaml.dump(pool, { lineWidth: -1, noRefs: true }));
    console.log(`  ✅ ${POOL_FILE} に保存`);
  } else {
    console.log('  ℹ️ DRY RUN: プール書き込みスキップ');
  }

  // 5. Discord通知
  await notifyDiscord(selectedThemes, generatedPosts, activeCount, warnings);

  // 6. サマリー
  console.log('\n' + '='.repeat(60));
  console.log('✅ 日次自動投稿生成完了');
  console.log(`  生成: ${generatedPosts.length}/${slotCount}件`);
  console.log(`  テーマ: ${generatedPosts.map(p => p.theme).join(', ')}`);
  console.log(`  品質: ${generatedPosts.map(p => `${p.slot}=${p.quality_score}点`).join(', ')}`);
  if (warnings.length > 0) {
    console.log(`  ⚠️ 警告: ${warnings.length}件`);
    for (const w of warnings) console.log(`    - ${w}`);
  }
  console.log('='.repeat(60));
}

main().catch(e => {
  console.error('❌ daily_generate エラー:', e);
  process.exit(1);
});
