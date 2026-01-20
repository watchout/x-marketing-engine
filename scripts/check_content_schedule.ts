/**
 * コンテンツスケジュール抜け漏れチェックスクリプト
 * 
 * 機能:
 * - 今日の投稿予定を表示
 * - 今週の投稿状況をチェック
 * - 抜け漏れアラートを表示
 * 
 * 使い方:
 *   npm run marketing:check          # 今日の予定を表示
 *   npm run marketing:check -- week  # 今週の状況を表示
 *   npm run marketing:check -- alert # アラートのみ表示
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

// =============================================================================
// 型定義
// =============================================================================

interface XPost {
  time: string;
  type: string;
  content: string;
  status: 'scheduled' | 'planned' | 'posted' | 'skipped';
}

interface Article {
  article_id?: string;
  title: string;
  status: 'draft' | 'planned' | 'published';
  deadline: string;
}

interface DayContent {
  weekday: string;
  x: XPost[] | null;
  zenn: Article | null;
  note: Article | null;
}

interface Calendar {
  [date: string]: DayContent;
}

interface ContentSchedule {
  channels: {
    x: {
      frequency: {
        posts_per_week: number;
        min_per_day: number;
      };
    };
    zenn: {
      frequency: {
        posts_per_month: number;
      };
    };
    note: {
      frequency: {
        posts_per_month: number;
      };
    };
  };
  alerts: {
    x: Array<{ condition: string; message: string; severity: string }>;
    zenn: Array<{ condition: string; message: string; severity: string }>;
    note: Array<{ condition: string; message: string; severity: string }>;
  };
}

// =============================================================================
// ユーティリティ関数
// =============================================================================

function getJSTDate(): Date {
  const now = new Date();
  // UTC+9 for JST
  return new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getWeekDates(baseDate: Date): string[] {
  const dates: string[] = [];
  const dayOfWeek = baseDate.getDay();
  const monday = new Date(baseDate);
  monday.setDate(baseDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
  
  for (let i = 0; i < 7; i++) {
    const date = new Date(monday);
    date.setDate(monday.getDate() + i);
    dates.push(formatDate(date));
  }
  return dates;
}

function loadCalendar(month: string): Calendar | null {
  const calendarPath = path.join(process.cwd(), 'content', 'calendar', `${month}.yml`);
  if (!fs.existsSync(calendarPath)) {
    console.log(`⚠️ カレンダーが見つかりません: ${calendarPath}`);
    return null;
  }
  const content = fs.readFileSync(calendarPath, 'utf-8');
  const parsed = parseYaml(content);
  return parsed.calendar;
}

function loadSchedule(): ContentSchedule {
  const schedulePath = path.join(process.cwd(), 'ssot', 'content_schedule.yml');
  const content = fs.readFileSync(schedulePath, 'utf-8');
  return parseYaml(content);
}

// =============================================================================
// チェック関数
// =============================================================================

function showToday(calendar: Calendar): void {
  const today = formatDate(getJSTDate());
  const dayContent = calendar[today];
  
  console.log('\n' + '='.repeat(60));
  console.log(`📅 今日の投稿予定 (${today})`);
  console.log('='.repeat(60));
  
  if (!dayContent) {
    console.log('❌ 今日の予定が登録されていません');
    return;
  }
  
  console.log(`\n曜日: ${dayContent.weekday}`);
  
  // X
  console.log('\n【X（Twitter）】');
  if (dayContent.x && dayContent.x.length > 0) {
    dayContent.x.forEach((post, i) => {
      const statusIcon = post.status === 'posted' ? '✅' : 
                         post.status === 'scheduled' ? '⏰' : 
                         post.status === 'skipped' ? '⏭️' : '📝';
      console.log(`  ${i + 1}. ${statusIcon} ${post.time} [${post.type}]`);
      console.log(`     ${post.content.split('\n')[0]}...`);
    });
  } else {
    console.log('  📭 今日のX投稿はありません');
  }
  
  // Zenn
  console.log('\n【Zenn】');
  if (dayContent.zenn) {
    const statusIcon = dayContent.zenn.status === 'published' ? '✅' : '📝';
    console.log(`  ${statusIcon} ${dayContent.zenn.title}`);
    console.log(`     締切: ${dayContent.zenn.deadline} | 状態: ${dayContent.zenn.status}`);
  } else {
    console.log('  📭 今日のZenn記事公開予定はありません');
  }
  
  // note
  console.log('\n【note】');
  if (dayContent.note) {
    const statusIcon = dayContent.note.status === 'published' ? '✅' : '📝';
    console.log(`  ${statusIcon} ${dayContent.note.title}`);
    console.log(`     締切: ${dayContent.note.deadline} | 状態: ${dayContent.note.status}`);
  } else {
    console.log('  📭 今日のnote記事公開予定はありません');
  }
}

function showWeek(calendar: Calendar): void {
  const today = getJSTDate();
  const weekDates = getWeekDates(today);
  
  console.log('\n' + '='.repeat(60));
  console.log(`📊 今週の投稿状況 (${weekDates[0]} 〜 ${weekDates[6]})`);
  console.log('='.repeat(60));
  
  let xPostCount = 0;
  let xPostedCount = 0;
  
  const weekdays = ['月', '火', '水', '木', '金', '土', '日'];
  
  weekDates.forEach((date, i) => {
    const dayContent = calendar[date];
    const isToday = date === formatDate(today);
    const prefix = isToday ? '👉 ' : '   ';
    
    if (dayContent) {
      const xPosts = dayContent.x || [];
      const xCount = xPosts.length;
      const xPosted = xPosts.filter(p => p.status === 'posted').length;
      xPostCount += xCount;
      xPostedCount += xPosted;
      
      const zennIcon = dayContent.zenn ? 
        (dayContent.zenn.status === 'published' ? '✅' : '📝') : '  ';
      const noteIcon = dayContent.note ?
        (dayContent.note.status === 'published' ? '✅' : '📝') : '  ';
      
      console.log(`${prefix}${date} (${weekdays[i]}) | X: ${xPosted}/${xCount} | Zenn: ${zennIcon} | note: ${noteIcon}`);
    } else {
      console.log(`${prefix}${date} (${weekdays[i]}) | 未登録`);
    }
  });
  
  console.log('─'.repeat(60));
  console.log(`   X投稿: ${xPostedCount}/${xPostCount} 完了`);
  
  const schedule = loadSchedule();
  const targetPerWeek = schedule.channels.x.frequency.posts_per_week;
  
  if (xPostCount < targetPerWeek) {
    console.log(`   ⚠️ 目標 ${targetPerWeek} に対して ${targetPerWeek - xPostCount} 件不足`);
  }
}

function showAlerts(calendar: Calendar): void {
  const schedule = loadSchedule();
  const today = getJSTDate();
  const weekDates = getWeekDates(today);
  
  console.log('\n' + '='.repeat(60));
  console.log('🚨 アラート');
  console.log('='.repeat(60));
  
  let alertCount = 0;
  
  // X: 今週の投稿数チェック
  let xPostCount = 0;
  weekDates.forEach(date => {
    const dayContent = calendar[date];
    if (dayContent && dayContent.x) {
      xPostCount += dayContent.x.length;
    }
  });
  
  if (xPostCount < 7) {
    console.log(`\n⚠️ [X] 今週のX投稿が ${xPostCount} 件です（目標: 10件）`);
    alertCount++;
  }
  
  // 今日の投稿チェック
  const todayStr = formatDate(today);
  const todayContent = calendar[todayStr];
  if (!todayContent || !todayContent.x || todayContent.x.length === 0) {
    console.log(`\n🚨 [X] 今日（${todayStr}）のX投稿が登録されていません`);
    alertCount++;
  }
  
  // Zenn/note: 直近の記事チェック
  const allDates = Object.keys(calendar).sort();
  let lastZennDate: string | null = null;
  let lastNoteDate: string | null = null;
  
  allDates.forEach(date => {
    if (calendar[date].zenn?.status === 'published') {
      lastZennDate = date;
    }
    if (calendar[date].note?.status === 'published') {
      lastNoteDate = date;
    }
  });
  
  // 将来の予定（draft/planned）を確認
  const upcomingZenn = allDates.find(date => 
    date > todayStr && calendar[date].zenn && 
    ['draft', 'planned'].includes(calendar[date].zenn!.status)
  );
  
  const upcomingNote = allDates.find(date =>
    date > todayStr && calendar[date].note &&
    ['draft', 'planned'].includes(calendar[date].note!.status)
  );
  
  if (!upcomingZenn) {
    console.log(`\n⚠️ [Zenn] 今後のZenn記事公開予定がありません`);
    alertCount++;
  }
  
  if (!upcomingNote) {
    console.log(`\n⚠️ [note] 今後のnote記事公開予定がありません`);
    alertCount++;
  }
  
  if (alertCount === 0) {
    console.log('\n✅ アラートはありません');
  } else {
    console.log(`\n─`.repeat(30));
    console.log(`合計: ${alertCount} 件のアラート`);
  }
}

function showUpcoming(calendar: Calendar): void {
  const today = formatDate(getJSTDate());
  const upcomingDates = Object.keys(calendar)
    .filter(date => date >= today)
    .sort()
    .slice(0, 7);
  
  console.log('\n' + '='.repeat(60));
  console.log('📆 今後7日間の予定');
  console.log('='.repeat(60));
  
  upcomingDates.forEach(date => {
    const dayContent = calendar[date];
    const isToday = date === today;
    
    console.log(`\n${isToday ? '👉' : '📅'} ${date} (${dayContent.weekday})`);
    
    if (dayContent.x && dayContent.x.length > 0) {
      dayContent.x.forEach(post => {
        const statusIcon = post.status === 'posted' ? '✅' : 
                           post.status === 'scheduled' ? '⏰' : '📝';
        console.log(`   ${statusIcon} X ${post.time} [${post.type}]`);
      });
    }
    
    if (dayContent.zenn) {
      const statusIcon = dayContent.zenn.status === 'published' ? '✅' : '📝';
      console.log(`   ${statusIcon} Zenn: ${dayContent.zenn.title.substring(0, 30)}...`);
    }
    
    if (dayContent.note) {
      const statusIcon = dayContent.note.status === 'published' ? '✅' : '📝';
      console.log(`   ${statusIcon} note: ${dayContent.note.title.substring(0, 30)}...`);
    }
  });
}

// =============================================================================
// メイン処理
// =============================================================================

async function main(): Promise<void> {
  const command = process.argv[2] || 'today';
  const today = getJSTDate();
  const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  
  const calendar = loadCalendar(month);
  if (!calendar) {
    console.error('カレンダーの読み込みに失敗しました');
    process.exit(1);
  }
  
  switch (command) {
    case 'today':
      showToday(calendar);
      showAlerts(calendar);
      break;
    case 'week':
      showWeek(calendar);
      showAlerts(calendar);
      break;
    case 'alert':
      showAlerts(calendar);
      break;
    case 'upcoming':
      showUpcoming(calendar);
      break;
    default:
      console.log('使い方:');
      console.log('  npm run marketing:check          # 今日の予定');
      console.log('  npm run marketing:check -- week  # 今週の状況');
      console.log('  npm run marketing:check -- alert # アラートのみ');
      console.log('  npm run marketing:check -- upcoming # 今後7日間');
  }
}

main().catch(console.error);

