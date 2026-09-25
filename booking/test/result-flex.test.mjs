import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChallengeFlex, buildResultFlex } from '../src/result-flex.js';

const slot = { park: '1050', date: '2026-09-30', startHour: 13, people: 2 };
const bytes = (m) => Buffer.byteLength(JSON.stringify(m.contents), 'utf8');

test('確認依頼カード: 開く URL がボタンに入り、予約者・期限が本文にある', () => {
  const url = 'https://tennis-reservation-bot.y-ykym.workers.dev/vnc?token=abc.def';
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

test('結果カード: 成功は予約番号と料金、失敗は理由と手動リンク', () => {
  const ok = buildResultFlex({ slot, status: 'success', reservationNo: '2026260562', fee: '2,600円', facility: '亀戸中央公園' }, 'ゆう');
  assert.match(JSON.stringify(ok.contents), /2026260562/);
  const okActions = ok.contents.footer.contents[1].contents.map((b) => b.action);
  assert.deepEqual(okActions.map((a) => a.type), ['message', 'uri'], '成功時は「予約一覧を見る」(よやく)とサイトリンク');
  assert.equal(okActions[0].text, 'よやく');
  const ng = buildResultFlex({ slot, status: 'taken', message: '満員', facility: '亀戸中央公園' }, 'ゆう');
  assert.match(JSON.stringify(ng.contents), /先に予約されていました/);
  assert.deepEqual(ng.contents.footer.contents[1].contents.map((b) => b.action.type), ['uri'], '失敗時はサイトへのリンクだけ');
});

test('結果カード(自動予約): 見出しに「自動予約」。cancelData があれば警告文とキャンセル postback ボタンが付く', () => {
  const ok = buildResultFlex({ slot, status: 'success', reservationNo: '2026260562', fee: '2,600円', facility: '亀戸中央公園' }, 'ゆう', { auto: true, cancelData: 'c|A|2026260562|20260930|1300|1500|亀戸中央公園|3|1|.sig' });
  const text = JSON.stringify(ok.contents);
  assert.equal(ok.contents.header.contents[0].text, '🤖 自動予約が完了');
  assert.match(text, /空きを見つけて自宅の予約サーバーが自動で予約しました/);
  assert.match(text, /ペナルティなしで取り消せるのは今日 23:59 まで/);
  const pb = JSON.stringify(ok.contents.footer).match(/"type":"postback"/g);
  assert.equal(pb.length, 1);
  assert.match(JSON.stringify(ok.contents.footer), /"data":"c\|A\|2026260562/);
  assert.ok(bytes(ok) < 10000);

  const plain = buildResultFlex({ slot, status: 'success', reservationNo: '1', facility: '亀戸中央公園' }, 'ゆう', { auto: true });
  assert.equal(JSON.stringify(plain.contents).includes('"type":"postback"'), false, '+5 日以降はキャンセルボタン無し');
  assert.equal(JSON.stringify(plain.contents).includes('ペナルティなしで取り消せるのは今日'), false);

  const ng = buildResultFlex({ slot, status: 'taken', message: '先に取られた', facility: '亀戸中央公園' }, 'ゆう', { auto: true });
  assert.equal(ng.contents.header.contents[0].text, '🤖 自動予約できませんでした');
  // 手動(LINE のボタン)のカードは「(ボタン)」と押したボタンの名前で見分ける(2026-09-25。それまで小見出しが「自動で予約しました」で紛らわしかった)
  const manual = buildResultFlex({ slot, status: 'success', reservationNo: '1', facility: '亀戸中央公園' }, 'ゆう');
  assert.equal(manual.contents.header.contents[0].text, '🎾 予約完了(ボタン)');
  assert.match(JSON.stringify(manual.contents.header), /LINE の「ゆうで予約」ボタンが押されたので予約しました/);
  assert.equal(JSON.stringify(manual.contents).includes('自動'), false, '手動カードに「自動」という言葉を出さない');
  const manualNg = buildResultFlex({ slot, status: 'taken', message: '満員', facility: '亀戸中央公園' }, 'ゆう');
  assert.equal(manualNg.contents.header.contents[0].text, '⚠️ 予約できませんでした(ボタン)');
});
