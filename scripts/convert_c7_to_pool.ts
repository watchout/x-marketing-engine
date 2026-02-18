/**
 * C7出力 → ab_test_pool.yml 変換スクリプト
 *
 * C7 Xスレッド/マルチテーマ投稿の出力（markdown）を既存のab_test_pool.ymlの
 * 投稿プールに変換・追加する。
 *
 * 使い方:
 *   # 従来モード（単一テーマスレッド）
 *   npx ts-node scripts/convert_c7_to_pool.ts <c7-output.md> [--theme "テーマ名"] [--start-date 2026-02-24] [--dry-run]
 *
 *   # マルチテーマモード（C0連携）
 *   npx ts-node scripts/convert_c7_to_pool.ts <c7-output.md> --multi-theme [--start-date 2026-02-24] [--dry-run]
 *
 * 機能:
 *   - C7 markdownからツイートを抽出
 *   - マルチテーマ形式の場合、テーマ別にパース
 *   - 1週間分のスケジュールに配置（morning/night × テーマ混在）
 *   - 各ツイートにVariant A（感情型）/ Variant B（丁寧型）を生成
 *   - ab_test_pool.yml に追加
 *   - pain_hypothesis_log.yml のweeks配列にもエントリ追加
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const PROJECT_ROOT = path.join(__dirname, '..');
const POOL_FILE = path.join(PROJECT_ROOT, 'content/ab_test_pool.yml');
const HYPOTHESIS_LOG = path.join(PROJECT_ROOT, 'content/pain_hypothesis_log.yml');

// ===== 型定義 =====

interface ParsedTweet {
  index: number;
  total: number;
  content: string;
  theme?: string;
}

interface MultiThemeParsed {
  themes: Array<{
    theme: string;
    approach: string;
    tweets: ParsedTweet[];
  }>;
}

interface PoolPost {
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
}

interface ConvertOptions {
  inputFile: string;
  theme: string;
  startDate: string;
  approach?: string;
  painLayer?: string;
  painWhat?: string;
  dryRun: boolean;
  multiTheme: boolean;
}

// ===== C7出力パーサー =====

function parseC7Output(content: string): ParsedTweet[] {
  const tweets: ParsedTweet[] = [];

  // パターン1: #### 1/N 形式
  const threadPattern = /####\s+(\d+)\/(\d+)\s*\n([\s\S]*?)(?=####\s+\d+\/\d+|---\s*\n\*\*エンゲージメント要素|$)/g;
  let match;

  while ((match = threadPattern.exec(content)) !== null) {
    const index = parseInt(match[1]);
    const total = parseInt(match[2]);
    let tweetContent = match[3].trim();

    // markdownの装飾を除去（**bold** → bold, `code` → code）
    tweetContent = tweetContent
      .replace(/---\s*$/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .trim();

    // 空のツイートはスキップ
    if (tweetContent.length > 0) {
      tweets.push({ index, total, content: tweetContent });
    }
  }

  // パターン2: パターン1でマッチしない場合、番号付きリスト形式を試行
  if (tweets.length === 0) {
    const listPattern = /(?:^|\n)(\d+)\.\s+([\s\S]*?)(?=\n\d+\.\s+|\n---|\n##|$)/g;
    while ((match = listPattern.exec(content)) !== null) {
      const index = parseInt(match[1]);
      let tweetContent = match[2].trim();
      if (tweetContent.length > 0) {
        tweets.push({ index, total: 0, content: tweetContent });
      }
    }
    // totalを後付け
    tweets.forEach(t => t.total = tweets.length);
  }

  // パターン3: --- 区切り形式（最終手段）
  if (tweets.length === 0) {
    const sections = content.split(/\n---\n/).filter(s => s.trim().length > 0);
    sections.forEach((section, i) => {
      const cleaned = section
        .replace(/^#+.*\n/gm, '') // ヘッダー除去
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .trim();
      if (cleaned.length > 0 && cleaned.length < 500) {
        tweets.push({ index: i + 1, total: sections.length, content: cleaned });
      }
    });
  }

  return tweets;
}

// ===== マルチテーマ C7出力パーサー =====

function parseMultiThemeC7Output(content: string): MultiThemeParsed {
  const result: MultiThemeParsed = { themes: [] };

  // パターン: ### テーマN: [テーマ名]（N投稿）
  const themeSections = content.split(/###\s+テーマ\d+:\s*/);

  for (let i = 1; i < themeSections.length; i++) {
    const section = themeSections[i];

    // テーマ名を抽出（最初の行）
    const firstLine = section.split('\n')[0].trim();
    const themeMatch = firstLine.match(/^(.+?)(?:（(\d+)投稿）)?$/);
    const themeName = themeMatch ? themeMatch[1].trim() : `テーマ${i}`;

    // アプローチを抽出
    const approachMatch = section.match(/アプローチ[:：]\s*(\S+)/);
    const approach = approachMatch ? approachMatch[1] : 'unknown';

    // 投稿を抽出: #### 投稿N-M パターン
    const tweets: ParsedTweet[] = [];
    const postPattern = /####\s+投稿\d+-(\d+)\s*\n([\s\S]*?)(?=####\s+投稿|###\s+テーマ|###\s+品質|$)/g;
    let postMatch;

    while ((postMatch = postPattern.exec(section)) !== null) {
      const postIndex = parseInt(postMatch[1]);
      const postContent = postMatch[2];

      // Variant A を抽出
      const variantAMatch = postContent.match(/\*\*Variant A[^*]*\*\*[:：]?\s*\n([\s\S]*?)(?=\*\*Variant B|\n-\s+文字数|$)/);
      if (variantAMatch) {
        const tweetContent = variantAMatch[1].trim()
          .replace(/^>\s*/gm, '')     // blockquote除去
          .replace(/\*\*([^*]+)\*\*/g, '$1')  // bold除去
          .trim();

        if (tweetContent.length > 0) {
          tweets.push({
            index: postIndex,
            total: 0,
            content: tweetContent,
            theme: themeName,
          });
        }
      }
    }

    // パターン2: Variant A/Bがない場合、投稿テキストを直接抽出
    if (tweets.length === 0) {
      const simplePostPattern = /####\s+投稿\d+-(\d+)\s*\n([\s\S]*?)(?=####|###|$)/g;
      let simpleMatch;
      while ((simpleMatch = simplePostPattern.exec(section)) !== null) {
        const text = simpleMatch[2].trim()
          .replace(/^>\s*/gm, '')
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/---\s*$/gm, '')
          .replace(/- 文字数:.*/g, '')
          .replace(/- フック:.*/g, '')
          .replace(/- 推奨スロット:.*/g, '')
          .trim();

        if (text.length > 0 && text.length < 500) {
          tweets.push({
            index: parseInt(simpleMatch[1]),
            total: 0,
            content: text,
            theme: themeName,
          });
        }
      }
    }

    // totalを後付け
    tweets.forEach(t => t.total = tweets.length);

    if (tweets.length > 0) {
      result.themes.push({
        theme: themeName,
        approach,
        tweets,
      });
    }
  }

  return result;
}

// ===== テーマ・メタデータ抽出 =====

function extractMetadata(content: string): { theme?: string; target?: string; timing?: string } {
  const result: { theme?: string; target?: string; timing?: string } = {};

  // スレッド戦略セクションから抽出
  const targetMatch = content.match(/\*\*ターゲット\*\*:\s*(.+)/);
  if (targetMatch) result.target = targetMatch[1].trim();

  const timingMatch = content.match(/\*\*投稿タイミング\*\*:\s*(.+)/);
  if (timingMatch) result.timing = timingMatch[1].trim();

  // 狙いから推測
  const aimMatch = content.match(/\*\*狙い\*\*:\s*(.+)/);
  if (aimMatch) result.theme = aimMatch[1].trim();

  return result;
}

// ===== 投稿タイプの推定 =====

function inferPostType(content: string, index: number, total: number): string {
  if (index === 1) return 'hook';
  if (index === total) return 'cta';

  // コンテンツ分析
  if (content.match(/[？?]/) && content.length < 100) return 'question';
  if (content.match(/\d+[%％倍]|[0-9]+[万億]|前年比/)) return 'data_proof';
  if (content.match(/実は|知ら[なれ]/)) return 'discovery';
  if (content.match(/手順|ステップ|方法|やり方|設定/)) return 'tips';
  if (content.match(/あるある|わかる|つらい|苦労/)) return 'empathy';
  if (content.match(/結果|変わ|実現|達成/)) return 'proof';

  return 'content';
}

// ===== Variant B 生成（丁寧型に変換）=====

function generateVariantB(originalContent: string): string {
  // 感情型（Variant A）→ 丁寧型（Variant B）への変換
  let content = originalContent;

  // 口語的な表現をフォーマルに
  content = content
    .replace(/マジで/g, '本当に')
    .replace(/ヤバい/g, '驚くべき')
    .replace(/めっちゃ/g, '非常に')
    .replace(/〜じゃん/g, '〜ですよね')
    .replace(/だよね/g, 'ですよね')
    .replace(/だけど/g, 'ですが')
    .replace(/なんだ/g, 'なのです')
    .replace(/してみた/g, 'してみました')
    .replace(/だった/g, 'でした')
    .replace(/なった/g, 'なりました')
    .replace(/できた/g, 'できました')
    .replace(/わかった/g, 'わかりました');

  // 文末の変換
  content = content
    .replace(/([^。！？\n])$/gm, (match) => {
      if (match.endsWith('。') || match.endsWith('！') || match.endsWith('？')) return match;
      return match;
    });

  // 絵文字の調整（一部削除）
  const emojis = content.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu);
  if (emojis && emojis.length > 3) {
    // 絵文字が多すぎる場合、半分に減らす
    let count = 0;
    content = content.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, (match) => {
      count++;
      return count % 2 === 0 ? '' : match;
    });
  }

  // 変更がなかった場合はサフィックスを付ける
  if (content === originalContent) {
    // 末尾に「。」がなければ追加
    content = content.trimEnd();
    if (!content.endsWith('。') && !content.endsWith('！') && !content.endsWith('？')) {
      content += '。';
    }
    // 少し表現を変える
    content = content
      .replace(/！/g, '。')
      .replace(/✨/g, '')
      .replace(/🔥/g, '')
      .replace(/💡/g, '');
  }

  return content.trim();
}

// ===== スケジュール配置 =====

function scheduleTweets(
  tweets: ParsedTweet[],
  startDate: string,
  slotsPerDay: string[] = ['morning', 'night']
): Array<{ tweet: ParsedTweet; date: string; slot: string }> {
  const scheduled: Array<{ tweet: ParsedTweet; date: string; slot: string }> = [];
  const start = new Date(startDate + 'T00:00:00Z');

  let dayOffset = 0;
  let slotIndex = 0;

  for (const tweet of tweets) {
    const date = new Date(start.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const dateStr = date.toISOString().split('T')[0];
    const slot = slotsPerDay[slotIndex];

    scheduled.push({ tweet, date: dateStr, slot });

    slotIndex++;
    if (slotIndex >= slotsPerDay.length) {
      slotIndex = 0;
      dayOffset++;
    }
  }

  return scheduled;
}

// マルチテーマの投稿をインターリーブ配置（テーマが連続しないように）
function scheduleMultiThemeTweets(
  multiTheme: MultiThemeParsed,
  startDate: string,
  slotsPerDay: string[] = ['morning', 'night']
): Array<{ tweet: ParsedTweet; date: string; slot: string }> {
  // 各テーマの投稿を順番にインターリーブ
  const allTweets: ParsedTweet[] = [];
  const maxLen = Math.max(...multiTheme.themes.map(t => t.tweets.length));

  for (let i = 0; i < maxLen; i++) {
    for (const themeGroup of multiTheme.themes) {
      if (i < themeGroup.tweets.length) {
        allTweets.push(themeGroup.tweets[i]);
      }
    }
  }

  return scheduleTweets(allTweets, startDate, slotsPerDay);
}

// ===== ab_test_pool.yml に追加 =====

function addToPool(newPosts: PoolPost[], dryRun: boolean): void {
  let pool: any;

  if (fs.existsSync(POOL_FILE)) {
    pool = yaml.load(fs.readFileSync(POOL_FILE, 'utf-8')) as any;
  } else {
    pool = {
      metadata: {
        version: '2.0',
        created: new Date().toISOString(),
        goal: 'ペイン分析ベースのテーマ別投稿',
        note: 'C7出力からの変換',
      },
      time_slots: {
        morning: { time: '08:00', purpose: '有益情報・Tips' },
        night: { time: '21:00', purpose: '共感・思想・ストーリー' },
      },
      posts: [],
    };
  }

  // 既存のactive投稿をarchiveに変更（オプション）
  // 古い投稿は残すが、新しいテーマの投稿を追加
  pool.posts = [...(pool.posts || []), ...newPosts];

  if (dryRun) {
    console.log('\n📋 生成された投稿プレビュー:\n');
    for (const post of newPosts) {
      console.log(`  📅 ${post.scheduled_date} [${post.slot}]`);
      console.log(`     テーマ: ${post.theme}`);
      console.log(`     タイプ: ${post.type}`);
      console.log(`     A: ${post.variants.A.content.substring(0, 60)}...`);
      console.log(`     B: ${post.variants.B.content.substring(0, 60)}...`);
      console.log('');
    }
    console.log(`\n🔍 DRY RUN - ${newPosts.length} 件の投稿を生成（プールには追加されていません）`);
    return;
  }

  // 保存
  const yamlContent = yaml.dump(pool, {
    lineWidth: -1,
    noRefs: true,
    quotingType: "'",
    forceQuotes: false,
  });
  fs.writeFileSync(POOL_FILE, yamlContent);
  console.log(`\n✅ ${newPosts.length} 件の投稿を ab_test_pool.yml に追加しました`);
}

// ===== pain_hypothesis_log.yml 更新 =====

function updateHypothesisLog(
  theme: string,
  postsCount: number,
  approach: string,
  painLayer: string,
  painWhat: string,
  dryRun: boolean
): void {
  if (dryRun) return;

  if (!fs.existsSync(HYPOTHESIS_LOG)) {
    console.log('⚠️ pain_hypothesis_log.yml が見つかりません。スキップします。');
    return;
  }

  const log = yaml.load(fs.readFileSync(HYPOTHESIS_LOG, 'utf-8')) as any;

  // 現在の週番号を計算
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
  const weekStr = `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  const dateStr = now.toISOString().split('T')[0];

  const newEntry = {
    week: weekStr,
    date: dateStr,
    theme: theme,
    why_this_theme: '(C0テーマ決定時に記入)',
    pain: {
      what: painWhat || '(C0で分析)',
      layer: painLayer || 'surface_pain',
    },
    approach: approach || '(C0で選定)',
    why_this_approach: '(C0で記入)',
    framework_link: {
      matched: false,
      what: '',
    },
    exit_connection: {
      target: '',
      angle: '',
    },
    discord_input: {
      asked: false,
      responses: 0,
      useful_insights: '',
    },
    result: {
      posts_count: postsCount,
      avg_imp: null,
      avg_likes: null,
      avg_er: null,
      best_post: null,
      worst_post: null,
    },
    verification: {
      pain_accurate: null,
      approach_effective: null,
      expression_worked: null,
      framework_link_value: null,
    },
    learning: '',
    next_action: '',
  };

  // weeks配列に追加
  if (!log.weeks || !Array.isArray(log.weeks)) {
    log.weeks = [];
  }
  log.weeks.push(newEntry);

  const yamlContent = yaml.dump(log, {
    lineWidth: -1,
    noRefs: true,
    quotingType: "'",
    forceQuotes: false,
  });

  // ヘッダーコメントを復元
  const header = `# ペイン仮説検証ログ
# 毎週のテーマ決定→結果→学びを蓄積する
# C0テーマ決定エージェントが過去の学びを参照する

`;

  fs.writeFileSync(HYPOTHESIS_LOG, header + yamlContent);
  console.log(`✅ pain_hypothesis_log.yml に ${weekStr} のエントリを追加しました`);
}

// ===== マルチテーマ変換処理 =====

function convertMultiTheme(options: ConvertOptions): void {
  console.log('\n🔄 C7マルチテーマ出力 → ab_test_pool.yml 変換\n');

  if (!fs.existsSync(options.inputFile)) {
    console.error(`❌ ファイルが見つかりません: ${options.inputFile}`);
    process.exit(1);
  }

  const content = fs.readFileSync(options.inputFile, 'utf-8');
  console.log(`📄 入力ファイル: ${options.inputFile}`);

  // マルチテーマパース
  const multiTheme = parseMultiThemeC7Output(content);

  if (multiTheme.themes.length === 0) {
    console.error('❌ マルチテーマ形式のツイートが抽出できませんでした。');
    console.log('   従来モードで再試行します...\n');
    // フォールバック: 従来モードで処理
    options.multiTheme = false;
    convert(options);
    return;
  }

  console.log(`🎯 テーマ数: ${multiTheme.themes.length}`);
  for (const t of multiTheme.themes) {
    console.log(`   📝 ${t.theme}: ${t.tweets.length}投稿 (${t.approach})`);
  }

  // インターリーブ配置
  const scheduled = scheduleMultiThemeTweets(multiTheme, options.startDate);
  console.log(`📅 スケジュール: ${options.startDate} 〜 ${scheduled[scheduled.length - 1]?.date}`);

  // 投稿プール形式に変換
  const poolPosts: PoolPost[] = scheduled.map((item, idx) => {
    const theme = item.tweet.theme || 'テーマ未設定';
    const postType = inferPostType(item.tweet.content, item.tweet.index, item.tweet.total);
    const variantB = generateVariantB(item.tweet.content);

    return {
      id: `post_${Date.now()}_mt_${idx}`,
      generated_at: new Date().toISOString(),
      scheduled_date: item.date,
      slot: item.slot,
      topic: item.tweet.content.substring(0, 80),
      theme: theme,
      type: postType,
      quality_score: 0,
      refinement_rounds: 0,
      variants: {
        A: {
          content: item.tweet.content,
          hook_type: 'フック型A',
        },
        B: {
          content: variantB,
          hook_type: 'フック型B',
        },
      },
      scores: {
        hook_strength: 0,
        persona_fit: 0,
        x_culture_fit: 0,
        specificity: 0,
        credibility: 0,
        total: 0,
        feedback: `C7マルチテーマ出力から変換。テーマ: ${theme}`,
      },
      status: 'active',
    };
  });

  // プールに追加
  addToPool(poolPosts, options.dryRun);

  // 各テーマの仮説ログ更新
  for (const themeGroup of multiTheme.themes) {
    const themePosts = poolPosts.filter(p => p.theme === themeGroup.theme);
    updateHypothesisLog(
      themeGroup.theme,
      themePosts.length,
      themeGroup.approach,
      options.painLayer || '',
      options.painWhat || '',
      options.dryRun
    );
  }

  // サマリー
  console.log('\n📊 マルチテーマ変換サマリー:');
  console.log(`   テーマ数: ${multiTheme.themes.length}`);
  console.log(`   合計投稿数: ${poolPosts.length}`);
  console.log(`   期間: ${scheduled[0]?.date} 〜 ${scheduled[scheduled.length - 1]?.date}`);

  const themeCount = poolPosts.reduce((acc, p) => {
    acc[p.theme] = (acc[p.theme] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log(`   テーマ別内訳:`);
  for (const [theme, count] of Object.entries(themeCount)) {
    console.log(`     ${theme}: ${count}投稿`);
  }
}

// ===== メイン変換処理（従来モード）=====

function convert(options: ConvertOptions): void {
  console.log('\n🔄 C7出力 → ab_test_pool.yml 変換\n');

  // C7出力を読み込み
  if (!fs.existsSync(options.inputFile)) {
    console.error(`❌ ファイルが見つかりません: ${options.inputFile}`);
    process.exit(1);
  }

  const content = fs.readFileSync(options.inputFile, 'utf-8');
  console.log(`📄 入力ファイル: ${options.inputFile}`);

  // メタデータ抽出
  const metadata = extractMetadata(content);
  const theme = options.theme || metadata.theme || 'テーマ未設定';
  console.log(`🎯 テーマ: ${theme}`);

  // ツイート抽出
  const tweets = parseC7Output(content);
  if (tweets.length === 0) {
    console.error('❌ ツイートが抽出できませんでした。C7出力のフォーマットを確認してください。');
    process.exit(1);
  }
  console.log(`📝 抽出されたツイート数: ${tweets.length}`);

  // スケジュール配置
  const scheduled = scheduleTweets(tweets, options.startDate);
  console.log(`📅 スケジュール: ${options.startDate} 〜 ${scheduled[scheduled.length - 1]?.date}`);

  // 投稿プール形式に変換
  const poolPosts: PoolPost[] = scheduled.map((item) => {
    const postType = inferPostType(item.tweet.content, item.tweet.index, item.tweet.total);
    const variantB = generateVariantB(item.tweet.content);

    return {
      id: `post_${Date.now()}_${item.tweet.index}`,
      generated_at: new Date().toISOString(),
      scheduled_date: item.date,
      slot: item.slot,
      topic: item.tweet.content.substring(0, 80),
      theme: theme,
      type: postType,
      quality_score: 0,
      refinement_rounds: 0,
      variants: {
        A: {
          content: item.tweet.content,
          hook_type: 'フック型A',
        },
        B: {
          content: variantB,
          hook_type: 'フック型B',
        },
      },
      scores: {
        hook_strength: 0,
        persona_fit: 0,
        x_culture_fit: 0,
        specificity: 0,
        credibility: 0,
        total: 0,
        feedback: 'C7出力から変換。投稿後にメトリクスを収集して評価。',
      },
      status: 'active',
    };
  });

  // プールに追加
  addToPool(poolPosts, options.dryRun);

  // 仮説ログ更新
  updateHypothesisLog(
    theme,
    poolPosts.length,
    options.approach || '',
    options.painLayer || '',
    options.painWhat || '',
    options.dryRun
  );

  // サマリー
  console.log('\n📊 変換サマリー:');
  console.log(`   テーマ: ${theme}`);
  console.log(`   投稿数: ${poolPosts.length}`);
  console.log(`   期間: ${scheduled[0]?.date} 〜 ${scheduled[scheduled.length - 1]?.date}`);

  const typeCount = poolPosts.reduce((acc, p) => {
    acc[p.type] = (acc[p.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log(`   タイプ内訳: ${Object.entries(typeCount).map(([k, v]) => `${k}:${v}`).join(', ')}`);
}

// ===== CLI =====

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
C7出力 → ab_test_pool.yml 変換スクリプト

使い方:
  npx ts-node scripts/convert_c7_to_pool.ts <c7-output.md> [options]

オプション:
  --theme <テーマ名>       投稿テーマ名（単一テーマモード用）
  --multi-theme            マルチテーマモード（C0連携時）
  --start-date <YYYY-MM-DD>  投稿開始日（デフォルト: 明後日）
  --approach <アプローチ>    solution / empathy / discovery / warning / proof
  --pain-layer <レイヤー>    surface_pain / deeper_pain / desire / identity
  --pain-what <ペイン>       刺すペインの内容
  --dry-run                ドライラン（プレビューのみ）

例:
  # 従来モード（単一テーマ）
  npx ts-node scripts/convert_c7_to_pool.ts outputs/mcp/260217/c7-x-thread.md --theme "MCPサーバー導入"

  # マルチテーマモード（C0連携）
  npx ts-node scripts/convert_c7_to_pool.ts outputs/multi-theme/260218/c7-x-thread.md --multi-theme --start-date 2026-02-24

  # ドライラン
  npx ts-node scripts/convert_c7_to_pool.ts c7-output.md --multi-theme --dry-run
`);
    process.exit(0);
  }

  const inputFile = args[0];

  // デフォルト開始日: 明後日（準備期間を考慮）
  const dayAfterTomorrow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const defaultStartDate = dayAfterTomorrow.toISOString().split('T')[0];

  const options: ConvertOptions = {
    inputFile: path.resolve(inputFile),
    theme: '',
    startDate: defaultStartDate,
    dryRun: false,
    multiTheme: false,
  };

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--theme':
        options.theme = args[++i] || '';
        break;
      case '--multi-theme':
        options.multiTheme = true;
        break;
      case '--start-date':
        options.startDate = args[++i] || defaultStartDate;
        break;
      case '--approach':
        options.approach = args[++i] || '';
        break;
      case '--pain-layer':
        options.painLayer = args[++i] || '';
        break;
      case '--pain-what':
        options.painWhat = args[++i] || '';
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
    }
  }

  // マルチテーマモードか従来モードかで分岐
  if (options.multiTheme) {
    convertMultiTheme(options);
  } else {
    convert(options);
  }
}

main();
