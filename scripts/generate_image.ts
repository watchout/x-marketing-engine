/**
 * 投稿用画像生成スクリプト
 * 
 * 投稿テキストから画像を自動生成する
 * 
 * サポートするプロバイダー:
 *   - gemini: Google Gemini (NanoBanana)
 *   - flux: Replicate Flux
 *   - dalle: OpenAI DALL-E 3
 * 
 * 使い方:
 *   npx ts-node scripts/marketing/generate_image.ts --text "投稿テキスト" --style infographic
 *   npx ts-node scripts/marketing/generate_image.ts --prompt "画像プロンプト" --provider flux
 */

import * as fs from 'fs';
import * as path from 'path';

// 環境変数ファイルを読み込み
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
        
        // 'export KEY=value' 形式に対応
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

// 型定義
type ImageStyle = 'infographic' | 'code' | 'contrast' | 'tech' | 'minimal';
type Provider = 'gemini' | 'flux' | 'dalle';

interface ImageGenerationResult {
  success: boolean;
  imagePath?: string;
  imageUrl?: string;
  error?: string;
}

// 画像保存ディレクトリ
const IMAGES_DIR = path.join(__dirname, '../content/images/generated');

// スタイル別プロンプトテンプレート
const STYLE_TEMPLATES: Record<ImageStyle, string> = {
  infographic: `
Create a clean, modern infographic-style image with:
- Dark mode background (#1a1a2e or similar)
- Clear hierarchy with large readable text
- Tech/developer aesthetic
- Subtle neon accents (cyan, purple)
- Sans-serif font style
- 16:9 aspect ratio
`,
  code: `
Create a code snippet visualization with:
- Dark IDE theme (VS Code dark style)
- Syntax highlighting
- Clean monospace font
- Subtle glow effects
- 16:9 aspect ratio
`,
  contrast: `
Create a before/after comparison image with:
- Split layout (left: problem, right: solution)
- Left side: red/warning tones, chaos
- Right side: green/success tones, clean
- Clear visual hierarchy
- 16:9 aspect ratio
`,
  tech: `
Create a futuristic tech visualization with:
- Abstract geometric patterns
- Circuit board or neural network motifs
- Glowing connections
- Professional dark theme
- 16:9 aspect ratio
`,
  minimal: `
Create a minimalist image with:
- Simple clean design
- Maximum 2-3 colors
- Large bold text as focal point
- Lots of white/dark space
- 16:9 aspect ratio
`
};

// 投稿テキストから画像プロンプトを生成
function generateImagePrompt(postText: string, style: ImageStyle): string {
  // 投稿からキーワードを抽出
  const keywords = extractKeywords(postText);
  const theme = detectTheme(postText);
  
  const basePrompt = STYLE_TEMPLATES[style];
  
  return `
${basePrompt}

Theme: ${theme}
Key concepts to visualize: ${keywords.join(', ')}

Content context:
"${postText.substring(0, 200)}..."

Important:
- Text should be in Japanese or bilingual (Japanese + English)
- Include "dev-OS" branding subtly if appropriate
- Make it shareable on social media
- High contrast for mobile viewing
`.trim();
}

// キーワード抽出
function extractKeywords(text: string): string[] {
  const keywords: string[] = [];
  
  // 重要なフレーズを抽出
  const patterns = [
    /dev-OS/gi,
    /Cursor/gi,
    /AI開発/g,
    /SSOT/gi,
    /バイブ/g,
    /自動化/g,
    /効率化/g,
    /エージェント/g,
  ];
  
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) {
      keywords.push(...matches);
    }
  }
  
  return [...new Set(keywords)].slice(0, 5);
}

// テーマ検出
function detectTheme(text: string): string {
  if (text.includes('バイブ') || text.includes('限界')) return 'Problem/Challenge';
  if (text.includes('解決') || text.includes('爆速')) return 'Solution/Speed';
  if (text.includes('Tips') || text.includes('コツ')) return 'Tips/Tutorial';
  if (text.includes('比較') || text.includes('vs')) return 'Comparison';
  if (text.includes('開発') && text.includes('物語')) return 'Story/Journey';
  return 'General Tech';
}

// Gemini (Google AI) で画像生成
async function generateWithGemini(prompt: string): Promise<ImageGenerationResult> {
  const apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    return { success: false, error: 'GOOGLE_AI_API_KEY not found' };
  }
  
  try {
    // Gemini 2.0 Flash with Imagen 3 for image generation
    // Using the imagen model for image generation
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{
            prompt: prompt
          }],
          parameters: {
            sampleCount: 1,
            aspectRatio: '16:9',
            outputFormat: 'png'
          }
        })
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      
      // Imagen APIが使えない場合はGemini 2.0 Flash experimentalを試す
      console.log('⚠️ Imagen API failed, trying Gemini 2.0 Flash experimental...');
      
      const geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `Generate an image: ${prompt}`
              }]
            }],
            generationConfig: {
              responseModalities: ['IMAGE', 'TEXT']
            }
          })
        }
      );
      
      if (!geminiResponse.ok) {
        const geminiError = await geminiResponse.text();
        return { success: false, error: `Gemini API error: ${geminiError}` };
      }
      
      const geminiData = await geminiResponse.json() as any;
      
      // 画像データを抽出
      const imagePart = geminiData.candidates?.[0]?.content?.parts?.find(
        (p: any) => p.inlineData?.mimeType?.startsWith('image/')
      );
      
      if (imagePart?.inlineData?.data) {
        const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
        const filename = `gemini_${Date.now()}.png`;
        const filepath = path.join(IMAGES_DIR, filename);
        
        if (!fs.existsSync(IMAGES_DIR)) {
          fs.mkdirSync(IMAGES_DIR, { recursive: true });
        }
        
        fs.writeFileSync(filepath, imageBuffer);
        return { success: true, imagePath: filepath };
      }
      
      return { success: false, error: 'No image in Gemini response' };
    }
    
    const data = await response.json() as any;
    
    // Imagen API response
    const imageData = data.predictions?.[0]?.bytesBase64Encoded;
    
    if (imageData) {
      const imageBuffer = Buffer.from(imageData, 'base64');
      const filename = `gemini_${Date.now()}.png`;
      const filepath = path.join(IMAGES_DIR, filename);
      
      if (!fs.existsSync(IMAGES_DIR)) {
        fs.mkdirSync(IMAGES_DIR, { recursive: true });
      }
      
      fs.writeFileSync(filepath, imageBuffer);
      return { success: true, imagePath: filepath };
    }
    
    return { success: false, error: 'No image in response' };
  } catch (e) {
    return { success: false, error: `Gemini error: ${e}` };
  }
}

// Replicate Flux で画像生成
async function generateWithFlux(prompt: string): Promise<ImageGenerationResult> {
  const apiKey = process.env.REPLICATE_API_KEY;
  
  if (!apiKey) {
    return { success: false, error: 'REPLICATE_API_KEY not found' };
  }
  
  try {
    // Flux schnell model (fast, cost-effective)
    const response = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        version: 'black-forest-labs/flux-schnell',
        input: {
          prompt: prompt,
          aspect_ratio: '16:9',
          output_format: 'png',
          num_outputs: 1
        }
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Replicate API error: ${error}` };
    }
    
    const prediction = await response.json() as any;
    
    // ポーリングで完了を待つ
    let result = prediction;
    while (result.status !== 'succeeded' && result.status !== 'failed') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const statusResponse = await fetch(
        `https://api.replicate.com/v1/predictions/${result.id}`,
        {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        }
      );
      result = await statusResponse.json() as any;
    }
    
    if (result.status === 'succeeded' && result.output?.[0]) {
      const imageUrl = result.output[0];
      
      // 画像をダウンロード
      const imageResponse = await fetch(imageUrl);
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const filename = `flux_${Date.now()}.png`;
      const filepath = path.join(IMAGES_DIR, filename);
      
      if (!fs.existsSync(IMAGES_DIR)) {
        fs.mkdirSync(IMAGES_DIR, { recursive: true });
      }
      
      fs.writeFileSync(filepath, imageBuffer);
      return { success: true, imagePath: filepath, imageUrl };
    }
    
    return { success: false, error: `Flux failed: ${result.error}` };
  } catch (e) {
    return { success: false, error: `Flux error: ${e}` };
  }
}

// OpenAI DALL-E 3 で画像生成
async function generateWithDalle(prompt: string): Promise<ImageGenerationResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    return { success: false, error: 'OPENAI_API_KEY not found' };
  }
  
  try {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: prompt,
        n: 1,
        size: '1792x1024',  // 16:9に近い
        quality: 'standard',
        response_format: 'url'
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `DALL-E API error: ${error}` };
    }
    
    const data = await response.json() as any;
    const imageUrl = data.data?.[0]?.url;
    
    if (imageUrl) {
      // 画像をダウンロード
      const imageResponse = await fetch(imageUrl);
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const filename = `dalle_${Date.now()}.png`;
      const filepath = path.join(IMAGES_DIR, filename);
      
      if (!fs.existsSync(IMAGES_DIR)) {
        fs.mkdirSync(IMAGES_DIR, { recursive: true });
      }
      
      fs.writeFileSync(filepath, imageBuffer);
      return { success: true, imagePath: filepath, imageUrl };
    }
    
    return { success: false, error: 'No image URL in response' };
  } catch (e) {
    return { success: false, error: `DALL-E error: ${e}` };
  }
}

// メイン生成関数
export async function generateImage(
  options: {
    text?: string;
    prompt?: string;
    style?: ImageStyle;
    provider?: Provider;
  }
): Promise<ImageGenerationResult> {
  const style = options.style || 'infographic';
  const provider = options.provider || 'gemini';
  
  // プロンプトを決定
  let finalPrompt: string;
  if (options.prompt) {
    finalPrompt = options.prompt;
  } else if (options.text) {
    finalPrompt = generateImagePrompt(options.text, style);
  } else {
    return { success: false, error: 'Either text or prompt is required' };
  }
  
  console.log(`\n🎨 Generating image with ${provider}...`);
  console.log(`📝 Style: ${style}`);
  console.log(`📄 Prompt (first 200 chars): ${finalPrompt.substring(0, 200)}...`);
  
  // プロバイダー別に生成
  switch (provider) {
    case 'gemini':
      return generateWithGemini(finalPrompt);
    case 'flux':
      return generateWithFlux(finalPrompt);
    case 'dalle':
      return generateWithDalle(finalPrompt);
    default:
      return { success: false, error: `Unknown provider: ${provider}` };
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  
  // 引数パース
  const options: {
    text?: string;
    prompt?: string;
    style?: ImageStyle;
    provider?: Provider;
  } = {};
  
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--text':
        options.text = args[++i];
        break;
      case '--prompt':
        options.prompt = args[++i];
        break;
      case '--style':
        options.style = args[++i] as ImageStyle;
        break;
      case '--provider':
        options.provider = args[++i] as Provider;
        break;
      case '--help':
        console.log(`
画像生成スクリプト

使い方:
  npx ts-node scripts/marketing/generate_image.ts [options]

オプション:
  --text "投稿テキスト"    投稿テキストから自動でプロンプトを生成
  --prompt "プロンプト"    直接プロンプトを指定
  --style <style>         スタイル: infographic, code, contrast, tech, minimal
  --provider <provider>   プロバイダー: gemini, flux, dalle

例:
  npx ts-node scripts/marketing/generate_image.ts --text "正直、AI開発で効率が10倍になった" --style infographic
  npx ts-node scripts/marketing/generate_image.ts --prompt "Dark mode infographic about AI development" --provider flux
        `);
        return;
    }
  }
  
  if (!options.text && !options.prompt) {
    console.error('❌ Either --text or --prompt is required. Use --help for usage.');
    process.exit(1);
  }
  
  const result = await generateImage(options);
  
  if (result.success) {
    console.log(`\n✅ Image generated successfully!`);
    console.log(`📁 Saved to: ${result.imagePath}`);
    if (result.imageUrl) {
      console.log(`🔗 URL: ${result.imageUrl}`);
    }
  } else {
    console.error(`\n❌ Image generation failed: ${result.error}`);
    process.exit(1);
  }
}

// CLI実行
if (require.main === module) {
  main().catch(console.error);
}
