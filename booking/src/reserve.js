// ============================================================
// 予約実行: 予約サイトにログインし、指定した枠(公園・日付・開始時刻)を1件予約する。
//
//   reserve(slot, credentials, options) → Promise<Result>
//
//   slot        = { park: '1050', date: '2026-09-17', startHour: 15, people: 2 }
//   credentials = { userId, password }            利用者番号(8桁)とパスワード
//   options     = {
//     headless: true,        ブラウザを画面に出さない(既定)。ローカル確認では false にできる
//     dryRun: false,         true なら予約内容確認画面まで進んで「予約」を押さずに終わる
//     log: (msg) => {},      進行ログ(利用者番号・パスワード・Cookie は出さない)
//     debugDir: null,        失敗時にスクリーンショットと HTML を保存する場所(個人情報を含むので共有しない)
//     onChallenge: null,     自動確定用。「予約」を押した後に reCAPTCHA v2(チェック)が出たときだけ呼ばれ、人間の操作が終わるまで待つ関数
//     onConfirm: null,       半自動用。予約内容確認画面(人数入力後)で呼ばれ、人間の操作が終わるまで待つ関数。
//                            渡すと「予約」は押さない(人間が押す)。({ page, facility, dateLabel, slot, people })
//     fastInPage: false,     高速経路(ブラウザ内版・推奨)。トップを開いたブラウザの中で fetch によりログイン〜枠選択を行い、
//                            予約内容確認画面の POST まで進める(src/site-inpage.js)。UI 操作の待ちを省く
//     prepared: null,        高速経路(Node HTTP 版。src/site-http.js)。Cloud Run では通信の出口が分かれて失敗することがあるため非推奨
//     channel: undefined,    'chrome' で Google Chrome 安定版を使う(既定は環境変数 BROWSER_CHANNEL)。無ければ Chromium
//     userDataDir: null,     渡すとそのディレクトリをブラウザプロファイルとして使う(Cookie 等を持ち越す)
//     launchArgs: [],        Chromium の起動引数(例: ['--window-size=600,1000'])
//     viewport: {...}|null,  ページのビューポート。null でウィンドウに従う
//   }
//   Result = {
//     status: 'success' | 'dry_run' | 'abandoned' | 'taken' | 'duplicate' | 'rejected' | 'auth_error' | 'error',
//     message: string,                 人間向けの短い説明
//     reservationNo?, fee?, facility?, dateText?, timeText?,   成功時の内容(完了画面の表示そのまま)
//     elapsedMs: number,
//   }
//
//   status の意味:
//     success    完了画面(prwec1000)に到達し予約番号が取れた
//     dry_run    dryRun 指定で予約内容確認画面まで到達した(予約はしていない)
//     abandoned  onConfirm(半自動)で人間に渡したが、操作が完了しなかった(予約はされていない)
//     taken      対象セルが空きではなかった(先に取られた・保守日など)。やり直しても意味がない
//     duplicate  同じ日時に既に予約がある等、サイトが申込みを断った。やり直しても意味がない
//     rejected   reCAPTCHA の判定で申込みが拒否された。**やり直さない**(繰り返すのは回避行為になる)
//     auth_error ログインが拒否された(利用者番号・パスワード・カード期限)。やり直さない
//     error      一時的なサーバーエラー・想定外画面・タイムアウト。呼び出し側で1回だけやり直してよい
//
// 方式: Playwright(Chromium)でサイトの画面をそのまま操作する。
//   ログイン → お知らせモーダルを閉じる → 空き検索 → 対象セルを選択 → 「予約」 → 予約内容確認画面で
//   種目・人数を入力 → 「予約」 → 確認ダイアログ OK → 完了画面を解析 → ログアウト
//   reCAPTCHA v3 はサイトの JS が「予約」クリック時に自前でトークンを取る。ここでは一切触らない
//   (回避・偽装・再試行はしない。低スコアで拒否されたら rejected として人間に委ねる)。
//   画面構造・実機確認の記録は docs/site-notes.md「フェーズ2 追加調査」「予約フローの実機確認結果」。
// ============================================================
import { chromium } from 'playwright';
import { inPageFlow, submitApplyForm } from './site-inpage.js';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = 'https://kouen.sports.metro.tokyo.lg.jp';
// 開始時刻(時) → セル id(td#YYYYMMDD_NN)の時間帯インデックス NN
const HOUR_TO_TZ = { 9: '10', 11: '20', 13: '30', 15: '40', 17: '50', 19: '60' };
// 種目: テニス（人工芝）
const PURPOSE_VALUE = '1000_1030';
// ログイン済み画面にだけある「ログアウト」リンク(ドロップダウン内で非表示のこともあるので attached で判定)
const LOGOUT_SELECTOR = '[href*="gRsvWTransUserAttestationEndAction"], [onclick*="gRsvWTransUserAttestationEndAction"]';
// 1ステップの待ち時間上限
const STEP_TIMEOUT = 30000;
// 画面遷移は DOM ができた時点で次へ進む(既定の load 待ちだと外部スクリプト(reCAPTCHA・チャットボット)の
// 読み込み完了まで待ってしまい、1画面あたり十数秒遅くなる。必要な要素は個別に待つ)
// 「予約」確定後の遷移待ち(reCAPTCHA のトークン取得を含む)
const APPLY_TIMEOUT = 60000;

export class ReserveError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 画面種別(<!-- xxx.jsp --> コメント)
async function pageId(page) {
  const head = await page.evaluate(() => document.documentElement.outerHTML.slice(0, 500));
  return head.match(/<!-- (\w+\.jsp) -->/)?.[1] ?? null;
}

async function hidden(page, name) {
  return page.$eval(`input[name="${name}"]`, (e) => e.value).catch(() => null);
}

async function saveDebug(page, debugDir, label) {
  if (!debugDir || page.isClosed()) return;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const base = path.join(debugDir, `${stamp}-${label}`);
  // HTML を先に書く(スクショが失敗しても HTML は残す)
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    fs.writeFileSync(`${base}.html`, await page.content());
  } catch {
    /* 無視 */
  }
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true, timeout: 15000 });
  } catch {
    /* 無視 */
  }
}

// 予約内容確認画面で「目に見える reCAPTCHA(v2 チェックボックス)」が要求されているかを判定する。
// v3(バッジのみ)なら false。判定材料: 促し文「チェックを入れて…」、badge の外にある可視の anchor iframe、g-recaptcha 枠の可視化
async function recaptchaChallenge(page) {
  return page.evaluate(() => {
    const promptShown = /チェックを入れて/.test(document.body.innerText || '');
    let boxVisible = false;
    for (const f of document.querySelectorAll('iframe[src*="recaptcha/api2/anchor"]')) {
      if (f.closest('.grecaptcha-badge')) continue; // v3 のバッジは対象外
      const r = f.getBoundingClientRect();
      if (r.width > 10 && r.height > 10) boxVisible = true;
    }
    return { promptShown, boxVisible };
  });
}

// "2026-09-17" → { ymd: "20260917", label: "9月17日" }
function dateParts(date) {
  const [y, m, d] = date.split('-').map(Number);
  return { ymd: `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`, label: `${m}月${d}日` };
}

// 完了画面(prwec1000)の表を「項目名 → 値」に
async function parseResultTable(page) {
  return page.$$eval('table tr', (rows) => {
    const out = {};
    for (const r of rows) {
      const th = r.querySelector('th');
      const td = r.querySelector('td');
      if (th && td) out[th.textContent.trim()] = td.textContent.replace(/\s+/g, ' ').trim();
    }
    return out;
  });
}

export async function reserve(slot, credentials, options = {}) {
  const { headless = true, dryRun = false, log = () => {}, debugDir = null, onConfirm = null, prepared = null, fastInPage = false } = options;
  const started = Date.now();
  const done = (status, message, extra = {}) => ({ status, message, elapsedMs: Date.now() - started, ...extra });

  if (!credentials?.userId || !credentials?.password) return done('auth_error', '利用者番号またはパスワードが未設定です');
  const tz = HOUR_TO_TZ[Number(slot.startHour)];
  if (!tz || !/^\d{4}-\d{2}-\d{2}$/.test(slot.date || '') || !/^\d{4}$/.test(slot.park || '')) {
    return done('error', `枠の指定が不正です (${JSON.stringify(slot)})`);
  }
  const { ymd, label: dateLabel } = dateParts(slot.date);
  const cellId = `${ymd}_${tz}`;
  const people = String(slot.people || 2);

  // ブラウザ本体: BROWSER_CHANNEL=chrome なら Google Chrome 安定版(reCAPTCHA の判定が素の Chromium より穏やかになる見込み)。
  // 入っていない環境では Playwright 同梱の Chromium に戻す
  const channel = options.channel ?? process.env.BROWSER_CHANNEL ?? undefined;
  // 起動オプションは環境変数でも足せる(運用側の判断で設定する。値はここでは決めない):
  //   CHROME_ARGS         追加の起動引数(空白区切り)
  //   IGNORE_DEFAULT_ARGS Playwright 既定の起動引数から外すもの(空白区切り)
  const envArgs = (process.env.CHROME_ARGS || '').split(/\s+/).filter(Boolean);
  const ignoreDefaultArgs = (process.env.IGNORE_DEFAULT_ARGS || '').split(/\s+/).filter(Boolean);
  const launchBase = { headless, args: ['--lang=ja-JP', ...envArgs, ...(options.launchArgs || [])] };
  if (ignoreDefaultArgs.length) launchBase.ignoreDefaultArgs = ignoreDefaultArgs;
  const contextBase = {
    // viewport: null を渡すとウィンドウサイズに従う(noVNC で画面ごと配信するとき用)
    viewport: 'viewport' in options ? options.viewport : { width: 1000, height: 900 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  };
  // userDataDir を渡すとプロファイル(Cookie 等)を持ち越す永続コンテキストで起動する(src/profile-store.js で保存・復元)
  const launchWith = async (ch) => {
    if (options.userDataDir) {
      const ctx = await chromium.launchPersistentContext(options.userDataDir, { ...launchBase, ...contextBase, channel: ch || undefined });
      return { browser: ctx.browser(), context: ctx };
    }
    const br = await chromium.launch({ ...launchBase, channel: ch || undefined });
    return { browser: br, context: await br.newContext(contextBase) };
  };
  let browser;
  let context;
  try {
    ({ browser, context } = await launchWith(channel));
  } catch (e) {
    if (!channel) throw e;
    log(`${channel} を起動できないため同梱の Chromium を使います: ${e.message.split('\n')[0]}`);
    ({ browser, context } = await launchWith(undefined));
  }
  log(`ブラウザ: ${browser?.version?.() ?? '(persistent)'}${channel ? ` (channel=${channel})` : ''}${options.userDataDir ? ' プロファイル持ち越し' : ''}${envArgs.length || ignoreDefaultArgs.length ? ' 起動オプション指定あり' : ''}`);
  // サイトの静的ファイル配信が遅い(1ファイル3〜7秒)ため、予約に不要な画像・フォント・都のチャットボットは読み込まない。
  // サイト本体の JS と Google の reCAPTCHA はそのまま通す
  // ※reCAPTCHA(google.com / gstatic.com)の画像・フォントは止めない(画像選択のチャレンジが表示できなくなる)
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    const url = route.request().url();
    if (url.includes('chatbot.metro.tokyo.lg.jp')) return route.abort();
    const siteAsset = url.startsWith(BASE_URL) && ['image', 'font', 'media'].includes(type);
    return siteAsset ? route.abort() : route.continue();
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(STEP_TIMEOUT);

  // 人間らしい操作(reCAPTCHA v3 のスコア対策)。実際にマウスを動かして押し、入力に間を置くだけで、
  // ブラウザの正体やトークンの偽装はしない(検出回避ではなく、実際に自然に操作する)。
  // options.humanize=false で従来どおりの機械操作(速度比較用)
  const humanize = options.humanize !== false;
  const rand = (a, b) => a + Math.random() * (b - a);
  const pause = (a = 250, b = 700) => (humanize ? page.waitForTimeout(rand(a, b)) : Promise.resolve());
  async function humanClick(selector) {
    if (!humanize) return page.click(selector);
    const el = page.locator(selector).first();
    await el.scrollIntoViewIfNeeded().catch(() => {});
    const box = await el.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2 + rand(-6, 6), box.y + box.height / 2 + rand(-4, 4), { steps: Math.round(rand(6, 18)) });
    }
    await pause(150, 450);
    await el.click();
  }
  async function humanType(selector, text) {
    if (!humanize) return page.fill(selector, String(text));
    await humanClick(selector);
    for (const ch of String(text)) await page.keyboard.type(ch, { delay: rand(60, 160) });
  }

  // ダイアログの扱い:
  //   - 「予約申込処理を行います」(最終確認)   → OK(dryRun のときはここまで来ない)
  //   - 「…ペナルティが付与されますが…」(3日以内の枠を選んだときの注意) → OK(予約する意思は確定している)
  //   - それ以外(エラーの alert 等)           → 閉じて、文言を控えておく(結果の説明に使う)
  const alerts = [];
  page.on('dialog', async (d) => {
    const msg = d.message();
    if (d.type() === 'confirm' && (/予約申込処理を行います/.test(msg) || /ペナルティが付与されますが/.test(msg))) {
      log(`確認ダイアログ: ${msg} → OK`);
      await d.accept().catch(() => {});
      return;
    }
    alerts.push(msg);
    log(`ダイアログ(${d.type()}): ${msg} → 閉じる`);
    await d.dismiss().catch(() => {});
  });
  const lastAlert = () => alerts[alerts.length - 1] || '';

  let loggedIn = false;
  try {
    let facility = slot.park;
    if (fastInPage) {
      // 高速経路(ブラウザ内版): トップページを開き、その中で fetch によりログイン〜枠選択 → 確認画面へ POST
      const topRes = await page.goto(`${BASE_URL}/web/index.jsp`, { waitUntil: 'domcontentloaded' });
      if (!(await page.$('[onclick*="gRsvWTransUserLoginAction"]'))) {
        // 何を受け取ったかを残す(サイトの 502・メンテナンス・IP による応答差の切り分け用)
        const diag = await page
          .evaluate(() => `${document.title} | ${document.body?.innerText.replace(/\s+/g, ' ').slice(0, 160)}`)
          .catch(() => '(取得不可)');
        await saveDebug(page, debugDir, 'top-unexpected');
        throw new ReserveError('error', `トップページにログインボタンがありません (HTTP ${topRes?.status() ?? '?'}, ${await pageId(page)}: ${diag})`);
      }
      const r = await page.evaluate(inPageFlow, { slot: { park: slot.park, date: slot.date, startHour: Number(slot.startHour) }, credentials });
      if (!r.ok) throw new ReserveError(r.status, r.message);
      loggedIn = true;
      facility = r.facility || slot.park;
      log(`高速経路(ブラウザ内): 枠選択まで完了 空き${r.vacant}面 (${Date.now() - started}ms)`);
      await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.evaluate(submitApplyForm, r.applyFields)]);
      log(`高速経路(ブラウザ内): 予約内容確認画面へ POST (${Date.now() - started}ms)`);
    } else if (prepared) {
      // 高速経路: HTTP で作ったログイン済みセッションの Cookie を移植し、予約内容確認画面へ進む POST だけをブラウザで行う
      await context.addCookies(prepared.cookies);
      facility = prepared.facility || slot.park;
      loggedIn = true;
      const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      const inputs = Object.entries(prepared.applyFields)
        .map(([k, v]) => `<input type="hidden" name="${escAttr(k)}" value="${escAttr(v)}">`)
        .join('');
      await page.setContent(
        `<form id="f" method="post" action="${BASE_URL}/web/rsvWOpeReservedApplyAction.do" accept-charset="Shift_JIS">${inputs}</form>`
      );
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.evaluate(() => document.getElementById('f').submit()),
      ]);
      log(`高速経路: 予約内容確認画面へ POST (${Date.now() - started}ms)`);
    } else {
      // 1. トップ → ログイン画面
      const topRes = await page.goto(`${BASE_URL}/web/index.jsp`, { waitUntil: 'domcontentloaded' });
      if (!(await page.$('[onclick*="gRsvWTransUserLoginAction"]'))) {
        const diag = await page
          .evaluate(() => `${document.title} | ${document.body?.innerText.replace(/\s+/g, ' ').slice(0, 160)}`)
          .catch(() => '(取得不可)');
        await saveDebug(page, debugDir, 'top-unexpected');
        throw new ReserveError('error', `トップページにログインボタンがありません (HTTP ${topRes?.status() ?? '?'}, ${await pageId(page)}: ${diag})`);
      }
      await pause();
      await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), humanClick('[onclick*="gRsvWTransUserLoginAction"]')]);
      if ((await pageId(page)) !== 'pawab2100.jsp') throw new ReserveError('error', `ログイン画面が想定外です (${await pageId(page)})`);

      // 2. ログイン(サイトの submitLogin() がパスワードの分解と reCAPTCHA v3 の処理を行う)
      await humanType('input[name="userId"]', credentials.userId);
      await humanType('input[name="password"]', credentials.password);
      await pause();
      // 入力エラーの alert(「利用者番号は半角数字で…」等)が出ると遷移しないので、alert を見たら即 auth_error にする
      const alertCount = alerts.length;
      const alertSeen = new Promise((resolve) => {
        const t = setInterval(() => {
          if (alerts.length > alertCount) {
            clearInterval(t);
            resolve('alert');
          }
        }, 200);
        setTimeout(() => clearInterval(t), STEP_TIMEOUT);
      });
      const outcome = await Promise.race([
        Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), humanClick('[onclick*="submitLogin"]')]).then(() => 'nav'),
        alertSeen,
      ]);
      if (outcome === 'alert') throw new ReserveError('auth_error', `ログインの入力が受け付けられませんでした: ${lastAlert()}`);
      const afterLogin = await pageId(page);
      if (afterLogin === 'pawab2100.jsp') {
        // ログイン画面に戻された。サイトの一時的な通信エラー(「データ通信を正しく行うことができませんでした」)なら
        // 認証の失敗ではないので、やり直し可能な error にする。それ以外(パスワード誤り等)は auth_error(やり直さない)
        const reason = lastAlert();
        if (/データ通信|時間をあけ|再度操作/.test(reason)) {
          throw new ReserveError('error', `ログイン時にサイトの一時エラー: ${reason.replace(/\s+/g, ' ')}`);
        }
        throw new ReserveError('auth_error', `ログインが拒否されました: ${reason || '利用者番号・パスワード・カード有効期限を確認'}`);
      }
      if (!(await page.$(LOGOUT_SELECTOR))) throw new ReserveError('error', `ログイン後の画面が想定外です (${afterLogin})`);
      loggedIn = true;
      log(`ログイン完了 (${Date.now() - started}ms)`);

      // 3. ログイン直後の「お知らせ」等のモーダルを閉じる
      const closed = await page.evaluate(() => {
        const open = [...document.querySelectorAll('.modal.show')];
        for (const m of open) window.jQuery?.(m).modal('hide');
        return open.map((m) => m.id);
      });
      if (closed.length) {
        log(`モーダルを閉じました: ${closed.join(', ')}`);
        await page.waitForSelector('.modal-backdrop', { state: 'detached', timeout: 5000 }).catch(() => {});
      }

      // 4. 空き検索(種目 → 公園の順。同期先の hidden も揃ってから検索する。docs/site-notes.md「ハマりどころ」)
      //    ホーム画面の Ajax(種目→公園の選択肢)が失敗して「データ通信を正しく行うことができませんでした」が出ることがあるので、
      //    公園の選択肢が出てこなければホームを読み直して1回だけやり直す
      for (let attempt = 1; ; attempt++) {
        try {
          await page.fill('#daystart-home', slot.date);
          await page.selectOption('#purpose-home', PURPOSE_VALUE);
          await page.waitForFunction(
            (code) => [...document.querySelectorAll('#bname-home option')].some((o) => o.value === code),
            slot.park,
            { timeout: 15000 }
          );
          break;
        } catch (e) {
          if (attempt >= 2) throw new ReserveError('error', `ホーム画面で公園の選択肢が出ませんでした: ${e.message.split('\n')[0]}`);
          log('ホーム画面の読み込みに失敗したため読み直します');
          alerts.length = 0;
          // index.jsp を直接開くとログイン状態の画面に戻れないことがあるため、サイトの「ホーム」操作(form1 の POST)で読み直す
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.evaluate(() => {
              document.form1.action = gRsvWOpeHomeAction;
              document.form1.submit();
            }),
          ]);
          await pause(800, 1500);
          if (!(await page.$(LOGOUT_SELECTOR))) throw new ReserveError('error', 'ホームを読み直したらログインが外れていました');
        }
      }
      await page.selectOption('#bname-home', slot.park);
      await page.waitForFunction(
        (code) => document.querySelector('#bname')?.value === code && document.querySelector('#selectAreaBcd')?.value === code,
        slot.park
      );
      await pause();
      await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), humanClick('#btn-go')]);
      if ((await pageId(page)) !== 'prwrc2000.jsp' || (await hidden(page, 'selectBldCd')) !== slot.park) {
        // セッション未認識のまま 200 が返るパターン(公園未指定の空き状況画面)
        throw new ReserveError('error', `検索結果画面が想定外です (${await pageId(page)}, 公園=${await hidden(page, 'selectBldCd')})`);
      }
      facility = (await hidden(page, 'selectBldName')) || slot.park;
      await page.waitForSelector(`#week-info td[id^="${ymd.slice(0, 6)}"]`);
      log(`空き状況画面 ${facility} (${Date.now() - started}ms)`);

      // 5. 対象セル(id が数字始まりなので [id="..."] で指定)
      const cell = await page.$(`[id="${cellId}"]`);
      if (!cell) throw new ReserveError('error', `対象セル ${cellId} が週表示にありません`);
      const vacant = await page.$eval(`[id="A_${cellId}"]`, (e) => e.value).catch(() => null);
      if (vacant === null || Number(vacant) < 1) {
        const alt = await cell.$eval('img', (e) => e.alt).catch(() => '不明');
        return done('taken', `その枠は空きではありませんでした(${alt})`);
      }
      await humanClick(`[id="${cellId}"]`);
      await page.waitForFunction((id) => document.getElementById(`S_${id}`)?.value === '1', cellId, { timeout: 15000 });
      log(`枠を選択 (空き${vacant}面, ${Date.now() - started}ms)`);

      // 6. 「予約」→ 予約内容確認画面(prwea1000)
      await pause();
      await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), humanClick('#btn-go')]);
    }
    if ((await pageId(page)) !== 'prwea1000.jsp') {
      // 空き状況画面が返ってくる = サイトがセッション上の選択を認識しなかった(ロードバランサ配下の癖)可能性が高い。
      // 呼び出し側の再試行(新しいセッション)で回復する
      const selected = await page.$eval(`[id="S_${cellId}"]`, (e) => e.value).catch(() => 'なし');
      const size = await hidden(page, 'selectSize');
      throw new ReserveError(
        'error',
        `予約内容確認画面に進めませんでした (画面=${await pageId(page)}, 選択=${selected}, selectSize=${size}) ${lastAlert()}`
      );
    }
    // 表示内容が指定した枠と一致するか(別の枠を予約してしまわないための最終確認)
    const heading = await page.$eval('h3', (e) => e.textContent.replace(/\s+/g, '')).catch(() => '');
    if ((await hidden(page, 'stimeZoneNo')) !== tz || !heading.includes(dateLabel)) {
      throw new ReserveError('error', `予約内容確認画面の枠が一致しません (${heading}, 時間帯=${await hidden(page, 'stimeZoneNo')})`);
    }
    if (!(await page.$eval('#purpose0', (e) => e.value).catch(() => ''))) await page.selectOption('#purpose0', PURPOSE_VALUE);
    await humanType('#peoples0', people);
    log(`予約内容確認画面: ${heading} 人数${people} (${Date.now() - started}ms)`);

    if (dryRun) {
      // reCAPTCHA チャレンジ(v2 チェックボックス)が出るかを判定。少し待ってから見る(iframe の描画待ち)
      await page.waitForTimeout(2500);
      const rc = await recaptchaChallenge(page);
      const challenge = rc.promptShown || rc.boxVisible;
      log(`reCAPTCHA: ${challenge ? 'v2チャレンジあり(要チェック)' : 'v3のみ(チェック不要)'} (促し文=${rc.promptShown}, 可視box=${rc.boxVisible})`);
      await saveDebug(page, debugDir, `dry-run-${challenge ? 'v2challenge' : 'v3ok'}`);
      return done('dry_run', `予約内容確認画面まで到達(予約はしていません): ${facility} ${dateLabel} ${slot.startHour}時`, {
        facility,
        recaptcha: challenge ? 'v2_challenge' : 'v3_ok',
      });
    }

    if (onConfirm) {
      // 半自動(noVNC): ここで人間に制御を渡す。「予約」→(出れば)reCAPTCHA v2 チェック → 再度「予約」は人間が行う。
      // onConfirm は人間の操作が終わる(完了画面に遷移する)か、時間切れになると戻ってくる
      alerts.length = 0;
      log('予約内容確認画面に到達。人間に操作を渡します');
      await onConfirm({ page, facility, dateLabel, slot, people });
      if ((await pageId(page)) === 'prwea1000.jsp') {
        await saveDebug(page, debugDir, 'handoff-abandoned');
        return done('abandoned', '人間の操作が完了しないまま終了しました(予約はされていません)', { facility });
      }
    } else {
      // 7. 「予約」→ 確認ダイアログ OK(dialog ハンドラ)→ サイトの JS が reCAPTCHA v3 トークンを取って送信 → 完了画面
      // reCAPTCHA の JS が読み込まれてから押す。読み込み前に押すとサイトの JS は「トークン無し」で送ってしまい、
      // 結果的に認証を素通りさせる形になる(それはしない)。読み込めない場合は予約せずに error で終える
      try {
        await page.waitForFunction(() => typeof window.grecaptcha?.execute === 'function', null, { timeout: 20000 });
      } catch {
        throw new ReserveError('error', 'reCAPTCHA のスクリプトが読み込まれなかったため、予約を送信しませんでした');
      }
      alerts.length = 0; // ここまでの alert(トップページの Ajax 失敗など)は結果判定に混ぜない
      await pause();
      await Promise.all([page.waitForNavigation({ timeout: APPLY_TIMEOUT, waitUntil: 'domcontentloaded' }), humanClick('#btn-go')]);
    }
    // 送信後の画面を判定する(成功 / 失敗の種類)。onChallenge があり v2 チェックボックスが出た場合は人間に渡してから再判定
    const classify = async (afterHuman) => {
      const resultId = await pageId(page);
      if (resultId === 'prwec1000.jsp') {
        const t = await parseResultTable(page);
        const title = await page.$eval('h3 .title', (e) => e.textContent.trim()).catch(() => facility);
        log(`予約完了 予約番号=${t['予約番号']} (${Date.now() - started}ms)`);
        return done('success', `予約が完了しました: ${title} ${dateLabel} ${t['時間'] || ''} ${t['利用料金'] || ''}`, {
          reservationNo: t['予約番号'] || '',
          fee: t['利用料金'] || '',
          facility: title,
          dateText: dateLabel,
          timeText: t['時間'] || '',
        });
      }
      const bodyText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ')).catch(() => '');
      if (resultId === 'prwea1000.jsp' && /チェックを入れて/.test(bodyText)) {
        if (options.onChallenge && !afterHuman) {
          // reCAPTCHA v2(チェックボックス)が要求された。人間に画面を渡し、解いて「予約」を押してもらう
          log('reCAPTCHA v2 のチェックが要求されたため、人間に操作を渡します');
          alerts.length = 0;
          await options.onChallenge({ page, facility, dateLabel, slot, people, challenge: true });
          return classify(true);
        }
        await saveDebug(page, debugDir, 'apply-recaptcha-v2');
        return done(afterHuman ? 'abandoned' : 'rejected', afterHuman ? '人間の操作が完了しないまま終了しました(予約はされていません)' : 'reCAPTCHA v2 のチェックが要求されました(人間の操作が必要)', { facility });
      }
      if (resultId === 'prwea1000.jsp' && afterHuman) {
        return done('abandoned', '人間の操作が完了しないまま終了しました(予約はされていません)', { facility });
      }
      await saveDebug(page, debugDir, `apply-${resultId || 'unknown'}`);
      const reason = lastAlert() || bodyText.slice(0, 200);
      if (/reCAPTCHA|ロボット|不正なアクセス/i.test(reason)) return done('rejected', `サイトの認証(reCAPTCHA)で申込みが拒否されました: ${reason}`);
      if (/同じ利用日時|複数の予約|既に予約|2件まで/.test(reason)) return done('duplicate', `サイトが申込みを断りました: ${reason}`);
      if (/空き|予約済|予約あり|他の利用者/.test(reason)) return done('taken', `先に予約された可能性があります: ${reason}`);
      return done('error', `完了画面に到達しませんでした (${resultId || '不明'}): ${reason}`);
    };
    return await classify(false);
  } catch (e) {
    await saveDebug(page, debugDir, 'error');
    if (e instanceof ReserveError) return done(e.status, e.message);
    const timeout = /Timeout|timeout/.test(e.message);
    return done('error', `${timeout ? 'タイムアウト' : '想定外のエラー'}: ${e.message.split('\n')[0]}`);
  } finally {
    // ログアウト(失敗しても結果には影響させない)。サイトの doAction() は submit 後に未定義関数を呼ぶ画面があるため submit だけ行う
    if (loggedIn && !page.isClosed()) {
      try {
        await Promise.all([
          page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
          page.evaluate(() => {
            document.form1.action = gRsvWTransUserAttestationEndAction;
            document.form1.submit();
          }),
        ]);
        log('ログアウト');
      } catch (e) {
        log(`ログアウト失敗(無視): ${e.message.split('\n')[0]}`);
      }
    }
    await context.close().catch(() => {});
    await browser?.close?.().catch(() => {});
  }
}

// 通知・ログ用の枠表記("亀戸中央公園 9/17(木) 15-17時" 相当は呼び出し側で公園名を足す)
export function slotLabel(slot) {
  const [, m, d] = slot.date.split('-').map(Number);
  return `${m}/${d} ${slot.startHour}-${Number(slot.startHour) + 2}時`;
}
