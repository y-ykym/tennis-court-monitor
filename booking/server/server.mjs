// ============================================================
// 予約支援サーバー(自宅の Raspberry Pi 上の Docker で動く Node Web アプリ。booking/pc/docker-compose.yml)
//
//   GET /book?token=…    署名付きトークン(予約者 person 入り)を検証し、予約フローを開始。ブラウザ向けの画面は返さず、
//                        呼び出し元(Cloudflare Worker。LINE の postback ボタンから)が読む JSON を返す:
//                          202 {status:'started'}  始めた(結果は LINE にカードで push する)
//                          200 {status:'already'}  同じ枠の予約が既に成立している(二重予約防止)
//                          409 {status:'busy'}     別の枠を処理中
//                          400 {status:'no_person'} トークンに予約者が無い / 403 {status:'invalid'} 署名不正・期限切れ
//   GET /status?token=…  進行状況 JSON(noVNC 画面が数秒ごとに見る)
//   GET /vnc?token=…     noVNC 画面。reCAPTCHA v2 が出たときだけ、LINE の「確認が必要です」カードのボタンから開く。
//                        人間がチェック → 画像問題 → 再度「予約」を行う。準備前に開いたら「準備中」を返して数秒後に再読み込み
//   WS  /websockify?token=…  noVNC と x11vnc(localhost:5900)の橋渡し(websockify 相当を Node で実装)
//   GET /result?token=…  結果画面(noVNC 画面が完了を検知して遷移する)
//   GET /abort?token=…   人間が「やめる」を押した(予約せず終了)
//   GET /warmup          監視・生存確認の空叩き
//   GET /healthz
//   GET /auto/status     フェーズ3 自動予約の状態(mode・行列・最終照会・起動時刻)。Pi 自身の確認用と、Worker が生存判定に使う(トンネル越し)
//   GET /auto/report     直近 N 日(?days=7、最大 14)の日ごとの記録と候補ごとの結果、自分が自動予約した枠。Worker の週報(毎週月曜 9:00)が読む
//
// 環境変数(.env と docker-compose.yml から):
//   BOOKING_SIGNING_SECRET  トークン署名鍵(通知側・Worker と同じ値)
//   SITE_USER_A / SITE_PASS_A / LABEL_A(/ _B)  予約サイトの利用者番号・パスワード・呼び名
//   VNC_PASSWORD            x11vnc のパスワード(entrypoint が生成して渡す)
//   DISPLAY, SCREEN_W, SCREEN_H, PORT
//   PROFILE_LOCAL=1         ブラウザプロファイル(Cookie 等)を docker volume に持ち越す
//   FAST_PATH=0             高速経路(ページ内 fetch でログイン〜枠選択)を使わず UI 操作で進める(既定は高速経路)
//   LINE_CHANNEL_ACCESS_TOKEN / LINE_USER_ID  結果カードと「確認が必要です」カードを LINE に push する。
//                           回線断で送れなかったカードは PENDING_LINE_FILE に保存し、1 分ごとに再送(src/line-queue.js)
//   BOOKING_PUBLIC_URL / WORKER_URL  そのカードのボタンに使う、外から届く URL(玄関の Worker)。WORKER_URL は自動予約の合図の宛先にも使う
//   AUTO_BOOKING            フェーズ3 自動予約: 'on' / 'dry-run' / 'off'(既定)。src/auto-runner.js
//   AUTO_POLL_MS            空き照会の間隔(既定 60000。30000 未満にはならない)
//   AUTO_STATE_FILE         自動予約の状態ファイル(既定 /var/lib/booking/auto-state.json)
//   MOCK_SLOTS_FILE         あればサイトを見ずにこのファイルの空きを使う(dry-run の確認用)
//
// 方針:
//   - 「予約」まで自動で押す(自宅回線なら reCAPTCHA v3 で通る)。v2 のチェックが出たときだけ noVNC で人間に渡す
//   - 同時に扱う予約は1件だけ(画面が1つしかない)。フェーズ3 からは行列(src/booking-queue.js)で 1 件ずつ実行し、
//     手動(LINE ボタン)を自動予約より優先する。手動同士は従来どおり 409 busy
//   - セッションは予約サイト側で約10分で切れるため、人間に渡してから HANDOFF_TIMEOUT_MS で打ち切る
//   - 利用者番号・パスワード・Cookie・VNC パスワードはログに出さない
// ============================================================
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { createRequire } from 'node:module';
import { reserve } from '../src/reserve.js';
import { buildChallengeFlex, buildResultFlex, pushResult } from '../src/result-flex.js';
import { createLineQueue } from '../src/line-queue.js';
import { verify, sign, slotExpiry } from '../src/token.js';
import { createBookingQueue } from '../src/booking-queue.js';
import { createAutoState } from '../src/auto-state.js';
import { createAutoJournal, JOURNAL_KEEP_DAYS } from '../src/auto-journal.js';
import { createAutoRunner, createScraper } from '../src/auto-runner.js';

const require = createRequire(import.meta.url);
const { sendHeartbeat, addExcludedSlots, fetchTennisbearPlans } = require('../../lib/auto-client.js');
const { AUTO_BOOKING } = require('../../lib/config.js');
const { slotKey } = require('../../lib/auto-rules.js');
// 従来の空き通知カード(予約ボタン付き)。予約直前に対象外になった枠を Pi から通知するのに使う。
// ボタンの署名と宛先は lib/notify.js が環境変数から読む(BOOKING_BASE_URL は Pi では WORKER_URL と同じ)
process.env.BOOKING_BASE_URL ||= process.env.WORKER_URL || process.env.BOOKING_PUBLIC_URL || '';
const { buildFlexMessages } = require('../../lib/notify.js');

const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.BOOKING_SIGNING_SECRET || '';
const VNC_PASSWORD = process.env.VNC_PASSWORD || '';
const VNC_PORT = 5900;
const SCREEN_W = Number(process.env.SCREEN_W || 600);
const SCREEN_H = Number(process.env.SCREEN_H || 1000);
// 人間に渡してからの上限(予約サイトのセッション寿命が約10分なので、それより短く)
const HANDOFF_TIMEOUT_MS = 8 * 60 * 1000;
// 終わったセッションの情報を保持する時間(結果画面の表示用)
const DONE_KEEP_MS = 10 * 60 * 1000;
// noVNC クライアント(npm の lib は CommonJS なので、esbuild でブラウザ用 ESM に束ねたもの。npm run build:novnc)
const NOVNC_BUNDLE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'rfb.js');
const PARK_NAMES = { 1040: '猿江恩賜公園', 1050: '亀戸中央公園', 1160: '大島小松川公園' };
// ブラウザプロファイル(Cookie 等)の置き場所。PROFILE_LOCAL=1 のとき docker volume として持ち越す
const PROFILE_DIR = '/tmp/profile';
const PROFILE_LOCAL = process.env.PROFILE_LOCAL === '1';
// 結果を LINE に push する(両方あるとき)
const LINE = { token: process.env.LINE_CHANNEL_ACCESS_TOKEN || '', to: process.env.LINE_USER_ID || '' };
// LINE のカードに載せる、外(スマホ)から届く URL。玄関の Worker(固定 URL)を使う
const PUBLIC_BASE = (process.env.BOOKING_PUBLIC_URL || process.env.WORKER_URL || '').replace(/\/$/, '');

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const SERVER_STARTED_AT = Date.now();

// LINE への push は「届くまで持ち越す」(回線断の間に送れなかった結果カードを取りこぼさない)。保存先は docker volume
const lineQueue = createLineQueue({
  file: process.env.PENDING_LINE_FILE || '/var/lib/booking/pending-line.json',
  push: (message) => pushResult(message, LINE),
  log,
}).start();

function credentialsFor(person) {
  const p = person === 'B' ? 'B' : 'A';
  return {
    userId: process.env[`SITE_USER_${p}`],
    password: process.env[`SITE_PASS_${p}`],
    label: process.env[`LABEL_${p}`] || p,
  };
}

// ---- 予約の実行(行列で 1 件ずつ。手動優先) ----
const queue = createBookingQueue({ log });
// token → セッション。終わったものも DONE_KEEP_MS の間は残す(結果画面・/status 用)
const sessions = new Map();
// session = { token, payload, label, kind: 'manual'|'auto', status: 'queued'|'starting'|'ready'|'done', message, result, startedAt, readyAt, finish(reason) }

function slotText(p) {
  const [y, m, d] = p.date.split('-').map(Number);
  const dow = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
  return `${PARK_NAMES[p.park] || p.park} ${m}/${d}(${dow}) ${p.startHour}:00-${Number(p.startHour) + 2}:00`;
}

function newSession(token, payload, kind) {
  const creds = credentialsFor(payload.person);
  const s = {
    token,
    payload,
    label: creds.label,
    kind,
    status: 'queued',
    message: kind === 'auto' ? '自動予約の順番待ち…' : '順番待ち(別の予約を処理中)…',
    result: null,
    startedAt: null,
    readyAt: null,
    finish: null,
  };
  sessions.set(token, s);
  return s;
}

// 予約フロー本体(行列の中で呼ばれる)。extra は reserve() への追加オプション(自動予約の reservationList / beforeApply)
async function runReserve(s, extra = {}) {
  const { token, payload } = s;
  const creds = credentialsFor(payload.person);
  s.status = 'starting';
  s.startedAt = Date.now();
  s.message = 'ログインして枠を選んでいます…';

  // 人間に画面を渡す(reCAPTCHA v2 が出たときだけ呼ばれる)。人間の操作が終わる(画面が変わる)か、時間切れ/中止まで待つ
  const handoff = ({ page, facility }) =>
    new Promise((resolve) => {
      s.status = 'ready';
      s.readyAt = Date.now();
      s.message = '画面を表示しています';
      // ボタンを押した人がもう待機画面を閉じていても気づけるよう、LINE に「確認が必要です」カードを送る(失敗しても続行)
      if (LINE.token && LINE.to && PUBLIC_BASE) {
        const url = `${PUBLIC_BASE}/vnc?token=${encodeURIComponent(token)}`;
        lineQueue.send(buildChallengeFlex({ slot, facility, label: s.label, url, minutes: HANDOFF_TIMEOUT_MS / 60000 }), '  reCAPTCHA の確認依頼');
      }
      let finished = false;
      const finish = (reason) => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        log(`人間の操作フェーズ終了: ${reason}`);
        resolve();
      };
      s.finish = finish;
      const timer = setInterval(async () => {
        if (Date.now() - s.readyAt > HANDOFF_TIMEOUT_MS) return finish('時間切れ');
        try {
          const head = await page.evaluate(() => document.documentElement.outerHTML.slice(0, 500));
          const id = head.match(/<!-- (\w+\.jsp) -->/)?.[1];
          // 予約内容確認画面(prwea1000)以外に移った = 完了画面かエラー画面。少し待って結果判定に戻す
          if (id && id !== 'prwea1000.jsp') setTimeout(() => finish(`画面遷移 ${id}`), 1500);
        } catch {
          /* 遷移中は evaluate が失敗することがある。次の周期で見る */
        }
      }, 1000);
    });

  const slot = { park: payload.park, date: payload.date, startHour: Number(payload.startHour), people: Number(payload.people || 2) };
  log(`予約フロー開始${s.kind === 'auto' ? '(自動予約)' : ''}: ${slotText(payload)} 予約者=${creds.label}`);
  const credentials = { userId: creds.userId, password: creds.password };
  const browserOptions = {
    headless: false,
    launchArgs: [`--window-size=${SCREEN_W},${SCREEN_H}`, '--window-position=0,0'],
    viewport: null,
    onChallenge: handoff,
    debugDir: '/tmp/debug-out',
    log: (m) => log(`  ${m}`),
    ...extra,
  };
  let result;
  try {
    // ブラウザプロファイル(Cookie 等)を前回から引き継ぐ
    if (PROFILE_LOCAL) browserOptions.userDataDir = PROFILE_DIR;
    // まず高速経路(ブラウザ内 fetch でログイン〜枠選択)。一時エラーなら全ブラウザ方式(UI 操作)で1回やり直す。
    // 環境変数 FAST_PATH=0 で高速経路を使わず、最初から UI 操作(人間らしい操作)で進める(reCAPTCHA の重さの比較用)
    const useFast = process.env.FAST_PATH !== '0';
    s.message = useFast ? 'ログインして枠を選んでいます(高速経路)…' : 'ブラウザでログインして枠を選んでいます…';
    result = await reserve(slot, credentials, { ...browserOptions, fastInPage: useFast });
    if (useFast && result.status === 'error') {
      log(`  高速経路の結果が error のためブラウザ方式でやり直し: ${result.message}`);
      s.message = 'ブラウザでログインして枠を選んでいます(やり直し)…';
      result = await reserve(slot, credentials, browserOptions);
    }
  } catch (e) {
    result = { status: 'error', message: e.message };
    log(`予約フロー例外: ${e.message}`);
  }
  s.status = 'done';
  s.result = result;
  s.message = result.message;
  log(`予約フロー終了: ${result.status} ${result.message}`);
  // 手動の結果は LINE にも送る(ボタンを押した本人以外にも分かるように)。自動予約のカードは auto-runner が送る
  if (s.kind === 'manual' && LINE.token && LINE.to && result.status !== 'dry_run') {
    await lineQueue.send(buildResultFlex({ slot, ...result }, s.label), '結果カード');
  }
  setTimeout(() => {
    if (sessions.get(token) === s) sessions.delete(token);
  }, DONE_KEEP_MS);
  return result;
}

// ---- フェーズ3 自動予約(AUTO_BOOKING=on|dry-run のとき起動) ----
const AUTO_MODE = (() => {
  const v = String(process.env.AUTO_BOOKING || 'off').trim().toLowerCase();
  if (v === 'on' || v === '1') return 'on';
  if (v === 'dry-run' || v === 'dryrun') return 'dry-run';
  return 'off';
})();
const WORKER_URL = (process.env.WORKER_URL || process.env.BOOKING_PUBLIC_URL || '').replace(/\/$/, '');
let autoRunner = null;
let autoState = null;
let autoJournal = null;
if (AUTO_MODE !== 'off') {
  if (!WORKER_URL || !SECRET) {
    log('自動予約: WORKER_URL と BOOKING_SIGNING_SECRET が必要です。起動しません');
  } else {
    const stateFile = process.env.AUTO_STATE_FILE || '/var/lib/booking/auto-state.json';
    const state = createAutoState({ file: stateFile });
    const journal = createAutoJournal({ file: path.join(path.dirname(stateFile), 'auto-journal.json') });
    autoState = state;
    autoJournal = journal;
    autoRunner = createAutoRunner({
      mode: AUTO_MODE,
      scrape: createScraper(),
      queue,
      state,
      worker: {
        heartbeat: (payload) => sendHeartbeat(WORKER_URL, SECRET, payload),
        addExcludedSlots: (slots) => addExcludedSlots(WORKER_URL, SECRET, slots),
        tennisbear: (person) => fetchTennisbearPlans(WORKER_URL, SECRET, person),
      },
      credentialsFor: (person) => {
        const c = credentialsFor(person);
        return c.userId && c.password ? c : null;
      },
      // 候補 1 件の予約実行(行列の中で呼ばれる)。手動と同じセッション扱いにして、reCAPTCHA v2 の /vnc も同じ仕組みで動くようにする
      book: async (c, { beforeApply }) => {
        const payload = { park: c.park, date: c.date, startHour: Number(c.startHour), people: AUTO_BOOKING.PEOPLE, person: c.person, auto: 1, exp: slotExpiry(c.date, c.startHour) };
        const token = sign(payload, SECRET);
        const s = newSession(token, payload, 'auto');
        return runReserve(s, { reservationList: true, beforeApply });
      },
      notify: (message, what) => (LINE.token && LINE.to ? lineQueue.send(message, what) : Promise.resolve(false)),
      notifyVacancy: async (slots) => {
        if (!LINE.token || !LINE.to) return;
        for (const m of buildFlexMessages(slots)) await lineQueue.send(m, '空き通知カード(予約直前に対象外になった枠)');
      },
      signingSecret: SECRET,
      log: (m) => log(`[auto] ${m}`),
      pollMs: Number(process.env.AUTO_POLL_MS) || AUTO_BOOKING.POLL_INTERVAL_MS,
      // 実枠テスト用(README「フェーズ3」参照): このファイルに枠キーを書くと、その枠を「新しく出た」扱いにする
      forgetFile: path.join(path.dirname(stateFile), 'forget-keys.txt'),
      journal,
    }).start();
  }
}

// ---- HTML ----
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const page = (title, body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>${esc(title)}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;margin:0;background:#f4f6f8;color:#222}
  .card{max-width:520px;margin:24px auto;background:#fff;border-radius:12px;padding:20px 22px;box-shadow:0 2px 10px rgba(0,0,0,.06)}
  h1{font-size:1.15rem;margin:0 0 12px}
  .slot{font-weight:700;font-size:1.05rem;margin:6px 0 14px}
  .muted{color:#666;font-size:.9rem;line-height:1.6}
  .ok{color:#06863b} .ng{color:#c0392b}
  .spinner{display:inline-block;width:16px;height:16px;border:3px solid #ccc;border-top-color:#06C755;border-radius:50%;animation:s 1s linear infinite;vertical-align:middle;margin-right:8px}
  @keyframes s{to{transform:rotate(360deg)}}
  a.btn{display:inline-block;margin-top:14px;padding:10px 16px;border-radius:8px;background:#06C755;color:#fff;text-decoration:none;font-weight:700}
  a.btn.gray{background:#888}
</style></head><body>${body}</body></html>`;

// noVNC 画面や結果画面を、準備が整う前に開いたときの表示(数秒後に自動で再読み込み)
function preparingPage(s) {
  return page(
    '準備中',
    `<meta http-equiv="refresh" content="3">
    <div class="card">
      <h1><span class="spinner"></span>予約を進めています</h1>
      <div class="slot">${esc(slotText(s.payload))}<br><span class="muted">予約者: ${esc(s.label)}</span></div>
      <div class="muted">${esc(s.message)}</div>
      <div class="muted" style="margin-top:12px">この画面は数秒ごとに自動で更新されます。結果は LINE にも届きます。</div>
    </div>`
  );
}

function resultPage(s) {
  const r = s.result || { status: 'error', message: s.message };
  const ok = r.status === 'success';
  const STATUS = {
    success: '予約が完了しました',
    abandoned: '予約は行われませんでした(操作が完了しなかったか、中止しました)',
    taken: '先に予約されていました',
    duplicate: 'サイトが申込みを断りました',
    rejected: 'サイトの認証で拒否されました',
    auth_error: 'ログインできませんでした',
    error: 'サイトのエラーで完了できませんでした',
  };
  return page(
    ok ? '予約完了' : '予約できませんでした',
    `<div class="card">
      <h1 class="${ok ? 'ok' : 'ng'}">${ok ? '🎾 ' : '⚠️ '}${esc(STATUS[r.status] || r.status)}</h1>
      <div class="slot">${esc(slotText(s.payload))}<br><span class="muted">予約者: ${esc(s.label)}</span></div>
      ${ok ? `<div class="muted">予約番号: <b>${esc(r.reservationNo || '-')}</b><br>料金: ${esc(r.fee || '-')}<br>予約完了メールは都のシステムから届きます。</div>` : `<div class="muted">${esc(r.message || '')}</div><a class="btn gray" href="https://kouen.sports.metro.tokyo.lg.jp/web/index.jsp">予約サイトを開く(手動で続ける)</a>`}
    </div>`
  );
}

function vncPage(token, s) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>予約サイトを操作</title>
<style>
  html,body{margin:0;height:100%;background:#111;color:#eee;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;overflow:hidden}
  #bar{position:fixed;top:0;left:0;right:0;height:44px;background:#06C755;color:#fff;display:flex;align-items:center;gap:10px;padding:0 10px;font-size:.85rem;z-index:10;box-sizing:border-box}
  #bar b{white-space:nowrap} #bar .st{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #bar a{color:#fff;background:rgba(0,0,0,.25);padding:6px 10px;border-radius:6px;text-decoration:none;white-space:nowrap}
  #screen{position:fixed;top:44px;left:0;right:0;bottom:0}
  #hint{position:fixed;bottom:0;left:0;right:0;background:rgba(0,0,0,.7);color:#fff;font-size:.8rem;padding:8px 12px;line-height:1.5;z-index:10}
</style></head><body>
<div id="bar"><b>${esc(slotText(s.payload))}</b><span class="st" id="st">接続中…</span><a href="/abort?token=${encodeURIComponent(token)}">やめる</a></div>
<div id="screen"></div>
<div id="hint">「予約」は押しました。<b>チェックボックス</b>を押し、画像問題が出たら解いてから、もう一度<b>「予約」</b>を押してください。完了画面になると自動で結果に進みます。</div>
<script type="module">
  // esbuild で CommonJS を束ねたため、既定エクスポートが { default: RFB } の形になることがある
  import mod from '/novnc/rfb.js';
  const RFB = mod && mod.default ? mod.default : mod;
  const token=${JSON.stringify(token)};
  const proto=location.protocol==='https:'?'wss':'ws';
  const url=proto+'://'+location.host+'/websockify?token='+encodeURIComponent(token);
  const rfb=new RFB(document.getElementById('screen'),url,{credentials:{password:${JSON.stringify(VNC_PASSWORD)}}});
  rfb.scaleViewport=true; rfb.resizeSession=false; rfb.showDotCursor=true; rfb.background='#111';
  const st=document.getElementById('st');
  rfb.addEventListener('connect',()=>{st.textContent='接続しました。画面を操作できます';});
  rfb.addEventListener('disconnect',(e)=>{st.textContent='切断されました'+(e.detail.clean?'':'(エラー)');console.log('noVNC disconnect',e.detail);});
  window.addEventListener('error',(e)=>{st.textContent='エラー: '+e.message;});
  rfb.addEventListener('securityfailure',(e)=>{st.textContent='認証に失敗: '+e.detail.reason;});
  async function poll(){
    try{const r=await fetch('/status?token='+encodeURIComponent(token),{cache:'no-store'}); const j=await r.json();
      if(j.status==='done'){location.replace('/result?token='+encodeURIComponent(token));return;}
    }catch(e){}
    setTimeout(poll,2000);
  }
  poll();
</script></body></html>`;
}

function simplePage(title, body, status = 200) {
  return [status, page(title, `<div class="card"><h1>${esc(title)}</h1><div class="muted">${body}</div></div>`)];
}

// ---- HTTP ----
function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function tokenOf(url) {
  const token = url.searchParams.get('token') || '';
  return { token, payload: verify(token, SECRET) };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p === '/healthz' || p === '/warmup') return send(res, 200, 'ok\n', 'text/plain');
  if (p === '/auto/status') {
    return send(
      res,
      200,
      JSON.stringify({
        // mode: 'on' | 'paused'(LINE の「じどうおふ」で停止中) | 'dry-run' | 'off'。Worker が生存判定に使う
        mode: autoRunner ? autoRunner.effectiveMode() : AUTO_MODE,
        envMode: AUTO_MODE,
        active: !!autoRunner && autoRunner.effectiveMode() === 'on',
        enabled: autoRunner ? autoRunner.remoteEnabled() : null,
        notifyEnabled: autoRunner ? autoRunner.remoteNotify() : null,
        startedAt: SERVER_STARTED_AT,
        now: Date.now(),
        intervalMs: autoRunner?.intervalMs ?? null,
        lastCycle: autoRunner?.lastCycle() ?? null,
        // 直近の照会で見えていた監視対象の空き(実枠テストで枠を選ぶときに見る)
        targets: autoRunner ? autoRunner.lastTargets().map((s) => ({ key: slotKey(s), ...s })) : null,
        exclusions: autoRunner?.exclusions() ? { dates: autoRunner.exclusions().dates.length, slots: autoRunner.exclusions().slots.length, at: autoRunner.exclusions().at } : null,
        queue: { running: queue.current() ? { kind: queue.current().kind, id: queue.current().id } : null, waiting: queue.waiting().map((j) => ({ kind: j.kind, id: j.id })) },
      }),
      'application/json'
    );
  }

  // 週報用(Worker の auto-report.js が月曜 9:00 にトンネル越しに読む)。予約番号・利用者情報は含めない
  if (p === '/auto/report') {
    const days = Math.max(1, Math.min(Number(url.searchParams.get('days')) || 7, JOURNAL_KEEP_DAYS));
    const nowMs = Date.now();
    return send(
      res,
      200,
      JSON.stringify({
        mode: autoRunner ? autoRunner.effectiveMode() : AUTO_MODE,
        envMode: AUTO_MODE,
        enabled: autoRunner ? autoRunner.remoteEnabled() : null,
        startedAt: SERVER_STARTED_AT,
        now: nowMs,
        intervalMs: autoRunner?.intervalMs ?? null,
        lastCycle: autoRunner?.lastCycle() ?? null,
        authPaused: autoRunner?.authPaused() ?? [],
        ...(autoJournal ? autoJournal.summary({ days, nowMs }) : { from: null, to: null, days: [], events: [] }),
        own: autoState ? autoState.own().map(({ key, person, date, start, end, park, facility, at }) => ({ key, person, date, start, end, park, facility, at })) : [],
      }),
      'application/json'
    );
  }

  // noVNC のクライアント JS(単一バンドル)
  if (p === '/novnc/rfb.js') {
    if (!fs.existsSync(NOVNC_BUNDLE)) return send(res, 500, 'noVNC bundle がありません(npm run build:novnc)', 'text/plain');
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' });
    return fs.createReadStream(NOVNC_BUNDLE).pipe(res);
  }

  if (!['/book', '/status', '/vnc', '/abort', '/result'].includes(p)) return send(res, 404, 'not found', 'text/plain');

  const { token, payload } = tokenOf(url);
  const json = (status, body) => send(res, status, JSON.stringify(body), 'application/json');
  if (!payload) {
    if (p === '/status' || p === '/book') return json(403, { status: 'invalid' });
    return send(res, ...simplePage('このリンクは使えません', 'リンクの期限が切れているか、正しくありません。新しい通知のボタンから開いてください。', 403));
  }

  if (p === '/book') {
    // 予約者はトークンに入っている(通知側が「<呼び名>で予約」ボタンごとに署名)。無いトークンは受け付けない
    if (!['A', 'B'].includes(payload.person)) return json(400, { status: 'no_person' });
    const existing = sessions.get(token);
    if (existing) {
      // 同じ枠で終わった処理があるとき: 予約が成立していれば「済み」(二重予約防止)。それ以外(中止・失敗)はやり直せる
      if (existing.status !== 'done') return json(202, { status: 'started' });
      if (existing.result?.status === 'success') return json(200, { status: 'already' });
      sessions.delete(token);
    }
    // 手動同士は従来どおり 1 件だけ(実行中・順番待ちの手動があれば busy)。自動予約が実行中なら受け付けて、その直後に割り込む
    const manualBusy = (queue.current()?.kind === 'manual') || queue.waiting().some((j) => j.kind === 'manual');
    if (manualBusy) return json(409, { status: 'busy' });
    const s = newSession(token, payload, 'manual');
    const r = queue.submit({ id: `manual:${token}`, kind: 'manual', run: () => runReserve(s) });
    if (r.status === 'queued') log(`手動予約を受け付け(自動予約の実行中のため順番待ち): ${slotText(payload)}`);
    return json(202, { status: 'started', queued: r.status === 'queued' });
  }

  const s = sessions.get(token) || null;
  if (!s) {
    if (p === '/status') return json(200, { status: 'none' });
    return send(res, ...simplePage('処理が見つかりません', 'この予約の処理は始まっていないか、終了しています。通知のボタンからもう一度開いてください。', 404));
  }
  if (p === '/status') return json(200, { status: s.status, message: s.message });
  if (p === '/vnc') return send(res, 200, s.status === 'ready' ? vncPage(token, s) : s.status === 'done' ? resultPage(s) : preparingPage(s));
  if (p === '/result') return send(res, 200, s.status === 'done' ? resultPage(s) : preparingPage(s));
  if (p === '/abort') {
    if (s.finish) s.finish('人間が中止');
    res.writeHead(302, { location: `/result?token=${encodeURIComponent(token)}` });
    return res.end();
  }
});

// ---- WebSocket → VNC(TCP 5900) 橋渡し ----
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/websockify') return socket.destroy();
  const { token, payload } = tokenOf(url);
  const session = sessions.get(token);
  if (!payload || !session || session.status !== 'ready') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const vnc = net.connect(VNC_PORT, '127.0.0.1');
    const stream = createWebSocketStream(ws, { decodeStrings: false });
    vnc.on('connect', () => log('noVNC 接続'));
    vnc.on('error', (e) => log(`VNC 接続エラー: ${e.message}`));
    stream.on('error', () => {});
    stream.pipe(vnc).pipe(stream);
    ws.on('close', () => vnc.destroy());
    vnc.on('close', () => ws.close());
  });
});

server.listen(PORT, () => {
  log(`予約支援サーバー起動 port=${PORT} display=${process.env.DISPLAY || '(なし)'} 署名鍵=${SECRET ? 'あり' : 'なし!'} VNCパスワード=${VNC_PASSWORD ? 'あり' : 'なし!'} 自動予約=${AUTO_MODE}`);
});
