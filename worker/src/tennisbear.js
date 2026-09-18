// ============================================================
// フェーズ5: テニスベア(www.tennisbear.net)の「今後の予定」を取る(要件定義書 §15)
//
//   fetchTennisbearEvents({ email, password }, { signal, log }) → Promise<TbEvent[]>
//
//   TbEvent = {
//     source:   'tennisbear',   // 都の予約(source 無し)と見分ける印。キャンセルボタンを付けない判定にも使う
//     id:       string,         // イベント ID(URL 用)
//     title:    string,         // イベント名(行の見出し。🐻 を付けて出す)
//     date:     string,         // "YYYY-MM-DD"(JST)
//     start:    string,         // "HH:MM"(0 埋め。都の予約と桁を揃えないと日付順がずれる)
//     end:      string,         // "HH:MM"(終了時刻は datetimeForDisplay からしか取れない。取れなければ '')
//     facility: string,         // コート名(place.name)。行の 2 段目
//     placeCode: string,        // テニスベアの施設 ID(place.code)。都の予約と同じ枠かの突き合わせに使う(courts.js)
//     lat, lng: number|null,    // コートの緯度経度(place.lat/lng)。台帳に無いコート(都営以外)の天気に使う
//     organizer: boolean,       // 主催かどうか(myInfo.isOrganizer)。表示には使わないが保持
//   }
//
// 通信の流れ(2026-09-17 に実機で調査。JSON API なので HTML 解析も Shift_JIS も不要):
//   1. POST /api/v3/auth/login/email   { email, password } → { user, token: { accessToken } }
//   2. GET  /api/v3/events/me/future   Authorization: Bearer <accessToken> → イベントの配列
//
// 方針:
//   - 「よやく」の返信は都の取得と並行で走らせ、こちらが遅れても都の予約だけは必ず返す(上限は呼び出し側で 12 秒程度)
//   - 認証エラー(401/403 や token が無い応答)は再試行しない(繰り返すとロックの恐れ)
//   - 非公開の内部 API なので形が変わりうる。1 件の形が崩れていてもその件だけ飛ばし、全体は返す
//   - ログにメールアドレス・パスワード・トークン・イベント名を出さない(件数と所要時間だけ)
// ============================================================

const BASE_URL = 'https://www.tennisbear.net';
const LOGIN_PATH = '/api/v3/auth/login/email';
const FUTURE_PATH = '/api/v3/events/me/future';
export const EVENT_URL = (id) => `${BASE_URL}/event/${id}`;
// 1 リクエストの上限(呼び出し側の全体予算とは別)
const REQUEST_TIMEOUT_MS = 10000;

export class TennisbearAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TennisbearAuthError';
  }
}

async function requestJson(pathname, { method = 'GET', body, token, signal, log }) {
  const started = Date.now();
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(BASE_URL + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal || timeout,
  });
  log(`${method} ${pathname.replace('/api/v3/', '')} ${res.status} ${Date.now() - started}ms`);
  if (res.status === 401 || res.status === 403) throw new TennisbearAuthError(`テニスベアの認証に失敗しました(HTTP ${res.status})`);
  if (!res.ok) throw new Error(`テニスベア HTTP ${res.status}: ${pathname}`);
  return res.json();
}

// "9:00" / "19:00" → "09:00" / "19:00"。数字と ':' 以外(全角コロンなど)も揃える。読めなければ ''
export function normalizeTime(s) {
  const m = String(s ?? '')
    .replace(/[：]/g, ':')
    .match(/(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return '';
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

// "9/22(火祝) 19:00-21:00" → { start: '19:00', end: '21:00' }。片方しか無ければ end は ''
export function parseDisplayRange(display) {
  const m = String(display ?? '')
    .replace(/[：]/g, ':')
    .replace(/[〜～]/g, '-')
    .match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  if (!m) return { start: '', end: '' };
  return { start: normalizeTime(m[1]), end: normalizeTime(m[2]) };
}

// API の 1 件を都の予約と同じ形に。必須(日付)が取れない・形が違うものは null
//   startDatetimeString は "2026-09-22T19:00:00.000+09:00"(末尾 +09:00 なので先頭 10 文字が JST の日付、11〜16 文字目が開始時刻)。
//   万一 Z や別のオフセットで来たら Date で JST に直す
export function normalizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const iso = typeof ev.startDatetimeString === 'string' ? ev.startDatetimeString : '';
  let date = '';
  let start = '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*\+09:00$/.test(iso)) {
    date = iso.slice(0, 10);
    start = iso.slice(11, 16);
  } else if (iso) {
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) {
      const jst = new Date(t + 9 * 60 * 60 * 1000).toISOString();
      date = jst.slice(0, 10);
      start = jst.slice(11, 16);
    }
  }
  const range = parseDisplayRange(ev.datetimeForDisplay);
  if (!date) return null;
  return {
    source: 'tennisbear',
    id: ev.id != null ? String(ev.id) : '',
    title: typeof ev.eventTitle === 'string' && ev.eventTitle.trim() ? ev.eventTitle.trim() : 'イベント',
    date,
    start: start || range.start,
    end: range.end,
    facility: typeof ev.place?.name === 'string' ? ev.place.name.trim() : '',
    placeCode: ev.place?.code != null ? String(ev.place.code) : '',
    lat: Number.isFinite(ev.place?.lat) ? ev.place.lat : null,
    lng: Number.isFinite(ev.place?.lng) ? ev.place.lng : null,
    organizer: ev.myInfo?.isOrganizer === true,
  };
}

// 配列 → 正規化済みの配列(形が崩れた件は飛ばす)。API が配列以外を返したら例外
export function normalizeEvents(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.events) ? payload.events : Array.isArray(payload?.data) ? payload.data : null;
  if (!list) throw new Error('テニスベアの応答が配列ではありません');
  return list.map(normalizeEvent).filter(Boolean);
}

export async function fetchTennisbearEvents({ email, password }, { signal, log = () => {} } = {}) {
  const login = await requestJson(LOGIN_PATH, { method: 'POST', body: { email, password }, signal, log });
  const token = login?.token?.accessToken;
  if (typeof token !== 'string' || !token) throw new TennisbearAuthError('テニスベアのログイン応答にトークンがありません');
  const payload = await requestJson(FUTURE_PATH, { token, signal, log });
  const events = normalizeEvents(payload);
  log(`今後の予定 ${events.length}件(元データ ${Array.isArray(payload) ? payload.length : '?'}件)`);
  return events;
}
