import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReservationFlex, buildCancelConfirmFlex, buildCancelResultFlex, jstNowHHMM, bubbleBytes, MAX_BUBBLE_BYTES } from '../src/flex.js';

const A = [
  { id: '2026000001', date: '2026-09-13', start: '11:00', end: '13:00', facility: '亀戸中央公園', status: '支払前' },
  { id: '2026000002', date: '2026-09-06', start: '09:00', end: '11:00', facility: '猿江恩賜公園', status: '支払済' },
];
const B = [{ id: '2026000003', date: '2026-09-21', start: '19:00', end: '21:00', facility: '猿江恩賜公園', status: '支払前' }];
const opts = { today: '2026-09-02' };
// 署名付き postback data の実物相当(約80文字)
const DATA = 'c|A|2026000123|20260918|1700|1900|大島小松川公園|3|1757200000.AAAAAAAAAAAAAAAAAAAAAA';

// Flex の木構造から text / span の文字列を全部集める
function texts(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (node && typeof node === 'object') {
    if ((node.type === 'text' || node.type === 'span') && typeof node.text === 'string') out.push(node.text);
    Object.values(node).forEach((v) => texts(v, out));
  }
  return out;
}
function find(node, pred, out = []) {
  if (Array.isArray(node)) node.forEach((n) => find(n, pred, out));
  else if (node && typeof node === 'object') {
    if (pred(node)) out.push(node);
    Object.values(node).forEach((v) => find(v, pred, out));
  }
  return out;
}
const tiles = (msg) => find(msg.contents, (n) => n.width === '58px').map((n) => [texts(n).join(' '), n.backgroundColor]);
const pills = (msg) => find(msg.contents, (n) => n.action?.type === 'postback');

test('flex: ヘッダー件数・人ごとの見出し・行の並び(日付昇順)', () => {
  const msg = buildReservationFlex([{ label: 'ゆうたそ', reservations: A }, { label: 'B', reservations: B }], opts);
  assert.equal(msg.type, 'flex');
  assert.equal(msg.altText, '📅 予約一覧 3件: ゆうたそ 9/6(日) 9:00-11:00 猿江恩賜公園 ほか');
  const t = texts(msg.contents);
  assert.equal(t[0], '予約一覧');
  assert.equal(t[1], '9/2 現在 ・ 3件');
  assert.ok(t.indexOf('9:00 - 11:00') < t.indexOf('11:00 - 13:00'), '日付昇順(9/6 → 9/13)');
  assert.ok(t.includes('ゆうたそ') && t.includes('2件') && t.includes('B') && t.includes('1件'));
  assert.equal(t.includes('支払前') || t.includes('支払済'), false, '支払状況は表示しない');
  assert.deepEqual(tiles(msg)[0], ['9/6 日', '#FBE4E4'], '日付タイル');
  assert.equal(pills(msg).length, 0, 'cancelData が無ければボタンは出ない');
});

test('flex: 日付タイルの色(日=赤 / 土=青 / 祝日=赤 / 平日=グレー)', () => {
  const reservations = [
    { date: '2026-09-06', start: '09:00', end: '11:00', facility: 'x' }, // 日
    { date: '2026-09-05', start: '09:00', end: '11:00', facility: 'x' }, // 土
    { date: '2026-09-21', start: '09:00', end: '11:00', facility: 'x' }, // 月(敬老の日)
    { date: '2026-09-24', start: '09:00', end: '11:00', facility: 'x' }, // 木
  ];
  const msg = buildReservationFlex([{ label: 'A', reservations }], opts);
  assert.deepEqual(tiles(msg), [
    ['9/5 土', '#E3EEFB'],
    ['9/6 日', '#FBE4E4'],
    ['9/21 月', '#FBE4E4'],
    ['9/24 木', '#EEF0F3'],
  ]);
});

test('flex: 片方失敗・片方0件の表示', () => {
  const msg = buildReservationFlex([{ label: 'A', reservations: [] }, { label: 'B', error: new Error('x') }], opts);
  const t = texts(msg.contents);
  assert.ok(t.includes('予約なし'));
  assert.ok(t.includes('取得失敗'));
  assert.equal(t[0], '予約一覧');
  assert.equal(msg.altText, '📅 予約一覧 0件');
});

test('flex: JSTの現在時刻', () => {
  assert.equal(jstNowHHMM(new Date('2026-09-02T15:30:00Z')), '00:30');
  assert.equal(jstNowHHMM(new Date('2026-09-02T06:05:00Z')), '15:05');
});

test('flex: 今日・明日の補足ラベルは公園名の行に付く', () => {
  const msg = buildReservationFlex(
    [{ label: 'A', reservations: [{ date: '2026-09-03', start: '09:00', end: '11:00', facility: '猿江恩賜公園' }] }],
    opts
  );
  const t = texts(msg.contents);
  assert.ok(t.includes('  明日'));
  assert.ok(t.indexOf('\n猿江恩賜公園') < t.indexOf('  明日'), '公園名の後ろ');
});

test('flex: キャンセルボタン(postback ピル)は cancelData がある行だけ。終了済みには付けない', () => {
  const reservations = [
    { id: '1', date: '2026-09-03', start: '09:00', end: '11:00', facility: '猿江恩賜公園', cancelData: DATA },
    { id: '2', date: '2026-09-02', start: '09:00', end: '11:00', facility: '亀戸中央公園', cancelData: DATA }, // 当日・終了
    { id: '3', date: '2026-09-05', start: '09:00', end: '11:00', facility: '大島小松川公園' }, // data 無し
  ];
  const msg = buildReservationFlex([{ label: 'A', reservations }], { today: '2026-09-02', nowHHMM: '12:00' });
  const p = pills(msg);
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].action, { type: 'postback', label: 'キャンセル', data: DATA, displayText: '9/3 9:00 猿江恩賜公園 をキャンセル' });
  assert.ok(texts(msg.contents).includes('  終了'));
});

test('flex: バブルは 9,800 バイト以内に収める(ボタン付き 9 行 → 行を減らして「…ほかN件」)', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    id: String(2026000100 + i),
    date: `2026-09-${String(10 + i).padStart(2, '0')}`,
    start: '17:00',
    end: '19:00',
    facility: ['猿江恩賜公園', '亀戸中央公園', '大島小松川公園'][i % 3],
    cancelData: DATA,
  }));
  const msg = buildReservationFlex([{ label: 'ゆうたそ', reservations: many.slice(0, 5) }, { label: 'B', reservations: many.slice(5) }], opts);
  const bytes = bubbleBytes(msg.contents);
  assert.ok(bytes <= MAX_BUBBLE_BYTES, `${bytes} bytes`);
  const shown = pills(msg).length;
  assert.ok(shown >= 6 && shown <= 8, `表示行数 ${shown}(7行前後)`);
  assert.ok(texts(msg.contents).includes(`…ほか${9 - shown}件`));
  // ボタン無し(現行相当)なら 9 行とも載る
  const plain = buildReservationFlex([{ label: 'A', reservations: many.map(({ cancelData, ...r }) => r) }], opts);
  assert.equal(texts(plain.contents).some((s) => s.startsWith('…ほか')), false);
  assert.ok(bubbleBytes(plain.contents) <= MAX_BUBBLE_BYTES);
});

test('flex: 確認カード(ペナルティ警告あり/なし・ボタン2つ)', () => {
  const r = { id: '2026000123', date: '2026-09-18', start: '17:00', end: '19:00', facility: '大島小松川公園' };
  const msg = buildCancelConfirmFlex({ label: 'ゆうたそ', reservation: r, penalty: true, penaltyDay: 3, yesData: 'Y', noData: 'n' }, { today: '2026-09-16' });
  const t = texts(msg.contents);
  assert.equal(t[0], 'キャンセルの確認');
  assert.ok(t.includes('この予約をキャンセルしますか？'));
  assert.ok(t.includes('17:00 - 19:00') && t.includes('\n大島小松川公園') && t.includes('  明後日'));
  assert.ok(t.includes('予約番号 2026000123'));
  assert.ok(t.some((s) => s.includes('利用日が3日以内のため')));
  assert.equal(t.some((s) => s.includes('支払')), false, '支払状況は出さない');
  assert.equal(t.some((s) => s.includes('取り消せません')), false);
  const pb = pills(msg).map((b) => b.action);
  assert.deepEqual(pb, [
    { type: 'postback', label: 'はい、キャンセルする', data: 'Y', displayText: 'はい' },
    { type: 'postback', label: 'いいえ', data: 'n', displayText: 'いいえ' },
  ]);
  assert.equal(msg.contents.footer.layout, 'vertical', 'ボタンは縦積み(省略されないように)');
  assert.equal(find(msg.contents, (n) => n.adjustMode === 'shrink-to-fit').length, 1, '日付は縮小して1行に収める');
  assert.ok(bubbleBytes(msg.contents) < 4000);
  const noWarn = buildCancelConfirmFlex({ label: 'A', reservation: r, penalty: false, yesData: 'Y', noData: 'n' }, { today: '2026-09-02' });
  assert.equal(texts(noWarn.contents).some((s) => s.includes('ペナルティ')), false);
  assert.match(msg.altText, /^キャンセルの確認: ゆうたそ 9\/18\(金\) 17:00-19:00 大島小松川公園$/);
});

test('flex: 結果カード(成功=緑・打ち消し線 / 失敗=グレー・サイト確認の案内)', () => {
  const r = { id: '2026000123', date: '2026-09-18', start: '17:00', end: '19:00', facility: '大島小松川公園' };
  const ok = buildCancelResultFlex({ ok: true, label: 'ゆうたそ', reservation: r, nowText: '9/6 12:49' });
  const t = texts(ok.contents);
  assert.equal(t[0], 'キャンセルしました');
  assert.equal(t[1], '9/6 12:49');
  assert.ok(t.includes('予約番号 2026000123'));
  assert.equal(ok.contents.header.backgroundColor, '#15803D');
  assert.equal(find(ok.contents, (n) => n.decoration === 'line-through').length, 1);
  const ng = buildCancelResultFlex({ ok: false, label: 'ゆうたそ', reservation: r });
  const t2 = texts(ng.contents);
  assert.equal(t2[0], 'キャンセルできませんでした');
  assert.ok(t2.some((s) => s.includes('予約サイトで状態を確認')));
  assert.equal(ng.contents.header.backgroundColor, '#6B7280');
});
