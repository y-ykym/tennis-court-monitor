// 「予約」を押した後に同じ確認画面が返ったときの理由の読み取り(reserve.js の siteErrorMessage)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteErrorMessage } from '../src/reserve.js';

test('onload の errorMsg(&quot;…&quot;, 0) から文言を取る(2026-10-26 23:26 に保存された実画面の形)', () => {
  const html = '<body class="d-flex" onload="javascript:msgHide();javascript:errorMsg(&quot;エラーが発生しました。(施設予約に失敗しました。)&quot;, 0);startInitTimer();">'
    + '<div class="modal">ご利用環境 × 対応ブラウザ 対応ブラウザは以下のとおりです。</div>';
  assert.equal(siteErrorMessage(html), 'エラーが発生しました。(施設予約に失敗しました。)');
});

test('&lt;BR&gt; は空白に、エンティティは元の文字に戻す(2026-10-26 12:31 の「データ通信」の形)', () => {
  const html = '<body onload="javascript:errorMsg(&quot;データ通信を正しく行うことができませんでした。&lt;BR&gt;時間をあけ再度操作を行って下さい。&quot;, 0);">';
  assert.equal(siteErrorMessage(html), 'データ通信を正しく行うことができませんでした。 時間をあけ再度操作を行って下さい。');
});

test('showAlert("…") の形(ログイン画面)も同じ関数で読める', () => {
  assert.equal(siteErrorMessage('<body onload="showAlert(\'パスワードは10桁以上で入力して下さい。\');">'), 'パスワードは10桁以上で入力して下さい。');
});

test('文言が無ければ空文字(本文の非表示モーダルの文言は拾わない)', () => {
  assert.equal(siteErrorMessage('<body onload="startInitTimer();"><div>ご利用環境 × 対応ブラウザ</div>'), '');
  assert.equal(siteErrorMessage(''), '');
  assert.equal(siteErrorMessage(null), '');
});

test('taken の判定: 「施設予約に失敗しました」は先を越されたとみなす(reserve.js の分類と同じ正規表現)', () => {
  const reason = siteErrorMessage('<body onload="javascript:errorMsg(&quot;エラーが発生しました。(施設予約に失敗しました。)&quot;, 0);">');
  assert.match(reason, /空き|予約済|予約あり|他の利用者|施設予約に失敗/);
  assert.doesNotMatch(reason, /同じ利用日時|複数の予約|既に予約|2件まで/);
});

test('通常の確認画面にある空の errorMsg(&quot;&quot;, 0) は空文字(後ろの文字列を巻き込まない。2026-11-01 の実機で確認)', () => {
  const html = '<body onload="javascript:msgHide();javascript:errorMsg(&quot;&quot;, 0);startInitTimer();"><div onclick="showConfirm(&quot;x&quot;, 0)"></div>';
  assert.equal(siteErrorMessage(html), '');
});

// 記録・ログに個人情報を残さない(2026-11-19)
import { redactPersonal } from '../src/reserve.js';
test('redactPersonal: 利用者カードのモーダルの利用者番号・氏名と、利用者番号そのものを伏せる。ほかの文言は変えない', () => {
  const body = '完了画面に到達しませんでした (prwea1000.jsp): ご利用環境 × 対応ブラウザ 閉じる 利用者カード× 利用者番号：12345678 利用者氏名：山田太郎 様 閉じる 抽選申込み';
  const out = redactPersonal(body, { userId: '12345678' });
  assert.ok(!out.includes('12345678') && !out.includes('山田'), out);
  assert.ok(out.includes('利用者番号：(伏せ)') && out.includes('利用者氏名：(伏せ)') && out.includes('抽選申込み'));
  assert.equal(redactPersonal('ログイン失敗 12345678 を確認', { userId: '12345678' }), 'ログイン失敗 (伏せ) を確認');
  assert.equal(redactPersonal('先に予約された可能性があります: エラーが発生しました。(施設予約に失敗しました。)', { userId: '12345678' }), '先に予約された可能性があります: エラーが発生しました。(施設予約に失敗しました。)');
  assert.equal(redactPersonal(null), '');
});
