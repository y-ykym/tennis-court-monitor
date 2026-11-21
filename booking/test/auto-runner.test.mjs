import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutoRunner, nextDelayMs, pollIntervalAt, backoffIntervalMs, MIN_GAP_MS, DAY_REMAINING_TTL_MS, AUTH_PAUSE_MS, TB_PLANS_TTL_MS, PARTIAL_CARRY_MAX_MS, SITE_LIST_REFRESH_MS, SITE_LIST_RETRY_MS, SITE_LIST_MAX_AGE_MS } from '../src/auto-runner.js';
import { createEventLog, readEvents } from '../src/auto-events.js';
import { createAutoState } from '../src/auto-state.js';
import { createBookingQueue } from '../src/booking-queue.js';
import { verifyCancelToken } from '../src/cancel-token.js';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AUTO_BOOKING } = require('../../lib/config.js');
// このファイルのテストの多くは土日の日付で「上限 1 件」の動きを見ているので、土日祝の上限もここでは 1 件に固定する。
// 本番の値(土日祝 2 件。2026-11-21)での動きは「土日祝は 1 日 2 件まで」のテストで、値を戻して確かめる
const HOLIDAY_MAX = AUTO_BOOKING.MAX_PER_DAY_HOLIDAY;
AUTO_BOOKING.MAX_PER_DAY_HOLIDAY = 1;

const SECRET = 'test-signing-secret';
// 2026-09-14(月) JST 10:00
const T0 = Date.parse('2026-09-14T01:00:00Z');
const slot = (facility, date, time, count = 1) => ({ facility, date, time, count });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-')), 'auto-state.json');
const flush = () => new Promise((r) => setTimeout(r, 20));

function harness({ mode = 'on', slots = [], exclusions = { dates: [], slots: [] }, book, reservations = {}, creds = { A: true, B: true }, heartbeatFails = false, start = T0, workerOverride = null, eventsFile = null, skipListCheck = undefined, afterListFails = false } = {}) {
  let t = start;
  const logs = [];
  const notified = [];
  const vacancyCards = [];
  const heartbeats = [];
  const added = [];
  const dropped = [];
  const bookings = [];
  const bookOpts = [];
  const state = createAutoState({ file: tmpFile(), now: () => t });
  const queue = createBookingQueue();
  let current = slots;
  const workerRef = Object.assign(workerOverride || {}, {
    heartbeat: async (p) => {
      heartbeats.push(p);
      if (heartbeatFails) throw new Error('offline');
      return exclusions;
    },
    addExcludedSlots: async (s) => added.push(...s),
    dropAllowedSlots: async (s) => dropped.push(...s),
  });
  const runner = createAutoRunner({
    mode,
    scrape: async () => {
      if (current instanceof Error) throw current;
      return current;
    },
    queue,
    state,
    worker: workerRef,
    book:
      book ||
      (async (c, opts) => {
        const { beforeApply, skipList } = opts;
        bookings.push(`${c.date} ${c.park} ${c.startHour} ${c.person}`);
        bookOpts.push(opts);
        const list = reservations[c.person] || [];
        if (skipList) {
          // 予約の前の一覧は見ない。成立の後の一覧(サイトの本物 = それまでの予約 + 今回の 1 件)を付けて返す
          const mine = { id: `R${bookings.length}`, date: c.date, start: `${String(c.startHour).padStart(2, '0')}:00`, end: `${String(Number(c.startHour) + 2).padStart(2, '0')}:00`, facility: c.facility };
          reservations[c.person] = [...list, mine]; // 偽のサイトも成立した予約を覚える(次の成立後の一覧に載る)
          return { status: 'success', reservationNo: mine.id, fee: '2,600円', facility: c.facility, ...(afterListFails ? {} : { reservationsAfter: reservations[c.person] }) };
        }
        const stop = await beforeApply({ reservations: list });
        if (stop) return { ...stop, reservationsBefore: list };
        return { status: 'success', reservationNo: `R${bookings.length}`, fee: '2,600円', facility: c.facility, reservationsBefore: list };
      }),
    credentialsFor: (p) => (creds[p] ? { userId: 'u', password: 'p', label: `name${p}` } : null),
    notify: async (m, what) => notified.push({ m, what }),
    notifyVacancy: async (slots) => vacancyCards.push(...slots),
    signingSecret: SECRET,
    log: (m) => logs.push(m),
    now: () => t,
    eventLog: eventsFile ? createEventLog({ file: eventsFile }) : null,
    ...(skipListCheck === undefined ? {} : { skipListCheck }),
  });
  return {
    runner, state, queue, logs, notified, heartbeats, added, dropped, bookings, bookOpts, vacancyCards, workerRef,
    setSlots: (s) => (current = s),
    advance: (ms) => (t += ms),
    now: () => t,
  };
}

test('初回起動: いま見えている空きを既知として登録し予約しない。heartbeat は送る', async () => {
  const h = harness({ slots: [slot('猿江恩賜公園', '2026-09-25', '19:00-21:00')] });
  const r = await h.runner.tick();
  assert.deepEqual(r, { baseline: true, known: 1 });
  assert.equal(h.bookings.length, 0);
  assert.equal(h.heartbeats.length, 1);
  assert.equal(h.heartbeats[0].active, true);
  assert.equal(h.heartbeats[0].mode, 'on');
  assert.ok(h.logs.some((l) => l.includes('初回起動')));
  // 2 回目: 同じ空きなら新規なし
  h.advance(60_000);
  assert.deepEqual(await h.runner.tick(), { newSlots: 0 });
});

test('振り分けと実行: 対象は予約者(平日 B / 休日 A)で予約、ペナルティ期間・除外日・除外枠は見送り(理由をログに)', async () => {
  const h = harness({ exclusions: { dates: ['2026-09-30'], slots: [{ park: '1160', date: '2026-09-27', start: '13:00' }] } });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([
    slot('猿江恩賜公園', '2026-09-25', '19:00-21:00'), // 金 → B
    slot('大島小松川公園', '2026-09-27', '09:00-11:00'), // 日 → A
    slot('大島小松川公園', '2026-09-27', '13:00-15:00'), // 除外枠
    slot('猿江恩賜公園', '2026-09-16', '19:00-21:00'), // ペナルティ期間
    slot('猿江恩賜公園', '2026-09-30', '19:00-21:00'), // 除外日
  ]);
  const r = await h.runner.tick();
  assert.deepEqual(r, { newSlots: 5, planned: 2 });
  await flush();
  assert.deepEqual(h.bookings, ['2026-09-25 1040 19 B', '2026-09-27 1160 9 A']);
  assert.equal(h.notified.length, 2, '成功カード 2 枚');
  assert.match(h.notified[0].m.contents.header.contents[0].text, /自動予約/);
  assert.ok(h.logs.some((l) => l.includes('2026-09-16') && l.includes('ペナルティ期間')));
  assert.ok(h.logs.some((l) => l.includes('2026-09-30') && l.includes('除外日')));
  assert.ok(h.logs.some((l) => l.includes('13:00') && l.includes('除外枠')));
  assert.equal(h.state.attemptStatus('1040|2026-09-25|19:00'), 'success');
  assert.equal(h.state.own().length, 2);
  // 同じ枠が見え続けても再投入しない。いったん消えて再び出ても success の枠は取り直さない
  h.advance(60_000);
  h.setSlots([]);
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-25', '19:00-21:00')]);
  assert.deepEqual(await h.runner.tick(), { newSlots: 1, planned: 0 });
  assert.ok(h.logs.some((l) => l.includes('既に自動予約済み')));
});

test('1 日の上限: 予約直前の一覧でその日の件数を数え、上限(1 件)に達したら見送る。同じ実行の成立分も数える', async () => {
  // 9/27(日) A: 大島 9・13・15、猿江 13 が同時に出た。A はその日にまだ予約が無い
  const reservations = { A: [] };
  const h = harness({ reservations });
  // 成立したら一覧にも増える(サイトの振る舞いを模す)
  const origBook = async (c, { beforeApply }) => {
    h.bookings.push(`${c.park} ${c.startHour}`);
    const list = reservations.A;
    const stop = await beforeApply({ reservations: list });
    if (stop) return stop;
    reservations.A = [...list, { id: `R${list.length}`, date: c.date, start: `${String(c.startHour).padStart(2, '0')}:00`, end: `${c.startHour + 2}:00`, facility: c.facility }];
    return { status: 'success', reservationNo: `R${list.length}`, facility: c.facility };
  };
  h.runner.stop();
  const h2 = harness({ reservations, book: origBook });
  Object.assign(h, { runner: h2.runner, bookings: h2.bookings, notified: h2.notified, logs: h2.logs, state: h2.state, advance: h2.advance, setSlots: h2.setSlots });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([
    slot('猿江恩賜公園', '2026-09-27', '13:00-15:00'),
    slot('大島小松川公園', '2026-09-27', '09:00-11:00'),
    slot('大島小松川公園', '2026-09-27', '13:00-15:00'),
    slot('大島小松川公園', '2026-09-27', '15:00-17:00'),
  ]);
  const r = await h.runner.tick();
  assert.equal(r.planned, 4);
  await flush();
  assert.deepEqual(h.bookings, ['1160 9'], '優先順 1 位の大島 9 時だけ予約(成立で上限 1 件)。残りはログインせずに見送り');
  assert.equal(h.notified.length, 1);
  assert.equal(h.state.attemptStatus('1160|2026-09-27|15:00'), 'capped');
  assert.equal(h.state.attemptStatus('1160|2026-09-27|13:00'), 'capped');
  assert.equal(h.state.attemptStatus('1040|2026-09-27|13:00'), 'capped');
  assert.ok(h.logs.filter((l) => l.includes('既に 1 件あるため')).length >= 3);
});

test('1 日の上限: 一覧で既にその日に予約(手動分)があれば予約せず(capped)、カードも送らない。失敗(taken)は次の候補へ進むが、カードは送らない(通数節約)', async () => {
  const reservations = { A: [{ id: '1', date: '2026-09-27', start: '17:00' }], B: [] };
  let n = 0;
  const h = harness({
    reservations,
    book: async (c, { beforeApply }) => {
      const list = reservations[c.person];
      const stop = await beforeApply({ reservations: list });
      if (stop) return stop;
      n++;
      return n === 1 ? { status: 'taken', message: '先に取られた' } : { status: 'success', reservationNo: 'R9', facility: c.facility };
    },
  });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([
    slot('大島小松川公園', '2026-09-27', '09:00-11:00'), // A: 手動で 1 件あり → capped
    slot('猿江恩賜公園', '2026-09-25', '19:00-21:00'), // B(金): taken
    slot('猿江恩賜公園', '2026-09-29', '19:00-21:00'), // B(火): success
  ]);
  await h.runner.tick();
  await flush();
  assert.equal(h.state.attemptStatus('1160|2026-09-27|09:00'), 'capped');
  assert.equal(h.state.attemptStatus('1040|2026-09-25|19:00'), 'taken');
  assert.equal(h.state.attemptStatus('1040|2026-09-29|19:00'), 'success');
  assert.deepEqual(h.notified.map((x) => x.m.contents.header.contents[0].text), ['🤖 自動予約が完了'], 'taken のカードは送らない');
  assert.ok(h.logs.some((l) => l.includes('結果カードは送りません(taken')));
});

test('失敗カード: ログインできない・reCAPTCHA 拒否は送る(放置すると自動予約が止まる)。先に取られた・断られた・サイトのエラーは送らない', async () => {
  const statuses = ['auth_error', 'rejected', 'error', 'error' /* error 直後のその場のやり直し(2026-11-08) */, 'taken', 'duplicate'];
  let i = 0;
  const h = harness({ book: async () => ({ status: statuses[i++], message: 'x' }) });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([
    slot('猿江恩賜公園', '2026-09-22', '19:00-21:00'),
    slot('猿江恩賜公園', '2026-09-24', '19:00-21:00'),
    slot('猿江恩賜公園', '2026-09-25', '19:00-21:00'),
    slot('猿江恩賜公園', '2026-09-29', '19:00-21:00'),
    slot('猿江恩賜公園', '2026-09-30', '19:00-21:00'),
  ]);
  await h.runner.tick();
  await flush();
  assert.equal(i, 6);
  const reasons = h.notified.map((x) => JSON.stringify(x.m.contents.body));
  assert.equal(reasons.length, 2);
  assert.match(reasons[0], /ログインできませんでした/);
  assert.match(reasons[1], /認証で拒否/);
  assert.ok(h.logs.some((l) => l.includes('結果カードは送りません(error')));
});

test('利用日 = 今日+4 日の成功カードにはキャンセルボタン(Worker が検証できる c| トークン、期限は今日 23:59)。+5 日には付かない', async () => {
  const h = harness();
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-18', '19:00-21:00'), slot('猿江恩賜公園', '2026-09-19', '09:00-11:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(h.notified.length, 2);
  const withBtn = h.notified.find((x) => JSON.stringify(x.m).includes('2026-09-18') || JSON.stringify(x.m).includes('9/18'));
  const data = JSON.stringify(withBtn.m.contents.footer).match(/"data":"([^"]+)"/)[1];
  const v = verifyCancelToken(SECRET, data, h.now());
  assert.equal(v.kind, 'c');
  assert.equal(v.person, 'B');
  assert.equal(v.date, '2026-09-18');
  assert.equal(v.start, '19:00');
  assert.equal(v.end, '21:00');
  assert.equal(v.facility, '猿江恩賜公園');
  assert.equal(v.penaltyDay, 3);
  assert.equal(v.exp, Math.floor(Date.parse('2026-09-14T14:59:59Z') / 1000), '今日 23:59:59 JST');
  assert.equal(v.expired, false);
  const without = h.notified.find((x) => x !== withBtn);
  assert.equal(JSON.stringify(without.m).includes('"type":"postback"'), false);
});

test('dry-run: 予約せず「予約するはず」をログに出す。heartbeat は active=false', async () => {
  const h = harness({ mode: 'dry-run' });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-25', '19:00-21:00')]);
  const r = await h.runner.tick();
  assert.deepEqual(r, { newSlots: 1, planned: 0 });
  assert.equal(h.bookings.length, 0);
  assert.ok(h.logs.some((l) => l.includes('[dry-run] 予約するはず') && l.includes('nameB')));
  assert.equal(h.heartbeats.at(-1).active, false);
  assert.equal(h.heartbeats.at(-1).mode, 'dry-run');
});

test('Worker に繋がらない: 除外一覧が一度も取れていなければ予約しない。直近の一覧があればそれで続ける', async () => {
  const h = harness({ heartbeatFails: true });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-25', '19:00-21:00')]);
  const r = await h.runner.tick();
  assert.equal(r.reason, 'no_exclusions');
  assert.equal(h.bookings.length, 0);
  assert.ok(h.logs.some((l) => l.includes('除外一覧が取れていない')));
});

test('予約者の利用者情報が無い(B 未設定)なら見送り', async () => {
  const h = harness({ creds: { A: true, B: false } });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-25', '19:00-21:00')]);
  assert.deepEqual(await h.runner.tick(), { newSlots: 1, planned: 0 });
  assert.ok(h.logs.some((l) => l.includes('予約者 B の利用者情報が未設定')));
});

test('手放しの検出: 自分が自動予約した枠が一覧から消えていたら除外枠として Worker に登録する', async () => {
  const reservations = { B: [] };
  const h = harness({
    reservations,
    book: async (c, { beforeApply }) => {
      const stop = await beforeApply({ reservations: reservations.B });
      if (stop) return stop;
      return { status: 'success', reservationNo: 'R1', facility: c.facility };
    },
  });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-25', '19:00-21:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(h.state.own().length, 1);
  // 本人がサイトで直接取り消した(一覧に無い)。次の予約の一覧確認で気づく
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-25', '19:00-21:00'), slot('猿江恩賜公園', '2026-09-29', '19:00-21:00')]);
  await h.runner.tick();
  await flush();
  assert.deepEqual(h.added.map((s) => `${s.park} ${s.date} ${s.start} ${s.reason}`), ['1040 2026-09-25 19:00 released']);
  assert.equal(h.state.own().filter((o) => o.key === '1040|2026-09-25|19:00').length, 0);
});

test('照会の失敗はスキップし、heartbeat だけ送る。30 秒未満の間隔は 30 秒に切り上げ', async () => {
  const h = harness();
  h.runner.stop();
  const logs = [];
  const heartbeats = [];
  const runner = createAutoRunner({
    mode: 'on',
    scrape: async () => { throw new Error('502'); },
    queue: createBookingQueue(),
    state: createAutoState({ file: tmpFile() }),
    worker: { heartbeat: async (p) => heartbeats.push(p) && { dates: [], slots: [] }, addExcludedSlots: async () => {} },
    book: async () => ({ status: 'error' }),
    credentialsFor: () => null,
    log: (m) => logs.push(m),
    pollMs: 5000,
  });
  assert.equal(runner.intervalMs, 30000);
  assert.deepEqual(await runner.tick(), { skipped: 'scrape_failed', consecutiveFailures: 1 });
  assert.equal(heartbeats.length, 1);
  assert.ok(runner.lastCycle().error.includes('502'), '失敗は /auto/status の lastCycle に残る(合図は照会と同時に投げるので中身には載らない)');
});

test('空き照会の連続失敗で間隔を広げ、成功で戻す', async () => {
  // 3 回目から 3 分 → 5 分 → 10 分 → 15 分(上限)。閾値未満は通常の間隔
  assert.equal(backoffIntervalMs(0, 60000), 60000);
  assert.equal(backoffIntervalMs(2, 60000), 60000);
  assert.equal(backoffIntervalMs(3, 60000), 3 * 60000);
  assert.equal(backoffIntervalMs(4, 60000), 5 * 60000);
  assert.equal(backoffIntervalMs(5, 60000), 10 * 60000);
  assert.equal(backoffIntervalMs(6, 60000), 15 * 60000);
  assert.equal(backoffIntervalMs(60, 60000), 15 * 60000);
  // 通常の間隔の方が長ければそちら(深夜 3 分 vs 3 分)
  assert.equal(backoffIntervalMs(3, 5 * 60000), 5 * 60000);

  let fail = true;
  const logs = [];
  const runner = createAutoRunner({
    mode: 'on',
    scrape: async () => { if (fail) throw new Error('fetch failed'); return []; },
    queue: createBookingQueue(),
    state: createAutoState({ file: tmpFile() }),
    worker: { heartbeat: async () => ({ dates: [], slots: [] }), addExcludedSlots: async () => {} },
    book: async () => ({}),
    credentialsFor: () => null,
    log: (m) => logs.push(m),
  });
  assert.equal(runner.consecutiveFailures(), 0);
  assert.deepEqual(await runner.tick(), { skipped: 'scrape_failed', consecutiveFailures: 1 });
  assert.deepEqual(await runner.tick(), { skipped: 'scrape_failed', consecutiveFailures: 2 });
  assert.ok(!logs.at(-1).includes('空けます'), '2 回目までは間隔を広げない');
  assert.deepEqual(await runner.tick(), { skipped: 'scrape_failed', consecutiveFailures: 3 });
  assert.ok(logs.at(-1).includes('次の照会まで 3 分空けます'), logs.at(-1));
  assert.equal(runner.consecutiveFailures(), 3);
  fail = false;
  await runner.tick();
  assert.equal(runner.consecutiveFailures(), 0);
  assert.ok(logs.some((m) => m.includes('空き照会が回復しました(連続失敗 3 回のあと)')), logs.join('\n'));
});

const jst = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+09:00`);

test('日付境界: 23:59 に見つけた +4 日の枠を 00:01 に実行 → +3 日になっているので予約せず、Pi が従来の空き通知カードを送る', async () => {
  // 予約の実行を止めておき、日付が変わってから動かす
  const gate = deferredGate();
  const h = harness({
    start: jst('2026-09-14', '23:58'),
    book: async () => { throw new Error('予約してはいけない'); },
  });
  await h.runner.tick(); // 初回(23:58)
  h.advance(60_000); // 23:59
  h.setSlots([slot('猿江恩賜公園', '2026-09-18', '19:00-21:00')]); // 9/14 の +4 日 → 23:59 は締切後なので見つけた時点で見送り
  const r0 = await h.runner.tick();
  assert.equal(r0.planned, 0);
  assert.ok(h.logs.some((l) => l.includes('23:35 を過ぎている')));
  assert.equal(h.vacancyCards.length, 0, '見つけた時点で対象外なら通知は Actions に任せる');

  // +5 日の枠(9/19)は 23:59 でも対象。ただし実行が 00:01 になると +4 日で、まだ締切前 → 予約してよい
  // 逆に 9/13 23:59 に見つけた 9/17(+4 日、締切後)は上のケース。ここでは「見つけた時は対象、実行時に対象外」を 9/18 で作る:
  // 23:34 に見つけて(対象)、実行が 23:36(締切後)になったケース
  const h2 = harness({ start: jst('2026-09-14', '23:33'), book: async () => { throw new Error('予約してはいけない'); } });
  await h2.runner.tick();
  h2.advance(60_000); // 23:34
  h2.setSlots([slot('猿江恩賜公園', '2026-09-18', '19:00-21:00')]);
  // 行列を塞いでおく(手動予約が実行中の想定)
  h2.queue.submit({ id: 'manual:x', kind: 'manual', run: () => gate.promise });
  const r1 = await h2.runner.tick();
  assert.equal(r1.planned, 1, '見つけた時点(23:34)では対象');
  h2.advance(2 * 60_000); // 23:36 に手動が終わり、自動の番になる
  gate.resolve();
  await flush();
  assert.equal(h2.bookings.length, 0);
  assert.equal(h2.state.attemptStatus('1040|2026-09-18|19:00'), 'skipped_deadline');
  assert.deepEqual(h2.vacancyCards.map((s) => `${s.facility} ${s.date} ${s.time}`), ['猿江恩賜公園 2026-09-18 19:00-21:00'], 'Pi が従来の通知カードを送る');
  assert.equal(h2.notified.length, 0, '結果カードは送らない');
  assert.ok(h2.logs.some((l) => l.includes('予約直前の再判定') && l.includes('従来の空き通知カード')));

  // 日付が変わるケース: 9/14 23:58 に見つけた 9/19(+5 日、対象)を 9/15 00:01 に実行 → +4 日・締切前なので予約する。
  // 9/14 23:58 に見つけた 9/18 は締切後なので上のとおり見送り。日付が変わって +3 日になるのは「9/13 23:59 に見つけた 9/17」:
  const gate3 = deferredGate();
  const h3 = harness({ start: jst('2026-09-13', '23:33') });
  await h3.runner.tick();
  h3.advance(60_000); // 9/13 23:34 → 9/17 は +4 日・締切前で対象
  h3.setSlots([slot('猿江恩賜公園', '2026-09-17', '19:00-21:00')]);
  h3.queue.submit({ id: 'manual:y', kind: 'manual', run: () => gate3.promise });
  assert.equal((await h3.runner.tick()).planned, 1);
  h3.advance(27 * 60_000); // 9/14 00:01
  gate3.resolve();
  await flush();
  assert.equal(h3.bookings.length, 0, '+3 日 = ペナルティ期間なので予約しない');
  assert.equal(h3.state.attemptStatus('1040|2026-09-17|19:00'), 'skipped_penalty');
  assert.equal(h3.vacancyCards.length, 1);
});

test('日付境界: 予約直前の再判定で除外枠になっていたら予約せず、通知もしない', async () => {
  const gate = deferredGate();
  let ex = { dates: [], slots: [] };
  const h = harness({ book: async () => { throw new Error('予約してはいけない'); } });
  // heartbeat の応答を差し替えられるように harness の worker を直接いじる代わりに、tick 前に除外一覧を返す関数を切り替える
  h.runner.stop();
  const logs = [];
  const vac = [];
  const state = createAutoState({ file: tmpFile(), now: () => T0 });
  const queue = createBookingQueue();
  let current = [];
  const runner = createAutoRunner({
    mode: 'on', scrape: async () => current, queue, state,
    worker: { heartbeat: async () => ex, addExcludedSlots: async () => {} },
    book: async () => { throw new Error('予約してはいけない'); },
    credentialsFor: () => ({ userId: 'u', password: 'p', label: 'x' }),
    notifyVacancy: async (s) => vac.push(...s),
    log: (m) => logs.push(m), now: () => T0,
  });
  await runner.tick();
  current = [slot('猿江恩賜公園', '2026-09-25', '19:00-21:00')];
  queue.submit({ id: 'manual:z', kind: 'manual', run: () => gate.promise });
  assert.equal((await runner.tick()).planned, 1);
  // 実行までの間に本人が LINE でその枠をキャンセル → 次の heartbeat で除外枠に
  ex = { dates: [], slots: [{ park: '1040', date: '2026-09-25', start: '19:00' }] };
  current = [];
  await runner.tick();
  gate.resolve();
  await flush();
  assert.equal(state.attemptStatus('1040|2026-09-25|19:00'), 'skipped_excluded_slot');
  assert.equal(vac.length, 0);
  assert.ok(logs.some((l) => l.includes('通知もしない')));
});

function deferredGate() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test('照会の間隔: 前回の開始から 60 秒後に次を始める。照会が 60 秒を超えたら 15 秒だけ空ける', () => {
  assert.equal(nextDelayMs({ startedAt: 0, finishedAt: 20_000, intervalMs: 60_000 }), 40_000);
  assert.equal(nextDelayMs({ startedAt: 0, finishedAt: 100_000, intervalMs: 60_000 }), MIN_GAP_MS);
  assert.equal(nextDelayMs({ startedAt: 0, finishedAt: 50_000, intervalMs: 60_000 }), MIN_GAP_MS, '残り 10 秒でも最低 15 秒');
});

test('毎周期 1 行の要約ログが出る', async () => {
  const h = harness({ slots: [slot('猿江恩賜公園', '2026-09-25', '19:00-21:00')] });
  await h.runner.tick();
  assert.ok(h.logs.some((l) => /照会: 監視対象 1 件\(全体 1 件\)、新規 0 件、所要 \d+ 秒/.test(l)));
});

test('照会間隔(JST): 1 分が基本、12 時台・20〜24 時は 30 秒、7〜9 時・13 時台・15 時台は 2 分、1 時台は 3 分、2〜7 時は 10 分(2026-11-21)', () => {
  assert.equal(pollIntervalAt(jst('2026-09-15', '00:00'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '00:59'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '01:00'), 60_000), 180_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '01:59'), 60_000), 180_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '02:00'), 60_000), 600_000); // 2026-11-01 に 2〜6 時を 10 分(出現 0 件の時間帯)
  assert.equal(pollIntervalAt(jst('2026-09-15', '04:30'), 60_000), 600_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '05:59'), 60_000), 600_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '06:00'), 60_000), 600_000); // 2026-11-17 に 6 時台も 10 分(30 日で出現 0 件)
  assert.equal(pollIntervalAt(jst('2026-09-15', '06:59'), 60_000), 600_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '07:00'), 60_000), 120_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '08:59'), 60_000), 120_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '09:00'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '11:59'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '12:00'), 60_000), 30_000); // 2026-11-21: 12 時台は 30 秒
  assert.equal(pollIntervalAt(jst('2026-09-15', '12:59'), 60_000), 30_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '13:00'), 60_000), 120_000); // 2026-11-17: 13 時台は枠が長持ちするので 2 分
  assert.equal(pollIntervalAt(jst('2026-09-15', '13:59'), 60_000), 120_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '14:00'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '14:59'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '15:00'), 60_000), 120_000); // 15 時台はほぼ出ないので 2 分のまま
  assert.equal(pollIntervalAt(jst('2026-09-15', '15:59'), 60_000), 120_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '16:00'), 60_000), 60_000); // 2026-11-17: 16〜18 時は 2 分 → 1 分(次の照会までに消える枠が多い)
  assert.equal(pollIntervalAt(jst('2026-09-15', '17:59'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '19:59'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '20:00'), 60_000), 30_000); // 2026-11-21: 20〜22 時も 30 秒(押下後の僅差の負けが続いた)
  assert.equal(pollIntervalAt(jst('2026-09-15', '21:59'), 60_000), 30_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '22:00'), 60_000), 30_000); // 2026-11-01: 主戦場の 22〜24 時は 30 秒(下限)
  assert.equal(pollIntervalAt(jst('2026-09-15', '23:59'), 60_000), 30_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '18:00'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '22:00'), 60_000), 30_000); // 2026-11-01 に 22〜24 時は 30 秒
  assert.equal(pollIntervalAt(jst('2026-09-15', '23:59'), 60_000), 30_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '03:00'), 60_000, []), 60_000, '設定が無ければ常に同じ');
  // 2026-11-21: 毎月 22 日の 0 時台だけ 30 秒(翌月分の先着受付が 22 日 0:00 に開く)
  assert.equal(pollIntervalAt(jst('2026-11-21', '23:59'), 60_000), 30_000);
  assert.equal(pollIntervalAt(jst('2026-11-22', '00:00'), 60_000), 30_000);
  assert.equal(pollIntervalAt(jst('2026-11-22', '00:59'), 60_000), 30_000);
  assert.equal(pollIntervalAt(jst('2026-11-22', '01:00'), 60_000), 180_000);
  assert.equal(pollIntervalAt(jst('2026-11-23', '00:00'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-12-22', '00:30'), 60_000), 30_000);
});

test('実枠テスト用: forgetFile に書いた枠キーは既知から外れ、次の周期で「新しく出た」扱いになる(ファイルは消える)', async () => {
  const forget = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-')), 'forget-keys.txt');
  const logs = [];
  const bookings = [];
  let t = T0;
  const runner = createAutoRunner({
    mode: 'on',
    scrape: async () => [slot('大島小松川公園', '2026-09-27', '15:00-17:00'), slot('猿江恩賜公園', '2026-09-25', '19:00-21:00')],
    queue: createBookingQueue(),
    state: createAutoState({ file: tmpFile(), now: () => t }),
    worker: { heartbeat: async () => ({ dates: [], slots: [] }), addExcludedSlots: async () => {} },
    book: async (c, { beforeApply }) => { bookings.push(c.key); await beforeApply({ reservations: [] }); return { status: 'success', reservationNo: 'R1', facility: c.facility }; },
    credentialsFor: () => ({ userId: 'u', password: 'p', label: 'x' }),
    log: (m) => logs.push(m), now: () => t, forgetFile: forget,
  });
  await runner.tick(); // 初回: 2 件を既知に
  assert.deepEqual(runner.lastTargets().length, 2);
  t += 60_000;
  assert.deepEqual(await runner.tick(), { newSlots: 0 });
  fs.writeFileSync(forget, '1160|2026-09-27|15:00\n9999|nope|00:00\n');
  t += 60_000;
  const r = await runner.tick();
  assert.deepEqual(r, { newSlots: 1, planned: 1 });
  await flush();
  assert.deepEqual(bookings, ['1160|2026-09-27|15:00']);
  assert.equal(fs.existsSync(forget), false, '読んだら消す');
  assert.ok(logs.some((l) => l.includes('テスト用に既知から外しました')));
  assert.ok(logs.some((l) => l.includes('9999|nope|00:00') && l.includes('ありません')));
});

test('除外日: 見つけた時点で除外日なら見送り(通知は Actions もしない)。予約直前に除外日になっていても予約せず、カードも送らない', async () => {
  const gate = deferredGate();
  let ex = { dates: [], slots: [] };
  const logs = [];
  const vac = [];
  const state = createAutoState({ file: tmpFile(), now: () => T0 });
  const queue = createBookingQueue();
  let current = [];
  const runner = createAutoRunner({
    mode: 'on', scrape: async () => current, queue, state,
    worker: { heartbeat: async () => ex, addExcludedSlots: async () => {} },
    book: async () => { throw new Error('予約してはいけない'); },
    credentialsFor: () => ({ userId: 'u', password: 'p', label: 'x' }),
    notifyVacancy: async (s) => vac.push(...s),
    log: (m) => logs.push(m), now: () => T0,
  });
  await runner.tick();
  current = [slot('大島小松川公園', '2026-09-27', '09:00-11:00')];
  queue.submit({ id: 'manual:w', kind: 'manual', run: () => gate.promise });
  assert.equal((await runner.tick()).planned, 1);
  ex = { dates: ['2026-09-27'], slots: [] };
  current = [];
  await runner.tick();
  gate.resolve();
  await flush();
  assert.equal(state.attemptStatus('1160|2026-09-27|09:00'), 'skipped_excluded_date');
  assert.equal(vac.length, 0, '除外日はカードも送らない');
  // 見つけた時点で除外日
  current = [slot('大島小松川公園', '2026-09-27', '13:00-15:00')];
  const r = await runner.tick();
  assert.equal(r.planned, 0);
  assert.ok(logs.some((l) => l.includes('13:00') && l.includes('除外日') && l.includes('通知もしない')));
});

test('「その日は上限」の記憶は 60 分で忘れ、次はまた一覧を見て数える(取り消した後に見送り続けない)', async () => {
  const reservations = { A: [{ id: '1', date: '2026-09-27', start: '17:00' }] };
  const h = harness({
    reservations,
    book: async (c, { beforeApply }) => {
      h.bookings.push(c.key);
      const stop = await beforeApply({ reservations: reservations.A });
      if (stop) return stop;
      return { status: 'success', reservationNo: 'R1', facility: c.facility };
    },
  });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('大島小松川公園', '2026-09-27', '09:00-11:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(h.state.attemptStatus('1160|2026-09-27|09:00'), 'capped', '一覧に 1 件あるので見送り');
  // 5 分後に別の枠が出ても、記憶が生きているのでログインせずに見送り
  h.advance(5 * 60_000);
  h.setSlots([slot('大島小松川公園', '2026-09-27', '13:00-15:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(h.bookings.length, 1, 'ログインしていない');
  assert.equal(h.state.attemptStatus('1160|2026-09-27|13:00'), 'capped');
  // 本人が取り消した。60 分を過ぎて出た枠は、記憶を忘れて一覧を見直す → 0 件なので予約する
  reservations.A = [];
  h.advance(DAY_REMAINING_TTL_MS + 60_000);
  h.setSlots([slot('大島小松川公園', '2026-09-27', '15:00-17:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(h.bookings.length, 2, 'また一覧を見た');
  assert.equal(h.state.attemptStatus('1160|2026-09-27|15:00'), 'success');
});

test('ログイン拒否(auth_error): その予約者の自動予約を 6 時間止め、カードは最初の 1 回だけ。カードの公園は名前で出す', async () => {
  let n = 0;
  const h = harness({ book: async () => { n++; return { status: 'auth_error', message: 'ログインが拒否されました' }; } });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-26', '09:00-11:00')]); // 土 → A
  await h.runner.tick();
  await flush();
  assert.equal(n, 1);
  assert.equal(h.notified.length, 1);
  assert.match(JSON.stringify(h.notified[0].m.contents.body), /猿江恩賜公園/, '公園コードではなく名前');
  // 10 分後に別の A の枠 → ログインせず見送り(B の枠は影響なし)
  h.advance(10 * 60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-26', '09:00-11:00'), slot('大島小松川公園', '2026-09-27', '13:00-15:00'), slot('猿江恩賜公園', '2026-09-25', '19:00-21:00')]);
  const r = await h.runner.tick();
  await flush();
  assert.equal(r.planned, 1, 'B(9/25 金)だけ行列へ');
  assert.equal(n, 2, 'B の分だけログインを試した');
  assert.equal(h.notified.length, 2, 'B の auth_error は B としては最初なのでカードあり');
  assert.ok(h.logs.some((l) => l.includes('予約者 A はログインが拒否されたため')));
  // 6 時間過ぎたら A も 1 回だけ試し直す(カードは 6 時間ぶりなので出す)
  h.advance(AUTH_PAUSE_MS);
  h.setSlots([slot('大島小松川公園', '2026-09-27', '13:00-15:00')]);
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('大島小松川公園', '2026-09-27', '13:00-15:00'), slot('亀戸中央公園', '2026-09-27', '15:00-17:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(n, 3);
});

test('LINE の「じどうおふ」: heartbeat の応答 enabled=false で予約を止め(照会は続く)、Worker には mode=paused/active=false を申告。「じどうおん」で再開', async () => {
  let enabled = true;
  const heartbeats = [];
  const logs = [];
  const bookings = [];
  let t = T0;
  let current = [];
  const runner = createAutoRunner({
    mode: 'on',
    scrape: async () => current,
    queue: createBookingQueue(),
    state: createAutoState({ file: tmpFile(), now: () => t }),
    worker: { heartbeat: async (p) => { heartbeats.push(p); return { dates: [], slots: [], enabled }; }, addExcludedSlots: async () => {} },
    book: async (c, { beforeApply }) => { bookings.push(c.key); await beforeApply({ reservations: [] }); return { status: 'success', reservationNo: 'R', facility: c.facility }; },
    credentialsFor: () => ({ userId: 'u', password: 'p', label: 'x' }),
    log: (m) => logs.push(m), now: () => t,
  });
  await runner.tick();
  assert.deepEqual([runner.effectiveMode(), heartbeats.at(-1).mode, heartbeats.at(-1).active], ['on', 'on', true]);
  // OFF にされた
  enabled = false;
  t += 60_000;
  current = [slot('猿江恩賜公園', '2026-09-25', '19:00-21:00')];
  const r = await runner.tick();
  await flush();
  assert.deepEqual(r, { newSlots: 1, planned: 0 });
  assert.equal(bookings.length, 0);
  assert.ok(logs.some((l) => l.includes('じどうおふ')));
  assert.ok(logs.some((l) => l.includes('[LINE で停止中] 予約するはず')));
  assert.equal(runner.effectiveMode(), 'paused');
  t += 60_000;
  await runner.tick();
  assert.deepEqual([heartbeats.at(-1).mode, heartbeats.at(-1).active], ['paused', false], '次の合図から paused を申告');
  // ON に戻す → 次に新しく出た枠から予約する(OFF 中に出ていた枠は既知なので取り直さない)
  enabled = true;
  t += 60_000;
  current = [slot('猿江恩賜公園', '2026-09-25', '19:00-21:00'), slot('猿江恩賜公園', '2026-09-29', '19:00-21:00')];
  const r2 = await runner.tick();
  await flush();
  assert.equal(r2.planned, 1);
  assert.deepEqual(bookings, ['1040|2026-09-29|19:00']);
  assert.equal(runner.effectiveMode(), 'on');
  assert.ok(logs.some((l) => l.includes('じどうおん')));
});

test('LINE の「つうちおふ」: 予約直前に対象外になった枠の空き通知カードを Pi からも送らない(結果カードは別)', async () => {
  const gate = deferredGate();
  const vac = [];
  const logs = [];
  const state = createAutoState({ file: tmpFile(), now: () => T0 });
  const queue = createBookingQueue();
  let current = [];
  let notifyEnabled = true;
  let t = jst('2026-09-14', '23:33');
  const runner = createAutoRunner({
    mode: 'on', scrape: async () => current, queue, state,
    worker: { heartbeat: async () => ({ dates: [], slots: [], enabled: true, notifyEnabled }), addExcludedSlots: async () => {} },
    book: async () => { throw new Error('予約してはいけない'); },
    credentialsFor: () => ({ userId: 'u', password: 'p', label: 'x' }),
    notifyVacancy: async (s) => vac.push(...s),
    log: (m) => logs.push(m), now: () => t,
  });
  await runner.tick();
  t += 60_000; // 23:34
  current = [slot('猿江恩賜公園', '2026-09-18', '19:00-21:00')];
  queue.submit({ id: 'manual:v', kind: 'manual', run: () => gate.promise });
  assert.equal((await runner.tick()).planned, 1);
  notifyEnabled = false;
  current = [];
  t += 60_000;
  await runner.tick(); // つうちおふ を受け取る
  t += 60_000; // 23:36
  gate.resolve();
  await flush();
  assert.equal(vac.length, 0, 'カードを送らない');
  assert.ok(logs.some((l) => l.includes('つうちおふ') && l.includes('送らない')));
  assert.equal(runner.remoteNotify(), false);
});

// ---- 隣接の判定(2026-09-24 追加): 隣の時間帯に別の場所の予定があれば見送る ----
function withTennisbear(h, impl) {
  // harness の worker にテニスベアの取得を配線する(createAutoRunner は worker オブジェクトを参照で持つ)
  h.tbCalls = [];
  h.workerRef.tennisbear = async (person) => {
    h.tbCalls.push(person);
    return impl(person);
  };
  return h;
}
// harness の worker オブジェクトに後から手を入れられるよう、参照を残す
const harnessTb = (opts, impl) => {
  const worker = {};
  const h = harness({ ...opts, workerOverride: worker });
  return withTennisbear(h, impl);
};

test('隣接(テニスベア): 隣の時間帯に別の場所のテニスベアの予定があれば、ログインせず見送り(conflict)。カードは送らない。同じ公園なら予約する', async () => {
  // 9/27(日) A。テニスベアに 11:00-13:00 亀戸中央 の予定がある → 猿江 13:00 は見送り、大島 15:00 は離れているので予約、亀戸 13:00 は同じ公園なので候補になる
  const h = harnessTb({}, async () => ({ configured: true, events: [{ source: 'tennisbear', date: '2026-09-27', start: '11:00', end: '13:00', park: '1050', facility: '亀戸中央公園' }] }));
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-27', '13:00-15:00')]);
  assert.deepEqual(await h.runner.tick(), { newSlots: 1, planned: 1 });
  await flush();
  assert.deepEqual(h.bookings, [], 'ログイン(book)まで行かない');
  assert.equal(h.notified.length, 0, 'カードなし');
  assert.equal(h.state.attemptStatus('1040|2026-09-27|13:00'), 'conflict');
  assert.ok(h.logs.some((l) => l.includes('見送り') && l.includes('直前に別の場所のテニスベアの予定') && l.includes('ログインせず')), h.logs.join('\n'));
  assert.deepEqual(h.tbCalls, ['A']);
  // 同じ公園(亀戸 13:00)なら予約する。10 分以内なのでテニスベアは取り直さない
  h.advance(60_000);
  h.setSlots([slot('亀戸中央公園', '2026-09-27', '13:00-15:00')]);
  await h.runner.tick();
  await flush();
  assert.deepEqual(h.bookings, ['2026-09-27 1050 13 A']);
  assert.equal(h.notified.length, 1, '成功カード');
  assert.deepEqual(h.tbCalls, ['A'], '10 分は使い回す');
  // 10 分を過ぎたら取り直す(9/28(月)の猿江 19 時 → 予約者は B)
  h.advance(TB_PLANS_TTL_MS + 1000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-28', '19:00-21:00')]);
  await h.runner.tick();
  await flush();
  assert.deepEqual(h.tbCalls, ['A', 'B'], '9/28(月)は B');
  assert.equal(h.state.attemptStatus('1040|2026-09-28|19:00'), 'success');
});

test('隣接(テニスベア): 予定が取れなければ見送る(判定できないため予約しない)。直近 60 分以内の結果があればそれで判定する', async () => {
  let fail = true;
  const h = harnessTb({}, async () => {
    if (fail) throw new Error('Worker HTTP 502 /auto/tennisbear');
    return { configured: true, events: [] };
  });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-27', '13:00-15:00')]);
  await h.runner.tick();
  await flush();
  assert.deepEqual(h.bookings, []);
  assert.equal(h.state.attemptStatus('1040|2026-09-27|13:00'), 'skipped_tennisbear');
  assert.ok(h.logs.some((l) => l.includes('テニスベアの予定が取れず')), h.logs.join('\n'));
  // 取れるようになったら予約する
  fail = false;
  h.advance(60_000);
  h.setSlots([]);
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-27', '13:00-15:00')]);
  await h.runner.tick();
  await flush();
  assert.deepEqual(h.bookings, ['2026-09-27 1040 13 A']);
  // その後また失敗しても、60 分以内の結果で判定して予約する(別の日 10/3(土)。9/27 は上限に達している)
  fail = true;
  h.advance(TB_PLANS_TTL_MS + 1000);
  h.setSlots([slot('大島小松川公園', '2026-10-03', '09:00-11:00')]);
  await h.runner.tick();
  await flush();
  assert.ok(h.logs.some((l) => l.includes('分前の結果で判定します')), h.logs.join('\n'));
  assert.equal(h.state.attemptStatus('1160|2026-10-03|09:00'), 'success');
});

test('隣接(テニスベア未設定): configured=false なら都の予約だけで判定し、予約する', async () => {
  const h = harnessTb({}, async () => ({ configured: false, events: [] }));
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-27', '13:00-15:00')]);
  await h.runner.tick();
  await flush();
  assert.deepEqual(h.bookings, ['2026-09-27 1040 13 A']);
  assert.ok(h.logs.some((l) => l.includes('テニスベアは未設定')));
});

test('土日祝は 1 日 2 件まで(2026-11-21): 手元の一覧に 1 件ある土曜はもう 1 件取り、3 件目は見送る。平日は 1 件のまま', async () => {
  assert.equal(HOLIDAY_MAX, 2, '本番の設定は土日祝 2 件');
  AUTO_BOOKING.MAX_PER_DAY_HOLIDAY = HOLIDAY_MAX;
  try {
    // A は 9/26(土) に 猿江 9:00-11:00、B は 9/24(木) に 猿江 17:00-19:00 を持っている
    const reservations = {
      A: [{ id: 'R1', date: '2026-09-26', start: '09:00', end: '11:00', facility: '猿江恩賜公園' }],
      B: [{ id: 'R2', date: '2026-09-24', start: '17:00', end: '19:00', facility: '猿江恩賜公園' }],
    };
    const h = harness({ reservations });
    await h.runner.tick();
    h.advance(60_000);
    h.setSlots([slot('猿江恩賜公園', '2026-09-26', '13:00-15:00')]);
    await h.runner.tick();
    await flush();
    assert.equal(h.state.attemptStatus('1040|2026-09-26|13:00'), 'success', '土曜の 2 件目は取る');
    h.advance(60_000);
    h.setSlots([slot('猿江恩賜公園', '2026-09-26', '17:00-19:00')]);
    await h.runner.tick();
    await flush();
    assert.equal(h.state.attemptStatus('1040|2026-09-26|17:00'), 'capped', '土曜の 3 件目は見送り');
    h.advance(60_000);
    h.setSlots([slot('猿江恩賜公園', '2026-09-24', '19:00-21:00')]);
    await h.runner.tick();
    await flush();
    assert.equal(h.state.attemptStatus('1040|2026-09-24|19:00'), 'capped', '平日は 1 件のまま');
    assert.equal(h.notified.length, 1, '成立カードは 1 通');
  } finally {
    AUTO_BOOKING.MAX_PER_DAY_HOLIDAY = 1;
  }
});

test('隣接(都の予約): 予約直前の一覧に、隣の時間帯の別の公園の予約があれば見送り(conflict)。上限を 2 件にして確認(上限 1 件のうちは capped が先に当たる)', async () => {
  const saved = AUTO_BOOKING.MAX_PER_DAY_HOLIDAY;
  AUTO_BOOKING.MAX_PER_DAY_HOLIDAY = 2;
  try {
    // A は 9/27 に 亀戸 11:00-13:00 を手動で持っている → 猿江 13:00 は見送り(ログインして一覧を見た上で)、猿江 15:00 は 2 時間空くので予約
    const reservations = { A: [{ id: 'R9', date: '2026-09-27', start: '11:00', end: '13:00', facility: '亀戸中央公園' }] };
    const h = harnessTb({ reservations }, async () => ({ configured: true, events: [] }));
    await h.runner.tick();
    h.advance(60_000);
    h.setSlots([slot('猿江恩賜公園', '2026-09-27', '13:00-15:00')]);
    await h.runner.tick();
    await flush();
    assert.equal(h.state.attemptStatus('1040|2026-09-27|13:00'), 'conflict');
    assert.deepEqual(h.bookings, ['2026-09-27 1040 13 A'], '都の予約との隣接は一覧を見ないと分からないのでログインはする');
    h.advance(60_000);
    h.setSlots([slot('猿江恩賜公園', '2026-09-27', '15:00-17:00')]);
    await h.runner.tick();
    await flush();
    assert.equal(h.state.attemptStatus('1040|2026-09-27|15:00'), 'success');
    assert.equal(h.notified.length, 1, '成功カードだけ');
    assert.ok(h.logs.some((l) => l.includes('conflict') && l.includes('直前に別の場所の予約')), h.logs.join('\n'));
    // テニスベアのイベントは上限の件数に数えない: 同じ日に予定が 2 件あっても(離れた時間・同じ公園)予約できる。
    // ただし時間が重なる予定(同じ公園でも)があれば見送り
    const h2 = harnessTb({ reservations: { A: [] } }, async () => ({
      configured: true,
      events: [
        { source: 'tennisbear', date: '2026-09-27', start: '09:00', end: '11:00', park: '1040', facility: '猿江恩賜公園' },
        { source: 'tennisbear', date: '2026-09-27', start: '17:00', end: '19:00', park: '1050', facility: '亀戸中央公園' },
      ],
    }));
    await h2.runner.tick();
    h2.advance(60_000);
    h2.setSlots([slot('猿江恩賜公園', '2026-09-27', '13:00-15:00'), slot('猿江恩賜公園', '2026-09-27', '09:00-11:00')]);
    await h2.runner.tick();
    await flush();
    assert.deepEqual(h2.bookings, ['2026-09-27 1040 13 A']);
    assert.equal(h2.state.attemptStatus('1040|2026-09-27|09:00'), 'conflict', '同じ公園でも時間が重なれば見送り');
    assert.ok(h2.logs.some((l) => l.includes('時間が重なるテニスベアの予定') && l.includes('ログインせず')), h2.logs.join('\n'));
  } finally {
    AUTO_BOOKING.MAX_PER_DAY_HOLIDAY = saved;
  }
});

test('記録(auto-events): 出現・行列へ・結果・消滅・照会失敗が 1 行ずつ残る。消滅には初めて見えた時刻と試行状態が付く', async () => {
  const eventsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')), 'auto-events.jsonl');
  const h = harness({ eventsFile });
  await h.runner.tick(); // 初回(既知の登録。記録なし)
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-25', '19:00-21:00')]);
  await h.runner.tick();
  await flush();
  h.advance(120_000);
  h.setSlots([]); // 消えた(自分が取った)
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots(new Error('fetch failed')); // 照会失敗
  await h.runner.tick();
  const ev = readEvents(eventsFile);
  const types = ev.map((e) => e.type);
  assert.deepEqual(types.slice(0, 3), ['appeared', 'queued', 'result']);
  assert.equal(ev[0].key, '1040|2026-09-25|19:00');
  assert.equal(ev[0].intervalMs, 60_000, '出現時刻(JST 9:00)の照会間隔');
  assert.equal(ev[1].person, 'B');
  assert.equal(ev[2].status, 'success');
  const gone = ev.find((e) => e.type === 'gone');
  assert.ok(gone, '消滅の記録');
  assert.equal(gone.key, '1040|2026-09-25|19:00');
  assert.equal(gone.firstSeenAt, T0 + 60_000);
  assert.equal(gone.attempt, 'success');
  assert.equal(gone.facility, '猿江恩賜公園');
  assert.ok(h.logs.some((l) => l.includes('枠が消えた: 2026-09-25 19:00-21:00 猿江恩賜公園(見えてから 2 分、この枠の試行: success)')));
  assert.equal(ev.at(-1).type, 'poll_failed');
  assert.equal(ev.at(-1).consecutive, 1);
});

test('記録(auto-events): 記録ファイルが無くても動く。見送りは kind 付きで残る', async () => {
  const eventsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')), 'auto-events.jsonl');
  const h = harness({ eventsFile, exclusions: { dates: ['2026-09-30'], slots: [] } });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-30', '19:00-21:00')]);
  await h.runner.tick();
  const ev = readEvents(eventsFile);
  assert.deepEqual(ev.map((e) => e.type), ['appeared', 'skipped']);
  assert.equal(ev[1].kind, 'excluded_date');
  assert.deepEqual(readEvents('/nonexistent/auto-events.jsonl'), []);
});

test('追加枠(2026-10-25): heartbeat の allowSlots にある枠はペナルティ期間でも予約し、成功カードに取消のペナルティの警告が付く。同じ日の別の枠は見送り。解除されたら予約直前の再判定で見送り', async () => {
  // 9/14(月) 10:00。9/16(水)は +2 日 = ペナルティ期間
  const allow = { park: '1040', date: '2026-09-16', start: '19:00', end: '21:00', facility: '猿江恩賜公園' };
  const h = harness({ exclusions: { dates: [], slots: [], allowSlots: [allow] } });
  await h.runner.tick();
  assert.ok(h.logs.some((l) => l.includes('追加枠 1 件')));
  h.advance(60_000);
  // 平日の監視対象は猿江 19:00 だけなので、同じ日の別の枠の見送りは 9/15 19:00(追加していない枠)で見る
  h.setSlots([slot('猿江恩賜公園', '2026-09-16', '19:00-21:00'), slot('猿江恩賜公園', '2026-09-15', '19:00-21:00')]);
  const r = await h.runner.tick();
  assert.equal(r.planned, 1, '9/16 19:00 だけ予約し、9/15 は従来どおり見送り');
  await flush();
  assert.deepEqual(h.bookings, ['2026-09-16 1040 19 B']);
  assert.ok(h.logs.some((l) => l.includes('2026-09-15') && l.includes('ペナルティ期間')));
  assert.equal(h.notified.length, 1);
  const card = JSON.stringify(h.notified[0].m);
  assert.match(card, /取り消すとペナルティ 1 点が付きます/);
  assert.equal(card.includes('"type":"postback"'), false, '+4 日の枠ではないのでキャンセルボタンは無い');

  // allowSlots が無い(古い Worker)応答でも落ちない
  let ex = { dates: [], slots: [] };
  const h2 = harness({ workerOverride: {} });
  h2.workerRef.heartbeat = async () => ex;
  await h2.runner.tick();
  h2.advance(60_000);
  // 行列で待っている間に本人が「解除」→ 次の heartbeat で allowSlots から消える → 予約直前の再判定で見送り(従来の空き通知カード)
  ex = { dates: [], slots: [], allowSlots: [allow] };
  const gate = deferredGate();
  h2.queue.submit({ id: 'manual:x', kind: 'manual', run: () => gate.promise });
  h2.setSlots([slot('猿江恩賜公園', '2026-09-16', '19:00-21:00')]);
  assert.equal((await h2.runner.tick()).planned, 1);
  ex = { dates: [], slots: [], allowSlots: [] };
  h2.advance(60_000);
  h2.setSlots([slot('猿江恩賜公園', '2026-09-16', '19:00-21:00')]);
  await h2.runner.tick(); // heartbeat で解除を受け取る
  gate.resolve();
  await flush();
  assert.equal(h2.bookings.length, 0);
  assert.equal(h2.state.attemptStatus('1040|2026-09-16|19:00'), 'skipped_penalty');
  assert.equal(h2.vacancyCards.length, 1, '従来の空き通知カードを送る');
});

test('追加枠(2026-11-03): 場所と時間を本人が指定した枠なので、その日に既に予約があっても(1 日 1 件の上限)、接する別の公園の予約・テニスベアの予定があっても予約する。テニスベアは見に行かない。時間が重なる都の予約だけは見送る', async () => {
  // 9/14(月) 10:00。9/16(水) B は 亀戸 11:00-13:00 を手動で持っている(上限 1 件に達している・猿江 13:00 とは接する別の公園)
  const reservations = { B: [{ id: 'R9', date: '2026-09-16', start: '11:00', end: '13:00', facility: '亀戸中央公園' }] };
  const allow = { park: '1040', date: '2026-09-16', start: '13:00', end: '15:00', facility: '猿江恩賜公園' };
  const h = harnessTb({ reservations, exclusions: { dates: [], slots: [], allowSlots: [allow] } }, async () => ({ configured: true, events: [{ source: 'tennisbear', date: '2026-09-16', start: '15:00', end: '17:00', park: '1160', facility: '大島小松川公園' }] }));
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-16', '13:00-15:00')]);
  assert.equal((await h.runner.tick()).planned, 1);
  await flush();
  assert.deepEqual(h.bookings, ['2026-09-16 1040 13 B']);
  assert.equal(h.state.attemptStatus('1040|2026-09-16|13:00'), 'success', '上限・隣接の判定を掛けずに取る');
  assert.deepEqual(h.tbCalls, [], 'テニスベアの予定は見に行かない');
  assert.ok(h.logs.some((l) => l.includes('追加枠なので 1 日の上限・場所の判定は掛けません')), h.logs.join('\n'));
  // 同じ日の普段の枠(猿江 19:00)は従来どおり上限で見送り(成立分を数えて 2 件)
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-16', '13:00-15:00'), slot('猿江恩賜公園', '2026-09-20', '19:00-21:00')]);
  // 9/20(日)は +6 日で普段の対象。A はその日に予約なし → 普段どおり取れる(追加枠の例外が他の日に漏れていない)
  assert.equal((await h.runner.tick()).planned, 1);
  await flush();
  assert.deepEqual(h.bookings, ['2026-09-16 1040 13 B', '2026-09-20 1040 19 A']);

  // 時間が重なる都の予約(B が 9/16 13:00-15:00 を手で取っていた)があれば、追加枠でも見送り(conflict)
  const reservations2 = { B: [{ id: 'R1', date: '2026-09-16', start: '13:00', end: '15:00', facility: '大島小松川公園' }] };
  const h2 = harnessTb({ reservations: reservations2, exclusions: { dates: [], slots: [], allowSlots: [allow] } }, async () => ({ configured: true, events: [] }));
  await h2.runner.tick();
  h2.advance(60_000);
  h2.setSlots([slot('猿江恩賜公園', '2026-09-16', '13:00-15:00')]);
  assert.equal((await h2.runner.tick()).planned, 1);
  await flush();
  assert.equal(h2.state.attemptStatus('1040|2026-09-16|13:00'), 'conflict');
  assert.ok(h2.logs.some((l) => l.includes('時間が重なる予約')), h2.logs.join('\n'));
});

test('追加枠(2026-10-25): 平日の監視対象外の枠(大島 17:00)も追加してあれば見て予約する。追加した時点で既に空いていた枠も、次の照会で取りに行く', async () => {
  // 9/14(月) 10:00。9/15(火)・9/16(水)は平日なので普段の監視対象は猿江 19:00 だけ(どちらもペナルティ期間)
  const allowOoshima = { park: '1160', date: '2026-09-16', start: '17:00', end: '19:00', facility: '大島小松川公園' };
  // 同じ日時の猿江 17:00 と、同じ日の別の時間帯の猿江 9:00 も追加してある(取れたらどちらも消える。2026-11-03: 同じ日は 1 件取れたら残りの追加枠を全部消す)
  const allowSarue = { park: '1040', date: '2026-09-16', start: '17:00', end: '19:00', facility: '猿江恩賜公園' };
  const allowSarue9 = { park: '1040', date: '2026-09-16', start: '09:00', end: '11:00', facility: '猿江恩賜公園' };
  let ex = { dates: [], slots: [], allowSlots: [allowOoshima, allowSarue, allowSarue9] };
  const h = harness({ workerOverride: {} });
  h.workerRef.heartbeat = async () => ex;
  // 猿江 9/15 19:00 は監視対象で、最初から空いている(初回で既知になる)
  h.setSlots([slot('大島小松川公園', '2026-09-16', '17:00-19:00'), slot('亀戸中央公園', '2026-09-16', '17:00-19:00'), slot('猿江恩賜公園', '2026-09-15', '19:00-21:00')]);
  await h.runner.tick(); // 初回(既知の登録)。この時点で heartbeat が allowSlots を持ってくる
  h.advance(60_000);
  const r = await h.runner.tick();
  assert.equal(r.planned, 1, '追加した大島 17:00 は平日でも監視対象になり予約する。亀戸 17:00 は監視対象外、猿江 9/15 19:00 は既知でペナルティ期間');
  await flush();
  assert.deepEqual(h.bookings, ['2026-09-16 1160 17 B']);
  // 取れたら、同じ日の追加枠(猿江 17:00・猿江 9:00 と取れた大島 17:00 自身)を Worker に消してもらう(日だけ渡す)
  assert.deepEqual(h.dropped, [{ date: '2026-09-16' }]);
  assert.ok(h.logs.some((l) => l.includes('同じ日の追加枠を全部消します: 17:00 大島小松川公園・17:00 猿江恩賜公園・09:00 猿江恩賜公園 (2026-09-16)')), h.logs.join('\n'));
  assert.deepEqual(h.runner.exclusions().allowSlots, [], '手元の写しからも消える');

  // 運用中に「せってい」で猿江 9/15 19:00 を追加 → 既に空いていて既知だが、次の照会で「新しい空き」として予約しに行く
  // (2026-11-21: 合図は照会と同時に投げるので、追加を受け取ったその回に動く。以前は 1 周期あとだった)
  ex = { dates: [], slots: [], allowSlots: [allowOoshima, { park: '1040', date: '2026-09-15', start: '19:00', end: '21:00', facility: '猿江恩賜公園' }] };
  h.advance(60_000);
  const r2 = await h.runner.tick();
  assert.equal(r2.planned, 1);
  await flush();
  assert.ok(h.logs.some((l) => l.includes('新しい空きとして扱います: 1040|2026-09-15|19:00')));
  assert.deepEqual(h.bookings, ['2026-09-16 1160 17 B', '2026-09-15 1040 19 B']);

  // 全部解除したら、平日の大島・亀戸 17:00 は監視対象外に戻る(猿江 19:00 は監視対象のまま既知)
  ex = { dates: [], slots: [], allowSlots: [] };
  h.advance(60_000);
  await h.runner.tick();
  h.advance(60_000);
  const r3 = await h.runner.tick();
  assert.equal(r3.newSlots, 0);
  assert.deepEqual(h.runner.lastTargets().map((s) => `${s.facility} ${s.date} ${s.time}`), ['猿江恩賜公園 2026-09-15 19:00-21:00']);

  // 状態ファイルが無い初回起動(既知の登録だけの回)で追加枠を受け取っても、印は消えず次の照会で取りに行く
  const h3 = harness({ workerOverride: {}, exclusions: { dates: [], slots: [], allowSlots: [{ park: '1040', date: '2026-09-15', start: '19:00', end: '21:00', facility: '猿江恩賜公園' }] } });
  h3.setSlots([slot('猿江恩賜公園', '2026-09-15', '19:00-21:00')]);
  await h3.runner.tick(); // 初回: 猿江 19:00 は既知になる(この回は予約しない)
  h3.advance(60_000);
  assert.equal((await h3.runner.tick()).planned, 1, '既知だが追加枠なので新しい空きとして予約する');
  await flush();
  assert.deepEqual(h3.bookings, ['2026-09-15 1040 19 B']);
});

test('stillVacant(2026-11-01): book に渡す関数は、直近の照会にその枠がまだあれば true、消えていれば false。照会が失敗した回は直前の結果のまま', async () => {
  let probe = null;
  const h = harness({ book: async (c, { stillVacant }) => { probe = stillVacant; return { status: 'taken', message: 'x' }; } });
  await h.runner.tick(); // 初回(既知の登録)
  h.advance(60_000);
  const ooshima = slot('大島小松川公園', '2026-09-27', '09:00-11:00'); // 日 → A
  h.setSlots([ooshima]);
  assert.equal((await h.runner.tick()).planned, 1);
  await flush();
  assert.equal(typeof probe, 'function');
  assert.equal(probe(), true, '直近の照会にある');
  h.advance(60_000);
  h.setSlots([]);
  await h.runner.tick();
  assert.equal(probe(), false, '照会で消えた');
  h.advance(60_000);
  h.setSlots([ooshima]);
  await h.runner.tick();
  assert.equal(probe(), true, 'また見えたら true(taken の枠は再投入されないが判定は照会どおり)');
  h.advance(60_000);
  h.setSlots(new Error('offline'));
  await h.runner.tick().catch(() => {});
  assert.equal(probe(), true, '照会の失敗では「消えた」と判断しない');
});

test('候補には空き照会の面数(count)が付いて book に渡る(2026-11-01: server.mjs が vacant として高速経路に渡し、週データの再確認を飛ばす)', async () => {
  const seen = [];
  const h = harness({ book: async (c) => { seen.push(c.count); return { status: 'taken', message: 'x' }; } });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('大島小松川公園', '2026-09-27', '09:00-11:00', 3)]);
  await h.runner.tick();
  await flush();
  assert.deepEqual(seen, [3]);
});

test('再挑戦(2026-11-06): 一時エラー(error)で終わった枠が 5 分後もまだ空いていれば再挑戦する。再挑戦は 2 回まで。taken は再挑戦しない', async () => {
  const results = [];
  const h = harness({
    book: async (c, { beforeApply }) => {
      const stop = await beforeApply({ reservations: [] });
      if (stop) return stop;
      results.push(`${c.date} ${c.startHour}`);
      return c.date === '2026-09-25' ? { status: 'taken', message: '先に取られた' } : { status: 'error', message: 'タイムアウト' };
    },
  });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-29', '19:00-21:00'), slot('猿江恩賜公園', '2026-09-25', '19:00-21:00')]); // 火=B error / 金=B taken
  await h.runner.tick();
  await flush();
  // error の枠は、その場のやり直し(2026-11-08)で毎回 2 回呼ばれる
  assert.deepEqual(results, ['2026-09-25 19', '2026-09-29 19', '2026-09-29 19']);
  assert.equal(h.state.attemptStatus('1040|2026-09-29|19:00'), 'error');
  assert.equal(h.state.attemptInfo('1040|2026-09-29|19:00').errors, 1);
  // 4 分後: まだ再挑戦しない
  h.advance(4 * 60_000);
  await h.runner.tick();
  await flush();
  assert.equal(results.length, 3, '5 分経つまでは再挑戦しない');
  // 5 分後: 1 回目の再挑戦(taken の枠は再挑戦しない)
  h.advance(60_000);
  await h.runner.tick();
  await flush();
  assert.deepEqual(results, ['2026-09-25 19', '2026-09-29 19', '2026-09-29 19', '2026-09-29 19', '2026-09-29 19']);
  assert.ok(h.logs.some((l) => l.includes('再挑戦: 2026-09-29 19:00-21:00 猿江恩賜公園') && l.includes('5 分前')), h.logs.filter((l) => l.includes('再挑戦')).join('\n'));
  assert.ok(h.logs.some((l) => l.includes('再挑戦 1 件')), '要約ログに再挑戦の件数が出る');
  assert.equal(h.state.attemptInfo('1040|2026-09-29|19:00').errors, 2);
  // さらに 5 分後: 2 回目の再挑戦
  h.advance(5 * 60_000);
  await h.runner.tick();
  await flush();
  assert.equal(results.length, 7);
  assert.equal(h.state.attemptInfo('1040|2026-09-29|19:00').errors, 3);
  // さらに 5 分後: もう再挑戦しない
  h.advance(5 * 60_000);
  await h.runner.tick();
  await flush();
  assert.equal(results.length, 7, '再挑戦は 2 回まで');
  assert.ok(!h.logs.some((l) => l.includes('結果カード') && l.includes('自動予約の結果カード')), 'error のカードは送らない');
});

test('再挑戦(2026-11-06): 一時エラーの後、枠が消えてまた現れたときは「新しく出た」として扱い、二重に候補にしない', async () => {
  let n = 0;
  const h = harness({
    book: async (c, { beforeApply }) => {
      const stop = await beforeApply({ reservations: [] });
      if (stop) return stop;
      n++;
      return n === 1 ? { status: 'error', message: 'タイムアウト' } : { status: 'success', reservationNo: 'R1', facility: c.facility };
    },
  });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-29', '19:00-21:00')]);
  await h.runner.tick();
  await flush();
  h.advance(60_000);
  h.setSlots([]);
  await h.runner.tick();
  h.advance(10 * 60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-29', '19:00-21:00')]);
  const r = await h.runner.tick();
  await flush();
  assert.equal(r.newSlots, 1);
  assert.equal(n, 2);
  assert.equal(h.state.attemptStatus('1040|2026-09-29|19:00'), 'success');
});

test('都サイトの「お知らせ」ページ(siteNotice)は 2 回目まで通常の間隔で見直し、3 回目以降も 3 分より長くは空けない。成功で戻す(2026-11-11)', async () => {
  let fail = true;
  const logs = [];
  const runner = createAutoRunner({
    mode: 'on',
    scrape: async () => {
      if (!fail) return [];
      const e = new Error('猿江恩賜公園 の取得に失敗: 都サイトがメンテナンス・障害中(「施設予約システムからのお知らせ」ページが返った): トップページ');
      e.siteNotice = true;
      throw e;
    },
    queue: createBookingQueue(),
    state: createAutoState({ file: tmpFile() }),
    worker: { heartbeat: async () => ({ dates: [], slots: [] }), addExcludedSlots: async () => {} },
    book: async () => ({}),
    credentialsFor: () => null,
    log: (m) => logs.push(m),
  });
  const failLine = () => logs.filter((m) => m.includes('空き照会に失敗')).at(-1) || '';
  assert.deepEqual(await runner.tick(), { skipped: 'scrape_failed', consecutiveFailures: 1 });
  assert.ok(!failLine().includes('次の照会まで'), failLine());
  assert.equal(runner.backoffMs(60000), 60000, '1 回目は通常の間隔');
  assert.deepEqual(await runner.tick(), { skipped: 'scrape_failed', consecutiveFailures: 2 });
  assert.equal(runner.backoffMs(60000), 60000, '2 回目も通常の間隔');
  assert.deepEqual(await runner.tick(), { skipped: 'scrape_failed', consecutiveFailures: 3 });
  assert.ok(failLine().includes('次の照会まで 3 分空けます(都サイトの「お知らせ」が続いているため'), failLine());
  assert.equal(runner.backoffMs(60000), 3 * 60000);
  for (let i = 0; i < 5; i++) await runner.tick();
  assert.equal(runner.consecutiveFailures(), 8);
  assert.ok(failLine().includes('次の照会まで 3 分空けます'), failLine());
  assert.equal(runner.backoffMs(60000), 3 * 60000, '何回続いても 3 分まで');
  assert.equal(runner.backoffMs(3 * 60000), 3 * 60000);
  fail = false;
  await runner.tick();
  assert.equal(runner.consecutiveFailures(), 0);
  assert.ok(logs.some((m) => m.includes('空き照会が回復しました')), logs.join('\n'));
});

test('即やり直し(2026-11-08): 一時エラー(error)で終わった直後、枠がまだ空いていれば待たずにもう一度予約する(1 回)。2 回目が成功なら success', async () => {
  const eventsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')), 'auto-events.jsonl');
  const calls = [];
  const h = harness({
    eventsFile,
    book: async (c, { beforeApply }) => {
      const stop = await beforeApply({ reservations: [] });
      if (stop) return stop;
      calls.push(`${c.date} ${c.startHour}`);
      return calls.length === 1 ? { status: 'error', message: 'タイムアウト', elapsedMs: 90_000 } : { status: 'success', reservationNo: 'R9', facility: c.facility, elapsedMs: 30_000 };
    },
  });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-29', '19:00-21:00')]);
  await h.runner.tick();
  await flush();
  assert.deepEqual(calls, ['2026-09-29 19', '2026-09-29 19'], 'error の直後にその場でもう一度');
  assert.equal(h.state.attemptStatus('1040|2026-09-29|19:00'), 'success');
  assert.equal(h.state.attemptInfo('1040|2026-09-29|19:00').errors, 0, '最終結果が success なら error の回数は増えない');
  assert.ok(h.logs.some((l) => l.includes('一時エラーのためその場でもう一度予約します(1/1 回目)') && l.includes('タイムアウト')), h.logs.join('\n'));
  const ev = readEvents(eventsFile);
  const retry = ev.find((e) => e.type === 'retry_now');
  assert.ok(retry && retry.key === '1040|2026-09-29|19:00' && retry.firstError === 'タイムアウト', JSON.stringify(ev));
  const res = ev.filter((e) => e.type === 'result' && e.key === '1040|2026-09-29|19:00');
  assert.equal(res.length, 1, '記録に残る result は最終結果の 1 件だけ');
  assert.equal(res[0].status, 'success');
  assert.equal(res[0].diag.retryNow, 1);
  assert.equal(res[0].diag.firstError, 'タイムアウト');
  assert.equal(h.notified.filter((n) => n.what === '自動予約の成立カード').length, 1, '成立カードは 1 通');
});

test('即やり直し(2026-11-08): 2 回とも error なら error で終わり(その場のやり直しは 1 回だけ)、5 分後の再挑戦はこれまでどおり動く', async () => {
  const calls = [];
  const h = harness({
    book: async (c, { beforeApply }) => {
      const stop = await beforeApply({ reservations: [] });
      if (stop) return stop;
      calls.push(`${c.date} ${c.startHour}`);
      return { status: 'error', message: 'データ通信エラー' };
    },
  });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-29', '19:00-21:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(calls.length, 2, 'その場のやり直しは 1 回だけ');
  assert.equal(h.state.attemptStatus('1040|2026-09-29|19:00'), 'error');
  assert.equal(h.state.attemptInfo('1040|2026-09-29|19:00').errors, 1, 'その場のやり直しを含めて 1 回の error と数える');
  assert.ok(!h.notified.some((n) => n.what === '自動予約の結果カード'), 'error のカードは送らない');
  // 5 分後の再挑戦(こちらもその場のやり直し付きなので 2 回呼ばれる)
  h.advance(5 * 60_000);
  await h.runner.tick();
  await flush();
  assert.equal(calls.length, 4, '5 分後に再挑戦し、その中でもその場のやり直しを 1 回する');
  assert.equal(h.state.attemptInfo('1040|2026-09-29|19:00').errors, 2);
});

test('即やり直し(2026-11-08): error の後の空き照会で枠が消えていれば、その場ではやり直さない', async () => {
  const calls = [];
  let h;
  h = harness({
    book: async (c, { beforeApply }) => {
      const stop = await beforeApply({ reservations: [] });
      if (stop) return stop;
      calls.push(`${c.date} ${c.startHour}`);
      // 予約の最中に行われた照会で枠が消えた
      h.setSlots([]);
      h.advance(60_000);
      await h.runner.tick();
      return { status: 'error', message: 'タイムアウト' };
    },
  });
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-29', '19:00-21:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(calls.length, 1, '枠が消えていればやり直さない');
  assert.ok(h.logs.some((l) => l.includes('その後の空き照会で枠が消えているためその場ではやり直しません')), h.logs.join('\n'));
  assert.equal(h.state.attemptStatus('1040|2026-09-29|19:00'), 'error');
});

// 一部の 公園×週 だけ取れなかった照会(lib/scrape.js が failures を添えて返す)を模す
const partial = (slots, failures) => Object.assign([...slots], { failures: failures.map(([name, code, week, message]) => ({ park: { name, code }, week, error: new Error(message) })) });

test('照会の部分採用(2026-11-08): 一部の公園×週が取れなかったら、その分は前回の結果で補い、枠が「消えた」ことにしない。取れた公園の新しい空きは普通に予約する', async () => {
  const eventsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')), 'auto-events.jsonl');
  const h = harness({ eventsFile, slots: [slot('亀戸中央公園', '2026-09-20', '09:00-11:00'), slot('猿江恩賜公園', '2026-09-29', '19:00-21:00')] });
  await h.runner.tick(); // 初回(既知の登録)
  h.advance(60_000);
  // 亀戸の 1 週目(9/14〜9/20)が 502。猿江は取れていて、新しい空きが 1 つ
  h.setSlots(partial([slot('猿江恩賜公園', '2026-09-29', '19:00-21:00'), slot('猿江恩賜公園', '2026-09-30', '19:00-21:00')], [['亀戸中央公園', '1050', 0, '亀戸中央公園 の取得に失敗: HTTP 502: /web/index.jsp']]));
  const r = await h.runner.tick();
  await flush();
  assert.equal(r.skipped, undefined, '照会の失敗(スキップ)にはしない');
  assert.ok(h.logs.some((l) => l.includes('空き照会の一部が取れず、前回の結果で補いました: 亀戸中央公園 1 週目(亀戸中央公園 の取得に失敗: HTTP 502')), h.logs.join('\n'));
  assert.ok(!h.logs.some((l) => l.includes('枠が消えた') && l.includes('亀戸中央公園')), '取れなかった公園の枠を「消えた」にしない');
  assert.ok(h.logs.some((l) => l.includes('照会: 監視対象 3 件(全体 3 件)')), '補った分を含めて数える: ' + h.logs.filter((l) => l.includes('照会:')).join('\n'));
  assert.deepEqual(h.bookings, ['2026-09-30 1040 19 B'], '取れた公園の新しい空きは予約する');
  const ev = readEvents(eventsFile);
  const pp = ev.find((e) => e.type === 'poll_partial');
  assert.deepEqual(pp.failures, [{ park: '亀戸中央公園', week: 0, message: '亀戸中央公園 の取得に失敗: HTTP 502: /web/index.jsp' }]);
  assert.ok(!ev.some((e) => e.type === 'poll_failed'));
  // 次の照会で亀戸も取れた(空きは変わらず)→ 新規なし・消えたなし
  h.advance(60_000);
  h.setSlots([slot('亀戸中央公園', '2026-09-20', '09:00-11:00'), slot('猿江恩賜公園', '2026-09-29', '19:00-21:00'), slot('猿江恩賜公園', '2026-09-30', '19:00-21:00')]);
  await h.runner.tick();
  await flush();
  assert.ok(!h.logs.some((l) => l.includes('新しい空き') && l.includes('亀戸')), '補っていた枠が戻っても「新しい空き」にしない');
  assert.equal(h.bookings.length, 1);
});

test('照会の部分採用(2026-11-08): 同じ公園が 10 分より長く取れないままなら、補わずに従来どおり照会の失敗(スキップ)にする。一度も取れていない公園も同じ', async () => {
  const h = harness({ slots: [slot('亀戸中央公園', '2026-09-20', '09:00-11:00'), slot('猿江恩賜公園', '2026-09-29', '19:00-21:00')] });
  await h.runner.tick();
  const failing = partial([slot('猿江恩賜公園', '2026-09-29', '19:00-21:00')], [['亀戸中央公園', '1050', 0, '亀戸中央公園 の取得に失敗: HTTP 502: /web/index.jsp']]);
  h.setSlots(failing);
  h.advance(PARTIAL_CARRY_MAX_MS); // ちょうど 10 分: まだ補う
  let r = await h.runner.tick();
  assert.equal(r.skipped, undefined);
  h.advance(60_000); // 11 分: もう補わない
  r = await h.runner.tick();
  assert.equal(r.skipped, 'scrape_failed');
  assert.equal(r.consecutiveFailures, 1);
  assert.ok(h.logs.some((l) => l.includes('空き照会に失敗(今回はスキップ。連続 1 回)') && l.includes('最後に取れたのが 11 分前')), h.logs.filter((l) => l.includes('空き照会')).join('\n'));
  // 一度も取れていない公園(初回から失敗)は補えない
  const h2 = harness({ slots: failing });
  r = await h2.runner.tick();
  assert.equal(r.skipped, 'scrape_failed');
  assert.ok(h2.logs.some((l) => l.includes('まだ一度も取れていない')), h2.logs.join('\n'));
});

test('照会の部分採用(2026-11-08): 一覧 JSON の方式(failures の week が null)なら、その公園の全部の枠を前回の結果で補う', async () => {
  const h = harness({ slots: [slot('亀戸中央公園', '2026-09-20', '09:00-11:00'), slot('亀戸中央公園', '2026-10-04', '09:00-11:00'), slot('猿江恩賜公園', '2026-09-29', '19:00-21:00')] }); // 10/4 は日曜(監視対象)
  await h.runner.tick();
  h.advance(60_000);
  h.setSlots(partial([slot('猿江恩賜公園', '2026-09-29', '19:00-21:00')], [['亀戸中央公園', '1050', null, '亀戸中央公園 の取得に失敗: HTTP 502: /web/index.jsp']]));
  const r = await h.runner.tick();
  await flush();
  assert.equal(r.skipped, undefined);
  assert.ok(h.logs.some((l) => l.includes('空き照会の一部が取れず、前回の結果で補いました: 亀戸中央公園(亀戸中央公園 の取得に失敗')), h.logs.join('\n'));
  assert.ok(!h.logs.some((l) => l.includes('枠が消えた')), '亀戸の 2 枠(別の週)とも消えた扱いにしない: ' + h.logs.filter((l) => l.includes('枠が消えた')).join('\n'));
  assert.ok(h.logs.some((l) => l.includes('照会: 監視対象 3 件(全体 3 件)')), h.logs.filter((l) => l.includes('照会:')).join('\n'));
});

// ---- 手元の予約一覧(2026-11-19): 1 時間ごとに Worker の /auto/plans で取り直し、既に予約のある日はログインせずに見送る ----
const sitePlan = (person, date, start, park = '1060') => ({ person, label: person, source: 'site', date, start, end: '', park, facility: '' });

test('手元の予約一覧(2026-11-19): 一覧にその日の予約があれば、ログインせずに見送る(capped)。予約の無い日は従来どおりログインして予約する。テニスベアの予定は数えない', async () => {
  let calls = 0;
  const h = harness({
    reservations: { A: [{ id: '1', date: '2026-09-27', start: '17:00', end: '19:00', facility: '木場公園' }] }, // サイトの本物も同じ内容
    workerOverride: {
      plans: async () => {
        calls++;
        return { plans: [sitePlan('A', '2026-09-27', '17:00'), { person: 'A', source: 'tennisbear', date: '2026-09-26', start: '09:00', end: '11:00', park: null }, sitePlan('B', '2026-09-26', '19:00')], failed: [] };
      },
    },
  });
  await h.runner.tick();
  await flush();
  assert.equal(calls, 1, '最初の照会で取りに行く');
  assert.ok(h.logs.some((l) => l.includes('手元の予約一覧を更新: A 1 件・B 1 件')), h.logs.join('\n'));
  h.advance(60_000);
  h.setSlots([slot('大島小松川公園', '2026-09-27', '09:00-11:00'), slot('猿江恩賜公園', '2026-09-26', '13:00-15:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(calls, 1, '1 時間たつまでは取り直さない');
  assert.equal(h.state.attemptStatus('1160|2026-09-27|09:00'), 'capped');
  assert.ok(h.logs.some((l) => l.includes('見送り: 2026-09-27') && l.includes('手元の予約一覧(1 分前)で判定。ログインせず')), h.logs.join('\n'));
  assert.deepEqual(h.bookings, ['2026-09-26 1040 13 A'], '9/27 はログインしていない。9/26 は A の都の予約が無い(テニスベアと B の予約は数えない)ので予約する');
  assert.equal(h.state.attemptStatus('1040|2026-09-26|13:00'), 'success');
  // 1 時間後の照会で取り直す
  h.advance(SITE_LIST_REFRESH_MS);
  await h.runner.tick();
  await flush();
  assert.equal(calls, 2);
});

test('手元の予約一覧(2026-11-19): 自動予約が成立したらその場で一覧に足す。取りに行っている間に成立した分は、取り直しの結果に無くても残す', async () => {
  let release = null;
  let calls = 0;
  const h = harness({
    workerOverride: {
      plans: () => {
        calls++;
        if (calls === 1) return Promise.resolve({ plans: [], failed: [] });
        return new Promise((r) => (release = () => r({ plans: [], failed: [] }))); // 2 回目は成立前の一覧(空)を、成立の後に返す
      },
    },
  });
  await h.runner.tick();
  await flush();
  // 1 時間後: 取り直しが始まる(まだ返らない)。同じ照会で出た枠が成立する
  h.advance(SITE_LIST_REFRESH_MS);
  h.setSlots([slot('大島小松川公園', '2026-09-27', '09:00-11:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(calls, 2);
  // 取り直し中の照会で枠が出て成立(取り直しはまだ返っていない)
  h.advance(60_000);
  h.setSlots([slot('大島小松川公園', '2026-09-27', '09:00-11:00'), slot('猿江恩賜公園', '2026-09-26', '13:00-15:00')]);
  assert.equal(h.state.attemptStatus('1160|2026-09-27|09:00'), 'success');
  await h.runner.tick();
  await flush();
  assert.equal(h.state.attemptStatus('1040|2026-09-26|13:00'), 'success');
  release();
  await flush();
  const list = h.runner.siteList();
  assert.deepEqual(list.byPerson.A.map((r) => `${r.date} ${r.start}`).sort(), ['2026-09-26 13:00', '2026-09-27 09:00'], '取り直しを始めた後に成立した 2 件は、Worker の一覧(成立前のもの。空)に無くても残る');
  // 「その日は上限」の記憶(60 分)が切れた後でも、手元の一覧で 9/26 はログインせずに見送る
  h.advance(DAY_REMAINING_TTL_MS - 5 * 60_000);
  h.runner.dayRemaining.clear();
  h.setSlots([slot('大島小松川公園', '2026-09-27', '09:00-11:00'), slot('猿江恩賜公園', '2026-09-26', '13:00-15:00'), slot('猿江恩賜公園', '2026-09-26', '15:00-17:00')]);
  const before = h.bookings.length;
  await h.runner.tick();
  await flush();
  assert.equal(h.bookings.length, before, 'ログインしていない');
  assert.equal(h.state.attemptStatus('1040|2026-09-26|15:00'), 'capped');
});

test('手元の予約一覧(2026-11-19): 取れなければ従来どおりログインして数え、10 分後にもう一度取る。1 人分でも都の予約が取れていなければ使わない。古い一覧(80 分超)も使わない', async () => {
  let calls = 0;
  let answer = () => ({ plans: [sitePlan('A', '2026-09-27', '17:00')], failed: ['nameB(都の予約)'] });
  const reservations = { A: [{ id: '1', date: '2026-09-27', start: '17:00' }] };
  const h = harness({
    reservations,
    workerOverride: {
      plans: async () => {
        calls++;
        return answer();
      },
    },
  });
  await h.runner.tick();
  await flush();
  assert.equal(h.runner.siteList(), null);
  assert.ok(h.logs.some((l) => l.includes('手元の予約一覧を更新できませんでした(取れなかった分: nameB(都の予約))')), h.logs.join('\n'));
  h.advance(60_000);
  h.setSlots([slot('大島小松川公園', '2026-09-27', '09:00-11:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(calls, 1);
  assert.equal(h.bookings.length, 1, '一覧が無いのでログインして数えた');
  assert.equal(h.state.attemptStatus('1160|2026-09-27|09:00'), 'capped');
  // 10 分後にもう一度。今度は取れる(テニスベアだけ取れなかったのは構わない)
  answer = () => ({ plans: [sitePlan('A', '2026-09-27', '17:00')], failed: ['nameA(テニスベアの予定)'] });
  h.advance(SITE_LIST_RETRY_MS);
  await h.runner.tick();
  await flush();
  assert.equal(calls, 2);
  assert.equal(h.runner.siteList().byPerson.A.length, 1);
  // その後ずっと取れない(Worker に繋がらない)。80 分を過ぎたら一覧を使わず、またログインして数える
  answer = () => {
    throw new Error('Worker HTTP 502 /auto/plans');
  };
  h.advance(SITE_LIST_MAX_AGE_MS + 60_000);
  h.runner.dayRemaining.clear();
  h.setSlots([slot('大島小松川公園', '2026-09-27', '13:00-15:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(h.bookings.length, 2, '古い一覧は使わずログインして数えた');
  assert.ok(h.logs.some((l) => l.includes('一覧が無い間は従来どおりログインして数え')), h.logs.join('\n'));
});

test('手元の予約一覧(2026-11-19): 追加枠は一覧に予約があっても予約する。dry-run と配線なしでは取りに行かない', async () => {
  let calls = 0;
  const plans = async () => {
    calls++;
    return { plans: [sitePlan('A', '2026-09-27', '17:00')], failed: [] };
  };
  const h = harness({ exclusions: { dates: [], slots: [], allowSlots: [{ park: '1160', date: '2026-09-27', start: '09:00' }] }, workerOverride: { plans } });
  await h.runner.tick();
  await flush();
  h.advance(60_000);
  h.setSlots([slot('大島小松川公園', '2026-09-27', '09:00-11:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(h.state.attemptStatus('1160|2026-09-27|09:00'), 'success', '追加枠は 1 日の上限を掛けない');
  const d = harness({ mode: 'dry-run', workerOverride: { plans } });
  const before = calls;
  await d.runner.tick();
  await flush();
  assert.equal(calls, before, 'dry-run は取りに行かない');
  assert.equal(await harness().runner.refreshSiteList(), false, '配線が無ければ何もしない');
});

test('手元の予約一覧(2026-11-19): LINE での取消(除外枠 reason=cancel が heartbeat で届く)は一覧から外し、「その日は上限」の記憶も忘れて、同じ日の別の枠をすぐ取りに行く。取消より後に取り直した一覧にまだあれば残す', async () => {
  const exclusions = { dates: [], slots: [] };
  let plans = [sitePlan('A', '2026-09-27', '17:00', '1060')];
  const reservations = { A: [{ id: '1', date: '2026-09-27', start: '17:00' }] };
  const h = harness({ exclusions, reservations, workerOverride: { plans: async () => ({ plans, failed: [] }) } });
  await h.runner.tick();
  await flush();
  h.advance(60_000);
  h.setSlots([slot('大島小松川公園', '2026-09-27', '09:00-11:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(h.state.attemptStatus('1160|2026-09-27|09:00'), 'capped');
  assert.equal(h.bookings.length, 0, '手元の一覧で見送り(ログインしていない)');
  // 木場 9/27 17:00 を LINE で取り消した(Worker が除外枠に載せる)。次の照会の heartbeat で届く
  h.advance(60_000);
  exclusions.slots = [{ park: '1060', date: '2026-09-27', start: '17:00', end: '19:00', facility: '木場公園', reason: 'cancel', at: h.now() - 10_000 }];
  reservations.A = [];
  h.setSlots([slot('大島小松川公園', '2026-09-27', '09:00-11:00'), slot('大島小松川公園', '2026-09-27', '13:00-15:00')]);
  await h.runner.tick();
  await flush();
  assert.ok(h.logs.some((l) => l.includes('手元の予約一覧から外しました(取消または手放し): A 2026-09-27 17:00 木場公園')), h.logs.join('\n'));
  assert.equal(h.state.attemptStatus('1160|2026-09-27|13:00'), 'success', '取り消した日の別の枠を取りに行く');
  assert.deepEqual(h.runner.siteList().byPerson.A.map((r) => `${r.date} ${r.start} ${r.park}`), ['2026-09-27 13:00 1160']);
  // 1 時間後の取り直し(取消より後)に、同じ木場 17:00 がまた載っている(取り直した)。除外枠が残っていても外さない
  plans = [sitePlan('A', '2026-09-27', '17:00', '1060')];
  h.advance(SITE_LIST_REFRESH_MS);
  await h.runner.tick();
  await flush();
  assert.deepEqual(h.runner.siteList().byPerson.A.map((r) => `${r.date} ${r.start}`), ['2026-09-27 17:00']);
});

test('手元の予約一覧(2026-11-19): 取り直しが取消より前に始まり、取消の後に「まだある」一覧を返しても、その予約は外す', async () => {
  const exclusions = { dates: [], slots: [] };
  let release = null;
  let calls = 0;
  const h = harness({
    exclusions,
    workerOverride: {
      plans: () => {
        calls++;
        if (calls === 1) return Promise.resolve({ plans: [sitePlan('A', '2026-09-27', '17:00', '1060')], failed: [] });
        return new Promise((r) => (release = () => r({ plans: [sitePlan('A', '2026-09-27', '17:00', '1060')], failed: [] })));
      },
    },
  });
  await h.runner.tick();
  await flush();
  h.advance(SITE_LIST_REFRESH_MS);
  await h.runner.tick(); // 取り直しが始まる(まだ返らない)
  await flush();
  h.advance(30_000);
  exclusions.slots = [{ park: '1060', date: '2026-09-27', start: '17:00', reason: 'cancel', at: h.now() }]; // その間に取消
  h.advance(30_000);
  await h.runner.tick();
  await flush();
  assert.deepEqual(h.runner.siteList().byPerson.A, [], '古い一覧からはすぐ外れる');
  release(); // 取消の前に取った一覧が、いま返ってくる
  await flush();
  assert.deepEqual(h.runner.siteList().byPerson.A, [], '取消より前に取り始めた一覧の分は外す');
});

test('手元の予約一覧(2026-11-19): LINE のボタンでの手動予約(noteBooked)はその場で足し、同じ日の枠はログインせずに見送る。二重には足さない。一覧がまだ無ければ何もしない', async () => {
  const h = harness({ workerOverride: { plans: async () => ({ plans: [], failed: [] }) } });
  assert.equal(h.runner.noteBooked('A', { date: '2026-09-27', start: '15:00', park: '1040' }), false, '一覧がまだ無い');
  await h.runner.tick();
  await flush();
  assert.equal(h.runner.noteBooked('A', { date: '2026-09-27', start: '15:00', park: '1040' }), true);
  assert.equal(h.runner.noteBooked('A', { date: '2026-09-27', start: '15:00', park: '1040' }), false, '同じ予約は 1 回だけ');
  h.advance(60_000);
  h.setSlots([slot('大島小松川公園', '2026-09-27', '09:00-11:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(h.bookings.length, 0, 'ログインしていない');
  assert.equal(h.state.attemptStatus('1160|2026-09-27|09:00'), 'capped');
});

test('手元の予約一覧の照らし合わせ(2026-11-19): 自動予約・手動予約・LINE の取消を反映できていれば、次の取り直しと一致する(食い違い 0)。サイトで直接取った・取り消した分は食い違いとして記録する', async () => {
  const exclusions = { dates: [], slots: [] };
  let plans = [sitePlan('A', '2026-09-27', '17:00', '1060'), sitePlan('B', '2026-09-25', '19:00', '1040'), sitePlan('A', '2026-09-13', '09:00', '1040')];
  const eventsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')), 'events.jsonl');
  const h = harness({ exclusions, eventsFile, workerOverride: { plans: async () => ({ plans, failed: [] }) } });
  await h.runner.tick();
  await flush();
  assert.deepEqual(h.runner.siteListCheck(), { checks: 0, mismatches: 0, lastMismatchAt: null, lastMismatch: null }, '最初の 1 回は比べる相手が無い');
  // この 1 時間に: 自動予約が 1 件成立・LINE で手動予約 1 件・LINE で木場 9/27 を取消
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-26', '13:00-15:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(h.state.attemptStatus('1040|2026-09-26|13:00'), 'success');
  h.runner.noteBooked('A', { date: '2026-10-03', start: '09:00', park: '1160' });
  exclusions.slots = [{ park: '1060', date: '2026-09-27', start: '17:00', reason: 'cancel', at: h.now() }];
  // サイトの一覧もそのとおりになっている(昨日までの予約 9/13 は日付が変わって消えた、という想定で無くてもよい)
  plans = [sitePlan('B', '2026-09-25', '19:00', '1040'), sitePlan('A', '2026-09-26', '13:00', '1040'), sitePlan('A', '2026-10-03', '09:00', '1160')];
  h.advance(SITE_LIST_REFRESH_MS);
  await h.runner.tick();
  await flush();
  assert.equal(h.runner.siteListCheck().checks, 1);
  assert.equal(h.runner.siteListCheck().mismatches, 0, h.logs.filter((l) => l.includes('食い違')).join('\n'));
  // 次の 1 時間に、サイトで直接 B が 10/1 を取り、A が 10/3 を取り消した(イベントは届かない)
  plans = [sitePlan('B', '2026-09-25', '19:00', '1040'), sitePlan('A', '2026-09-26', '13:00', '1040'), sitePlan('B', '2026-10-01', '19:00', '1040')];
  h.advance(SITE_LIST_REFRESH_MS);
  await h.runner.tick();
  await flush();
  const ck = h.runner.siteListCheck();
  assert.deepEqual([ck.checks, ck.mismatches], [2, 1]);
  assert.deepEqual(ck.lastMismatch, { onlySite: ['B 2026-10-01 19:00 猿江恩賜公園'], onlyLocal: ['A 2026-10-03 09:00 大島小松川公園'] });
  assert.ok(h.logs.some((l) => l.includes('手元の予約一覧がサイトと食い違っていました') && l.includes('手元に無かった予約: B 2026-10-01 19:00 猿江恩賜公園') && l.includes('手元にだけあった予約: A 2026-10-03 09:00 大島小松川公園')), h.logs.join('\n'));
  assert.equal(readEvents(eventsFile).filter((e) => e.type === 'site_list_diff').length, 1);
  // その次は一致に戻る
  h.advance(SITE_LIST_REFRESH_MS);
  await h.runner.tick();
  await flush();
  assert.deepEqual([h.runner.siteListCheck().checks, h.runner.siteListCheck().mismatches], [3, 1]);
});

// ---- 予約の前の一覧を省く(2026-11-19): 手元の予約一覧が使えるときは省き、成立の後に一覧を見て答え合わせをする ----
test('一覧の省略(2026-11-19): 手元の予約一覧があれば book に skipList=true を渡し、成立後の一覧で手元を入れ替える。手元の一覧が無い・古い・AUTO_SKIP_LIST=0 なら従来どおり予約の前に見る', async () => {
  const eventsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')), 'events.jsonl');
  const reservations = { A: [{ id: '9', date: '2026-10-03', start: '09:00', end: '11:00', facility: '大島小松川公園' }] };
  const h = harness({ reservations, eventsFile, workerOverride: { plans: async () => ({ plans: [sitePlan('A', '2026-10-03', '09:00', '1160')], failed: [] }) } });
  await h.runner.tick();
  await flush();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-26', '13:00-15:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(h.bookOpts[0].skipList, true);
  assert.ok(h.logs.some((l) => l.includes('自動予約 開始') && l.includes('[予約前の一覧は省く。手元の一覧 1 分前]')), h.logs.join('\n'));
  assert.equal(h.state.attemptStatus('1040|2026-09-26|13:00'), 'success');
  assert.deepEqual(h.runner.siteList().byPerson.A.map((r) => `${r.date} ${r.start} ${r.park}`), ['2026-10-03 09:00 1160', '2026-09-26 13:00 1040'], '成立後の一覧で入れ替え(重ねて足さない)');
  assert.equal(h.runner.dayRemaining.get('2026-09-26').remaining, 0);
  assert.ok(!h.logs.some((l) => l.includes('二重予約')));
  assert.equal(readEvents(eventsFile).find((e) => e.type === 'result' && e.status === 'success').diag.listSkipped, true);
  assert.ok(!JSON.stringify(h.notified[0].m).includes('重なっています'));
  // 手元の一覧が古い(80 分超・取り直しは失敗)なら省かない
  h.workerRef.plans = async () => {
    throw new Error('down');
  };
  h.advance(SITE_LIST_MAX_AGE_MS + 60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-26', '13:00-15:00'), slot('大島小松川公園', '2026-10-04', '09:00-11:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(h.bookOpts[1].skipList, false, '古い一覧は使わず、予約の前に見る');
  // 止めるスイッチ
  const off = harness({ skipListCheck: false, workerOverride: { plans: async () => ({ plans: [], failed: [] }) } });
  await off.runner.tick();
  await flush();
  off.advance(60_000);
  off.setSlots([slot('猿江恩賜公園', '2026-09-26', '13:00-15:00')]);
  await off.runner.tick();
  await flush();
  assert.equal(off.bookOpts[0].skipList, false);
});

test('一覧の省略(2026-11-19): 手元の一覧が知らなかった予約が同じ日にあった(二重予約)ら、成立カードに注意を出し、ログと記録に残す。手元の一覧もサイトに合わせる', async () => {
  const eventsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')), 'events.jsonl');
  // サイトには 9/26 17:00 木場(サイトで直接取った)があるが、手元の一覧は知らない
  const reservations = { A: [{ id: '7', date: '2026-09-26', start: '17:00', end: '19:00', facility: '木場公園' }] };
  const h = harness({ reservations, eventsFile, workerOverride: { plans: async () => ({ plans: [], failed: [] }) } });
  await h.runner.tick();
  await flush();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-26', '13:00-15:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(h.state.attemptStatus('1040|2026-09-26|13:00'), 'success');
  assert.ok(h.logs.some((l) => l.includes('⚠ 二重予約: 2026-09-26 に 2 件の予約があります') && l.includes('17:00 木場公園')), h.logs.join('\n'));
  assert.ok(JSON.stringify(h.notified[0].m).includes('この日は予約が重なっています(17:00 木場公園)'));
  assert.deepEqual(readEvents(eventsFile).find((e) => e.type === 'double_booked').others, [{ start: '17:00', facility: '木場公園', id: '7' }]);
  assert.deepEqual(h.runner.siteList().byPerson.A.map((r) => `${r.start} ${r.park}`).sort(), ['13:00 1040', '17:00 1060']);
  // 次に同じ日の枠が出ても、もう取りに行かない
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-26', '13:00-15:00'), slot('大島小松川公園', '2026-09-26', '09:00-11:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(h.bookings.length, 1);
});

test('一覧の省略(2026-11-19): 成立後の一覧が取れなくても成立は成立。手元の一覧には今回の 1 件を足す。自分が自動予約した枠が成立後の一覧から消えていたら、従来どおり手放しとして登録する', async () => {
  const h = harness({ afterListFails: true, workerOverride: { plans: async () => ({ plans: [], failed: [] }) } });
  await h.runner.tick();
  await flush();
  h.advance(60_000);
  h.setSlots([slot('猿江恩賜公園', '2026-09-26', '13:00-15:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(h.state.attemptStatus('1040|2026-09-26|13:00'), 'success');
  assert.ok(h.logs.some((l) => l.includes('予約後の一覧が取れなかった')));
  assert.deepEqual(h.runner.siteList().byPerson.A.map((r) => `${r.date} ${r.start}`), ['2026-09-26 13:00']);

  // 手放しの検出: 9/26 13:00 を自動で取った後、サイトの一覧からそれが消えている状態で別の日が成立
  const reservations = { A: [] };
  const h2 = harness({ reservations, workerOverride: { plans: async () => ({ plans: [], failed: [] }) } });
  await h2.runner.tick();
  await flush();
  h2.advance(60_000);
  h2.setSlots([slot('猿江恩賜公園', '2026-09-26', '13:00-15:00')]);
  await h2.runner.tick();
  await flush();
  reservations.A = []; // サイトで 9/26 13:00 を手放した
  h2.advance(60_000);
  h2.setSlots([slot('猿江恩賜公園', '2026-09-26', '13:00-15:00'), slot('大島小松川公園', '2026-10-03', '09:00-11:00')]);
  await h2.runner.tick();
  await flush();
  assert.equal(h2.state.attemptStatus('1160|2026-10-03|09:00'), 'success');
  assert.deepEqual(h2.added.map((s) => `${s.date} ${s.start}`), ['2026-09-26 13:00'], '一覧から消えた自動予約の枠を除外枠に登録');
});
