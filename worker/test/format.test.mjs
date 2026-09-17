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

// ---- フェーズ5 テニスベアの合流 ----
const TB = [
  { source: 'tennisbear', id: '1', title: 'ストローク多め練', date: '2026-09-22', start: '19:00', end: '21:00', facility: '亀戸中央公園テニスコート' },
  { source: 'tennisbear', id: '2', title: '朝練', date: '2026-09-08', start: '09:00', end: '11:00', facility: '' },
];

test('format(§15): テニスベアの予定を人の行に日付順で混ぜる。🐻 イベント名(コート名)', () => {
  const text = formatReply([{ label: 'A', reservations: A, tennisbear: { events: TB } }, { label: 'B', reservations: B }], { today: '2026-09-02' });
  assert.equal(
    text,
    [
      '📅 予約一覧(9/2 現在)',
      '・A  9/6(日)  9:00-11:00 猿江恩賜公園',
      '・A  9/8(火)  9:00-11:00 🐻 朝練',
      '・A  9/13(日) 11:00-13:00 亀戸中央公園',
      '・A  9/22(火) 19:00-21:00 🐻 ストローク多め練(亀戸中央公園テニスコート)',
      '・B  9/10(木) 19:00-21:00 猿江恩賜公園',
    ].join('\n')
  );
});

test('format(§15): テニスベアだけ失敗 → 都の予約は普通に出し、末尾に 1 行。都が 0 件でも黙って「予約はありません」にしない', () => {
  const text = formatReply([{ label: 'A', reservations: B, tennisbear: { error: new Error('x') } }], { today: '2026-09-02' });
  assert.equal(text, ['📅 予約一覧(9/2 現在)', '・A  9/10(木) 19:00-21:00 猿江恩賜公園', '・A  (🐻 テニスベアの取得に失敗)'].join('\n'));
  const zero = formatReply([{ label: 'A', reservations: [], tennisbear: { error: new Error('x') } }], { today: '2026-09-02' });
  assert.equal(zero, ['📅 予約一覧(9/2 現在)', '・A  予約なし', '・A  (🐻 テニスベアの取得に失敗)'].join('\n'));
});

test('format(§15): 都だけ失敗 → (取得失敗)の下にテニスベアの予定。都が全員失敗でも予定があればカードにする', () => {
  const text = formatReply([{ label: 'A', error: new Error('x'), tennisbear: { events: TB } }], { today: '2026-09-02' });
  assert.equal(
    text,
    ['📅 予約一覧(9/2 現在)', '・A  (取得失敗)', '・A  9/8(火)  9:00-11:00 🐻 朝練', '・A  9/22(火) 19:00-21:00 🐻 ストローク多め練(亀戸中央公園テニスコート)'].join('\n')
  );
  // 都が全員失敗・テニスベアも失敗(または 0 件)→ 従来どおりエラー文言
  assert.equal(formatReply([{ label: 'A', error: new Error('x'), tennisbear: { error: new Error('y') } }], { today: '2026-09-02' }), MSG_FETCH_FAILED);
  assert.equal(formatReply([{ label: 'A', error: new Error('x'), tennisbear: { events: [] } }], { today: '2026-09-02' }), MSG_FETCH_FAILED);
  // 都もテニスベアも 0 件 → 従来どおり「予約はありません」
  assert.equal(formatReply([{ label: 'A', reservations: [], tennisbear: { events: [] } }], { today: '2026-09-02' }), MSG_NO_RESERVATIONS);
});
