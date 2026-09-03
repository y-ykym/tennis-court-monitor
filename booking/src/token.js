// ============================================================
// 署名付きトークン: LINE の「予約する」ボタンに埋める URL のパラメータ。
// 枠情報(公園・日付・開始時刻・人数・予約者)と有効期限を HMAC-SHA256 で署名し、
// 第三者が URL を作って予約サーバーを起動できないようにする。
//
//   sign(payload, secret)          → 'base64url(json).base64url(hmac)'
//   verify(token, secret, now?)    → payload | null(署名不一致・期限切れ・形式不正)
//
// payload = { park: '1050', date: '2026-09-17', startHour: 15, people: 2, person: 'A', exp: <unix秒> }
// 秘密鍵は環境変数 BOOKING_SIGNING_SECRET(通知側の GitHub Secrets と、予約サーバー側の Secret Manager に同じ値)。
// Node 標準の crypto だけで動く(lib/notify.js からも booking/server からも同じコードを使う)。
// ============================================================
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function hmac(data, secret) {
  return createHmac('sha256', secret).update(data).digest();
}

export function sign(payload, secret) {
  if (!secret) throw new Error('署名用の秘密鍵(BOOKING_SIGNING_SECRET)が未設定です');
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(hmac(body, secret))}`;
}

export function verify(token, secret, now = Date.now()) {
  if (!secret || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  let expected;
  let given;
  try {
    expected = hmac(body, secret);
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp === 'number' && payload.exp * 1000 < now) return null;
  return payload;
}

// 枠の利用開始時刻(JST)を有効期限にする(それを過ぎたボタンは意味がない)
export function slotExpiry(date, startHour) {
  const [y, m, d] = date.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, Number(startHour) - 9, 0, 0) / 1000);
}
