// src/site-inpage.js の inPageFlow(ブラウザ内 fetch でログイン〜枠選択)のテスト。
// 本来はブラウザで動く自己完結の関数だが、fetch・TextDecoder・URLSearchParams は Node にもあるので、fetch を偽物に差し替えて Node で動かす
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inPageFlow } from '../src/site-inpage.js';

// Shift_JIS のバイト列を作る(偽サイトの応答用)。使う日本語は「空き」「予約あり」だけなので表で置き換える
const SJIS = { 空: [0x8b, 0xf3], き: [0x82, 0xab], 予: [0x97, 0x5c], 約: [0x96, 0xf1], あ: [0x82, 0xa0], り: [0x82, 0xe8] };
function sjis(str) {
  const out = [];
  for (const ch of str) {
    if (SJIS[ch]) out.push(...SJIS[ch]);
    else out.push(...new TextEncoder().encode(ch));
  }
  return new Uint8Array(out);
}
const PARK = { code: '1050', name: 'KAMEIDO' };
const TOP = '<!-- pawab2000.jsp --><html><input type="hidden" name="displayNo" value="pawab2000"><a onclick="doAction(form1, gRsvWTransUserAttestationEndAction);">logout</a></html>';
const LOGIN_PAGE = '<!-- pawab2100.jsp --><html><input type="hidden" name="loginJKey" value="JKEY"><input type="hidden" name="displayNo" value="pawab2100"></html>';
const LIST = '<!-- prwha1000.jsp --><html><table id="rsvacceptlist"></table></html>';
const WEEK_PAGE = `<!-- prwrc2000.jsp --><html><input type="hidden" name="selectInstCd" value="10500030"><input type="hidden" name="selectBldCd" value="${PARK.code}"><input type="hidden" name="selectBldName" value="${PARK.name}"><input type="hidden" name="displayNo" value="prwrc2000"></html>`;
const weekJson = (alt, rsvNum) => JSON.stringify({ result: [{ tzoneNo: 20, timeResult: [{ alt, useDay: 20261105, startTime: 1100, endTime: 1300, rsvNum, selectNum: 0 }] }] });

// 偽のサイト。呼ばれた順(path)と送られた form を記録する。respond(path, form) で応答文字列を返す
function fakeFetch(respond) {
  const calls = [];
  globalThis.fetch = async (path, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body || ''));
    calls.push({ path, form });
    const body = respond(path, form, calls.length);
    return { status: 200, type: 'basic', arrayBuffer: async () => sjis(body).buffer };
  };
  return calls;
}
const defaultRespond = (overrides = {}) => (path, form) => {
  if (overrides[path]) {
    const r = overrides[path](form);
    if (r !== undefined) return r;
  }
  if (path === '/web/rsvWTransUserLoginAction.do') return LOGIN_PAGE;
  if (path === '/web/rsvWUserAttestationLoginAction.do') return TOP;
  if (path === '/web/rsvWGetCancelRsvDataAction.do') return LIST;
  if (path === '/web/rsvWOpeInstSrchVacantAction.do') return WEEK_PAGE;
  if (path === '/web/rsvWOpeInstSrchVacantAjaxAction.do') return weekJson('空き', 3);
  if (path === '/web/rsvWOpeInstReservAjaxAction.do') return JSON.stringify({ divFldFg: 3, selectNum: 1, selectState: 1, akiNum: Number(form.akiNum) - 1 });
  throw new Error(`unexpected ${path}`);
};
const paths = (calls) => calls.map((c) => c.path.replace('/web/', '').replace('.do', ''));
const creds = { userId: '12345678', password: 'pw' };
const slot = { park: PARK.code, date: '2026-11-05', startHour: 11 };

test('面数と時間帯番号が分かっていれば週データを取らず、枠選択 → 予約一覧 の順に進む', async () => {
  const calls = fakeFetch(defaultRespond());
  const r = await inPageFlow({ slot: { ...slot, vacant: 3, tzoneNo: '20' }, credentials: creds, withList: true });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(paths(calls), ['rsvWTransUserLoginAction', 'rsvWUserAttestationLoginAction', 'rsvWOpeInstSrchVacantAction', 'rsvWOpeInstReservAjaxAction', 'rsvWGetCancelRsvDataAction']);
  const sel = calls[3].form;
  assert.deepEqual({ startTime: sel.startTime, endTime: sel.endTime, tzoneNo: sel.tzoneNo, akiNum: sel.akiNum, selectNum: sel.selectNum, useDay: sel.useDay }, { startTime: '1100', endTime: '1300', tzoneNo: '20', akiNum: '3', selectNum: '0', useDay: '20261105' });
  assert.equal(r.skippedWeek, true);
  assert.equal(r.vacant, 3);
  assert.equal(r.facility, PARK.name);
  assert.equal(r.listHtml, LIST);
  assert.equal(r.applyFields.applyFlg, '1');
  assert.equal(r.applyFields.selectSize, '1');
  assert.equal(r.applyFields.selectInstCd, '10500030');
});

test('枠選択が断られたら(空きでないセルの応答)taken。予約一覧は取らない', async () => {
  const calls = fakeFetch(defaultRespond({ '/web/rsvWOpeInstReservAjaxAction.do': () => JSON.stringify({ divFldFg: 3, selectNum: 0, selectState: 0, akiNum: 0 }) }));
  const r = await inPageFlow({ slot: { ...slot, vacant: 2, tzoneNo: '20' }, credentials: creds, withList: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'taken');
  assert.ok(!paths(calls).includes('rsvWGetCancelRsvDataAction'));
  assert.ok(!paths(calls).includes('rsvWOpeInstSrchVacantAjaxAction'));
});

test('枠選択の応答が JSON でない・想定外なら error(やり直しの対象)', async () => {
  fakeFetch(defaultRespond({ '/web/rsvWOpeInstReservAjaxAction.do': () => '<!-- pawfa1000.jsp --><html>error</html>' }));
  const r = await inPageFlow({ slot: { ...slot, vacant: 2, tzoneNo: '20' }, credentials: creds, withList: true });
  assert.equal(r.status, 'error');
  fakeFetch(defaultRespond({ '/web/rsvWOpeInstReservAjaxAction.do': () => JSON.stringify({ selectNum: 2, selectState: 1, akiNum: 1 }) }));
  assert.equal((await inPageFlow({ slot: { ...slot, vacant: 2, tzoneNo: '20' }, credentials: creds })).status, 'error');
});

test('面数が無ければ(手動の「よやく」)従来どおり週データで空きを確かめてから選ぶ', async () => {
  const calls = fakeFetch(defaultRespond());
  const r = await inPageFlow({ slot, credentials: creds, withList: true });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(paths(calls), ['rsvWTransUserLoginAction', 'rsvWUserAttestationLoginAction', 'rsvWOpeInstSrchVacantAction', 'rsvWOpeInstSrchVacantAjaxAction', 'rsvWOpeInstReservAjaxAction', 'rsvWGetCancelRsvDataAction']);
  assert.equal(r.skippedWeek, false);
  assert.equal(calls[4].form.tzoneNo, '20');
  assert.equal(calls[4].form.akiNum, '3');
});

test('面数が無く週データで空きでなければ taken(枠選択も一覧もしない)', async () => {
  const calls = fakeFetch(defaultRespond({ '/web/rsvWOpeInstSrchVacantAjaxAction.do': () => weekJson('予約あり', 0) }));
  const r = await inPageFlow({ slot, credentials: creds, withList: true });
  assert.equal(r.status, 'taken');
  assert.equal(paths(calls).at(-1), 'rsvWOpeInstSrchVacantAjaxAction');
});

test('面数が 0 や文字列なら週データの経路に戻る', async () => {
  let calls = fakeFetch(defaultRespond());
  assert.equal((await inPageFlow({ slot: { ...slot, vacant: 0, tzoneNo: '20' }, credentials: creds })).skippedWeek, false);
  assert.ok(paths(calls).includes('rsvWOpeInstSrchVacantAjaxAction'));
  calls = fakeFetch(defaultRespond());
  assert.equal((await inPageFlow({ slot: { ...slot, vacant: 3 }, credentials: creds })).skippedWeek, false, '時間帯番号が無いときも');
});

test('予約一覧が本物の画面でなければ error(枠は選んだ後)', async () => {
  const calls = fakeFetch(defaultRespond({ '/web/rsvWGetCancelRsvDataAction.do': () => '<!-- pawab2000.jsp --><html>home</html>' }));
  const r = await inPageFlow({ slot: { ...slot, vacant: 3, tzoneNo: '20' }, credentials: creds, withList: true });
  assert.equal(r.status, 'error');
  assert.match(r.message, /予約一覧画面が想定外/);
  assert.equal(paths(calls).at(-1), 'rsvWGetCancelRsvDataAction');
});
