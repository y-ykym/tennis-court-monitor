// ============================================================
// フェーズ11: Google Calendar API の薄い包み(要件定義書 §21)
//
//   認証はサービスアカウント(ロボット用アカウント)。JSON 鍵の private_key で JWT(RS256)に自前で署名し、
//   oauth2.googleapis.com/token でアクセストークン(1 時間有効)に替える。ライブラリは使わない(Web Crypto のみ)。
//   トークンは KV に置かず、この isolate のメモリに持つ(無ければ取り直す。KV の書き込み枠を使わない)。
//
//   createGcalClient(env, { fetchFn, now })  → { listBotEvents, insert, patch, remove, calls }
//     listBotEvents(calendarId, { timeMin, timeMax, key }) ボットが作った予定(extendedProperties.private.tennisBot = '1')だけを一覧で。
//                                                        key を渡すとその tennisBotKey の予定だけ(キャンセル直後の削除用。時間の条件なし)
//     insert(calendarId, body) / patch(calendarId, id, body) / remove(calendarId, id)
//     calls: ここまでに外へ出た通信の回数(無料プランの 50 回/リクエストを数えるため。トークン取得も含む)
//
//   必要な Secrets: GCAL_CLIENT_EMAIL(JSON 鍵の client_email)、GCAL_PRIVATE_KEY(JSON 鍵の private_key。改行は実物でも "\n" でも可)
//
// 方針:
//   - 401/403/404 は「認証または権限の問題」(鍵が違う・カレンダーが共有されていない・ID が違う)。GcalError.status で呼び出し側が判定する
//   - 削除の 404/410 は「もう無い」なので成功扱い
//   - ログに鍵・トークン・予定の中身(タイトル等)を出さない。回数と所要時間だけ
// ============================================================

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/calendar/v3';
// 予定の読み書きだけ(カレンダーの共有設定などには触れない最小の権限)
export const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const REQUEST_TIMEOUT_MS = 10000;
// トークンの残りがこれより短ければ取り直す
const TOKEN_MARGIN_MS = 60 * 1000;
// 一覧の最大ページ数(1 ページ 250 件。普通は 1 ページで足りる)
const MAX_LIST_PAGES = 4;
// ボットが作った予定の目印(全予定に付ける。一覧の絞り込み privateExtendedProperty=tennisBot=1 に使う)
export const BOT_MARK_KEY = 'tennisBot';
export const BOT_MARK_VALUE = '1';
export const BOT_ID_KEY = 'tennisBotKey';

export class GcalError extends Error {
  constructor(message, { status = 0, path = '' } = {}) {
    super(message);
    this.name = 'GcalError';
    this.status = status;
    this.path = path;
  }
}
// 認証・権限の問題か(鍵違い・未共有・カレンダー ID 違い)。一時的なエラー(5xx・タイムアウト)とは分けて扱う
export const isGcalAuthError = (e) => e instanceof GcalError && [401, 403, 404].includes(e.status);

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uJson = (obj) => b64u(new TextEncoder().encode(JSON.stringify(obj)));

// PEM("-----BEGIN PRIVATE KEY-----" … )を DER(バイト列)に。Secret に "\n" のまま入っていても実際の改行でも読める
export function pemToDer(pem) {
  const body = String(pem || '')
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  if (!body) throw new GcalError('秘密鍵が空です(GCAL_PRIVATE_KEY)');
  const bin = atob(body);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// サービスアカウントの JWT(RS256)。{ iss, scope, aud, iat, exp } に署名する
export async function createJwt({ clientEmail, privateKey, scope = SCOPE, now = Date.now(), ttlSec = 3600 }) {
  if (!clientEmail) throw new GcalError('GCAL_CLIENT_EMAIL が未設定です');
  const iat = Math.floor(now / 1000);
  const header = b64uJson({ alg: 'RS256', typ: 'JWT' });
  const claims = b64uJson({ iss: clientEmail, scope, aud: TOKEN_URL, iat, exp: iat + ttlSec });
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(privateKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`)));
  return `${header}.${claims}.${b64u(sig)}`;
}

// isolate 内のトークンの控え(鍵のメールが変わったら捨てる)
let tokenCache = { email: '', token: '', exp: 0 };
export function resetTokenCache() {
  tokenCache = { email: '', token: '', exp: 0 };
}

export async function fetchAccessToken(env, { fetchFn = globalThis.fetch, now = Date.now() } = {}) {
  if (tokenCache.token && tokenCache.email === env.GCAL_CLIENT_EMAIL && tokenCache.exp - TOKEN_MARGIN_MS > now) {
    return { token: tokenCache.token, cached: true };
  }
  const assertion = await createJwt({ clientEmail: env.GCAL_CLIENT_EMAIL, privateKey: env.GCAL_PRIVATE_KEY, now });
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    // 鍵が違う・メールが違うときは 400 invalid_grant / 401。権限の問題として扱う
    throw new GcalError(`トークン取得に失敗: HTTP ${res.status} ${json.error || ''}`.trim(), { status: res.status === 400 ? 401 : res.status, path: 'token' });
  }
  tokenCache = { email: env.GCAL_CLIENT_EMAIL, token: json.access_token, exp: now + (Number(json.expires_in) || 3600) * 1000 };
  return { token: json.access_token, cached: false };
}

export function createGcalClient(env, { fetchFn = globalThis.fetch, now = Date.now, log = () => {} } = {}) {
  const state = { calls: 0 };

  async function request(method, path, { query, body } = {}) {
    const { token, cached } = await fetchAccessToken(env, { fetchFn, now: now() });
    if (!cached) state.calls += 1;
    const url = new URL(`${API_BASE}${path}`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const started = Date.now();
    state.calls += 1;
    const res = await fetchFn(url.toString(), {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    log(`${method} ${path.replace(/\/calendars\/[^/]+/, '/calendars/…').replace(/\/events\/[^/?]+/, '/events/…')} → ${res.status} (${Date.now() - started}ms)`);
    if (res.status === 204) return null;
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const reason = json?.error?.errors?.[0]?.reason || json?.error?.status || '';
      throw new GcalError(`Google Calendar HTTP ${res.status}${reason ? ` ${reason}` : ''}`, { status: res.status, path });
    }
    return json;
  }

  const calPath = (calendarId) => `/calendars/${encodeURIComponent(calendarId)}/events`;

  return {
    get calls() {
      return state.calls;
    },
    // ボットが作った予定の一覧。timeMin/timeMax は ISO 文字列(省略可)。key を渡すとその 1 件(重複していれば複数)だけ
    async listBotEvents(calendarId, { timeMin, timeMax, key } = {}) {
      const items = [];
      let pageToken;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const json = await request('GET', calPath(calendarId), {
          query: {
            privateExtendedProperty: key ? `${BOT_ID_KEY}=${key}` : `${BOT_MARK_KEY}=${BOT_MARK_VALUE}`,
            singleEvents: 'true',
            showDeleted: 'false',
            maxResults: '250',
            timeMin,
            timeMax,
            pageToken,
          },
        });
        for (const it of json?.items || []) items.push(it);
        pageToken = json?.nextPageToken;
        if (!pageToken) break;
      }
      return items;
    },
    insert(calendarId, body) {
      return request('POST', calPath(calendarId), { body });
    },
    patch(calendarId, id, body) {
      return request('PATCH', `${calPath(calendarId)}/${encodeURIComponent(id)}`, { body });
    },
    async remove(calendarId, id) {
      try {
        await request('DELETE', `${calPath(calendarId)}/${encodeURIComponent(id)}`);
        return true;
      } catch (e) {
        // もう無い(手で消された・二重に消しに来た)なら成功扱い
        if (e instanceof GcalError && (e.status === 404 || e.status === 410)) return false;
        throw e;
      }
    },
  };
}
