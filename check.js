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
//
// フェーズ3(自動予約)との分担: 新しい空きのうち、自宅 Pi の自動予約が生きていれば
//   「自動予約の対象(利用日 >= 今日+4 日、除外日以外)」は通知しない(Pi が予約し、結果カードで知らせる)。
//   Pi が止まっていれば従来どおり全部通知する(受け皿)。除外枠(人が手放した枠)は通知しない。
//   Pi の生死と除外一覧は Worker の GET /auto/state から取る(lib/auto-client.js)。取れなければ全部通知(安全側)
// ============================================================
const fs = require('fs');
const { scrapeAvailability } = require('./lib/scrape');
const { filterTargetSlots } = require('./lib/filter');
const { loadState, diffNewSlots, saveState } = require('./lib/state');
const { sendLineMessage, formatMessage, warmupBookingServer } = require('./lib/notify');
const { inMaintenanceWindow } = require('./lib/maintenance');
const { splitForNotification } = require('./lib/auto-rules');
const { fetchAutoState } = require('./lib/auto-client');

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

  // 3.5 フェーズ3: Pi の自動予約が生きていれば、対象期間の枠は通知しない(Pi が予約する)。除外枠は通知しない
  let toNotify = newSlots;
  if (newSlots.length > 0 && process.env.BOOKING_BASE_URL && process.env.BOOKING_SIGNING_SECRET) {
    const autoState = await fetchAutoState(process.env.BOOKING_BASE_URL, process.env.BOOKING_SIGNING_SECRET);
    const { notify, suppressed, piAlive } = splitForNotification(newSlots, { now: Date.now(), autoState });
    console.log(`自動予約(Pi): ${autoState ? (piAlive ? '稼働中' : autoState.alive ? `生存(mode=${autoState.mode || '?'}, 自動予約は停止中)` : '停止中(生存の合図なし)') : '状態不明'}${autoState?.notifyEnabled === false ? ' / 空き通知は LINE の「つうちおふ」で停止中' : ''}`);
    for (const s of suppressed) console.log(`  通知しない: ${s.slot.date} ${s.slot.time} ${s.slot.facility} (${s.reason})`);
    toNotify = notify;
  }

  // 4. 新しい空きがあればLINEへ通知(Flex Message。dry-run時はテキスト表現で表示)
  if (toNotify.length > 0) {
    if (DRY_RUN) {
      console.log('[dry-run] 送信される通知内容:\n' + formatMessage(toNotify));
    } else {
      // 予約支援サーバー(フェーズ2)を通知と同時に起こしておく(コールドスタート対策。失敗しても通知は送る)
      const [sent] = await Promise.allSettled([sendLineMessage(toNotify), warmupBookingServer()]);
      if (sent.status === 'rejected') throw sent.reason;
      console.log(`LINE通知を送信しました (${toNotify.length}件)`);
    }
  } else {
    console.log(newSlots.length > 0 ? '新しい空きはすべて自動予約の対象(または除外枠)のため通知しません。' : '新しい空きはありません。');
  }

  // 5. 今回の結果を保存(次回の比較用)
  saveState(targets);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
