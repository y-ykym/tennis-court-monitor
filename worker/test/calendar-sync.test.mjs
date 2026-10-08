import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wantedFromSite, wantedFromTennisbear, eventBody, diffEvents, syncPerson, runCalendarSync, removeCalendarEvent, trackAuthFailure,
  calendarSyncEnabled, calendarSyncMode, configuredCalendars, toJstIso, jstMs, siteKey, tbKey, MAX_CALENDAR_CHANGES, KV_SYNC_STATE, ALERT_AFTER_MS, MSG_CALENDAR_ALERT, DESCRIPTION_FOOTER,
} from '../src/calendar-sync.js';
import { GcalError } from '../src/gcal.js';
import { handleAuto } from '../src/auto.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { signRequest } = require('../../lib/auto-client.js');

const NOW = Date.parse('2026-10-08T03:00:00Z'); // JST 10/8(木) 12:00
const ENV = {
  GCAL_CLIENT_EMAIL: 'bot@example.iam.gserviceaccount.com',
  GCAL_PRIVATE_KEY: 'dummy',
  GCAL_CALENDAR_ID_A: 'a@gmail.com',
  GCAL_CALENDAR_ID_B: 'b@gmail.com',
  LINE_CHANNEL_ACCESS_TOKEN: 'line',
  LINE_GROUP_ID: 'Cgroup',
};
function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const writes = [];
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { writes.push(['put', k]); store.set(k, v); },
    async delete(k) { writes.push(['delete', k]); store.delete(k); },
    store,
    writes,
  };
}
// Google の偽物。calendars[calendarId] = [{ id, summary, …, extendedProperties }]。呼び出しを記録する
function fakeGcal(calendars = {}, { failWith } = {}) {
  const ops = [];
  let seq = 0;
  const cal = (id) => (calendars[id] ||= []);
  return {
    ops,
    calendars,
    calls: 0,
    async listBotEvents(calendarId, { key } = {}) {
      this.calls += 1;
      if (failWith) throw failWith;
      ops.push(['list', calendarId, key || '']);
      return cal(calendarId).filter((e) => !key || e.extendedProperties?.private?.tennisBotKey === key);
    },
    async insert(calendarId, body) {
      this.calls += 1;
      ops.push(['insert', calendarId, body.extendedProperties.private.tennisBotKey]);
      const e = { id: `g${++seq}`, ...body };
      cal(calendarId).push(e);
      return e;
    },
    async patch(calendarId, id, body) {
      this.calls += 1;
      ops.push(['patch', calendarId, id]);
      const i = cal(calendarId).findIndex((e) => e.id === id);
      cal(calendarId)[i] = { ...cal(calendarId)[i], ...body };
      return cal(calendarId)[i];
    },
    async remove(calendarId, id) {
      this.calls += 1;
      ops.push(['delete', calendarId, id]);
      const i = cal(calendarId).findIndex((e) => e.id === id);
      if (i < 0) return false;
      cal(calendarId).splice(i, 1);
      return true;
    },
  };
}
const SITE = [
  { id: '2026100001', date: '2026-10-10', start: '19:00', end: '21:00', facility: '亀戸中央公園', purpose: 'テニス（人工芝）', status: '未払い' },
  { id: '2026100002', date: '2026-10-07', start: '09:00', end: '11:00', facility: '猿江恩賜公園', purpose: 'テニス', status: '' }, // 昨日 → 対象外
  { id: '', date: '2026-10-12', start: '13:00', end: '15:00', facility: '大島小松川公園' }, // 予約番号なし → 対象外
];
const TB = [
  { source: 'tennisbear', id: '1621297', title: 'ストローク多め練', date: '2026-10-11', start: '19:00', end: '21:00', facility: '亀戸中央公園テニスコート', organizerName: '田中', tbStatus: '', tbStatusType: '' },
  { source: 'tennisbear', id: '1621298', title: '待ち', date: '2026-10-12', start: '09:00', end: '11:00', facility: '錦糸公園', tbStatus: 'キャンセル待ち', tbStatusType: 'tagGreen' },
  { source: 'tennisbear', id: '1621299', title: '中止になった', date: '2026-10-13', start: '09:00', end: '', facility: '錦糸公園', tbStatus: '中止', tbStatusType: 'tagDarkGray' },
  { source: 'tennisbear', id: '1621300', title: '終わり無し', date: '2026-10-14', start: '22:00', end: '', facility: '', tbStatus: '' },
];

test('calendar-sync: 都の予約 → 予定(今日以降・予約番号あり。タイトル 🎾 公園名・場所欄・説明欄に予約番号とコート種類)', () => {
  const w = wantedFromSite(SITE, { now: NOW });
  assert.equal(w.length, 1);
  assert.deepEqual(w[0], {
    key: 'site:2026100001',
    summary: '🎾 亀戸中央公園',
    location: '亀戸中央公園',
    description: `予約番号: 2026100001\nテニス（人工芝）\n${DESCRIPTION_FOOTER}`,
    startMs: Date.parse('2026-10-10T19:00:00+09:00'),
    endMs: Date.parse('2026-10-10T21:00:00+09:00'),
  });
  const body = eventBody(w[0]);
  assert.equal(body.start.dateTime, '2026-10-10T19:00:00+09:00');
  assert.equal(body.end.dateTime, '2026-10-10T21:00:00+09:00');
  assert.equal(body.start.timeZone, 'Asia/Tokyo');
  assert.deepEqual(body.extendedProperties.private, { tennisBot: '1', tennisBotKey: 'site:2026100001' });
  // 今日の予約は対象(時刻が過ぎていても。過去の日だけ外す)
  assert.equal(wantedFromSite([{ ...SITE[0], date: '2026-10-08', start: '09:00' }], { now: NOW }).length, 1);
});

test('calendar-sync: テニスベア → 確定した参加・主催だけ(キャンセル待ち・中止は入れない)。終了が無ければ 2 時間、22:00 開始は翌 0:00', () => {
  const w = wantedFromTennisbear(TB, { now: NOW });
  assert.deepEqual(w.map((x) => x.key), ['tb:1621297', 'tb:1621300']);
  assert.equal(w[0].summary, '🐻 ストローク多め練');
  assert.equal(w[0].location, '亀戸中央公園テニスコート');
  assert.equal(w[0].description, `主催: 田中\nhttps://www.tennisbear.net/event/1621297/info\n${DESCRIPTION_FOOTER}`);
  assert.equal(toJstIso(w[1].endMs), '2026-10-15T00:00:00+09:00');
  assert.equal(w[1].description.startsWith('https://'), true, '主催者名が無ければ URL から');
});

test('calendar-sync: 差分 = 無いものは追加・違うものは更新・消えたものは削除。目印の無い予定と、取れなかった元の予定は消さない。重複は 1 件残す', () => {
  const wanted = wantedFromSite(SITE, { now: NOW }).concat(wantedFromTennisbear(TB, { now: NOW }));
  const same = { id: 'g1', ...eventBody(wanted[0]) };
  const changed = { id: 'g2', ...eventBody(wanted[1]), summary: '🐻 古い名前' };
  const gone = { id: 'g3', ...eventBody({ key: 'site:999', summary: '🎾 x', location: '', description: '', startMs: jstMs('2026-10-20', '09:00'), endMs: jstMs('2026-10-20', '11:00') }) };
  const goneTb = { id: 'g4', ...eventBody({ key: 'tb:888', summary: '🐻 x', location: '', description: '', startMs: jstMs('2026-10-20', '09:00'), endMs: jstMs('2026-10-20', '11:00') }) };
  const manual = { id: 'g5', summary: '歯医者', start: { dateTime: '2026-10-20T09:00:00+09:00' }, end: { dateTime: '2026-10-20T10:00:00+09:00' } };
  const dup = { id: 'g6', ...eventBody(wanted[0]) };
  const d = diffEvents(wanted, [same, changed, gone, goneTb, manual, dup]);
  assert.deepEqual(d.inserts.map((w) => w.key), ['tb:1621300']);
  assert.deepEqual(d.updates.map((u) => [u.id, u.w.key]), [['g2', 'tb:1621297']]);
  assert.deepEqual(d.deletes.map((x) => [x.id, x.reason]), [['g6', 'duplicate'], ['g3', 'gone'], ['g4', 'gone']]);
  // 都が取れなかった回: site: は消さない(tb: は消す)
  const d2 = diffEvents(wanted, [same, changed, gone, goneTb, manual], { allowDelete: { site: false, tb: true } });
  assert.deepEqual(d2.deletes.map((x) => x.id), ['g4']);
  // Google が返す dateTime がオフセット違い(Z)でも同じ時刻なら更新しない
  const sameZ = { ...same, start: { dateTime: '2026-10-10T10:00:00Z' }, end: { dateTime: '2026-10-10T12:00:00Z' } };
  assert.equal(diffEvents(wanted, [sameZ, changed]).updates.length, 1);
});

test('calendar-sync: 1 人ぶんの同期は 削除 → 追加 → 更新 の順に、合計 20 件まで。残りは次回', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `2026${String(i).padStart(6, '0')}`, date: '2026-10-20', start: '09:00', end: '11:00', facility: '亀戸中央公園' }));
  const wanted = wantedFromSite(many, { now: NOW });
  const stale = { id: 'old', ...eventBody({ key: 'site:x', summary: '🎾 x', location: '', description: '', startMs: jstMs('2026-10-20', '09:00'), endMs: jstMs('2026-10-20', '11:00') }) };
  const gcal = fakeGcal({ 'a@gmail.com': [stale] });
  const st = await syncPerson(gcal, { slot: 'A', calendarId: 'a@gmail.com', wanted, allowDelete: { site: true, tb: true }, now: NOW });
  assert.deepEqual([st.deleted, st.inserted, st.updated, st.remaining], [1, 19, 0, 6]);
  assert.equal(gcal.ops[1][0], 'delete', '削除が先');
  assert.equal(MAX_CALENDAR_CHANGES, 20);
  // 2 回目で残りが入る
  const st2 = await syncPerson(gcal, { slot: 'A', calendarId: 'a@gmail.com', wanted, allowDelete: { site: true, tb: true }, now: NOW });
  assert.deepEqual([st2.inserted, st2.remaining], [6, 0]);
  // 一覧の timeMin は今日 0:00 JST
  assert.equal(gcal.ops[0][0], 'list');
});

test('calendar-sync: dry-run はカレンダーに触らず、やることの一覧だけ返す', async () => {
  const gcal = fakeGcal();
  const wanted = wantedFromSite(SITE, { now: NOW });
  const st = await syncPerson(gcal, { slot: 'A', calendarId: 'a@gmail.com', wanted, allowDelete: { site: true, tb: true }, now: NOW, dryRun: true });
  assert.deepEqual(st.plan, { inserts: ['site:2026100001'], updates: [], deletes: [] });
  assert.equal(gcal.ops.filter((o) => o[0] !== 'list').length, 0);
});

test('calendar-sync: 一時的なエラーは数えて続け、認証・権限のエラーは投げる', async () => {
  const gcal = fakeGcal();
  const wanted = wantedFromSite(SITE, { now: NOW }).concat(wantedFromTennisbear(TB, { now: NOW }));
  let n = 0;
  gcal.insert = async () => {
    n += 1;
    if (n === 1) throw new GcalError('Google Calendar HTTP 500', { status: 500 });
    return { id: 'x' };
  };
  const st = await syncPerson(gcal, { slot: 'A', calendarId: 'a@gmail.com', wanted, allowDelete: { site: true, tb: true }, now: NOW });
  assert.deepEqual([st.inserted, st.errors], [2, 1]);
  gcal.insert = async () => {
    throw new GcalError('Google Calendar HTTP 403 forbidden', { status: 403 });
  };
  await assert.rejects(syncPerson(gcal, { slot: 'A', calendarId: 'a@gmail.com', wanted, allowDelete: { site: true, tb: true }, now: NOW }), /403/);
});

test('calendar-sync: 設定(CALENDAR_SYNC・Secrets)で有効/無効が決まり、書き先がある人だけ同期する', () => {
  assert.equal(calendarSyncEnabled(ENV), true);
  assert.equal(calendarSyncEnabled({ ...ENV, CALENDAR_SYNC: 'off' }), false);
  assert.equal(calendarSyncEnabled({ ...ENV, GCAL_PRIVATE_KEY: '' }), false);
  assert.deepEqual(configuredCalendars({ ...ENV, GCAL_CALENDAR_ID_B: '' }).map((c) => c.slot), ['A']);
  assert.deepEqual([calendarSyncMode(ENV), calendarSyncMode({ CALENDAR_SYNC: 'DRY' }), calendarSyncMode({ CALENDAR_SYNC: 'off' }), calendarSyncMode({ CALENDAR_SYNC: 'x' })], ['on', 'dry', 'off', 'on']);
});

test('calendar-sync: CALENDAR_SYNC="dry" なら Cron も直後の同期もカレンダーに触らず、やることだけ返す', async () => {
  const gcal = fakeGcal();
  const env = { ...ENV, CALENDAR_SYNC: 'dry' };
  const out = await runCalendarSync(env, { fetchResults: async () => [{ slot: 'A', reservations: SITE }], fetchTb: async () => [], now: NOW, gcal });
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.A.plan, { inserts: ['site:2026100001'], updates: [], deletes: [] });
  assert.equal(gcal.ops.filter((o) => o[0] !== 'list').length, 0);
  assert.equal(await removeCalendarEvent(env, 'A', 'site:1', { gcal }), 0);
  assert.equal(gcal.ops.some((o) => o[0] === 'delete'), false);
});

test('calendar-sync: 全体の同期 = A は A のカレンダー・B は B のカレンダーへ。B が未登録なら A だけ。都が取れなかった人はその回は削除しない', async () => {
  const stale = (key) => ({ id: `old-${key}`, ...eventBody({ key, summary: '🎾 x', location: '', description: '', startMs: jstMs('2026-10-20', '09:00'), endMs: jstMs('2026-10-20', '11:00') }) });
  const gcal = fakeGcal({ 'a@gmail.com': [stale('site:a-old')], 'b@gmail.com': [stale('site:b-old'), stale('tb:b-old')] });
  const seenSlots = [];
  const fetchResults = async (slots) => {
    seenSlots.push(slots);
    return [
      { slot: 'A', label: 'ゆうたそ', reservations: SITE },
      { slot: 'B', label: 'まきたそ', error: new Error('timeout') },
    ];
  };
  const fetchTb = async () => [{ slot: 'A', events: TB }, { slot: 'B', events: [] }];
  const env = { ...ENV, BOOKING_KV: fakeKV() };
  const out = await runCalendarSync(env, { fetchResults, fetchTb, now: NOW, gcal, push: async () => {} });
  assert.deepEqual(seenSlots, [['A', 'B']]);
  assert.deepEqual([out.A.inserted, out.A.deleted, out.A.updated], [3, 1, 0], 'A: 都 1 + テニスベア 2 を追加、古い 1 件を削除');
  assert.deepEqual([out.B.inserted, out.B.deleted, out.B.noDelete], [0, 1, ['site']], 'B: 都は取れなかったので site: は残し、tb: の古い 1 件だけ削除');
  assert.equal(gcal.calendars['a@gmail.com'].some((e) => e.extendedProperties.private.tennisBotKey === 'site:2026100001'), true);
  assert.equal(gcal.calendars['b@gmail.com'].some((e) => e.extendedProperties.private.tennisBotKey === 'site:2026100001'), false, 'A の予定は B のカレンダーに入らない');
  assert.equal(out.authFailed, false);
  assert.equal(env.BOOKING_KV.writes.length, 0, '普段は KV に書かない');

  // B が未登録なら A だけ。persons で絞れば都・テニスベアもその人だけ取りに行く
  const seen2 = [];
  const out2 = await runCalendarSync({ ...ENV, GCAL_CALENDAR_ID_B: '' }, { fetchResults: async (s) => (seen2.push(s), []), fetchTb: async (s) => (seen2.push(s), []), now: NOW, gcal: fakeGcal() });
  assert.deepEqual(Object.keys(out2).filter((k) => k === 'A' || k === 'B'), ['A']);
  assert.deepEqual(seen2, [['A'], ['A']]);
  const out3 = await runCalendarSync(ENV, { fetchResults: async () => [], fetchTb: async () => [], now: NOW, gcal: fakeGcal(), persons: ['B'] });
  assert.deepEqual(Object.keys(out3).filter((k) => k === 'A' || k === 'B'), ['B']);
  // 止めてあれば何もしない
  assert.deepEqual(await runCalendarSync({ ...ENV, CALENDAR_SYNC: 'off' }, { gcal: fakeGcal() }), { skipped: 'disabled' });
  // テニスベア全体が落ちた回(null)は tb: を消さない。都の結果が無い人(SITE_USER 未設定)は site: を消さない
  const gcal4 = fakeGcal({ 'a@gmail.com': [stale('site:a-old'), stale('tb:a-old')] });
  const out4 = await runCalendarSync({ ...ENV, GCAL_CALENDAR_ID_B: '' }, { fetchResults: async () => [], fetchTb: async () => { throw new Error('down'); }, now: NOW, gcal: gcal4 });
  assert.deepEqual([out4.A.deleted, out4.A.noDelete], [0, ['site', 'tb']]);
});

test('calendar-sync: 認証・権限の失敗が 6 時間続いたら ⚠️ を 1 回だけ。直ったら記録を消す(KV の書き込みは 3 回だけ)', async () => {
  const kv = fakeKV();
  const env = { ...ENV, BOOKING_KV: kv };
  const pushed = [];
  const push = async (token, to, text) => pushed.push(text);
  const gcal = fakeGcal({}, { failWith: new GcalError('Google Calendar HTTP 403 forbidden', { status: 403 }) });
  const fetchResults = async () => [{ slot: 'A', reservations: SITE }];
  const fetchTb = async () => [];
  let out = await runCalendarSync(env, { fetchResults, fetchTb, now: NOW, gcal, push });
  assert.equal(out.authFailed, true);
  assert.equal(out.A.auth, true);
  assert.equal(JSON.parse(kv.store.get(KV_SYNC_STATE)).since, NOW);
  assert.equal(pushed.length, 0);
  await runCalendarSync(env, { fetchResults, fetchTb, now: NOW + 3 * 3600000, gcal, push });
  assert.equal(pushed.length, 0, '3 時間ではまだ知らせない');
  await runCalendarSync(env, { fetchResults, fetchTb, now: NOW + ALERT_AFTER_MS, gcal, push });
  assert.deepEqual(pushed, [MSG_CALENDAR_ALERT]);
  await runCalendarSync(env, { fetchResults, fetchTb, now: NOW + ALERT_AFTER_MS + 3600000, gcal, push });
  assert.equal(pushed.length, 1, '2 度は知らせない');
  // 直った
  out = await runCalendarSync(env, { fetchResults, fetchTb, now: NOW + 2 * ALERT_AFTER_MS, gcal: fakeGcal(), push });
  assert.equal(out.authFailed, false);
  assert.equal(kv.store.has(KV_SYNC_STATE), false);
  assert.deepEqual(kv.writes.map((w) => w[0]), ['put', 'put', 'delete']);
  // 一時的なエラー(5xx)は認証の失敗に数えない
  const kv2 = fakeKV();
  const out5 = await runCalendarSync({ ...ENV, BOOKING_KV: kv2 }, { fetchResults, fetchTb, now: NOW, gcal: fakeGcal({}, { failWith: new GcalError('HTTP 503', { status: 503 }) }), push });
  assert.deepEqual([out5.authFailed, out5.A.auth, kv2.writes.length], [false, false, 0]);
  assert.equal(await trackAuthFailure({ ...ENV }, true, { now: NOW }), null, 'KV が無ければ何もしない');
});

test('calendar-sync: キャンセル直後は、その予約番号の予定だけを消す(都のサイトには行かない)', async () => {
  const mk = (key) => ({ id: `e-${key}`, ...eventBody({ key, summary: 's', location: '', description: '', startMs: jstMs('2026-10-20', '09:00'), endMs: jstMs('2026-10-20', '11:00') }) });
  const gcal = fakeGcal({ 'a@gmail.com': [mk('site:111'), mk('site:222')] });
  assert.equal(await removeCalendarEvent(ENV, 'A', siteKey('111'), { gcal }), 1);
  assert.deepEqual(gcal.calendars['a@gmail.com'].map((e) => e.id), ['e-site:222']);
  assert.deepEqual(gcal.ops, [['list', 'a@gmail.com', 'site:111'], ['delete', 'a@gmail.com', 'e-site:111']]);
  assert.equal(await removeCalendarEvent(ENV, 'B', tbKey('x'), { gcal }), 0, '無ければ 0');
  assert.equal(await removeCalendarEvent({ ...ENV, CALENDAR_SYNC: 'off' }, 'A', 'site:222', { gcal }), 0, '止めてあれば触らない');
  const broken = fakeGcal({}, { failWith: new GcalError('HTTP 403', { status: 403 }) });
  assert.equal(await removeCalendarEvent(ENV, 'A', 'site:222', { gcal: broken }), 0, '失敗しても投げない(次の同期で消える)');
});

test('calendar-sync: POST /auto/calendar-sync は署名付きで、person と dryRun を同期関数に渡す', async () => {
  const SECRET = 'test-signing-secret';
  const env = { BOOKING_SIGNING_SECRET: SECRET, BOOKING_KV: fakeKV() };
  const got = [];
  const runSync = async (opts) => (got.push(opts), { A: { inserted: 1 } });
  const post = async (payload, { secret = SECRET } = {}) => {
    const body = JSON.stringify(payload);
    const headers = { ...signRequest(secret, { method: 'POST', path: '/auto/calendar-sync', body, ts: NOW }), 'content-type': 'application/json' };
    return handleAuto(new Request('https://w.example/auto/calendar-sync', { method: 'POST', headers, body }), env, { waitUntil() {} }, { now: NOW, runSync });
  };
  let res = await post({ person: 'A', dryRun: true, reason: 'manual' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { A: { inserted: 1 } });
  assert.deepEqual(got[0], { persons: ['A'], dryRun: true, reason: 'manual' });
  res = await post({});
  assert.deepEqual(got[1], { persons: null, dryRun: false, reason: 'manual' });
  res = await post({ person: 'C' });
  assert.equal(res.status, 400);
  res = await post({ person: 'A' }, { secret: 'wrong' });
  assert.equal(res.status, 401);
  // 配線が無ければ 501
  const body = JSON.stringify({ person: 'A' });
  const headers = { ...signRequest(SECRET, { method: 'POST', path: '/auto/calendar-sync', body, ts: NOW }), 'content-type': 'application/json' };
  res = await handleAuto(new Request('https://w.example/auto/calendar-sync', { method: 'POST', headers, body }), env, { waitUntil() {} }, { now: NOW });
  assert.equal(res.status, 501);
});
