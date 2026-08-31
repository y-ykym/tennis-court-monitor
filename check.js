#!/usr/bin/env node
// ============================================================
// メイン処理: 空きチェック → 監視条件で絞り込み → 前回との差分検出
//            → 新しい空きだけLINE通知 → 状態保存
//
// 使い方:
//   node check.js              通常実行(LINE通知あり)
//   node check.js --dry-run    通知せず内容をコンソール表示のみ
//   MOCK_SLOTS_FILE=test/mock-slots.json node check.js --dry-run
//                              スクレイピングせずモックデータで動作確認
// ============================================================
const fs = require('fs');
const { scrapeAvailability } = require('./lib/scrape');
const { filterTargetSlots } = require('./lib/filter');
const { loadState, diffNewSlots, saveState } = require('./lib/state');
const { sendLineMessage, formatMessage } = require('./lib/notify');
const { inMaintenanceWindow } = require('./lib/maintenance');

const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
  // サイトの定期メンテナンス時間帯は最初からスキップ(エラー扱いにしない)
  if (inMaintenanceWindow(new Date())) {
    console.log('サイトのメンテナンス時間帯のため、今回はスキップします。');
    return;
  }

  // 1. 空き状況を取得
  let slots;
  if (process.env.MOCK_SLOTS_FILE) {
    slots = JSON.parse(fs.readFileSync(process.env.MOCK_SLOTS_FILE, 'utf8'));
    console.log(`[mock] ${process.env.MOCK_SLOTS_FILE} から ${slots.length}件読込`);
  } else {
    try {
      slots = await scrapeAvailability();
    } catch (e) {
      // 深夜メンテナンスや一時的な障害の可能性が高いので、静かにスキップ
      console.log(`取得失敗のためスキップします: ${e.message}`);
      return;
    }
  }

  // 2. 監視条件(平日=猿江19時 / 土日祝=3公園全時間)で絞り込み
  const targets = filterTargetSlots(slots);
  console.log(`空き枠: サイト全体 ${slots.length}件 / 監視対象 ${targets.length}件`);

  // 3. 前回結果と比較して「新しく出た空き」だけ抽出
  const prev = loadState();
  const newSlots = diffNewSlots(prev, targets);

  // 4. 新しい空きがあればLINEへ通知
  if (newSlots.length > 0) {
    const msg = formatMessage(newSlots);
    if (DRY_RUN) {
      console.log('[dry-run] 送信される通知内容:\n' + msg);
    } else {
      await sendLineMessage(msg);
      console.log(`LINE通知を送信しました (${newSlots.length}件)`);
    }
  } else {
    console.log('新しい空きはありません。');
  }

  // 5. 今回の結果を保存(次回の比較用)
  saveState(targets);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
