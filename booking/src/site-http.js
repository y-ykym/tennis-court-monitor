// ============================================================
// Cookie を持ち回る素の HTTP セッション(Node の fetch)。ブラウザを使わずに予約サイトと通信するときに使う。
// いま使っているのは計測用の booking/scripts/http-first-measure.mjs だけ(本番の予約処理からは使っていない)。
//
// 経緯: 「HTTP 先行方式」(ログイン〜枠選択を HTTP で済ませ、Cookie を本番のブラウザに渡して確認画面と「予約」だけブラウザで行う)を
// 2026-11-19 に検討して見送った。昼間(16:45)の Pi からの計測で、空きが出てからの分(ログイン 2.9 + 枠の選択 4.1 + 予約一覧 4.5 秒)は
// 11.4 秒、今のブラウザ内 fetch は同じ 3 通信で 15.6〜16.5 秒。差は 4〜5 秒で、遅いのは主に都サイト自体だった。
// 一方「予約」を本番のブラウザで押す試験が要り、reCAPTCHA の点数への影響を本人が避けたいと判断(docs/site-notes.md)。
//
// ログには利用者番号・パスワード・Cookie の値を出さない。
// ============================================================

export const SITE_ORIGIN = 'https://kouen.sports.metro.tokyo.lg.jp';
// 1 通信の上限。固まったら error にして、呼び出し側(reserve.js)が従来のブラウザ内 fetch でやり直す
export const HTTP_REQUEST_TIMEOUT_MS = 10000;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Set-Cookie 1 行 → { name, value, path, secure, httpOnly, sameSite }(属性は Playwright の addCookies に渡す形)。読めなければ null
export function parseSetCookie(line) {
  const parts = String(line || '').split(';').map((p) => p.trim());
  const eq = parts[0].indexOf('=');
  if (eq <= 0) return null;
  const cookie = { name: parts[0].slice(0, eq), value: parts[0].slice(eq + 1), path: '/', secure: false, httpOnly: false, sameSite: null };
  for (const p of parts.slice(1)) {
    const [k, ...rest] = p.split('=');
    const key = k.trim().toLowerCase();
    const v = rest.join('=').trim();
    if (key === 'path' && v) cookie.path = v;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') cookie.sameSite = /^none$/i.test(v) ? 'None' : /^strict$/i.test(v) ? 'Strict' : 'Lax';
    else if (key === 'max-age' && Number(v) <= 0) cookie.expired = true;
  }
  return cookie;
}

// Cookie を持ち回る 1 セッション。fetch は inPageFlow の通信関数として渡せる形(パスは /web/... の相対、応答は { status, type, arrayBuffer() })
export function createHttpSession({ fetchImpl = globalThis.fetch, origin = SITE_ORIGIN, timeoutMs = HTTP_REQUEST_TIMEOUT_MS, now = Date.now } = {}) {
  const jar = new Map(); // name → cookie
  const steps = []; // { path, ms }
  const header = () => [...jar.values()].map((c) => `${c.name}=${c.value}`).join('; ');
  async function fetchInSession(path, init = {}) {
    const started = now();
    const headers = { ...(init.headers || {}), 'user-agent': USER_AGENT, 'accept-language': 'ja', referer: `${origin}/web/index.jsp` };
    if (jar.size) headers.cookie = header();
    if (init.method === 'POST') headers.origin = origin;
    const res = await fetchImpl(`${origin}${path}`, { method: init.method || 'GET', headers, body: init.body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const lines = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of lines) {
      const c = parseSetCookie(line);
      if (!c) continue;
      if (c.expired || c.value === '') jar.delete(c.name);
      else jar.set(c.name, c);
    }
    const buf = await res.arrayBuffer();
    steps.push({ path: path.replace(/^\/web\//, '').replace(/\.(do|jsp)$/, ''), ms: now() - started });
    return { status: res.status, type: res.type || 'basic', arrayBuffer: async () => buf };
  }
  return {
    fetch: fetchInSession,
    cookies: () => [...jar.values()].map(({ expired, ...c }) => c),
    steps: () => steps.slice(),
  };
}
