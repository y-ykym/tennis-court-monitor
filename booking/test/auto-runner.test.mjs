import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutoRunner, nextDelayMs, pollIntervalAt, MIN_GAP_MS, DAY_REMAINING_TTL_MS } from '../src/auto-runner.js';
import { createAutoState } from '../src/auto-state.js';
import { createBookingQueue } from '../src/booking-queue.js';
import { verifyCancelToken } from '../src/cancel-token.js';

const SECRET = 'test-signing-secret';
// 2026-09-14(月) JST 10:00
const T0 = Date.parse('2026-09-14T01:00:00Z');
const slot = (facility, date, time, count = 1) => ({ facility, date, time, count });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-')), 'auto-state.json');
const flush = () => new Promise((r) => setTimeout(r, 20));

function harness({ mode = 'on', slots = [], exclusions = { dates: [], slots: [] }, book, reservations = {}, creds = { A: true, B: true }, heartbeatFails = false, start = T0 } = {}) {
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
  const runner = createAutoRunner({
    mode,
    scrape: async () => current,
    queue,
    state,
    worker: {
      heartbeat: async (p) => {
        heartbeats.push(p);
        if (heartbeatFails) throw new Error('offline');
        return exclusions;
      },
      addExcludedSlots: async (s) => added.push(...s),
    },
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
    runner, state, queue, logs, notified, heartbeats, added, bookings, vacancyCards,
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

test('照会間隔(JST): 21:00〜翌 1:00 は 1 分、7:00〜21:00 は 2 分、1:00〜7:00 は 3 分', () => {
  assert.equal(pollIntervalAt(jst('2026-09-15', '00:59'), 60_000), 60_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '01:00'), 60_000), 180_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '04:30'), 60_000), 180_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '06:59'), 60_000), 180_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '07:00'), 60_000), 120_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '14:00'), 60_000), 120_000);
  assert.equal(pollIntervalAt(jst('2026-09-15', '20:59'), 60_000), 120_000);
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

test('「その日は上限」の記憶は 15 分で忘れ、次はまた一覧を見て数える(取り消した後に見送り続けない)', async () => {
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
  // 本人が取り消した。16 分後に出た枠は、記憶を忘れて一覧を見直す → 0 件なので予約する
  reservations.A = [];
  h.advance(DAY_REMAINING_TTL_MS + 60_000);
  h.setSlots([slot('大島小松川公園', '2026-09-27', '15:00-17:00')]);
  await h.runner.tick();
  await flush();
  assert.equal(h.bookings.length, 2, 'また一覧を見た');
  assert.equal(h.state.attemptStatus('1160|2026-09-27|15:00'), 'success');
});
