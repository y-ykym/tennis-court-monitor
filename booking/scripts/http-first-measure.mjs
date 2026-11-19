#!/usr/bin/env node
// ============================================================
// HTTP 先行方式(src/site-http.js)の「直接通信の部分」だけを測る。**ブラウザは一切使わない。予約も押さない。**
//   トップ → ログイン画面 → ログイン → 検索 → 枠の選択 → 予約一覧 → ログアウト(LINE の「よやく」と同じ種類の通信)
// reCAPTCHA の載った画面(確認画面)は開かないので、判定に材料を与えない。枠の選択はセッションの中だけの状態で、仮押さえにならない
// (docs/site-notes.md)。ログアウトで消える。
//
//   Pi で: docker compose exec -T booking node scripts/http-first-measure.mjs [--person A] [--park 1040] [--date YYYY-MM-DD] [--start 9]
//     既定: 予約者 A・猿江(1040)・今日から 14 日後・9 時。枠が空いていなくても選択までは進む(サーバーは「予約」送信まで空きを検証しない)
//
// 本番のブラウザ・プロファイルには触らない(playwright を読み込まない)。ログインを 1 回するので、続けて何度も回さない。
// 利用者番号・パスワード・Cookie は表示しない。
// ============================================================
import { createHttpSession } from '../src/site-http.js';
import { inPageFlow } from '../src/site-inpage.js';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const person = opt('person', 'A') === 'B' ? 'B' : 'A';
const credentials = { userId: process.env[`SITE_USER_${person}`], password: process.env[`SITE_PASS_${person}`] };
if (!credentials.userId || !credentials.password) {
  console.error(`SITE_USER_${person} / SITE_PASS_${person} が未設定です(booking コンテナの中で実行してください)`);
  process.exit(1);
}
const HOUR_TO_TZ = { 9: '10', 11: '20', 13: '30', 15: '40', 17: '50', 19: '60' }; // src/reserve.js と同じ
const jstDate = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
const startHour = Number(opt('start', '9'));
const slot = { park: opt('park', '1040'), date: opt('date', jstDate(Date.now() + 14 * 86400 * 1000)), startHour, vacant: 1, tzoneNo: HOUR_TO_TZ[startHour] };
if (!slot.tzoneNo) {
  console.error('--start は 9 / 11 / 13 / 15 / 17 / 19 のどれか');
  process.exit(1);
}

console.log(`計測: 公園 ${slot.park} ${slot.date} ${startHour} 時(予約者 ${person}。ブラウザは使わず、予約も押しません) ${new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
const started = Date.now();
const realFetch = globalThis.fetch;
const session = createHttpSession({ fetchImpl: realFetch });
let loggedIn = false;
let result;
try {
  const top = await session.fetch('/web/index.jsp');
  const html = new TextDecoder('shift_jis').decode(await top.arrayBuffer());
  if (top.status !== 200 || !/rsvWTransUserLoginAction/i.test(html)) throw new Error(`トップページが想定外です (HTTP ${top.status})`);
  // inPageFlow はブラウザ用で、その場の fetch を使う。ここでは Cookie を持ち回る自前の通信に差し替えて Node で動かす
  // (session は差し替える前の本物の fetch を掴んでいる。本番の予約処理が通るコードは変えない)
  globalThis.fetch = session.fetch;
  result = await inPageFlow({ slot, credentials, withList: true, prefetched: null }, session.fetch);
  loggedIn = session.steps().some((s) => s.path === 'rsvWUserAttestationLoginAction');
} catch (e) {
  result = { ok: false, status: 'error', message: e.message };
}
const flowMs = Date.now() - started;
if (loggedIn) {
  try {
    await session.fetch('/web/rsvWTransUserAttestationEndAction.do', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'displayNo=prwha1000&displayNoFrm=prwha1000' });
  } catch (e) {
    console.log(`ログアウト失敗(放置で 10 分後に切れます): ${e.message}`);
  }
}
const NAMES = { index: 'トップ', rsvWTransUserLoginAction: 'ログイン画面', rsvWUserAttestationLoginAction: 'ログイン', rsvWOpeInstSrchVacantAction: '検索', rsvWOpeInstReservAjaxAction: '枠の選択', rsvWGetCancelRsvDataAction: '予約一覧', rsvWTransUserAttestationEndAction: 'ログアウト' };
for (const s of session.steps()) console.log(`  ${(NAMES[s.path] || s.path).padEnd(8, ' ')} ${(s.ms / 1000).toFixed(1)} 秒`);
console.log(result.ok ? `結果: 枠の選択まで成功(${result.facility})。トップ〜予約一覧の合計 ${(flowMs / 1000).toFixed(1)} 秒` : `結果: ${result.status} ${result.message}(${(flowMs / 1000).toFixed(1)} 秒)`);
process.exit(result.ok ? 0 : 1);
