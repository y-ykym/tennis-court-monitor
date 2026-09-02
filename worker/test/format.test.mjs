import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReply, formatDate, formatTime, jstTodayIso, MSG_NO_RESERVATIONS, MSG_FETCH_FAILED } from '../src/format.js';

const A = [
  { date: '2026-09-13', start: '11:00', end: '13:00', facility: '亀戸中央公園' },
  { date: '2026-09-06', start: '09:00', end: '11:00', facility: '猿江恩賜公園' },
];
const B = [{ date: '2026-09-10', start: '19:00', end: '21:00', facility: '猿江恩賜公園' }];

test('format: §11.2 の返信例と同じ形(人ごと・日付昇順・時刻の桁揃え)', () => {
  const text = formatReply(
    [
      { label: 'A', reservations: A },
      { label: 'B', reservations: B },
    ],
    { today: '2026-09-02' }
  );
  assert.equal(
    text,
    ['📅 予約一覧(9/2 現在)', '・A  9/6(日)  9:00-11:00 猿江恩賜公園', '・A  9/13(日) 11:00-13:00 亀戸中央公園', '・B  9/10(木) 19:00-21:00 猿江恩賜公園'].join('\n')
  );
});

test('format: 全員0件なら「予約はありません」', () => {
  assert.equal(
    formatReply([{ label: 'A', reservations: [] }, { label: 'B', reservations: [] }], { today: '2026-09-02' }),
    MSG_NO_RESERVATIONS
  );
});

test('format: 全員失敗ならエラー文言', () => {
  assert.equal(
    formatReply([{ label: 'A', error: new Error('x') }, { label: 'B', error: new Error('y') }], { today: '2026-09-02' }),
    MSG_FETCH_FAILED
  );
});

test('format: 片方だけ失敗 → 取れた方を出し、失敗側は(取得失敗)の1行', () => {
  const text = formatReply([{ label: 'A', reservations: B }, { label: 'B', error: new Error('x') }], { today: '2026-09-02' });
  assert.equal(text, ['📅 予約一覧(9/2 現在)', '・A  9/10(木) 19:00-21:00 猿江恩賜公園', '・B  (取得失敗)'].join('\n'));
});

test('format: 片方だけ0件 → その人は「予約なし」の1行', () => {
  const text = formatReply([{ label: 'A', reservations: [] }, { label: 'B', reservations: B }], { today: '2026-09-02' });
  assert.equal(text, ['📅 予約一覧(9/2 現在)', '・A  予約なし', '・B  9/10(木) 19:00-21:00 猿江恩賜公園'].join('\n'));
});

test('format: 日付・時刻・JST今日', () => {
  assert.equal(formatDate('2026-09-06'), '9/6(日)');
  assert.equal(formatDate('2026-12-31'), '12/31(木)');
  assert.equal(formatTime('09:00'), '9:00');
  assert.equal(formatTime('19:00'), '19:00');
  // UTC 2026-09-02T15:30 = JST 09-03 00:30
  assert.equal(jstTodayIso(new Date('2026-09-02T15:30:00Z')), '2026-09-03');
  assert.equal(jstTodayIso(new Date('2026-09-02T14:30:00Z')), '2026-09-02');
});
