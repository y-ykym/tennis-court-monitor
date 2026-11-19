// ============================================================
// HTTP 先行方式(2026-11-19 試験導入。既定は無効): ログイン → 空き検索 → 枠の選択(→ 予約一覧)を、ブラウザを使わず
// Node の fetch で済ませる。済んだセッションの Cookie を先に起こしてあるブラウザへ渡し、ブラウザは予約内容確認画面の POST と
// 「予約」(reCAPTCHA v3 はサイトの JS がブラウザで動く)だけを行う(src/reserve.js の options.httpFirst)。
//
//   httpFirstFlow({ slot, credentials, withList }, { fetchImpl?, timeoutMs? })
//     → inPageFlow と同じ形の結果({ ok: true, applyFields, facility, vacant, listHtml?, … } | { ok: false, status, message })に
//       cookies([{ name, value, path, secure, httpOnly, sameSite }])と steps(工程ごとの所要 ms)を足したもの
//
// 手順そのものは site-inpage.js の inPageFlow をそのまま使う(通信の関数だけ差し替える)。ブラウザ内版と送る内容がずれないようにするため。
// ブラウザ側のセッションで先取りしたログイン画面・検索(prefetched)は別セッションのものなので使わない(トップ → ログイン画面 → ログイン → 検索 → 枠選択)。
//
// 経緯(docs/site-notes.md「素の HTTP で枠選択まで済ませ…」): Pi の本番では ブラウザ内 fetch の枠選択までが 9〜25 秒、素の HTTP は 2〜4 秒(2026-11-08 実測)。
// Cookie を Playwright に渡して確認画面に到達できることは確認済み。「予約」を押したときの reCAPTCHA v3 の点数だけが未確認
// (11/8 の試験は新しく起こした試験用ブラウザで押して v2 に回された。同じ夜でも本番の先起こしブラウザでは成立している)。
//
// 注意: Cloud Run のように Node とブラウザの出口(IP)が別になる環境では使えない(サイトのロードバランサがセッションを別ノードに振る)。Pi は同じ出口。
// ログには利用者番号・パスワード・Cookie の値を出さない。
// ============================================================
import { inPageFlow } from './site-inpage.js';

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

// トップ(セッション Cookie)→ inPageFlow(ログイン画面 → ログイン → 検索 → 枠選択 → 予約一覧)。例外は投げず、inPageFlow と同じ形で返す
export async function httpFirstFlow({ slot, credentials, withList = false }, { fetchImpl, timeoutMs, now } = {}) {
  const session = createHttpSession({ fetchImpl, timeoutMs, now });
  const fail = (status, message) => ({ ok: false, status, message, steps: session.steps() });
  try {
    const top = await session.fetch('/web/index.jsp');
    const html = new TextDecoder('shift_jis').decode(await top.arrayBuffer());
    if (top.status !== 200 || !/rsvWTransUserLoginAction/i.test(html)) {
      return fail('error', `トップページが想定外です (HTTP ${top.status}。メンテナンスかお知らせの可能性)`);
    }
    if (!session.cookies().length) return fail('error', 'トップページでセッションの Cookie が発行されませんでした');
  } catch (e) {
    return fail('error', `トップページを取得できませんでした: ${e?.message || e}`);
  }
  const r = await inPageFlow({ slot, credentials, withList, prefetched: null }, session.fetch);
  const message = r.ok ? r.message : String(r.message || '').replace('ブラウザ内 fetch でエラー', 'HTTP でエラー');
  return { ...r, ...(r.ok ? {} : { message }), cookies: session.cookies(), steps: session.steps() };
}
