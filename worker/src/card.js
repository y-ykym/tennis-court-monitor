// ============================================================
// フェーズ7 利用者カード: LINE で「うけつけ」と送ると、受付で見せる利用者カードを人ごとに返す
//
//   施設の受付でバーコードをスキャナに読ませる / 代理受付のときは利用者番号を読み上げる、という用途。
//   バーコードの中身は利用者番号 8 桁そのままで、毎回変わる値ではない(docs/site-notes.md 参照)。
//   利用者番号は既に Secrets(SITE_USER_A / SITE_USER_B)にあるので、
//   **予約サイトへのログインは一切しない**。Worker だけで組み立てるので返信は 1 秒以内に返る。
//
//   バーコードは画像として LINE に渡す必要がある(Flex の image は URL しか受け付けない)ので、
//   この Worker 自身が PNG を返す口を持つ:
//
//     GET /card/A.png?s=<署名22文字>   → A の利用者番号のバーコード(src/barcode.js)
//
//   署名は既存の BOOKING_SIGNING_SECRET を使った HMAC の先頭 16 バイト。**期限は付けない**。
//   LINE のトーク履歴に残ったカードを後日そのまま見せられるようにするため(電波の悪い受付で効く)。
//   URL が漏れてもバーコードが見えるだけで、ログインにはパスワードが必要。利用者番号そのものは
//   受付で相手に見せる値なので、サイトのカード画面を見せるのと同じ range のリスクに留まる。
// ============================================================
import { barcodePng } from './barcode.js';
import { buildUserCardFlex } from './flex.js';

// グループで受け付ける合言葉(flex.js にも同じ文字列を直書きしている。循環 import を避けるため)
export const CARD_COMMAND_TEXT = 'うけつけ';

const CARD_PATH = /^\/card\/([AB])\.png$/;
const SIG_BYTES = 16;
// 画像は中身が変わらないので長くキャッシュさせる(LINE 側・端末側の再取得を防ぐ)
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const MSG_CARD_FAILED = '利用者カードを表示できませんでした';
export const MSG_CARD_UNSET = '利用者番号が登録されていません';

const enc = new TextEncoder();

function b64u(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function safeEqual(a, b) {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// 人(A/B)ごとの固定の署名。期限は入れない(上のコメント参照)
export async function signCardSlot(secret, slot) {
  if (!secret) throw new Error('署名鍵が未設定です');
  if (!['A', 'B'].includes(slot)) throw new Error('slot が不正です');
  return b64u((await hmac(secret, `card|${slot}`)).slice(0, SIG_BYTES));
}

export async function verifyCardSlot(secret, slot, sig) {
  if (!secret || !['A', 'B'].includes(slot) || typeof sig !== 'string') return false;
  return safeEqual(await signCardSlot(secret, slot), sig);
}

// Secrets から利用者カードを出せる人を組む。パスワードは要らない(サイトに行かないため)。
// 氏名は CARD_NAME_*(受付で照合される本名)。無ければ表示名で代える
export function configuredCards(env) {
  return [
    { slot: 'A', label: env.LABEL_A || 'A', name: env.CARD_NAME_A || '', userId: String(env.SITE_USER_A ?? '') },
    { slot: 'B', label: env.LABEL_B || 'B', name: env.CARD_NAME_B || '', userId: String(env.SITE_USER_B ?? '') },
  ].filter((c) => {
    if (!c.userId) return false;
    // CODE128-C は偶数桁の数字しか入れられない(利用者番号は半角数字 8 桁)
    if (!/^\d+$/.test(c.userId) || c.userId.length % 2 !== 0) {
      console.error(`[card] ${c.slot} の利用者番号がバーコードにできない形式です(桁数・数字を確認してください)`);
      return false;
    }
    return true;
  });
}

// 「うけつけ」への返信。origin は Worker 自身の URL(https://....workers.dev)
export async function buildCardReply(env, origin) {
  const cards = configuredCards(env);
  if (cards.length === 0) return { text: MSG_CARD_UNSET };
  const fallback = ['🎫 利用者カード', ...cards.map((c) => `${c.label}${c.name ? `(${c.name} 様)` : ''} ${c.userId}`)].join('\n');
  // 署名鍵が無いとバーコード画像を出せないので、番号だけのテキストで返す(受付で読み上げはできる)
  if (!env.BOOKING_SIGNING_SECRET || !origin) {
    console.error('[card] BOOKING_SIGNING_SECRET か origin が無いため、バーコード無しで返します');
    return { text: fallback };
  }
  const withUrl = await Promise.all(
    cards.map(async (c) => ({ ...c, imageUrl: `${origin}/card/${c.slot}.png?s=${await signCardSlot(env.BOOKING_SIGNING_SECRET, c.slot)}` }))
  );
  return { flex: buildUserCardFlex(withUrl), text: fallback };
}

// GET /card/<A|B>.png?s=<署名> → バーコードの PNG。担当外のパスなら null(index.js が次の処理に回す)
export async function handleCardImage(request, env) {
  const url = new URL(request.url);
  const m = CARD_PATH.exec(url.pathname);
  if (!m) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  const slot = m[1];
  if (!(await verifyCardSlot(env.BOOKING_SIGNING_SECRET, slot, url.searchParams.get('s')))) {
    console.warn(`[card] 署名が合わないため拒否しました (${slot})`);
    return new Response('forbidden', { status: 403 });
  }
  const card = configuredCards(env).find((c) => c.slot === slot);
  if (!card) return new Response('not found', { status: 404 });
  const png = await barcodePng(card.userId);
  return new Response(request.method === 'HEAD' ? null : png, {
    status: 200,
    headers: { 'content-type': 'image/png', 'cache-control': CACHE_CONTROL, 'content-length': String(png.length) },
  });
}
