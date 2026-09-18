// フェーズ7 利用者カード(「うけつけ」)のテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredCards, signCardSlot, verifyCardSlot, buildCardReply, handleCardImage, KV_CARD_IMAGE, MSG_CARD_UNSET, MSG_CARD_NO_IMAGE } from '../src/card.js';

const ORIGIN = 'https://bot.example.workers.dev';
// 用意してあるカード画像のつもり(中身は問わない)
const IMAGE_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const IMAGE_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);

const env = (images = { A: IMAGE_A, B: IMAGE_B }) => ({
  SITE_USER_A: '00000000',
  SITE_USER_B: '00000001',
  LABEL_A: 'ゆう',
  LABEL_B: 'まきたそ',
  BOOKING_SIGNING_SECRET: 'test-secret',
  BOOKING_KV: kvWith(Object.fromEntries(Object.entries(images).map(([slot, v]) => [KV_CARD_IMAGE(slot), v]))),
});

// KV の代わり(人ごとのカード画像を持っているふりをする)
const kvWith = (entries) => ({
  get: async (key, type) => {
    const v = entries[key];
    if (!v) return null;
    return type === 'arrayBuffer' ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v;
  },
  list: async ({ prefix } = {}) => ({ keys: Object.keys(entries).filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) }),
});

test('card: 利用者番号がある人だけを対象にする(奇数桁・数字以外は出さない)', () => {
  assert.deepEqual(configuredCards(env()).map((c) => c.slot), ['A', 'B']);
  assert.ok(!('name' in configuredCards(env())[0]), '氏名は持たない(配る画像に写っているため)');
  assert.deepEqual(configuredCards({ SITE_USER_A: '00000000' }).map((c) => c.userId), ['00000000']);
  // バーコードにできない値は黙って出さない(受付で読めないカードを配らないため)
  assert.deepEqual(configuredCards({ SITE_USER_A: '1028543' }), []);
  assert.deepEqual(configuredCards({ SITE_USER_A: 'abcdefgh' }), []);
  assert.deepEqual(configuredCards({}), []);
});

test('card: 署名は人ごとに違い、鍵が違えば通らない', async () => {
  const a = await signCardSlot('test-secret', 'A');
  const b = await signCardSlot('test-secret', 'B');
  assert.notEqual(a, b);
  assert.equal(await verifyCardSlot('test-secret', 'A', a), true);
  assert.equal(await verifyCardSlot('test-secret', 'B', a), false, 'A の署名で B の画像は取れない');
  assert.equal(await verifyCardSlot('other-secret', 'A', a), false);
  assert.equal(await verifyCardSlot('test-secret', 'A', null), false);
  assert.equal(await verifyCardSlot('', 'A', a), false);
});

test('card: 返すのはカード画像だけ(人数分の image メッセージ。文章は添えない)', async () => {
  const reply = await buildCardReply(env(), ORIGIN);
  assert.equal(reply.messages.length, 2, '2 人なら 2 枚');
  assert.deepEqual(reply.messages.map((m) => m.type), ['image', 'image'], '画像以外は送らない');
  // 人ごとに違う署名付き URL。preview も同じ画像でよい(小さいため)
  assert.ok(reply.messages[0].originalContentUrl.startsWith(`${ORIGIN}/card/A.png?s=`));
  assert.ok(reply.messages[1].originalContentUrl.startsWith(`${ORIGIN}/card/B.png?s=`));
  assert.equal(reply.messages[0].previewImageUrl, reply.messages[0].originalContentUrl);
  assert.notEqual(reply.messages[0].originalContentUrl, reply.messages[1].originalContentUrl);
});

test('card: 1 人なら 1 枚だけ', async () => {
  const e = { ...env(), SITE_USER_B: '' };
  const reply = await buildCardReply(e, ORIGIN);
  assert.equal(reply.messages.length, 1);
  assert.ok(reply.messages[0].originalContentUrl.includes('/card/A.png'));
});

test('card: 画像がまだ無い人は番号だけテキストで知らせる(黙って居ないことにしない)', async () => {
  const reply = await buildCardReply(env({ A: IMAGE_A }), ORIGIN);
  assert.equal(reply.messages.length, 2);
  assert.equal(reply.messages[0].type, 'image');
  assert.equal(reply.messages[1].type, 'text');
  assert.ok(reply.messages[1].text.includes(MSG_CARD_NO_IMAGE));
  assert.ok(reply.messages[1].text.includes('00000001'), 'B の番号は読み上げられるようにする');
});

test('card: 全員の画像が無ければ画像は送らず、番号だけ返す', async () => {
  const reply = await buildCardReply(env({}), ORIGIN);
  assert.equal(reply.messages, undefined);
  assert.ok(reply.text.includes(MSG_CARD_NO_IMAGE));
  assert.ok(reply.text.includes('00000000') && reply.text.includes('00000001'));
});

test('card: KV の一覧が取れないときは画像を送る側に倒す(一時的な失敗のため)', async () => {
  const e = { ...env(), BOOKING_KV: { list: async () => { throw new Error('KV down'); } } };
  const reply = await buildCardReply(e, ORIGIN);
  assert.equal(reply.messages.length, 2);
  assert.deepEqual(reply.messages.map((m) => m.type), ['image', 'image']);
});

test('card: 署名鍵が無ければ画像を出せないので番号だけ返す(受付で読み上げはできる)', async () => {
  const e = env();
  delete e.BOOKING_SIGNING_SECRET;
  const reply = await buildCardReply(e, ORIGIN);
  assert.equal(reply.messages, undefined);
  assert.ok(reply.text.includes('00000000') && reply.text.includes('00000001'));
});

test('card: 利用者番号が未登録なら、そう伝える', async () => {
  assert.deepEqual(await buildCardReply({}, ORIGIN), { text: MSG_CARD_UNSET });
});

test('card: 送った URL で KV のカード画像がそのまま取れる(往復)', async () => {
  const e = env();
  const reply = await buildCardReply(e, ORIGIN);
  const res = await handleCardImage(new Request(reply.messages[0].originalContentUrl), e);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...IMAGE_A], 'KV の画像をそのまま返す');
});

test('card: KV に画像が無い・KV が読めないときは 404(壊れた画像を返さない)', async () => {
  const e = env({ A: IMAGE_A });
  const sigB = await signCardSlot(e.BOOKING_SIGNING_SECRET, 'B');
  assert.equal((await handleCardImage(new Request(`${ORIGIN}/card/B.png?s=${sigB}`), e)).status, 404);

  const broken = { ...env(), BOOKING_KV: { get: async () => { throw new Error('KV down'); } } };
  const sigA = await signCardSlot(broken.BOOKING_SIGNING_SECRET, 'A');
  assert.equal((await handleCardImage(new Request(`${ORIGIN}/card/A.png?s=${sigA}`), broken)).status, 404);
});

test('card: 署名が無い・違う画像 URL は 403。担当外のパスは null', async () => {
  const e = env();
  assert.equal((await handleCardImage(new Request(`${ORIGIN}/card/A.png`), e)).status, 403);
  assert.equal((await handleCardImage(new Request(`${ORIGIN}/card/A.png?s=deadbeef`), e)).status, 403);
  // B の署名で A は取れない
  const sigB = await signCardSlot(e.BOOKING_SIGNING_SECRET, 'B');
  assert.equal((await handleCardImage(new Request(`${ORIGIN}/card/A.png?s=${sigB}`), e)).status, 403);
  // 別の口(/webhook など)は card.js の担当外
  assert.equal(await handleCardImage(new Request(`${ORIGIN}/card/C.png`), e), null);
  assert.equal(await handleCardImage(new Request(`${ORIGIN}/webhook`), e), null);
});

test('card: 利用者番号が未登録の人は 404、GET/HEAD 以外は 405', async () => {
  const e = { SITE_USER_A: '00000000', BOOKING_SIGNING_SECRET: 'k', BOOKING_KV: kvWith({ [KV_CARD_IMAGE('A')]: IMAGE_A }) };
  const sigB = await signCardSlot('k', 'B');
  assert.equal((await handleCardImage(new Request(`${ORIGIN}/card/B.png?s=${sigB}`), e)).status, 404);
  const sigA = await signCardSlot('k', 'A');
  assert.equal((await handleCardImage(new Request(`${ORIGIN}/card/A.png?s=${sigA}`, { method: 'POST' }), e)).status, 405);
});
