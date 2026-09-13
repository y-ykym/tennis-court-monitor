import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReservations, findReservation } from '../src/reservation-list.js';

// Worker 側と同じ画面(prwha1000)の見本。個人情報はダミー化済み
const fixture = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../worker/test/fixtures/reservation-list.html'), 'utf8');

test('一覧を解析して、日付・開始時刻・公園で該当の予約を探せる', () => {
  const list = parseReservations(fixture);
  assert.ok(list.length >= 1, `一覧が ${list.length} 件`);
  const r = list[0];
  assert.match(r.id, /^\d+$/);
  assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(r.start, /^\d{2}:\d{2}$/);
  const slot = { date: r.date, startHour: Number(r.start.slice(0, 2)) };
  assert.equal(findReservation(list, slot, r.facility)?.id, r.id, '公園名そのまま');
  assert.equal(findReservation(list, slot, `No.1${r.facility}`)?.id, r.id, '見出し形式(No.1 付き)');
  assert.equal(findReservation(list, slot, '')?.id, r.id, '公園名が無ければ日時だけで照合');
  assert.equal(findReservation(list, { ...slot, startHour: (slot.startHour + 1) % 24 }, r.facility), null, '時刻が違えば見つからない');
  assert.equal(findReservation(list, slot, '存在しない公園'), null);
});

test('該当行の無い HTML は空配列', () => {
  assert.deepEqual(parseReservations('<html><body>予約はありません</body></html>'), []);
});
