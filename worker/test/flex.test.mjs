import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReservationFlex, jstNowHHMM } from '../src/flex.js';

const A = [
  { date: '2026-09-13', start: '11:00', end: '13:00', facility: '亀戸中央公園', status: '支払前' },
  { date: '2026-09-06', start: '09:00', end: '11:00', facility: '猿江恩賜公園', status: '支払済' },
];
const B = [{ date: '2026-09-21', start: '19:00', end: '21:00', facility: '猿江恩賜公園', status: '支払前' }];
const opts = { today: '2026-09-02' };

// Flex の木構造から text を全部集める
function texts(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (node && typeof node === 'object') {
    if (node.type === 'text') out.push(node.text);
    Object.values(node).forEach((v) => texts(v, out));
  }
  return out;
}

test('flex: ヘッダー件数・人ごとの見出し・行の並び(日付昇順)', () => {
  const msg = buildReservationFlex([{ label: 'ゆうたそ', reservations: A }, { label: 'B', reservations: B }], opts);
  assert.equal(msg.type, 'flex');
  assert.equal(msg.altText, '📅 予約一覧 3件: ゆうたそ 9/6(日) 9:00-11:00 猿江恩賜公園 ほか');
  const t = texts(msg.contents);
  assert.equal(t[0], '予約一覧');
  assert.equal(t[1], '9/2 現在');
  assert.ok(t.indexOf('9:00 - 11:00') < t.indexOf('11:00 - 13:00'), '日付昇順(9/6 → 9/13)');
  assert.ok(t.includes('ゆうたそ') && t.includes('2件') && t.includes('B') && t.includes('1件'));
  assert.equal(t.includes('支払前') || t.includes('支払済'), false, '支払状況は表示しない');
  assert.ok(t.includes('9/6') && t.includes('日'), '日付タイル');
});

test('flex: 日付タイルの色(日=赤 / 土=青 / 祝日=赤 / 平日=グレー)', () => {
  const reservations = [
    { date: '2026-09-06', start: '09:00', end: '11:00', facility: 'x' }, // 日
    { date: '2026-09-05', start: '09:00', end: '11:00', facility: 'x' }, // 土
    { date: '2026-09-21', start: '09:00', end: '11:00', facility: 'x' }, // 月(敬老の日)
    { date: '2026-09-24', start: '09:00', end: '11:00', facility: 'x' }, // 木
  ];
  const msg = buildReservationFlex([{ label: 'A', reservations }], opts);
  const tiles = [];
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      if (n.width === '58px') tiles.push([n.contents.map((c) => c.text).join(' '), n.backgroundColor]);
      Object.values(n).forEach(walk);
    }
  })(msg.contents);
  assert.deepEqual(tiles, [
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

test('flex: 今日・明日の補足ラベル', () => {
  const msg = buildReservationFlex(
    [{ label: 'A', reservations: [{ date: '2026-09-03', start: '09:00', end: '11:00', facility: '猿江恩賜公園' }] }],
    opts
  );
  assert.ok(texts(msg.contents).includes('明日'));
});

test('flex: 当日でもう終わった時間帯はグレー表示+「終了」、まだ先のものは通常表示', () => {
  const reservations = [
    { date: '2026-09-02', start: '09:00', end: '11:00', facility: '猿江恩賜公園' }, // 終了済み
    { date: '2026-09-02', start: '19:00', end: '21:00', facility: '猿江恩賜公園' }, // 今日これから
    { date: '2026-09-03', start: '09:00', end: '11:00', facility: '猿江恩賜公園' }, // 明日
  ];
  const msg = buildReservationFlex([{ label: 'A', reservations }], { today: '2026-09-02', nowHHMM: '15:00' });
  const rows = [];
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      if (n.width === '58px') rows.push(n.backgroundColor);
      Object.values(n).forEach(walk);
    }
  })(msg.contents);
  assert.deepEqual(rows, ['#F3F4F6', '#EEF0F3', '#EEF0F3']);
  const t = texts(msg.contents);
  assert.ok(t.includes('終了') && t.includes('今日') && t.includes('明日'));
  // 終了ちょうど(end == now)は終了扱い、1分前はまだ
  const edge = (now) => texts(buildReservationFlex([{ label: 'A', reservations: [reservations[0]] }], { today: '2026-09-02', nowHHMM: now }).contents);
  assert.ok(edge('11:00').includes('終了'));
  assert.ok(edge('10:59').includes('今日'));
});

test('flex: 多数の予約でも 10KB 制限内に収まる(9件で打ち切り「…ほかN件」)', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`,
    start: '09:00',
    end: '11:00',
    facility: '大島小松川公園',
    status: '支払前',
  }));
  const msg = buildReservationFlex([{ label: 'ゆうたそ', reservations: many }, { label: 'B', reservations: many }], opts);
  const size = new TextEncoder().encode(JSON.stringify(msg.contents)).length;
  assert.ok(size < 10 * 1024, `size=${size}`);
  assert.ok(texts(msg.contents).includes('…ほか51件'));
});
