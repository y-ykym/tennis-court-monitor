#!/usr/bin/env node
// ============================================================
// 「予約に使うセッションで検索をしなくても、確認画面まで進めるか」を 1 回だけ確かめる。**ブラウザは使わない。「予約」は押さない。**
//   検索結果の hidden は別のセッションで取ったものを使う(匿名の確認では、hidden はセッションに依らず完全に同じだった。
//   docs/site-notes.md「追加調査 2026-11-21」4.)。通れば、先起こしのブラウザの先取りは「ログイン画面 1 往復」だけにできる。
//
//   セッション X(匿名): トップ → 検索(公園)             ← 検索結果の hidden を取るだけ
//   セッション Y(本人): トップ → ログイン画面 → ログイン → 枠の選択 → 確認画面へ POST(X の hidden を使う。Y では検索しない)
//   確認画面(prwea1000)に着いたら「キャンセル」と同じ通信で戻り、ログアウトする。
//   着かなかったら、同じログインのまま Y でも検索してからもう一度送り、原因が「検索していないこと」かを切り分ける。
//
//   Pi で(booking/pc から):
//     docker compose cp ../scripts booking:/app/booking/ && docker compose exec -T booking node scripts/no-search-measure.mjs [--person A] [--park 1040]
//
// 確認画面は HTML を受け取るだけで、JS も reCAPTCHA も動かさない。確認画面までは仮押さえにならない。本番のブラウザ・プロファイルには触らない。
// ログインを 1 回するので、続けて何度も回さない。利用者番号・パスワード・Cookie・画面の中身(氏名など)は表示しない。
// ============================================================
import { createHttpSession } from '../src/site-http.js';
import { inPageFlow, prefetchInPage } from '../src/site-inpage.js';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const person = opt('person', 'A') === 'B' ? 'B' : 'A';
const park = opt('park', '1040');
const credentials = { userId: process.env[`SITE_USER_${person}`], password: process.env[`SITE_PASS_${person}`] };
if (!credentials.userId || !credentials.password) {
  console.error(`SITE_USER_${person} / SITE_PASS_${person} が未設定です(booking コンテナの中で実行してください)`);
  process.exit(1);
}
const jstDate = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
const slot = { park, date: jstDate(Date.now() + 12 * 86400 * 1000), startHour: 9, vacant: 1, tzoneNo: '10' };
const dec = new TextDecoder('shift_jis');
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const pageId = (html) => (html.slice(0, 3000).match(/<!-- (\w+\.jsp) -->/) || [])[1] || null;

// ブラウザの form 送信と同じく Shift_JIS で % エンコードする(Node には Shift_JIS のエンコーダが無いので、デコーダから逆引き表を作る)
const sjisTable = new Map();
for (let hi = 0x81; hi <= 0xfc; hi++) {
  if (hi > 0x9f && hi < 0xe0) continue;
  for (let lo = 0x40; lo <= 0xfc; lo++) {
    if (lo === 0x7f) continue;
    const ch = dec.decode(new Uint8Array([hi, lo]));
    if (ch.length === 1 && ch !== '�' && !sjisTable.has(ch)) sjisTable.set(ch, [hi, lo]);
  }
}
for (let b = 0xa1; b <= 0xdf; b++) sjisTable.set(dec.decode(new Uint8Array([b])), [b]); // 半角カナ
const pct = (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
function encSjis(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out += /[A-Za-z0-9*\-._]/.test(ch) ? ch : ch === ' ' ? '+' : pct(c);
    else out += (sjisTable.get(ch) || [0x3f]).map(pct).join('');
  }
  return out;
}
const formBody = (fields) => Object.entries(fields).map(([k, v]) => `${encSjis(k)}=${encSjis(v)}`).join('&');
function hiddenFields(html) {
  const out = {};
  for (const tag of html.match(/<input[^>]*type="hidden"[^>]*>/g) || []) {
    const name = (tag.match(/name="([^"]*)"/) || [])[1];
    if (name) out[name] = ((tag.match(/value="([^"]*)"/) || [])[1] ?? '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  return out;
}

const realFetch = globalThis.fetch;
const X = createHttpSession({ fetchImpl: realFetch, timeoutMs: 30000 });
const Y = createHttpSession({ fetchImpl: realFetch, timeoutMs: 30000 });
async function post(session, label, path, fields) {
  const t = Date.now();
  const res = await session.fetch(path, { method: 'POST', headers: FORM, body: formBody(fields) });
  const html = dec.decode(await res.arrayBuffer());
  console.log(`  ${label}: ${((Date.now() - t) / 1000).toFixed(1)} 秒 HTTP ${res.status} 長さ ${html.length} 画面 ${pageId(html) || '(なし)'}`);
  return { status: res.status, html, id: pageId(html) };
}

console.log(`確認: 検索していないセッションで確認画面まで進めるか(予約者 ${person}・公園 ${park}・${slot.date} 9 時。「予約」は押しません) ${new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
let loggedIn = false;
let verdict = '';
try {
  // X: 検索結果の hidden を取るだけ(匿名)
  globalThis.fetch = X.fetch;
  await X.fetch('/web/index.jsp');
  const p = await prefetchInPage({ parks: [park], date: jstDate(Date.now()) });
  const search = p.searches?.[park];
  if (!search) throw new Error(`別セッションでの検索に失敗: ${p.message || '不明'}`);
  console.log(`  別セッション X: 検索結果を取得(hidden ${Object.keys(search.fields).length} 個)`);

  // Y: 検索せずに ログイン画面 → ログイン → 枠の選択(本番と同じ inPageFlow。検索は X のものを「先取り済み」として渡す)
  globalThis.fetch = Y.fetch;
  await Y.fetch('/web/index.jsp');
  const started = Date.now();
  const r = await inPageFlow({ slot, credentials, withList: false, prefetched: { loginFields: null, loginRecaptcha: false, search: null, searches: { [park]: search } } });
  loggedIn = Y.steps().some((s) => s.path === 'rsvWUserAttestationLoginAction');
  console.log(`  セッション Y の通信: ${Y.steps().map((s) => `${s.path}(${(s.ms / 1000).toFixed(1)} 秒)`).join(' → ')}`);
  if (!r.ok) throw new Error(`枠の選択まで進めませんでした: ${r.status} ${r.message}`);
  if (Y.steps().some((s) => s.path === 'rsvWOpeInstSrchVacantAction')) throw new Error('想定外: セッション Y が検索をしています');
  const confirm = await post(Y, '確認画面へ POST(検索なし)', '/web/rsvWOpeReservedApplyAction.do', r.applyFields);
  if (confirm.id === 'prwea1000.jsp') {
    const md = `${Number(slot.date.slice(5, 7))}月${Number(slot.date.slice(8, 10))}日`;
    verdict = `通りました: 検索していないセッションで確認画面(prwea1000)に到達。ログインから ${((Date.now() - started) / 1000).toFixed(1)} 秒。` +
      `日付の表示 ${confirm.html.includes(md) ? 'あり' : 'なし'}・予約ボタン ${/id="btn-go"/.test(confirm.html) ? 'あり' : 'なし'}`;
    const back = await post(Y, '確認画面から戻る', '/web/rsvWOpeReservedApplyBackAction.do', hiddenFields(confirm.html));
    verdict += `。戻った先 ${back.id || '(なし)'}`;
  } else {
    // 切り分け: 同じログインのまま Y でも検索してから、Y 自身の hidden でもう一度送る(枠の選択はセッションに残っている)
    const week = await post(Y, '切り分け: Y でも検索', '/web/rsvWOpeInstSrchVacantAction.do', {
      displayNo: 'pawab2000', daystarthome: slot.date, daystart: slot.date, selectPpsClPpscd: '1000_1030', selectPpsClsCd: '1000', selectPpsCd: '1030',
      selectAreaBcd: park, selectBldCd: '', selectIcd: '0', dayofweekClearFlg: '1', timezoneClearFlg: '1',
    });
    const again = await post(Y, '切り分け: 確認画面へ POST(検索あり)', '/web/rsvWOpeReservedApplyAction.do', { ...hiddenFields(week.html), daystart: slot.date, applyFlg: '1', selectSize: r.applyFields.selectSize });
    if (again.id === 'prwea1000.jsp') {
      verdict = `通りませんでした: 検索なしでは ${confirm.id || '(画面 ID なし・長さ ' + confirm.html.length + ')'}、同じセッションで検索してからなら確認画面に到達。検索は予約に使うセッションで必要`;
      await post(Y, '確認画面から戻る', '/web/rsvWOpeReservedApplyBackAction.do', hiddenFields(again.html));
    } else {
      verdict = `判定できず: 検索なし ${confirm.id || '(なし)'}・検索あり ${again.id || '(なし)'}(この試し方では検索ありでも確認画面に着かない)`;
    }
  }
} catch (e) {
  loggedIn = loggedIn || Y.steps().some((s) => s.path === 'rsvWUserAttestationLoginAction');
  verdict = `中断: ${e.message}`;
}
if (loggedIn) {
  try {
    await post(Y, 'ログアウト', '/web/rsvWTransUserAttestationEndAction.do', { displayNo: 'prwha1000', displayNoFrm: 'prwha1000' });
  } catch (e) {
    console.log(`ログアウト失敗(放置で 10 分後に切れます): ${e.message}`);
  }
}
console.log(`結果: ${verdict}`);
