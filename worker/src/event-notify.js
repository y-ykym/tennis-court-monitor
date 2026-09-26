// ============================================================
// フェーズ10: テニスベアの新着イベント通知(要件定義書 §20)
//
//   Cron(月・木 20:00 JST) → テニスベアの検索 API で「近くの 6 コート × 土日祝 × 募集中 × テニスのみ × Lv.4 を含む」を取り、
//   前回までに見ていないイベント(新着)だけを、日付ごとに 1 枚のカードにして LINE グループへ push する。
//   合言葉「いべんと」 → 同じ条件の全イベント(新着に限らない)を同じカードで reply する(通数を消費しない)。
//
//   どちらも A・B の予定(都の予約 + テニスベアの参加予定)と突き合わせ、
//     ・時間が重なるイベント                          → 除外(同時に 2 か所ではできない)
//     ・別の場所で、間が 60 分未満のイベント(隣接)    → 除外(移動が間に合わない)。同じ場所なら残す
//
//   ┌──────────────────────────────┐ ┌──────────────────────────────┐
//   │ 10/12 (月祝)          新着 4 件 │ │ 10/17 (土)            新着 4 件 │  ← ヘッダー(土=青 / 日祝=赤。「よやく」の日付タイルと同じ色)
//   ├──────────────────────────────┤ ├──────────────────────────────┤
//   │ 10:00 - 12:00 [荒川砂町]  ¥900 │ │ 7:50 - 10:00 [荒川砂町] ¥1,200 │  ← 1 行目: 時間(md 太字)・コートの札(色つき)・料金(右端)
//   │ 10月12日10-12時 江東区荒川砂町… │ │ サーブ＆レシーブ自由練習会 江東… │  ← 2 行目: イベント名(xs・薄い色・2 行まで)
//   │ ───────────────────────────── │ │ ───────────────────────────── │     行をタップするとイベント詳細ページが開く(uri アクション)
//   │ 14:00 - 17:00 [荒川砂町] ¥1,500 │ │ …                              │
//   ├──────────────────────────────┤ ├──────────────────────────────┤
//   │   タップでイベントの詳細を開く   │ │   タップでイベントの詳細を開く   │  ← フッター(文字だけ。ボタンは置かない)
//   └──────────────────────────────┘ └──────────────────────────────┘
//      ←── 横にスワイプで日付を切り替え ──→   (見本: docs/flex-design-events-v2.html)
//
// 通信(2026-09-26 に実機で調査。docs/site-notes.md):
//   PUT /api/v3/events/search/for-web?limit=200&offset=N   本文 = 検索条件(JSON)。認証不要。並びは「おすすめ」→ 開始日時順
//   GET /api/v3/events/{id}/detail-page-no-add-view          料金(priceOverview)はこれでしか取れない。閲覧数を増やさない方を使う
//   一覧の 1 件は tennisbear.js の normalizeEvent でそのまま整形できる(同じ形)
//
// 「新着」の判定と KV(BOOKING_KV の KV_STATE_KEY 1 キー):
//   { events: { "<id>": { d: "YYYY-MM-DD", p: <料金|null> } } }  … 一度カードに載せた(または載せないと決めた)イベント
//   ・キーが無い = 初回。Cron なら全件を控えるだけで送らない(ならし運転。§20.2 本人決定)。
//     「いべんと」なら表示した全件(候補全部。除外した分も)を控える = そのカードで見たものはもう新着ではない(2026-09-26 本人指示)
//   ・開催日が過去のものは読み込み時に捨てる(容量が増え続けないように)
//   ・予定と重なって除外したものも控える(その後に予約を手放しても再通知しない。単純さ優先)
//   ・書き込みは Cron 1 回につき 1 回(送信の後)。「いべんと」は料金を新しく取ったときだけ 1 回(無料枠 1,000 回/日への影響は無い)
//
// 方針:
//   ・テニスベアの検索・詳細は認証不要なので、ログイン情報は使わない(参加予定の取得だけフェーズ5 の関数を借りる)
//   ・A・B の予定が取れなかった人がいても送る(その人の分の除外はできないので、カードに 1 行添える)
//   ・送信に失敗したら KV を更新しない(次の回にもう一度「新着」として送る。二重に届くほうが、届かないより良い)
//   ・新着 0 件は送らない。検索そのものに失敗したときだけ 1 行のテキストで知らせる
//   ・ログにイベント名・URL・トークンは出さない(件数と所要時間だけ)
// ============================================================
import Holidays from 'japanese-holidays';
import { normalizeEvent } from './tennisbear.js';
import { courtByFacility, courtByTbCode } from './courts.js';
import { pushMessages } from './line.js';
import { formatTime, jstTodayIso } from './format.js';
import { bubbleBytes, MAX_BUBBLE_BYTES, MAX_CAROUSEL_BYTES } from './flex.js';

// グループで受け付ける合言葉(前後の空白を除いた本文との完全一致)
export const EVENT_COMMAND_TEXT = 'いべんと';
// 月・木 20:00 JST(= 11:00 UTC)。wrangler.toml [triggers] と index.js の scheduled() で振り分ける
export const EVENT_NOTIFY_CRON = '0 11 * * 1,4';
export const KV_STATE_KEY = 'tb_event_notify';

// ---- 検索条件(本人決定。2026-09-26) ----
// 通知対象のコート。code はテニスベアの place.code(GET /api/v3/search-menus で確認)。
// short は札に出す短い呼び名、bg/fg は札の色(コートごとに固定。同じ日に複数あるとき色で場所を見分ける)
export const EVENT_PLACES = [
  { code: '0100140006', name: '大横川親水公園テニスコート', short: '大横川', bg: '#EDE9FE', fg: '#5B21B6' },
  { code: '0100140003', name: '錦糸公園テニスコート', short: '錦糸公園', bg: '#FCE7F3', fg: '#9D174D' },
  { code: '0100010008', name: '猿江恩賜公園', short: '猿江', bg: '#E0E7FF', fg: '#3730A3' },
  { code: '0100010009', name: '亀戸中央公園', short: '亀戸', bg: '#FEF3C7', fg: '#92400E' },
  { code: '0100010020', name: '大島小松川公園Ａ', short: '大島小松川', bg: '#CCFBF1', fg: '#115E59' },
  { code: '0100130006', name: '荒川・砂町庭球場', short: '荒川砂町', bg: '#DCFCE7', fg: '#166534' },
];
export const LEVEL_ID = 4; // 初中級。サイトと同じく「募集レベルの範囲に 4 を含む」
export const DAYS_AHEAD = 31; // 今日から何日先まで(直近 1 か月)
export const ADJACENT_MINUTES = 60; // これ未満の間隔で別の場所なら「隣接」
// 終了時刻が取れないイベントは 2 時間とみなす(都のコートは 2 時間単位が基本)
const DEFAULT_DURATION_MIN = 120;

const BASE_URL = 'https://www.tennisbear.net';
const SEARCH_PATH = '/api/v3/events/search/for-web';
const DETAIL_PATH = (id) => `/api/v3/events/${encodeURIComponent(id)}/detail-page-no-add-view`;
export const EVENT_INFO_URL = (id) => `${BASE_URL}/event/${id}/info`;
const PAGE_SIZE = 200;
const MAX_PAGES = 3; // 600 件まで(実測は 1 か月で 80 件前後)
const REQUEST_TIMEOUT_MS = 10000;
const DETAIL_CONCURRENCY = 6;
// 1 回の処理で料金を取りに行く上限。Cloudflare 無料プランは 1 リクエスト(Cron 1 回・Webhook 1 回)につき外部通信 50 回まで。
// 都の予約サイト(A・B で約 10 回)+ テニスベアのログインと予定(4 回)+ 検索(1〜2 回)+ LINE(1〜2 回)+ KV で 20 回近く使うので、
// 料金は 15 件までにして残りは「料金 -」で出す(次の「いべんと」で控えに無い分から順に埋まる)。
// 2026-09-26 の初回「いべんと」は 67 件を取りに行って上限に当たり、LINE への返信ができなかった
export const MAX_PRICE_FETCHES = 15;

export const MSG_EVENT_SEARCH_FAILED = '🐻 テニスベアに繋がらず、新着イベントを確認できませんでした';
export const MSG_EVENT_NONE = '🐻 条件に合うイベントは今ありません(近くのコート・土日祝・初中級・募集中)';
export const MSG_EVENT_FAILED = '🐻 イベントの一覧を作れませんでした。少し待ってもう一度お試しください';

// Flex の配色(flex.js と同じ値。日付の色は「よやく」の日付タイルに揃える)
const HEADER_COLORS = {
  sat: { bg: '#E3EEFB', fg: '#1D4F91' },
  sun: { bg: '#FBE4E4', fg: '#9B2C2C' },
  weekday: { bg: '#EEF0F3', fg: '#374151' },
};
const COLOR_TEXT = '#111827';
const COLOR_SUB = '#6B7280';
const COLOR_MUTED = '#9CA3AF';
const COLOR_LINE = '#E5E7EB';
const COLOR_WARN = '#B45309';
const ROWS_PER_BUBBLE = 8; // 1 枚に載せる上限(超えたらその日を 2 枚に分ける)
const BUBBLES_PER_MESSAGE = 12; // LINE のカルーセル上限
const MESSAGES_PER_SEND = 5; // LINE の 1 回の push/reply 上限

const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];
const text = (str, extra = {}) => ({ type: 'text', text: String(str), ...extra });

// ---- 日付・時刻のユーティリティ ----
function toUtcDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function addDays(iso, n) {
  return new Date(toUtcDate(iso).getTime() + n * 86400000).toISOString().slice(0, 10);
}
export function isHolidayIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return !!Holidays.isHoliday(new Date(y, m - 1, d)); // japanese-holidays はローカル日付で判定する
}
// 土日祝か(検索 API の satFlg/sunFlg/holidayFlg と同じ判定を手元でも掛けて、API の解釈が変わっても平日を出さない)
export function isWeekendOrHoliday(iso) {
  const dow = toUtcDate(iso).getUTCDay();
  return dow === 0 || dow === 6 || isHolidayIso(iso);
}
function dayKind(iso) {
  const dow = toUtcDate(iso).getUTCDay();
  if (dow === 0 || isHolidayIso(iso)) return 'sun';
  return dow === 6 ? 'sat' : 'weekday';
}
const shortDate = (iso) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${m}/${d}`;
};
// "月祝" のように、祝日は曜日の後ろに「祝」
const dowLabel = (iso) => `${DOW_JA[toUtcDate(iso).getUTCDay()]}${isHolidayIso(iso) && toUtcDate(iso).getUTCDay() !== 0 ? '祝' : ''}`;
const toMin = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const fromMin = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// ---- 検索 ----
// 検索 API に送る条件(ブラウザが送る形と同じ項目を全部書く。省いても動くが、サーバーの既定値に頼らない)
export function searchBody() {
  return {
    prefectureCodeList: [],
    regionCodeList: [],
    tennis365Flg: false,
    areaCodeList: [],
    placeCodeList: EVENT_PLACES.map((p) => p.code),
    sunFlg: true,
    monFlg: false,
    tuesFlg: false,
    wedFlg: false,
    thursFlg: false,
    friFlg: false,
    satFlg: true,
    holidayFlg: true,
    dateList: [],
    timePeriodTypeList: [],
    isOpen: true,
    tennisOnlyFlg: true,
    lookingForMembers: false,
    levelList: [LEVEL_ID],
    tournamentTypeList: [],
    keyword: null,
    maxLat: null,
    maxLng: null,
    minLat: null,
    minLng: null,
    indoorFlg: false,
    courtTypeOmniFlg: false,
    courtTypeCrayFlg: false,
    courtTypeHardFlg: false,
    courtTypeCarpetFlg: false,
    anyoneBookable: false,
    anyoneRegisterable: false,
    distanceSearch: null,
    friendOrganizeFlg: null,
    fullSoonFlg: null,
    priceUpperLimit: null,
    sameAboutAgeOrganizerFlg: null,
    sameGenderOrganizerFlg: null,
    sameLevelOrganizerFlg: null,
    goodOsusumeOrganizerFlg: null,
    pickleballFlg: false,
    softTennisFlg: false,
    beachTennisFlg: false,
    padelFlg: false,
  };
}

async function requestJson(pathname, { method = 'GET', body, signal, fetchImpl = fetch, log = () => {} }) {
  const started = Date.now();
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetchImpl(BASE_URL + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal || timeout,
  });
  log(`${method} ${pathname.replace('/api/v3/', '').replace(/\d{5,}/, '<id>')} ${res.status} ${Date.now() - started}ms`);
  if (!res.ok) throw new Error(`テニスベア HTTP ${res.status}: ${pathname.replace(/\d{5,}/, '<id>')}`);
  return res.json();
}

// 一覧の 1 件を整形する。normalizeEvent(tennisbear.js)の形 + 満員・中止の印
export function normalizeSearchItem(raw) {
  const ev = normalizeEvent(raw);
  if (!ev) return null;
  return { ...ev, isFull: raw.isFull === true, callOff: raw.callOff === true };
}

// 検索 API を offset をずらして呼び、全件を整形して返す(形が崩れた件は飛ばす)
export async function searchEvents({ signal, fetchImpl = fetch, log = () => {} } = {}) {
  const body = searchBody();
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const payload = await requestJson(`${SEARCH_PATH}?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`, { method: 'PUT', body, signal, fetchImpl, log });
    if (!Array.isArray(payload)) throw new Error('テニスベアの検索の応答が配列ではありません');
    out.push(...payload.map(normalizeSearchItem).filter(Boolean));
    if (payload.length < PAGE_SIZE) break;
  }
  return out;
}

// 通知の対象か: 今日〜DAYS_AHEAD 日先、土日祝、対象コート、満員・中止でない
export function inScope(ev, today) {
  if (!ev?.date || !ev.id) return false;
  if (ev.date < today || ev.date > addDays(today, DAYS_AHEAD)) return false;
  if (!isWeekendOrHoliday(ev.date)) return false;
  if (!EVENT_PLACES.some((p) => p.code === ev.placeCode)) return false;
  if (ev.isFull || ev.callOff) return false;
  return true;
}

// 日付 → 開始時刻 → id の順(カードの並び)
export function sortEvents(events) {
  return [...events].sort((a, b) => (a.date + (a.start || '') + a.id).localeCompare(b.date + (b.start || '') + b.id));
}

// ---- 料金(詳細 API) ----
// ids の料金をまとめて取る。cache(id → 料金)にあるものは取りに行かない。取れなかった id と、上限(max)を超えた分は null。
// 戻り値: Map(id → 料金|null)。並列は DETAIL_CONCURRENCY まで、取りに行く件数は max まで(ids の先頭 = 日付の早い順から)
export async function fetchPrices(ids, { cache = {}, max = MAX_PRICE_FETCHES, signal, fetchImpl = fetch, log = () => {} } = {}) {
  const prices = new Map();
  const todo = [];
  for (const id of ids) {
    if (Object.prototype.hasOwnProperty.call(cache, id) && cache[id] != null) prices.set(id, cache[id]);
    else if (todo.length < max) todo.push(id);
    else prices.set(id, null);
  }
  let idx = 0;
  let failed = 0;
  const worker = async () => {
    while (idx < todo.length) {
      if (signal?.aborted) return;
      const id = todo[idx++];
      try {
        const det = await requestJson(DETAIL_PATH(id), { signal, fetchImpl, log: () => {} });
        prices.set(id, Number.isFinite(det?.priceOverview) ? det.priceOverview : null);
      } catch {
        failed++;
        prices.set(id, null);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, todo.length) }, worker));
  const deferred = [...prices.values()].filter((v) => v == null).length - failed;
  if (todo.length || deferred) log(`料金の取得 ${todo.length}件(失敗 ${failed}件${deferred ? ` / 上限 ${max} 件のため後回し ${deferred}件` : ''})`);
  return prices;
}

// ---- 予定との突き合わせ ----
// A・B の予定を 1 本の配列にする。
//   results: index.js の fetchAllReservations の戻り値 [{ slot, label, reservations } | { slot, label, error }]
//   tb:      index.js の fetchAllTennisbear の戻り値 [{ slot, events } | { slot, error }]
// 予定の場所は「テニスベアの place.code の配列」に揃える(都の公園名は courts.js の台帳で引く。区営など台帳に無い place.code はその値だけ)。
// 戻り値 { items: [{ date, start, end, placeCodes, label }], failed: ['ゆうたそ(都の予約)', …] }
export function buildSchedules(results = [], tb = []) {
  const items = [];
  const failed = [];
  const labelOf = (slot) => results.find((p) => p.slot === slot)?.label || slot;
  for (const p of results || []) {
    if (p.error) {
      failed.push(`${p.label || p.slot}(都の予約)`);
      continue;
    }
    for (const r of p.reservations || []) {
      if (!r.date || !r.start) continue;
      const court = courtByFacility(r.facility);
      items.push({ date: r.date, start: r.start, end: r.end || fromMin(toMin(r.start) + DEFAULT_DURATION_MIN), placeCodes: court ? [...court.tbCodes] : [], label: p.label || p.slot });
    }
  }
  for (const t of tb || []) {
    if (t.error) {
      failed.push(`${labelOf(t.slot)}(テニスベアの予定)`);
      continue;
    }
    for (const e of t.events || []) {
      if (!e.date || !e.start) continue;
      const court = courtByTbCode(e.placeCode);
      items.push({ date: e.date, start: e.start, end: e.end || fromMin(toMin(e.start) + DEFAULT_DURATION_MIN), placeCodes: court ? [...court.tbCodes] : e.placeCode ? [e.placeCode] : [], label: labelOf(t.slot) });
    }
  }
  return { items, failed };
}

// イベント ev と予定 item の関係。'overlap'(重なる)| 'adjacent'(別の場所で間が ADJACENT_MINUTES 未満)| null(問題なし)
export function conflictKind(ev, item, { adjacentMinutes = ADJACENT_MINUTES } = {}) {
  if (!ev?.date || ev.date !== item?.date) return null;
  const evStart = toMin(ev.start);
  const itStart = toMin(item.start);
  if (evStart == null || itStart == null) return null;
  const evEnd = toMin(ev.end) ?? evStart + DEFAULT_DURATION_MIN;
  const itEnd = toMin(item.end) ?? itStart + DEFAULT_DURATION_MIN;
  if (evStart < itEnd && itStart < evEnd) return 'overlap';
  const samePlace = !!ev.placeCode && (item.placeCodes || []).includes(ev.placeCode);
  if (samePlace) return null;
  const gap = evStart >= itEnd ? evStart - itEnd : itStart - evEnd;
  return gap < adjacentMinutes ? 'adjacent' : null;
}

// 予定と重なる・隣接するイベントを除く。戻り値 { kept, excluded: [{ event, kind, item }] }
export function excludeConflicts(events, items, opts) {
  const kept = [];
  const excluded = [];
  for (const ev of events) {
    let hit = null;
    for (const item of items) {
      const kind = conflictKind(ev, item, opts);
      if (kind === 'overlap') {
        hit = { kind, item };
        break;
      }
      if (kind === 'adjacent' && !hit) hit = { kind, item };
    }
    if (hit) excluded.push({ event: ev, ...hit });
    else kept.push(ev);
  }
  return { kept, excluded };
}

// ---- KV の控え ----
// { events: { id: { d, p } } }。開催日が today より前のものは捨てる。無い・壊れている → null(初回扱い)
export async function loadState(env, today) {
  if (!env.BOOKING_KV) return null;
  let v;
  try {
    v = JSON.parse((await env.BOOKING_KV.get(KV_STATE_KEY)) || 'null');
  } catch {
    return null;
  }
  if (!v || typeof v.events !== 'object' || v.events === null) return null;
  const events = {};
  for (const [id, e] of Object.entries(v.events)) {
    if (e && typeof e.d === 'string' && e.d >= today) events[id] = { d: e.d, p: Number.isFinite(e.p) ? e.p : null };
  }
  return { events };
}
export async function saveState(env, state) {
  if (!env.BOOKING_KV) return false;
  await env.BOOKING_KV.put(KV_STATE_KEY, JSON.stringify({ events: state.events, savedAt: new Date().toISOString() }));
  return true;
}
// 控えに events を追加する(料金 prices があれば添える)。同じ id は上書き
export function recordEvents(state, events, prices = new Map()) {
  const next = { events: { ...(state?.events || {}) } };
  for (const ev of events) {
    const prev = next.events[ev.id];
    const p = prices.has(ev.id) && prices.get(ev.id) != null ? prices.get(ev.id) : prev?.p ?? null;
    next.events[ev.id] = { d: ev.date, p };
  }
  return next;
}
// 控えに無いイベントだけ
export function pickNew(events, state) {
  const seen = state?.events || {};
  return events.filter((ev) => !Object.prototype.hasOwnProperty.call(seen, ev.id));
}

// ---- Flex ----
export function priceText(p) {
  if (p == null) return '料金 -';
  if (p === 0) return '無料';
  return `¥${p.toLocaleString('ja-JP')}`;
}

function placeChip(placeCode) {
  const place = EVENT_PLACES.find((p) => p.code === placeCode) || { short: 'その他', bg: '#EEF0F3', fg: '#374151' };
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    backgroundColor: place.bg,
    cornerRadius: '6px',
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingStart: '6px',
    paddingEnd: '6px',
    contents: [text(place.short, { size: 'xxs', weight: 'bold', color: place.fg })],
  };
}

// 1 行 = 1 イベント。1 行目: 時間・コートの札・料金、2 行目: イベント名(2 行まで)。行全体が詳細ページへのリンク
export function eventRow(ev, price, { first }) {
  const time = ev.start && ev.end ? `${formatTime(ev.start)} - ${formatTime(ev.end)}` : ev.start ? `${formatTime(ev.start)} -` : '時間不明';
  return {
    type: 'box',
    layout: 'vertical',
    margin: first ? 'md' : 'none',
    paddingTop: '10px',
    paddingBottom: '10px',
    action: { type: 'uri', label: '詳細', uri: EVENT_INFO_URL(ev.id) },
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        alignItems: 'center',
        spacing: 'sm',
        contents: [
          text(time, { size: 'md', weight: 'bold', color: COLOR_TEXT, flex: 0 }),
          placeChip(ev.placeCode),
          text(priceText(price), { size: 'sm', weight: 'bold', color: COLOR_TEXT, align: 'end', flex: 1, gravity: 'center' }),
        ],
      },
      text(ev.title || 'イベント', { size: 'xs', color: COLOR_SUB, wrap: true, maxLines: 2, margin: 'sm' }),
    ],
  };
}

// 見出しの右側。分割していない日は「新着 N 件」「N 件」。分割した日(range = [from, to])は「1〜8 / 11 件」のように
// この枡に載っている範囲を出す(2026-09-26 実機確認で「その1 … 11 件」だと 8 行しか無いのに 11 と見えて数が合わない、を直した)
function countLabel(count, { mode, range }) {
  if (range) return `${mode === 'new' ? '新着 ' : ''}${range[0]}〜${range[1]} / ${count} 件`;
  return mode === 'new' ? `新着 ${count} 件` : `${count} 件`;
}

function dateHeader(iso, count, { mode, part, range }) {
  const colors = HEADER_COLORS[dayKind(iso)];
  const label = countLabel(count, { mode, range });
  return {
    type: 'box',
    layout: 'horizontal',
    backgroundColor: colors.bg,
    paddingAll: '12px',
    paddingStart: '16px',
    paddingEnd: '16px',
    alignItems: 'flex-end',
    contents: [
      text(shortDate(iso), { size: 'xxl', weight: 'bold', color: colors.fg, flex: 0 }),
      text(`(${dowLabel(iso)})${part ? ` ${part}` : ''}`, { size: 'md', weight: 'bold', color: colors.fg, flex: 1, margin: 'sm', gravity: 'bottom' }),
      text(label, { size: 'sm', color: colors.fg, flex: 0, align: 'end', gravity: 'bottom' }),
    ],
  };
}

function dateBubble(iso, rows, prices, { mode, part, total, note, range }) {
  const body = [];
  rows.forEach((ev, i) => {
    if (i > 0) body.push({ type: 'separator', color: COLOR_LINE });
    body.push(eventRow(ev, prices.get(ev.id), { first: i === 0 }));
  });
  if (note) body.push(text(note, { size: 'xxs', color: COLOR_WARN, wrap: true, margin: 'md' }));
  return {
    type: 'bubble',
    size: 'mega',
    header: dateHeader(iso, total, { mode, part, range }),
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', paddingTop: '0px', paddingBottom: '6px', backgroundColor: '#FFFFFF', contents: body },
    footer: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#FFFFFF',
      contents: [{ type: 'separator', color: COLOR_LINE }, text('タップでイベントの詳細を開く', { size: 'xxs', color: COLOR_MUTED, align: 'center', margin: 'md' })],
      paddingBottom: '10px',
    },
  };
}

// 日付ごとに 1 枚。1 日が ROWS_PER_BUBBLE 行(またはバイト上限)を超えたら「その1」「その2」に分ける。
// カルーセルは 12 枚まで、かつ全体 50KB まで(実測 8 行の枡が約 8.7KB → 1 つのカルーセルに 5 枚前後)。
// 溢れたら次のカルーセルに送る(1 回の送信は 5 メッセージまで。それ以上は切り捨てて件数だけ altText に残す)
//   events: inScope 済み・任意の順。prices: Map(id → 料金|null)。mode: 'new'(定期通知)| 'all'(「いべんと」)。note: 先頭の枡に添える注意書き
// 戻り値: Flex メッセージの配列(空配列 = 0 件)
export function buildEventMessages(events, prices = new Map(), { mode = 'new', note = null } = {}) {
  const sorted = sortEvents(events);
  if (sorted.length === 0) return [];
  const byDate = new Map();
  for (const ev of sorted) {
    if (!byDate.has(ev.date)) byDate.set(ev.date, []);
    byDate.get(ev.date).push(ev);
  }
  const bubbles = [];
  let firstNote = note;
  for (const [iso, rows] of byDate) {
    const chunks = [];
    for (let i = 0; i < rows.length; i += ROWS_PER_BUBBLE) chunks.push(rows.slice(i, i + ROWS_PER_BUBBLE));
    chunks.forEach((chunk, ci) => {
      const part = chunks.length > 1 ? `その${ci + 1}` : '';
      const from = ci * ROWS_PER_BUBBLE + 1;
      const opts = () => ({ mode, part, total: rows.length, note: firstNote, range: chunks.length > 1 ? [from, from + chunk.length - 1] : null });
      let bubble = dateBubble(iso, chunk, prices, opts());
      // バイト上限(30KB)は 8 行なら届かないが、念のため行を減らして収める
      while (bubbleBytes(bubble) > MAX_BUBBLE_BYTES && chunk.length > 1) {
        chunk.pop();
        bubble = dateBubble(iso, chunk, prices, opts());
      }
      firstNote = null;
      bubbles.push(bubble);
    });
  }
  const alt = altText(sorted, mode);
  const groups = packBubbles(bubbles);
  return groups.slice(0, MESSAGES_PER_SEND).map((slice) => ({ type: 'flex', altText: alt, contents: slice.length === 1 ? slice[0] : { type: 'carousel', contents: slice } }));
}

// 枡を順番に、12 枚・MAX_CAROUSEL_BYTES を超えない範囲でカルーセルに詰める(カルーセルの外枠ぶんは数十バイトなので枡の合計で見る)
export function packBubbles(bubbles) {
  const groups = [];
  let cur = [];
  let bytes = 0;
  for (const b of bubbles) {
    const size = bubbleBytes(b);
    if (cur.length > 0 && (cur.length >= BUBBLES_PER_MESSAGE || bytes + size > MAX_CAROUSEL_BYTES - 200)) {
      groups.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(b);
    bytes += size;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// プッシュ通知バナーに出る要約(上限 400 字)
export function altText(events, mode = 'new') {
  const sorted = sortEvents(events);
  if (sorted.length === 0) return mode === 'new' ? '🐻 新着イベント 0 件' : '🐻 イベント 0 件';
  const first = sorted[0].date;
  const last = sorted[sorted.length - 1].date;
  const range = first === last ? `${shortDate(first)}(${dowLabel(first)})` : `${shortDate(first)}〜${shortDate(last)}`;
  return `🐻 ${mode === 'new' ? '新着イベント' : 'イベント'} ${sorted.length} 件(${range})`.slice(0, 400);
}

// テキスト版(Flex が 400 で弾かれたときの再送)。1 イベント 1 行、日付ごとに見出し
export function eventText(events, prices = new Map(), { mode = 'new', note = null } = {}) {
  const sorted = sortEvents(events);
  const lines = [altText(sorted, mode)];
  let cur = null;
  for (const ev of sorted) {
    if (ev.date !== cur) {
      cur = ev.date;
      lines.push('', `■ ${shortDate(ev.date)}(${dowLabel(ev.date)})`);
    }
    const place = EVENT_PLACES.find((p) => p.code === ev.placeCode)?.short || ev.facility || '';
    lines.push(`${formatTime(ev.start)}-${formatTime(ev.end)} ${place} ${priceText(prices.get(ev.id))}`, `  ${ev.title}`, `  ${EVENT_INFO_URL(ev.id)}`);
  }
  if (note) lines.push('', note);
  return lines.join('\n').slice(0, 5000);
}

// 予定が取れなかった人がいるときにカードへ添える 1 行
export const scheduleNote = (failed) => (failed.length ? `⚠️ ${failed.join('・')}を確認できなかったので、予定と重なるものも入っています` : null);

// ---- 共通の取り込み: 検索 → 対象を絞る → 予定と突き合わせ → 料金 ----
//   fetchResults / fetchTb は index.js の fetchAllReservations / fetchAllTennisbear を包んだ関数(テストで差し替える)
//   onlyNew: true なら KV の控えに無いものだけ(定期通知)
// 戻り値 { events(候補), kept, excluded, failed, prices, state }
async function collect(env, { today, onlyNew, state, fetchResults, fetchTb, fetchImpl, signal, log }) {
  const [all, results, tb] = await Promise.all([
    searchEvents({ signal, fetchImpl, log }),
    fetchResults ? fetchResults().catch((e) => (log(`都の予約の取得に失敗: ${e.message}`), null)) : Promise.resolve([]),
    fetchTb ? fetchTb().catch((e) => (log(`テニスベアの予定の取得に失敗: ${e.message}`), null)) : Promise.resolve([]),
  ]);
  const scoped = sortEvents(all.filter((ev) => inScope(ev, today)));
  const events = onlyNew ? pickNew(scoped, state) : scoped;
  const { items, failed } = buildSchedules(results, tb);
  if (results === null) failed.unshift('都の予約');
  if (tb === null) failed.push('テニスベアの予定');
  const { kept, excluded } = excludeConflicts(events, items);
  const cache = Object.fromEntries(Object.entries(state?.events || {}).map(([id, e]) => [id, e.p]));
  const prices = await fetchPrices(
    kept.map((e) => e.id),
    { cache, signal, fetchImpl, log }
  );
  log(`検索 ${all.length}件 → 対象 ${scoped.length}件${onlyNew ? ` → 新着 ${events.length}件` : ''} → 予定と重なる/隣接 ${excluded.length}件を除いて ${kept.length}件${failed.length ? ` / 予定を確認できず ${failed.length}` : ''}`);
  return { events, kept, excluded, failed, prices };
}

// Cron(月・木 20:00)から呼ばれる本体。
// 戻り値 { seeded, candidates, sent, excluded, failed }(sent: 送ったイベント数。0 なら送っていない)
export async function runEventNotify(env, { now = Date.now(), fetchResults, fetchTb, fetchImpl = fetch, push = pushMessages, log = (m) => console.log(`[events] ${m}`) } = {}) {
  const started = Date.now();
  const today = jstTodayIso(new Date(now));
  const state = await loadState(env, today);

  // 初回(控えが無い): 今あるイベントを全部控えて、送らない(ならし運転)
  if (!state) {
    let all;
    try {
      all = await searchEvents({ fetchImpl, log });
    } catch (e) {
      log(`初回の控え作成に失敗(次の回にやり直す): ${e.message}`);
      return { seeded: 0, candidates: 0, sent: 0, excluded: 0, failed: [] };
    }
    const scoped = all.filter((ev) => inScope(ev, today));
    await saveState(env, recordEvents({ events: {} }, scoped));
    log(`初回: ${scoped.length}件を控えました(送信なし) (${Date.now() - started}ms)`);
    return { seeded: scoped.length, candidates: 0, sent: 0, excluded: 0, failed: [] };
  }

  let c;
  try {
    c = await collect(env, { today, onlyNew: true, state, fetchResults, fetchTb, fetchImpl, log });
  } catch (e) {
    log(`検索に失敗: ${e.message}`);
    try {
      await push(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_GROUP_ID, [{ type: 'text', text: MSG_EVENT_SEARCH_FAILED }]);
    } catch (e2) {
      log(`失敗の知らせも送れませんでした: ${e2.message}`);
    }
    return { seeded: 0, candidates: 0, sent: 0, excluded: 0, failed: ['search'] };
  }

  const note = scheduleNote(c.failed);
  if (c.kept.length > 0) {
    const messages = buildEventMessages(c.kept, c.prices, { mode: 'new', note });
    try {
      await push(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_GROUP_ID, messages);
    } catch (e) {
      if (e.status !== 400) {
        log(`送信に失敗(控えは更新しない。次の回にもう一度送る): ${e.message}`);
        return { seeded: 0, candidates: c.events.length, sent: 0, excluded: c.excluded.length, failed: c.failed, error: e.message };
      }
      log(`Flex が 400 のためテキストで再送: ${e.message}`);
      await push(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_GROUP_ID, [{ type: 'text', text: eventText(c.kept, c.prices, { mode: 'new', note }) }]);
    }
  }
  // 送った分も、予定と重なって外した分も控える(控えは送信の後。送れなかったら次の回にもう一度新着として扱う)
  try {
    await saveState(env, recordEvents(state, c.events, c.prices));
  } catch (e) {
    log(`控えの保存に失敗(次の回に同じ内容がもう一度届きます): ${e.message}`);
  }
  log(`新着 ${c.events.length}件 → 送信 ${c.kept.length}件 (${Date.now() - started}ms)`);
  return { seeded: 0, candidates: c.events.length, sent: c.kept.length, excluded: c.excluded.length, failed: c.failed };
}

// 「いべんと」への返信。今の条件に合う全イベント(予定と重なる・隣接するものは除く)。
// 控えが無ければ(初回)、表示した候補を全部控える = ならし運転を「いべんと」1 回で済ませられる。
// 戻り値 { messages, text } または { text }(0 件・失敗)
export async function buildEventReply(env, { now = Date.now(), fetchResults, fetchTb, fetchImpl = fetch, log = (m) => console.log(`[events] ${m}`) } = {}) {
  const today = jstTodayIso(new Date(now));
  const state = await loadState(env, today);
  const c = await collect(env, { today, onlyNew: false, state, fetchResults, fetchTb, fetchImpl, log });
  if (!state) {
    try {
      await saveState(env, recordEvents({ events: {} }, c.events, c.prices));
      log(`初回: 「いべんと」で表示した ${c.events.length}件を控えました(次の定期通知からは新着だけ)`);
    } catch (e) {
      log(`初回の控えを保存できませんでした(次の Cron が控えを作る): ${e.message}`);
    }
  }
  // 新しく取れた料金は控えに足しておく(次の定期通知・次の「いべんと」で取りに行かない)
  if (state) {
    const known = state.events;
    const learned = c.kept.some((ev) => c.prices.get(ev.id) != null && known[ev.id]?.p == null && Object.prototype.hasOwnProperty.call(known, ev.id));
    if (learned) {
      try {
        const next = { events: { ...known } };
        for (const ev of c.kept) if (known[ev.id] && c.prices.get(ev.id) != null) next.events[ev.id] = { d: ev.date, p: c.prices.get(ev.id) };
        await saveState(env, next);
      } catch (e) {
        log(`料金の控えを保存できませんでした(表示には影響なし): ${e.message}`);
      }
    }
  }
  const note = scheduleNote(c.failed);
  if (c.kept.length === 0) return { text: note ? `${MSG_EVENT_NONE}\n${note}` : MSG_EVENT_NONE };
  return { messages: buildEventMessages(c.kept, c.prices, { mode: 'all', note }), text: eventText(c.kept, c.prices, { mode: 'all', note }) };
}
