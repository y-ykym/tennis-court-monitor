import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPostbackReply, attachCancelData, MSG_CANCEL_DECLINED, MSG_CANCEL_EXPIRED, MSG_CANCEL_DISABLED } from '../src/index.js';
import { signCancelToken, verifyCancelToken } from '../src/cancel-token.js';

const SECRET = 'test-signing-secret';
const env = {
  CANCEL_ENABLED: '1',
  BOOKING_SIGNING_SECRET: SECRET,
  SITE_USER_A: '10000000',
  SITE_PASS_A: 'pw',
  LABEL_A: 'ゆうたそ',
};
const NOW = Date.parse('2026-09-06T03:00:00Z'); // JST 9/6 12:00
const base = { person: 'A', id: '2026000123', date: '2026-09-18', start: '17:00', end: '19:00', facility: '大島小松川公園', penaltyDay: 3 };

function texts(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (node && typeof node === 'object') {
    if ((node.type === 'text' || node.type === 'span') && typeof node.text === 'string') out.push(node.text);
    Object.values(node).forEach((v) => texts(v, out));
  }
  return out;
}
function postbacks(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => postbacks(n, out));
  else if (node && typeof node === 'object') {
    if (node.type === 'postback') out.push(node);
    Object.values(node).forEach((v) => postbacks(v, out));
  }
  return out;
}

test('postback: 「いいえ」はテキストで返す(サイトへは行かない)', async () => {
  assert.deepEqual(await buildPostbackReply(env, 'n', { now: NOW }), { text: MSG_CANCEL_DECLINED });
});

test('postback: 署名不正は無視(null)、期限切れは時間切れの案内', async () => {
  assert.equal(await buildPostbackReply(env, 'c|A|1|20260918|1700|1900|x|3|1.zzzzzzzzzzzzzzzzzzzzzz', { now: NOW }), null);
  const expired = await signCancelToken(SECRET, { ...base, kind: 'c', exp: Math.floor(NOW / 1000) - 10 });
  assert.deepEqual(await buildPostbackReply(env, expired, { now: NOW }), { text: MSG_CANCEL_EXPIRED });
});

test('postback: 機能停止中(CANCEL_ENABLED≠1)は案内を返す', async () => {
  const token = await signCancelToken(SECRET, { ...base, kind: 'c', exp: Math.floor(NOW / 1000) + 600 });
  assert.deepEqual(await buildPostbackReply({ ...env, CANCEL_ENABLED: '0' }, token, { now: NOW }), { text: MSG_CANCEL_DISABLED });
});

test('postback: 「キャンセル」ボタン → 確認カード(はい=10分の署名トークン、いいえ=n)', async () => {
  const token = await signCancelToken(SECRET, { ...base, kind: 'c', exp: Math.floor(NOW / 1000) + 3600 });
  const reply = await buildPostbackReply(env, token, { now: NOW });
  assert.equal(reply.flex.type, 'flex');
  const t = texts(reply.flex.contents);
  assert.ok(t.includes('キャンセルの確認'));
  assert.ok(t.includes('この予約をキャンセルしますか？'));
  assert.ok(t.includes('ゆうたそ') && t.includes('予約番号 2026000123'));
  assert.equal(t.some((s) => s.includes('ペナルティ')), false, '12日後なので警告なし');
  const pb = postbacks(reply.flex.contents);
  assert.deepEqual(pb.map((p) => p.label), ['はい、キャンセルする', 'いいえ']);
  assert.equal(pb[1].data, 'n');
  const yes = await verifyCancelToken(SECRET, pb[0].data, NOW);
  assert.equal(yes.kind, 'y');
  assert.equal(yes.id, '2026000123');
  assert.equal(yes.exp, Math.floor(NOW / 1000) + 600, '「はい」の期限は10分');
  assert.equal(pb[0].displayText, 'はい');
});

test('postback: 明日からペナルティ対象になる予約は「はい」も今日 23:59 で切れる(0時をまたいで押させない。フェーズ4)', async () => {
  // JST 9/6 23:55。9/10 は「今日はまだ無料、明日になると 3 日以内」の境目 → 「はい」は 10 分後(0:05)ではなく 23:59:59 まで
  const late = Date.parse('2026-09-06T14:55:00Z');
  const token = await signCancelToken(SECRET, { ...base, date: '2026-09-10', kind: 'c', exp: Math.floor(late / 1000) + 3600 });
  const reply = await buildPostbackReply(env, token, { now: late });
  const yes = await verifyCancelToken(SECRET, postbacks(reply.flex.contents)[0].data, late);
  assert.equal(new Date(yes.exp * 1000).toISOString(), '2026-09-06T14:59:59.000Z', 'JST 9/6 23:59:59');
  assert.equal(texts(reply.flex.contents).some((s) => s.includes('ペナルティ')), false, '今日のうちはまだ無料なので警告は出さない');

  // 期限がまだ先の予約(9/18)は従来どおり 10 分。0 時をまたいでも取消は無料なので切らない
  const far = await signCancelToken(SECRET, { ...base, kind: 'c', exp: Math.floor(late / 1000) + 3600 });
  const farReply = await buildPostbackReply(env, far, { now: late });
  const farYes = await verifyCancelToken(SECRET, postbacks(farReply.flex.contents)[0].data, late);
  assert.equal(farYes.exp, Math.floor(late / 1000) + 600);
});

test('postback: 利用日が3日以内ならペナルティ警告が付く', async () => {
  const token = await signCancelToken(SECRET, { ...base, date: '2026-09-08', kind: 'c', exp: Math.floor(NOW / 1000) + 3600 });
  const reply = await buildPostbackReply(env, token, { now: NOW });
  assert.ok(texts(reply.flex.contents).some((s) => s.includes('利用日が3日以内のため')));
});

test('attachCancelData: 終了済み以外の予約に署名付き data を付ける。停止中は付けない', async () => {
  const results = [
    {
      slot: 'A',
      label: 'A',
      reservations: [
        { id: '1', date: '2026-09-18', start: '17:00', end: '19:00', facility: '大島小松川公園', penaltyDay: 3 },
        { id: '2', date: '2026-09-06', start: '09:00', end: '11:00', facility: '猿江恩賜公園', penaltyDay: 3 }, // 終了済み
      ],
    },
    { slot: 'B', label: 'B', error: new Error('x') },
  ];
  await attachCancelData(env, results, { today: '2026-09-06', nowHHMM: '12:00', now: NOW });
  const v = await verifyCancelToken(SECRET, results[0].reservations[0].cancelData, NOW);
  assert.equal(v.kind, 'c');
  assert.equal(v.person, 'A');
  assert.equal(v.exp, Math.floor(NOW / 1000) + 3600, 'ボタンの期限は60分');
  assert.equal(results[0].reservations[1].cancelData, undefined, '終了済みにはボタン無し');

  // フェーズ4 のアラートは期限を指定して渡す(今日 23:59 まで)
  const alert = [{ slot: 'A', label: 'A', reservations: [{ id: '1', date: '2026-09-10', start: '17:00', end: '19:00', facility: 'x', penaltyDay: 3 }] }];
  const endOfDay = Math.floor(Date.parse('2026-09-06T14:59:59Z') / 1000);
  await attachCancelData(env, alert, { today: '2026-09-06', nowHHMM: '12:00', now: NOW, exp: endOfDay });
  assert.equal((await verifyCancelToken(SECRET, alert[0].reservations[0].cancelData, NOW)).exp, endOfDay);

  const off = [{ slot: 'A', label: 'A', reservations: [{ id: '1', date: '2026-09-18', start: '17:00', end: '19:00', facility: 'x' }] }];
  await attachCancelData({ ...env, CANCEL_ENABLED: '0' }, off, { today: '2026-09-06', nowHHMM: '12:00', now: NOW });
  assert.equal(off[0].reservations[0].cancelData, undefined);
});

test('postback: 予約ボタン(book|トークン)は自宅サーバーの /book を叩いて「受け付けました」を返す', async () => {
  const { sign, slotExpiry } = await import('../../booking/src/token.js');
  const { MSG_BOOK } = await import('../src/index.js');
  const SECRET = 'test-secret';
  // 利用日は遠い未来の固定日にする(exp = 利用開始時刻なので、日付が過ぎるとトークンが期限切れになりテストが落ちる。booking.test.mjs は 2026-09-17 に実際に落ちた)
  const token = sign({ park: '1050', date: '2099-09-30', startHour: 13, people: 2, person: 'A', exp: slotExpiry('2099-09-30', 13) }, SECRET);
  const store = new Map([['booking_url', 'https://abc.trycloudflare.com']]);
  const env = {
    BOOKING_SIGNING_SECRET: SECRET,
    LABEL_A: 'ゆうたそ',
    CANCEL_ENABLED: '0', // キャンセル機能が止まっていても予約ボタンは動く
    BOOKING_KV: { get: async (k) => store.get(k) ?? null, put: async () => {}, delete: async () => {} },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ status: 'started' }, { status: 202 });
  try {
    const reply = await buildPostbackReply(env, `book|${token}`, { now: Date.UTC(2026, 8, 13) });
    assert.equal(reply.text, MSG_BOOK.started('ゆうたそ', '9/30(水) 13:00-15:00 亀戸中央公園'));
    assert.match(reply.text, /受け付けました/);
  } finally {
    globalThis.fetch = realFetch;
  }
  // 署名が不正なら「期限切れか無効」
  const bad = await buildPostbackReply(env, 'book|abc.def', { now: Date.UTC(2026, 8, 13) });
  assert.equal(bad.text, MSG_BOOK.invalid());
});

// ---- フェーズ5 テニスベアの合流(§15) ----
test('buildReservationReply(§15): 都とテニスベアを並行で取り、人ごとに合流。署名は都の行だけ・テニスベアには付かない', async () => {
  const { buildReservationReply, configuredTennisbear, fetchAllTennisbear, mergeTennisbear } = await import('../src/index.js');
  const tbEnv = { ...env, TB_EMAIL_A: 'a@example.com', TB_PASS_A: 'pw' };
  assert.deepEqual(configuredTennisbear(tbEnv).map((p) => p.slot), ['A'], 'B は未登録なので飛ばす');
  assert.deepEqual(configuredTennisbear(env), []);

  const mkSite = () => [{ slot: 'A', label: 'ゆうたそ', reservations: [{ id: '1', date: '2099-09-18', start: '17:00', end: '19:00', facility: '大島小松川公園', penaltyDay: 3 }] }];
  const site = mkSite();
  const tb = [{ slot: 'A', events: [{ source: 'tennisbear', id: '9', title: 'ストローク多め練', date: '2099-09-10', start: '19:00', end: '21:00', facility: '亀戸中央公園テニスコート' }] }];
  const reply = await buildReservationReply(tbEnv, { fetchSite: async () => site, fetchTb: async () => tb });
  assert.ok(reply.flex);
  const pb = postbacks(reply.flex.contents);
  assert.equal(pb.length, 1, 'キャンセルボタンは都の 1 行だけ');
  assert.equal((await verifyCancelToken(SECRET, pb[0].data, Date.now())).id, '1');
  assert.equal(site[0].tennisbear.events[0].cancelData, undefined, 'テニスベアの行に署名を付けない');
  assert.match(reply.text, /🐻 ストローク多め練/);
  assert.ok(reply.text.indexOf('ストローク') < reply.text.indexOf('大島小松川'), '日付順(9/10 🐻 → 9/18 都)');

  // テニスベアの取得そのものが例外を投げても都の返信は壊れない
  const safe = await buildReservationReply(tbEnv, { fetchSite: async () => mkSite(), fetchTb: async () => { throw new Error('boom'); } });
  assert.ok(safe.flex);
  assert.doesNotMatch(safe.text, /🐻/);

  // fetchAllTennisbear: 失敗はその人の error に入れ、例外にしない
  const results = await fetchAllTennisbear(tbEnv, { fetchEvents: async () => { throw new Error('x'); } });
  assert.equal(results.length, 1);
  assert.equal(results[0].slot, 'A');
  assert.ok(results[0].error);
  const merged = mergeTennisbear([{ slot: 'A', label: 'A', reservations: [] }, { slot: 'B', label: 'B', reservations: [] }], results);
  assert.ok(merged[0].tennisbear.error);
  assert.equal(merged[1].tennisbear, undefined, '登録のない B には何も付けない');
});
