// ============================================================
// フェーズ2 予約支援の「玄関」(Cloudflare Workers 側)
//
// 自宅 PC で動く予約支援サーバーは、Cloudflare Tunnel(quick tunnel)の URL が起動ごとに変わる。
// そこで固定 URL のこの Worker を LINE の「予約」ボタンの宛先にし、PC が登録した現在の URL へ転送する。
//
//   GET  /book?token=…&person=…   署名トークンを検証 → PC の URL が登録されていれば 302 で転送。無ければ「繋がりません」画面
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
// PC からの登録の有効期限(秒)。PC は 4 分ごとに登録し直す
const REGISTER_TTL_SEC = 600;
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
  if (!['/book', '/booking/register', '/warmup', '/booking/status'].includes(p)) return null;

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

  // GET /book
  const token = url.searchParams.get('token') || '';
  const payload = await verifyBookingToken(token, env.BOOKING_SIGNING_SECRET);
  if (!payload) {
    return html('このリンクは使えません', 'リンクの期限が切れているか、正しくありません。新しい通知のボタンから開いてください。', 403);
  }
  if (!registered) {
    return html(
      '予約サーバーに繋がりません',
      `自宅の予約サーバー(PC)が起動していないようです。お手数ですが予約サイトで手動で予約してください。<br><a class="btn" href="${SITE_URL}">予約サイトを開く</a>`,
      503
    );
  }
  const dest = new URL(`${registered}/book`);
  for (const [k, v] of url.searchParams) dest.searchParams.set(k, v);
  return Response.redirect(dest.toString(), 302);
}
