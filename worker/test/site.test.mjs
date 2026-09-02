import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReservations } from '../src/site.js';

// 実機の「予約の確認・取消画面」(2026-09-02)を、氏名・利用者番号・予約番号をダミーに置換して保存したもの
const html = readFileSync(new URL('./fixtures/reservation-list.html', import.meta.url), 'utf8');

test('parse: 予約一覧ページから3件を正しく取り出す', () => {
  const list = parseReservations(html);
  assert.deepEqual(list, [
    { id: '2026000001', date: '2026-09-06', start: '19:00', end: '21:00', facility: '猿江恩賜公園', purpose: 'テニス（人工芝）', status: '支払前' },
    { id: '2026000002', date: '2026-09-24', start: '09:00', end: '11:00', facility: '大島小松川公園', purpose: 'テニス（人工芝）', status: '支払前' },
    { id: '2026000003', date: '2026-09-25', start: '09:00', end: '11:00', facility: '大島小松川公園', purpose: 'テニス（人工芝）', status: '支払前' },
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
