#!/usr/bin/env node
// ============================================================
// 「一覧の予約ボタン → ログイン → 確認画面」の導線が通るかを 1 回だけ確かめる。**ブラウザは使わない。「予約」は押さない。**
//   今の本番: ログイン → 枠の選択 → 確認画面へ POST(3 往復)
//   この導線: (匿名で)一覧の「予約」を送る → ログイン画面が返る → ログイン(2 往復)。ログインの応答が確認画面になるかを見る
//   docs/site-notes.md「追加調査 2026-11-21」。匿名の部分(ログイン画面が返るところ)までは同日に確認済み
//
//   Pi で(booking/pc から。scripts はイメージに入れていないので、動いているコンテナに置いてから実行する):
//     docker compose cp ../scripts booking:/app/booking/ && docker compose exec -T booking node scripts/list-apply-measure.mjs [--person A] [--park 1040] [--no-daily]
//     既定: 予約者 A・猿江(1040)。一覧から「今日 + 5 日以降で予約ボタンのある最初の枠」を選ぶ
//     --no-daily: 一覧画面(rsvWOpeUnreservedDailyAction)を開かず、トップの直後に予約を送る(往復をもう 1 つ減らせるかの確認。匿名の部分だけで止めるには --anon-only)
//     --anon-only: ログインしない(ログイン画面が返るかだけを見る)
//
// 確認画面に着いたら「キャンセル」と同じ通信(rsvWOpeReservedApplyBackAction)で戻り、ログアウトする。確認画面までは仮押さえにならない。
// 確認画面は HTML を受け取るだけで、JS も reCAPTCHA も動かさない。本番のブラウザ・プロファイルには触らない。
// ログインを 1 回するので、続けて何度も回さない。利用者番号・パスワード・Cookie・画面の中身(氏名など)は表示しない。
// ============================================================
import { createHttpSession } from '../src/site-http.js';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const person = opt('person', 'A') === 'B' ? 'B' : 'A';
const park = opt('park', '1040');
const useDaily = !argv.includes('--no-daily');
const anonOnly = argv.includes('--anon-only');
const credentials = { userId: process.env[`SITE_USER_${person}`], password: process.env[`SITE_PASS_${person}`] };
if (!anonOnly && (!credentials.userId || !credentials.password)) {
  console.error(`SITE_USER_${person} / SITE_PASS_${person} が未設定です(booking コンテナの中で実行してください)`);
  process.exit(1);
}
const jstDate = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
const dec = new TextDecoder('shift_jis');
const session = createHttpSession({ timeoutMs: 30000 });
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const pageId = (html) => (html.slice(0, 3000).match(/<!-- (\w+\.jsp) -->/) || [])[1] || null;
// hidden 一式。日本語の値(画面の文言)は送らない(URLSearchParams は UTF-8 で送るので、Shift_JIS のサイトでは文字化けするだけ)
function hiddenFields(html) {
  const out = {};
  for (const tag of html.match(/<input[^>]*type="hidden"[^>]*>/g) || []) {
    const name = (tag.match(/name="([^"]*)"/) || [])[1];
    const value = (tag.match(/value="([^"]*)"/) || [])[1] ?? '';
    if (name && /^[\x20-\x7e]*$/.test(value)) out[name] = value;
  }
  return out;
}
const log = [];
async function call(label, path, form) {
  const t = Date.now();
  const body = form ? (form instanceof URLSearchParams ? form.toString() : new URLSearchParams(form).toString()) : undefined;
  const res = await session.fetch(path, form ? { method: 'POST', headers: FORM, body } : {});
  const html = dec.decode(await res.arrayBuffer());
  const id = pageId(html);
  const line = `  ${label}: ${((Date.now() - t) / 1000).toFixed(1)} 秒 HTTP ${res.status} 長さ ${html.length} 画面 ${id || '(なし)'}`;
  log.push(line);
  console.log(line);
  return { status: res.status, html, id };
}

console.log(`確認: 一覧の予約ボタン → ログイン → 確認画面(予約者 ${person}・公園 ${park}。${anonOnly ? 'ログインしません' : '「予約」は押しません'}) ${new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
const today = jstDate(Date.now());
let loggedIn = false;
let verdict = '';
try {
  const top = await call('トップ', '/web/index.jsp');
  if (top.id !== 'pawab2000.jsp') throw new Error('トップページが想定外です');
  let hidden = hiddenFields(top.html);
  if (useDaily) {
    const daily = await call('一覧画面', '/web/rsvWOpeUnreservedDailyAction.do', {
      displayNo: 'pawab2000', displayNoFrm: 'pawab2000', selectPpsClPpscd: '1000_1030', selectAreaBcd: park, selectIcd: '0',
      dayofweekClearFlg: '1', timezoneClearFlg: '1', daystart: today, days: '31', selectPpsClsCd: '0', selectPpsCd: '0', selectBldCd: '', penaltyday: '',
    });
    if (daily.id !== 'prwrc1000.jsp') throw new Error('一覧画面が想定外です');
    hidden = hiddenFields(daily.html);
  }
  const list = await call('一覧データ', '/web/rsvWOpeUnreservedSearchAjaxAction.do', {
    date: '3', timezoneClearFlg: '1', displayNo: 'pawab2000', offset: '0', dayofweekClearFlg: '1', daystart: today, selectPpsClPpscd: '1000_1030',
    limit: '50', days: '31', selectIcd: '0', selectAreaBcd: park,
  });
  const json = JSON.parse(list.html);
  const minYmd = Number(jstDate(Date.now() + 5 * 86400 * 1000).replace(/-/g, ''));
  const row = (json.results || []).find((r) => Number(r.mediaFlg) === 3 && Number(r.useYmd) >= minYmd && String(r.bcd) === park);
  if (!row) throw new Error(`今日 + 5 日以降で予約ボタンのある枠が一覧にありません(全 ${json.all} 件)`);
  console.log(`  選んだ枠: ${row.useYmd} ${row.sTime}-${row.eTime} 公園 ${row.bcd} 空き ${row.fieldCnt} 面`);

  // doReserved(prwrf1000.js)と同じ送信内容
  const form = new URLSearchParams({
    ...hidden,
    selectUseYmd: String(row.useYmd), selectBldCd: String(row.bcd), selectInstCd: String(row.icd), selectPpsCd: String(row.ppsCd), selectPpsClsCd: String(row.ppsClsCd),
    selectStimeZoneNo: String(row.tZoneNo), selectEtimeZoneNo: String(row.tZoneNo), selectStime: String(row.sTime), selectEtime: String(row.eTime),
    selectEventName: '', selectApplyNum: '', fieldCnt: String(row.fieldCnt), displayNo: 'prwrc1000',
  });
  for (const v of String(row.timeZoneNos ?? row.tZoneNo).split('|')) form.append('availableTZoneNo', v);
  for (const v of String(row.sTimeZones ?? row.sTime).split('|')) form.append('availableSTime', v);
  for (const v of String(row.eTimeZones ?? row.eTime).split('|')) form.append('availableETime', v);
  const applyStarted = Date.now();
  const apply = await call('予約を送る(匿名)', '/web/rsvWOpeReservedApplyAction.do', form);
  if (apply.id !== 'pawab2100.jsp') throw new Error('ログイン画面が返りませんでした(この送り方では受け付けられない)');
  const loginFields = hiddenFields(apply.html);
  if (!loginFields.loginJKey) throw new Error('ログイン画面に loginJKey がありません');
  if (/gRecaptchaActive\s*=\s*true/.test(apply.html)) throw new Error('ログイン画面で reCAPTCHA が有効のため、ここで止めます');
  if (anonOnly) {
    verdict = 'ログイン画面が返りました(匿名の部分は通る)。ログインはしていません';
  } else {
    const lf = new URLSearchParams(loginFields);
    lf.set('userId', credentials.userId);
    lf.set('password', credentials.password);
    for (const ch of credentials.password) lf.append('loginCharPass', ch);
    const home = await call('ログイン', '/web/rsvWUserAttestationLoginAction.do', lf);
    if (home.status >= 300 || home.id === 'pawab2100.jsp') throw new Error('ログインが受け付けられませんでした(以後は何もしません)');
    loggedIn = true;
    const toConfirmMs = Date.now() - applyStarted;
    if (home.id === 'prwea1000.jsp') {
      const ymd = String(row.useYmd);
      const dateOk = home.html.includes(`${Number(ymd.slice(4, 6))}月${Number(ymd.slice(6, 8))}日`);
      const names = Object.keys(hiddenFields(home.html));
      verdict = `通りました: ログインの応答がそのまま確認画面(prwea1000)。予約を送ってから ${(toConfirmMs / 1000).toFixed(1)} 秒(2 往復)。` +
        `選んだ日付の表示 ${dateOk ? 'あり' : 'なし'}・予約ボタン ${/id="btn-go"/.test(home.html) ? 'あり' : 'なし'}・reCAPTCHA の読み込み ${/recaptcha/i.test(home.html) ? 'あり' : 'なし'}・hidden ${names.length} 個`;
      const back = await call('確認画面から戻る', '/web/rsvWOpeReservedApplyBackAction.do', hiddenFields(home.html));
      verdict += `。戻った先 ${back.id || '(なし)'}`;
    } else {
      verdict = `通りませんでした: ログインの応答は ${home.id || '(画面 ID なし)'}(確認画面ではない)。予約は送っていません`;
    }
  }
} catch (e) {
  loggedIn = loggedIn || session.steps().some((s) => s.path === 'rsvWUserAttestationLoginAction');
  verdict = `中断: ${e.message}`;
}
if (loggedIn) {
  try {
    await call('ログアウト', '/web/rsvWTransUserAttestationEndAction.do', { displayNo: 'prwha1000', displayNoFrm: 'prwha1000' });
  } catch (e) {
    console.log(`ログアウト失敗(放置で 10 分後に切れます): ${e.message}`);
  }
}
console.log(`結果: ${verdict}`);
