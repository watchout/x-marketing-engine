/**
 * マーケティングコンテンツ生成エンジン（3極統合版）
 * 
 * 3つの知的極による多段階生成:
 *   1. Strategy Designer (Nami) - 戦略整合
 *   2. Brand Guardian (Sun) - 原稿作成
 *   3. Market Analyst (Iza) - 最終監査
 * 
 * 使い方:
 *   npm run marketing:content                    # デフォルトテーマで生成
 *   npm run marketing:content "カスタムテーマ"   # テーマを指定
 * 
 * 必要な環境変数:
 *   OPENROUTER_API_KEY または GROK_API_KEY
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

// 環境変数ファイルを読み込み
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
        
        const match = trimmed.match(/^([^=]+)=(.*)$/);
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

// API設定
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTERT_KEY || process.env.OPENROUTER_KEY;
const USE_OPENROUTER = !!OPENROUTER_KEY;
const API_URL = USE_OPENROUTER 
  ? 'https://openrouter.ai/api/v1/chat/completions'
  : 'https://api.x.ai/v1/chat/completions';

// モデル設定
const MODELS = {
  strategy: USE_OPENROUTER ? 'openai/gpt-4o' : 'grok-2-latest',           // 戦略分析
  creative: USE_OPENROUTER ? 'anthropic/claude-3.5-sonnet' : 'grok-2-latest', // クリエイティブ
  audit: USE_OPENROUTER ? 'openai/gpt-4o' : 'grok-2-latest',              // 監査
};

const ROOT = path.join(__dirname, '..');

// LLM API呼び出し
async function callLLM(
  systemPrompt: string, 
  userPrompt: string, 
  model: string
): Promise<string> {
  const apiKey = USE_OPENROUTER 
    ? OPENROUTER_KEY 
    : process.env.GROK_API_KEY;
  
  if (!apiKey) {
    const keyName = USE_OPENROUTER ? 'OPENROUTER_API_KEY' : 'GROK_API_KEY';
    throw new Error(`${keyName} が設定されていません。.env.api に追加してください。`);
  }
  
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  
  if (USE_OPENROUTER) {
    headers['HTTP-Referer'] = 'https://dev-os.iyasaka.co.jp';
    headers['X-Title'] = 'dev-OS Marketing Content Engine';
  }
  
  const response = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 3000,
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`LLM API error: ${response.status} - ${error}`);
  }
  
  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  
  return data.choices[0].message.content;
}

// SSOT読み込み
function loadSSOT() {
  const marketing = parseYaml(fs.readFileSync(path.join(ROOT, 'ssot/marketing.yml'), 'utf-8'));
  const schedule = parseYaml(fs.readFileSync(path.join(ROOT, 'ssot/content_schedule.yml'), 'utf-8'));
  const personas = parseYaml(fs.readFileSync(path.join(ROOT, 'ssot/personas.yml'), 'utf-8'));
  return { marketing, schedule, personas };
}

// 感情駆動テーマ（痛み×不安×焦り）
const THEME_POOL = [
  // 痛みの代弁（共感を呼ぶ）
  "AIに丸投げして3時間溶かした話",
  "Cursorの出力が毎回違って発狂しかけた",
  "深夜2時にAIの手戻りでキレた経験",
  "チームメンバーのAIコード、レビューで全部書き直した",
  "プロトは1日で完成、本番品質にするのに2週間かかった地獄",
  
  // 不安・焦りの創出
  "AIコーディング、このまま続けて大丈夫？",
  "来年、AIを使いこなせない開発者はどうなる？",
  "隣の会社はAI開発で3倍速、うちは？",
  "AI時代に仕様書を書けないエンジニアの末路",
  "今のやり方を続けると技術的負債が爆発する",
  
  // 発見・転換（希望）
  "AIへの指示を変えたら手戻りが消えた",
  "仕様を整えたらAIが別人になった",
];

function getRandomTheme(): string {
  // 日付ベースでテーマをローテーション（同じ日は同じテーマ群から選択）
  const today = new Date();
  const dayOfYear = Math.floor((today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) / 86400000);
  const hourOfDay = today.getHours();
  const index = (dayOfYear * 3 + hourOfDay) % THEME_POOL.length;
  return THEME_POOL[index];
}

async function main() {
  const theme = process.argv[2] || getRandomTheme();
  
  console.log('='.repeat(60));
  console.log('🎯 マーケティングコンテンツ生成エンジン（3極統合版）');
  console.log('='.repeat(60));
  console.log(`📝 テーマ: "${theme}"`);
  console.log(`🔌 API: ${USE_OPENROUTER ? 'OpenRouter' : 'xAI直接'}`);
  console.log('');

  // SSOT読み込み
  const ssot = loadSSOT();

  // ─────────────────────────────────────────
  // Step 1: Strategy Designer (Nami) - 戦略整合
  // ─────────────────────────────────────────
  console.log('📊 Step 1: Strategy Designer (Nami) が戦略を練っています...');
  
  const strategySystemPrompt = `あなたは IYASAKA の Strategy Designer (Nami) です。
マーケティング戦略とスケジュールに基づき、今回のテーマがどの投稿タイプ（Type1-4）に該当し、
どのようなフックで訴求すべきか戦略を立ててください。

【投稿タイプ定義】
- Type1 (対比型): Before/After で「不」を「光」に変える
- Type2 (チラ見せ型): 開発過程を公開し、共犯者（ファン）を作る
- Type3 (思想型): IYASAKA の哲学を語り、信頼を深める
- Type4 (Tips/要約型): 速報・有益ノウハウを提供

【マーケティング戦略SSOT】
${JSON.stringify(ssot.marketing.marketing_strategy || ssot.marketing, null, 2).slice(0, 2000)}

【スケジュールSSOT】
${JSON.stringify(ssot.schedule, null, 2).slice(0, 1000)}`;

  const strategyUserPrompt = `テーマ: ${theme}

以下を出力してください：
1. 推奨する投稿タイプ（Type1-4のいずれか）
2. 訴求フック（読者が反応するポイント）
3. ターゲット心理（このテーマで刺さる感情）
4. 推奨プラットフォーム（X/Zenn/note）`;

  const strategyAlignment = await callLLM(
    strategySystemPrompt, 
    strategyUserPrompt, 
    MODELS.strategy
  );
  
  console.log('  ✅ 戦略整合完了\n');

  // ─────────────────────────────────────────
  // Step 2: Brand Guardian (Sun) - 原稿作成
  // ─────────────────────────────────────────
  console.log('✍️  Step 2: Brand Guardian (Sun) が体温のある原稿を書いています...');
  
  const brandSystemPrompt = `あなたは感情を動かすコピーライターです。
読者の心を揺さぶり、スクロールを止めさせる投稿を作成してください。

【感情駆動の原則】
1. 痛みの代弁（共感）
   - 「わかる...」「それな...」と思わせる
   - 具体的な失敗シーンを描写する
   - 数字や時間を入れてリアリティを出す
   
2. 不安・焦りの創出
   - 「知らないとやばい」と思わせる
   - 周りとの差を意識させる
   - 未来の自分を想像させる

3. 解決策への渇望
   - 痛みを描いた後に希望を見せる
   - ただし「売り込み」は絶対NG

【ペルソナの痛み】
- AIに丸投げしたら全然違うものができた
- 手戻りで深夜まで作業
- チームメンバーのAIコードが品質バラバラ
- プロトタイプは速いが本番品質にならない
- レビューに時間がかかりすぎる

【戦略担当のメモ】
${strategyAlignment}`;

  const brandUserPrompt = `【X投稿を3パターン作成してください】

■ パターン1: 痛みの代弁（共感型）
- 「わかる...」と思わせる失敗談・苦労話
- 具体的なシーン（深夜2時、3時間溶けた等）
- 感情を込めた一人語り

■ パターン2: 不安・焦り型
- 「このままでいいのか？」と不安にさせる
- 周りとの比較、未来への警鐘
- 知らないことへの危機感

■ パターン3: 発見・転換型
- 痛みからの解放を匂わせる
- 「〜したら世界が変わった」

【ルール】
- 各280文字以内
- ハッシュタグは絶対に使わない
- 絵文字は1個まで
- 製品名（dev-OS等）は出さない
- 情報提供ではなく「感情」を動かす
- 開発者が「俺のことだ...」と思う内容に

【出力形式】
パターン1:
（投稿文）

パターン2:
（投稿文）

パターン3:
（投稿文）`;

  const draftManuscript = await callLLM(
    brandSystemPrompt, 
    brandUserPrompt, 
    MODELS.creative
  );
  
  console.log('  ✅ 原稿作成完了\n');

  // ─────────────────────────────────────────
  // Step 3: Market Analyst (Iza) - 最終監査
  // ─────────────────────────────────────────
  console.log('🔍 Step 3: Market Analyst (Iza) が最終品質をチェックしています...');
  
  const auditSystemPrompt = `あなたは IYASAKA の Market Analyst (Iza) です。
生成された原稿を最終監査し、以下のチェックを行ってください。

【チェック項目】
1. ガバナンス：未実装機能を実装済みのように扱っていないか
2. 誠実さ：誇大広告になっていないか
3. 接続：URL が正しく p_id=dev-os を含んでいるか（言及がある場合）
4. ブランド：IYASAKA の「体温」が感じられるか

【修正が必要な場合】
修正後の最終稿を出力してください。
問題がない場合は「✅ 監査通過」と明記し、原稿をそのまま出力してください。`;

  const auditUserPrompt = draftManuscript;

  const finalManuscript = await callLLM(
    auditSystemPrompt, 
    auditUserPrompt, 
    MODELS.audit
  );
  
  console.log('  ✅ 最終監査完了\n');

  // ─────────────────────────────────────────
  // 結果の保存と表示
  // ─────────────────────────────────────────
  const outputDir = path.join(ROOT, 'outputs/marketing');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `content_${timestamp}.md`;
  const outputPath = path.join(outputDir, fileName);
  
  const fullOutput = `# マーケティングコンテンツ生成結果

## テーマ
${theme}

## 生成日時
${new Date().toLocaleString('ja-JP')}

---

## Step 1: 戦略整合 (Nami)

${strategyAlignment}

---

## Step 2: 原稿 (Sun)

${draftManuscript}

---

## Step 3: 最終稿 (Iza監査済み)

${finalManuscript}
`;

  fs.writeFileSync(outputPath, fullOutput);

  console.log('='.repeat(60));
  console.log('📄 生成された最終稿');
  console.log('='.repeat(60));
  console.log(finalManuscript);
  console.log('');
  console.log('='.repeat(60));
  console.log(`✅ 保存先: ${outputPath}`);
  console.log('='.repeat(60));
}

main().catch(console.error);
