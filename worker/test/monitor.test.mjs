import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMonitor, probeBookingServer, ALERT_AFTER_FAILS, PROBE_ATTEMPTS } from '../src/monitor.js';

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return { async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); }, store };
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

test('monitor: 知らせた後に復帰したら「復帰しました(停止 約N分)」を 1 回', async () => {
  const env = baseEnv();
  const pushed = [];
  const push = async (_t, _to, text) => pushed.push(text);
  await runMonitor(env, { now: T0, probe: down, push });
  const r = await runMonitor(env, { now: T0 + 3600000, probe: up, push });
  assert.deepEqual([r.ok, r.fails, r.notified], [true, 0, 'up']);
  assert.equal(pushed.length, 2);
  assert.match(pushed[1], /復帰しました\(停止 約60分\)/);
  await runMonitor(env, { now: T0 + 7200000, probe: up, push });
  assert.equal(pushed.length, 2);
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
