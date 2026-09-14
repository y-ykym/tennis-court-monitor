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

test('並べ替え: 日付 → 公園の優先順(大島 > 猿江 > 亀戸)→ 時間帯(17 > 19 > 9 > 11 > 13 > 15)', () => {
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
    '2026-09-27 大島小松川公園 17:00',
    '2026-09-27 大島小松川公園 09:00',
    '2026-09-27 大島小松川公園 13:00',
    '2026-09-27 大島小松川公園 15:00',
    '2026-09-27 猿江恩賜公園 13:00',
    '2026-09-27 亀戸中央公園 17:00',
  ]);
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

test('通知の振り分け: Pi が生きていれば対象期間の枠は通知せず、ペナルティ期間・除外日は通知。除外枠は常に通知しない', () => {
  const slots = [
    slot('猿江恩賜公園', '2026-09-16', '19:00-21:00'), // ペナルティ期間 → 通知
    slot('猿江恩賜公園', '2026-09-25', '19:00-21:00'), // 対象 → Pi が生きていれば通知しない
    slot('大島小松川公園', '2026-09-27', '09:00-11:00'), // 除外日 → 通知
    slot('大島小松川公園', '2026-09-28', '13:00-15:00'), // 除外枠 → 通知しない
  ];
  const state = { alive: true, active: true, dates: ['2026-09-27'], slots: [{ park: '1160', date: '2026-09-28', start: '13:00' }] };
  const r = splitForNotification(slots, { today: TODAY, autoState: state });
  assert.equal(r.piAlive, true);
  assert.deepEqual(r.notify.map((s) => s.date), ['2026-09-16', '2026-09-27']);
  assert.deepEqual(r.suppressed.map((s) => [s.slot.date, s.kind]), [['2026-09-25', 'auto'], ['2026-09-28', 'excluded_slot']]);

  // Pi が死んでいる(または dry-run で active=false)→ 対象期間も通知。除外枠だけは通知しない
  for (const dead of [{ ...state, alive: false }, { ...state, active: false }]) {
    const d = splitForNotification(slots, { today: TODAY, autoState: dead });
    assert.equal(d.piAlive, false);
    assert.deepEqual(d.notify.map((s) => s.date), ['2026-09-16', '2026-09-25', '2026-09-27']);
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
