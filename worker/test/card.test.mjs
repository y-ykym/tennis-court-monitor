// フェーズ7 利用者カード(「うけつけ」)のテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredCards, signCardSlot, verifyCardSlot, buildCardReply, handleCardImage, MSG_CARD_UNSET } from '../src/card.js';

const ORIGIN = 'https://bot.example.workers.dev';
const env = () => ({
  SITE_USER_A: '00000000',
  SITE_USER_B: '00000001',
  LABEL_A: 'ゆう',
  LABEL_B: 'まきたそ',
  CARD_NAME_A: '山田太郎',
  CARD_NAME_B: '山田花子',
  BOOKING_SIGNING_SECRET: 'test-secret',
});

// Flex の木から条件に合うノードを集める
function find(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (pred(node)) out.push(node);
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((x) => find(x, pred, out));
    else if (v && typeof v === 'object') find(v, pred, out);
  }
  return out;
}
const texts = (node) => find(node, (n) => (n.type === 'text' || n.type === 'span') && typeof n.text === 'string').map((n) => n.text);
const images = (node) => find(node, (n) => n.type === 'image');

test('card: 利用者番号がある人だけを対象にする(奇数桁・数字以外は出さない)', () => {
  assert.deepEqual(configuredCards(env()).map((c) => c.slot), ['A', 'B']);
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

test('card: 2 人ならカルーセル。予約サイトのモーダルと同じ並び(番号 → 氏名 → バーコード → 番号)', async () => {
  const reply = await buildCardReply(env(), ORIGIN);
  assert.equal(reply.flex.contents.type, 'carousel');
  const bubbles = reply.flex.contents.contents;
  assert.equal(bubbles.length, 2);
  assert.ok(reply.flex.altText.includes('ゆう') && reply.flex.altText.includes('まきたそ'));

  const [a] = bubbles;
  assert.equal(a.size, 'giga', '受付でスキャナに読ませるので最大幅');
  // モーダルと同じ「白い 1 枚」に見せるため、ヘッダー領域は使わない
  assert.equal(a.header, undefined, 'ヘッダー領域は持たない');
  const t = texts(a.body);
  assert.deepEqual(
    t,
    ['利用者カード', '利用者番号：', '00000000', '利用者氏名：', '山田太郎 様', '00000000'],
    'モーダルと同じ並び。呼び名は出さず、縞の下にも番号を出す'
  );
  assert.ok(!t.includes('ゆう'), '呼び名はカードに出さない(モーダルに無いため)');
  assert.ok(reply.flex.altText.includes('ゆう'), '通知の要約には呼び名を残す');
  // 縞の下の番号は中央寄せ(モーダルの HRI と同じ位置)
  const hri = find(a.body, (n) => n.type === 'text' && n.text === '00000000')[0];
  assert.equal(hri.align, 'center');

  const img = images(a.body);
  assert.equal(img.length, 1);
  assert.ok(img[0].url.startsWith(`${ORIGIN}/card/A.png?s=`));
  assert.equal(img[0].action.type, 'uri', 'タップで全画面に開ける');
  assert.equal(img[0].action.uri, img[0].url);

  // フッター(ボタン)は付けない。拡大はバーコードのタップで足りる
  assert.equal(a.footer, undefined, 'フッターは持たない');
  assert.equal(find(a, (n) => n.type === 'button').length, 0, 'ボタンは 1 つも置かない');

  // B のカードは B の番号と署名
  assert.ok(images(bubbles[1].body)[0].url.startsWith(`${ORIGIN}/card/B.png?s=`));
  assert.ok(texts(bubbles[1].body).includes('00000001'));
});

test('card: 1 人ならカルーセルにせずカード 1 枚。氏名が未登録なら出さない', async () => {
  const reply = await buildCardReply({ SITE_USER_A: '00000000', LABEL_A: 'ゆう', BOOKING_SIGNING_SECRET: 'k' }, ORIGIN);
  assert.equal(reply.flex.contents.type, 'bubble');
  const t = texts(reply.flex.contents.body);
  assert.ok(t.includes('00000000'));
  assert.ok(!t.some((s) => s.includes('様')));
});

test('card: 署名鍵が無ければバーコード無しで番号だけ返す(受付で読み上げはできる)', async () => {
  const e = env();
  delete e.BOOKING_SIGNING_SECRET;
  const reply = await buildCardReply(e, ORIGIN);
  assert.equal(reply.flex, undefined);
  assert.ok(reply.text.includes('00000000') && reply.text.includes('山田太郎'));
});

test('card: 利用者番号が未登録なら、そう伝える', async () => {
  assert.deepEqual(await buildCardReply({}, ORIGIN), { text: MSG_CARD_UNSET });
});

test('card: カードに載せた画像 URL でそのまま PNG が取れる(往復)', async () => {
  const e = env();
  const reply = await buildCardReply(e, ORIGIN);
  const url = images(reply.flex.contents.contents[0].body)[0].url;
  const res = await handleCardImage(new Request(url), e);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control'), /immutable/);
  const png = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
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

test('card: 未登録の人の画像は 404、GET/HEAD 以外は 405', async () => {
  const e = { SITE_USER_A: '00000000', BOOKING_SIGNING_SECRET: 'k' };
  const sigB = await signCardSlot('k', 'B');
  assert.equal((await handleCardImage(new Request(`${ORIGIN}/card/B.png?s=${sigB}`), e)).status, 404);
  const sigA = await signCardSlot('k', 'A');
  assert.equal((await handleCardImage(new Request(`${ORIGIN}/card/A.png?s=${sigA}`, { method: 'POST' }), e)).status, 405);
});
