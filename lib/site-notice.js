// ============================================================
// 都のサイトが障害・メンテナンス中に返す「お知らせ」ページの判定。
//
// 2026-11-07 01:09(JST)に本物を記録した(Pi の last-scrape-failure.html)。トップ(/web/index.jsp)に対して HTTP 200 で
//   <title>施設予約システムからのお知らせ</title>
//   ご迷惑をおかけしております。現在、ご指定のページはアクセスできません。しばらく経ってから、アクセスしてください。
// が返る(予約の一覧でも同じページが返ることは 2026-10-08 に確認済み。booking/src/reservation-list.js)。
//
// このページが返ったら、都サイト全体が止まっているので、公園や週を変えてやり直しても無駄。
// 呼び出し側はすぐに照会の間隔を広げる(booking/src/auto-runner.js)・ブラウザの起こし直しを待つ(browser-warmer.js)。
// ============================================================
const SITE_NOTICE_TITLE = '施設予約システムからのお知らせ';
const SITE_NOTICE_MESSAGE = '都サイトがメンテナンス・障害中(「施設予約システムからのお知らせ」ページが返った)';

// その HTML(または <title> の文字列)が「お知らせ」ページか
function isSiteNoticePage(html) {
  return String(html || '').includes(SITE_NOTICE_TITLE);
}

// 「お知らせ」ページを受け取ったときに投げる Error(siteNotice=true が目印。メッセージの先頭に付けて伝播させる)
function siteNoticeError(where) {
  const e = new Error(where ? `${SITE_NOTICE_MESSAGE}: ${where}` : SITE_NOTICE_MESSAGE);
  e.siteNotice = true;
  return e;
}

// 別の Error に包み直すとき、目印を引き継ぐ
function carrySiteNotice(from, to) {
  if (from && from.siteNotice) to.siteNotice = true;
  return to;
}

module.exports = { SITE_NOTICE_TITLE, SITE_NOTICE_MESSAGE, isSiteNoticePage, siteNoticeError, carrySiteNotice };
