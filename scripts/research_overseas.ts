/**
 * 海外AIリサーチスクリプト（Grok + 学術論文版）
 *
 * 機能:
 *   - Grokを使ってX内の海外AI情報を直接検索（API制限なし）
 *   - arXiv / Semantic Scholar / Papers with Code から学術論文をリサーチ
 *   - 日本未発信のトピック・論文知見を抽出
 *   - GPTで日本語コンテンツ案を生成（論文→実務翻訳）
 *   - 投稿プールに追加
 *
 * 使い方:
 *   npx ts-node scripts/research_overseas.ts          # フルリサーチ（Grok + 論文）
 *   npx ts-node scripts/research_overseas.ts papers    # 論文リサーチのみ
 *   npx ts-node scripts/research_overseas.ts trends    # Grokトレンドのみ
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

interface AcademicPaper {
  title: string;
  authors: string[];
  published: string;       // YYYY-MM-DD
  source: 'arxiv' | 'semantic_scholar' | 'papers_with_code';
  url: string;
  abstract_summary: string; // 日本語要約（100文字）
  categories: string[];     // cs.AI, cs.CL, etc.
  citation_count?: number;
  practical_value: 'high' | 'medium' | 'low';     // 実務への翻訳可能性
  japan_coverage: 'none' | 'partial' | 'full';     // 日本語解説の有無
  wow_factor: number;       // 1-10: 「へぇ」ファクター
  target_readability: 'expert' | 'intermediate' | 'beginner_friendly';
  practical_translation: string;  // 「この研究→あなたの開発にどう活きるか」
}

interface ContentIdea {
  insight: TrendInsight;
  paper?: AcademicPaper;    // 論文ソースの場合
  japanese_adaptation: string;
  hook: string;
  generated_at: string;
  source_type: 'trend' | 'paper';  // 情報ソースの種類
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

// ===== arXiv API呼び出し =====
async function searchArxiv(query: string, maxResults: number = 10): Promise<any[]> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodedQuery}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`arXiv API failed: ${response.status}`);
    const xml = await response.text();

    // XMLからエントリを簡易パース
    const entries: any[] = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;
    while ((match = entryRegex.exec(xml)) !== null) {
      const entry = match[1];
      const getField = (tag: string) => {
        const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
        return m ? m[1].trim() : '';
      };
      const getAuthors = () => {
        const authors: string[] = [];
        const authorRegex = /<author>\s*<name>([^<]+)<\/name>/g;
        let am;
        while ((am = authorRegex.exec(entry)) !== null) {
          authors.push(am[1].trim());
        }
        return authors;
      };
      const getCategories = () => {
        const cats: string[] = [];
        const catRegex = /<category[^>]*term="([^"]+)"/g;
        let cm;
        while ((cm = catRegex.exec(entry)) !== null) {
          cats.push(cm[1]);
        }
        return cats;
      };

      entries.push({
        title: getField('title').replace(/\s+/g, ' '),
        authors: getAuthors(),
        published: getField('published').substring(0, 10),
        summary: getField('summary').replace(/\s+/g, ' ').substring(0, 500),
        url: getField('id'),
        categories: getCategories()
      });
    }
    return entries;
  } catch (e) {
    console.error('  arXiv API error:', (e as Error).message);
    return [];
  }
}

// ===== Semantic Scholar API呼び出し =====
async function searchSemanticScholar(query: string, limit: number = 5): Promise<any[]> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodedQuery}&limit=${limit}&fields=title,authors,year,citationCount,url,abstract,publicationDate&sort=publicationDate:desc`;

  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) throw new Error(`Semantic Scholar API failed: ${response.status}`);
    const data = await response.json() as any;
    return (data.data || []).map((paper: any) => ({
      title: paper.title,
      authors: (paper.authors || []).map((a: any) => a.name),
      published: paper.publicationDate || `${paper.year}-01-01`,
      summary: (paper.abstract || '').substring(0, 500),
      url: paper.url || `https://www.semanticscholar.org/paper/${paper.paperId}`,
      citation_count: paper.citationCount || 0,
      categories: []
    }));
  } catch (e) {
    console.error('  Semantic Scholar API error:', (e as Error).message);
    return [];
  }
}

// ===== 学術論文リサーチ =====
async function researchAcademicPapers(settings: any): Promise<AcademicPaper[]> {
  console.log('\n📚 学術論文リサーチ開始...\n');

  // AI開発に関連する検索クエリ
  const searchQueries = [
    'LLM agent code generation',
    'AI-assisted software development',
    'prompt optimization techniques',
    'code LLM evaluation benchmark',
    'AI pair programming',
    'autonomous coding agent',
    'retrieval augmented generation code',
    'LLM structured output',
    'multi-agent software engineering',
    'AI developer productivity'
  ];

  const allPapers: any[] = [];
  const seenTitles = new Set<string>();

  // arXiv検索（上位3クエリ）
  console.log('  📄 arXiv検索中...');
  for (const query of searchQueries.slice(0, 4)) {
    const papers = await searchArxiv(query, 5);
    for (const p of papers) {
      const normalizedTitle = p.title.toLowerCase().trim();
      if (!seenTitles.has(normalizedTitle)) {
        seenTitles.add(normalizedTitle);
        allPapers.push({ ...p, source: 'arxiv' });
      }
    }
    await new Promise(r => setTimeout(r, 1000)); // API rate limit
  }

  // Semantic Scholar検索（補完）
  console.log('  🔬 Semantic Scholar検索中...');
  for (const query of searchQueries.slice(0, 3)) {
    const papers = await searchSemanticScholar(query, 3);
    for (const p of papers) {
      const normalizedTitle = p.title.toLowerCase().trim();
      if (!seenTitles.has(normalizedTitle)) {
        seenTitles.add(normalizedTitle);
        allPapers.push({ ...p, source: 'semantic_scholar' });
      }
    }
    await new Promise(r => setTimeout(r, 1500)); // Rate limit (100 req/5min)
  }

  console.log(`  📊 ${allPapers.length}件の論文を発見\n`);

  // AI開発実務に関連するカテゴリのみ通過させる（地理空間、暗号、CV系は除外）
  const relevantCategories = new Set([
    'cs.AI', 'cs.CL', 'cs.SE', 'cs.LG', 'cs.PL', 'cs.HC', 'cs.MA'
  ]);
  const irrelevantCategories = new Set([
    'cs.CV', 'cs.CR', 'cs.IR', 'stat.AP', 'cs.RO', 'cs.GR',
    'cs.NI', 'cs.DC', 'eess.SP', 'eess.AS', 'physics'
  ]);
  const filteredPapers = allPapers.filter(p => {
    const cats = p.categories || [];
    // 完全に無関係なカテゴリのみの論文は除外
    if (cats.length > 0 && cats.every((c: string) => irrelevantCategories.has(c))) {
      console.log(`  ⏭️ カテゴリ除外: [${cats.join(',')}] ${p.title.substring(0, 50)}...`);
      return false;
    }
    // 関連カテゴリが1つも含まれていない場合も除外
    if (cats.length > 0 && !cats.some((c: string) => relevantCategories.has(c))) {
      console.log(`  ⏭️ 関連カテゴリなし: [${cats.join(',')}] ${p.title.substring(0, 50)}...`);
      return false;
    }
    return true;
  });
  console.log(`  🔍 カテゴリフィルタ後: ${filteredPapers.length}件\n`);

  // GPTで論文の実務価値を評価・翻訳
  const evaluatedPapers: AcademicPaper[] = [];
  const personaContext = getPersonaContext(settings);

  // 上位15件を評価（カテゴリフィルタ済み）
  for (const paper of filteredPapers.slice(0, 15)) {
    try {
      const evalPrompt = `あなたはAI開発の実務者であり、学術論文を実務に翻訳する専門家です。

以下の論文を評価してください。

${personaContext}

【論文情報】
タイトル: ${paper.title}
著者: ${paper.authors.slice(0, 3).join(', ')}${paper.authors.length > 3 ? ' et al.' : ''}
発表日: ${paper.published}
概要: ${paper.summary.substring(0, 300)}
カテゴリ: ${paper.categories.join(', ')}
${paper.citation_count ? `引用数: ${paper.citation_count}` : ''}

【評価基準（厳格に判定すること。大半はlow評価が正しい）】
1. 実務への翻訳可能性: この研究結果は明日からのAI開発（LLM、エージェント、プロンプト設計、コード生成）に直接使えるか？
2. ターゲットペルソナの課題との接点: AIを使ったソフトウェア開発に関係するか？
3. 日本語での解説がまだ存在しない可能性
4. 「へぇ」ファクター: AI開発者が知って驚く・人に話したくなるか

【重要：以下に該当する場合は必ずlow評価にすること】
- コンピュータビジョン（画像認識・3D・リモートセンシング）→ low
- 暗号理論・セキュリティ理論 → low
- eコマース・マーケティング最適化 → low
- 自然言語処理でもAI開発の実務に無関係な応用（歴史テキスト、市場分析等）→ low
- ペルソナが「AIを使いこなしたい開発者」であることを常に意識すること

JSON形式で回答:
{
  "abstract_summary": "日本語要約（100文字以内）",
  "practical_value": "high/medium/low",
  "japan_coverage": "none/partial/full（推定）",
  "wow_factor": 1-10,
  "target_readability": "expert/intermediate/beginner_friendly",
  "practical_translation": "この研究があなたの開発に活きるポイント（80文字以内）",
  "skip_reason": "low評価の場合の理由（なければnull）"
}`;

      const evalResponse = await callGPT(evalPrompt);
      const jsonMatch = evalResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const eval_ = JSON.parse(jsonMatch[0]);

        // low評価はスキップ
        if (eval_.practical_value === 'low') {
          console.log(`  ⏭️ [${paper.title.substring(0, 40)}...] 実務距離が遠い`);
          continue;
        }

        evaluatedPapers.push({
          title: paper.title,
          authors: paper.authors,
          published: paper.published,
          source: paper.source,
          url: paper.url,
          abstract_summary: eval_.abstract_summary,
          categories: paper.categories,
          citation_count: paper.citation_count,
          practical_value: eval_.practical_value,
          japan_coverage: eval_.japan_coverage,
          wow_factor: eval_.wow_factor,
          target_readability: eval_.target_readability,
          practical_translation: eval_.practical_translation
        });

        const emoji = eval_.practical_value === 'high' ? '🔥' : '⭐';
        console.log(`  ${emoji} [${paper.title.substring(0, 50)}...]`);
        console.log(`     実務価値: ${eval_.practical_value} | へぇ: ${eval_.wow_factor}/10 | 日本語解説: ${eval_.japan_coverage}`);
        console.log(`     → ${eval_.practical_translation}`);
      }

      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`  ⚠️ 評価失敗: ${(e as Error).message}`);
    }
  }

  // 優先度でソート: 実務価値high → wow_factor高い順
  evaluatedPapers.sort((a, b) => {
    if (a.practical_value !== b.practical_value) {
      return a.practical_value === 'high' ? -1 : 1;
    }
    return b.wow_factor - a.wow_factor;
  });

  return evaluatedPapers;
}

// 論文からコンテンツアイデアを生成
async function generatePaperContent(paper: AcademicPaper): Promise<ContentIdea | null> {
  const prompt = `あなたは日本のAI開発コミュニティ向けのコンテンツクリエイターです。

以下の学術論文の知見を基に、Xの投稿を作成してください。

【論文】${paper.title}
【要約】${paper.abstract_summary}
【実務ポイント】${paper.practical_translation}

【重要ルール】
1. 「論文によると〜」という学術的な導入は使わない
2. 自分が発見した実務的な気づきとして語る
3. 「研究」「論文」という単語は使わず、「最新の検証で分かったこと」「海外のエンジニアが検証した結果」等の表現
4. ターゲットの「AIを使いこなせない焦り」に刺さる内容
5. 140文字以内
6. 具体的なTipsや数字を含める
7. ハッシュタグは1個以内

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
      // 論文ソースの場合、TrendInsightを疑似生成
      const pseudoInsight: TrendInsight = {
        topic: paper.title.substring(0, 60),
        summary: paper.abstract_summary,
        key_accounts: paper.authors.slice(0, 2),
        example_posts: [],
        japan_relevance: paper.practical_translation,
        novelty_score: paper.japan_coverage === 'none' ? 9 : paper.japan_coverage === 'partial' ? 7 : 5,
        persona_fit: paper.practical_value === 'high' ? 9 : 7,
        freshness: 8, // 論文は鮮度より知見の深さが重要
        japan_spread: paper.japan_coverage === 'none' ? 1 : paper.japan_coverage === 'partial' ? 4 : 7,
        priority_score: 0
      };
      // 優先度スコア計算（トレンドと同一基準。ソース種別による加点はしない）
      // 論文 vs トレンドの効果差はThompson Samplingで事後的に検証する
      pseudoInsight.priority_score = Math.round(
        (pseudoInsight.freshness * (10 - pseudoInsight.japan_spread) * pseudoInsight.persona_fit) / 10
      );

      return {
        insight: pseudoInsight,
        paper,
        japanese_adaptation: parsed.japanese_adaptation,
        hook: parsed.hook,
        generated_at: new Date().toISOString(),
        source_type: 'paper'
      };
    }
  } catch (e) {
    console.log('  ⚠️ 論文コンテンツ生成失敗:', (e as Error).message);
  }
  return null;
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

// 前回のトピックを読み込み（重複防止用）
function loadPreviousTopics(): string[] {
  try {
    if (!fs.existsSync(OUTPUT_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
    const topics: string[] = [];
    // Grokトレンドのトピック
    if (data.insights) {
      for (const insight of data.insights) {
        if (insight.topic) topics.push(insight.topic);
      }
    }
    // ideasからもトピック取得
    if (data.ideas) {
      for (const idea of data.ideas) {
        const t = idea.insight?.topic || idea.topic;
        if (t) topics.push(t);
      }
    }
    return [...new Set(topics)];
  } catch { return []; }
}

// Grokで海外トレンドをリサーチ（ペルソナフィルタリング付き）
async function researchWithGrok(keywords: string[], influencers: string[], settings: any): Promise<TrendInsight[]> {
  console.log('🔍 Grokで海外AI情報をリサーチ中...\n');

  const personaContext = getPersonaContext(settings);

  // 前回のトピックを取得（重複防止）
  const previousTopics = loadPreviousTopics();
  const exclusionList = previousTopics.length > 0
    ? `\n【除外トピック（前回と同じネタは禁止。これらとは異なる新しいトピックを探すこと）】\n${previousTopics.map(t => `- ${t}`).join('\n')}\n`
    : '';

  // 今日の日付を含めて鮮度を強調
  const today = new Date().toISOString().split('T')[0];

  const prompt = `あなたはX（Twitter）の情報に精通したAIリサーチャーです。

今日は${today}です。
過去24-48時間にXで話題になっている海外AI開発関連のトピックを調査してください。

${personaContext}

【監視キーワード】
${keywords.join(', ')}

【注目インフルエンサー】
${influencers.join(', ')}
${exclusionList}
【重要な調査条件】
1. 上記ペルソナの「ペインポイント」を解決する情報を優先
2. AI開発の実務に直接使える情報（ツール、手法、ワークフロー、Tips）
3. 日本ではまだあまり知られていない概念や手法
4. 実用的で、すぐに試せるTipsやアプローチ
5. 曖昧な開発から脱却し、再現性のある開発を実現する情報
6. 除外トピックと同じテーマを別の言い方で返すのも禁止。本当に新しいネタを探すこと

【出力形式】JSON配列で5件
[
  {
    "topic": "トピック名（英語で簡潔に）",
    "summary": "日本語で概要を100文字程度。何が新しく、なぜ重要かを具体的に説明",
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
        generated_at: new Date().toISOString(),
        source_type: 'trend' as const
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
      const isPaper = idea.source_type === 'paper';

      const post: any = {
        id: `overseas_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        content: idea.japanese_adaptation,
        type: isPaper ? 'academic_insight' : 'overseas_insight',
        topic: idea.insight.topic,
        source_accounts: idea.insight.key_accounts,
        novelty_score: novelty,
        persona_fit: personaFit,
        freshness: freshness,
        japan_spread: japanSpread,
        priority_score: priorityScore,
        priority,
        created_at: idea.generated_at,
        expires_at: new Date(Date.now() + (isPaper ? 14 : 7) * 24 * 60 * 60 * 1000).toISOString()
      };

      // 論文ソースの場合、メタデータを追加
      if (isPaper && idea.paper) {
        post.paper_ref = {
          title: idea.paper.title,
          url: idea.paper.url,
          authors: idea.paper.authors.slice(0, 3),
          practical_value: idea.paper.practical_value,
          japan_coverage: idea.paper.japan_coverage
        };
      }

      pool.posts.push(post);
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
  const mode = process.argv[2] || 'full'; // full | papers | trends

  console.log('\n🌐 海外AIリサーチ（Grok + 学術論文版）\n');
  console.log(`📌 モード: ${mode === 'full' ? 'フルリサーチ' : mode === 'papers' ? '論文のみ' : 'トレンドのみ'}\n`);

  const settings = loadSettings();
  const ideas: ContentIdea[] = [];

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

  // ===== 1. 学術論文リサーチ =====
  let academicPapers: AcademicPaper[] = [];
  if (mode === 'full' || mode === 'papers') {
    console.log('='.repeat(60));
    console.log('📚 Phase 1: 学術論文リサーチ');
    console.log('='.repeat(60));

    academicPapers = await researchAcademicPapers(settings);

    console.log(`\n📊 評価済み論文: ${academicPapers.length}件`);
    console.log(`   うち実務価値 high: ${academicPapers.filter(p => p.practical_value === 'high').length}件`);
    console.log(`   うち日本語解説なし: ${academicPapers.filter(p => p.japan_coverage === 'none').length}件\n`);

    // 上位5件をコンテンツ化
    for (const paper of academicPapers.slice(0, 5)) {
      const idea = await generatePaperContent(paper);
      if (idea) {
        ideas.push(idea);
        console.log(`  ✅ 論文→投稿: 「${idea.japanese_adaptation.substring(0, 50)}...」`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ===== 2. Grokトレンドリサーチ =====
  let insights: TrendInsight[] = [];
  if (mode === 'full' || mode === 'trends') {
    console.log('\n' + '='.repeat(60));
    console.log('🔍 Phase 2: Grokトレンドリサーチ');
    console.log('='.repeat(60));

    console.log(`🔍 監視キーワード: ${trendKeywords.slice(0, 5).join(', ')}...`);
    console.log(`👥 注目アカウント: ${influencerHandles.slice(0, 5).join(', ')}...\n`);

    // Grokでリサーチ
    insights = await researchWithGrok(trendKeywords, influencerHandles, settings);

    console.log(`\n📊 発見したトピック: ${insights.length}件\n`);

    for (const insight of insights) {
      const personaFit = insight.persona_fit || 5;
      const freshness = insight.freshness || 5;
      const japanSpread = insight.japan_spread || 5;

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
  }

  // ===== 3. 統合結果 =====
  // 優先度順にソート（論文ソースにボーナスあり）
  ideas.sort((a, b) => (b.insight.priority_score || 0) - (a.insight.priority_score || 0));

  // 結果を保存
  const output = {
    researched_at: new Date().toISOString(),
    method: mode === 'papers' ? 'academic' : mode === 'trends' ? 'grok' : 'grok+academic',
    keywords_used: trendKeywords,
    influencers_monitored: influencerHandles,
    topics_found: insights.length,
    papers_found: academicPapers.length,
    papers_high_value: academicPapers.filter(p => p.practical_value === 'high').length,
    papers_japan_uncovered: academicPapers.filter(p => p.japan_coverage === 'none').length,
    ideas_generated: ideas.length,
    ideas_from_papers: ideas.filter(i => i.source_type === 'paper').length,
    ideas_from_trends: ideas.filter(i => i.source_type === 'trend').length,
    high_novelty_count: ideas.filter(i => i.insight.novelty_score >= 7).length,
    academic_papers: academicPapers,
    insights,
    ideas
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  // NOTE: プールへの直接追加は廃止。daily_generate.ts が overseas_insights.json を
  // 読み取り、Thompson Sampling でテーマ選定→LLM生成→プールに投入する。
  // research_overseas.ts はデータソース（overseas_insights.json）の更新のみ担当。
  console.log(`\n📋 overseas_insights.json を更新しました（daily_generate.ts がテーマ選定に使用）`);

  // サマリー
  console.log('\n' + '='.repeat(60));
  console.log('📋 リサーチサマリー\n');

  if (ideas.filter(i => i.source_type === 'paper').length > 0) {
    console.log('📚 論文ソース:');
    for (const idea of ideas.filter(i => i.source_type === 'paper')) {
      const priorityScore = idea.insight.priority_score || 0;
      const emoji = priorityScore >= 60 ? '🔥' : priorityScore >= 40 ? '⭐' : '📝';
      console.log(`  ${emoji} [${idea.paper?.title?.substring(0, 50) || idea.insight.topic}...] 優先度: ${priorityScore}`);
      console.log(`     日本語解説: ${idea.paper?.japan_coverage || '不明'} | 実務価値: ${idea.paper?.practical_value || '不明'}`);
      console.log(`     ${idea.japanese_adaptation.substring(0, 60)}...`);
    }
    console.log('');
  }

  if (ideas.filter(i => i.source_type === 'trend').length > 0) {
    console.log('🔍 トレンドソース:');
    for (const idea of ideas.filter(i => i.source_type === 'trend')) {
      const freshness = idea.insight.freshness || 5;
      const japanSpread = idea.insight.japan_spread || 5;
      const personaFit = idea.insight.persona_fit || 0;
      const priorityScore = idea.insight.priority_score || 0;

      const emoji = priorityScore >= 60 ? '🔥' : priorityScore >= 40 ? '⭐' : '📝';
      console.log(`  ${emoji} [${idea.insight.topic}] 優先度: ${priorityScore}`);
      console.log(`     鮮度: ${freshness}/10 | 日本普及: ${japanSpread}/10 | ペルソナ: ${personaFit}/10`);
      console.log(`     ${idea.japanese_adaptation.substring(0, 60)}...`);
      console.log(`     ソース: ${idea.insight.key_accounts.slice(0, 2).join(', ')}`);
    }
    console.log('');
  }

  console.log(`📁 保存先: ${OUTPUT_FILE}`);
  console.log(`📊 総計: 論文${ideas.filter(i => i.source_type === 'paper').length}件 + トレンド${ideas.filter(i => i.source_type === 'trend').length}件 = ${ideas.length}件`);
  console.log('\n💡 新規性7以上のコンテンツは自動で投稿プールに追加されます');
  console.log('📚 論文ソースは有効期間14日（トレンドは7日）');
}

main().catch(console.error);
