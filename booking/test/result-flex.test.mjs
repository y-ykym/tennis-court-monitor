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
  assert.ok(m.altText.length <= 400);
  assert.ok(bytes(m) < 10000, 'バブルは 10KB 未満');
});

test('結果カード: 成功は予約番号と料金、失敗は理由と手動リンク', () => {
  const ok = buildResultFlex({ slot, status: 'success', reservationNo: '2026260562', fee: '2,600円', facility: '亀戸中央公園' }, 'ゆう');
  assert.match(JSON.stringify(ok.contents), /2026260562/);
  assert.equal(ok.contents.footer, undefined);
  const ng = buildResultFlex({ slot, status: 'taken', message: '満員', facility: '亀戸中央公園' }, 'ゆう');
  assert.match(JSON.stringify(ng.contents), /先に予約されていました/);
  assert.equal(ng.contents.footer.contents[0].action.type, 'uri');
});
