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
//   fetchTennisbearPlans(base, secret, person) POST /auto/tennisbear { person } → { configured, events:[{ date, start, end, park, facility, source }] }。
//                                           Pi が予約直前に「隣の時間帯に別の場所の予定が無いか」を見るのに使う(2026-09-24)。失敗は throw
//   fetchPlans(base, secret)                GET  /auto/plans     → { plans:[{ person, label, source, date, start, end, park, facility }], failed:[…] } | null(失敗)
//                                           Actions が空き通知を送る直前に A・B の予定(都の予約 + テニスベア)を取り、時間が重なる枠と
//                                           接していて別の公園の枠を通知から外すのに使う(2026-09-27)。Worker が都のサイトにログインするので
//                                           待ち時間は長め(PLANS_TIMEOUT_MS)。失敗は null(呼び出し側は従来どおり全部通知する)
// ============================================================
const { createHmac } = require('crypto');

const TIMEOUT_MS = 10000;
// /auto/plans は Worker が A・B の予約一覧(都のサイト。実測 12 秒前後、遅い夜は 40 秒超)を取ってから返すので長めに待つ
const PLANS_TIMEOUT_MS = 60000;

function signRequest(secret, { method, path, body = '', ts = Date.now() }) {
  if (!secret) throw new Error('署名鍵(BOOKING_SIGNING_SECRET)が未設定です');
  const data = `${ts}\n${method.toUpperCase()} ${path}\n${body}`;
  const auth = createHmac('sha256', secret).update(data).digest('base64url');
  return { 'x-booking-ts': String(ts), 'x-booking-auth': auth };
}

async function call(base, secret, method, path, payload, { timeoutMs = TIMEOUT_MS } = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const headers = { ...signRequest(secret, { method, path, body }) };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${String(base).replace(/\/$/, '')}${path}`, {
    method,
    headers,
    body: body || undefined,
    signal: AbortSignal.timeout(timeoutMs),
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

function fetchTennisbearPlans(base, secret, person) {
  return call(base, secret, 'POST', '/auto/tennisbear', { person });
}

async function fetchPlans(base, secret) {
  try {
    const res = await call(base, secret, 'GET', '/auto/plans', undefined, { timeoutMs: PLANS_TIMEOUT_MS });
    if (!res || !Array.isArray(res.plans)) {
      console.log('A・B の予定が取れませんでした(Worker に取得の配線が無い)。重なりの判定はせず、従来どおり通知します');
      return null;
    }
    return res;
  } catch (e) {
    console.log(`A・B の予定を取得できませんでした(重なりの判定はせず、従来どおり通知します): ${e.message}`);
    return null;
  }
}

module.exports = { signRequest, fetchAutoState, sendHeartbeat, addExcludedSlots, fetchTennisbearPlans, fetchPlans };
