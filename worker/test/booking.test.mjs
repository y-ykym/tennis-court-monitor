import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBookingToken, registerAuth, handleBooking } from '../src/booking.js';
// 署名側(通知側)の実装と相互に検証できることを確認する
import { sign, slotExpiry } from '../../booking/src/token.js';

const SECRET = 'test-secret';
const payload = { park: '1050', date: '2026-09-17', startHour: 15, people: 2, exp: slotExpiry('2026-09-17', 15) };

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(k) {
      return store.has(k) ? store.get(k) : null;
    },
    async put(k, v) {
      store.set(k, v);
    },
    async delete(k) {
      store.delete(k);
    },
    store,
  };
}
const ctx = { waitUntil() {} };

test('通知側(Node crypto)で署名したトークンを Worker 側(Web Crypto)で検証できる', async () => {
  const token = sign(payload, SECRET);
  assert.deepEqual(await verifyBookingToken(token, SECRET, Date.UTC(2026, 8, 4)), payload);
  assert.equal(await verifyBookingToken(token, 'other', Date.UTC(2026, 8, 4)), null);
  assert.equal(await verifyBookingToken(token.slice(0, -1) + 'x', SECRET, Date.UTC(2026, 8, 4)), null);
  assert.equal(await verifyBookingToken(token, SECRET, Date.UTC(2026, 8, 17, 6, 1)), null);
});

test('/book: PC が未登録なら 503 の案内、登録があれば PC へ中継(プロキシ)', async () => {
  const token = sign(payload, SECRET);
  const env = { BOOKING_SIGNING_SECRET: SECRET, BOOKING_KV: fakeKV() };
  const req = new Request(`https://w.example/book?token=${token}&person=A`);
  const r1 = await handleBooking(req, env, ctx);
  assert.equal(r1.status, 503);
  assert.match(await r1.text(), /繋がりません/);

  env.BOOKING_KV.store.set('booking_url', 'https://abc-def.trycloudflare.com');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (target, init) => {
    calls.push({ target: String(target), method: init.method });
    return new Response('<h1>誰の予約にしますか?</h1>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try {
    const r2 = await handleBooking(req, env, ctx);
    assert.equal(r2.status, 200);
    assert.match(await r2.text(), /誰の予約/);
    assert.equal(calls.length, 1);
    const t = new URL(calls[0].target);
    assert.equal(t.origin + t.pathname, 'https://abc-def.trycloudflare.com/book');
    assert.equal(t.searchParams.get('token'), token);
    assert.equal(t.searchParams.get('person'), 'A');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('中継: トンネルの一時エラー(530)はやり直し、成功したら返す', async () => {
  const env = { BOOKING_SIGNING_SECRET: SECRET, BOOKING_KV: fakeKV({ booking_url: 'https://abc.trycloudflare.com' }) };
  let n = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => (++n < 3 ? new Response('error 1033', { status: 530 }) : new Response('{"status":"ready"}', { status: 200 }));
  try {
    const r = await handleBooking(new Request('https://w.example/status?token=x'), env, ctx);
    assert.equal(r.status, 200);
    assert.equal(n, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/book: 署名が不正なら 403', async () => {
  const env = { BOOKING_SIGNING_SECRET: SECRET, BOOKING_KV: fakeKV({ booking_url: 'https://abc.trycloudflare.com' }) };
  const r = await handleBooking(new Request('https://w.example/book?token=abc.def'), env, ctx);
  assert.equal(r.status, 403);
});

test('/booking/register: 認証値が合えば登録、合わなければ 401', async () => {
  const env = { BOOKING_SIGNING_SECRET: SECRET, BOOKING_KV: fakeKV() };
  const url = 'https://xyz-123.trycloudflare.com';
  const ok = await handleBooking(
    new Request('https://w.example/booking/register', {
      method: 'POST',
      headers: { 'x-booking-auth': await registerAuth(SECRET, url), 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    }),
    env,
    ctx
  );
  assert.equal(ok.status, 204);
  assert.equal(env.BOOKING_KV.store.get('booking_url'), url);

  const bad = await handleBooking(
    new Request('https://w.example/booking/register', {
      method: 'POST',
      headers: { 'x-booking-auth': 'wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://evil.trycloudflare.com' }),
    }),
    env,
    ctx
  );
  assert.equal(bad.status, 401);
  assert.equal(env.BOOKING_KV.store.get('booking_url'), url);
});

test('扱わないパスは null(既存の /webhook を邪魔しない)', async () => {
  const env = { BOOKING_SIGNING_SECRET: SECRET, BOOKING_KV: fakeKV() };
  assert.equal(await handleBooking(new Request('https://w.example/webhook', { method: 'POST' }), env, ctx), null);
});

test('startBooking: 未登録なら offline、302→/wait なら started、302→/result なら already、409 なら busy、署名不正なら invalid', async () => {
  const { startBooking } = await import('../src/booking.js');
  const token = sign({ ...payload, person: 'A' }, SECRET);
  const env = { BOOKING_SIGNING_SECRET: SECRET, BOOKING_KV: fakeKV() };
  assert.equal((await startBooking(env, token)).status, 'offline');
  assert.equal((await startBooking(env, 'abc.def')).status, 'invalid');

  env.BOOKING_KV.store.set('booking_url', 'https://abc.trycloudflare.com');
  const realFetch = globalThis.fetch;
  const withResponse = async (res, fn) => {
    const calls = [];
    globalThis.fetch = async (target, init) => {
      calls.push({ target: String(target), redirect: init.redirect });
      return typeof res === 'function' ? res() : res;
    };
    try {
      return await fn(calls);
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  await withResponse(new Response(null, { status: 302, headers: { location: `/wait?token=${token}` } }), async (calls) => {
    const r = await startBooking(env, token);
    assert.equal(r.status, 'started');
    assert.equal(r.payload.person, 'A');
    const t = new URL(calls[0].target);
    assert.equal(t.origin + t.pathname, 'https://abc.trycloudflare.com/book');
    assert.equal(t.searchParams.get('token'), token);
    assert.equal(calls[0].redirect, 'manual', 'リダイレクトは追わずに Location を見る');
  });
  await withResponse(new Response(null, { status: 302, headers: { location: `/result?token=${token}` } }), async () => {
    assert.equal((await startBooking(env, token)).status, 'already');
  });
  await withResponse(new Response('busy', { status: 409 }), async () => {
    assert.equal((await startBooking(env, token)).status, 'busy');
  });
  // トンネルの一時エラーが続いたら offline
  await withResponse(() => new Response('error 1033', { status: 530 }), async (calls) => {
    assert.equal((await startBooking(env, token)).status, 'offline');
    assert.equal(calls.length, 4, '4 回やり直す');
  });
});
