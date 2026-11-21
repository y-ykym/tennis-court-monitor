// ============================================================
// フェーズ3 自動予約の中核(Pi の予約支援サーバーの中で動く。server/server.mjs から起動)
//
//   定期的に(AUTO_BOOKING.POLL_INTERVAL_MS と POLL_SCHEDULE。9〜12 時・14〜15 時・16〜20 時・0〜1 時は 1 分、12 時台・20〜24 時は 30 秒、7〜9 時・13 時台・15 時台は 2 分、1〜2 時は 3 分、2〜7 時は 10 分。
//   30 秒未満にはしない。「前回の開始から間隔ぶん後」に次を始め、照会自体が間隔を超えたときは MIN_GAP_MS だけ空けて次を始める):
//     空き照会(lib/scrape.js。ログイン不要の JSON)→ 監視条件(lib/filter.js)→ 前回との差分 = 新しく出た空き
//     → Worker に「生きている」合図(heartbeat)を送り、応答で除外日・除外枠を受け取る
//     → lib/auto-rules.js で振り分け(ペナルティ期間・除外日・除外枠は見送り。ただし「せってい」で 1 枠ずつ選んだ「追加枠」は対象。追加枠は 1 日の上限・場所の判定も掛けない)、
//       利用日ごとに公園→時間帯の優先順に並べる
//     → 候補を 1 件ずつ予約の行列(booking-queue.js)に入れる。行列は 1 件ずつ実行し、手動(LINE ボタン)を優先する
//     → 一時エラー(error)で終わった枠は、直近の照会でまだ空いていれば待たずにその場でもう一度予約する(ERROR_RETRY_NOW_MAX=1 回。2026-11-08)
//     → それでも error で終わった枠が ERROR_RETRY_AFTER_MS(5 分)後もまだ空いていれば、同じ流れで再挑戦する(ERROR_RETRY_MAX=2 回まで。2026-11-06)
//     → 行列に他の枠が待っているときは、error の枠をすぐ捨てずに行列の後ろへ戻す(ERROR_REQUEUE_MAX=2 回まで。2026-11-22)
//   各候補の実行(行列の中):
//     まず「いま」の時刻で対象かどうかをもう一度判定する(要件 #11。23:59 に見つけて 00:01 に実行すると +3 日 = ペナルティ期間になる。
//     +4 日の枠は 23:35 以降は自動予約しない)。対象外になっていたら予約せず、Pi 自身が従来の空き通知カード(予約ボタン付き)を送る
//     (Actions は見つけた時点で「対象枠だから通知しない」と処理済みのことがあるため)。除外日・除外枠になっていたらカードも送らない。
//     その利用日の残り枚数が 0 なら見送り(ログイン不要)。
//     手元の予約一覧(Worker の /auto/plans で 1 時間ごとに取り直す A・B の都の予約。成立分はその場で足す)でその日が上限でも見送り(ログイン不要。2026-11-19)。
//     次に Worker からその人のテニスベアの予定を取り(/auto/tennisbear。10 分は使い回す)、候補と時間が重なる予定(場所を問わず)、
//     または時間が接する別の場所の予定があれば見送り 'conflict'(ログイン不要。2026-09-24 追加。lib/auto-rules.js の findPlaceConflict)。
//     テニスベアの予定が取れなければ、直近 60 分以内の結果があればそれで判定し、無ければ見送る(判定できないため予約しない)。
//     そうでなければ reserve() を reservationList + beforeApply 付きで呼び、ログイン直後の予約一覧でその日の件数を数え、
//     上限(平日 MAX_PER_DAY 件・土日祝 MAX_PER_DAY_HOLIDAY 件。テニスベアの予定は数えない)なら予約せず 'capped'。同じ一覧で、候補と時間が重なる予約・接する別の公園の予約が
//     あれば同じく 'conflict'。成立したら結果カード(自動予約の表記。
//     利用日 = 今日+4 日なら「ペナルティなしで取り消せるのは今日 23:59 まで」とキャンセルボタン)。見送りはカードなし。
//     失敗のうち「先に取られた(taken)」「サイトが断った(duplicate)」は LINE の通数を節約するためカードを送らずログのみ(人が何もできない失敗)。
//     ログインできない・reCAPTCHA で拒否・サイトのエラーは放置すると自動予約が全部止まるのでカードで知らせる
//     予約一覧に「自分が自動予約した枠」が無ければ、サイトで手放したとみなして Worker に除外枠として登録する
//     (一覧が本物の画面でなければ reserve.js が先に中止するので、ここには本物の一覧しか来ない。2026-10-10 に追加)
//
//   mode: 'on'     予約まで行う(heartbeat の active=true → Actions は対象期間の枠を通知しない)
//         'dry-run' 照会と振り分けだけ行い、予約するはずの枠をログに出す(active=false → Actions は従来どおり全部通知)
//   LINE の「じどうおふ」/「じどうおん」: Worker の KV のスイッチを heartbeat の応答(enabled)で受け取る。OFF の間は mode='on' でも
//         予約せず(dry-run と同じ動き。ログは [LINE で停止中])、Worker には mode='paused'・active=false を申告する
//
//   初回起動(状態ファイルが無い・古い): いま見えている空きを既知として登録し、予約しない(起動直後の暴走防止)
//   実枠テスト用: forgetFile(既定 /var/lib/booking/forget-keys.txt)に枠キーを 1 行ずつ書いておくと、次の周期でその枠を
//   「既知」から外す = いま見えている空きを「新しく出た」扱いにして予約の流れに乗せる(ファイルは読んだら消す)。
//   Pi 上で: docker compose exec booking sh -c 'echo "1160|2026-09-27|15:00" > /var/lib/booking/forget-keys.txt'
//   Worker に繋がらない: 直近 EXCLUSIONS_MAX_AGE_MS 以内に取れた除外一覧があればそれで続行、無ければ予約しない(除外日を守れないため)
//   空き照会が連続で失敗(サイトのメンテナンス・長い障害): BACKOFF_AFTER 回目から次の照会までの間隔を BACKOFF_STEPS_MS の順に広げ、
//     1 回成功したら通常の間隔に戻す(2026-09-27。定期メンテの時間帯の決め打ち lib/maintenance.js は撤去。
//     旧システムの公表値「毎月 27 日 12:00〜28 日 8:45」で稼働中のサイトを 21 時間飛ばしたため。新システムに定期メンテの公表は無い)
//     都サイトの「お知らせ」ページ(lib/site-notice.js)が返った失敗も同じく 3 回目から広げるが、広げるのは 3 分まで(NOTICE_BACKOFF_STEPS_MS)。
//     2026-11-09〜10 の夜に出たお知らせ 31 回のうち 20 回は 1 回きり・8 回は 2 回続きの短い不調で、長い 3 回も「つながりにくい」状態だった
//     (同時刻の GitHub 側は 3 回に 1 回ほど成功)。1 回目から広げて 15 分まで伸ばすと、夜の 2 時間 18 分で 9 回しか照会できなかった(2026-11-11)
//
//   ログには利用者番号・パスワード・鍵・Cookie を出さない。見送りの理由は必ず出す
// ============================================================
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { signCancelToken } from './cancel-token.js';
import { buildResultFlex } from './result-flex.js';

const require = createRequire(import.meta.url);
const { AUTO_BOOKING, PARKS } = require('../../lib/config.js');
const { isTargetSlot } = require('../../lib/filter.js');
const { jstTodayIso, jstEndOfDaySec, jstHHMM, daysBetween } = require('../../lib/date.js');
const { slotKey, parkOf, planAutoBooking, classifySlot, isFreeCancelLastDay, isPenaltyPeriod, startHHMM, findPlaceConflict, maxPerDayFor } = require('../../lib/auto-rules.js');

// 除外一覧はこれより古いものを使わない(Worker に繋がらない間は、これを過ぎたら予約しない)
const EXCLUSIONS_MAX_AGE_MS = 30 * 60 * 1000;
// これらの結果の枠は同じ枠が「新しく出た」扱いになっても再投入しない
const NO_RETRY_STATUSES = new Set(['queued', 'running', 'success']);
// error(都サイトの一時エラー・タイムアウト)で終わった枠が、そのあとも空いたまま見えていれば、これだけ経ってから再挑戦する。回数は ERROR_RETRY_MAX まで
// (2026-11-06。11/5 12:46 の大島は「予約」押下後 90 秒無応答で error になった後、34 分も空いたままだったのに二度と挑戦しなかった。
//  記録のある 3 週間で同じ取りこぼしが 3 回(6 分・34 分・95 分)。押した直後のやり直しは server.mjs が二重予約よけで止めているが、
//  数分後の再挑戦は予約直前の一覧(beforeApply)で入っていないことを確かめてから押すので安全)
export const ERROR_RETRY_AFTER_MS = 5 * 60 * 1000;
export const ERROR_RETRY_MAX = 2;
// error で終わった直後に、待たずにその場でやり直す回数(2026-11-08 本人指示)。
// 直近 1 週間の失敗 3 件は全部「予約」押下後に都サイトが応答しなかったもの(90 秒無応答・pawfa1000 のデータ通信エラー・確認画面のまま)で、
// 空きは 179 件中 119 件が 2 分以内に消えるため、5 分後の再挑戦では大半が間に合わない。error は予約が入っていない
// (reserve.js が押した後の error では予約一覧で未成立を確かめて error にしている)ので、やり直しの前に一覧を見直す処理は入れない。
// 直近の照会で枠が消えていれば taken 相当なのでやり直さない
export const ERROR_RETRY_NOW_MAX = 1;
// error で終わった枠を、行列の後ろへ戻してもう一度挑戦する回数(2026-11-22 本人指示)。
// 22 日 0 時の先着受付で亀戸 9 枠が並んだとき、都サイトの 502 で 1 枠に 1〜5 分かかり、error の枠はそのまま捨てられた。
// 同時に空き照会も 502 で止まり(15 分の間隔あけ)、5 分後の再挑戦(tick 側)も動けず、25 分後に 9 枠とも消えていた。
// 戻すのは「他の枠が行列で待っている」ときだけ(先に他の枠の 1 回目を済ませる。行列が空なら従来どおり 5 分後の再挑戦に任せる)。
// 予約が入っていないことは reserve.js が error の前に確かめているので、戻しても二重にはならない
export const ERROR_REQUEUE_MAX = 2;
// 照会が間隔より長くかかったとき、次の照会までに最低これだけ空ける
export const MIN_GAP_MS = 15 * 1000;
// 空き照会で一部の 公園×週 だけ取れなかったとき(lib/scrape.js の failures)、その分は前回の結果で補って照会を続ける(2026-11-08)。
// 補うのに使う「その公園を最後にきちんと取れた時刻」がこれより古ければ、補わずに従来どおり照会の失敗(スキップ)にする
// (古い結果で補い続けると、取られた枠が空いたままに見えたり、新しい空きを見逃したまま照会が「成功」になるため)
export const PARTIAL_CARRY_MAX_MS = 10 * 60 * 1000;
// 「その日は既に上限まで予約がある」という記憶の有効時間。過ぎたら次の候補でまた一覧を見て数える。
// 15 分だと、同じ枠が空いたり取られたりを繰り返す(9/17 の 9/21 17:00 猿江)たびにログインしてしまうので 60 分に(2026-09-17)
export const DAY_REMAINING_TTL_MS = 60 * 60 * 1000;
// A・B の都の予約一覧を手元に持っておく(2026-11-19 本人提案)。SITE_LIST_REFRESH_MS ごとに Worker の /auto/plans で取り直し、
// 自動予約が成立したらその場で足す。「その日は既に予約がある」枠を、ログインせずに見送るのに使う
// (11/17 16:46 は、既に予約のある 11/22 の大島をログインして見送るのに 22 秒 + ブラウザの起こし直し 30 秒かかり、
//  同時に出た 11/27 の猿江が待たされて先を越された。上の DAY_REMAINING は「その日の予約に挑戦した後の 60 分」しか覚えていない)。
// 手元の一覧が「0 件」のときは従来どおりログインして予約直前の一覧(beforeApply)で数えるので、古い一覧のせいで二重に取ることはない。
// 逆に、サイトで直接取り消した日は次の取り直しまで「予約あり」のままになる(最大で SITE_LIST_MAX_AGE_MS)。
// LINE での取消・LINE のボタンでの手動予約は、その場で手元の一覧に反映する(applyCancels / noteBooked。同日追加)。
// 本人は「予約サイトで直接は操作しない」前提で運用する(2026-11-19 本人明言)
export const SITE_LIST_REFRESH_MS = 60 * 60 * 1000;
// 取り直しに失敗したときは、これだけ空けてもう一度
export const SITE_LIST_RETRY_MS = 10 * 60 * 1000;
// 手元の一覧はこれより古ければ使わない(取り直しが失敗し続けたら従来どおりログインして数える)
export const SITE_LIST_MAX_AGE_MS = 80 * 60 * 1000;
// ログインが拒否された(auth_error)予約者は、この時間はその人の自動予約を止める(パスワード誤り等で繰り返すとアカウントロックの恐れ。
// カードも最初の 1 回だけ)。時間が過ぎたら次の候補で 1 回だけ試し直す
export const AUTH_PAUSE_MS = 6 * 60 * 60 * 1000;
// テニスベアの予定(隣接の判定用)を使い回す時間。同じ周期に候補が複数あっても Worker 経由のテニスベアへのログインを 1 回に抑える
export const TB_PLANS_TTL_MS = 10 * 60 * 1000;
// テニスベアの予定が取れなかったとき、これより新しい直近の結果があればそれで判定する(無ければ見送る)
export const TB_PLANS_STALE_MAX_MS = 60 * 60 * 1000;

// 空き照会がこの回数連続で失敗したら間隔を広げ始める(単発の fetch failed・502 では発動しない。9/26 の失敗 10 回は全て単発だった)
export const BACKOFF_AFTER = 3;
// 広げた間隔(連続失敗 3 回目 → 3 分、4 回目 → 5 分、5 回目 → 10 分、6 回目以降 → 15 分)。成功で即リセット
export const BACKOFF_STEPS_MS = [3 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000, 15 * 60 * 1000];
// 直近の失敗が都サイトの「お知らせ」ページだったときの広げ方(3 回目以降ずっと 3 分。短い不調が大半なので長く空けない。2026-11-11)
export const NOTICE_BACKOFF_STEPS_MS = [3 * 60 * 1000];

// 連続失敗の回数に応じた照会間隔。閾値未満なら通常の間隔(normalMs)
export function backoffIntervalMs(consecutiveFailures, normalMs, { after = BACKOFF_AFTER, steps = BACKOFF_STEPS_MS } = {}) {
  if (consecutiveFailures < after) return normalMs;
  const step = steps[Math.min(consecutiveFailures - after, steps.length - 1)];
  return Math.max(step, normalMs);
}

// 次の照会までの待ち時間: 「前回の開始 + 間隔」を目標にし、既に過ぎていれば MIN_GAP_MS だけ空ける
export function nextDelayMs({ startedAt, finishedAt, intervalMs, minGapMs = MIN_GAP_MS }) {
  return Math.max(startedAt + intervalMs - finishedAt, minGapMs);
}

// その時刻(JST)に使う照会間隔。AUTO_BOOKING.POLL_SCHEDULE の時間帯(FROM <= 時刻 < TO)に当たればその間隔、当たらなければ baseIntervalMs。
// DAY(JST の日。1〜31)がある行はその日だけ当たる。上から順に見て最初に当たった行を使うので、日付つきの行は先に書く(2026-11-21)
export function pollIntervalAt(nowMs, baseIntervalMs, schedule = AUTO_BOOKING.POLL_SCHEDULE) {
  if (!schedule || schedule.length === 0) return baseIntervalMs;
  const hhmm = jstHHMM(nowMs);
  const day = new Date(nowMs + 9 * 3600 * 1000).getUTCDate();
  for (const w of schedule) {
    if (w.DAY != null && w.DAY !== day) continue;
    const hit = w.FROM < w.TO ? hhmm >= w.FROM && hhmm < w.TO : hhmm >= w.FROM || hhmm < w.TO;
    if (hit) return Math.max(w.POLL_INTERVAL_MS, AUTO_BOOKING.MIN_POLL_INTERVAL_MS);
  }
  return baseIntervalMs;
}

// 結果カードを送らない結果: 見送りと、人が何もできない失敗(先に取られた・サイトが断った・サイトのエラー)。LINE の月 200 通の枠を節約する。
// 送るのは 成功、ログインできない(auth_error)、reCAPTCHA で拒否(rejected)、人に渡したが完了しなかった(abandoned)
const SILENT_STATUSES = new Set(['capped', 'conflict', 'skipped', 'dry_run', 'taken', 'duplicate', 'error']);

export function createAutoRunner({
  mode = 'dry-run',
  scrape, // async () => Slot[]
  queue, // booking-queue.js
  state, // auto-state.js
  worker, // { heartbeat(payload) → Promise<{ dates, slots, allowSlots? }>, addExcludedSlots(slots) → Promise, dropAllowedSlots?([{ date }]) → Promise,
  //         tennisbear?(person) → Promise<{ configured, events }>,
  //         plans?() → Promise<{ plans:[{ person, source, date, start, end, park }], failed:[…] }>(A・B の都の予約一覧を手元に持つのに使う。2026-11-19),
  //         calendarSync?(person) → void(フェーズ11。予約成立の直後に Worker へ同期を頼む。結果は待たない) }
  book, // async (candidate, { credentials, beforeApply }) → reserve() の結果
  credentialsFor, // (person) → { userId, password, label } | null
  notify = async () => {}, // (flexMessage, what) → LINE に push(server の lineQueue.send)
  notifyVacancy = async () => {}, // (slots) → 従来の空き通知カード(予約ボタン付き)を LINE に push(予約直前に対象外になった枠用)
  signingSecret = '',
  log = () => {},
  now = Date.now,
  pollMs = AUTO_BOOKING.POLL_INTERVAL_MS,
  forgetFile = null,
  // 手元の予約一覧(下の siteList)が使えるとき、予約の前にサイトで予約一覧を見るのを省く(昼間で 1 通信 4.5 秒。2026-11-19 本人決定)。
  // 代わりに成立の後で一覧を見て、同じ日に 2 件入っていたらカードで知らせる。false で従来どおり予約の前に見る(server は AUTO_SKIP_LIST=0)
  skipListCheck = true,
  eventLog = null, // auto-events.js の { append(obj) }。枠の出現・消滅・試行の記録(照会間隔の調整用)。無ければ記録しない
}) {
  const interval = Math.max(Number(pollMs) || AUTO_BOOKING.POLL_INTERVAL_MS, AUTO_BOOKING.MIN_POLL_INTERVAL_MS);
  const active = mode === 'on';
  let timer = null;
  let running = false;
  let exclusions = null; // { dates, slots, allowSlots, at }(allowSlots = 「せってい」の追加枠。2026-10-25。10-15〜10-25 は日単位の allowDates)
  // 「追加枠」に新しく入った枠キー。次の照会で既知から外し、その時点で空いていれば「新しく出た空き」として予約しに行く
  // (追加した時点で既に空いている枠は、差分では「新しい」にならず取りに行かないため。2026-10-25)
  const freshAllowKeys = new Set();
  let remoteEnabled = true; // LINE の「じどうおふ」で false(Worker の応答で更新)
  let remoteNotify = true; // LINE の「つうちおふ」で false(予約直前に対象外になった枠の空き通知カードを送らない)
  const effectiveMode = () => (mode === 'on' && !remoteEnabled ? 'paused' : mode);
  const bookingEnabled = () => mode === 'on' && remoteEnabled;
  let lastCycle = { at: null, ms: null, error: null, newSlots: 0 };
  let consecutiveFailures = 0; // 空き照会の連続失敗回数(成功で 0 に戻る。間隔を広げる判断に使う)
  let lastFailureWasNotice = false; // 直近の失敗が都サイトの「お知らせ」ページだったか(広げる上限を 3 分にする)
  const backoffOpts = () => (lastFailureWasNotice ? { steps: NOTICE_BACKOFF_STEPS_MS } : {});
  let lastTargets = []; // 直近の照会で見えていた監視対象の枠(/auto/status で確認できる)
  let lastAllSlots = []; // 直近の照会の全枠(一部の公園×週が取れなかったとき、その分を補うのに使う)
  const parkFreshAt = new Map(); // 公園名 → その公園の全週をきちんと取れた最後の照会の時刻
  // 利用日ごとの残り枚数(予約一覧を見た結果から)。DAY_REMAINING_TTL_MS を過ぎたら忘れて、次はまた一覧を見て数える
  // (本人が LINE やサイトで取り消した後に「まだ 1 件ある」と思い込み続けないため)
  const dayRemaining = new Map(); // date → { remaining, at }
  const authFailedAt = new Map();
  const requeued = new Map(); // 枠ごとの「行列の後ろへ戻した」回数(ERROR_REQUEUE_MAX まで。再起動で消えてよい) // person → ログインが拒否された時刻
  const tbPlans = new Map(); // person → { configured, events, at }(テニスベアの予定。隣接の判定用)
  const remainingFor = (date) => {
    const r = dayRemaining.get(date);
    if (!r) return null;
    if (now() - r.at > DAY_REMAINING_TTL_MS) {
      dayRemaining.delete(date);
      return null;
    }
    return r.remaining;
  };
  // 手元に持っている A・B の都の予約一覧(SITE_LIST_REFRESH_MS ごとに取り直す)。
  // { at(取りに行った時刻), byPerson: { A: [{ date, start, park, addedAt? }], B: [...] } }。addedAt は自動予約の成立で足した分
  let siteList = null;
  let siteListInflight = null;
  let siteListNextAt = 0; // 次に取り直す時刻
  const usableSiteList = () => (siteList && now() - siteList.at <= SITE_LIST_MAX_AGE_MS ? siteList : null);
  // その人のその日の予約の件数(手元の一覧から)。一覧が無い・古ければ null
  const listedCount = (person, date) => {
    const l = usableSiteList();
    return l ? (l.byPerson[person] || []).filter((r) => r.date === date).length : null;
  };
  // LINE での取消(Worker が除外枠に reason: 'cancel' で載せる)と、手放しの検出('released')を手元の一覧に反映する(2026-11-19)。
  // 除外枠は「その 公園・日・開始時刻 の予約が at の時点で無くなった」印なので、それより前から手元にある同じ枠の予約を外す。
  // (取り直しが取消の前に始まっていて、取消の後に「まだある」一覧を返すことがある → 一覧の時刻 < 取消の時刻 なので外れる。
  //  取消の後に同じ枠を取り直した予約は、手元に入った時刻の方が新しいので残る)
  // 「その日は上限」の記憶(ログイン直後の一覧から。60 分)も、その日の分は忘れる(取消した日の別の枠をすぐ取りに行けるように)
  function applyCancels() {
    if (!siteList || !exclusions) return;
    for (const x of exclusions.slots || []) {
      if (!x?.date || !x.start || x.at == null) continue;
      for (const [person, list] of Object.entries(siteList.byPerson)) {
        const keep = list.filter((r) => !(r.date === x.date && r.start === x.start && String(r.park ?? '') === String(x.park ?? '') && x.at > (r.addedAt ?? siteList.at)));
        if (keep.length === list.length) continue;
        siteList.byPerson[person] = keep;
        const mem = dayRemaining.get(x.date);
        if (mem && mem.at < x.at) dayRemaining.delete(x.date);
        log(`手元の予約一覧から外しました(取消または手放し): ${person} ${x.date} ${x.start} ${x.facility || x.park}`);
      }
    }
  }
  // 取り直しのたびに、それまで手元に持っていた一覧(before)と、いまサイトから取った一覧を比べる(2026-11-19)。
  // LINE 経由の予約・取消をその場で反映できていれば一致するはず。食い違いは「サイトで直接操作した」か「反映もれ」で、
  // ログと記録(site_list_diff)に残す。予約直前の一覧の確認を省いてよいかの判断材料(食い違いが出ないことを数日見る)。
  // 比べないもの: 取り直しを始めた後に手元へ足した予約(サイトの一覧が成立前のことがある)・昨日までの予約(日付が変われば一覧から消える)
  const siteListCheck = { checks: 0, mismatches: 0, lastMismatchAt: null, lastMismatch: null };
  function compareSiteList(before, startedAt) {
    if (!before || !siteList) return;
    const today = jstTodayIso(now());
    const keyOf = (person, r) => `${person} ${r.date} ${r.start} ${parkOf(r.park)?.name || r.park || '別の場所'}`;
    const keysOf = (l, skip) => {
      const out = new Set();
      for (const [person, list] of Object.entries(l.byPerson)) for (const r of list) if (r.date >= today && !skip(r)) out.add(keyOf(person, r));
      return out;
    };
    const addedLater = (r) => r.addedAt != null && r.addedAt >= startedAt;
    const had = keysOf(before, addedLater);
    const has = keysOf(siteList, addedLater);
    const onlySite = [...has].filter((k) => !had.has(k)); // サイトにあって手元に無かった(サイトで直接取った・予約の反映もれ)
    const onlyLocal = [...had].filter((k) => !has.has(k)); // 手元にだけあった(サイトで直接取り消した・取消の反映もれ)
    siteListCheck.checks++;
    if (!onlySite.length && !onlyLocal.length) return;
    siteListCheck.mismatches++;
    siteListCheck.lastMismatchAt = now();
    siteListCheck.lastMismatch = { onlySite, onlyLocal };
    log(`手元の予約一覧がサイトと食い違っていました(サイトの内容に合わせました)${onlySite.length ? `。手元に無かった予約: ${onlySite.join(' / ')}` : ''}${onlyLocal.length ? `。手元にだけあった予約: ${onlyLocal.join(' / ')}` : ''}`);
    event('site_list_diff', { onlySite, onlyLocal });
  }
  // LINE のボタンでの手動予約が成立したとき、server.mjs が呼ぶ(2026-11-19)。次の取り直しを待たずに手元の一覧へ足す
  function noteBooked(person, { date, start, park }) {
    if (!siteList || !person || !date || !start) return false;
    const list = (siteList.byPerson[person] ||= []);
    if (list.some((r) => r.date === date && r.start === start && String(r.park ?? '') === String(park ?? ''))) return false;
    list.push({ date, start, end: startHHMM(Number(start.slice(0, 2)) + 2), park: park ?? null, facility: parkOf(park)?.name || '', addedAt: now() });
    log(`手元の予約一覧に足しました(手動予約の成立): ${person} ${date} ${start} ${parkOf(park)?.name || park}`);
    return true;
  }
  // 取り直し。照会ループが待たずに呼ぶ(失敗しても予約は従来どおり動く)。戻り値は取れたかどうか
  function refreshSiteList() {
    if (typeof worker.plans !== 'function') return Promise.resolve(false);
    if (siteListInflight) return siteListInflight;
    const startedAt = now();
    siteListNextAt = startedAt + SITE_LIST_REFRESH_MS;
    siteListInflight = (async () => {
      try {
        const res = await worker.plans();
        if (!res || !Array.isArray(res.plans)) throw new Error('Worker から予定が返らなかった');
        // 都の予約が 1 人分でも取れていなければ使わない(取れなかった人を「0 件」と読むと毎回ログインするだけだが、誰の分かが応答から分からない)
        const failed = (Array.isArray(res.failed) ? res.failed : []).filter((f) => /都の予約|配線/.test(String(f)));
        if (failed.length) throw new Error(`取れなかった分: ${failed.join('、')}`);
        const byPerson = {};
        for (const p of res.plans) {
          if (p?.source !== 'site' || !p.person || !p.date) continue;
          (byPerson[p.person] ||= []).push({ date: p.date, start: p.start || '', end: p.end || '', park: p.park ?? null, facility: p.facility || '' });
        }
        // 取りに行っている間に成立した自動予約は、Worker の一覧に入っていないことがあるので残す
        for (const [person, list] of Object.entries(siteList?.byPerson || {})) {
          for (const r of list) {
            if (r.addedAt == null || r.addedAt < startedAt) continue;
            if (!(byPerson[person] || []).some((x) => x.date === r.date && x.start === r.start)) (byPerson[person] ||= []).push(r);
          }
        }
        const before = usableSiteList();
        siteList = { at: startedAt, byPerson };
        applyCancels(); // 取りに行っている間に LINE で取り消された分
        compareSiteList(before, startedAt);
        log(`手元の予約一覧を更新: ${Object.keys(byPerson).sort().map((k) => `${k} ${byPerson[k].length} 件`).join('・') || '予約なし'}(次は ${Math.round(SITE_LIST_REFRESH_MS / 60000)} 分後。既に予約のある日はログインせずに見送る)`);
        return true;
      } catch (e) {
        siteListNextAt = startedAt + SITE_LIST_RETRY_MS;
        const l = usableSiteList();
        log(`手元の予約一覧を更新できませんでした(${e.message})。${l ? `${Math.round((now() - l.at) / 60000)} 分前の一覧で続け` : '一覧が無い間は従来どおりログインして数え'}、${Math.round(SITE_LIST_RETRY_MS / 60000)} 分後にもう一度取ります`);
        return false;
      } finally {
        siteListInflight = null;
      }
    })();
    return siteListInflight;
  }

  const describe = (s) => `${s.date} ${s.time || `${startHHMM(s.startHour)}-`} ${s.facility || parkOf(s.park)?.name || s.park}`;
  const event = (type, data) => {
    if (!eventLog) return;
    try {
      eventLog.append({ at: now(), type, ...data });
    } catch {
      /* 記録の失敗で予約を止めない */
    }
  };
  // 試行状態の更新と記録(running は記録しない)
  const attempt = (c, status, message, extra = {}) => {
    state.markAttempt(c.key, status);
    if (status !== 'running') event('result', { key: c.key, status, person: c.person, message: message || undefined, ...extra });
  };
  // 予約実行の結果から記録に残す診断(所要・経路 fast/ui・先起こし warm・先取りで省略したもの・やり直しの理由)
  const resultExtra = (result) => ({ ...(result.elapsedMs != null ? { elapsedMs: result.elapsedMs } : {}), ...(result.diag ? { diag: result.diag } : {}) });

  async function heartbeat(extra = {}) {
    const payload = { active: bookingEnabled(), mode: effectiveMode(), at: now(), queued: queue.waiting().length, running: queue.isBusy(), lastCycle, ...extra };
    try {
      const res = await worker.heartbeat(payload);
      if (res && typeof res.enabled === 'boolean' && res.enabled !== remoteEnabled) {
        remoteEnabled = res.enabled;
        log(remoteEnabled ? 'LINE の「じどうおん」で自動予約を再開します' : 'LINE の「じどうおふ」で自動予約を停止します(照会は続け、予約はしない)');
      }
      if (res && typeof res.notifyEnabled === 'boolean' && res.notifyEnabled !== remoteNotify) {
        remoteNotify = res.notifyEnabled;
        log(remoteNotify ? 'LINE の「つうちおん」で空き通知カードを再開します' : 'LINE の「つうちおふ」で空き通知カードを止めます(結果カードは送る)');
      }
      if (res && Array.isArray(res.dates) && Array.isArray(res.slots)) {
        const allowSlots = Array.isArray(res.allowSlots) ? res.allowSlots : [];
        const changed = !exclusions || JSON.stringify([res.dates, res.slots.map(slotKey), allowSlots.map(slotKey)]) !== JSON.stringify([exclusions.dates, exclusions.slots.map(slotKey), exclusions.allowSlots.map(slotKey)]);
        const before = new Set((exclusions?.allowSlots || []).map(slotKey));
        for (const k of allowSlots.map(slotKey)) if (!before.has(k)) freshAllowKeys.add(k);
        exclusions = { dates: res.dates, slots: res.slots, allowSlots, at: now() };
        if (changed) log(`除外一覧を更新: 除外日 ${res.dates.length} 件、除外枠 ${res.slots.length} 件、追加枠 ${allowSlots.length} 件`);
        applyCancels(); // LINE での取消は除外枠として届く。手元の予約一覧からも外す
      }
      return true;
    } catch (e) {
      log(`Worker への合図に失敗(${e.message})${exclusions ? `。直近の除外一覧(${Math.round((now() - exclusions.at) / 60000)} 分前)で続けます` : '。除外一覧が無いため予約はしません'}`);
      return false;
    }
  }

  // 一部の 公園×週 だけ取れなかった照会(result.failures)は、その分を前回の結果で補う(2026-11-08)。
  // 補える前回の結果が PARTIAL_CARRY_MAX_MS より古ければ、従来どおり照会の失敗として throw する(呼び出し側の catch へ)
  function fillPartial(result, today, started) {
    const failures = Array.isArray(result.failures) ? result.failures : [];
    const failedParks = new Set(failures.map((f) => f.park.name));
    for (const p of PARKS) if (!failedParks.has(p.name)) parkFreshAt.set(p.name, started);
    if (!failures.length) {
      lastAllSlots = result;
      return result;
    }
    const stale = failures.find((f) => {
      const at = parkFreshAt.get(f.park.name);
      return at == null || started - at > PARTIAL_CARRY_MAX_MS;
    });
    if (stale) {
      const at = parkFreshAt.get(stale.park.name);
      throw carryNotice(stale.error, new Error(`${stale.error.message}(${at == null ? 'まだ一度も取れていない' : `最後に取れたのが ${Math.round((started - at) / 60000)} 分前`}ため前回の結果では補えない)`));
    }
    const weekOf = (date) => Math.floor(daysBetween(today, date) / 7);
    const filled = [...result];
    // week が null(一覧 JSON の方式: 公園ごと 1 本)ならその公園の全部、数なら 公園×週 の分だけ補う
    for (const f of failures) filled.push(...lastAllSlots.filter((s) => s.facility === f.park.name && (f.week == null || weekOf(s.date) === f.week)));
    filled.failures = failures;
    log(`空き照会の一部が取れず、前回の結果で補いました: ${failures.map((f) => `${f.park.name}${f.week == null ? '' : ` ${f.week + 1} 週目`}(${f.error.message})`).join(' / ')}`);
    event('poll_partial', { failures: failures.map((f) => ({ park: f.park.name, week: f.week, message: f.error.message })) });
    lastAllSlots = filled;
    return filled;
  }
  const carryNotice = (from, to) => {
    if (from && from.siteNotice) to.siteNotice = true;
    return to;
  };

  function usableExclusions() {
    if (!exclusions) return null;
    if (now() - exclusions.at > EXCLUSIONS_MAX_AGE_MS) return null;
    return exclusions;
  }

  // 1 周期分。戻り値はテスト用の要約
  async function tick() {
    if (running) return { skipped: 'busy' };
    running = true;
    const started = now();
    // Worker への合図(除外一覧・スイッチの受け取り)は照会と同時に投げる(2026-11-21。以前は照会の後に順番に待ち、
    // 新しい空きを行列へ入れるのが合図 1 往復分(0.5 秒前後)遅れていた)。Worker は合図の中身を使わない(生存は Pi の /auto/status を直接見る)ので、
    // 中身の lastCycle が 1 周期前でも困らない。heartbeat() は失敗しても throw しない
    const hb = heartbeat();
    try {
      const today = jstTodayIso(started);
      let slots;
      try {
        slots = fillPartial(await scrape(), today, started);
      } catch (e) {
        consecutiveFailures++;
        lastFailureWasNotice = !!e.siteNotice;
        const backoff = backoffIntervalMs(consecutiveFailures, 0, backoffOpts());
        log(`空き照会に失敗(今回はスキップ。連続 ${consecutiveFailures} 回): ${e.message}${backoff ? `。次の照会まで ${Math.round(backoff / 60000)} 分空けます${e.siteNotice ? '(都サイトの「お知らせ」が続いているため。短い不調が多いので 3 分より長くは空けない)' : '(メンテナンスか長い障害の可能性)'}` : ''}`);
        lastCycle = { at: started, ms: now() - started, error: e.message, newSlots: 0 };
        event('poll_failed', { consecutive: consecutiveFailures, message: e.message, ...(e.siteNotice ? { siteNotice: true } : {}) });
        await hb;
        return { skipped: 'scrape_failed', consecutiveFailures };
      }
      if (consecutiveFailures >= BACKOFF_AFTER) log(`空き照会が回復しました(連続失敗 ${consecutiveFailures} 回のあと)。通常の間隔に戻します`);
      consecutiveFailures = 0;
      lastFailureWasNotice = false;
      await hb; // 照会の間に届いているのが普通。ここから下は受け取った除外一覧・追加枠・スイッチで判定する
      // 監視対象(平日は猿江 19:00 だけ・土日祝は全部。lib/filter.js)に加えて、「せってい」の追加枠はいつでも見る
      // (平日の 17:00 や大島・亀戸は監視対象ではないため、これが無いと追加しても見てもらえない。2026-10-25)
      const allowKeys = new Set((exclusions?.allowSlots || []).map(slotKey));
      const targets = slots.filter((s) => isTargetSlot(s) || allowKeys.has(slotKey(s)));
      lastTargets = targets;
      const keys = targets.map(slotKey);
      const known = state.knownKeys();
      // 「追加枠」に入ったばかりの枠を既知から外す → いま空いていれば下で「新しく出た空き」になる。
      // 初回起動(既知の登録だけで予約しない回)では消さず、次の照会に持ち越す
      if (!state.needsBaseline()) {
        for (const k of freshAllowKeys) {
          if (known.delete(k)) log(`追加枠がいま空いているので、新しい空きとして扱います: ${k}`);
        }
        freshAllowKeys.clear();
      }
      // 実枠テスト用: 指定された枠を既知から外して「新しく出た」扱いにする
      for (const k of readForgetKeys()) {
        if (known.delete(k)) log(`テスト用に既知から外しました(次の判定で新しい空きとして扱う): ${k}`);
        else log(`テスト用の指定 ${k} は既知の一覧にありません(いま空いていないか、キーの書き方が違う)`);
      }
      const newSlots = state.needsBaseline() ? [] : targets.filter((s) => !known.has(slotKey(s)));
      const baseline = state.needsBaseline();
      // error で終わってから ERROR_RETRY_AFTER_MS 経っても空いたまま見えている枠は、もう一度候補にする(ERROR_RETRY_MAX 回まで)
      const retrySlots = baseline
        ? []
        : targets.filter((s) => {
            const k = slotKey(s);
            if (known.has(k) && !newSlots.includes(s)) {
              const a = state.attemptInfo(k);
              return a && a.status === 'error' && (a.errors || 0) <= ERROR_RETRY_MAX && started - a.at >= ERROR_RETRY_AFTER_MS;
            }
            return false;
          });
      // 記録: 消えた枠(前回まで見えていて今回無い)と、新しく出た枠
      if (!baseline) {
        const nowKeys = new Set(keys);
        for (const k of known) {
          if (nowKeys.has(k)) continue;
          const info = state.seenInfo(k);
          const minutes = info ? Math.round((started - info.at) / 60000) : null;
          event('gone', { key: k, facility: info?.facility, date: info?.date, time: info?.time, firstSeenAt: info?.at ?? null, sinceBaseline: info?.baseline ?? null, attempt: state.attemptStatus(k) });
          if (info) log(`枠が消えた: ${info.date} ${info.time} ${info.facility}(見えてから ${minutes} 分${info.baseline ? '以上' : ''}${state.attemptStatus(k) ? `、この枠の試行: ${state.attemptStatus(k)}` : '、試行なし'})`);
        }
        const intervalMs = pollIntervalAt(started, interval);
        for (const s of newSlots) event('appeared', { key: slotKey(s), facility: s.facility, date: s.date, time: s.time, intervalMs });
      }
      state.setKnown(keys);
      state.setSeen(targets.map((s) => ({ key: slotKey(s), at: started, facility: s.facility, date: s.date, time: s.time, baseline })));
      state.prune(today);
      lastCycle = { at: started, ms: now() - started, error: null, newSlots: newSlots.length };
      state.save();
      // 手元の予約一覧の取り直し(待たない)。予約の実行中は、同じ人のログインが重ならないよう次の照会に回す
      if (bookingEnabled() && now() >= siteListNextAt && !queue.isBusy()) refreshSiteList();
      // 動いていることが分かるよう毎回 1 行(1 日 1,440 行程度。docker のログ上限 10MB×3 に収まる)
      log(`照会: 監視対象 ${targets.length} 件(全体 ${slots.length} 件)、新規 ${newSlots.length} 件${retrySlots.length ? `、再挑戦 ${retrySlots.length} 件` : ''}、所要 ${Math.round(lastCycle.ms / 1000)} 秒`);

      if (baseline) {
        log(`初回起動: いま見えている監視対象 ${targets.length} 件を既知として登録しました(この分は予約しません)`);
        return { baseline: true, known: targets.length };
      }
      if (newSlots.length === 0 && retrySlots.length === 0) return { newSlots: 0 };
      if (newSlots.length) log(`新しい空き ${newSlots.length} 件: ${newSlots.map(describe).join(' / ')}`);
      for (const s of retrySlots) {
        const a = state.attemptInfo(slotKey(s));
        log(`再挑戦: ${describe(s)} (${Math.round((started - a.at) / 60000)} 分前に一時エラーで失敗したがまだ空いている。${a.errors} 回目の失敗後、再挑戦は ${ERROR_RETRY_MAX} 回まで)`);
        event('retry', { key: slotKey(s), facility: s.facility, date: s.date, time: s.time, errors: a.errors, sinceErrorMs: started - a.at });
      }
      const candidates = [...newSlots, ...retrySlots];

      const ex = usableExclusions();
      if (!ex) {
        for (const s of candidates) {
          log(`  見送り: ${describe(s)} (Worker から除外一覧が取れていないため)`);
          event('skipped', { key: slotKey(s), kind: 'no_exclusions', reason: 'Worker から除外一覧が取れていない' });
        }
        return { newSlots: newSlots.length, planned: 0, reason: 'no_exclusions' };
      }
      const { byDate, skipped } = planAutoBooking(candidates, { now: started, exclusions: ex });
      for (const s of skipped) {
        log(`  見送り: ${describe(s.slot)} (${s.reason}${s.kind === 'penalty' || s.kind === 'deadline' ? '。通知は Actions が行う' : s.kind === 'excluded_date' || s.kind === 'excluded_slot' ? '。通知もしない' : ''})`);
        event('skipped', { key: slotKey(s.slot), kind: s.kind, reason: s.reason });
      }

      let planned = 0;
      for (const [date, cands] of byDate) {
        const person = cands[0].person;
        const creds = credentialsFor(person);
        if (!creds) {
          for (const c of cands) {
            log(`  見送り: ${describe(c)} (予約者 ${person} の利用者情報が未設定)`);
            event('skipped', { key: c.key, kind: 'no_credentials', reason: `予約者 ${person} の利用者情報が未設定` });
          }
          continue;
        }
        const failedAt = authFailedAt.get(person);
        if (failedAt != null && now() - failedAt < AUTH_PAUSE_MS) {
          const left = Math.ceil((AUTH_PAUSE_MS - (now() - failedAt)) / 60000);
          for (const c of cands) {
            log(`  見送り: ${describe(c)} (予約者 ${person} はログインが拒否されたため ${left} 分間は自動予約を止めている。利用者番号・パスワード・カード有効期限を確認)`);
            event('skipped', { key: c.key, kind: 'auth_paused', reason: `予約者 ${person} のログイン拒否で停止中` });
          }
          continue;
        }
        for (const c of cands) {
          const st = state.attemptStatus(c.key);
          if (NO_RETRY_STATUSES.has(st)) {
            log(`  見送り: ${describe(c)} (この枠は ${st === 'success' ? '既に自動予約済み' : '実行中または待ち行列にある'})`);
            continue;
          }
          if (!bookingEnabled()) {
            log(`  [${mode === 'on' ? 'LINE で停止中' : 'dry-run'}] 予約するはず: ${describe(c)} 予約者=${creds.label}(${person})`);
            state.markAttempt(c.key, 'dry_run');
            event('dry_run', { key: c.key, person });
            continue;
          }
          const r = queue.submit({ id: c.key, kind: 'auto', meta: c, run: () => runCandidate(c, creds) });
          if (r.status === 'duplicate') {
            log(`  見送り: ${describe(c)} (行列に既にある)`);
            continue;
          }
          state.markAttempt(c.key, 'queued');
          event('queued', { key: c.key, person });
          planned++;
          log(`  行列へ: ${describe(c)} 予約者=${creds.label}(${person}) [${r.status}]`);
        }
      }
      state.save();
      return { newSlots: newSlots.length, planned };
    } catch (e) {
      log(`照会ループでエラー(次の周期で続けます): ${e.stack || e.message}`);
      return { error: e.message };
    } finally {
      running = false;
    }
  }

  // 行列の中で実行される 1 候補分
  async function runCandidate(c, creds) {
    const key = c.key;
    // 行列で待っている間に「じどうおふ」が来ていたら予約しない(カードも送らない。Actions が従来どおり通知する)
    if (!bookingEnabled()) {
      log(`見送り(実行直前): ${describe(c)} (LINE で自動予約が停止中)`);
      attempt(c, 'dry_run', 'LINE で自動予約が停止中');
      state.save();
      return { status: 'skipped', message: 'LINE で自動予約が停止中' };
    }
    // 予約の直前に「いま」で対象かどうかをもう一度判定する(見つけた時の判定を使い回さない。日付が変わる・23:35 を過ぎる)
    const t = now();
    const today = jstTodayIso(t);
    const again = classifySlot(c, { now: t, exclusions: usableExclusions() || exclusions || { dates: [], slots: [] } });
    if (again.kind !== 'auto') {
      attempt(c, `skipped_${again.kind}`, again.reason);
      state.save();
      if (again.kind === 'excluded_slot' || again.kind === 'excluded_date') {
        log(`見送り(予約直前の再判定): ${describe(c)} (${again.reason}。通知もしない)`);
        return { status: 'skipped', message: again.reason };
      }
      if (!remoteNotify) {
        log(`見送り(予約直前の再判定): ${describe(c)} (${again.reason}。空き通知カードは「つうちおふ」で止めているため送らない)`);
        return { status: 'skipped', message: again.reason, notified: false };
      }
      log(`見送り(予約直前の再判定): ${describe(c)} (${again.reason}。従来の空き通知カードを送る)`);
      try {
        await notifyVacancy([{ facility: c.facility, date: c.date, time: c.time || `${startHHMM(c.startHour)}-${startHHMM(Number(c.startHour) + 2)}`, count: c.count ?? 1 }]);
      } catch (e) {
        log(`空き通知カードの送信に失敗: ${e.message}`);
      }
      return { status: 'skipped', message: again.reason, notified: true };
    }
    // 追加枠(「せってい」で場所と時間を本人が指定した枠。again.allowed)は、1 日の上限・テニスベアの予定・接する別の場所の予約の判定を
    // 掛けない(2026-11-03 本人指示)。時間が重なる都の予約だけは予約直前の一覧で見る(選ぶ時点で予約済みの時間は Worker が出さないので通常は当たらない)
    const allowed = !!again.allowed;
    if (allowed) log(`追加枠なので 1 日の上限・場所の判定は掛けません: ${describe(c)}`);
    const maxDay = maxPerDayFor(c.date); // 平日 1 件・土日祝 2 件(2026-11-21)
    const remaining = allowed ? null : remainingFor(c.date);
    if (remaining != null && remaining <= 0) {
      log(`見送り: ${describe(c)} (${c.date} は既に ${maxDay} 件あるため。ログインせず)`);
      attempt(c, 'capped', `${c.date} は既に ${maxDay} 件あるため`);
      state.save();
      return { status: 'capped' };
    }
    // 手元の予約一覧(1 時間ごとに取り直し)でその日が上限なら、ログインせずに見送る(2026-11-19)
    const listed = allowed ? null : listedCount(c.person, c.date);
    if (listed != null && listed >= maxDay) {
      log(`見送り: ${describe(c)} (${c.date} は既に ${listed} 件の予約があるため。手元の予約一覧(${Math.round((now() - siteList.at) / 60000)} 分前)で判定。ログインせず)`);
      attempt(c, 'capped', `${c.date} は既に ${listed} 件の予約があるため(手元の予約一覧)`);
      state.save();
      return { status: 'capped' };
    }
    // 隣接の判定(その 1): テニスベアの予定。ログインの前に見て、隣の時間帯に別の場所の予定があれば見送る(ログインせず)
    const tb = allowed ? { configured: false, events: [], at: t } : await tennisbearPlansFor(c.person);
    if (!tb) {
      log(`見送り: ${describe(c)} (テニスベアの予定が取れず、隣の時間帯に別の場所の予定が無いか判定できないため。ログインせず)`);
      attempt(c, 'skipped_tennisbear', 'テニスベアの予定が取れないため');
      state.save();
      return { status: 'skipped', message: 'テニスベアの予定が取れないため' };
    }
    const tbConflict = findPlaceConflict(c, tb.events);
    if (tbConflict) {
      log(`見送り: ${describe(c)} (${tbConflict.reason}。ログインせず)`);
      attempt(c, 'conflict', tbConflict.reason);
      state.save();
      return { status: 'conflict', message: tbConflict.reason };
    }
    // 手元の予約一覧が使えるなら、予約の前にサイトで一覧を見るのを省く(skipList)。重なり・隣の時間帯の別の公園の判定も手元の一覧で先に行う
    // (上限 1 件のうちは上の件数の判定が先に当たる。追加枠は時間が重なる予約だけ見る)。成立の後に一覧を見て答え合わせをする(下の reservationsAfter)
    const local = skipListCheck ? usableSiteList() : null;
    const skipList = !!local;
    if (skipList) {
      const mine = (local.byPerson[c.person] || []).filter((r) => r.date === c.date);
      const conflict = findPlaceConflict(c, mine, { overlapOnly: allowed });
      if (conflict) {
        log(`見送り: ${describe(c)} (${conflict.reason}。手元の予約一覧(${Math.round((now() - local.at) / 60000)} 分前)で判定。ログインせず)`);
        attempt(c, 'conflict', conflict.reason);
        state.save();
        return { status: 'conflict', message: conflict.reason };
      }
    }
    state.markAttempt(key, 'running');
    state.save();
    let listCount = null;
    const beforeApply = async ({ reservations }) => {
      const sameDay = reservations.filter((r) => r.date === c.date);
      listCount = sameDay.length;
      await detectReleased(c.person, reservations, today);
      if (!allowed && listCount >= maxDay) {
        return { status: 'capped', message: `${c.date} は既に ${listCount} 件の予約があるため見送りました(手動分を含む)` };
      }
      // 隣接の判定(その 2): 都の予約一覧。時間が重なる予約・隣の時間帯の別の公園の予約があれば見送る(上限が 1 件のうちは通常ここに来ないが、上限を戻したときのため)。
      // 追加枠は時間が重なる予約だけ見る
      const conflict = findPlaceConflict(c, sameDay, { overlapOnly: allowed });
      if (conflict) return { status: 'conflict', message: conflict.reason };
      return null;
    };
    log(`自動予約 開始: ${describe(c)} 予約者=${creds.label}(${c.person})${skipList ? ` [予約前の一覧は省く。手元の一覧 ${Math.round((now() - local.at) / 60000)} 分前]` : ''}`);
    // stillVacant: 直近の照会にこの枠がまだあるか(server.mjs が、やり直しの前に見る。消えていればやり直さず taken。2026-11-01)
    const stillVacant = () => lastTargets.some((s) => slotKey(s) === key);
    const bookOnce = async () => {
      try {
        return await book(c, { credentials: creds, beforeApply, stillVacant, skipList });
      } catch (e) {
        return { status: 'error', message: e.message };
      }
    };
    let result = await bookOnce();
    // 一時エラー(error)なら、直近の照会でまだ空いているうちに待たずにもう一度(ERROR_RETRY_NOW_MAX 回。2026-11-08)。
    // 5 分後の再挑戦(tick 側)は、これでも error だったときのために残す
    for (let n = 1; result.status === 'error' && n <= ERROR_RETRY_NOW_MAX; n++) {
      if (!stillVacant()) {
        log(`  一時エラーの直後だが、その後の空き照会で枠が消えているためその場ではやり直しません: ${result.message || ''}`.trimEnd());
        break;
      }
      log(`  一時エラーのためその場でもう一度予約します(${n}/${ERROR_RETRY_NOW_MAX} 回目): ${result.message || ''}`.trimEnd());
      event('retry_now', { key, n, firstError: result.message, firstMs: result.elapsedMs });
      const first = result;
      result = await bookOnce();
      result.diag = { ...(result.diag || {}), retryNow: n, firstError: first.message, firstMs: first.elapsedMs, firstDiag: first.diag };
    }
    const ok = result.status === 'success';
    if (skipList) result.diag = { ...(result.diag || {}), listSkipped: true };
    // 予約の前の一覧を省いた回の答え合わせ: 成立の後に取った一覧(サイトの本物)でその日の件数を数え直し、手元の一覧もその人の分を入れ替える。
    // 同じ日に上限を超えて入っていたら(手元の一覧が知らなかった予約があった)、成立カードとログで知らせる
    let doubled = null;
    if (ok && skipList && Array.isArray(result.reservationsAfter)) {
      const after = result.reservationsAfter;
      const sameDay = after.filter((r) => r.date === c.date);
      listCount = Math.max(sameDay.length - 1, 0); // 今回の 1 件を除いた、予約の前の件数に当たる数
      if (!allowed && sameDay.length > maxDay) {
        const others = sameDay.filter((r) => !(r.start === startHHMM(c.startHour) && parkOf(r.facility)?.code === c.park));
        doubled = others.length ? others : sameDay;
        log(`⚠ 二重予約: ${c.date} に ${sameDay.length} 件の予約があります(手元の予約一覧に無かった予約: ${doubled.map((r) => `${r.start} ${r.facility}`).join(' / ')})。どちらかを取り消してください`);
        event('double_booked', { key, person: c.person, date: c.date, others: doubled.map((r) => ({ start: r.start, facility: r.facility, id: r.id })) });
      }
      if (siteList) siteList.byPerson[c.person] = after.filter((r) => r.date && r.start).map((r) => ({ date: r.date, start: r.start, end: r.end || '', park: parkOf(r.facility)?.code ?? null, facility: r.facility || '', addedAt: now() }));
      await detectReleased(c.person, after, today);
    } else if (ok && skipList) {
      log('  予約後の一覧が取れなかったため、答え合わせは次の取り直し(1 時間ごと)に任せます');
    }
    if (listCount != null) dayRemaining.set(c.date, { remaining: maxDay - listCount - (ok ? 1 : 0), at: now() }); // 追加枠の成立で負になることがある(その日の普段の枠は capped)
    if (result.status === 'auth_error') {
      const first = !authFailedAt.has(c.person) || now() - authFailedAt.get(c.person) >= AUTH_PAUSE_MS;
      authFailedAt.set(c.person, now());
      log(`予約者 ${c.person} のログインが拒否されたため、${Math.round(AUTH_PAUSE_MS / 3600000)} 時間は ${c.person} の自動予約を止めます`);
      if (!first) {
        attempt(c, result.status, result.message, resultExtra(result));
        state.save();
        return result;
      }
    } else if (ok) {
      authFailedAt.delete(c.person);
    }
    attempt(c, result.status, result.message, resultExtra(result));
    log(`自動予約 結果: ${result.status} ${describe(c)} ${result.message || ''}`.trim());
    if (result.status === 'error') requeueAfterError(c, creds, stillVacant);

    if (ok) {
      const park = parkOf(c.park);
      const start = startHHMM(c.startHour);
      const end = startHHMM(Number(c.startHour) + 2);
      state.addOwn({ key, person: c.person, id: result.reservationNo || '', date: c.date, start, end, park: c.park, facility: park?.name || c.facility });
      // 手元の予約一覧にもその場で足す(次の取り直しを待たずに、同じ日の枠をログインせずに見送れる)。予約後の一覧で入れ替え済みなら重ねない
      if (siteList && !(siteList.byPerson[c.person] || []).some((r) => r.date === c.date && r.start === start && String(r.park ?? '') === String(c.park))) {
        (siteList.byPerson[c.person] ||= []).push({ date: c.date, start, end, park: c.park, facility: park?.name || '', addedAt: now() });
      }
      await dropAllowedSlotsAt(c.date);
      // フェーズ11: その人の Google カレンダーの同期を Worker に頼む(待たない。配線が無ければ何もしない)
      if (typeof worker.calendarSync === 'function') {
        try {
          worker.calendarSync(c.person);
        } catch (e) {
          log(`カレンダー同期の依頼に失敗(毎時の同期で載ります): ${e.message}`);
        }
      }
      let cancelData = null;
      if (isFreeCancelLastDay(c.date, today) && result.reservationNo && signingSecret) {
        try {
          cancelData = signCancelToken(signingSecret, {
            kind: 'c',
            person: c.person,
            id: result.reservationNo,
            date: c.date,
            start,
            end,
            facility: park?.name || c.facility,
            penaltyDay: AUTO_BOOKING.PENALTY_DAYS,
            exp: jstEndOfDaySec(today),
          });
        } catch (e) {
          log(`キャンセルボタンの署名に失敗(ボタン無しで送ります): ${e.message}`);
        }
      }
      // ペナルティ期間の枠(「せってい」の追加枠)の成功カードには、取消にペナルティが付く旨を添える(2026-10-15。10-25 に枠単位へ)
      const penalty = isPenaltyPeriod(c.date, today);
      const doubleBooked = doubled ? doubled.map((r) => `${r.start} ${r.facility}`).join('・') : null;
      await notify(buildResultFlex({ slot: bookingSlot(c), ...result }, creds.label, { auto: true, cancelData, penalty, doubleBooked }), '自動予約の成立カード');
    } else if (!SILENT_STATUSES.has(result.status)) {
      await notify(buildResultFlex({ slot: bookingSlot(c), ...result, facility: result.facility || parkOf(c.park)?.name || c.facility }, creds.label, { auto: true }), '自動予約の結果カード');
    } else if (result.status === 'taken' || result.status === 'duplicate' || result.status === 'error') {
      log(`結果カードは送りません(${result.status}。人が対応できる失敗ではないため。LINE の通数節約)`);
    }
    state.save();
    return result;
  }

  // error で終わった枠を行列の後ろへ戻す(ERROR_REQUEUE_MAX 回まで)。今の実行が終わる前に入れるので、待っている他の枠の後ろに付く
  function requeueAfterError(c, creds, stillVacant) {
    const key = c.key;
    const n = requeued.get(key) || 0;
    if (n >= ERROR_REQUEUE_MAX) return;
    if (queue.waiting().length === 0) return; // 待っている枠が無ければ従来どおり 5 分後の再挑戦に任せる
    if (!stillVacant()) {
      log(`  行列の後ろへは戻しません(その後の空き照会で枠が消えている): ${describe(c)}`);
      return;
    }
    if (!bookingEnabled()) return;
    const r = queue.submit({ id: key, kind: 'auto', meta: c, run: () => runCandidate(c, creds) }, { requeue: true });
    if (r.status === 'duplicate') return;
    requeued.set(key, n + 1);
    state.markAttempt(key, 'queued');
    state.save();
    event('requeued', { key, n: n + 1 });
    log(`  行列の後ろへ戻しました(一時エラーのため。${n + 1}/${ERROR_REQUEUE_MAX} 回目。待ち ${queue.waiting().length} 件): ${describe(c)}`);
  }

  // その人のテニスベアの予定(隣接の判定用)。Worker の /auto/tennisbear を呼び、TB_PLANS_TTL_MS の間は使い回す。
  // 取れなければ直近 TB_PLANS_STALE_MAX_MS 以内の結果で代用し、それも無ければ null(呼び出し側は見送る)。
  // 予約が取れた日の「追加枠」を、公園・時間帯を問わず全部消す(同じ日は 1 件取れたら残りは取らない。2026-11-03 本人指示。
  // 10-25〜11-03 は同じ日時だけだった)。手元の写しからも外し、Worker にも頼む(失敗しても次の heartbeat で写しは戻るだけ。Worker 側は残るので手で「解除」)
  async function dropAllowedSlotsAt(date) {
    const hit = (exclusions?.allowSlots || []).filter((a) => a.date === date);
    if (!hit.length) return;
    exclusions.allowSlots = exclusions.allowSlots.filter((a) => a.date !== date);
    log(`予約が取れたので同じ日の追加枠を全部消します: ${hit.map((a) => `${a.start} ${a.facility || a.park}`).join('・')} (${date})`);
    if (typeof worker.dropAllowedSlots !== 'function') return;
    try {
      await worker.dropAllowedSlots([{ date }]);
    } catch (e) {
      log(`追加枠の削除を Worker に頼めませんでした(「せってい」で手で解除してください): ${e.message}`);
    }
  }

  // worker.tennisbear が配線されていない(テスト等)ときは「予定なし」として都の予約だけで判定する
  async function tennisbearPlansFor(person) {
    if (typeof worker.tennisbear !== 'function') return { configured: false, events: [], at: now() };
    const cached = tbPlans.get(person);
    if (cached && now() - cached.at <= TB_PLANS_TTL_MS) return cached;
    try {
      const res = await worker.tennisbear(person);
      const entry = { configured: res?.configured !== false, events: Array.isArray(res?.events) ? res.events : [], at: now() };
      tbPlans.set(person, entry);
      log(entry.configured ? `テニスベアの予定を取得: 予約者 ${person} は今後 ${entry.events.length} 件(隣接の判定に使う)` : `予約者 ${person} のテニスベアは未設定のため、隣接の判定は都の予約だけで行う`);
      return entry;
    } catch (e) {
      if (cached && now() - cached.at <= TB_PLANS_STALE_MAX_MS) {
        log(`テニスベアの予定を取得できないため、${Math.round((now() - cached.at) / 60000)} 分前の結果で判定します(${e.message})`);
        return cached;
      }
      log(`テニスベアの予定を取得できません(${e.message})`);
      return null;
    }
  }

  // 自分が自動予約した枠が、その人の予約一覧から消えていたら「サイトで手放した」とみなして除外枠に登録する
  async function detectReleased(person, reservations, today) {
    const mine = state.own().filter((o) => o.person === person && o.date >= today);
    if (mine.length === 0) return;
    const inList = new Set(reservations.map(slotKey));
    const released = mine.filter((o) => !inList.has(o.key));
    if (released.length === 0) return;
    for (const o of released) log(`自動予約した枠が予約一覧に無いため除外枠に登録します: ${o.date} ${o.start} ${o.facility}`);
    try {
      await worker.addExcludedSlots(released.map((o) => ({ park: o.park, date: o.date, start: o.start, end: o.end, facility: o.facility, reason: 'released' })));
      for (const o of released) state.removeOwn(o.key);
      state.save();
    } catch (e) {
      log(`除外枠の登録に失敗(次回また試します): ${e.message}`);
    }
  }

  const bookingSlot = (c) => ({ park: c.park, date: c.date, startHour: Number(c.startHour), people: AUTO_BOOKING.PEOPLE });

  // forgetFile を読んで枠キーの配列を返し、ファイルは消す(無ければ空)
  function readForgetKeys() {
    if (!forgetFile) return [];
    try {
      const keys = fs.readFileSync(forgetFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      fs.rmSync(forgetFile, { force: true });
      return keys;
    } catch {
      return [];
    }
  }

  function start() {
    if (timer) return api;
    const sched = (AUTO_BOOKING.POLL_SCHEDULE || []).map((w) => `${w.DAY != null ? `毎月 ${w.DAY} 日の ` : ''}${w.FROM}〜${w.TO} は ${Math.round(w.POLL_INTERVAL_MS / 1000)} 秒`).join('、');
    log(`自動予約の照会ループを開始: mode=${mode} 間隔=${Math.round(interval / 1000)}秒${sched ? `(${sched})` : ''}`);
    const loop = async () => {
      const startedAt = now();
      await tick();
      const intervalMs = backoffIntervalMs(consecutiveFailures, pollIntervalAt(startedAt, interval), backoffOpts());
      timer = setTimeout(loop, nextDelayMs({ startedAt, finishedAt: now(), intervalMs }));
    };
    timer = setTimeout(loop, 3000);
    return api;
  }
  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  const api = {
    tick, start, stop, mode, active, intervalMs: interval,
    effectiveMode, remoteEnabled: () => remoteEnabled, remoteNotify: () => remoteNotify,
    exclusions: () => exclusions, lastCycle: () => lastCycle, lastTargets: () => lastTargets, dayRemaining, tbPlans,
    refreshSiteList, siteList: () => siteList, noteBooked, siteListCheck: () => ({ ...siteListCheck }),
    consecutiveFailures: () => consecutiveFailures,
    backoffMs: (normalMs) => backoffIntervalMs(consecutiveFailures, normalMs, backoffOpts()),
  };
  return api;
}

// 空き照会の関数を作る。MOCK_SLOTS_FILE があればファイルを読む(dry-run の確認用)。
// 実サイトは既定で「公園 × 週 = 16 本のセッションを持ち続け、毎回は週の JSON だけを全部同時に取る」
// (lib/scrape.js の createPersistentScraper。3 公園のとき 1 回の照会 約 50 秒 → 約 10 秒、通信 18 → 12 回。2026-10-25。4 公園は 24 → 16 回)。
// AUTO_SCRAPE_WEEKS=0 で従来の「公園ごとに新しいセッションで 4 週を順番に取る」に戻す(AUTO_SCRAPE_CONCURRENCY 公園を同時、既定 3)
export function createScraper({
  mockFile = process.env.MOCK_SLOTS_FILE,
  listApi = process.env.AUTO_SCRAPE_LIST !== '0',
  weekSessions = process.env.AUTO_SCRAPE_WEEKS !== '0',
  concurrency = Number(process.env.AUTO_SCRAPE_CONCURRENCY) || 3,
  log = console.log,
} = {}) {
  if (mockFile) {
    return async () => JSON.parse(fs.readFileSync(mockFile, 'utf8'));
  }
  const { scrapeAvailability, createPersistentScraper, createListScraper } = require('../../lib/scrape.js');
  if (listApi) {
    log('[auto] 空き照会の方式: 空いている枠だけ返る一覧 JSON を公園ごとに 1 本取る(AUTO_SCRAPE_LIST=0 で公園 × 週の方式)');
    return createListScraper({ log });
  }
  if (weekSessions) {
    log('[auto] 空き照会の方式: 公園 × 週のセッションを持ち続けて週だけ同時に取る(AUTO_SCRAPE_WEEKS=0 で従来の順番取り)');
    return createPersistentScraper({ log });
  }
  log(`[auto] 空き照会の方式: 公園ごとに新しいセッションで 4 週を順番に取る(${concurrency} 公園同時)`);
  return () => scrapeAvailability({ concurrency });
}
