import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  handleAuto, verifyAutoRequest, pruneExclusions, addExcludedSlots, loadExclusions, autoStatus, signAutoData, verifyAutoData,
  buildAutoSettingsReply, handleAutoPostback, slotKeyOf, ALIVE_WITHIN_MS, MSG_AUTO_EXPIRED, MSG_AUTO_BAD_DATE,
} from '../src/auto.js';
import { buildPostbackReply, MSG_AUTO_UNAVAILABLE } from '../src/index.js';
import { signCancelToken } from '../src/cancel-token.js';
import { runMonitor, AUTO_STALL_MS } from '../src/monitor.js';
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

test('API: 認証なしは 401。heartbeat で生存を記録して除外一覧を返し、/auto/state で Actions が生存と除外を読める', async () => {
  const env = envOf();
  const r401 = await handleAuto(new Request('https://w.example/auto/state'), env, ctx);
  assert.equal(r401.status, 401);
  assert.equal(await handleAuto(new Request('https://w.example/webhook', { method: 'POST' }), env, ctx), null, '他のパスは触らない');

  // Pi が生きていないときの state
  const s0 = await (await handleAuto(signed('GET', '/auto/state'), env, ctx)).json();
  assert.deepEqual([s0.alive, s0.active, s0.dates, s0.slots], [false, false, [], []]);

  // heartbeat(on)
  const hb = await handleAuto(signed('POST', '/auto/heartbeat', { active: true, mode: 'on', at: Date.now() }), env, ctx);
  assert.equal(hb.status, 200);
  const body = await hb.json();
  assert.deepEqual([body.dates, body.slots], [[], []]);
  const s1 = await (await handleAuto(signed('GET', '/auto/state'), env, ctx)).json();
  assert.deepEqual([s1.alive, s1.active, s1.mode], [true, true, 'on']);
  assert.equal(JSON.parse(env.BOOKING_KV.store.get('auto_mode')).mode, 'on');

  // dry-run の heartbeat は alive だが active=false
  await handleAuto(signed('POST', '/auto/heartbeat', { active: false, mode: 'dry-run' }), env, ctx);
  const s2 = await (await handleAuto(signed('GET', '/auto/state'), env, ctx)).json();
  assert.deepEqual([s2.alive, s2.active, s2.mode], [true, false, 'dry-run']);

  // 4 分より古い合図は死んでいる扱い
  const st = await autoStatus(env, Date.now() + ALIVE_WITHIN_MS + 1000);
  assert.equal(st.alive, false);
  assert.equal(st.active, false);
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

test('「じどう」カード: 状態・除外日(解除)・除外枠(解除)・日を追加(datetimepicker)。ボタンの data は署名付きで 300 文字以内', async () => {
  const env = envOf();
  const d = new Date(NOW + 13 * 86400000).toISOString().slice(0, 10);
  await addExcludedSlots(env, [{ park: '1160', date: d, start: '13:00', reason: 'cancel' }], NOW);
  env.BOOKING_KV.store.set('auto_exclusions', JSON.stringify({ ...(await loadExclusions(env, NOW)), dates: [d] }));
  await handleAuto(signed('POST', '/auto/heartbeat', { active: true, mode: 'on' }, NOW), env, ctx, { now: NOW });

  const reply = await buildAutoSettingsReply(env, { now: NOW + 1000 });
  const t = texts(reply.flex.contents);
  assert.ok(t.includes('🤖 自動予約の設定'));
  assert.ok(t.some((s) => s.includes('稼働中')));
  assert.ok(t.some((s) => s.includes('大島小松川公園') && s.includes('キャンセル済み')));
  const acts = actions(reply.flex.contents);
  const picker = acts.find((a) => a.type === 'datetimepicker');
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
  // ぶら下がる「更新」はメッセージアクションで「じどう」
  assert.ok(acts.some((a) => a.type === 'message' && a.text === 'じどう'));
});

test('「じどう」postback: 日を追加(params.date)・除外日の解除・除外枠の解除。期限切れ・範囲外・署名不正', async () => {
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

test('「じどう」の抽出は pickTextCommandEvents で(「よやく」と同じ条件)', () => {
  const ev = (text) => ({ type: 'message', replyToken: 'rt', source: { type: 'group', groupId: 'C1' }, message: { type: 'text', text } });
  const raw = JSON.stringify({ events: [ev('じどう'), ev(' じどう '), ev('よやく'), ev('じどう!')] });
  assert.equal(pickTextCommandEvents(raw, 'C1', ['じどう']).length, 2);
  assert.equal(pickTextCommandEvents(raw, 'C1', ['よやく']).length, 1);
});

test('生存監視: Pi は動いているのに自動予約の合図が 15 分以上無ければ 1 回知らせ、戻れば 1 回知らせる', async () => {
  const env = envOf();
  const pushed = [];
  const push = async (_t, _to, text) => pushed.push(text);
  const up = async () => ({ ok: true });
  env.BOOKING_KV.store.set('auto_mode', JSON.stringify({ mode: 'on', at: NOW }));
  env.BOOKING_KV.store.set('auto_alive', JSON.stringify({ at: NOW, active: true, mode: 'on' }));
  let r = await runMonitor(env, { now: NOW + 60000, probe: up, push });
  assert.equal(r.autoNotified, null);
  r = await runMonitor(env, { now: NOW + AUTO_STALL_MS + 60000, probe: up, push });
  assert.equal(r.autoNotified, 'stalled');
  assert.match(pushed[0], /自動予約の空きチェックが止まっています/);
  r = await runMonitor(env, { now: NOW + AUTO_STALL_MS + 120000, probe: up, push });
  assert.equal(r.autoNotified, null, '連続では鳴らさない');
  env.BOOKING_KV.store.set('auto_alive', JSON.stringify({ at: NOW + AUTO_STALL_MS + 170000, active: true, mode: 'on' }));
  r = await runMonitor(env, { now: NOW + AUTO_STALL_MS + 180000, probe: up, push });
  assert.equal(r.autoNotified, 'resumed');
  assert.equal(pushed.length, 2);
  // dry-run / off を申告しているときは鳴らさない
  const env2 = envOf();
  env2.BOOKING_KV.store.set('auto_mode', JSON.stringify({ mode: 'dry-run', at: NOW }));
  assert.equal((await runMonitor(env2, { now: NOW + 3600000, probe: up, push })).autoNotified, null);
});
