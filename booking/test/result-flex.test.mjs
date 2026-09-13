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
