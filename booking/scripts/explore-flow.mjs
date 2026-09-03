#!/usr/bin/env node
// ============================================================
// フェーズ2 調査用: 予約フローを「予約直前の画面」まで進めて、そこで止まるスクリプト。
//
//   - ログインは本人が行う(このスクリプトはパスワードを扱わない。画面に出たログイン欄に
//     自分で入力する)。ログイン完了を検知したら以降を自動で進める
//   - 進める範囲: 空き検索 → 対象枠(セル)の選択 → 「予約する」ボタン → 次の画面が出たら停止
//   - **確定・申込み・支払いのボタンは絶対に押さない**(押すのは人間。このスクリプトは
//     「予約する」の次に出た画面の HTML・スクリーンショットを保存するだけ)
//   - 停止後は Enter で「ログアウト」して終了する(選択状態を残さない)
//   - 各画面の HTML/PNG は booking/.explore/(gitignore済み)に保存。個人情報を含むので共有しない
//
// 使い方(リポジトリの booking/ で):
//   node scripts/explore-flow.mjs --park 1040 --date 2026-09-10 --start 13
//     --park  公園コード(猿江=1040 / 亀戸=1050 / 大島小松川=1160)
//     --date  利用日 YYYY-MM-DD(ペナルティ確認ダイアログを避けるため4日以上先を推奨)
//     --start 開始時刻(9/11/13/15/17/19)。空きが多い枠を選ぶ(調査中に他人が取っても影響が少ない)
//     --stop-at select   「予約する」を押さず、セル選択で止める(段階的に調べるとき)
//     --through          通しモード(2026-09-03 ユーザー指示で方針変更: スクリプトが「予約」と確認OKまで押す)。
//                        予約内容確認画面で種目・人数を入力 → 「予約」クリック → 確認ダイアログ OK → 結果画面を保存。
//                        目に見える reCAPTCHA(チェックボックス/画像選択)が出た場合だけ人間がブラウザで解く。
//                        成立した予約はテスト用なので、続けて表示する「予約の確認」画面から人間がキャンセルする
//                        (テニスは利用日の4日前までならペナルティ無し。--date は十分先の日付にする)
//     --people 2         通しモードで入力する利用人数(既定 2)
// ============================================================
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'https://kouen.sports.metro.tokyo.lg.jp';
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.explore');
// 開始時刻(時) → セルidの時間帯インデックス(td#YYYYMMDD_NN の NN)
const HOUR_TO_TZ = { 9: '10', 11: '20', 13: '30', 15: '40', 17: '50', 19: '60' };
// ログイン済み画面にだけある「ログアウト」リンク(ドロップダウン内の <a href="javascript:doAction(...)">。
// 表示状態に関係なく DOM にあるかで判定する)
const LOGOUT_SELECTOR = '[href*="gRsvWTransUserAttestationEndAction"], [onclick*="gRsvWTransUserAttestationEndAction"]';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? ''] : null)).filter(Boolean)
);
const park = args.park || '1040';
const date = args.date;
const startHour = Number(args.start || 13);
const stopAt = args['stop-at'] || 'apply';
const through = process.argv.includes('--through');
const people = String(args.people || '2');
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !HOUR_TO_TZ[startHour]) {
  console.error('使い方: node scripts/explore-flow.mjs --park 1040 --date YYYY-MM-DD --start 9|11|13|15|17|19');
  process.exit(1);
}
const ymd = date.replace(/-/g, '');
const cellId = `${ymd}_${HOUR_TO_TZ[startHour]}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const log = (m) => console.log(`[${new Date().toLocaleTimeString('ja-JP')}] ${m}`);

// 画面種別(<!-- xxx.jsp --> コメント)
async function pageId(page) {
  const html = await page.content();
  return html.slice(0, 500).match(/<!-- (\w+\.jsp) -->/)?.[1] ?? '(不明)';
}

// 画面を保存(HTML + スクショ)し、概要をコンソールに出す
async function snapshot(page, label) {
  const id = await pageId(page);
  const html = await page.content();
  const base = path.join(OUT_DIR, `${stamp}-${label}-${id.replace('.jsp', '')}`);
  fs.writeFileSync(`${base}.html`, html);
  await page.screenshot({ path: `${base}.png`, fullPage: true });
  const recaptcha = /gRecaptchaActive\s*=\s*(true|false)/.exec(html)?.[1] ?? (/recaptcha/i.test(html) ? 'あり(変数なし)' : 'なし');
  const buttons = await page.$$eval('button, input[type=submit], input[type=button], a[onclick]', (els) =>
    els
      .filter((e) => e.offsetParent !== null)
      .map((e) => `${(e.textContent || e.value || '').replace(/\s+/g, ' ').trim().slice(0, 20)} → ${(e.getAttribute('onclick') || '').slice(0, 80)}`)
      .filter((s) => !s.startsWith(' →'))
  );
  log(`--- [${label}] 画面=${id} title=${await page.title()}`);
  log(`    reCAPTCHA: ${recaptcha}`);
  log(`    表示中のボタン/リンク:`);
  for (const b of buttons.slice(0, 40)) log(`      ${b}`);
  log(`    保存: ${base}.html / .png`);
  return { id, html };
}

// 匿名セッションで対象枠の空き面数を取る(選択・申込みで「仮押さえ」されるかの確認用)
async function vacantCount() {
  try {
    const jar = new Map();
    const req = async (p, form) => {
      const h = { 'user-agent': 'Mozilla/5.0' };
      if (form) h['content-type'] = 'application/x-www-form-urlencoded';
      if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const r = await fetch(BASE_URL + p, { method: form ? 'POST' : 'GET', headers: h, body: form ? new URLSearchParams(form).toString() : undefined });
      for (const sc of r.headers.getSetCookie()) {
        const pair = sc.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      return new TextDecoder('shift_jis').decode(await r.arrayBuffer());
    };
    await req('/web/index.jsp');
    const s = await req('/web/rsvWOpeInstSrchVacantAction.do', {
      displayNo: 'pawab2000', daystarthome: date, daystart: date, selectPpsClPpscd: '1000_1030', selectPpsClsCd: '1000',
      selectPpsCd: '1030', selectAreaBcd: park, selectBldCd: '', selectIcd: '0', dayofweekClearFlg: '1', timezoneClearFlg: '1',
    });
    const instCd = s.match(/name="selectInstCd"[^>]*value="([^"]*)"/)?.[1];
    const json = JSON.parse(
      await req('/web/rsvWOpeInstSrchVacantAjaxAction.do', { displayNo: 'prwrc2000', useDay: ymd, bldCd: park, instCd, transVacantMode: '0', clearFlag: '0' })
    );
    for (const row of json.result || []) {
      for (const c of row.timeResult || []) {
        if (String(c.useDay) === ymd && Number(c.startTime) === startHour * 100) return `${c.alt} ${c.rsvNum}面`;
      }
    }
    return '(該当セルなし)';
  } catch (e) {
    return `(取得失敗: ${e.message})`;
  }
}

const waitEnter = (msg) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, () => {
      rl.close();
      resolve();
    });
  });

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
// confirm/alert は内容をログに出して、必ず「キャンセル」側で閉じる(ペナルティ確認等で先に進まない)
// 通しモードでは「予約申込処理を行います」の確認ダイアログだけ OK を返す(それ以外は常にキャンセル)
page.on('dialog', async (d) => {
  if (through && d.type() === 'confirm' && /予約申込処理を行います/.test(d.message())) {
    log(`確認ダイアログ: ${d.message()} → OK を返します`);
    await d.accept().catch(() => {});
    return;
  }
  log(`ダイアログ(${d.type()}): ${d.message()} → キャンセルで閉じます`);
  await d.dismiss().catch(() => {});
});

try {
  // 1. トップ → ログイン画面(入力は本人)
  await page.goto(`${BASE_URL}/web/index.jsp`);
  await page.click('[onclick*="gRsvWTransUserLoginAction"]');
  await page.waitForSelector('input[name=userId]');
  log('ブラウザのログイン画面に、利用者番号とパスワードを入力してログインしてください(5分以内)');
  await page.waitForSelector(LOGOUT_SELECTOR, { state: 'attached', timeout: 5 * 60 * 1000 });
  log(`ログインを検知しました(画面=${await pageId(page)})。ここから自動で進めます`);
  await snapshot(page, '00-home');
  // ログイン直後に「東京都からのお知らせ」等のモーダルが出ることがある。開いていれば閉じる
  const closedModals = await page.evaluate(() => {
    const open = [...document.querySelectorAll('.modal.show')];
    for (const m of open) window.jQuery?.(m).modal('hide');
    return open.map((m) => m.id);
  });
  if (closedModals.length) {
    log(`モーダルを閉じました: ${closedModals.join(', ')}`);
    await page.waitForSelector('.modal-backdrop', { state: 'detached', timeout: 5000 }).catch(() => {});
  }

  // 2. 空き検索(ホームのフォーム。種目→公園の順で、同期先の hidden も揃うのを待つ)
  await page.fill('#daystart-home', date);
  await page.selectOption('#purpose-home', '1000_1030');
  await page.waitForFunction((code) => [...document.querySelectorAll('#bname-home option')].some((o) => o.value === code), park);
  await page.selectOption('#bname-home', park);
  await page.waitForFunction(
    (code) => document.querySelector('#bname')?.value === code && document.querySelector('#selectAreaBcd')?.value === code,
    park
  );
  log(`空き前(選択前)の対象枠: ${await vacantCount()}`);
  await Promise.all([page.waitForNavigation(), page.click('#btn-go')]);
  await page.waitForSelector(`#week-info td[id^="${ymd.slice(0, 6)}"]`, { timeout: 30000 });
  await snapshot(page, '01-week');

  // 3. 対象セルを選択(ログイン済みなので setReserv → Ajax で「選択中」になる)
  // id が数字始まりなので `#...` の CSS セレクタは使えない([id="..."] で指定する)
  const cell = await page.$(`[id="${cellId}"]`);
  if (!cell) throw new Error(`対象セル #${cellId} が週表示にありません(表示週が違う?)`);
  const before = await page.$eval(`[id="A_${cellId}"]`, (e) => e.value).catch(() => null);
  if (before === null) throw new Error(`#${cellId} は空きセルではありません(空き面数 hidden なし)`);
  log(`対象セル #${cellId}: 空き ${before}面 → クリックして選択します`);
  await cell.click();
  await page.waitForFunction((id) => document.getElementById(`S_${id}`)?.value === '1', cellId, { timeout: 15000 });
  log(`選択完了(S_=1, selectSize=${await page.$eval('input[name=selectSize]', (e) => e.value)})`);
  log(`選択後の対象枠(別セッションから見た空き): ${await vacantCount()}`);
  const sel = await snapshot(page, '02-selected');
  if (stopAt === 'select') {
    log('--stop-at select のためここで停止します');
  } else {
    // 4. 「予約する」(checkSelect → rsvWOpeReservedApplyAction)。次の画面で止まる
    const applyBtn = await page.$('[onclick*="checkSelect"]');
    if (!applyBtn) {
      log('「予約する」(checkSelect) ボタンが見つかりません。02-selected の HTML を確認してください');
    } else {
      log(`「予約する」を押します: ${await applyBtn.evaluate((e) => e.textContent.trim())}`);
      await Promise.all([page.waitForNavigation({ timeout: 30000 }), applyBtn.click()]);
      await page.waitForLoadState('networkidle').catch(() => {});
      await snapshot(page, '03-apply');
      log(`申込画面に到達後の対象枠(別セッションから見た空き): ${await vacantCount()}`);
      if (!through) {
        log('★ ここで停止します。この先(確定・申込み)のボタンは押しません ★');
      } else {
        // 通しモード: 種目と人数だけ自動で埋める。「予約」ボタンと確認 OK は人間が押す
        if (!(await page.$eval('#purpose0', (e) => e.value).catch(() => ''))) {
          await page.selectOption('#purpose0', '1000_1030');
        }
        await page.fill('#peoples0', people);
        log(`人数 ${people} を入力しました。「予約」ボタンを押します(確認ダイアログには OK を返します)`);
        const nav = page.waitForNavigation({ timeout: 10 * 60 * 1000 }).then(() => 'navigated', () => 'timeout');
        await page.click('#btn-go');
        // 目に見える reCAPTCHA(v2 のチェックボックス/画像選択)が出たら人間に任せて、遷移を待ち続ける
        const challenge = page
          .waitForSelector('iframe[src*="recaptcha/api2/bframe"]', { state: 'visible', timeout: 8000 })
          .then(() => 'challenge', () => null);
        const first = await Promise.race([nav, challenge.then((c) => c || new Promise(() => {}))]);
        if (first === 'challenge') {
          log('★ reCAPTCHA のチャレンジが表示されました。ブラウザでチェック/画像選択を行ってください(10分以内)★');
        }
        const outcome = await nav;
        if (outcome === 'navigated') {
          await page.waitForLoadState('networkidle').catch(() => {});
          const res = await snapshot(page, '04-result');
          const text = res.html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
          const hit = text.match(/.{0,60}(予約番号|完了|受付|reCAPTCHA|エラー|失敗|認証).{0,80}/g) || [];
          for (const h of hit.slice(0, 8)) log(`    本文: ${h.trim()}`);
          log(`結果画面到達後の対象枠(別セッションから見た空き): ${await vacantCount()}`);
          // テスト予約をすぐ取り消せるよう「予約の確認」画面を開いておく(キャンセルは人間が押す)
          await Promise.all([
            page.waitForNavigation({ timeout: 30000 }).catch(() => {}),
            page.evaluate(() => {
              document.form1.action = gRsvWGetCancelRsvDataAction;
              document.form1.submit();
            }),
          ]);
          await snapshot(page, '05-reservations');
          log('★ 「予約の確認」画面を表示しました。テスト予約をブラウザで「キャンセル」してください(ペナルティ期間外か確認のうえ)★');
        } else {
          log('10分経過しても画面が遷移しませんでした(予約は成立していない可能性が高い。「予約の確認」で要確認)');
        }
      }
    }
  }
  void sel;
  await waitEnter('画面を確認したら Enter を押してください(ログアウトして終了します)… ');
} catch (e) {
  log(`エラー: ${e.message}`);
  await snapshot(page, '99-error').catch(() => {});
  await waitEnter('Enter でログアウトして終了します… ');
} finally {
  try {
    const logout = await page.$(LOGOUT_SELECTOR);
    if (logout) {
      // ドロップダウン内で隠れていることがあるので、クリックではなくページの doAction を直接呼ぶ
      await Promise.all([
        page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
        // サイトの doAction() は submit 後に procStart() を呼んで ReferenceError になる画面があるため、submit だけ行う
        page.evaluate(() => {
          document.form1.action = gRsvWTransUserAttestationEndAction;
          document.form1.submit();
        }),
      ]);
      log(`ログアウトしました(画面=${await pageId(page)})`);
      log(`ログアウト後の対象枠(別セッションから見た空き): ${await vacantCount()}`);
    }
  } catch (e) {
    log(`ログアウト失敗(無視): ${e.message}`);
  }
  await browser.close();
}
