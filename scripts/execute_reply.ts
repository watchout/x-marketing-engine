/**
 * リプライ実行スクリプト
 * 
 * 使い方:
 *   npx ts-node scripts/execute_reply.ts [index]
 *   npx ts-node scripts/execute_reply.ts 0        # 最初の提案を実行
 *   npx ts-node scripts/execute_reply.ts list     # 一覧表示
 *   npx ts-node scripts/execute_reply.ts all      # 全て実行（確認あり）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// 環境変数読み込み
function loadEnvFile(): void {
  const envPath = path.join(__dirname, '../.env.api');
  if (fs.existsSync(envPath)) {
    console.log('📁 Loading environment from:', envPath.split('/').pop());
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

const SUGGESTIONS_FILE = path.join(__dirname, '../content/reply_suggestions.json');
const REPLY_HISTORY_FILE = path.join(__dirname, '../content/reply_history.json');

interface ReplySuggestion {
  tweet: {
    id: string;
    text: string;
    author: string;
    url: string;
  };
  suggested_reply: string;
  alternative_replies: string[];
  relevance: string;
  quality_score: number;
  generated_at: string;
  executed?: boolean;
  executed_at?: string;
}

interface SuggestionsFile {
  generated_at: string;
  suggestions: ReplySuggestion[];
}

function loadSuggestions(): SuggestionsFile | null {
  if (!fs.existsSync(SUGGESTIONS_FILE)) {
    console.log('❌ リプライ提案ファイルがありません');
    console.log('   まず npm run suggest-replies を実行してください');
    return null;
  }
  
  const content = fs.readFileSync(SUGGESTIONS_FILE, 'utf-8');
  const data = JSON.parse(content);
  
  // 古い形式（配列）と新しい形式（オブジェクト）の両方に対応
  if (Array.isArray(data)) {
    return { generated_at: new Date().toISOString(), suggestions: data };
  }
  return data;
}

function saveSuggestions(data: SuggestionsFile): void {
  fs.writeFileSync(SUGGESTIONS_FILE, JSON.stringify(data, null, 2));
}

function loadReplyHistory(): any[] {
  if (!fs.existsSync(REPLY_HISTORY_FILE)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(REPLY_HISTORY_FILE, 'utf-8'));
}

function saveReplyHistory(history: any[]): void {
  fs.writeFileSync(REPLY_HISTORY_FILE, JSON.stringify(history, null, 2));
}

function listSuggestions(data: SuggestionsFile): void {
  console.log('\n📋 リプライ提案一覧\n');
  console.log(`生成日時: ${data.generated_at}`);
  console.log('='.repeat(60));
  
  const pending = data.suggestions.filter(s => !s.executed);
  
  if (pending.length === 0) {
    console.log('\n✅ 未実行の提案はありません');
    return;
  }
  
  pending.forEach((s, i) => {
    const scoreEmoji = s.quality_score >= 8 ? '🌟' : s.quality_score >= 6 ? '✅' : '📝';
    console.log(`\n[${i}] ${scoreEmoji} @${s.tweet.author} へのリプライ`);
    console.log(`    関連度: ${s.relevance.toUpperCase()} | スコア: ${s.quality_score}/10`);
    console.log(`    元投稿: "${s.tweet.text.substring(0, 50)}..."`);
    console.log(`    提案: "${s.suggested_reply}"`);
    if (s.alternative_replies && s.alternative_replies.length > 0) {
      console.log(`    代替案: ${s.alternative_replies.length}件あり`);
    }
  });
  
  console.log('\n' + '='.repeat(60));
  console.log(`\n📊 未実行: ${pending.length}件 / 全体: ${data.suggestions.length}件`);
  console.log('\n💡 実行コマンド:');
  console.log('   npm run reply 0     # インデックス0を実行');
  console.log('   npm run reply all   # 全て実行（確認あり）');
}

async function executeReply(suggestion: ReplySuggestion): Promise<boolean> {
  const { TwitterApi } = await import('twitter-api-v2');
  
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY!,
    appSecret: process.env.X_API_SECRET!,
    accessToken: process.env.X_ACCESS_TOKEN!,
    accessSecret: process.env.X_ACCESS_SECRET!,
  });

  try {
    console.log(`\n🚀 リプライ送信中...`);
    console.log(`   To: @${suggestion.tweet.author}`);
    console.log(`   Reply: "${suggestion.suggested_reply}"`);
    
    const result = await client.v2.reply(
      suggestion.suggested_reply,
      suggestion.tweet.id
    );
    
    console.log(`✅ 送信成功! Tweet ID: ${result.data.id}`);
    
    // 履歴に保存
    const history = loadReplyHistory();
    history.unshift({
      original_tweet_id: suggestion.tweet.id,
      original_author: suggestion.tweet.author,
      reply_tweet_id: result.data.id,
      reply_text: suggestion.suggested_reply,
      quality_score: suggestion.quality_score,
      executed_at: new Date().toISOString()
    });
    saveReplyHistory(history);
    
    return true;
  } catch (error: any) {
    console.error(`❌ 送信失敗:`, error.message || error);
    return false;
  }
}

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'list';
  
  const data = loadSuggestions();
  if (!data) return;
  
  const pending = data.suggestions.filter(s => !s.executed);
  
  if (command === 'list') {
    listSuggestions(data);
    return;
  }
  
  if (command === 'all') {
    if (pending.length === 0) {
      console.log('✅ 未実行の提案はありません');
      return;
    }
    
    console.log(`\n📋 ${pending.length}件のリプライを実行します:\n`);
    pending.forEach((s, i) => {
      console.log(`[${i}] @${s.tweet.author}: "${s.suggested_reply.substring(0, 40)}..."`);
    });
    
    const ok = await confirm('\n本当に全て実行しますか? (y/N): ');
    if (!ok) {
      console.log('キャンセルしました');
      return;
    }
    
    for (let i = 0; i < pending.length; i++) {
      const suggestion = pending[i];
      const success = await executeReply(suggestion);
      if (success) {
        suggestion.executed = true;
        suggestion.executed_at = new Date().toISOString();
        saveSuggestions(data);
      }
      // レート制限対策
      if (i < pending.length - 1) {
        console.log('⏳ 3秒待機...');
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    
    const executed = pending.filter(s => s.executed).length;
    console.log(`\n✅ ${executed}/${pending.length}件のリプライを実行しました`);
    return;
  }
  
  // インデックス指定
  const index = parseInt(command);
  if (isNaN(index) || index < 0 || index >= pending.length) {
    console.log(`❌ 無効なインデックス: ${command}`);
    console.log(`   有効な範囲: 0〜${pending.length - 1}`);
    return;
  }
  
  const suggestion = pending[index];
  console.log(`\n📝 リプライ内容:`);
  console.log(`   To: @${suggestion.tweet.author}`);
  console.log(`   元: "${suggestion.tweet.text.substring(0, 50)}..."`);
  console.log(`   返信: "${suggestion.suggested_reply}"`);
  
  const ok = await confirm('\n送信しますか? (y/N): ');
  if (!ok) {
    console.log('キャンセルしました');
    return;
  }
  
  const success = await executeReply(suggestion);
  if (success) {
    suggestion.executed = true;
    suggestion.executed_at = new Date().toISOString();
    saveSuggestions(data);
  }
}

main().catch(console.error);
