// lib/site-notice.js: 都サイトの「お知らせ」ページ(本物の障害・メンテナンスの応答)の判定
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isSiteNoticePage, siteNoticeError, carrySiteNotice } = require('../lib/site-notice.js');

// 2026-11-07 01:09 に Pi の last-scrape-failure.html に残った実物(整形のみ)
const NOTICE = `<html><head><meta http-equiv="content-type" content="text/html;charset=Shift_JIS"/><title>
施設予約システムからのお知らせ
</title></head><body><font size="+3"><b>施設予約システムからのお知らせ<br></b></font>
<font size="+2">ご迷惑をおかけしております。<br>現在、ご指定のページはアクセスできません。<br>しばらく経ってから、アクセスしてください。<br></font></body></html>`;

test('本物のお知らせページを判定する。通常のトップ・502 の HTML・空は違う', () => {
  assert.equal(isSiteNoticePage(NOTICE), true);
  assert.equal(isSiteNoticePage('施設予約システムからのお知らせ'), true, 'ブラウザの <title> だけでも判定できる');
  assert.equal(isSiteNoticePage('<html><body onclick="rsvWOpeInstSrchVacantAction">トップ</body></html>'), false);
  assert.equal(isSiteNoticePage('<html><body>502 Bad Gateway</body></html>'), false);
  assert.equal(isSiteNoticePage(''), false);
  assert.equal(isSiteNoticePage(null), false);
});

test('siteNoticeError は目印付き。包み直しても carrySiteNotice で引き継ぐ', () => {
  const e = siteNoticeError('トップページ');
  assert.equal(e.siteNotice, true);
  assert.match(e.message, /^都サイトがメンテナンス・障害中.*: トップページ$/);
  const wrapped = carrySiteNotice(e, new Error(`猿江恩賜公園 の取得に失敗: ${e.message}`));
  assert.equal(wrapped.siteNotice, true);
  assert.equal(carrySiteNotice(new Error('fetch failed'), new Error('x')).siteNotice, undefined);
});
