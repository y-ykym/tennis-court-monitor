#!/usr/bin/env node
// ============================================================
// HTTP 先行方式(src/site-http.js)の「直接通信の部分」だけを測る。**ブラウザは一切使わない。予約も押さない。**
//   前もって済ませる分: トップ → 検索(今日の日付) → ログイン画面   ← 本番のブラウザが 8 分おきに先取りしているのと同じ順番
//   空きが出てからの分: ログイン → 枠の選択 → 予約一覧               ← ここが縮めたい時間
//   最後にログアウト(LINE の「よやく」と同じ種類の通信)
//   --no-prefetch を付けると先取りせず、ログインの後に検索する(2026-11-19 16:44 はこの順で検索結果の公園が空になった)
// reCAPTCHA の載った画面(確認画面)は開かないので、判定に材料を与えない。枠の選択はセッションの中だけの状態で、仮押さえにならない
// (docs/site-notes.md)。ログアウトで消える。
//
//   Pi で(booking/pc から。scripts はイメージに入れていない(.dockerignore)ので、動いているコンテナに置いてから実行する):
//     docker compose cp ../scripts booking:/app/booking/ && docker compose exec -T booking node scripts/http-first-measure.mjs [--person A] [--park 1040] [--date YYYY-MM-DD] [--start 9]
//     既定: 予約者 A・猿江(1040)・今日から 14 日後・9 時。枠が空いていなくても選択までは進む(サーバーは「予約」送信まで空きを検証しない)
//
// 本番のブラウザ・プロファイルには触らない(playwright を読み込まない)。ログインを 1 回するので、続けて何度も回さない。
// 利用者番号・パスワード・Cookie は表示しない。
// ============================================================
import { createHttpSession } from '../src/site-http.js';
import { inPageFlow, prefetchInPage } from '../src/site-inpage.js';

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
const inner = createHttpSession({ fetchImpl: realFetch });
// 失敗したときに「何が返ってきたか」を出すため、最後の応答を控える(中身は表示しない。画面 ID・題名・長さ・公園の hidden だけ)
let last = null;
const session = {
  ...inner,
  fetch: async (path, init) => {
    const res = await inner.fetch(path, init);
    const buf = await res.arrayBuffer();
    last = { path, status: res.status, html: new TextDecoder('shift_jis').decode(buf) };
    return res;
  },
};
const describeLast = () => {
  if (!last) return '(応答なし)';
  const h = last.html;
  const pick = (name) => (h.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`)) || [])[1];
  const title = (h.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/\s+/g, ' ').trim();
  const alert = (h.match(/(?:showAlert|errorMsg)\s*[(=]\s*["']([^"']{1,100})/) || [])[1];
  return `${last.path.replace('/web/', '')} HTTP ${last.status} 長さ ${h.length} 画面 ${(h.slice(0, 500).match(/<!-- (\w+\.jsp) -->/) || [])[1] || '不明'} 題名「${title || ''}」 selectBldCd=${pick('selectBldCd') ?? '(無し)'} selectAreaBcd=${pick('selectAreaBcd') ?? '(無し)'} selectInstCd=${pick('selectInstCd') ?? '(無し)'} daystart=${pick('daystart') ?? '(無し)'}${alert ? ` 文言「${alert}」` : ''}`;
};
const usePrefetch = !argv.includes('--no-prefetch');
let loggedIn = false;
let result;
let prefetchMs = null;
try {
  // inPageFlow / prefetchInPage はブラウザ用で、その場の fetch を使う。ここでは Cookie を持ち回る自前の通信に差し替えて Node で動かす
  // (inner は差し替える前の本物の fetch を掴んでいる。本番の予約処理が通るコードは変えない)
  globalThis.fetch = session.fetch;
  const top = await session.fetch('/web/index.jsp');
  if (top.status !== 200 || !/rsvWTransUserLoginAction/i.test(last.html)) throw new Error(`トップページが想定外です (HTTP ${top.status})`);
  let prefetched = null;
  if (usePrefetch) {
    const p = await prefetchInPage({ parks: [slot.park], date: jstDate(Date.now()) });
    if (!p.ok || !p.searches[slot.park]) throw new Error(`先取りに失敗: ${p.message || '検索結果が取れない'}`);
    prefetched = p;
    prefetchMs = Date.now() - started;
  }
  result = await inPageFlow({ slot, credentials, withList: true, prefetched });
  loggedIn = inner.steps().some((s) => s.path === 'rsvWUserAttestationLoginAction');
} catch (e) {
  loggedIn = inner.steps().some((s) => s.path === 'rsvWUserAttestationLoginAction');
  result = { ok: false, status: 'error', message: e.message };
}
const failedAt = result.ok ? null : describeLast();
const flowMs = Date.now() - started;
if (loggedIn) {
  try {
    await inner.fetch('/web/rsvWTransUserAttestationEndAction.do', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'displayNo=prwha1000&displayNoFrm=prwha1000' });
  } catch (e) {
    console.log(`ログアウト失敗(放置で 10 分後に切れます): ${e.message}`);
  }
}
const NAMES = { index: 'トップ', rsvWTransUserLoginAction: 'ログイン画面', rsvWUserAttestationLoginAction: 'ログイン', rsvWOpeInstSrchVacantAction: '検索', rsvWOpeInstReservAjaxAction: '枠の選択', rsvWGetCancelRsvDataAction: '予約一覧', rsvWTransUserAttestationEndAction: 'ログアウト' };
for (const s of inner.steps()) console.log(`  ${(NAMES[s.path] || s.path).padEnd(8, ' ')} ${(s.ms / 1000).toFixed(1)} 秒`);
if (result.ok) {
  console.log(`結果: 枠の選択まで成功(${result.facility})。${prefetchMs == null ? `トップ〜予約一覧の合計 ${(flowMs / 1000).toFixed(1)} 秒` : `前もって済ませる分 ${(prefetchMs / 1000).toFixed(1)} 秒 + 空きが出てからの分(ログイン・枠の選択・予約一覧) ${((flowMs - prefetchMs) / 1000).toFixed(1)} 秒`}`);
} else {
  console.log(`結果: ${result.status} ${result.message}(${(flowMs / 1000).toFixed(1)} 秒)`);
  console.log(`  最後の応答: ${failedAt}`);
}
process.exit(result.ok ? 0 : 1);
