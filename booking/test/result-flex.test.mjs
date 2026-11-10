import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChallengeFlex, buildResultFlex, pushResult } from '../src/result-flex.js';

const slot = { park: '1050', date: '2026-09-30', startHour: 13, people: 2 };
const bytes = (m) => Buffer.byteLength(JSON.stringify(m.contents), 'utf8');

test('確認依頼カード: 開く URL がボタンに入り、予約者・期限が本文にある', () => {
  const url = 'https://example.workers.dev/vnc?token=abc.def';
  const m = buildChallengeFlex({ slot, facility: '亀戸中央公園', label: 'ゆう', url, minutes: 8 });
  assert.equal(m.type, 'flex');
  assert.equal(m.contents.footer.contents[0].action.uri, url);
  const text = JSON.stringify(m.contents);
  assert.match(text, /ゆう/);
  assert.match(text, /9\/30\(水\) 13:00-15:00/);
  assert.match(text, /8分以内/);
  assert.equal(JSON.stringify(m.contents).match(/"type":"span"/g).length, 8, '手順4つ × 番号+本文の span');
  assert.ok(m.altText.length <= 400);
  assert.ok(bytes(m) < 10000, 'バブルは 10KB 未満');
});

test('結果カード: 成功は予約番号と料金、失敗は理由。フッターのリンクは置かない(2026-11-10)', () => {
  const ok = buildResultFlex({ slot, status: 'success', reservationNo: '2026000562', fee: '2,600円', facility: '亀戸中央公園' }, 'ゆう');
  assert.match(JSON.stringify(ok.contents), /2026000562/);
  assert.match(JSON.stringify(ok.contents), /2,600円/);
  assert.equal(ok.contents.footer, undefined);
  assert.equal(ok.contents.header.contents.length, 1, '見出しの下の言い直しは置かない');
  assert.equal(JSON.stringify(ok.contents).includes('取り消すときは'), false, '取り消し方の案内文は置かない');
  const ng = buildResultFlex({ slot, status: 'taken', message: '満員', facility: '亀戸中央公園' }, 'ゆう');
  assert.match(JSON.stringify(ng.contents), /先に予約されていました/);
  assert.equal(ng.contents.footer, undefined);
});

test('結果カード(自動予約): 見出しに「自動予約」。cancelData があれば警告文とキャンセル postback ボタンが付く', () => {
  const ok = buildResultFlex({ slot, status: 'success', reservationNo: '2026000562', fee: '2,600円', facility: '亀戸中央公園' }, 'ゆう', { auto: true, cancelData: 'c|A|2026000562|20260930|1300|1500|亀戸中央公園|3|1|.sig' });
  const text = JSON.stringify(ok.contents);
  assert.equal(ok.contents.header.contents[0].text, '🤖 自動予約が完了');
  assert.equal(text.match(/今日中/g).length, 1, '「今日中ならペナルティなし」は注意書きの 1 か所だけ');
  assert.match(text, /⚠ ペナルティなしの取消は今日中/);
  assert.match(JSON.stringify(ok.contents.body.contents.at(-1)), /ペナルティなしの取消は今日中/, '注意書きは本文の最後 = キャンセルボタンのすぐ上');
  const sizes = ok.contents.body.contents.filter((n) => n.layout === 'horizontal').map((n) => n.contents[1].size);
  assert.deepEqual([...new Set(sizes)], ['sm'], '予約番号も他の項目と同じ文字サイズ');
  const pb = JSON.stringify(ok.contents.footer).match(/"type":"postback"/g);
  assert.equal(pb.length, 1);
  assert.equal(ok.contents.footer.contents[0].action.label, 'キャンセル');
  assert.equal(JSON.stringify(ok.contents.footer).includes('"type":"uri"'), false, 'リンクは置かない');
  assert.match(JSON.stringify(ok.contents.footer), /"data":"c\|A\|2026000562/);
  assert.ok(bytes(ok) < 10000);

  const plain = buildResultFlex({ slot, status: 'success', reservationNo: '1', facility: '亀戸中央公園' }, 'ゆう', { auto: true });
  assert.equal(JSON.stringify(plain.contents).includes('"type":"postback"'), false, '+5 日以降はキャンセルボタン無し');
  assert.equal(JSON.stringify(plain.contents).includes('ペナルティなしの取消は今日中'), false);

  const ng = buildResultFlex({ slot, status: 'taken', message: '先に取られた', facility: '亀戸中央公園' }, 'ゆう', { auto: true });
  assert.equal(ng.contents.header.contents[0].text, '🤖 自動予約できませんでした');
  // 手動(LINE のボタン)のカードは見出しの「(ボタン)」で見分ける(2026-09-25。小見出しは 2026-11-10 に外した)
  const manual = buildResultFlex({ slot, status: 'success', reservationNo: '1', facility: '亀戸中央公園' }, 'ゆう');
  assert.equal(manual.contents.header.contents[0].text, '🎾 予約完了(ボタン)');
  assert.equal(JSON.stringify(manual.contents).includes('自動'), false, '手動カードに「自動」という言葉を出さない');
  const manualNg = buildResultFlex({ slot, status: 'taken', message: '満員', facility: '亀戸中央公園' }, 'ゆう');
  assert.equal(manualNg.contents.header.contents[0].text, '⚠️ 予約できませんでした(ボタン)');
});

test('結果カード(自動予約・ペナルティ期間の日): 取消にペナルティが付く旨の警告。キャンセルボタンは付けない', () => {
  const m = buildResultFlex({ slot, status: 'success', reservationNo: '1', fee: '2,600円', facility: '亀戸中央公園' }, 'ゆう', { auto: true, penalty: true });
  const text = JSON.stringify(m.contents);
  assert.match(text, /取り消すとペナルティ 1 点が付きます/);
  assert.equal(text.includes('ペナルティなしの取消は今日中'), false);
  assert.equal(text.includes('"type":"postback"'), false);
  assert.ok(bytes(m) < 10000);
});

test('pushResult: 送る本文の最後のメッセージにクイックリプライ(合言葉のボタン列)が付く', async () => {
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); };
  try {
    await pushResult({ type: 'text', text: 'a' }, { token: 't', to: 'G' });
    await pushResult([{ type: 'text', text: '1' }, { type: 'text', text: '2' }], { token: 't', to: 'G' });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(bodies[0].messages[0].quickReply.items.length, 6);
  assert.equal(bodies[0].messages[0].quickReply.items[0].action.text, 'よやく');
  assert.equal(bodies[1].messages[0].quickReply, undefined);
  assert.equal(bodies[1].messages[1].quickReply.items.length, 6);
});

test('結果カード・確認依頼カードの形(2026-11-10): 帯の色・表の太字・失敗の理由は赤', () => {
  const rowsOf = (m) => m.contents.body.contents.filter((n) => n.layout === 'horizontal').map((n) => [n.contents[0].text, n.contents[1].weight, n.contents[1].color]);
  const ok = buildResultFlex({ slot, status: 'success', reservationNo: '1', fee: '2,600円', facility: '亀戸中央公園' }, 'ゆう', { auto: true });
  assert.equal(ok.contents.header.backgroundColor, '#15803D', '成功は緑(白文字が読める濃さ)');
  assert.equal(ok.contents.size, 'mega');
  assert.deepEqual(rowsOf(ok), [['予約者', 'bold', '#111827'], ['日時', 'bold', '#111827'], ['公園', 'bold', '#111827'], ['予約番号', undefined, '#111827'], ['料金', undefined, '#111827']], '予約者・日時・公園だけ太字');
  const ng = buildResultFlex({ slot, status: 'taken', facility: '亀戸中央公園' }, 'ゆう', { auto: true });
  assert.equal(ng.contents.header.backgroundColor, '#6B7280', '失敗は灰');
  assert.deepEqual(rowsOf(ng).at(-1), ['理由', 'bold', '#DC2626'], '理由は赤の太字');
  const ch = buildChallengeFlex({ slot, facility: '亀戸中央公園', label: 'ゆう', url: 'https://example.workers.dev/vnc', minutes: 8 });
  assert.equal(ch.contents.header.backgroundColor, '#9A3412', '対応が要るカードは琥珀');
  assert.deepEqual(ch.contents.header.contents.map((n) => n.text), ['🔐 確認が必要です', '8分以内'], '期限を帯の右に');
  assert.match(ch.contents.body.contents[0].text, /8分以内に操作してください/, '期限を本文の先頭にも');
  assert.deepEqual(rowsOf(ch).map((r) => r[0]), ['予約者', '日時', '公園']);
});
