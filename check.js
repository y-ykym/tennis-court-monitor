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
// 予定との突き合わせ(2026-09-27): 通知する枠が残ったら、Worker の GET /auto/plans から A・B の予定(都の予約 + テニスベア)を取り、
//   時間が重なる枠は通知しない。時間が接する枠は同じ公園のものだけ通知する(自動予約と同じルール。lib/auto-rules.js の filterPlaceConflicts)。
//   予定が取れなければ従来どおり全部通知(安全側)
// ============================================================
const fs = require('fs');
const { scrapeAvailability } = require('./lib/scrape');
const { filterTargetSlots } = require('./lib/filter');
const { loadState, diffNewSlots, saveState } = require('./lib/state');
const { sendLineMessage, formatMessage, warmupBookingServer } = require('./lib/notify');
const { splitForNotification, filterPlaceConflicts } = require('./lib/auto-rules');
const { fetchAutoState, fetchPlans } = require('./lib/auto-client');

const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
  // 1. 空き状況を取得
  let slots;
  if (process.env.MOCK_SLOTS_FILE) {
    slots = JSON.parse(fs.readFileSync(process.env.MOCK_SLOTS_FILE, 'utf8'));
    console.log(`[mock] ${process.env.MOCK_SLOTS_FILE} から ${slots.length}件読込`);
  } else {
    try {
      slots = await scrapeAvailability();
    } catch (e) {
      // メンテナンスや一時的な障害の可能性が高いので、静かにスキップ(次回に任せる)。
      // 定期メンテの時間帯の決め打ちはしない(旧システムの公表値「毎月 27 日 12:00〜28 日 8:45」で
      // 2026-09-27 に稼働中のサイトを 21 時間飛ばしたため撤去。新システムに定期メンテの公表は無い)
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

  // 3.6 予定との突き合わせ: A・B の予定と時間が重なる枠は通知しない。接する枠は同じ公園のものだけ通知する(取れなければ全部通知)
  if (toNotify.length > 0 && process.env.BOOKING_BASE_URL && process.env.BOOKING_SIGNING_SECRET) {
    const res = await fetchPlans(process.env.BOOKING_BASE_URL, process.env.BOOKING_SIGNING_SECRET);
    if (res) {
      const { notify, suppressed } = filterPlaceConflicts(toNotify, res.plans);
      console.log(`A・B の予定 ${res.plans.length} 件と照合${res.failed?.length ? `(取れなかった分: ${res.failed.join('、')}。その分の重なりは判定できない)` : ''}`);
      for (const s of suppressed) console.log(`  通知しない: ${s.slot.date} ${s.slot.time} ${s.slot.facility} (${s.reason})`);
      toNotify = notify;
    }
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
    console.log(newSlots.length > 0 ? '新しい空きはすべて自動予約の対象(または除外枠・予定と重なる枠)のため通知しません。' : '新しい空きはありません。');
  }

  // 5. 今回の結果を保存(次回の比較用)
  saveState(targets);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
