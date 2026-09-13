// ============================================================
// フェーズ2 予約支援の「玄関」(Cloudflare Workers 側)
//
// 自宅 PC で動く予約支援サーバーは、Cloudflare Tunnel(quick tunnel)の URL が起動ごとに変わる。
// そこで固定 URL のこの Worker を LINE の「予約」ボタンの宛先にし、PC が登録した現在の URL へ転送する。
//
//   (LINE postback 'book|<token>')   index.js から startBooking(): PC の /book を叩いて予約フローを開始し、結果コードを返す。ブラウザは開かない
//   GET  /book?token=…               ブラウザから開かれたとき(古い通知の URL ボタン): 同じく startBooking() して結果を画面で返す
//   GET  /status /result /vnc /abort /novnc/rfb.js, WS /websockify
//                                  PC の noVNC 画面・API・WebSocket を中継(reCAPTCHA の「確認が必要です」カードのボタンが /vnc を開く)。
//                                  スマホは常にこの Worker(固定 URL)だけと通信し、
//                                  quick tunnel の一時エラー(Cloudflare 1033 等)は Worker 側で数回やり直して吸収する。
//                                  全部失敗しても登録は消さない(瞬断で消すと直後の予約まで巻き込む。TTL 5 分で自然に消える)
//   POST /booking/register         PC 側(server/register.mjs)が自分の URL を登録。ヘッダ x-booking-auth = HMAC(secret, url)
//                                  KV に TTL 付きで保存(PC が落ちると自然に消える)
//   GET  /warmup                   登録先の /warmup を叩く(通知と同時にブラウザを起こす)
//   GET  /booking/status           登録があるか(URL は出さない)
//
// 必要なもの:
//   Secret  BOOKING_SIGNING_SECRET  署名鍵(通知側・PC 側と同じ値)
//   KV      BOOKING_KV              wrangler.toml の [[kv_namespaces]] で束ねる
//
// トークンの形式は booking/src/token.js と同じ(base64url(JSON) . base64url(HMAC-SHA256))。ここでは Web Crypto で検証する。
// ============================================================

const KV_KEY = 'booking_url';
// PC(トンネル)へ中継するパス。これ以外(/webhook など)は触らない
const PROXY_PATHS = new Set(['/book', '/status', '/result', '/vnc', '/abort', '/websockify', '/novnc/rfb.js']);
// トンネルの一時エラー時のやり直し(回数・間隔)
const PROXY_RETRIES = 4;
const PROXY_RETRY_MS = 1500;
// PC からの登録の有効期限(秒)。PC は 2 分ごとに登録し直す(PC 停止後、古い URL が残る時間を短くする)
const REGISTER_TTL_SEC = 300;
const SITE_URL = 'https://kouen.sports.metro.tokyo.lg.jp/web/index.jsp';

const enc = new TextEncoder();

function b64uToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64u(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// booking/src/token.js の verify と同じ判定
export async function verifyBookingToken(token, secret, now = Date.now()) {
  if (!secret || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  let expected;
  let given;
  try {
    expected = await hmac(secret, body);
    given = b64uToBytes(sig);
  } catch {
    return null;
  }
  if (!equalBytes(expected, given)) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64uToBytes(body)));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp === 'number' && payload.exp * 1000 < now) return null;
  return payload;
}

// PC 側が URL 登録に付ける認証値(HMAC-SHA256(secret, url) を base64url)。server/register.mjs と同じ計算
export async function registerAuth(secret, url) {
  return bytesToB64u(await hmac(secret, url));
}

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const html = (title, body, status = 200) =>
  new Response(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;margin:0;background:#f4f6f8;color:#222}
.card{max-width:520px;margin:24px auto;background:#fff;border-radius:12px;padding:20px 22px;box-shadow:0 2px 10px rgba(0,0,0,.06)}
h1{font-size:1.15rem;margin:0 0 12px}.muted{color:#666;font-size:.9rem;line-height:1.6}
a.btn{display:inline-block;margin-top:14px;padding:10px 16px;border-radius:8px;background:#888;color:#fff;text-decoration:none;font-weight:700}</style></head>
<body><div class="card"><h1>${esc(title)}</h1><div class="muted">${body}</div></div></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );

// このモジュールが扱うパスなら Response を返す。扱わないパスは null
export async function handleBooking(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname;
  if (!PROXY_PATHS.has(p) && !['/booking/register', '/warmup', '/booking/status'].includes(p)) return null;

  if (!env.BOOKING_SIGNING_SECRET || !env.BOOKING_KV) {
    console.error('BOOKING_SIGNING_SECRET または BOOKING_KV が未設定です');
    return new Response('server misconfigured', { status: 500 });
  }

  if (p === '/booking/register' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('bad request', { status: 400 });
    }
    const target = typeof body?.url === 'string' ? body.url.replace(/\/$/, '') : '';
    if (!/^https:\/\/[a-z0-9.-]+\.trycloudflare\.com$/.test(target) && !/^https:\/\/[a-z0-9.-]+$/.test(target)) {
      return new Response('bad url', { status: 400 });
    }
    const expected = await registerAuth(env.BOOKING_SIGNING_SECRET, target);
    const given = request.headers.get('x-booking-auth') || '';
    if (expected.length !== given.length || !equalBytes(enc.encode(expected), enc.encode(given))) {
      console.warn('URL 登録の認証に失敗');
      return new Response('unauthorized', { status: 401 });
    }
    await env.BOOKING_KV.put(KV_KEY, target, { expirationTtl: REGISTER_TTL_SEC });
    console.log(`予約サーバーの URL を登録: ${new URL(target).hostname}`);
    return new Response(null, { status: 204 });
  }

  const registered = await env.BOOKING_KV.get(KV_KEY);

  if (p === '/booking/status') {
    return Response.json({ registered: !!registered, host: registered ? new URL(registered).hostname : null });
  }

  if (p === '/warmup') {
    if (registered) ctx.waitUntil(fetch(`${registered}/warmup`, { signal: AbortSignal.timeout(8000) }).catch(() => {}));
    return new Response(registered ? 'ok' : 'no server', { status: 200 });
  }

  // ブラウザから /book を開かれた(古い通知の URL 型ボタン)。postback と同じ処理をして結果を画面で返す
  if (p === '/book') {
    const { status, payload } = await startBooking(env, url.searchParams.get('token') || '');
    const who = payload ? env[`LABEL_${payload.person}`] || payload.person || '' : '';
    const text = (MSG_BOOK[status] || MSG_BOOK.error)(who, payload ? bookSlotText(payload) : '');
    const ok = status === 'started';
    return html(ok ? '受け付けました' : '予約を始められませんでした', `${esc(text).replace(/\n/g, '<br>')}<br><a class="btn" href="${SITE_URL}">予約サイトを開く</a>`, ok ? 200 : status === 'offline' ? 503 : status === 'invalid' ? 403 : 409);
  }

  if (!registered) return html('予約サーバーに繋がりません', `自宅の予約サーバー(PC)が起動していないようです。<br><a class="btn" href="${SITE_URL}">予約サイトを開く</a>`, 503);

  return proxyToServer(request, `${registered}${p}${url.search}`, env);
}

// PC(トンネル越し)へ中継する。Cloudflare Tunnel の一時エラー(1033 = HTTP 530 など)は少し待ってやり直す。
// WebSocket(noVNC)は Upgrade をそのまま渡し、返ってきた 101 応答を返せば双方向に流れる
async function proxyToServer(request, target, env) {
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('cf-connecting-ip');
  const isWs = (request.headers.get('upgrade') || '').toLowerCase() === 'websocket';
  const init = { method: request.method, headers, redirect: 'manual' };
  if (!isWs && request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
  let last;
  for (let n = 1; n <= PROXY_RETRIES; n++) {
    try {
      const res = await fetch(target, init);
      // 530/502/503/504 はトンネル側の一時エラーの可能性が高いのでやり直す(WebSocket は 101 以外をやり直す)
      const transient = isWs ? res.status !== 101 : [502, 503, 504, 530].includes(res.status);
      if (!transient) return res;
      last = res;
    } catch (e) {
      last = new Response(`中継に失敗: ${e.message}`, { status: 502 });
    }
    if (n < PROXY_RETRIES) await new Promise((r) => setTimeout(r, PROXY_RETRY_MS));
  }
  console.warn(`PC への中継が ${PROXY_RETRIES} 回とも失敗: ${new URL(target).pathname}`);
  // 登録は消さない。以前はここで KV を消していたが、自宅回線の数秒の瞬断でも消えてしまい、
  // 直後の予約まで「繋がりません」になっていた(2026-09-13)。URL が本当に死んでいれば 5 分の TTL で自然に消え、
  // PC 側の registrar が生きていれば 2 分以内に新しい URL で上書きされる
  if (isWs) return last;
  return html(
    '予約サーバーに繋がりませんでした',
    '自宅の予約サーバーへの中継が一時的に失敗しました。数秒待ってから、ブラウザで再読み込みしてください(処理は裏で続いています)。',
    503
  );
}

// ---- 予約開始(LINE の postback ボタン / 古い URL ボタン) ----
// PC の /book を叩いて予約フローを始める。PC は JSON で答える(server/server.mjs):
//   202 started / 200 already(同じ枠が成立済み) / 409 busy(別の枠を処理中) / 400 no_person / 403 invalid
// ここでの結果コード:
//   started  … 始めた(結果は PC が LINE にカードで push する)
//   already  … 同じ枠の予約が既に成立している
//   busy     … 別の枠を処理中
//   invalid  … 署名不正・期限切れ・予約者なし
//   offline  … PC の URL が未登録、または中継が全部失敗
//   error    … PC がそれ以外を返した
export const BOOK_POSTBACK_PREFIX = 'book|';

export async function startBooking(env, token) {
  const payload = await verifyBookingToken(token, env.BOOKING_SIGNING_SECRET);
  if (!payload) return { status: 'invalid' };
  const registered = await env.BOOKING_KV.get(KV_KEY);
  if (!registered) return { status: 'offline', payload };
  const target = `${registered}/book?token=${encodeURIComponent(token)}`;
  let last = null;
  for (let n = 1; n <= PROXY_RETRIES; n++) {
    try {
      last = await fetch(target, { method: 'GET', signal: AbortSignal.timeout(10000) });
      if (![502, 503, 504, 530].includes(last.status)) break;
    } catch {
      last = null;
    }
    if (n < PROXY_RETRIES) await new Promise((r) => setTimeout(r, PROXY_RETRY_MS));
  }
  if (!last || [502, 503, 504, 530].includes(last.status)) {
    console.warn('予約開始の中継が全部失敗');
    return { status: 'offline', payload };
  }
  const body = await last.json().catch(() => ({}));
  if (last.status === 202) return { status: 'started', payload };
  if (last.status === 200 && body.status === 'already') return { status: 'already', payload };
  if (last.status === 409) return { status: 'busy', payload };
  if (last.status === 400 || last.status === 403) return { status: 'invalid', payload };
  console.warn(`予約開始: PC が HTTP ${last.status} ${body.status || ''} を返した`);
  return { status: 'error', payload };
}

// 予約ボタンへの返信文(postback の reply と、ブラウザ向け画面で共用)
const PARK_NAMES = { 1040: '猿江恩賜公園', 1050: '亀戸中央公園', 1160: '大島小松川公園' };
export const MSG_BOOK = {
  started: (who, slot) => `🎾 受け付けました\n${who}: ${slot}\n自動で予約を進めています(1分ほど)。結果はこのグループにカードで届きます。ロボット確認が必要になったときもカードでお知らせします。`,
  already: (who, slot) => `この枠(${slot})は ${who} で既に予約が成立しています。「よやく」で確認してください`,
  busy: () => 'いま別の予約を処理中です。1〜2分待ってから、もう一度ボタンを押してください',
  offline: () => '自宅の回線が一時的に切れていて、予約サーバーに届きませんでした。1〜2分後にもう一度押してください(何度も続くときは予約サイトで手動で)',
  invalid: () => 'このボタンは期限切れか無効です。新しい通知のボタンから押してください',
  error: () => '予約サーバーがエラーを返しました。少し待ってもう一度押してください',
};
export function bookSlotText(p) {
  const [y, m, d] = String(p.date).split('-').map(Number);
  const dow = '日月火水木金土'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}(${dow}) ${p.startHour}:00-${Number(p.startHour) + 2}:00 ${PARK_NAMES[p.park] || p.park}`;
}
