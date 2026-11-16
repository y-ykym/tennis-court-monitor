import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMonitor, probeBookingServer, autoIssue, fetchLineQuotaUsage, fetchLineQuotaLimit, fetchLineQuota, ALERT_AFTER_FAILS, PROBE_ATTEMPTS, AUTO_STALL_MS, AUTO_FAIL_ALERT_AFTER } from '../src/monitor.js';

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
  let r = await runMonitor(env, { now: T0, probe: down, quota: noQuota, push });
  assert.deepEqual([r.fails, r.notified], [1, 'down']);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].to, 'C1');
  assert.match(pushed[0].text, /9\/13 12:00 から繋がりません/);
  assert.match(pushed[0].text, /テスト理由/);
  r = await runMonitor(env, { now: T0 + 3600000, probe: down, quota: noQuota, push });
  assert.deepEqual([r.fails, r.notified], [2, null]);
  assert.equal(pushed.length, 1);
  assert.equal(ALERT_AFTER_FAILS, 1);
});

test('monitor: 知らせた後に復帰したら「復帰しました(いつ〜いつ、約N分)」を 1 回', async () => {
  const env = baseEnv();
  const pushed = [];
  const push = async (_t, _to, text) => pushed.push(text);
  await runMonitor(env, { now: T0, probe: down, quota: noQuota, push });
  const r = await runMonitor(env, { now: T0 + 3600000, probe: up, quota: noQuota, push });
  assert.deepEqual([r.ok, r.fails, r.notified], [true, 0, 'up']);
  assert.equal(pushed.length, 2);
  assert.match(pushed[1], /復帰しました\(9\/13 12:00 〜 9\/13 13:00、約60分\)/);
  await runMonitor(env, { now: T0 + 7200000, probe: up, quota: noQuota, push });
  assert.equal(pushed.length, 2);
});

test('monitor: 状態を保存できない間は送らない(2026-09-16 の連投を防ぐ)。書けるようになったら 1 回だけ送る', async () => {
  const env = baseEnv();
  const pushed = [];
  const push = async (_t, _to, text) => pushed.push(text);
  env.BOOKING_KV.failWrites = true;
  let r = await runMonitor(env, { now: T0, probe: down, quota: noQuota, push });
  assert.deepEqual([r.saved, r.notified], [false, null]);
  assert.equal(pushed.length, 0, '記録を残せないなら送らない');
  await runMonitor(env, { now: T0 + 3600000, probe: down, quota: noQuota, push });
  assert.equal(pushed.length, 0);
  env.BOOKING_KV.failWrites = false;
  r = await runMonitor(env, { now: T0 + 7200000, probe: down, quota: noQuota, push });
  assert.deepEqual([r.saved, r.notified, pushed.length], [true, 'down', 1]);
  await runMonitor(env, { now: T0 + 10800000, probe: down, quota: noQuota, push });
  assert.equal(pushed.length, 1, '書けた後は 1 回だけ');
});

test('monitor: LINE に送れなかった知らせは次回に再送し、停止時間は水増ししない', async () => {
  const env = baseEnv();
  const pushed = [];
  let lineDown = false;
  const push = async (_t, _to, text) => { if (lineDown) throw new Error('LINE push失敗: HTTP 429'); pushed.push(text); };
  await runMonitor(env, { now: T0, probe: down, quota: noQuota, push });
  assert.equal(pushed.length, 1);
  lineDown = true;
  let r = await runMonitor(env, { now: T0 + 3600000, probe: up, quota: noQuota, push });
  assert.deepEqual([r.notified, r.sent, r.pending], ['up', 0, 1]);
  assert.equal(pushed.length, 1, '送れていない');
  assert.equal(JSON.parse(env.BOOKING_KV.store.get('monitor_state')).alerted, false, '状態は保存されている');
  lineDown = false;
  r = await runMonitor(env, { now: T0 + 6 * 3600000, probe: up, quota: noQuota, push });
  assert.deepEqual([r.sent, r.pending, pushed.length], [1, 0, 2]);
  assert.match(pushed[1], /9\/13 12:00 〜 9\/13 13:00、約60分/, '5 時間遅れて送っても 60 分のまま');
  assert.match(pushed[1], /遅れて届いています/);
  await runMonitor(env, { now: T0 + 7 * 3600000, probe: up, quota: noQuota, push });
  assert.equal(pushed.length, 2, '再送は 1 回きり');
});

test('monitor: 正常が続く間は何も送らない', async () => {
  const env = baseEnv();
  const pushed = [];
  const push = async (_t, _to, text) => pushed.push(text);
  await runMonitor(env, { now: T0, probe: up, quota: noQuota, push });
  await runMonitor(env, { now: T0 + 3600000, probe: up, quota: noQuota, push });
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

const autoOk = { registered: true, reachable: true, alive: true, active: true, mode: 'on', lastSeenAt: null, startedAt: T0 - 86400000, consecutiveFailures: 0, warm: { state: 'ready', failures: 0 }, reason: '' };
const noQuota = async () => 0;

test('monitor: 自動予約の判定(autoIssue)。auto-check.sh の「✔ 動いている」と同じ材料で、理由を 1 つ返す', () => {
  const now = T0;
  assert.equal(autoIssue({ ...autoOk, lastSeenAt: now - 60000 }, now), null);
  assert.equal(autoIssue({ ...autoOk, reachable: false }, now), null, 'Pi に届かないときは上の ⚠️ に任せる');
  // (a) 照会ループが止まった(mode=on なのに 15 分以上照会が無い)。起動直後は見ない。paused(じどうおふ)は止まっていても鳴らさない
  assert.equal(autoIssue({ ...autoOk, lastSeenAt: now - AUTO_STALL_MS - 1 }, now)?.kind, 'stalled');
  assert.match(autoIssue({ ...autoOk, lastSeenAt: now - AUTO_STALL_MS - 1 }, now).text, /止まっています\(最後の合図: 9\/13 11:44\)/);
  assert.equal(autoIssue({ ...autoOk, lastSeenAt: null, startedAt: now - 60000 }, now), null, '起動直後');
  assert.equal(autoIssue({ ...autoOk, mode: 'paused', lastSeenAt: now - 3600000 }, now), null);
  // (b) 空き照会の連続失敗(6 回 = 20 分以上)。5 回(10/31 の回線不調の最大)では鳴らさない
  assert.equal(autoIssue({ ...autoOk, lastSeenAt: now - 60000, consecutiveFailures: AUTO_FAIL_ALERT_AFTER - 1 }, now), null);
  const b = autoIssue({ ...autoOk, lastSeenAt: now - 60000, consecutiveFailures: AUTO_FAIL_ALERT_AFTER }, now);
  assert.equal(b.kind, 'scrape_failing');
  assert.match(b.text, /連続 6 回失敗/);
  // (c) ブラウザが起動できない
  assert.equal(autoIssue({ ...autoOk, lastSeenAt: now - 60000, warm: { state: 'launching', failures: 2 } }, now), null);
  const c = autoIssue({ ...autoOk, lastSeenAt: now - 60000, warm: { state: 'launching', failures: 3 } }, now);
  assert.equal(c.kind, 'browser_failing');
  assert.match(c.text, /ブラウザが起動できません\(3 回連続\)/);
  // 古い Pi(項目が無い)でも落ちない
  assert.equal(autoIssue({ ...autoOk, lastSeenAt: now - 60000, consecutiveFailures: null, warm: null }, now), null);
});

test('monitor: 自動予約の異常は 1 回だけ ⚠️、直ったら ✅ を 1 回。サーバーごと落ちている間は判定しない', async () => {
  const env = baseEnv();
  const pushed = [];
  const push = async (_t, _to, text) => pushed.push(text);
  let auto = { ...autoOk, consecutiveFailures: 8 };
  const status = async (_env, now) => ({ ...auto, lastSeenAt: now - 60000 }); // 照会は毎回直前にあったことにする
  let r = await runMonitor(env, { now: T0, probe: up, status, quota: noQuota, push });
  assert.deepEqual([r.autoNotified, pushed.length], ['scrape_failing', 1]);
  assert.match(pushed[0], /連続 8 回失敗/);
  r = await runMonitor(env, { now: T0 + 3600000, probe: up, status, quota: noQuota, push });
  assert.deepEqual([r.autoNotified, pushed.length], [null, 1], '続いている間は鳴らさない');
  // 別の種類の異常に変わっても、まだ ⚠️ 中なら足さない(直ってから次を知らせる)
  auto = { ...autoOk, warm: { state: 'launching', failures: 5 } };
  r = await runMonitor(env, { now: T0 + 7200000, probe: up, status, quota: noQuota, push });
  assert.deepEqual([r.autoNotified, pushed.length], [null, 1]);
  // サーバーごと落ちた → 自動予約の判定はせず、サーバーの ⚠️ だけ
  r = await runMonitor(env, { now: T0 + 10800000, probe: down, status, quota: noQuota, push });
  assert.deepEqual([r.notified, r.autoNotified, pushed.length], ['down', null, 2]);
  // 全部直った → サーバーの ✅ と自動予約の ✅
  auto = { ...autoOk };
  r = await runMonitor(env, { now: T0 + 14400000, probe: up, status, quota: noQuota, push });
  assert.deepEqual([r.notified, r.autoNotified, pushed.length], ['up', 'resumed', 4]);
  assert.match(pushed[2], /✅ 自動予約が復帰しました/);
  assert.match(pushed[3], /✅ 自宅の予約サーバーが復帰しました/);
  r = await runMonitor(env, { now: T0 + 18000000, probe: up, status, quota: noQuota, push });
  assert.deepEqual([r.autoNotified, pushed.length], [null, 4]);
});

test('monitor: LINE の通数が 160 に達したら、その月に 1 回だけ ⚠️。翌月は改めて。API が読めなければ鳴らさない', async () => {
  const env = baseEnv();
  const pushed = [];
  const push = async (_t, _to, text) => pushed.push(text);
  const pushCard = async (_t, _to, msgs) => { cards.push(msgs[0]); pushed.push(msgs[0].altText); };
  const cards = [];
  const status = async (_env, now) => ({ ...autoOk, lastSeenAt: now - 60000 });
  let usage = 159;
  const quota = async (token) => { assert.equal(token, 't'); return usage; };
  let r = await runMonitor(env, { now: T0, probe: up, status, quota, push, pushCard });
  assert.deepEqual([r.quotaNotified, pushed.length], [null, 0]);
  usage = 160;
  r = await runMonitor(env, { now: T0 + 3600000, probe: up, status, quota, push, pushCard });
  assert.deepEqual([r.quotaNotified, pushed.length], [160, 1]);
  assert.match(pushed[0], /今月の通知はあと 40 通です\(160\/200 通\)/);
  assert.match(pushed[0], /つうちおふ/);
  assert.equal(JSON.parse(env.BOOKING_KV.store.get('monitor_state')).quotaWarnedMonth, '2026-09');
  usage = 189;
  r = await runMonitor(env, { now: T0 + 7200000, probe: up, status, quota, push, pushCard });
  assert.deepEqual([r.quotaNotified, pushed.length], [null, 1], '同じ月は 1 回だけ');
  // 翌月(10/1 9:00 JST 以降)に改めて 160 を超えたら送る
  const oct = Date.parse('2026-10-05T03:00:00Z');
  r = await runMonitor(env, { now: oct, probe: up, status, quota, push, pushCard });
  assert.deepEqual([r.quotaNotified, pushed.length], [189, 2]);
  // API の失敗は黙って次回へ(Pi が落ちていても通数は見る)
  const broken = async () => { throw new Error('HTTP 500'); };
  r = await runMonitor(env, { now: oct + 3600000, probe: down, status, quota: broken, push });
  assert.deepEqual([r.notified, r.quotaNotified, pushed.length], ['down', null, 3]);
  assert.equal(JSON.parse(env.BOOKING_KV.store.get('monitor_state')).quotaWarnedMonth, '2026-10', '控えは引き継ぐ');
});

test('monitor: LINE の通数が 190 に達したら、その月に 1 回だけ「今月の通知はここまで」。160 を飛び越えたら 1 通にまとめる', async () => {
  const env = baseEnv();
  const pushed = [];
  const push = async (_t, _to, text) => { pushed.push(text); };
  const cards = [];
  const pushCard = async (_t, _to, msgs) => { cards.push(msgs[0]); pushed.push(msgs[0].altText); };
  const status = async () => ({ reachable: false });
  let usage = 160;
  const quota = async () => usage;
  let r = await runMonitor(env, { now: T0, probe: up, status, quota, push, pushCard });
  assert.deepEqual([r.quotaNotified, pushed.length], [160, 1]);
  usage = 188;
  r = await runMonitor(env, { now: T0 + 3600000, probe: up, status, quota, push, pushCard });
  assert.deepEqual([r.quotaNotified, pushed.length], [null, 1]);
  usage = 192;
  r = await runMonitor(env, { now: T0 + 7200000, probe: up, status, quota, push, pushCard });
  assert.deepEqual([r.quotaNotified, pushed.length], [192, 2]);
  assert.match(pushed[1], /今月の通知はここまでです\(192\/200 通/);
  assert.match(pushed[1], /「よやく」で確認できます/);
  usage = 200;
  r = await runMonitor(env, { now: T0 + 10800000, probe: up, status, quota, push, pushCard });
  assert.deepEqual([r.quotaNotified, pushed.length], [null, 2], '同じ月は 1 回だけ');
  // 翌月: 160 を見ないまま 190 を超えていたら「終わり」の 1 通だけ(⚠️ と 2 通にしない)
  const oct = T0 + 20 * 24 * 3600000;
  usage = 194;
  r = await runMonitor(env, { now: oct, probe: up, status, quota, push, pushCard });
  assert.deepEqual([r.quotaNotified, pushed.length], [194, 3]);
  assert.match(pushed[2], /ここまでです/);
  r = await runMonitor(env, { now: oct + 3600000, probe: up, status, quota, push, pushCard });
  assert.equal(pushed.length, 3);
  const st = JSON.parse(env.BOOKING_KV.store.get('monitor_state'));
  assert.deepEqual([st.quotaWarnedMonth, st.quotaEndedMonth], ['2026-10', '2026-10']);
});

test('monitor: 上限は LINE の答えに合わせる(5,000 通なら 4,960 で ⚠️・4,990 で終わり)。上限なしのプランは見張らない', async () => {
  const env = baseEnv();
  const pushed = [];
  const push = async (_t, _to, text) => { pushed.push(text); };
  const cards = [];
  const pushCard = async (_t, _to, msgs) => { cards.push(msgs[0]); pushed.push(msgs[0].altText); };
  const status = async () => ({ reachable: false });
  let q = { usage: 190, limit: 5000 };
  const quota = async () => q;
  let r = await runMonitor(env, { now: T0, probe: up, status, quota, push, pushCard });
  assert.deepEqual([r.quotaNotified, pushed.length], [null, 0], '200 通の境目では鳴らさない');
  q = { usage: 4960, limit: 5000 };
  r = await runMonitor(env, { now: T0 + 3600000, probe: up, status, quota, push, pushCard });
  assert.equal(r.quotaNotified, 4960);
  assert.match(pushed[0], /あと 40 通です\(4960\/5000 通\)/);
  q = { usage: 4990, limit: 5000 };
  r = await runMonitor(env, { now: T0 + 7200000, probe: up, status, quota, push, pushCard });
  assert.match(pushed[1], /ここまでです\(4990\/5000 通/);
  const env2 = baseEnv();
  q = { usage: 99999, limit: Infinity };
  r = await runMonitor(env2, { now: T0, probe: up, status, quota, push, pushCard });
  assert.deepEqual([r.quotaNotified, pushed.length], [null, 2]);
});

test('monitor: 通数の知らせはカードで送る。OFF にするボタンは「つうちおふ」を送り、もう止めていれば出さない。400 で弾かれたらテキストで', async () => {
  const status = async () => ({ reachable: false });
  const quota = async () => ({ usage: 160, limit: 200 });
  const find = (o, pred, out = []) => { if (o && typeof o === 'object') { if (pred(o)) out.push(o); Object.values(o).forEach((v) => find(v, pred, out)); } return out; };
  // ON のとき: ボタンあり。戻る日は翌月 1 日(T0 は 9/13 → 10/1(木) 9:00)
  let env = baseEnv();
  let cards = [];
  const texts = [];
  const push = async (_t, _to, text) => { texts.push(text); };
  let pushCard = async (_t, _to, msgs) => { cards.push(msgs[0]); };
  await runMonitor(env, { now: T0, probe: up, status, quota, push, pushCard });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].type, 'flex');
  assert.match(cards[0].altText, /10\/1\(木\) 9:00 まで/);
  assert.deepEqual(find(cards[0], (o) => o.type === 'message').map((a) => a.text), ['つうちおふ']);
  assert.ok(JSON.stringify(cards[0]).includes('あと 40 通で、10/1(木) まで通知が止まります'));
  // もう OFF のとき: ボタンなし
  env = baseEnv();
  await env.BOOKING_KV.put('notify_switch', JSON.stringify({ enabled: false, at: T0 }));
  cards = [];
  await runMonitor(env, { now: T0, probe: up, status, quota, push, pushCard });
  assert.equal(find(cards[0], (o) => o.type === 'message').length, 0);
  assert.match(cards[0].altText, /すでに止めています/);
  // 400 → テキストで送り直す。429 → 持ち越し
  env = baseEnv();
  pushCard = async () => { const e = new Error('LINE push失敗: HTTP 400'); e.status = 400; throw e; };
  let r = await runMonitor(env, { now: T0, probe: up, status, quota, push, pushCard });
  assert.deepEqual([r.sent, r.pending, texts.length], [1, 0, 1]);
  assert.match(texts[0], /あと 40 通です/);
  env = baseEnv();
  pushCard = async () => { const e = new Error('LINE push失敗: HTTP 429'); e.status = 429; throw e; };
  r = await runMonitor(env, { now: T0, probe: up, status, quota, push, pushCard });
  assert.deepEqual([r.sent, r.pending, texts.length], [0, 1, 1]);
});

test('monitor: fetchLineQuotaLimit は value を返す(none は Infinity)。fetchLineQuota は上限が読めなければ 200 として続ける', async () => {
  const orig = globalThis.fetch;
  try {
    let quotaRes = { ok: true, json: async () => ({ type: 'limited', value: 5000 }) };
    globalThis.fetch = async (u) => (String(u).endsWith('/quota') ? quotaRes : { ok: true, json: async () => ({ totalUsage: 136 }) });
    assert.equal(await fetchLineQuotaLimit('tok'), 5000);
    assert.deepEqual(await fetchLineQuota('tok'), { usage: 136, limit: 5000 });
    quotaRes = { ok: true, json: async () => ({ type: 'none' }) };
    assert.equal(await fetchLineQuotaLimit('tok'), Infinity);
    quotaRes = { ok: false, status: 500 };
    await assert.rejects(fetchLineQuotaLimit('tok'), /HTTP 500/);
    assert.deepEqual(await fetchLineQuota('tok'), { usage: 136, limit: 200 });
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    await assert.rejects(fetchLineQuota('tok'), /HTTP 401/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('monitor: fetchLineQuotaUsage は totalUsage を返す。HTTP エラー・形式の不備は例外', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (u, init) => {
      assert.equal(String(u), 'https://api.line.me/v2/bot/message/quota/consumption');
      assert.equal(init.headers.authorization, 'Bearer tok');
      return new Response(JSON.stringify({ totalUsage: 136 }), { status: 200 });
    };
    assert.equal(await fetchLineQuotaUsage('tok'), 136);
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    await assert.rejects(fetchLineQuotaUsage('tok'), /HTTP 401/);
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    await assert.rejects(fetchLineQuotaUsage('tok'), /totalUsage/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
