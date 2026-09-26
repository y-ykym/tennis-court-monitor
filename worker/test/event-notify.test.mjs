// フェーズ10 新着イベント通知のテスト(テニスベア・LINE には行かない。fetch と push は偽物で受け止める)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_COMMAND_TEXT,
  EVENT_NOTIFY_CRON,
  EVENT_PLACES,
  KV_STATE_KEY,
  ADJACENT_MINUTES,
  MAX_PRICE_FETCHES,
  searchBody,
  normalizeSearchItem,
  searchEvents,
  inScope,
  isWeekendOrHoliday,
  fetchPrices,
  buildSchedules,
  conflictKind,
  excludeConflicts,
  loadState,
  recordEvents,
  pickNew,
  priceText,
  buildEventMessages,
  altText,
  eventText,
  runEventNotify,
  buildEventReply,
  MSG_EVENT_SEARCH_FAILED,
  MSG_EVENT_NONE,
} from '../src/event-notify.js';

// 2026-09-26 に実機で見た一覧の 1 件の形(要件定義書 §20.3)
const RAW = {
  id: 1641200,
  eventType: 'NORMAL',
  eventTitle: '基礎練習会　荒川砂町庭球場',
  datetimeForDisplay: '10/17(土) 8:00-10:00',
  startDatetimeString: '2026-10-17T08:00:00.000+09:00',
  place: { code: '0100130006', name: '荒川・砂町庭球場', lat: 35.68, lng: 139.83 },
  minLevel: { id: 4, name: '初中級' },
  maxLevel: { id: 6, name: '中上級' },
  isFull: false,
  callOff: false,
  organizer: { id: 1, name: 'x', myInfo: { isFriend: false } },
};
const raw = (over = {}) => ({ ...RAW, ...over });
const ev = (over = {}) => ({
  source: 'tennisbear',
  id: '1641200',
  title: '基礎練習会　荒川砂町庭球場',
  date: '2026-10-17',
  start: '08:00',
  end: '10:00',
  facility: '荒川・砂町庭球場',
  placeCode: '0100130006',
  lat: 35.68,
  lng: 139.83,
  organizer: false,
  isFull: false,
  callOff: false,
  ...over,
});
// 2026-09-26(土) 20:00 JST
const NOW = Date.parse('2026-09-26T11:00:00Z');
const TODAY = '2026-09-26';

function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    puts: 0,
    async get(k) {
      return store.has(k) ? store.get(k) : null;
    },
    async put(k, v) {
      this.puts++;
      store.set(k, v);
    },
  };
}
const envWith = (kv) => ({ BOOKING_KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'token', LINE_GROUP_ID: 'Cgroup' });

// テニスベアの偽 fetch: 検索は searchRows を、詳細は prices[id] を返す。呼ばれた URL を記録する
function fakeFetch({ searchRows = [], prices = {}, failSearch = false, failDetail = false } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const u = new URL(url);
    if (u.pathname === '/api/v3/events/search/for-web') {
      if (failSearch) return new Response('down', { status: 503 });
      const offset = Number(u.searchParams.get('offset') || 0);
      const limit = Number(u.searchParams.get('limit') || 200);
      return Response.json(searchRows.slice(offset, offset + limit));
    }
    const m = /^\/api\/v3\/events\/(\d+)\/detail-page-no-add-view$/.exec(u.pathname);
    if (m) {
      if (failDetail) return new Response('x', { status: 500 });
      return Response.json({ id: Number(m[1]), priceOverview: prices[m[1]] ?? null });
    }
    return new Response('not found', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}
function fakePush() {
  const sent = [];
  const fn = async (token, to, messages) => {
    sent.push({ to, messages });
  };
  fn.sent = sent;
  return fn;
}
function nodes(node, pred, out = []) {
  if (Array.isArray(node)) node.forEach((n) => nodes(n, pred, out));
  else if (node && typeof node === 'object') {
    if (pred(node)) out.push(node);
    Object.values(node).forEach((v) => nodes(v, pred, out));
  }
  return out;
}
const texts = (node) => nodes(node, (n) => n.type === 'text' && typeof n.text === 'string').map((n) => n.text);
const uris = (node) => nodes(node, (n) => n.action?.type === 'uri').map((n) => n.action.uri);

test('events: 合言葉・Cron・対象コート(6 か所。テニスベアの place.code)', () => {
  assert.equal(EVENT_COMMAND_TEXT, 'いべんと');
  assert.equal(EVENT_NOTIFY_CRON, '0 11 * * 1,4'); // 月・木 20:00 JST
  assert.equal(EVENT_PLACES.length, 6);
  assert.deepEqual(
    EVENT_PLACES.map((p) => p.name),
    ['大横川親水公園テニスコート', '錦糸公園テニスコート', '猿江恩賜公園', '亀戸中央公園', '大島小松川公園Ａ', '荒川・砂町庭球場']
  );
  assert.equal(new Set(EVENT_PLACES.map((p) => p.code)).size, 6);
  assert.equal(ADJACENT_MINUTES, 60);
});

test('events: 検索条件は 6 コート・土日祝・募集中・テニスのみ・Lv.4 を含む(本人決定)', () => {
  const b = searchBody();
  assert.deepEqual(b.placeCodeList, EVENT_PLACES.map((p) => p.code));
  assert.equal(b.satFlg, true);
  assert.equal(b.sunFlg, true);
  assert.equal(b.holidayFlg, true);
  for (const k of ['monFlg', 'tuesFlg', 'wedFlg', 'thursFlg', 'friFlg']) assert.equal(b[k], false, k);
  assert.equal(b.isOpen, true);
  assert.equal(b.tennisOnlyFlg, true);
  assert.deepEqual(b.levelList, [4]);
  assert.deepEqual(b.prefectureCodeList, []);
  assert.deepEqual(b.regionCodeList, []);
});

test('events: 一覧の 1 件を整形(tennisbear.js と同じ形 + 満員・中止)。形が崩れた件は null', () => {
  assert.deepEqual(normalizeSearchItem(RAW), ev());
  assert.equal(normalizeSearchItem(raw({ isFull: true })).isFull, true);
  assert.equal(normalizeSearchItem({ id: 1 }), null);
  assert.equal(normalizeSearchItem(null), null);
});

test('events: 検索は 200 件ずつ offset をずらして取り、200 件未満が返ったら止める', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => raw({ id: 1600000 + i }));
  const fetchImpl = fakeFetch({ searchRows: rows });
  const out = await searchEvents({ fetchImpl });
  assert.equal(out.length, 250);
  const searches = fetchImpl.calls.filter((c) => c.url.includes('/search/for-web'));
  assert.deepEqual(
    searches.map((c) => new URL(c.url).searchParams.get('offset')),
    ['0', '200']
  );
  assert.equal(searches[0].method, 'PUT');
  assert.deepEqual(searches[0].body.placeCodeList, EVENT_PLACES.map((p) => p.code));
  // 失敗は例外
  await assert.rejects(searchEvents({ fetchImpl: fakeFetch({ failSearch: true }) }), /HTTP 503/);
});

test('events: 対象の絞り込み。今日〜31 日先の土日祝・対象コート・募集中だけ', () => {
  assert.equal(inScope(ev(), TODAY), true);
  assert.equal(inScope(ev({ date: '2026-10-12' }), TODAY), true, '10/12 はスポーツの日(月祝)');
  assert.equal(inScope(ev({ date: '2026-10-13' }), TODAY), false, '平日');
  assert.equal(inScope(ev({ date: '2026-09-25' }), TODAY), false, '過去');
  assert.equal(inScope(ev({ date: '2026-09-26' }), TODAY), true, '今日');
  assert.equal(inScope(ev({ date: '2026-10-31' }), TODAY), false, '32 日先(土)は範囲外');
  assert.equal(inScope(ev({ date: '2026-10-25' }), TODAY), true, '29 日先(日)');
  assert.equal(inScope(ev({ placeCode: '1100450001' }), TODAY), false, '対象外のコート(GODAI 亀戸)');
  assert.equal(inScope(ev({ isFull: true }), TODAY), false);
  assert.equal(inScope(ev({ callOff: true }), TODAY), false);
  assert.equal(isWeekendOrHoliday('2026-11-03'), true, '文化の日(火)');
  assert.equal(isWeekendOrHoliday('2026-11-04'), false);
});

test('events: 料金は詳細 API(閲覧数を増やさない方)から。控えにある料金は取りに行かない。失敗は null', async () => {
  const fetchImpl = fakeFetch({ prices: { 1641200: 1000, 1641201: 0 } });
  const prices = await fetchPrices(['1641200', '1641201', '1641202'], { cache: { 1641202: 1500 }, fetchImpl });
  assert.equal(prices.get('1641200'), 1000);
  assert.equal(prices.get('1641201'), 0);
  assert.equal(prices.get('1641202'), 1500);
  const detailUrls = fetchImpl.calls.map((c) => c.url);
  assert.equal(detailUrls.length, 2);
  assert.ok(detailUrls.every((u) => u.endsWith('/detail-page-no-add-view')), '閲覧数を増やさない方を使う');
  assert.ok(!detailUrls.some((u) => u.includes('1641202')), '控えにある料金は取りに行かない');
  const failed = await fetchPrices(['1641200'], { fetchImpl: fakeFetch({ failDetail: true }) });
  assert.equal(failed.get('1641200'), null);
  // 1 回に取りに行くのは MAX_PRICE_FETCHES 件まで(無料プランの外部通信 50 回/リクエストに収める)。超えた分は null、控えにある分は数えない
  assert.equal(MAX_PRICE_FETCHES, 15);
  const many = Array.from({ length: 40 }, (_, i) => String(2000 + i));
  const pricesAll = Object.fromEntries(many.map((id) => [id, 1000]));
  const f2 = fakeFetch({ prices: pricesAll });
  const capped = await fetchPrices(many, { cache: { 2000: 500 }, fetchImpl: f2 });
  assert.equal(f2.calls.length, 15);
  assert.equal(capped.get('2000'), 500);
  assert.equal([...capped.values()].filter((v) => v === 1000).length, 15);
  assert.equal([...capped.values()].filter((v) => v == null).length, 24);
  assert.equal(capped.size, 40);
  assert.equal(priceText(null), '料金 -');
  assert.equal(priceText(0), '無料');
  assert.equal(priceText(2900), '¥2,900');
});

test('events: A・B の予定を 1 本に。都の公園名は台帳でテニスベアのコードに、参加予定はコードそのまま。失敗した人は failed に', () => {
  const results = [
    { slot: 'A', label: 'ゆうたそ', reservations: [{ id: '1', date: '2026-10-17', start: '09:00', end: '11:00', facility: '亀戸中央公園' }] },
    { slot: 'B', label: 'B', error: new Error('timeout') },
  ];
  const tb = [
    { slot: 'A', events: [{ source: 'tennisbear', id: '9', date: '2026-10-18', start: '13:00', end: '15:00', placeCode: '0100140003' }] },
    { slot: 'B', error: new Error('auth') },
  ];
  const { items, failed } = buildSchedules(results, tb);
  assert.deepEqual(items, [
    { date: '2026-10-17', start: '09:00', end: '11:00', placeCodes: ['0100010009'], label: 'ゆうたそ' },
    { date: '2026-10-18', start: '13:00', end: '15:00', placeCodes: ['0100140003'], label: 'ゆうたそ' },
  ]);
  assert.deepEqual(failed, ['B(都の予約)', 'B(テニスベアの予定)']);
  // 終了時刻が無い予定は 2 時間とみなす
  const noEnd = buildSchedules([{ slot: 'A', label: 'A', reservations: [{ date: '2026-10-17', start: '09:00', facility: '猿江恩賜公園' }] }], []);
  assert.equal(noEnd.items[0].end, '11:00');
  assert.deepEqual(buildSchedules(null, null), { items: [], failed: [] });
});

test('events: 重なる予定は場所を問わず除外。別の場所で間が 60 分未満なら除外(隣接)。同じ場所なら残す。60 分以上あけば残す', () => {
  const kameido = { date: '2026-10-17', start: '09:00', end: '11:00', placeCodes: ['0100010009'], label: 'A' };
  const evAt = (start, end, placeCode = '0100130006') => ev({ date: '2026-10-17', start, end, placeCode });
  // 重なる
  assert.equal(conflictKind(evAt('10:00', '12:00'), kameido), 'overlap');
  assert.equal(conflictKind(evAt('08:00', '10:00'), kameido), 'overlap');
  assert.equal(conflictKind(evAt('09:00', '11:00', '0100010009'), kameido), 'overlap', '同じ場所でも重なれば除外');
  // 隣接(別の場所): ぴったり・59 分後・59 分前
  assert.equal(conflictKind(evAt('11:00', '13:00'), kameido), 'adjacent');
  assert.equal(conflictKind(evAt('11:59', '13:59'), kameido), 'adjacent');
  assert.equal(conflictKind(evAt('06:01', '08:01'), kameido), 'adjacent');
  // 60 分あけば別の場所でも残す
  assert.equal(conflictKind(evAt('12:00', '14:00'), kameido), null);
  assert.equal(conflictKind(evAt('06:00', '08:00'), kameido), null);
  // 同じ場所なら隣接でも残す
  assert.equal(conflictKind(evAt('11:00', '13:00', '0100010009'), kameido), null);
  assert.equal(conflictKind(evAt('11:30', '13:30', '0100010009'), kameido), null);
  // 別の日は関係なし
  assert.equal(conflictKind(ev({ date: '2026-10-18', start: '11:00', end: '13:00' }), kameido), null);
  // 終了時刻が無いイベントは 2 時間とみなす(10:30 開始 → 12:30 終了 → 9:00-11:00 と重なる)
  assert.equal(conflictKind(evAt('10:30', ''), kameido), 'overlap');
  // 都の公園名(大島小松川公園)とテニスベアの「大島小松川公園Ａ」は台帳で同じ場所
  const ojima = buildSchedules([{ slot: 'A', label: 'A', reservations: [{ date: '2026-10-17', start: '09:00', end: '11:00', facility: '大島小松川公園' }] }], []).items[0];
  assert.equal(conflictKind(evAt('11:00', '13:00', '0100010020'), ojima), null, '同じ公園なので隣接でも残す');
  assert.equal(conflictKind(evAt('11:00', '13:00', '0100010008'), ojima), 'adjacent', '猿江は別の場所');

  const { kept, excluded } = excludeConflicts([evAt('10:00', '12:00'), evAt('11:00', '13:00'), evAt('13:00', '15:00')], [kameido]);
  assert.deepEqual(kept.map((e) => e.start), ['13:00']);
  assert.deepEqual(excluded.map((x) => x.kind), ['overlap', 'adjacent']);
});

test('events: KV の控え。無い・壊れている → null(初回)。過去の開催日は読み込み時に捨てる。pickNew は控えに無いものだけ', async () => {
  assert.equal(await loadState(envWith(fakeKv()), TODAY), null);
  assert.equal(await loadState(envWith(fakeKv({ [KV_STATE_KEY]: '{broken' })), TODAY), null);
  assert.equal(await loadState({}, TODAY), null);
  const kv = fakeKv({ [KV_STATE_KEY]: JSON.stringify({ events: { 1: { d: '2026-09-20', p: 1000 }, 2: { d: '2026-10-03', p: null }, 3: { d: '2026-10-04', p: 800 } } }) });
  const state = await loadState(envWith(kv), TODAY);
  assert.deepEqual(state, { events: { 2: { d: '2026-10-03', p: null }, 3: { d: '2026-10-04', p: 800 } } });
  const fresh = ev({ id: '4', date: '2026-10-10' });
  assert.deepEqual(pickNew([ev({ id: '2' }), fresh], state), [fresh]);
  const next = recordEvents(state, [fresh, ev({ id: '2', date: '2026-10-03' })], new Map([['4', 1200]]));
  assert.deepEqual(next.events, { 2: { d: '2026-10-03', p: null }, 3: { d: '2026-10-04', p: 800 }, 4: { d: '2026-10-10', p: 1200 } });
});

test('events: カードは日付ごとに 1 枚(開始時刻順)。行に時間・札・料金・イベント名、行のリンクは詳細ページ。見出しの色は土=青・日祝=赤', () => {
  const events = [
    ev({ id: '3', date: '2026-10-17', start: '14:00', end: '17:00', title: '基礎練習会(3 時間)' }),
    ev({ id: '1', date: '2026-10-12', start: '10:00', end: '12:00', placeCode: '0100010020', title: 'ダブルス練習' }),
    ev({ id: '2', date: '2026-10-17', start: '07:50', end: '10:00', title: 'サーブ＆レシーブ自由練習会 ★動画＆AI分析付★' }),
  ];
  const prices = new Map([['1', 1200], ['2', 0], ['3', null]]);
  const messages = buildEventMessages(events, prices, { mode: 'new' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'flex');
  assert.equal(messages[0].altText, '🐻 新着イベント 3 件(10/12〜10/17)');
  const carousel = messages[0].contents;
  assert.equal(carousel.type, 'carousel');
  assert.equal(carousel.contents.length, 2, '日付が 2 つ → 2 枚');
  const [b1, b2] = carousel.contents;
  // 10/12(月祝)は赤、10/17(土)は青。見出しに日付・曜日・件数
  assert.equal(b1.header.backgroundColor, '#FBE4E4');
  assert.deepEqual(texts(b1.header), ['10/12', '(月祝)', '新着 1 件']);
  assert.equal(b2.header.backgroundColor, '#E3EEFB');
  assert.deepEqual(texts(b2.header), ['10/17', '(土)', '新着 2 件']);
  // 行: 開始時刻順、時間・札・料金・イベント名
  const t2 = texts(b2.body);
  assert.deepEqual(t2, ['7:50 - 10:00', '荒川砂町', '無料', 'サーブ＆レシーブ自由練習会 ★動画＆AI分析付★', '14:00 - 17:00', '荒川砂町', '料金 -', '基礎練習会(3 時間)']);
  assert.deepEqual(texts(b1.body), ['10:00 - 12:00', '大島小松川', '¥1,200', 'ダブルス練習']);
  // 行のリンクは詳細ページ。ボタンは置かない
  assert.deepEqual(uris(b2), ['https://www.tennisbear.net/event/2/info', 'https://www.tennisbear.net/event/3/info']);
  assert.equal(nodes(carousel, (n) => n.type === 'button').length, 0);
  // イベント名は 2 行まで、フッターは文字だけ
  const titles = nodes(b2.body, (n) => n.type === 'text' && n.maxLines === 2);
  assert.equal(titles.length, 2);
  assert.deepEqual(texts(b2.footer), ['タップでイベントの詳細を開く']);
  // 「いべんと」(mode: all)は「新着」を付けない
  const all = buildEventMessages(events, prices, { mode: 'all' });
  assert.equal(all[0].altText, '🐻 イベント 3 件(10/12〜10/17)');
  assert.deepEqual(texts(all[0].contents.contents[0].header), ['10/12', '(月祝)', '1 件']);
  // 0 件は空
  assert.deepEqual(buildEventMessages([], prices), []);
  assert.equal(altText([]), '🐻 新着イベント 0 件');
});

test('events: 1 日 9 件以上はその日を 2 枚に分ける。13 日分以上・50KB 超はカルーセルを分ける(1 回 5 メッセージまで)', () => {
  const many = Array.from({ length: 10 }, (_, i) => ev({ id: String(100 + i), date: '2026-10-17', start: `${String(6 + i).padStart(2, '0')}:00`, end: `${String(8 + i).padStart(2, '0')}:00` }));
  const m = buildEventMessages(many, new Map(), { mode: 'new' });
  assert.equal(m[0].contents.contents.length, 2);
  // 分割した日は右側に「この枡の範囲 / その日の件数」(枡に 8 行しか無いのに「10 件」と見えないように)
  assert.deepEqual(texts(m[0].contents.contents[0].header), ['10/17', '(土) その1', '新着 1〜8 / 10 件']);
  assert.deepEqual(texts(m[0].contents.contents[1].header), ['10/17', '(土) その2', '新着 9〜10 / 10 件']);
  assert.deepEqual(texts(buildEventMessages(many, new Map(), { mode: 'all' })[0].contents.contents[1].header), ['10/17', '(土) その2', '9〜10 / 10 件']);
  assert.equal(uris(m[0].contents.contents[0]).length, 8);
  assert.equal(uris(m[0].contents.contents[1]).length, 2);
  // 土日祝を 13 日分(10/3 〜 11/1 は 10 日 + 祝日 10/12 = 11 日… なので日付を偽って 13 日分)
  const days = ['2026-10-03', '2026-10-04', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-17', '2026-10-18', '2026-10-24', '2026-10-25', '2026-10-31', '2026-11-01', '2026-11-03', '2026-11-07'];
  const spread = days.map((d, i) => ev({ id: String(200 + i), date: d }));
  const m2 = buildEventMessages(spread, new Map());
  assert.equal(m2.length, 2);
  assert.equal(m2[0].contents.contents.length, 12);
  assert.equal(m2[1].contents.type, 'bubble', '残り 1 枚はカルーセルにしない');
  // 8 行の枡は約 8.7KB。10 日 × 8 件 = 80 件なら 1 つのカルーセルに 12 枚は入らず(50KB 超)、バイト数で分かれる。各メッセージは 50KB 未満
  const heavy = [];
  for (const [di, d] of days.slice(0, 10).entries()) for (let i = 0; i < 8; i++) heavy.push(ev({ id: String(1000 + di * 10 + i), date: d, start: `${String(6 + i).padStart(2, '0')}:00`, end: `${String(8 + i).padStart(2, '0')}:00`, title: 'サーブ＆レシーブ自由練習会 江東区荒川砂町 ★動画＆AI分析付★' }));
  const m3 = buildEventMessages(heavy, new Map());
  assert.ok(m3.length >= 2 && m3.length <= 5, `メッセージ数 ${m3.length}`);
  for (const msg of m3) assert.ok(new TextEncoder().encode(JSON.stringify(msg)).length <= 50000, 'カルーセル全体 50KB 以内');
  assert.equal(m3.reduce((n, msg) => n + (msg.contents.type === 'carousel' ? msg.contents.contents.length : 1), 0), 10, '枡は落とさない');
  // テキスト版
  const txt = eventText(spread.slice(0, 2), new Map([['200', 1000]]));
  assert.match(txt, /^🐻 新着イベント 2 件\(10\/3〜10\/4\)/);
  assert.match(txt, /■ 10\/3\(土\)\n8:00-10:00 荒川砂町 ¥1,000/);
  assert.match(txt, /https:\/\/www\.tennisbear\.net\/event\/200\/info/);
});

test('events: 初回(控えなし)は今あるイベントを全部控えて送らない(ならし運転)', async () => {
  const kv = fakeKv();
  const push = fakePush();
  const rows = [raw({ id: 1 }), raw({ id: 2, startDatetimeString: '2026-10-13T08:00:00.000+09:00', datetimeForDisplay: '10/13(火) 8:00-10:00' }), raw({ id: 3, isFull: true })];
  const r = await runEventNotify(envWith(kv), { now: NOW, fetchImpl: fakeFetch({ searchRows: rows }), push, log: () => {} });
  assert.equal(r.seeded, 1, '平日(10/13)と満員は対象外なので控えは 1 件');
  assert.equal(r.sent, 0);
  assert.equal(push.sent.length, 0, '送らない');
  assert.equal(kv.puts, 1);
  const saved = JSON.parse(kv.store.get(KV_STATE_KEY));
  assert.deepEqual(Object.keys(saved.events), ['1']);
  assert.equal(saved.events['1'].d, '2026-10-17');
});

test('events: 2 回目以降は控えに無いイベントだけ、予定と重なる・隣接するものを除いて push し、送った後に控える', async () => {
  const kv = fakeKv({ [KV_STATE_KEY]: JSON.stringify({ events: { 1: { d: '2026-10-17', p: 1000 } } }) });
  const push = fakePush();
  const rows = [
    raw({ id: 1 }), // 既に控えにある → 送らない
    raw({ id: 2, eventTitle: '新着 A', startDatetimeString: '2026-10-17T13:00:00.000+09:00', datetimeForDisplay: '10/17(土) 13:00-15:00' }), // 新着。予定と離れている → 送る
    raw({ id: 3, eventTitle: '新着 B', startDatetimeString: '2026-10-17T11:00:00.000+09:00', datetimeForDisplay: '10/17(土) 11:00-13:00' }), // 亀戸 9-11 の直後・別の場所 → 隣接で除外
    raw({ id: 4, eventTitle: '新着 C', startDatetimeString: '2026-10-18T09:00:00.000+09:00', datetimeForDisplay: '10/18(日) 9:00-11:00' }), // 参加予定と重なる → 除外
  ];
  const fetchImpl = fakeFetch({ searchRows: rows, prices: { 2: 1500 } });
  const fetchResults = async () => [{ slot: 'A', label: 'ゆうたそ', reservations: [{ id: 'r1', date: '2026-10-17', start: '09:00', end: '11:00', facility: '亀戸中央公園' }] }];
  const fetchTb = async () => [{ slot: 'A', events: [{ source: 'tennisbear', id: '9', date: '2026-10-18', start: '10:00', end: '12:00', placeCode: '0100140003' }] }];
  const r = await runEventNotify(envWith(kv), { now: NOW, fetchImpl, fetchResults, fetchTb, push, log: () => {} });
  assert.equal(r.candidates, 3);
  assert.equal(r.sent, 1);
  assert.equal(r.excluded, 2);
  assert.deepEqual(r.failed, []);
  assert.equal(push.sent.length, 1);
  assert.equal(push.sent[0].to, 'Cgroup');
  const msg = push.sent[0].messages[0];
  assert.equal(msg.altText, '🐻 新着イベント 1 件(10/17(土))');
  assert.deepEqual(texts(msg.contents.body), ['13:00 - 15:00', '荒川砂町', '¥1,500', '新着 A']);
  // 料金は送った 1 件だけ取りに行く(除外した分は取らない)
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes('detail-page')).length, 1);
  // 控えは送った分も除外した分も入る
  const saved = JSON.parse(kv.store.get(KV_STATE_KEY));
  assert.deepEqual(Object.keys(saved.events).sort(), ['1', '2', '3', '4']);
  assert.equal(saved.events['2'].p, 1500);
  assert.equal(kv.puts, 1);

  // 同じ内容でもう一度 → 新着 0 件 → 送らない(控えは掃除のため書き直す)
  const push2 = fakePush();
  const r2 = await runEventNotify(envWith(kv), { now: NOW, fetchImpl: fakeFetch({ searchRows: rows }), fetchResults, fetchTb, push: push2, log: () => {} });
  assert.equal(r2.candidates, 0);
  assert.equal(push2.sent.length, 0);
});

test('events: 予定が取れなかった人がいても送る(その人の除外はせず、カードに 1 行添える)。検索に失敗したら 1 行のテキストだけ', async () => {
  const kv = fakeKv({ [KV_STATE_KEY]: JSON.stringify({ events: {} }) });
  const push = fakePush();
  const rows = [raw({ id: 2 })];
  const fetchResults = async () => [
    { slot: 'A', label: 'ゆうたそ', reservations: [] },
    { slot: 'B', label: 'B', error: new Error('timeout') },
  ];
  const fetchTb = async () => {
    throw new Error('tb down');
  };
  const r = await runEventNotify(envWith(kv), { now: NOW, fetchImpl: fakeFetch({ searchRows: rows }), fetchResults, fetchTb, push, log: () => {} });
  assert.equal(r.sent, 1);
  assert.deepEqual(r.failed, ['B(都の予約)', 'テニスベアの予定']);
  const all = texts(push.sent[0].messages[0]);
  assert.ok(all.some((t) => t.startsWith('⚠️ B(都の予約)・テニスベアの予定を確認できなかった')), all.join('|'));

  // 検索に失敗 → テキスト 1 行、控えは触らない
  const kv2 = fakeKv({ [KV_STATE_KEY]: JSON.stringify({ events: { 1: { d: '2026-10-17', p: null } } }) });
  const push2 = fakePush();
  const r2 = await runEventNotify(envWith(kv2), { now: NOW, fetchImpl: fakeFetch({ failSearch: true }), fetchResults, fetchTb, push: push2, log: () => {} });
  assert.equal(r2.sent, 0);
  assert.deepEqual(push2.sent[0].messages, [{ type: 'text', text: MSG_EVENT_SEARCH_FAILED }]);
  assert.equal(kv2.puts, 0);
});

test('events: 送信に失敗(429 など)したら控えを更新しない(次の回にもう一度新着として送る)。400 ならテキストで再送して控える', async () => {
  const rows = [raw({ id: 2 })];
  const kv = fakeKv({ [KV_STATE_KEY]: JSON.stringify({ events: {} }) });
  const push429 = async () => {
    const e = new Error('LINE push失敗: HTTP 429');
    e.status = 429;
    throw e;
  };
  const r = await runEventNotify(envWith(kv), { now: NOW, fetchImpl: fakeFetch({ searchRows: rows }), push: push429, log: () => {} });
  assert.equal(r.sent, 0);
  assert.match(r.error, /429/);
  assert.equal(kv.puts, 0);

  const kv2 = fakeKv({ [KV_STATE_KEY]: JSON.stringify({ events: {} }) });
  const sent = [];
  const push400 = async (token, to, messages) => {
    sent.push(messages);
    if (messages[0].type === 'flex') {
      const e = new Error('LINE push失敗: HTTP 400');
      e.status = 400;
      throw e;
    }
  };
  const r2 = await runEventNotify(envWith(kv2), { now: NOW, fetchImpl: fakeFetch({ searchRows: rows }), push: push400, log: () => {} });
  assert.equal(r2.sent, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[1][0].type, 'text');
  assert.match(sent[1][0].text, /🐻 新着イベント 1 件/);
  assert.equal(kv2.puts, 1);
});

test('events: 「いべんと」は控えに関係なく全件(除外ルール適用後)を返す。0 件はテキスト。新しく取れた料金は控えに足す。控えが無ければ表示した全件を控える', async () => {
  const rows = [
    raw({ id: 1, startDatetimeString: '2026-10-17T13:00:00.000+09:00', datetimeForDisplay: '10/17(土) 13:00-15:00' }), // 控えにある(料金は未取得)。予定と離れている → 表示する。料金を取って控えに足す
    raw({ id: 2, eventTitle: '重なる', startDatetimeString: '2026-10-17T09:00:00.000+09:00', datetimeForDisplay: '10/17(土) 9:00-11:00' }), // 亀戸 9-11 と重なる → 除外
  ];
  const kv = fakeKv({ [KV_STATE_KEY]: JSON.stringify({ events: { 1: { d: '2026-10-17', p: null } } }) });
  const fetchResults = async () => [{ slot: 'A', label: 'ゆうたそ', reservations: [{ id: 'r1', date: '2026-10-17', start: '09:00', end: '11:00', facility: '亀戸中央公園' }] }];
  const reply = await buildEventReply(envWith(kv), { now: NOW, fetchImpl: fakeFetch({ searchRows: rows, prices: { 1: 1000 } }), fetchResults, fetchTb: async () => [], log: () => {} });
  assert.equal(reply.messages.length, 1);
  assert.equal(reply.messages[0].altText, '🐻 イベント 1 件(10/17(土))');
  assert.deepEqual(texts(reply.messages[0].contents.body), ['13:00 - 15:00', '荒川砂町', '¥1,000', '基礎練習会　荒川砂町庭球場']);
  assert.match(reply.text, /13:00-15:00 荒川砂町 ¥1,000/);
  assert.equal(JSON.parse(kv.store.get(KV_STATE_KEY)).events['1'].p, 1000, '料金を控えに足す');
  assert.equal(kv.puts, 1);

  const none = await buildEventReply(envWith(fakeKv()), { now: NOW, fetchImpl: fakeFetch({ searchRows: [] }), fetchResults, fetchTb: async () => [], log: () => {} });
  assert.deepEqual(none, { text: MSG_EVENT_NONE });

  // 控えが無い(初回)なら、表示した候補を全部控える(除外した分も)。以後の Cron は新着だけになる
  const kvFirst = fakeKv();
  const first = await buildEventReply(envWith(kvFirst), { now: NOW, fetchImpl: fakeFetch({ searchRows: rows, prices: { 1: 1000 } }), fetchResults, fetchTb: async () => [], log: () => {} });
  assert.equal(first.messages.length, 1);
  assert.equal(kvFirst.puts, 1);
  const seeded = JSON.parse(kvFirst.store.get(KV_STATE_KEY));
  assert.deepEqual(Object.keys(seeded.events).sort(), ['1', '2']);
  assert.equal(seeded.events['1'].p, 1000);
  const push = fakePush();
  const r = await runEventNotify(envWith(kvFirst), { now: NOW, fetchImpl: fakeFetch({ searchRows: rows }), fetchResults, fetchTb: async () => [], push, log: () => {} });
  assert.equal(r.seeded, 0);
  assert.equal(r.candidates, 0, '「いべんと」で見た分は新着にならない');
  assert.equal(push.sent.length, 0);
  // 検索の失敗は例外(index.js が MSG_EVENT_FAILED に置き換える)
  await assert.rejects(buildEventReply(envWith(fakeKv()), { now: NOW, fetchImpl: fakeFetch({ failSearch: true }), fetchResults, fetchTb: async () => [], log: () => {} }), /HTTP 503/);
});
