// ============================================================
// フェーズ3: Worker の自動予約 API(/auto/*)を呼ぶクライアント(Actions と Pi が共通で使う。Node 標準のみ)
//
//   認証: 既存の署名鍵 BOOKING_SIGNING_SECRET を流用した HMAC。/booking/register の x-booking-auth と同じ流儀だが、
//         再生(リプレイ)を防ぐため時刻を混ぜる:
//           x-booking-ts   = 送信時刻(unix ミリ秒)
//           x-booking-auth = base64url( HMAC-SHA256( secret, `${ts}\n${METHOD} ${path}\n${body}` ) )
//         Worker 側(worker/src/auto.js の verifyAutoRequest)は ts が ±5 分以内であることも確かめる
//
//   fetchAutoState(base, secret)            GET  /auto/state     → { alive, active, lastSeenAt, dates, slots } | null(失敗)
//   sendHeartbeat(base, secret, payload)    POST /auto/heartbeat → { dates, slots }(除外一覧を返す)。失敗は throw
//   addExcludedSlots(base, secret, slots)   POST /auto/exclusions { addSlots }。失敗は throw
// ============================================================
const { createHmac } = require('crypto');

const TIMEOUT_MS = 10000;

function signRequest(secret, { method, path, body = '', ts = Date.now() }) {
  if (!secret) throw new Error('署名鍵(BOOKING_SIGNING_SECRET)が未設定です');
  const data = `${ts}\n${method.toUpperCase()} ${path}\n${body}`;
  const auth = createHmac('sha256', secret).update(data).digest('base64url');
  return { 'x-booking-ts': String(ts), 'x-booking-auth': auth };
}

async function call(base, secret, method, path, payload) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const headers = { ...signRequest(secret, { method, path, body }) };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${String(base).replace(/\/$/, '')}${path}`, {
    method,
    headers,
    body: body || undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Worker HTTP ${res.status} ${path}`);
  return res.status === 204 ? null : res.json();
}

async function fetchAutoState(base, secret) {
  try {
    return await call(base, secret, 'GET', '/auto/state');
  } catch (e) {
    console.log(`自動予約の状態を取得できませんでした(Pi は止まっている扱いで全部通知します): ${e.message}`);
    return null;
  }
}

function sendHeartbeat(base, secret, payload) {
  return call(base, secret, 'POST', '/auto/heartbeat', payload);
}

function addExcludedSlots(base, secret, slots) {
  return call(base, secret, 'POST', '/auto/exclusions', { addSlots: slots });
}

module.exports = { signRequest, fetchAutoState, sendHeartbeat, addExcludedSlots };
