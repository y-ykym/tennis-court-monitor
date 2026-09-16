import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMonitor, probeBookingServer, sendMaintenanceReminder, MAINTENANCE_TEXT, ALERT_AFTER_FAILS, PROBE_ATTEMPTS } from '../src/monitor.js';

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const kv = {
    failWrites: false, // KV の 1 日 1,000 回の書き込み上限に当たった状況を再現する
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { if (kv.failWrites) throw new Error('KV put failed: limit exceeded'); store.set(k, v); },
    async delete(k) { store.delete(k); },
    store,
  };
  return kv;
}
const baseEnv = () => ({ BOOKING_KV: fakeKV(), LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_GROUP_ID: 'C1' });
const T0 = Date.parse('2026-09-13T03:00:00Z'); // JST 12:00
const down = async () => ({ ok: false, reason: 'テスト理由' });
const up = async () => ({ ok: true });

test('monitor: 失敗したら 1 回だけ「繋がりません」。連続失敗中は鳴らさない', async () => {
  const env = baseEnv();
  const pushed = [];
  const push = async (_t, to, text) => pushed.push({ to, text });
  let r = await runMonitor(env, { now: T0, probe: down, push });
  assert.deepEqual([r.fails, r.notified], [1, 'down']);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].to, 'C1');
  assert.match(pushed[0].text, /9\/13 12:00 から繋がりません/);
  assert.match(pushed[0].text, /テスト理由/);
  r = await runMonitor(env, { now: T0 + 3600000, probe: down, push });
  assert.deepEqual([r.fails, r.notified], [2, null]);
  assert.equal(pushed.length, 1);
  assert.equal(ALERT_AFTER_FAILS, 1);
});

test('monitor: 知らせた後に復帰したら「復帰しました(いつ〜いつ、約N分)」を 1 回', async () => {
  const env = baseEnv();
  const pushed = [];
  const push = async (_t, _to, text) => pushed.push(text);
  await runMonitor(env, { now: T0, probe: down, push });
  const r = await runMonitor(env, { now: T0 + 3600000, probe: up, push });
  assert.deepEqual([r.ok, r.fails, r.notified], [true, 0, 'up']);
  assert.equal(pushed.length, 2);
  assert.match(pushed[1], /復帰しました\(9\/13 12:00 〜 9\/13 13:00、約60分\)/);
  await runMonitor(env, { now: T0 + 7200000, probe: up, push });
  assert.equal(pushed.length, 2);
});

test('monitor: 状態を保存できない間は送らない(2026-09-16 の連投を防ぐ)。書けるようになったら 1 回だけ送る', async () => {
  const env = baseEnv();
  const pushed = [];
  const push = async (_t, _to, text) => pushed.push(text);
  env.BOOKING_KV.failWrites = true;
  let r = await runMonitor(env, { now: T0, probe: down, push });
  assert.deepEqual([r.saved, r.notified], [false, null]);
  assert.equal(pushed.length, 0, '記録を残せないなら送らない');
  await runMonitor(env, { now: T0 + 3600000, probe: down, push });
  assert.equal(pushed.length, 0);
  env.BOOKING_KV.failWrites = false;
  r = await runMonitor(env, { now: T0 + 7200000, probe: down, push });
  assert.deepEqual([r.saved, r.notified, pushed.length], [true, 'down', 1]);
  await runMonitor(env, { now: T0 + 10800000, probe: down, push });
  assert.equal(pushed.length, 1, '書けた後は 1 回だけ');
});

test('monitor: LINE に送れなかった知らせは次回に再送し、停止時間は水増ししない', async () => {
  const env = baseEnv();
  const pushed = [];
  let lineDown = false;
  const push = async (_t, _to, text) => { if (lineDown) throw new Error('LINE push失敗: HTTP 429'); pushed.push(text); };
  await runMonitor(env, { now: T0, probe: down, push });
  assert.equal(pushed.length, 1);
  lineDown = true;
  let r = await runMonitor(env, { now: T0 + 3600000, probe: up, push });
  assert.deepEqual([r.notified, r.sent, r.pending], ['up', 0, 1]);
  assert.equal(pushed.length, 1, '送れていない');
  assert.equal(JSON.parse(env.BOOKING_KV.store.get('monitor_state')).alerted, false, '状態は保存されている');
  lineDown = false;
  r = await runMonitor(env, { now: T0 + 6 * 3600000, probe: up, push });
  assert.deepEqual([r.sent, r.pending, pushed.length], [1, 0, 2]);
  assert.match(pushed[1], /9\/13 12:00 〜 9\/13 13:00、約60分/, '5 時間遅れて送っても 60 分のまま');
  assert.match(pushed[1], /遅れて届いています/);
  await runMonitor(env, { now: T0 + 7 * 3600000, probe: up, push });
  assert.equal(pushed.length, 2, '再送は 1 回きり');
});

test('monitor: 正常が続く間は何も送らない', async () => {
  const env = baseEnv();
  const pushed = [];
  const push = async (_t, _to, text) => pushed.push(text);
  await runMonitor(env, { now: T0, probe: up, push });
  await runMonitor(env, { now: T0 + 3600000, probe: up, push });
  assert.equal(pushed.length, 0);
  assert.equal(JSON.parse(env.BOOKING_KV.store.get('monitor_state')).fails, 0);
});

test('probe: 登録なし → down、/warmup 200 → ok、一時エラー後に 200 → ok(再試行)、全部失敗 → down', async () => {
  const env = baseEnv();
  assert.equal((await probeBookingServer(env)).ok, false);
  env.BOOKING_KV.store.set('booking_url', 'https://abc.trycloudflare.com');
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (u) => { assert.equal(String(u), 'https://abc.trycloudflare.com/warmup'); return new Response('ok', { status: 200 }); };
    assert.equal((await probeBookingServer(env, { retryMs: 0 })).ok, true);
    let n = 0;
    globalThis.fetch = async () => (++n < 3 ? new Response('error', { status: 530 }) : new Response('ok', { status: 200 }));
    assert.equal((await probeBookingServer(env, { retryMs: 0 })).ok, true, '3 回目で成功');
    assert.equal(PROBE_ATTEMPTS, 4);
    globalThis.fetch = async () => new Response('error', { status: 530 });
    const r = await probeBookingServer(env, { retryMs: 0 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /HTTP 530\(4 回試行\)/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('月初のお知らせ: グループに手順つきのテキストを 1 通', async () => {
  const pushed = [];
  await sendMaintenanceReminder({ LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_GROUP_ID: 'C1' }, { push: async (_t, to, text) => pushed.push({ to, text }) });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].to, 'C1');
  assert.equal(pushed[0].text, MAINTENANCE_TEXT);
  assert.match(pushed[0].text, /docker compose build --pull booking/);
  assert.match(pushed[0].text, /利用状況/, '10/1 に無料枠へ戻るので通数の確認も促す');
  assert.ok(pushed[0].text.length <= 5000);
});
