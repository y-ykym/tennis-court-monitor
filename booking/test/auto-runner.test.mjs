import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutoRunner, nextDelayMs, pollIntervalAt, MIN_GAP_MS, DAY_REMAINING_TTL_MS, AUTH_PAUSE_MS, TB_PLANS_TTL_MS } from '../src/auto-runner.js';
import { createAutoState } from '../src/auto-state.js';
import { createBookingQueue } from '../src/booking-queue.js';
import { verifyCancelToken } from '../src/cancel-token.js';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AUTO_BOOKING } = require('../../lib/config.js');

const SECRET = 'test-signing-secret';
// 2026-09-14(月) JST 10:00
const T0 = Date.parse('2026-09-14T01:00:00Z');
const slot = (facility, date, time, count = 1) => ({ facility, date, time, count });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-')), 'auto-state.json');
const flush = () => new Promise((r) => setTimeout(r, 20));

function harness({ mode = 'on', slots = [], exclusions = { dates: [], slots: [] }, book, reservations = {}, creds = { A: true, B: true }, heartbeatFails = false, start = T0, workerOverride = null } = {}) {
  let t = start;
  const logs = [];
  const notified = [];
  const vacancyCards = [];
  const heartbeats = [];
  const added = [];
  const bookings = [];
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
  });
  const runner = createAutoRunner({
    mode,
    scrape: async () => current,
    queue,
    state,
    worker: workerRef,
    book:
      book ||
      (async (c, { beforeApply }) => {
        bookings.push(`${c.date} ${c.park} ${c.startHour} ${c.person}`);
        const list = reservations[c.person] || [];
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
    maintenance: () => false,
  });
  return {
    runner, state, queue, logs, notified, heartbeats, added, bookings, vacancyCards, workerRef,
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
  assert.deepEqual(h.notified.map((x) => x.m.contents.header.contents[0].text), ['🎾 予約完了(自動予約)'], 'taken のカードは送らない');
  assert.ok(h.logs.some((l) => l.includes('結果カードは送りません(taken')));
});

test('失敗カード: ログインできない・reCAPTCHA 拒否は送る(放置すると自動予約が止まる)。先に取られた・断られた・サイトのエラーは送らない', async () => {
  const statuses = ['auth_error', 'rejected', 'error', 'taken', 'duplicate'];
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
  assert.equal(i, 5);
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

test('照会の失敗・メンテナンス時間帯はスキップし、heartbeat だけ送る。30 秒未満の間隔は 30 秒に切り上げ', async () => {
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
    maintenance: () => false,
  });
  assert.equal(runner.intervalMs, 30000);
  assert.deepEqual(await runner.tick(), { skipped: 'scrape_failed' });
  assert.equal(heartbeats.length, 1);
  assert.ok(heartbeats[0].lastCycle.error.includes('502'));
  const m = createAutoRunner({ mode: 'on', scrape: async () => [], queue: createBookingQueue(), state: createAutoState({ file: tmpFile() }), worker: { heartbeat: async () => ({ dates: [], slots: [] }), addExcludedSlots: async () => {} }, book: async () => ({}), credentialsFor: () => null, maintenance: () => true });
  assert.deepEqual(await m.tick(), { skipped: 'maintenance' });
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
    log: (m) => logs.push(m), now: () => T0, maintenance: () => false,
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

test('照会間隔(JST): 7:00〜翌 1:00 は 1 分、1:00〜7:00 は 3 分(2026-09-24 に日中を 2 分 → 1 分へ)', () => {
  assert.equal(pollIntervalAt(jst('2026-09-15', '00:59'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '01:00'), 60_000), 180_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '04:30'), 60_000), 180_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '06:59'), 60_000), 180_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '07:00'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '14:00'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '20:59'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '21:00'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '23:30'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '03:00'), 60_000, []), 60_000, '設定が無ければ常に同じ');
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
    log: (m) => logs.push(m), now: () => t, maintenance: () => false, forgetFile: forget,
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
    log: (m) => logs.push(m), now: () => T0, maintenance: () => false,
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
    log: (m) => logs.push(m), now: () => t, maintenance: () => false,
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
    log: (m) => logs.push(m), now: () => t, maintenance: () => false,
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

test('隣接(都の予約): 予約直前の一覧に、隣の時間帯の別の公園の予約があれば見送り(conflict)。上限を 2 件にして確認(上限 1 件のうちは capped が先に当たる)', async () => {
  const saved = AUTO_BOOKING.MAX_PER_DAY;
  AUTO_BOOKING.MAX_PER_DAY = 2;
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
    AUTO_BOOKING.MAX_PER_DAY = saved;
  }
});
