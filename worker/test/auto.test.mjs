import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  handleAuto, verifyAutoRequest, pruneExclusions, addExcludedSlots, loadExclusions, autoStatus, signAutoData, verifyAutoData,
  buildAutoSettingsReply, handleAutoPostback, slotKeyOf, ALIVE_WITHIN_MS, MSG_AUTO_EXPIRED, MSG_AUTO_BAD_DATE, AUTO_COMMAND_TEXT,
  MSG_AUTO_BAD_SLOT, START_HOURS, snapStartHHMM, addAllowedSlot, addExcludedDate,
} from '../src/auto.js';
import { buildPostbackReply } from '../src/index.js';
import { MSG_AUTO_UNAVAILABLE } from '../src/messages.js';
import { handleAutoSwitchCommand, loadAutoSwitch, AUTO_ON_TEXT, AUTO_OFF_TEXT, handleNotifySwitchCommand, loadNotifySwitch } from '../src/auto.js';
import { signCancelToken } from '../src/cancel-token.js';
import { runMonitor, AUTO_STALL_MS, PROBE_ATTEMPTS as MONITOR_PROBE_ATTEMPTS } from '../src/monitor.js';
import { pickTextCommandEvents } from '../src/line.js';

const require = createRequire(import.meta.url);
// Actions / Pi 側の署名実装(Node crypto)。Worker(Web Crypto)と相互に検証できることを確かめる
const { signRequest } = require('../../lib/auto-client.js');
const { slotKey, pruneExclusions: libPrune } = require('../../lib/auto-rules.js');

const SECRET = 'test-signing-secret';
const NOW = Date.parse('2026-09-14T01:00:00Z'); // JST 9/14(月) 10:00
function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    store,
  };
}
const ctx = { waitUntil() {} };
// Pi の /auto/status をトンネル越しに聞く fetch を差し替える。status が null なら「届かない」
function withPiStatus(status, fn) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (u) => {
    calls.push(String(u));
    if (status === null) throw new TypeError('fetch failed');
    if (status === 'http530') return new Response('error', { status: 530 });
    return Response.json(status, { status: 200 });
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      globalThis.fetch = realFetch;
    });
}
const envOf = (kv = fakeKV()) => ({ BOOKING_SIGNING_SECRET: SECRET, BOOKING_KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_GROUP_ID: 'C1', LABEL_A: 'ゆう', SITE_USER_A: 'u', SITE_PASS_A: 'p' });
const signed = (method, path, payload, ts = Date.now()) => {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const headers = { ...signRequest(SECRET, { method, path, body, ts }) };
  if (body) headers['content-type'] = 'application/json';
  return new Request(`https://w.example${path}`, { method, headers, body: body || undefined });
};
function texts(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (node && typeof node === 'object') {
    if ((node.type === 'text' || node.type === 'span') && typeof node.text === 'string') out.push(node.text);
    Object.values(node).forEach((v) => texts(v, out));
  }
  return out;
}
function actions(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => actions(n, out));
  else if (node && typeof node === 'object') {
    if (node.action && typeof node.action === 'object') out.push(node.action);
    Object.values(node).forEach((v) => actions(v, out));
  }
  return out;
}

test('署名: Actions/Pi(Node crypto)の signRequest を Worker(Web Crypto)で検証できる。時刻のずれ・改ざん・別の鍵は弾く', async () => {
  const ts = NOW;
  const h = signRequest(SECRET, { method: 'POST', path: '/auto/heartbeat', body: '{"active":true}', ts });
  const args = { method: 'POST', path: '/auto/heartbeat', body: '{"active":true}', ts: h['x-booking-ts'], auth: h['x-booking-auth'] };
  assert.equal(await verifyAutoRequest(SECRET, args, NOW), true);
  assert.equal(await verifyAutoRequest(SECRET, args, NOW + 6 * 60 * 1000), false, '5 分より古い');
  assert.equal(await verifyAutoRequest(SECRET, { ...args, body: '{"active":false}' }, NOW), false, '本文の改ざん');
  assert.equal(await verifyAutoRequest(SECRET, { ...args, path: '/auto/state' }, NOW), false, 'パスの改ざん');
  assert.equal(await verifyAutoRequest('other', args, NOW), false);
  assert.equal(await verifyAutoRequest(SECRET, { ...args, auth: '' }, NOW), false);
});

test('API: 認証なしは 401。heartbeat は KV に書かず除外一覧だけ返す。/auto/state は Pi の /auto/status を直接聞いて生存を判定する', async () => {
  const env = envOf();
  const r401 = await handleAuto(new Request('https://w.example/auto/state'), env, ctx);
  assert.equal(r401.status, 401);
  assert.equal(await handleAuto(new Request('https://w.example/webhook', { method: 'POST' }), env, ctx), null, '他のパスは触らない');

  // URL 登録が無い = Pi が止まっている
  const s0 = await (await handleAuto(signed('GET', '/auto/state', undefined, NOW), env, ctx, { now: NOW })).json();
  assert.deepEqual([s0.registered, s0.alive, s0.active, s0.dates, s0.slots], [false, false, false, [], []]);

  // heartbeat は除外一覧を返すだけで KV には書かない
  const before = [...env.BOOKING_KV.store.keys()];
  const hb = await handleAuto(signed('POST', '/auto/heartbeat', { active: true, mode: 'on', at: NOW }, NOW), env, ctx, { now: NOW });
  assert.equal(hb.status, 200);
  assert.deepEqual([(await hb.json()).dates, [...env.BOOKING_KV.store.keys()]], [[], before], 'KV の書き込みなし');

  env.BOOKING_KV.store.set('booking_url', 'https://abc.trycloudflare.com');
  // Pi が on で 1 分前に照会
  await withPiStatus({ mode: 'on', active: true, startedAt: NOW - 3600000, lastCycle: { at: NOW - 60000 } }, async (calls) => {
    const s1 = await (await handleAuto(signed('GET', '/auto/state', undefined, NOW), env, ctx, { now: NOW })).json();
    assert.deepEqual([s1.registered, s1.reachable, s1.alive, s1.active, s1.mode], [true, true, true, true, 'on']);
    assert.equal(calls[0], 'https://abc.trycloudflare.com/auto/status');
  });
  // dry-run は alive だが active=false
  await withPiStatus({ mode: 'dry-run', active: false, lastCycle: { at: NOW - 60000 } }, async () => {
    const s2 = await autoStatus(env, NOW);
    assert.deepEqual([s2.alive, s2.active, s2.mode], [true, false, 'dry-run']);
  });
  // 最後の照会が 5 分より古い = 照会ループが止まっている
  await withPiStatus({ mode: 'on', active: true, lastCycle: { at: NOW - ALIVE_WITHIN_MS - 1000 } }, async () => {
    const s3 = await autoStatus(env, NOW);
    assert.deepEqual([s3.reachable, s3.alive, s3.active], [true, false, false]);
  });
  // off なら alive ではない
  await withPiStatus({ mode: 'off', active: false, lastCycle: null }, async () => {
    assert.equal((await autoStatus(env, NOW)).alive, false);
  });
  // トンネル越しに届かない(瞬断は 2 回試す)
  await withPiStatus(null, async (calls) => {
    const s4 = await autoStatus(env, NOW, { retryMs: 0 });
    assert.deepEqual([s4.registered, s4.reachable, s4.alive], [true, false, false]);
    assert.match(s4.reason, /届きません/);
    assert.equal(calls.length, 2);
  });
  await withPiStatus('http530', async () => {
    assert.equal((await autoStatus(env, NOW, { retryMs: 0 })).alive, false);
  });
});

test('API: /auto/exclusions で Pi が手放した枠を登録できる(公園名・終了時刻を補い、重複は 1 件)', async () => {
  const env = envOf();
  const future = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const r = await handleAuto(
    signed('POST', '/auto/exclusions', { addSlots: [{ park: '1160', date: future, start: '13:00', reason: 'released' }, { facility: '大島小松川公園', date: future, start: '13:00', end: '15:00' }, { park: '9999', date: future, start: '09:00' }] }),
    env,
    ctx
  );
  const ex = await r.json();
  assert.equal(ex.slots.length, 1, '同じ枠は 1 件、知らない公園は無視');
  assert.deepEqual(ex.slots[0], { ...ex.slots[0], park: '1160', facility: '大島小松川公園', start: '13:00', end: '15:00', reason: 'released' });
  assert.equal(slotKeyOf(ex.slots[0]), `1160|${future}|13:00`);
  assert.equal(slotKeyOf(ex.slots[0]), slotKey(ex.slots[0]), 'lib/auto-rules.js の枠キーと同じ');
});

test('除外一覧の掃除: 過ぎた日・開始時刻を過ぎた枠は落ちる(lib/auto-rules.js と同じ結果)', () => {
  const now = Date.parse('2026-09-14T05:30:00Z'); // JST 14:30
  const ex = {
    dates: ['2026-09-13', '2026-09-14', '2026-09-20', '2026-09-20', 'bad'],
    slots: [
      { park: '1040', date: '2026-09-14', start: '13:00', facility: '猿江恩賜公園' },
      { park: '1040', date: '2026-09-14', start: '15:00', facility: '猿江恩賜公園' },
      { park: '1160', date: '2026-09-13', start: '09:00', facility: '大島小松川公園' },
    ],
  };
  const w = pruneExclusions(ex, now);
  assert.deepEqual(w.dates, ['2026-09-14', '2026-09-20']);
  assert.deepEqual(w.slots.map((s) => `${s.date} ${s.start}`), ['2026-09-14 15:00']);
  const l = libPrune({ dates: ex.dates.filter((d) => d !== 'bad'), slots: ex.slots }, now);
  assert.deepEqual(l.dates, w.dates);
  assert.deepEqual(l.slots.map((s) => `${s.date} ${s.start}`), w.slots.map((s) => `${s.date} ${s.start}`));
});

test('キャンセル成功 → その枠が除外枠に載る(返信より前に KV へ)。失敗なら載せない', async () => {
  const env = envOf();
  const future = new Date(NOW + 10 * 86400000).toISOString().slice(0, 10);
  const yes = await signCancelToken(SECRET, { kind: 'y', person: 'A', id: '2026000123', date: future, start: '17:00', end: '19:00', facility: '大島小松川公園', penaltyDay: 3, exp: Math.floor(NOW / 1000) + 600 });
  const env2 = { ...env, CANCEL_ENABLED: '1' };
  let kvAtCancel = null;
  const order = [];
  const cancel = async () => {
    order.push('cancel');
    kvAtCancel = env.BOOKING_KV.store.get('auto_exclusions') || null;
    return { status: 'success', reservation: { id: '2026000123' } };
  };
  const reply = await buildPostbackReply(env2, yes, { now: NOW, cancel });
  assert.match(reply.text, /キャンセルしました/);
  assert.equal(kvAtCancel, null, '取消 POST の時点では未登録');
  const ex = await loadExclusions(env, NOW);
  assert.equal(ex.slots.length, 1);
  assert.deepEqual([ex.slots[0].park, ex.slots[0].date, ex.slots[0].start, ex.slots[0].end, ex.slots[0].reason], ['1160', future, '17:00', '19:00', 'cancel']);

  const env3 = envOf();
  await buildPostbackReply({ ...env3, CANCEL_ENABLED: '1' }, yes, { now: NOW, cancel: async () => ({ status: 'failed' }) });
  assert.equal((await loadExclusions(env3, NOW)).slots.length, 0);
});

test('「せってい」カード: スイッチ 2 つ(ON/OFF ボタン)・除外日(解除)・除外枠(解除)・日を追加(datetimepicker)。postback の data は署名付きで 300 文字以内', async () => {
  const env = envOf();
  const d = new Date(NOW + 13 * 86400000).toISOString().slice(0, 10);
  await addExcludedSlots(env, [{ park: '1160', date: d, start: '13:00', reason: 'cancel' }], NOW);
  env.BOOKING_KV.store.set('auto_exclusions', JSON.stringify({ ...(await loadExclusions(env, NOW)), dates: [d] }));
  env.BOOKING_KV.store.set('booking_url', 'https://abc.trycloudflare.com');

  const reply = await withPiStatus({ mode: 'on', active: true, lastCycle: { at: NOW } }, () => buildAutoSettingsReply(env, { now: NOW + 1000 }));
  const t = texts(reply.flex.contents);
  assert.ok(t.includes('⚙️ 設定'));
  assert.ok(t.some((s) => s.includes('稼働中')));
  assert.equal(t.filter((s) => s === 'ON').length, 2, '自動予約・空き通知カードとも ON');
  assert.ok(t.some((s) => s.includes('大島小松川公園') && s.includes('キャンセル済み')));
  const acts = actions(reply.flex.contents);
  const picker = acts.find((a) => a.type === 'datetimepicker' && a.mode === 'date');
  assert.equal(picker.mode, 'date');
  assert.equal(picker.min, '2026-09-14');
  assert.equal(picker.max, '2026-10-19');
  const removes = acts.filter((a) => a.type === 'postback' && a.label === '解除');
  assert.equal(removes.length, 2, '除外日 1 + 除外枠 1');
  for (const a of [picker, ...removes]) {
    assert.ok(a.data.length <= 300);
    const v = await verifyAutoData(SECRET, a.data, NOW + 1000);
    assert.ok(v && !v.expired, `署名が正しい: ${a.data}`);
  }
  assert.ok(new TextEncoder().encode(JSON.stringify(reply.flex.contents)).length < 28000);
  assert.match(reply.text, /除外日: /);
  // ぶら下がる「更新」はメッセージアクションで「せってい」
  assert.ok(acts.some((a) => a.type === 'message' && a.text === 'せってい'));
  // スイッチのボタンは message アクション(署名・期限なし)。どちらも ON なので「OFF にする」が 2 つ
  const offs = acts.filter((a) => a.type === 'message' && a.label === 'OFF にする');
  assert.deepEqual(offs.map((a) => a.text), ['じどうおふ', 'つうちおふ']);
  assert.equal(acts.filter((a) => a.type === 'message' && a.label === 'ON にする').length, 0);
  assert.match(reply.text, /^⚙️ 設定/);
  assert.match(reply.text, /「じどうおん」「じどうおふ」/, 'テキスト版はボタンが無いので合言葉を添える');
});

test('「せってい」postback: 日を追加(params.date)・除外日の解除・除外枠の解除。期限切れ・範囲外・署名不正', async () => {
  const env = envOf();
  const exp = Math.floor(NOW / 1000) + 3600;
  const add = await signAutoData(SECRET, 'a', '-', exp);
  const r1 = await buildPostbackReply(env, add, { now: NOW, params: { date: '2026-09-27' } });
  assert.ok(texts(r1.flex.contents).some((s) => s.includes('9/27(日) を除外日に追加しました')));
  assert.deepEqual((await loadExclusions(env, NOW)).dates, ['2026-09-27']);
  assert.deepEqual(await buildPostbackReply(env, add, { now: NOW, params: { date: '2026-09-13' } }), { text: MSG_AUTO_BAD_DATE }, '過去の日');
  assert.deepEqual(await buildPostbackReply(env, add, { now: NOW, params: { date: '2026-12-01' } }), { text: MSG_AUTO_BAD_DATE }, '遠すぎる日');

  const del = await signAutoData(SECRET, 'd', '20260927', exp);
  const r2 = await buildPostbackReply(env, del, { now: NOW });
  assert.ok(texts(r2.flex.contents).some((s) => s.includes('9/27(日) の除外を解除しました')));
  assert.deepEqual((await loadExclusions(env, NOW)).dates, []);

  await addExcludedSlots(env, [{ park: '1040', date: '2026-09-25', start: '19:00' }], NOW);
  const rs = await signAutoData(SECRET, 's', '1040_20260925_1900', exp);
  const r3 = await buildPostbackReply(env, rs, { now: NOW });
  assert.ok(texts(r3.flex.contents).some((s) => s.includes('猿江恩賜公園 の除外を解除しました')));
  assert.equal((await loadExclusions(env, NOW)).slots.length, 0);

  const expired = await signAutoData(SECRET, 'a', '-', Math.floor(NOW / 1000) - 1);
  assert.deepEqual(await buildPostbackReply(env, expired, { now: NOW, params: { date: '2026-09-27' } }), { text: MSG_AUTO_EXPIRED });
  assert.equal(await buildPostbackReply(env, 'x|a|-|1.zzzzzzzzzzzzzzzzzzzzzz', { now: NOW }), null, '署名不正は無視');
  assert.deepEqual(await buildPostbackReply({ ...env, BOOKING_KV: undefined }, add, { now: NOW }), { text: MSG_AUTO_UNAVAILABLE });
});

test('「せってい」の抽出は pickTextCommandEvents で(「よやく」と同じ条件)。旧合言葉「じどう」は拾わない', () => {
  const ev = (text) => ({ type: 'message', replyToken: 'rt', source: { type: 'group', groupId: 'C1' }, message: { type: 'text', text } });
  const raw = JSON.stringify({ events: [ev('せってい'), ev(' せってい '), ev('よやく'), ev('せってい!'), ev('じどう')] });
  assert.equal(AUTO_COMMAND_TEXT, 'せってい');
  assert.equal(pickTextCommandEvents(raw, 'C1', [AUTO_COMMAND_TEXT]).length, 2);
  assert.equal(pickTextCommandEvents(raw, 'C1', ['よやく']).length, 1);
});

test('生存監視: Pi は動いているのに自動予約の照会が 15 分以上止まっていれば 1 回知らせ、戻れば 1 回知らせる(起動直後は判定しない)', async () => {
  const env = envOf();
  env.BOOKING_KV.store.set('booking_url', 'https://abc.trycloudflare.com');
  const pushed = [];
  const push = async (_t, _to, text) => pushed.push(text);
  const up = async () => ({ ok: true });
  const started = NOW - 3600000;
  let r = await withPiStatus({ mode: 'on', startedAt: started, lastCycle: { at: NOW } }, () => runMonitor(env, { now: NOW + 60000, probe: up, push }));
  assert.equal(r.autoNotified, null);
  r = await withPiStatus({ mode: 'on', startedAt: started, lastCycle: { at: NOW } }, () => runMonitor(env, { now: NOW + AUTO_STALL_MS + 60000, probe: up, push }));
  assert.equal(r.autoNotified, 'stalled');
  assert.match(pushed[0], /自動予約の空きチェックが止まっています/);
  r = await withPiStatus({ mode: 'on', startedAt: started, lastCycle: { at: NOW } }, () => runMonitor(env, { now: NOW + AUTO_STALL_MS + 120000, probe: up, push }));
  assert.equal(r.autoNotified, null, '連続では鳴らさない');
  const t2 = NOW + AUTO_STALL_MS + 180000;
  r = await withPiStatus({ mode: 'on', startedAt: started, lastCycle: { at: t2 - 10000 } }, () => runMonitor(env, { now: t2, probe: up, push }));
  assert.equal(r.autoNotified, 'resumed');
  assert.equal(pushed.length, 2);
  // dry-run / off、起動直後(初回の照会前)、Pi に届かないときは鳴らさない
  const env2 = envOf();
  env2.BOOKING_KV.store.set('booking_url', 'https://abc.trycloudflare.com');
  assert.equal((await withPiStatus({ mode: 'dry-run', startedAt: started, lastCycle: null }, () => runMonitor(env2, { now: NOW + 3600000, probe: up, push }))).autoNotified, null);
  assert.equal((await withPiStatus({ mode: 'on', startedAt: NOW, lastCycle: null }, () => runMonitor(env2, { now: NOW + 60000, probe: up, push }))).autoNotified, null, '起動直後');
  assert.equal((await withPiStatus(null, () => runMonitor(env2, { now: NOW + 3600000, probe: up, push }))).autoNotified, null, '届かない');
  assert.equal(MONITOR_PROBE_ATTEMPTS, 4);
});

test('「じどうおふ」「じどうおん」: KV のスイッチを切り替え、heartbeat と /auto/state に enabled が載る。カードに結果を添える', async () => {
  const env = envOf();
  env.BOOKING_KV.store.set('booking_url', 'https://abc.trycloudflare.com');
  assert.equal((await loadAutoSwitch(env)).enabled, true, '既定は ON');
  // OFF
  const off = await withPiStatus({ mode: 'on', active: true, lastCycle: { at: NOW } }, () => handleAutoSwitchCommand(env, false, { now: NOW }));
  assert.ok(texts(off.flex.contents).some((s) => s.includes('自動予約を OFF にしました')));
  assert.ok(texts(off.flex.contents).some((s) => s.includes('停止中')), '自動予約の行が停止中の説明');
  assert.ok(texts(off.flex.contents).includes('OFF'), 'スイッチが OFF 表示');
  assert.ok(actions(off.flex.contents).some((a) => a.type === 'message' && a.label === 'ON にする' && a.text === AUTO_ON_TEXT), 'ボタンは「ON にする」(じどうおん)');
  assert.equal((await loadAutoSwitch(env)).enabled, false);
  const hb = await (await handleAuto(signed('POST', '/auto/heartbeat', { active: true, mode: 'on' }, NOW), env, ctx, { now: NOW })).json();
  assert.equal(hb.enabled, false, 'Pi は heartbeat の応答で受け取る');
  // Pi が paused を申告 → alive だが active=false
  await withPiStatus({ mode: 'paused', active: false, lastCycle: { at: NOW } }, async () => {
    const st = await (await handleAuto(signed('GET', '/auto/state', undefined, NOW), env, ctx, { now: NOW })).json();
    assert.deepEqual([st.alive, st.active, st.mode, st.enabled], [true, false, 'paused', false]);
  });
  // ON(Pi の .env が dry-run なら注意書き)
  const on = await withPiStatus({ mode: 'dry-run', active: false, lastCycle: { at: NOW } }, () => handleAutoSwitchCommand(env, true, { now: NOW }));
  assert.ok(texts(on.flex.contents).some((s) => s.includes('自動予約を ON にしました') && s.includes('dry-run')));
  assert.equal((await loadAutoSwitch(env)).enabled, true);
  // 合言葉の抽出
  const ev = (text) => ({ type: 'message', replyToken: 'rt', source: { type: 'group', groupId: 'C1' }, message: { type: 'text', text } });
  const raw = JSON.stringify({ events: [ev('じどうおん'), ev('じどうおふ'), ev('せってい'), ev('じどう おん')] });
  assert.equal(pickTextCommandEvents(raw, 'C1', [AUTO_COMMAND_TEXT, AUTO_ON_TEXT, AUTO_OFF_TEXT]).length, 3);
});

test('「つうちおふ」「つうちおん」: 空き通知のスイッチを KV に持ち、/auto/state と heartbeat に notifyEnabled が載る。カードに状態行が出る', async () => {
  const env = envOf();
  assert.equal((await loadNotifySwitch(env)).enabled, true, '既定は届く');
  const off = await withPiStatus(null, () => handleNotifySwitchCommand(env, false, { now: NOW }));
  assert.ok(texts(off.flex.contents).some((s) => s.includes('空き通知を OFF にしました')));
  assert.ok(texts(off.flex.contents).some((s) => s.includes('止めています')));
  assert.ok(actions(off.flex.contents).some((a) => a.type === 'message' && a.label === 'ON にする' && a.text === 'つうちおん'), 'ボタンは「ON にする」(つうちおん)');
  assert.equal((await loadNotifySwitch(env)).enabled, false);
  const st = await (await handleAuto(signed('GET', '/auto/state', undefined, NOW), env, ctx, { now: NOW })).json();
  assert.equal(st.notifyEnabled, false);
  const hb = await (await handleAuto(signed('POST', '/auto/heartbeat', { active: true, mode: 'on' }, NOW), env, ctx, { now: NOW })).json();
  assert.equal(hb.notifyEnabled, false);
  const on = await withPiStatus(null, () => handleNotifySwitchCommand(env, true, { now: NOW }));
  assert.ok(texts(on.flex.contents).some((s) => s.includes('空き通知を ON にしました')));
  assert.equal((await loadNotifySwitch(env)).enabled, true);
  assert.match(on.text, /空き通知カード: ON/);
});

test('POST /auto/tennisbear(2026-09-24): その人のテニスベアの予定を公園コード付きで返す。未設定は configured:false、失敗は 502、person 不正は 400。イベント名は返さない', async () => {
  const env = { ...envOf(), TB_EMAIL_A: 'a@example.com', TB_PASS_A: 'pw' };
  const calls = [];
  const fetchEvents = async ({ email, password }, { log }) => {
    calls.push(email);
    log('GET events/me/future 200 100ms');
    if (email === 'fail@example.com') throw new Error('down');
    return [
      { source: 'tennisbear', id: '1', title: '秘密のイベント名', date: '2026-09-27', start: '11:00', end: '13:00', facility: '亀戸中央公園', placeCode: '0100010009', lat: 1, lng: 2, organizer: false },
      { source: 'tennisbear', id: '2', title: 'x', date: '2026-09-28', start: '19:00', end: '', facility: '有明テニスの森 A', placeCode: '9999999999', lat: null, lng: null, organizer: true },
      { source: 'tennisbear', id: '3', title: 'y', date: '2026-09-29', start: '09:00', end: '11:00', facility: '大島小松川公園Ａ', placeCode: '', lat: null, lng: null, organizer: true },
    ];
  };
  const r = await handleAuto(signed('POST', '/auto/tennisbear', { person: 'A' }, NOW), env, ctx, { now: NOW, fetchEvents });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.configured, true);
  assert.deepEqual(body.events, [
    { source: 'tennisbear', date: '2026-09-27', start: '11:00', end: '13:00', park: '1050', facility: '亀戸中央公園' },
    { source: 'tennisbear', date: '2026-09-28', start: '19:00', end: '', park: null, facility: '有明テニスの森 A' },
    { source: 'tennisbear', date: '2026-09-29', start: '09:00', end: '11:00', park: '1160', facility: '大島小松川公園Ａ' },
  ]);
  assert.ok(!JSON.stringify(body).includes('秘密のイベント名'), 'イベント名は返さない');
  assert.deepEqual(calls, ['a@example.com']);
  // B は未設定
  const rb = await (await handleAuto(signed('POST', '/auto/tennisbear', { person: 'B' }, NOW), env, ctx, { now: NOW, fetchEvents })).json();
  assert.deepEqual(rb, { person: 'B', configured: false, events: [] });
  assert.deepEqual(calls, ['a@example.com'], '未設定なら取りに行かない');
  // 失敗は 502
  const envFail = { ...env, TB_EMAIL_A: 'fail@example.com' };
  const rf = await handleAuto(signed('POST', '/auto/tennisbear', { person: 'A' }, NOW), envFail, ctx, { now: NOW, fetchEvents });
  assert.equal(rf.status, 502);
  assert.match((await rf.json()).error, /テニスベアの予定を取得できませんでした/);
  // person 不正・認証なし
  assert.equal((await handleAuto(signed('POST', '/auto/tennisbear', { person: 'C' }, NOW), env, ctx, { now: NOW, fetchEvents })).status, 400);
  assert.equal((await handleAuto(new Request('https://w.example/auto/tennisbear', { method: 'POST', body: '{"person":"A"}' }), env, ctx, { now: NOW, fetchEvents })).status, 401);
});

test('GET /auto/plans(2026-09-27): A・B の都の予約とテニスベアの予定を 1 本にして返す(公園コード・呼び名付き)。取れなかった人は failed に名前。配線が無ければ plans:null。イベント名は返さない', async () => {
  const { buildPlans } = await import('../src/auto.js');
  const env = { ...envOf(), LABEL_B: 'まき', SITE_USER_B: 'u2', SITE_PASS_B: 'p2' };
  const fetchResults = async () => [
    { slot: 'A', label: 'ゆう', reservations: [
      { id: '1', date: '2026-09-27', start: '13:00', end: '15:00', facility: '猿江恩賜公園' },
      { id: '2', date: '2026-10-03', start: '09:00', end: '11:00', facility: '有明テニスの森公園' },
      { id: '3', date: '', start: '', end: '', facility: '壊れた行' },
    ] },
    { slot: 'B', label: 'まき', error: new Error('timeout') },
  ];
  const fetchTb = async () => [
    { slot: 'A', events: [{ source: 'tennisbear', id: '9', title: '秘密のイベント名', date: '2026-09-28', start: '18:00', end: '', facility: '亀戸中央公園', placeCode: '0100010009' }] },
    { slot: 'B', events: [{ source: 'tennisbear', id: '8', title: 'x', date: '2026-09-26', start: '10:00', end: '12:00', facility: '有明テニスの森 A', placeCode: '9999999999' }] },
  ];
  const r = await handleAuto(signed('GET', '/auto/plans', undefined, NOW), env, ctx, { now: NOW, fetchResults, fetchTb });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.plans, [
    { person: 'B', label: 'まき', source: 'tennisbear', date: '2026-09-26', start: '10:00', end: '12:00', park: null, facility: '有明テニスの森 A' },
    { person: 'A', label: 'ゆう', source: 'site', date: '2026-09-27', start: '13:00', end: '15:00', park: '1040', facility: '猿江恩賜公園' },
    { person: 'A', label: 'ゆう', source: 'tennisbear', date: '2026-09-28', start: '18:00', end: '', park: '1050', facility: '亀戸中央公園' },
    { person: 'A', label: 'ゆう', source: 'site', date: '2026-10-03', start: '09:00', end: '11:00', park: null, facility: '有明テニスの森公園' },
  ]);
  assert.deepEqual(body.failed, ['まき(都の予約)']);
  assert.ok(!JSON.stringify(body).includes('秘密のイベント名'), 'イベント名は返さない');
  // 都の取得そのものが例外 → テニスベアの分だけ返し、failed に「都の予約」
  const r2 = await (await handleAuto(signed('GET', '/auto/plans', undefined, NOW), env, ctx, { now: NOW, fetchResults: async () => { throw new Error('down'); }, fetchTb })).json();
  assert.equal(r2.plans.length, 2);
  assert.deepEqual(r2.failed, ['都の予約']);
  // 配線が無い(index.js 以外から呼んだ)→ plans:null(Actions は従来どおり全部通知する)
  const r3 = await (await handleAuto(signed('GET', '/auto/plans', undefined, NOW), env, ctx, { now: NOW })).json();
  assert.equal(r3.plans, null);
  // 認証なしは 401
  assert.equal((await handleAuto(new Request('https://w.example/auto/plans'), env, ctx)).status, 401);
  // buildPlans 単体: 空でも壊れない
  assert.deepEqual(buildPlans([], []), { plans: [], failed: [] });
});

test('対象に追加した枠(2026-10-25): 日時ピッカー(b)→ 公園を選ぶカード(t)で追加、カードに一覧と「解除」(u)。除外枠とは両立せず除外日とは両立する。過ぎた枠・範囲外は断る', async () => {
  const env = envOf();
  env.BOOKING_KV.store.set('booking_url', 'https://abc.trycloudflare.com');
  assert.deepEqual(START_HOURS, [9, 11, 13, 15, 17, 19]);
  assert.deepEqual(['14:30', '08:10', '21:00', '11:00', '19:59'].map(snapStartHHMM), ['13:00', '09:00', '19:00', '11:00', '19:00']);

  const pi = { mode: 'on', active: true, lastCycle: { at: NOW } };
  const r0 = await withPiStatus(pi, () => buildAutoSettingsReply(env, { now: NOW }));
  const t0 = texts(r0.flex.contents);
  assert.ok(t0.includes('対象に追加した枠'));
  assert.ok(!t0.some((s) => s.includes('ペナルティ期間でも予約する日')), '日単位の旧機能は消えている');
  const pickers = actions(r0.flex.contents).filter((a) => a.type === 'datetimepicker');
  assert.deepEqual(pickers.map((a) => [a.label, a.mode]), [['＋ 追加', 'date'], ['＋ 追加', 'datetime']], '除外日・対象に追加した枠の見出しの右に「＋ 追加」');
  const add = pickers[1];
  assert.equal(actions(r0.flex.contents).filter((a) => a.type === 'message' && a.label.includes('更新')).length, 1, 'フッターは「更新」だけ');
  assert.ok(add.data.length <= 300);
  assert.equal((await verifyAutoData(SECRET, add.data, NOW)).kind, 'b');
  assert.match(r0.text, /対象に追加した枠: なし/);

  // 9/16(水) 14:30 を選ぶ → 13:00 の枠に丸めて、公園を選ぶカード(公園ごとのボタン、kind t)。KV にはまだ書かない
  const r1 = await buildPostbackReply(env, add.data, { now: NOW, params: { datetime: '2026-09-16T14:30' } });
  const t1 = texts(r1.flex.contents);
  assert.ok(t1.some((s) => s.includes('9/16(水) 13:00〜15:00')));
  assert.ok(t1.some((s) => s.includes('ペナルティ期間')), '+2 日なので警告');
  const parks = actions(r1.flex.contents).filter((a) => a.type === 'postback');
  assert.deepEqual(parks.map((a) => a.label), ['猿江恩賜公園', '亀戸中央公園', '大島小松川公園']);
  const v = await verifyAutoData(SECRET, parks[1].data, NOW);
  assert.deepEqual([v.kind, v.value], ['t', '1050_20260916_1300']);
  assert.deepEqual((await loadExclusions(env, NOW)).allowSlots, []);
  assert.match(r1.text, /9\/16\(水\) 13:00〜15:00/);

  // 亀戸を押す → KV の allowSlots に入り、設定カードに一覧(⚠ペナルティ期間)と「解除」(u)。heartbeat / state でも返る
  const r2 = await withPiStatus(pi, () => buildPostbackReply(env, parks[1].data, { now: NOW }));
  assert.ok(texts(r2.flex.contents).some((s) => s.includes('9/16(水) 13:00〜15:00 亀戸中央公園 を対象に追加しました') && s.includes('ペナルティ 1 点')));
  const ex2 = await loadExclusions(env, NOW);
  assert.deepEqual(ex2.allowSlots.map((s) => [slotKeyOf(s), s.end, s.facility]), [['1050|2026-09-16|13:00', '15:00', '亀戸中央公園']]);
  assert.ok(texts(r2.flex.contents).some((s) => s === '9/16(水) 13:00 亀戸中央公園'));
  assert.ok(texts(r2.flex.contents).includes('⚠ 取消にペナルティ'), 'ペナルティ期間の枠は 2 行目に小さく ⚠');
  const undo = actions(r2.flex.contents).filter((a) => a.type === 'postback' && a.label === '解除');
  assert.equal(undo.length, 1, '除外日・除外枠は無いので「解除」はこの 1 つ');
  assert.equal((await verifyAutoData(SECRET, undo[0].data, NOW)).kind, 'u');
  assert.match(r2.text, /対象に追加した枠: 9\/16\(水\) 13:00 亀戸中央公園/);
  const hb = await handleAuto(signed('POST', '/auto/heartbeat', { active: true }, NOW), env, ctx, { now: NOW });
  assert.deepEqual((await hb.json()).allowSlots.map(slotKeyOf), ['1050|2026-09-16|13:00']);
  const st = await withPiStatus(pi, () => handleAuto(signed('GET', '/auto/state', undefined, NOW), env, ctx, { now: NOW }));
  assert.deepEqual((await st.json()).allowSlots.map(slotKeyOf), ['1050|2026-09-16|13:00']);

  // 同じ枠がキャンセルで除外枠になったら対象からは外れる。逆に対象に追加したら除外枠からは外れる。除外日とは両立する(その日は除外でも、この枠だけは取る)
  await addExcludedSlots(env, [{ park: '1050', date: '2026-09-16', start: '13:00' }], NOW);
  assert.deepEqual(await loadExclusions(env, NOW).then((e) => [e.slots.map(slotKeyOf), e.allowSlots.map(slotKeyOf)]), [['1050|2026-09-16|13:00'], []]);
  await addAllowedSlot(env, { park: '1050', date: '2026-09-16', start: '13:00' }, NOW);
  assert.deepEqual(await loadExclusions(env, NOW).then((e) => [e.slots.map(slotKeyOf), e.allowSlots.map(slotKeyOf)]), [[], ['1050|2026-09-16|13:00']]);
  await addExcludedDate(env, '2026-09-16', NOW);
  assert.deepEqual(await loadExclusions(env, NOW).then((e) => [e.dates, e.allowSlots.map(slotKeyOf)]), [['2026-09-16'], ['1050|2026-09-16|13:00']]);
  // 同じ枠をもう一度足しても 1 つ
  await addAllowedSlot(env, { park: '1050', date: '2026-09-16', start: '13:00' }, NOW);
  assert.equal((await loadExclusions(env, NOW)).allowSlots.length, 1);

  // 「解除」→ 消える
  const r3 = await withPiStatus(pi, () => buildPostbackReply(env, undo[0].data, { now: NOW }));
  assert.ok(texts(r3.flex.contents).some((s) => s.includes('9/16(水) 13:00 亀戸中央公園 を対象から外しました')));
  assert.deepEqual((await loadExclusions(env, NOW)).allowSlots, []);

  // 断る: 丸めた枠がもう始まっている(今日 9:30 → 9:00 の枠。今は 10:00)・36 日先・日時なし。今日 11:00 は未来なので受け付ける
  assert.deepEqual(await buildPostbackReply(env, add.data, { now: NOW, params: { datetime: '2026-09-14T09:30' } }), { text: MSG_AUTO_BAD_SLOT });
  assert.deepEqual(await buildPostbackReply(env, add.data, { now: NOW, params: { datetime: '2026-10-20T09:00' } }), { text: MSG_AUTO_BAD_SLOT });
  assert.deepEqual(await buildPostbackReply(env, add.data, { now: NOW, params: null }), { text: MSG_AUTO_BAD_SLOT });
  assert.match((await buildPostbackReply(env, add.data, { now: NOW, params: { datetime: '2026-09-14T11:00' } })).text, /9\/14\(月\) 11:00〜13:00/);
  // 公園のボタンも同じ検査(古いカードから押した: 始まった枠・知らない公園)。期限切れは従来どおり
  const stale = await signAutoData(SECRET, 't', '1050_20260914_0900', Math.floor(NOW / 1000) + 3600);
  assert.deepEqual(await buildPostbackReply(env, stale, { now: NOW }), { text: MSG_AUTO_BAD_SLOT });
  const badPark = await signAutoData(SECRET, 't', '9999_20260916_1300', Math.floor(NOW / 1000) + 3600);
  assert.deepEqual(await buildPostbackReply(env, badPark, { now: NOW }), { text: MSG_AUTO_BAD_SLOT });
  assert.deepEqual(await buildPostbackReply(env, parks[1].data, { now: NOW + 2 * 3600 * 1000 }), { text: MSG_AUTO_EXPIRED });

  // 開始時刻を過ぎた枠は読むときに落ちる(Worker・lib とも)。古い形(allowDates だけ)の KV でも落ちない
  const raw = { dates: [], slots: [], allowSlots: [{ park: '1040', date: '2026-09-14', start: '09:00', end: '11:00', facility: '猿江恩賜公園' }, { park: '1040', date: '2026-09-14', start: '11:00', end: '13:00', facility: '猿江恩賜公園' }] };
  env.BOOKING_KV.store.set('auto_exclusions', JSON.stringify(raw));
  assert.deepEqual((await loadExclusions(env, NOW)).allowSlots.map(slotKeyOf), ['1040|2026-09-14|11:00']);
  assert.deepEqual(libPrune(raw, NOW).allowSlots.map(slotKey), ['1040|2026-09-14|11:00']);
  env.BOOKING_KV.store.set('auto_exclusions', JSON.stringify({ dates: [], slots: [], allowDates: ['2026-09-16'] }));
  assert.deepEqual((await loadExclusions(env, NOW)).allowSlots, []);
});
