// ============================================================
// フェーズ3 自動予約の判断ルール(Pi 側の照会ループと、Actions 側の通知の振り分けが共通で使う)
//
// 要件(docs/PROMPT_フェーズ3_自動予約.md §2)をコードにしたもの。設定値は lib/config.js の AUTO_BOOKING と PARKS。
//   - ペナルティ期間(利用日 <= 今日 + PENALTY_DAYS)の枠は自動予約しない → 従来どおり通知する
//   - 利用日 = 今日+4 日 の枠は LAST_DAY_DEADLINE(23:35)以降は自動予約しない → 従来どおり通知する
//     ※ 対象かどうかは「見つけた時」と「予約の直前」の両方で判定する(23:59 に見つけて 00:01 に予約すると +3 日になるため)。
//       予約の直前で対象外になった枠は Pi 自身が従来の通知カードを送る(booking/src/auto-runner.js)
//   - 除外日(A/B 共通、1 日単位)の枠は自動予約せず、通知もしない(2026-09-17 に「通知もしない」へ変更)
//   - 除外枠(LINE からキャンセルした枠・サイトで手放した枠)は自動予約せず、通知もしない
//   - 同じ利用日に候補が複数あるときは 公園の優先順 → 時間帯の優先順 に並べる
//   - 予約者は利用日の曜日で決める(平日=B、土日祝=A)
//
// 枠キー(除外枠・冪等判定・差分に使う): "<公園コード>|<YYYY-MM-DD>|<HH:MM 開始>"  例 "1160|2026-09-27|13:00"
//   公園名の表記揺れ(「No.1」「公園」の有無)に影響されないよう、名前ではなく公園コードで表す。
//   Worker 側(worker/src/auto.js)も同じ形式で組む。
//
// CommonJS(Node 標準 + japanese-holidays)。Pi の ESM からは import { ... } from '../../lib/auto-rules.js' で読める
// ============================================================
const { PARKS, AUTO_BOOKING } = require('./config');
const { isWeekendOrHoliday, startHour } = require('./filter');
const { daysBetween, jstTodayIso, jstDateTimeMs, jstHHMM } = require('./date');

// 施設名(サイト表記・「No.1」付き等)または公園コードから PARKS の要素を返す。見つからなければ null
function parkOf(facilityOrCode) {
  const s = String(facilityOrCode ?? '');
  return PARKS.find((p) => p.code === s) || PARKS.find((p) => s.includes(p.keyword)) || null;
}

// "09:00-11:00" / "9:00" / 9 → "09:00"
function startHHMM(timeOrHour) {
  const h = typeof timeOrHour === 'number' ? timeOrHour : startHour(timeOrHour);
  return h == null ? null : `${String(h).padStart(2, '0')}:00`;
}

// 枠キー。受け付ける形:
//   空き枠   { facility, date, time:'13:00-15:00' }          (lib/scrape.js の Slot)
//   予約     { facility, date, start:'13:00' }               (予約一覧の行)
//   予約指示 { park:'1160', date, startHour:13 }             (booking/src の slot)
function slotKey(s) {
  const park = parkOf(s.park ?? s.facility);
  const code = park ? park.code : String(s.park ?? s.facility ?? '?');
  const start = s.start ?? startHHMM(s.startHour ?? s.time);
  return `${code}|${s.date}|${start}`;
}

// 利用日がペナルティ期間(取り消すとペナルティが付く = 自動予約しない期間)か。today は JST の "YYYY-MM-DD"
function isPenaltyPeriod(dateIso, todayIso = jstTodayIso()) {
  return daysBetween(todayIso, dateIso) <= AUTO_BOOKING.PENALTY_DAYS;
}

// 利用日 = 今日 + PENALTY_DAYS + 1(自動予約の対象のうち、ペナルティなしで取り消せるのが今日 23:59 までの枠)か
function isFreeCancelLastDay(dateIso, todayIso = jstTodayIso()) {
  return daysBetween(todayIso, dateIso) === AUTO_BOOKING.PENALTY_DAYS + 1;
}

// 利用日 = 今日+4 日 の枠が締切(LAST_DAY_DEADLINE)を過ぎているか。now は unix ミリ秒
function isPastLastDayDeadline(dateIso, nowMs = Date.now()) {
  return isFreeCancelLastDay(dateIso, jstTodayIso(nowMs)) && jstHHMM(nowMs) >= AUTO_BOOKING.LAST_DAY_DEADLINE;
}

// 利用日の曜日で予約者を決める(平日=B、土日祝=A)
function personFor(dateIso) {
  return isWeekendOrHoliday(dateIso) ? AUTO_BOOKING.PERSON_BY_DAY.holiday : AUTO_BOOKING.PERSON_BY_DAY.weekday;
}

// 除外一覧を照合しやすい形に。exclusions = { dates: ['YYYY-MM-DD'], slots: [{ park|facility, date, start }] }(Worker の KV の形)
function normalizeExclusions(exclusions) {
  const dates = new Set((exclusions?.dates || []).map(String));
  const slots = new Set((exclusions?.slots || []).map(slotKey));
  return { dates, slots };
}

// 1 枠を振り分ける。now(unix ミリ秒)を渡すと、その時刻の JST で「今日」と締切を判定する(見つけた時・予約の直前の両方で呼ぶ)
// 戻り値 { kind, reason }
//   auto          自動予約の対象(Pi が予約する。Actions は通知しない)
//   penalty       ペナルティ期間 → 従来どおり通知(予約ボタン付き)
//   deadline      利用日 = 今日+4 日で LAST_DAY_DEADLINE 以降 → 従来どおり通知
//   excluded_date 除外日 → 自動予約せず、通知もしない
//   excluded_slot 除外枠(人が手放した枠)→ 自動予約せず、通知もしない
//   unknown_park  監視対象の公園に紐づかない(通常は filter で落ちている)→ 従来どおり通知
function classifySlot(slot, { now = Date.now(), today = jstTodayIso(now), exclusions } = {}) {
  const ex = exclusions && exclusions.dates instanceof Set ? exclusions : normalizeExclusions(exclusions);
  const park = parkOf(slot.park ?? slot.facility);
  if (!park) return { kind: 'unknown_park', reason: '監視対象の公園ではない' };
  if (ex.slots.has(slotKey(slot))) return { kind: 'excluded_slot', reason: '除外枠(LINE からキャンセル済み等)' };
  if (isPenaltyPeriod(slot.date, today)) {
    return { kind: 'penalty', reason: `利用日が今日+${AUTO_BOOKING.PENALTY_DAYS}日以内(ペナルティ期間)` };
  }
  if (isFreeCancelLastDay(slot.date, today) && jstHHMM(now) >= AUTO_BOOKING.LAST_DAY_DEADLINE) {
    return { kind: 'deadline', reason: `利用日が今日+${AUTO_BOOKING.PENALTY_DAYS + 1}日で ${AUTO_BOOKING.LAST_DAY_DEADLINE} を過ぎている(取消の猶予なし)` };
  }
  if (ex.dates.has(slot.date)) return { kind: 'excluded_date', reason: '除外日' };
  return { kind: 'auto', reason: '自動予約の対象' };
}

// 公園の優先順 → 時間帯の優先順(→ 念のため日付)で並べる。同じ利用日の候補を並べるのに使う
function compareCandidates(a, b) {
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  const pa = parkOf(a.park ?? a.facility)?.priority ?? 99;
  const pb = parkOf(b.park ?? b.facility)?.priority ?? 99;
  if (pa !== pb) return pa - pb;
  const rank = (s) => {
    const i = AUTO_BOOKING.HOUR_PRIORITY.indexOf(startHour(s.time ?? startHHMM(s.startHour)));
    return i < 0 ? 99 : i;
  };
  return rank(a) - rank(b);
}
function sortCandidates(slots) {
  return [...slots].sort(compareCandidates);
}

// 新しく出た空きを、自動予約の候補(利用日ごと・優先順)と見送り(理由付き)に分ける。
// 戻り値 { byDate: Map<date, [{ ...slot, key, park(code), startHour, person }]>, skipped: [{ slot, kind, reason }] }
function planAutoBooking(newSlots, { now = Date.now(), today = jstTodayIso(now), exclusions } = {}) {
  const ex = normalizeExclusions(exclusions);
  const byDate = new Map();
  const skipped = [];
  for (const slot of sortCandidates(newSlots)) {
    const c = classifySlot(slot, { now, today, exclusions: ex });
    if (c.kind !== 'auto') {
      skipped.push({ slot, ...c });
      continue;
    }
    const park = parkOf(slot.park ?? slot.facility);
    const cand = {
      ...slot,
      key: slotKey(slot),
      park: park.code,
      facility: slot.facility || park.name,
      startHour: slot.startHour ?? startHour(slot.time),
      person: personFor(slot.date),
    };
    if (!byDate.has(slot.date)) byDate.set(slot.date, []);
    byDate.get(slot.date).push(cand);
  }
  return { byDate, skipped };
}

// Actions 側: 新しい空きのうち LINE に通知するものを選ぶ。
//   autoState = Worker の /auto/state の応答 { alive, active, dates, slots } 。取れなかったときは null(= Pi は死んでいる扱い。安全側)
//   Pi の自動予約が生きて(alive)動いて(active)いれば、自動予約の対象(auto)は通知しない。
//   ペナルティ期間・締切後の枠(Pi が予約しないもの)は通知する。
//   除外日(excluded_date)・除外枠(excluded_slot)は Pi の生死に関係なく通知しない(本人が外した日・手放した枠の空き通知は雑音)。
//   ただし autoState が取れなければ除外一覧も分からないので全部通知
// 戻り値 { notify: Slot[], suppressed: [{ slot, kind, reason }] }
//   autoState.notifyEnabled === false(LINE の「つうちおふ」)なら空き通知カードは全部止める
function splitForNotification(newSlots, { now = Date.now(), today = jstTodayIso(now), autoState } = {}) {
  if (!autoState) return { notify: [...newSlots], suppressed: [], piAlive: false };
  const piAlive = !!(autoState.alive && autoState.active);
  if (autoState.notifyEnabled === false) {
    return { notify: [], suppressed: newSlots.map((slot) => ({ slot, kind: 'notify_off', reason: 'LINE の「つうちおふ」で空き通知を止めている' })), piAlive };
  }
  const ex = normalizeExclusions(autoState);
  const notify = [];
  const suppressed = [];
  for (const slot of newSlots) {
    const c = classifySlot(slot, { now, today, exclusions: ex });
    if (c.kind === 'excluded_slot' || c.kind === 'excluded_date') suppressed.push({ slot, ...c });
    else if (c.kind === 'auto' && piAlive) suppressed.push({ slot, ...c, reason: 'Pi が自動予約する枠' });
    else notify.push(slot);
  }
  return { notify, suppressed, piAlive };
}

// 除外一覧の掃除: 過ぎた除外日、開始時刻を過ぎた除外枠を落とす(Worker と Pi の両方で同じ判定)
function pruneExclusions(exclusions, nowMs = Date.now()) {
  const today = jstTodayIso(nowMs);
  const dates = (exclusions?.dates || []).filter((d) => d >= today);
  const slots = (exclusions?.slots || []).filter((s) => {
    const start = s.start ?? startHHMM(s.startHour ?? s.time);
    return s.date && start && jstDateTimeMs(s.date, start) > nowMs;
  });
  return { ...exclusions, dates: [...new Set(dates)].sort(), slots };
}

module.exports = {
  parkOf,
  startHHMM,
  slotKey,
  isPenaltyPeriod,
  isFreeCancelLastDay,
  isPastLastDayDeadline,
  personFor,
  normalizeExclusions,
  classifySlot,
  sortCandidates,
  planAutoBooking,
  splitForNotification,
  pruneExclusions,
};
