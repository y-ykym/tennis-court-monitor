import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReservations, buildCancelForm, isCancelDone } from '../src/site.js';

// 実機の「予約の確認・取消画面」(2026-09-02)を、氏名・利用者番号・予約番号をダミーに置換して保存したもの
const html = readFileSync(new URL('./fixtures/reservation-list.html', import.meta.url), 'utf8');

test('parse: 予約一覧ページから3件を正しく取り出す', () => {
  const list = parseReservations(html);
  assert.deepEqual(list, [
    { id: '2026000001', date: '2026-09-06', start: '19:00', end: '21:00', facility: '猿江恩賜公園', purpose: 'テニス（人工芝）', status: '支払前', index: 0, penaltyDay: 3 },
    { id: '2026000002', date: '2026-09-24', start: '09:00', end: '11:00', facility: '大島小松川公園', purpose: 'テニス（人工芝）', status: '支払前', index: 1, penaltyDay: 3 },
    { id: '2026000003', date: '2026-09-25', start: '09:00', end: '11:00', facility: '大島小松川公園', purpose: 'テニス（人工芝）', status: '支払前', index: 2, penaltyDay: 3 },
  ]);
});

test('parse: 予約が無い(モーダルが無い)ページは空配列', () => {
  const empty = html.replace(/id="rsvDetail\d+"/g, 'id="none"');
  assert.deepEqual(parseReservations(empty), []);
  assert.deepEqual(parseReservations('<!-- prwha1000.jsp --><html><body>予約はありません</body></html>'), []);
});

test('parse: 一覧に載る個人情報(氏名・利用者番号)は結果に含まれない', () => {
  const json = JSON.stringify(parseReservations(html));
  assert.equal(json.includes('山田'), false);
  assert.equal(json.includes('00000000'), false);
});

test('cancel: 取消フォームは hidden 一式 + 対象行の selectCancel=1 + pageNo=cancelPageNo(ブラウザの rsvcancel と同じ)', () => {
  const form = buildCancelForm(html, 1);
  assert.deepEqual(form.getAll('selectCancel'), ['', '1', ''], '2行目だけ 1');
  assert.equal(form.get('pageNo'), form.get('cancelPageNo'));
  assert.equal(form.get('delIRsvJKey'), 'DUMMYKEY');
  assert.equal(form.get('displayNo'), 'prwha1000');
  assert.equal(form.get('procType'), '1');
  assert.equal(form.get('selectIndex'), '-1');
  assert.deepEqual([form.get('useday0'), form.get('stime0'), form.get('penaltyday0')], ['20260906', '1900', '3']);
  // 並び順は画面どおり(useday0 → stime0 → penaltyday0 → selectCancel → useday1 ...)
  const names = [...form.keys()];
  assert.deepEqual(names.slice(0, 8), ['useday0', 'stime0', 'penaltyday0', 'selectCancel', 'useday1', 'stime1', 'penaltyday1', 'selectCancel']);
  // 送信本文に予約番号・氏名は含まれない(行は index で指定する)
  const body = form.toString();
  assert.equal(body.includes('2026000002'), false);
  assert.equal(body.includes('山田'), false);
});

test('cancel: 対象行が無い・delIRsvJKey が無い一覧では組み立てない', () => {
  assert.throws(() => buildCancelForm(html, 3), /対象行 3/);
  assert.throws(() => buildCancelForm(html.replace('name="delIRsvJKey" value="DUMMYKEY"', 'name="delIRsvJKey" value=""'), 0), /delIRsvJKey/);
});

test('cancel: 完了判定は prwga4000.jsp または完了文言', () => {
  assert.equal(isCancelDone('<!doctype html><html lang="ja"><!-- prwga4000.jsp --><head><title>予約取消完了画面</title></head></html>'), true);
  assert.equal(isCancelDone('<html><body><p>予約の取消が完了しました。</p></body></html>'), true);
  assert.equal(isCancelDone(html), false, '一覧画面は完了ではない');
  assert.equal(isCancelDone('<!-- pawab2000.jsp --><html></html>'), false);
});
