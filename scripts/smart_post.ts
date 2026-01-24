/**
 * スマート投稿スクリプト
 * 現在時刻に基づいて適切なスロットの投稿を自動判定・実行
 * 
 * 特徴:
 * - 時刻ベースで投稿スロットを自動判定
 * - 未投稿のスロットがあれば自動でキャッチアップ
 * - 重複投稿を防止
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const PROJECT_ROOT = path.join(__dirname, '..');
const POST_HISTORY_FILE = path.join(PROJECT_ROOT, 'content/post_history.json');

// スロット定義（JST時刻）
const SLOTS = [
  { name: 'morning', hour: 8 },
  { name: 'mid_morning', hour: 10 },
  { name: 'noon', hour: 12 },
  { name: 'evening', hour: 18 },
  { name: 'night', hour: 21 }
];

function getJSTDate(): Date {
  const now = new Date();
  // UTC to JST (+9)
  return new Date(now.getTime() + 9 * 60 * 60 * 1000);
}

function getTodayJST(): string {
  const jst = getJSTDate();
  return jst.toISOString().split('T')[0];
}

function getCurrentHourJST(): number {
  const jst = getJSTDate();
  return jst.getUTCHours();
}

function loadPostHistory(): any[] {
  if (!fs.existsSync(POST_HISTORY_FILE)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(POST_HISTORY_FILE, 'utf-8'));
}

function getTodayPostedSlots(): Set<string> {
  const history = loadPostHistory();
  const today = getTodayJST();
  const todayPosts = history.filter(p => {
    const postDate = new Date(p.posted_at);
    const postDateJST = new Date(postDate.getTime() + 9 * 60 * 60 * 1000);
    return postDateJST.toISOString().split('T')[0] === today;
  });
  return new Set(todayPosts.map(p => p.slot));
}

function getSlotsToPost(currentHour: number): string[] {
  const postedSlots = getTodayPostedSlots();
  const slotsToPost: string[] = [];
  
  for (const slot of SLOTS) {
    // 現在時刻がスロット時刻を過ぎていて、まだ投稿されていない場合
    if (currentHour >= slot.hour && !postedSlots.has(slot.name)) {
      slotsToPost.push(slot.name);
    }
  }
  
  return slotsToPost;
}

async function executePost(slot: string): Promise<boolean> {
  try {
    console.log(`\n🚀 投稿実行: ${slot}`);
    execSync(`npm run post:${slot}`, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      timeout: 60000
    });
    return true;
  } catch (error) {
    console.error(`❌ 投稿失敗: ${slot}`, error);
    return false;
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('🤖 スマート投稿システム');
  console.log('='.repeat(50));
  
  const today = getTodayJST();
  const currentHour = getCurrentHourJST();
  const postedSlots = getTodayPostedSlots();
  
  console.log(`\n📅 今日: ${today}`);
  console.log(`🕐 現在時刻(JST): ${currentHour}:00`);
  console.log(`✅ 投稿済みスロット: ${[...postedSlots].join(', ') || 'なし'}`);
  
  const slotsToPost = getSlotsToPost(currentHour);
  
  if (slotsToPost.length === 0) {
    console.log('\n✅ 未投稿のスロットはありません');
    
    // 次のスロットを表示
    const nextSlot = SLOTS.find(s => s.hour > currentHour && !postedSlots.has(s.name));
    if (nextSlot) {
      console.log(`⏳ 次回投稿: ${nextSlot.name} (${nextSlot.hour}:00 JST)`);
    } else {
      console.log('📊 本日の投稿は全て完了しています');
    }
    return;
  }
  
  console.log(`\n📝 投稿予定: ${slotsToPost.join(', ')}`);
  
  let successCount = 0;
  for (const slot of slotsToPost) {
    const success = await executePost(slot);
    if (success) successCount++;
    
    // 複数投稿の場合は間隔を空ける
    if (slotsToPost.indexOf(slot) < slotsToPost.length - 1) {
      console.log('⏳ 30秒待機...');
      await new Promise(r => setTimeout(r, 30000));
    }
  }
  
  console.log('\n' + '='.repeat(50));
  console.log(`✅ 完了: ${successCount}/${slotsToPost.length} 件投稿`);
}

main().catch(console.error);
