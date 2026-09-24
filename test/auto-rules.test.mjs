import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  slotKey, isPenaltyPeriod, isFreeCancelLastDay, isPastLastDayDeadline, personFor, classifySlot, sortCandidates, planAutoBooking, splitForNotification, pruneExclusions,
} = require('../lib/auto-rules.js');
const { AUTO_BOOKING } = require('../lib/config.js');
const { jstEndOfDaySec, daysBetween, addDaysIso } = require('../lib/date.js');

const TODAY = '2026-09-14'; // 月曜
const slot = (facility, date, time, count = 1) => ({ facility, date, time, count });

test('枠キー: 空き枠・予約一覧の行・予約指示のどれからでも同じキーになる(公園コード|日付|開始)', () => {
  const key = '1160|2026-09-27|13:00';
  assert.equal(slotKey(slot('大島小松川公園', '2026-09-27', '13:00-15:00')), key);
  assert.equal(slotKey({ facility: 'No.1大島小松川公園', date: '2026-09-27', start: '13:00' }), key);
  assert.equal(slotKey({ park: '1160', date: '2026-09-27', startHour: 13 }), key);
  assert.equal(slotKey(slot('猿江恩賜公園', '2026-09-25', '09:00-11:00')), '1040|2026-09-25|09:00');
});

test('ペナルティ境界: 今日+3 は対象外(ペナルティ期間)、今日+4 は対象。+4 は無料キャンセル最終日', () => {
  assert.equal(AUTO_BOOKING.PENALTY_DAYS, 3);
  assert.equal(isPenaltyPeriod('2026-09-17', TODAY), true, '+3');
  assert.equal(isPenaltyPeriod('2026-09-18', TODAY), false, '+4');
  assert.equal(isPenaltyPeriod('2026-09-14', TODAY), true, '当日');
  assert.equal(isFreeCancelLastDay('2026-09-18', TODAY), true);
  assert.equal(isFreeCancelLastDay('2026-09-19', TODAY), false);
  assert.equal(daysBetween(TODAY, '2026-09-18'), 4);
  assert.equal(addDaysIso(TODAY, 4), '2026-09-18');
});

test('予約者: 利用日が平日なら B、土日祝なら A(祝日は japanese-holidays)', () => {
  assert.equal(personFor('2026-09-25'), 'B', '金曜');
  assert.equal(personFor('2026-09-26'), 'A', '土曜');
  assert.equal(personFor('2026-09-27'), 'A', '日曜');
  assert.equal(personFor('2026-09-21'), 'A', '敬老の日(祝)');
  assert.equal(personFor('2026-09-23'), 'A', '秋分の日(祝)');
});

test('振り分け: 除外枠 > ペナルティ > 除外日 > 対象', () => {
  const ex = { dates: ['2026-09-27'], slots: [{ park: '1160', date: '2026-09-27', start: '13:00' }, { facility: '猿江恩賜公園', date: '2026-09-16', start: '19:00' }] };
  assert.equal(classifySlot(slot('猿江恩賜公園', '2026-09-25', '19:00-21:00'), { today: TODAY, exclusions: ex }).kind, 'auto');
  assert.equal(classifySlot(slot('猿江恩賜公園', '2026-09-16', '19:00-21:00'), { today: TODAY, exclusions: ex }).kind, 'excluded_slot', '除外枠はペナルティ期間でも除外枠');
  assert.equal(classifySlot(slot('猿江恩賜公園', '2026-09-17', '19:00-21:00'), { today: TODAY, exclusions: ex }).kind, 'penalty');
  assert.equal(classifySlot(slot('大島小松川公園', '2026-09-27', '09:00-11:00'), { today: TODAY, exclusions: ex }).kind, 'excluded_date');
  assert.equal(classifySlot(slot('大島小松川公園', '2026-09-27', '13:00-15:00'), { today: TODAY, exclusions: ex }).kind, 'excluded_slot');
  assert.equal(classifySlot(slot('木場公園', '2026-09-27', '13:00-15:00'), { today: TODAY, exclusions: ex }).kind, 'unknown_park');
});

test('並べ替え: 日付 → 公園の優先順(大島 > 猿江 > 亀戸)→ 時間帯(11 > 9 > 15 > 13 > 17 > 19)', () => {
  const sorted = sortCandidates([
    slot('猿江恩賜公園', '2026-09-27', '13:00-15:00'),
    slot('大島小松川公園', '2026-09-27', '15:00-17:00'),
    slot('亀戸中央公園', '2026-09-27', '17:00-19:00'),
    slot('大島小松川公園', '2026-09-27', '09:00-11:00'),
    slot('大島小松川公園', '2026-09-27', '13:00-15:00'),
    slot('亀戸中央公園', '2026-09-26', '15:00-17:00'),
    slot('大島小松川公園', '2026-09-27', '17:00-19:00'),
  ]).map((s) => `${s.date} ${s.facility} ${s.time.slice(0, 5)}`);
  assert.deepEqual(sorted, [
    '2026-09-26 亀戸中央公園 15:00',
    '2026-09-27 大島小松川公園 09:00',
    '2026-09-27 大島小松川公園 15:00',
    '2026-09-27 大島小松川公園 13:00',
    '2026-09-27 大島小松川公園 17:00',
    '2026-09-27 猿江恩賜公園 13:00',
    '2026-09-27 亀戸中央公園 17:00',
  ]);
  assert.deepEqual(AUTO_BOOKING.HOUR_PRIORITY, [11, 9, 15, 13, 17, 19]);
  assert.equal(AUTO_BOOKING.MAX_PER_DAY, 1);
});

test('計画: 利用日ごとに候補を並べ、予約者を付け、対象外は理由付きで見送る', () => {
  const { byDate, skipped } = planAutoBooking(
    [
      slot('猿江恩賜公園', '2026-09-27', '13:00-15:00'),
      slot('大島小松川公園', '2026-09-27', '09:00-11:00'),
      slot('大島小松川公園', '2026-09-27', '13:00-15:00'),
      slot('猿江恩賜公園', '2026-09-25', '19:00-21:00'),
      slot('猿江恩賜公園', '2026-09-16', '19:00-21:00'),
      slot('猿江恩賜公園', '2026-09-30', '19:00-21:00'),
    ],
    { today: TODAY, exclusions: { dates: ['2026-09-30'], slots: [] } }
  );
  assert.deepEqual([...byDate.keys()], ['2026-09-25', '2026-09-27']);
  assert.deepEqual(byDate.get('2026-09-27').map((c) => [c.park, c.startHour, c.person, c.key]), [
    ['1160', 9, 'A', '1160|2026-09-27|09:00'],
    ['1160', 13, 'A', '1160|2026-09-27|13:00'],
    ['1040', 13, 'A', '1040|2026-09-27|13:00'],
  ]);
  assert.deepEqual(byDate.get('2026-09-25').map((c) => [c.park, c.startHour, c.person]), [['1040', 19, 'B']]);
  assert.deepEqual(skipped.map((s) => [s.slot.date, s.kind]), [['2026-09-16', 'penalty'], ['2026-09-30', 'excluded_date']]);
});

test('通知の振り分け: Pi が生きていれば対象期間の枠は通知せず、ペナルティ期間は通知。除外日・除外枠は常に通知しない', () => {
  const slots = [
    slot('猿江恩賜公園', '2026-09-16', '19:00-21:00'), // ペナルティ期間 → 通知
    slot('猿江恩賜公園', '2026-09-25', '19:00-21:00'), // 対象 → Pi が生きていれば通知しない
    slot('大島小松川公園', '2026-09-27', '09:00-11:00'), // 除外日 → 通知しない
    slot('大島小松川公園', '2026-09-28', '13:00-15:00'), // 除外枠 → 通知しない
  ];
  const state = { alive: true, active: true, dates: ['2026-09-27'], slots: [{ park: '1160', date: '2026-09-28', start: '13:00' }] };
  const r = splitForNotification(slots, { today: TODAY, autoState: state });
  assert.equal(r.piAlive, true);
  assert.deepEqual(r.notify.map((s) => s.date), ['2026-09-16']);
  assert.deepEqual(r.suppressed.map((s) => [s.slot.date, s.kind]), [['2026-09-25', 'auto'], ['2026-09-27', 'excluded_date'], ['2026-09-28', 'excluded_slot']]);

  // Pi が死んでいる(または dry-run で active=false)→ 対象期間も通知。除外日・除外枠は通知しない
  for (const dead of [{ ...state, alive: false }, { ...state, active: false }]) {
    const d = splitForNotification(slots, { today: TODAY, autoState: dead });
    assert.equal(d.piAlive, false);
    assert.deepEqual(d.notify.map((s) => s.date), ['2026-09-16', '2026-09-25']);
  }
  // Worker に繋がらない(null)→ 全部通知(安全側)
  const u = splitForNotification(slots, { today: TODAY, autoState: null });
  assert.equal(u.notify.length, 4);
  assert.equal(u.piAlive, false);
});

test('除外一覧の掃除: 過ぎた日と開始時刻を過ぎた枠を落とす', () => {
  const now = Date.parse('2026-09-14T05:30:00Z'); // JST 9/14 14:30
  const pruned = pruneExclusions(
    {
      dates: ['2026-09-13', '2026-09-14', '2026-09-20', '2026-09-20'],
      slots: [
        { park: '1040', date: '2026-09-14', start: '13:00' }, // 開始済み
        { park: '1040', date: '2026-09-14', start: '15:00' }, // まだ
        { park: '1160', date: '2026-09-13', start: '09:00' },
      ],
    },
    now
  );
  assert.deepEqual(pruned.dates, ['2026-09-14', '2026-09-20']);
  assert.deepEqual(pruned.slots.map((s) => `${s.date} ${s.start}`), ['2026-09-14 15:00']);
  assert.equal(jstEndOfDaySec('2026-09-14'), Math.floor(Date.parse('2026-09-14T14:59:59Z') / 1000));
});

// JST の時刻 → unix ミリ秒(2026-09-14 基準)
const jst = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+09:00`);

test('締切: 利用日 = 今日+4 日は 23:35 以降は対象外(deadline)。23:34 は対象。+5 日には締切なし。日付が変わると +3 日 = ペナルティ', () => {
  assert.equal(AUTO_BOOKING.LAST_DAY_DEADLINE, '23:35');
  const s4 = slot('猿江恩賜公園', '2026-09-18', '19:00-21:00'); // 今日 9/14 の +4 日
  const s5 = slot('猿江恩賜公園', '2026-09-19', '09:00-11:00');
  assert.equal(classifySlot(s4, { now: jst('2026-09-14', '23:34') }).kind, 'auto');
  assert.equal(classifySlot(s4, { now: jst('2026-09-14', '23:35') }).kind, 'deadline');
  assert.equal(classifySlot(s4, { now: jst('2026-09-14', '23:59') }).kind, 'deadline');
  assert.equal(classifySlot(s4, { now: jst('2026-09-15', '00:01') }).kind, 'penalty', '日付が変わって +3 日');
  assert.equal(classifySlot(s5, { now: jst('2026-09-14', '23:59') }).kind, 'auto', '+5 日には締切なし');
  assert.equal(classifySlot(s5, { now: jst('2026-09-15', '00:01') }).kind, 'auto', '翌日には +4 日で、まだ 00:01 なので対象');
  assert.equal(isPastLastDayDeadline('2026-09-18', jst('2026-09-14', '23:35')), true);
  assert.equal(isPastLastDayDeadline('2026-09-18', jst('2026-09-14', '23:34')), false);
  assert.equal(isPastLastDayDeadline('2026-09-19', jst('2026-09-14', '23:59')), false);
  // now を渡さないときは today で判定(締切は実時刻)
  assert.equal(classifySlot(s4, { today: TODAY, now: jst('2026-09-14', '10:00') }).kind, 'auto');
});

test('通知の振り分け: 締切後の +4 日の枠は Pi が生きていても通知する(Pi は予約しない)', () => {
  const state = { alive: true, active: true, dates: [], slots: [] };
  const s4 = slot('猿江恩賜公園', '2026-09-18', '19:00-21:00');
  assert.deepEqual(splitForNotification([s4], { now: jst('2026-09-14', '23:34'), autoState: state }).notify, []);
  assert.deepEqual(splitForNotification([s4], { now: jst('2026-09-14', '23:40'), autoState: state }).notify, [s4]);
  const plan = planAutoBooking([s4], { now: jst('2026-09-14', '23:40'), exclusions: { dates: [], slots: [] } });
  assert.equal(plan.byDate.size, 0);
  assert.equal(plan.skipped[0].kind, 'deadline');
});

test('空き通知カード: ペナルティ期間(今日+3 日以内)の日には「⚠ 取消にペナルティ」が付き、それ以降には付かない', () => {
  const { buildFlexMessage, formatMessage } = require('../lib/notify.js');
  const today = require('../lib/date.js').jstTodayIso();
  const near = addDaysIso(today, 2);
  const far = addDaysIso(today, 10);
  const m = buildFlexMessage([slot('猿江恩賜公園', near, '19:00-21:00'), slot('猿江恩賜公園', far, '19:00-21:00')]);
  const json = JSON.stringify(m.contents);
  assert.equal((json.match(/⚠ 取消にペナルティ/g) || []).length, 1, '近い日だけ');
  const text = formatMessage([slot('猿江恩賜公園', near, '19:00-21:00'), slot('猿江恩賜公園', far, '19:00-21:00')]);
  const lines = text.split('\n').filter((l) => l.startsWith('📅'));
  assert.match(lines[0], /取消にペナルティ/);
  assert.doesNotMatch(lines[1], /取消にペナルティ/);
});

test('通知の振り分け: LINE の「つうちおふ」(notifyEnabled=false)なら空き通知は全部止める', () => {
  const slots = [slot('猿江恩賜公園', '2026-09-16', '19:00-21:00'), slot('猿江恩賜公園', '2026-09-25', '19:00-21:00')];
  const r = splitForNotification(slots, { today: TODAY, autoState: { alive: false, active: false, dates: [], slots: [], notifyEnabled: false } });
  assert.deepEqual(r.notify, []);
  assert.deepEqual(r.suppressed.map((s) => s.kind), ['notify_off', 'notify_off']);
  const on = splitForNotification(slots, { today: TODAY, autoState: { alive: false, active: false, dates: [], slots: [], notifyEnabled: true } });
  assert.equal(on.notify.length, 2);
});

test('隣接の判定(2026-09-24): 時間が重なる予定は場所を問わず見送り。接する予定は別の公園なら見送り、同じ公園なら問題なし。離れている・別の日は問題なし', () => {
  const { findPlaceConflict } = require('../lib/auto-rules.js');
  const cand = { park: '1040', date: '2026-09-27', startHour: 13 }; // 猿江 13:00-15:00
  // 直前(11-13)に別の公園の都の予約
  const before = findPlaceConflict(cand, [{ date: '2026-09-27', start: '11:00', end: '13:00', facility: '亀戸中央公園' }]);
  assert.equal(before?.relation, 'before');
  assert.match(before.reason, /直前に別の場所の予約/);
  // 直後(15-17)に別の公園のテニスベアの予定(公園コード付き)
  const after = findPlaceConflict(cand, [{ source: 'tennisbear', date: '2026-09-27', start: '15:00', end: '17:00', park: '1160', facility: '大島小松川公園Ａ' }]);
  assert.equal(after?.relation, 'after');
  assert.match(after.reason, /直後に別の場所のテニスベアの予定/);
  // 時間が重なる(14-16)別の場所(都営以外 = 公園が分からない)
  const overlap = findPlaceConflict(cand, [{ source: 'tennisbear', date: '2026-09-27', start: '14:00', end: '16:00', park: null, facility: '有明テニスの森' }]);
  assert.equal(overlap?.relation, 'overlap');
  assert.match(overlap.reason, /時間が重なるテニスベアの予定/);
  // 時間が重なるなら同じ公園でも見送り(同時に 2 面はできない)
  assert.equal(findPlaceConflict(cand, [{ source: 'tennisbear', date: '2026-09-27', start: '13:00', end: '15:00', park: '1040', facility: '猿江恩賜公園' }])?.relation, 'overlap');
  assert.equal(findPlaceConflict(cand, [{ date: '2026-09-27', start: '13:00', end: '15:00', facility: '猿江恩賜公園' }])?.relation, 'overlap');
  // 接するだけなら同じ公園は問題なし
  assert.equal(findPlaceConflict(cand, [{ date: '2026-09-27', start: '11:00', end: '13:00', facility: '猿江恩賜公園' }]), null);
  assert.equal(findPlaceConflict(cand, [{ source: 'tennisbear', date: '2026-09-27', start: '15:00', end: '17:00', park: '1040', facility: '猿江恩賜公園' }]), null);
  // 離れている(9-11 と 13-15 の間に 2 時間)・別の日 は問題なし
  assert.equal(findPlaceConflict(cand, [{ date: '2026-09-27', start: '09:00', end: '11:00', facility: '亀戸中央公園' }]), null);
  assert.equal(findPlaceConflict(cand, [{ date: '2026-09-28', start: '11:00', end: '13:00', facility: '亀戸中央公園' }]), null);
  // 終了時刻が無いテニスベアの予定は 2 時間と仮定(11:00 開始 → 13:00 終了 = 接する)。11:30 開始なら 13:30 終了で重なる
  assert.equal(findPlaceConflict(cand, [{ source: 'tennisbear', date: '2026-09-27', start: '11:00', end: '', park: null, facility: 'どこか' }])?.relation, 'before');
  assert.equal(findPlaceConflict(cand, [{ source: 'tennisbear', date: '2026-09-27', start: '11:30', end: '', park: null, facility: 'どこか' }])?.relation, 'overlap');
  // 間の空きの許容(既定 0 分): 12:30 終了なら 30 分空くので問題なし。gapMinutes を 30 にすれば見送り
  assert.equal(findPlaceConflict(cand, [{ source: 'tennisbear', date: '2026-09-27', start: '10:30', end: '12:30', park: null, facility: 'どこか' }]), null);
  assert.equal(findPlaceConflict(cand, [{ source: 'tennisbear', date: '2026-09-27', start: '10:30', end: '12:30', park: null, facility: 'どこか' }], { gapMinutes: 30 })?.relation, 'before');
  assert.equal(AUTO_BOOKING.ADJACENT_GAP_MINUTES, 0);
  // 空き枠の形(facility + time)の候補でも判定できる
  assert.equal(findPlaceConflict(slot('猿江恩賜公園', '2026-09-27', '13:00-15:00'), [{ date: '2026-09-27', start: '15:00', end: '17:00', facility: '亀戸中央公園' }])?.relation, 'after');
});
