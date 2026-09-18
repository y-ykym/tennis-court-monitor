import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReservationFlex, buildCancelConfirmFlex, buildCancelResultFlex, buildPenaltyAlertFlex, jstNowHHMM, bubbleBytes, MAX_BUBBLE_BYTES, MAX_CAROUSEL_BYTES } from '../src/flex.js';

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

test('flex: 人ごとに 1 枚のカルーセル。ヘッダーは名前 + 現在日・件数、行は日付昇順', () => {
  const msg = buildReservationFlex([{ label: 'ゆうたそ', reservations: A }, { label: 'B', reservations: B }], opts);
  assert.equal(msg.type, 'flex');
  assert.equal(msg.altText, '📅 予約一覧 3件: ゆうたそ 9/6(日) 9:00-11:00 猿江恩賜公園 ほか');
  assert.equal(msg.contents.type, 'carousel');
  assert.equal(msg.contents.contents.length, 2, '1 人 1 枚');
  const [a, b] = msg.contents.contents;
  assert.deepEqual(texts(a.header), ['ゆうたそ', '9/2 現在 ・ 2件']);
  assert.deepEqual(texts(b.header), ['B', '9/2 現在 ・ 1件']);
  const t = texts(a.body);
  assert.ok(t.indexOf('9:00 - 11:00') < t.indexOf('11:00 - 13:00'), '日付昇順(9/6 → 9/13)');
  assert.equal(t.includes('支払前') || t.includes('支払済'), false, '支払状況は表示しない');
  assert.deepEqual(tiles(msg)[0], ['9/6 日', '#FBE4E4'], '日付タイル');
  assert.equal(pills(msg).length, 0, 'cancelData が無ければボタンは出ない');
  for (const bubble of msg.contents.contents) {
    assert.equal(bubble.size, 'mega', 'カルーセル内のバブルは同じ幅');
    assert.deepEqual(find(bubble.footer, (n) => n.type === 'button').map((x) => x.action.type), ['uri', 'message'], '各カードにサイトリンクと更新');
  }
  // 1 人だけならカルーセルにせずバブルそのまま
  const single = buildReservationFlex([{ label: 'A', reservations: A }], opts);
  assert.equal(single.contents.type, 'bubble');
  assert.deepEqual(texts(single.contents.header), ['A', '9/2 現在 ・ 2件']);
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

test('flex: 片方0件・片方失敗は、それぞれのカードに表示', () => {
  const msg = buildReservationFlex([{ label: 'A', reservations: [] }, { label: 'B', error: new Error('x') }], opts);
  const [a, b] = msg.contents.contents;
  assert.deepEqual(texts(a.header), ['A', '9/2 現在 ・ 0件']);
  assert.ok(texts(a.body).includes('予約はありません'));
  assert.deepEqual(texts(b.header), ['B', '取得失敗']);
  assert.equal(b.header.backgroundColor, '#6B7280', '失敗はグレーのヘッダー');
  assert.ok(texts(b.body).some((s) => s.includes('繋がりませんでした')));
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

test('flex: 各カード 28,000 バイト・全体 49,000 バイト以内(15+15 行は全部載る / 26+26 行は減らして「…ほかN件」)', () => {
  const mk = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: String(2026000100 + i),
      date: `2026-${String(10 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
      start: '17:00',
      end: '19:00',
      facility: ['猿江恩賜公園', '亀戸中央公園', '大島小松川公園'][i % 3],
      cancelData: DATA,
    }));
  const total = (msg) => msg.contents.contents.reduce((n, b) => n + bubbleBytes(b), 0);
  const msg9 = buildReservationFlex([{ label: 'ゆうたそ', reservations: mk(15) }, { label: 'B', reservations: mk(15) }], opts);
  assert.equal(pills(msg9).length, 30, '15+15 行は全部載る(以前の 1 枚 24 行の上限より増えた)');
  assert.equal(texts(msg9.contents).some((s) => s.startsWith('…ほか')), false);
  assert.ok(total(msg9) <= MAX_CAROUSEL_BYTES, `${total(msg9)} bytes`);

  const msg30 = buildReservationFlex([{ label: 'ゆうたそ', reservations: mk(26) }, { label: 'B', reservations: mk(26) }], opts);
  for (const b of msg30.contents.contents) assert.ok(bubbleBytes(b) <= MAX_BUBBLE_BYTES, `${bubbleBytes(b)} bytes`);
  assert.ok(total(msg30) <= MAX_CAROUSEL_BYTES, `${total(msg30)} bytes`);
  const shown = pills(msg30).length;
  assert.ok(shown >= 30 && shown < 52, `表示行数 ${shown}`);
  assert.ok(texts(msg30.contents).some((s) => /^…ほか\d+件$/.test(s)));
});

test('flex: フッターに「一覧を更新」(メッセージアクション「よやく」)がある', () => {
  const msg = buildReservationFlex([{ label: 'A', reservations: A }], opts);
  const actions = find(msg.contents.footer, (n) => n.type === 'button').map((b) => b.action);
  assert.deepEqual(actions.map((a) => a.type), ['uri', 'message']);
  assert.equal(actions[1].text, 'よやく');
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
  assert.deepEqual(find(ok.contents.footer, (n) => n.type === 'button').map((b) => b.action.type), ['message', 'uri'], '成功時は「一覧を見る」が先');
  const ng = buildCancelResultFlex({ ok: false, label: 'ゆうたそ', reservation: r });
  const t2 = texts(ng.contents);
  assert.equal(t2[0], 'キャンセルできませんでした');
  assert.ok(t2.some((s) => s.includes('予約サイトで状態を確認')));
  assert.equal(ng.contents.header.backgroundColor, '#6B7280');
});

// ---- フェーズ4 ペナルティ予告アラートのカード ----
test('buildPenaltyAlertFlex: 23:35 版は見出しが変わり、取得失敗した人の断り書きと行数上限が付く', () => {
  const r = (over = {}) => ({ id: '1', date: '2026-09-21', start: '09:00', end: '11:00', facility: '猿江恩賜公園', cancelData: 'c|A|x', ...over });
  const rows = Array.from({ length: 18 }, (_, i) => ({ label: i % 2 ? 'B' : 'ゆうたそ', reservation: r({ id: String(i) }) }));

  const morning = buildPenaltyAlertFlex({ rows: [{ label: 'ゆうたそ', reservation: r() }], kind: 'morning', nowText: '9/17 9:00 現在' });
  const mt = texts(morning.contents);
  assert.ok(mt.includes('⏰ 今日中にキャンセル'));
  assert.ok(mt.some((s) => s.includes('今日 23:59 までにキャンセルすれば')));
  assert.ok(mt.some((s) => s.includes('ペナルティ(1点)')));
  assert.equal(find(morning.contents, (n) => n.type === 'postback').length, 1);

  const night = buildPenaltyAlertFlex({ rows, kind: 'deadline', nowText: '9/17 23:35 現在', failedLabels: ['B'] });
  const nt = texts(night.contents);
  assert.ok(nt.includes('⏰ まもなく期限(23:59)'));
  assert.ok(nt.some((s) => s.includes('まもなく期限です')));
  assert.ok(nt.some((s) => s.includes('…ほか3件')), '15行を超えた分はまとめる');
  assert.ok(nt.some((s) => s.includes('B は予約サイトに繋がらず確認できていません')));
  assert.ok(bubbleBytes(night.contents) <= MAX_BUBBLE_BYTES);
});

// ---- フェーズ5 テニスベアの合流(§15) ----
const TB = [
  { source: 'tennisbear', id: '1621297', title: 'ストローク多め練', date: '2026-09-22', start: '19:00', end: '21:00', facility: '亀戸中央公園テニスコート', organizer: false },
  { source: 'tennisbear', id: '2', title: '朝練', date: '2026-09-08', start: '09:00', end: '11:00', facility: '', organizer: true },
];

test('flex(§15): テニスベアの行は 🐻 イベント名 + コート名、都の行と日付順に混ざり、キャンセルボタンは付かない', () => {
  const site = A.map((r) => ({ ...r, cancelData: DATA }));
  const msg = buildReservationFlex([{ label: 'ゆうたそ', reservations: site, tennisbear: { events: TB } }], opts);
  assert.equal(msg.contents.type, 'bubble');
  assert.deepEqual(texts(msg.contents.header), ['ゆうたそ', '9/2 現在 ・ 4件'], '件数はテニスベア込み');
  assert.deepEqual(
    tiles(msg).map(([t]) => t),
    ['9/6 日', '9/8 火', '9/13 日', '9/22 火'],
    '日付順に混ざる(9/6 都 → 9/8 🐻 → 9/13 都 → 9/22 🐻)'
  );
  const t = texts(msg.contents.body);
  assert.ok(t.includes('\n🐻 ストローク多め練'));
  assert.ok(t.includes('\n亀戸中央公園テニスコート'), 'コート名はイベント名の下');
  assert.ok(t.includes('\n🐻 朝練'));
  assert.equal(t.filter((s) => s.includes('主催')).length, 0, '主催の印は付けない');
  assert.equal(pills(msg).length, 2, 'キャンセルボタンは都の 2 行だけ');
  assert.equal(t.some((s) => s.includes('テニスベアの取得に失敗')), false);
  assert.equal(msg.altText, '📅 予約一覧 4件: ゆうたそ 9/6(日) 9:00-11:00 猿江恩賜公園 ほか');
});

test('flex(§15): テニスベアの cancelData は無視する(万一混ざってもボタンにしない)', () => {
  const msg = buildReservationFlex([{ label: 'A', reservations: [], tennisbear: { events: [{ ...TB[0], cancelData: DATA }] } }], opts);
  assert.equal(pills(msg).length, 0);
  assert.equal(msg.altText, '📅 予約一覧 1件: A 9/22(火) 19:00-21:00 🐻 ストローク多め練');
});

test('flex(§15): テニスベアだけ失敗 → 都の予約は普通に出し、カード末尾に小さく 1 行', () => {
  const msg = buildReservationFlex([{ label: 'A', reservations: A, tennisbear: { error: new Error('x') } }, { label: 'B', reservations: B }], opts);
  const [a, b] = msg.contents.contents;
  assert.deepEqual(texts(a.header), ['A', '9/2 現在 ・ 2件']);
  const last = texts(a.body).at(-1);
  assert.equal(last, '🐻 テニスベアの取得に失敗しました');
  assert.equal(texts(b.body).some((s) => s.includes('テニスベア')), false, 'B には出ない');
  // 都が 0 件でも黙って「予約はありません」だけにしない
  const zero = buildReservationFlex([{ label: 'A', reservations: [], tennisbear: { error: new Error('x') } }], opts);
  assert.deepEqual(texts(zero.contents.body), ['予約はありません', '🐻 テニスベアの取得に失敗しました']);
});

test('flex(§15): 都だけ失敗 → 「繋がりませんでした」の下にテニスベアの予定を出す(ヘッダーは従来どおり取得失敗)', () => {
  const msg = buildReservationFlex([{ label: 'A', error: new Error('x'), tennisbear: { events: TB } }], opts);
  const t = texts(msg.contents.body);
  assert.deepEqual(texts(msg.contents.header), ['A', '取得失敗']);
  assert.equal(msg.contents.header.backgroundColor, '#6B7280');
  assert.ok(t[0].includes('繋がりませんでした'));
  assert.ok(t.indexOf('\n🐻 朝練') > 0 && t.indexOf('\n🐻 朝練') < t.indexOf('\n🐻 ストローク多め練'));
  assert.equal(pills(msg).length, 0);
  assert.equal(msg.altText, '📅 予約一覧 2件: A 9/8(火) 9:00-11:00 🐻 朝練 ほか');
});

test('flex(§15): テニスベアの行も 30KB 制限の行数調整に入る(「…ほかN件」)', () => {
  const mk = (n) =>
    Array.from({ length: n }, (_, i) => ({
      source: 'tennisbear',
      id: String(i),
      title: `イベント${i}`,
      date: `2026-${String(10 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
      start: '19:00',
      end: '21:00',
      facility: '亀戸中央公園テニスコート',
    }));
  const msg = buildReservationFlex([{ label: 'A', reservations: A, tennisbear: { events: mk(40) } }], opts);
  assert.ok(bubbleBytes(msg.contents) <= MAX_BUBBLE_BYTES);
  assert.ok(texts(msg.contents).some((s) => /^…ほか\d+件$/.test(s)));
});

// ---- 同じ日付を 1 つのタイルにまとめる(2026-09-17 変更) ----
test('flex: 同じ日の予定は 1 つの日付タイルの右に時間順で縦に並ぶ。キャンセルボタンは予定ごと、罫線は日と日の間だけ', () => {
  const reservations = [
    { id: '2', date: '2026-09-23', start: '15:00', end: '17:00', facility: '大島小松川公園', cancelData: DATA },
    { id: '1', date: '2026-09-22', start: '13:00', end: '15:00', facility: '猿江恩賜公園', cancelData: DATA },
    { id: '3', date: '2026-09-25', start: '09:00', end: '11:00', facility: '大島小松川公園', cancelData: DATA },
    { id: '4', date: '2026-09-25', start: '11:00', end: '13:00', facility: '大島小松川公園', cancelData: DATA },
  ];
  const TBX = [
    { source: 'tennisbear', id: 'a', title: 'ストローク多め練', date: '2026-09-22', start: '19:00', end: '21:00', facility: '大島小松川公園Ａ' },
    { source: 'tennisbear', id: 'b', title: 'ストローク多め練', date: '2026-09-23', start: '19:00', end: '21:00', facility: '大島小松川公園Ａ' },
  ];
  const msg = buildReservationFlex([{ label: 'ゆうたそ', reservations, tennisbear: { events: TBX } }], { today: '2026-09-17', nowHHMM: '12:00' });
  assert.deepEqual(texts(msg.contents.header), ['ゆうたそ', '9/17 現在 ・ 6件'], '件数は予定の数のまま');
  assert.deepEqual(tiles(msg).map(([t]) => t), ['9/22 火', '9/23 水', '9/25 金'], 'タイルは日ごとに 1 つ');
  assert.equal(pills(msg).length, 4, 'キャンセルボタンは都の 4 件ぶん');
  assert.equal(find(msg.contents.body, (n) => n.type === 'separator').length, 2, '罫線は日と日の間(2 本)だけ');
  // 9/22 の行: タイルの右の縦積みに 13:00(都・ボタン付き)→ 19:00(🐻・ボタン無し)の順
  const day22 = find(msg.contents.body, (n) => n.margin === 'lg' && n.layout === 'horizontal')[0];
  const column = day22.contents[1];
  assert.equal(column.layout, 'vertical');
  assert.equal(column.contents.length, 2);
  assert.ok(texts(column.contents[0]).includes('13:00 - 15:00') && pills(column.contents[0]).length === 1);
  assert.ok(texts(column.contents[1]).includes('19:00 - 21:00') && texts(column.contents[1]).includes('\n🐻 ストローク多め練') && pills(column.contents[1]).length === 0);
  assert.equal(column.contents[1].margin, 'lg', '同じ日の 2 件目は 12px 空ける(罫線は引かない)');
});

test('flex: 同じ日に終了済みとこれからの予定が混ざれば、タイルは通常色・終了した枝だけグレー。全部終了ならタイルもグレー', () => {
  const reservations = [
    { id: '1', date: '2026-09-02', start: '09:00', end: '11:00', facility: '亀戸中央公園', cancelData: DATA }, // 終了
    { id: '2', date: '2026-09-02', start: '17:00', end: '19:00', facility: '猿江恩賜公園', cancelData: DATA }, // これから
  ];
  const msg = buildReservationFlex([{ label: 'A', reservations }], { today: '2026-09-02', nowHHMM: '12:00' });
  assert.deepEqual(tiles(msg), [['9/2 水', '#EEF0F3']], '平日の通常色');
  assert.equal(pills(msg).length, 1, 'ボタンはこれからの 1 件だけ');
  const t = texts(msg.contents.body);
  assert.ok(t.includes('  終了') && t.includes('  今日'));
  const allPast = buildReservationFlex([{ label: 'A', reservations }], { today: '2026-09-02', nowHHMM: '20:00' });
  assert.deepEqual(tiles(allPast), [['9/2 水', '#F3F4F6']], '全部終了ならグレー');
  assert.equal(pills(allPast).length, 0);
});

test('flex: 「…ほかN件」は予定の数で数える(同じ日にまとめても上限の意味は変わらない)', () => {
  const same = Array.from({ length: 30 }, (_, i) => ({ id: String(i), date: '2026-10-01', start: `${String(6 + (i % 16)).padStart(2, '0')}:00`, end: '23:00', facility: '大島小松川公園', cancelData: DATA }));
  const msg = buildReservationFlex([{ label: 'A', reservations: same }, { label: 'B', reservations: same }], opts);
  for (const b of msg.contents.contents) assert.ok(bubbleBytes(b) <= MAX_BUBBLE_BYTES, `${bubbleBytes(b)} bytes`);
  assert.equal(tiles(msg).length, 2, '1 人 1 日なのでタイルは 1 人 1 個');
  assert.ok(texts(msg.contents).some((s) => /^…ほか\d+件$/.test(s)));
});

test('flex: 同じ枠を都で予約しテニスベアでも募集している行は 1 行にまとめ、キャンセルボタンは残す', () => {
  const site = [{ id: '2026000123', date: '2026-09-22', start: '19:00', end: '21:00', facility: '大島小松川公園', status: '支払前', cancelData: DATA }];
  const ev = { source: 'tennisbear', id: '1621297', title: 'ストローク多め練', date: '2026-09-22', start: '19:00', end: '21:00', facility: '大島小松川公園Ａ', placeCode: '0100010020', organizer: true };
  const msg = buildReservationFlex([{ label: 'A', reservations: site, tennisbear: { events: [ev] } }], opts);
  assert.deepEqual(texts(msg.contents.header), ['A', '9/2 現在 ・ 1件'], '2 行に見せず 1 件と数える');
  assert.deepEqual(tiles(msg).map(([t]) => t), ['9/22 火'], '日付タイルも 1 つ');
  const t = texts(msg.contents.body);
  assert.ok(t.includes('\n大島小松川公園'), '土台は都の行(公園名は都の表記)');
  assert.ok(t.includes('\n🐻 ストローク多め練'), 'テニスベアのイベント名も残す');
  assert.equal(pills(msg).length, 1, '都の予約なのでキャンセルボタンは付く');
});
