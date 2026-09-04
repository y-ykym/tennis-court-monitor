// ============================================================
// 予約支援サーバー(半自動 noVNC 方式)。Cloud Run の1コンテナで動く Node Web アプリ。
//
//   GET /book?token=…    署名付きトークンを検証し、予約フローを開始(ログイン→枠選択→予約内容確認画面→人数入力)。
//                        完了したら待機画面へ。すでに別の枠を処理中なら「使用中」
//   GET /wait?token=…    待機画面(数秒ごとに /status を見て、準備できたら /vnc へ)
//   GET /status?token=…  進行状況 JSON
//   GET /vnc?token=…     noVNC 画面。人間が「予約」→ reCAPTCHA v2 のチェック → 再度「予約」を行う
//   WS  /websockify?token=…  noVNC と x11vnc(localhost:5900)の橋渡し(websockify 相当を Node で実装)
//   GET /abort?token=…   人間が「やめる」を押した(予約せず終了)
//   GET /warmup          コールドスタート対策の空叩き(監視側が通知と同時に呼ぶ)
//   GET /healthz
//
// 環境変数(Cloud Run では Secret Manager から注入):
//   BOOKING_SIGNING_SECRET  トークン署名鍵(通知側と同じ値)
//   SITE_USER_A / SITE_PASS_A / LABEL_A(/ _B)  予約サイトの利用者番号・パスワード・呼び名
//   VNC_PASSWORD            x11vnc のパスワード(entrypoint が生成して渡す)
//   DISPLAY, SCREEN_W, SCREEN_H, PORT
//   AUTO_CONFIRM=1          「予約」までサーバーが押す(自宅回線用)。reCAPTCHA v2 が出たときだけ noVNC で人間に渡す
//   PROFILE_LOCAL=1 / PROFILE_BUCKET  ブラウザプロファイルの持ち越し(ローカル volume / GCS)
//   LINE_CHANNEL_ACCESS_TOKEN / LINE_USER_ID  あれば結果を LINE に push
//
// 方針:
//   - 同時に扱う予約は1件だけ(画面が1つしかない)。Cloud Run も max-instances=1 で運用する
//   - 「予約」ボタンと reCAPTCHA は人間が操作する。サーバーは押さない(reserve.js の onConfirm フック)
//   - セッションは予約サイト側で約10分で切れるため、人間に渡してから HANDOFF_TIMEOUT_MS で打ち切る
//   - 利用者番号・パスワード・Cookie・VNC パスワードはログに出さない
// ============================================================
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { reserve } from '../src/reserve.js';
import { restoreProfile, saveProfile } from '../src/profile-store.js';
import { buildResultFlex, pushResult } from '../src/result-flex.js';
import { verify } from '../src/token.js';

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
// ブラウザプロファイルの保存先(GCS バケット名。無ければ持ち越さない)と、コンテナ内の置き場所
const PROFILE_BUCKET = process.env.PROFILE_BUCKET || '';
const PROFILE_DIR = '/tmp/profile';
// PROFILE_LOCAL=1: GCS ではなくローカルの PROFILE_DIR(docker volume)にプロファイルを持ち越す(自宅 PC 用)
const PROFILE_LOCAL = process.env.PROFILE_LOCAL === '1';
// AUTO_CONFIRM=1: 「予約」までサーバーが押す(自宅回線で reCAPTCHA v3 が通る前提)。v2 のチェックが出たときだけ人間に渡す
const AUTO_CONFIRM = process.env.AUTO_CONFIRM === '1';
// 結果を LINE に push する(両方あるとき)
const LINE = { token: process.env.LINE_CHANNEL_ACCESS_TOKEN || '', to: process.env.LINE_USER_ID || '' };

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

function credentialsFor(person) {
  const p = person === 'B' ? 'B' : 'A';
  return {
    userId: process.env[`SITE_USER_${p}`],
    password: process.env[`SITE_PASS_${p}`],
    label: process.env[`LABEL_${p}`] || p,
  };
}

// ---- 進行中のセッション(1件だけ) ----
let session = null;
// session = { token, payload, label, status: 'starting'|'ready'|'done', message, result, startedAt, readyAt, finish(reason) }

function slotText(p) {
  const [y, m, d] = p.date.split('-').map(Number);
  const dow = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
  return `${PARK_NAMES[p.park] || p.park} ${m}/${d}(${dow}) ${p.startHour}:00-${Number(p.startHour) + 2}:00`;
}

function startSession(token, payload) {
  const creds = credentialsFor(payload.person);
  const s = {
    token,
    payload,
    label: creds.label,
    status: 'starting',
    message: 'ログインして枠を選んでいます…',
    result: null,
    startedAt: Date.now(),
    readyAt: null,
    finish: null,
    mode: AUTO_CONFIRM ? 'challenge' : 'confirm', // noVNC 画面の案内文の切り替え用
  };
  session = s;

  // 人間に画面を渡す。半自動では予約内容確認画面で、自動確定では reCAPTCHA v2 が出たときだけ呼ばれる。
  // 人間の操作が終わる(画面が変わる)か、時間切れ/中止まで待つ
  const handoff = ({ page }) =>
    new Promise((resolve) => {
      s.status = 'ready';
      s.readyAt = Date.now();
      s.message = '画面を表示しています';
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
  log(`予約フロー開始: ${slotText(payload)} 予約者=${creds.label}`);
  const credentials = { userId: creds.userId, password: creds.password };
  const browserOptions = {
    headless: false,
    launchArgs: [`--window-size=${SCREEN_W},${SCREEN_H}`, '--window-position=0,0'],
    viewport: null,
    ...(AUTO_CONFIRM ? { onChallenge: handoff } : { onConfirm: handoff }),
    debugDir: '/tmp/debug-out',
    log: (m) => log(`  ${m}`),
  };
  (async () => {
    // ブラウザプロファイル(Cookie 等)を前回から引き継ぐ
    if (PROFILE_BUCKET) {
      s.message = 'ブラウザを準備しています…';
      await restoreProfile(PROFILE_BUCKET, PROFILE_DIR, (m) => log(`  ${m}`));
      browserOptions.userDataDir = PROFILE_DIR;
    } else if (PROFILE_LOCAL) {
      browserOptions.userDataDir = PROFILE_DIR;
    }
    // まず高速経路(ブラウザ内 fetch でログイン〜枠選択)。一時エラーなら全ブラウザ方式(UI 操作)で1回やり直す。
    // 環境変数 FAST_PATH=0 で高速経路を使わず、最初から UI 操作(人間らしい操作)で進める(reCAPTCHA の重さの比較用)
    const useFast = process.env.FAST_PATH !== '0';
    s.message = useFast ? 'ログインして枠を選んでいます(高速経路)…' : 'ブラウザでログインして枠を選んでいます…';
    let result = await reserve(slot, credentials, { ...browserOptions, fastInPage: useFast });
    if (useFast && result.status === 'error') {
      log(`  高速経路の結果が error のためブラウザ方式でやり直し: ${result.message}`);
      s.message = 'ブラウザでログインして枠を選んでいます(やり直し)…';
      result = await reserve(slot, credentials, browserOptions);
    }
    return result;
  })()
    .then(async (result) => {
      s.status = 'done';
      s.result = result;
      s.message = result.message;
      log(`予約フロー終了: ${result.status} ${result.message}`);
      // 結果を LINE にも送る(ボタンを押した本人以外にも分かるように)。失敗しても結果表示には影響させない
      if (LINE.token && LINE.to && result.status !== 'dry_run') {
        try {
          await pushResult(buildResultFlex({ slot, ...result }, s.label), LINE);
          log('結果を LINE に通知しました');
        } catch (e) {
          log(`LINE 通知に失敗(無視): ${e.message}`);
        }
      }
    })
    .catch((e) => {
      s.status = 'done';
      s.result = { status: 'error', message: e.message };
      s.message = e.message;
      log(`予約フロー例外: ${e.message}`);
    })
    .finally(async () => {
      if (PROFILE_BUCKET) await saveProfile(PROFILE_BUCKET, PROFILE_DIR, (m) => log(`  ${m}`));
      setTimeout(() => {
        if (session === s) session = null;
      }, DONE_KEEP_MS);
    });
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

function waitPage(token, s) {
  return page(
    '予約の準備中',
    `<div class="card">
      <h1><span class="spinner"></span>予約の準備をしています</h1>
      <div class="slot">${esc(slotText(s.payload))}<br><span class="muted">予約者: ${esc(s.label)} / 人数: ${esc(s.payload.people || 2)}</span></div>
      <div class="muted" id="msg">${esc(s.message)}</div>
      <div class="muted" style="margin-top:12px">ログイン〜枠の選択まで自動で進めています(30〜60秒)。
      準備ができたら予約サイトの確認画面が表示されます。<br><b>表示後は数分以内に</b>「予約」を押してください(サイトの制限時間があります)。</div>
    </div>
    <script>
      const token=${JSON.stringify(token)};
      async function tick(){
        try{
          const r=await fetch('/status?token='+encodeURIComponent(token),{cache:'no-store'}); const j=await r.json();
          document.getElementById('msg').textContent=j.message||'';
          if(j.status==='ready'){location.replace('/vnc?token='+encodeURIComponent(token));return;}
          if(j.status==='done'){location.replace('/result?token='+encodeURIComponent(token));return;}
        }catch(e){}
        setTimeout(tick,1500);
      }
      tick();
    </script>`
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
<div id="hint">${
    s.mode === 'challenge'
      ? '「予約」は押しました。<b>チェックボックス</b>を押し、画像問題が出たら解いてから、もう一度<b>「予約」</b>を押してください。完了画面になると自動で結果に進みます。'
      : '人数は入力済みです。<b>「予約」</b>を押してください。「チェックを入れてから…」と出たら<b>チェックボックス</b>を押し、もう一度「予約」。完了画面になると自動で結果に進みます。'
  }</div>
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
  if (token === 'smoke' && process.env.BOOKING_SMOKE === '1') return { token, payload: session?.payload || null };
  const payload = verify(token, SECRET);
  return { token, payload };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p === '/healthz' || p === '/warmup') return send(res, 200, 'ok\n', 'text/plain');

  // 動作確認用(環境変数 BOOKING_SMOKE=1 のときだけ): 認証情報なしで Chromium を仮想ディスプレイに出し、
  // 予約サイトのトップページを noVNC で見られる状態にする(Xvfb・x11vnc・WebSocket 橋渡しの疎通確認)
  if (p === '/smoke' && process.env.BOOKING_SMOKE === '1') {
    const token = 'smoke';
    if (!session) {
      const s = { token, payload: { park: '1050', date: '2026-09-17', startHour: 15, people: 2 }, label: 'テスト', status: 'starting', message: 'ブラウザを起動中', result: null, startedAt: Date.now(), readyAt: null, finish: null };
      session = s;
      import('playwright').then(async ({ chromium }) => {
        const browser = await chromium.launch({ headless: false, args: [`--window-size=${SCREEN_W},${SCREEN_H}`, '--window-position=0,0'] });
        const pg = await (await browser.newContext({ viewport: null, locale: 'ja-JP' })).newPage();
        await pg.goto('https://kouen.sports.metro.tokyo.lg.jp/web/index.jsp', { waitUntil: 'domcontentloaded' }).catch(() => {});
        s.status = 'ready';
        s.readyAt = Date.now();
        s.finish = async () => {
          s.status = 'done';
          s.result = { status: 'abandoned', message: '動作確認を終了しました' };
          await browser.close().catch(() => {});
          setTimeout(() => { if (session === s) session = null; }, 5000);
        };
        setTimeout(() => s.finish && s.finish(), HANDOFF_TIMEOUT_MS);
      }).catch((e) => { s.status = 'done'; s.result = { status: 'error', message: e.message }; s.message = e.message; });
    }
    res.writeHead(302, { location: `/wait?token=smoke` });
    return res.end();
  }

  // noVNC のクライアント JS(単一バンドル)
  if (p === '/novnc/rfb.js') {
    if (!fs.existsSync(NOVNC_BUNDLE)) return send(res, 500, 'noVNC bundle がありません(npm run build:novnc)', 'text/plain');
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' });
    return fs.createReadStream(NOVNC_BUNDLE).pipe(res);
  }

  if (!['/book', '/wait', '/status', '/vnc', '/abort', '/result'].includes(p)) return send(res, 404, 'not found', 'text/plain');

  const { token, payload } = tokenOf(url);
  if (!payload) {
    if (p === '/status') return send(res, 403, JSON.stringify({ status: 'invalid' }), 'application/json');
    return send(res, ...simplePage('このリンクは使えません', 'リンクの期限が切れているか、正しくありません。新しい通知のボタンから開いてください。', 403));
  }

  if (p === '/book') {
    // 通知のボタンは「誰が押したか」が分からないので、予約者(A/B)をここで選ぶ。B の認証情報が無ければ A だけ
    const person = payload.person || url.searchParams.get('person');
    if (!person || !['A', 'B'].includes(person)) {
      const hasB = !!process.env.SITE_USER_B;
      const link = (who) => `/book?token=${encodeURIComponent(token)}&person=${who}`;
      return send(
        res,
        200,
        page(
          '誰の予約にしますか',
          `<div class="card"><h1>誰の予約にしますか?</h1>
           <div class="slot">${esc(slotText(payload))}<br><span class="muted">人数: ${esc(payload.people || 2)}</span></div>
           <a class="btn" href="${link('A')}">${esc(process.env.LABEL_A || 'A')} で予約</a>
           ${hasB ? `&nbsp; <a class="btn" href="${link('B')}">${esc(process.env.LABEL_B || 'B')} で予約</a>` : ''}
           <div class="muted" style="margin-top:14px">押すとログイン〜枠の選択まで自動で進み、最後の「予約」ボタンだけ自分で押します。</div></div>`
        )
      );
    }
    payload.person = person;
    // 同じ枠で終わった処理があるとき: 予約が成立していれば結果を見せる(二重予約防止)。それ以外(中止・失敗)はやり直せる
    if (session && session.token === token && session.status === 'done') {
      if (session.result?.status === 'success') {
        res.writeHead(302, { location: `/result?token=${encodeURIComponent(token)}` });
        return res.end();
      }
      session = null;
    }
    if (session && session.token !== token && session.status !== 'done') {
      return send(
        res,
        ...simplePage('ほかの予約を処理中です', `いま「${esc(slotText(session.payload))}」(${esc(session.label)})を処理しています。終わってから、もう一度ボタンを押してください。`, 409)
      );
    }
    if (!session || session.token !== token) startSession(token, payload);
    res.writeHead(302, { location: `/wait?token=${encodeURIComponent(token)}` });
    return res.end();
  }

  const s = session && session.token === token ? session : null;
  if (!s) {
    if (p === '/status') return send(res, 200, JSON.stringify({ status: 'none' }), 'application/json');
    return send(res, ...simplePage('処理が見つかりません', 'この予約の処理は始まっていないか、終了しています。通知のボタンからもう一度開いてください。', 404));
  }
  if (p === '/status') return send(res, 200, JSON.stringify({ status: s.status, message: s.message }), 'application/json');
  if (p === '/wait') return send(res, 200, s.status === 'done' ? resultPage(s) : s.status === 'ready' ? vncPage(token, s) : waitPage(token, s));
  if (p === '/vnc') return send(res, 200, s.status === 'ready' ? vncPage(token, s) : waitPage(token, s));
  if (p === '/result') return send(res, 200, s.status === 'done' ? resultPage(s) : waitPage(token, s));
  if (p === '/abort') {
    if (s.finish) s.finish('人間が中止');
    res.writeHead(302, { location: `/wait?token=${encodeURIComponent(token)}` });
    return res.end();
  }
});

// ---- WebSocket → VNC(TCP 5900) 橋渡し ----
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/websockify') return socket.destroy();
  const { token, payload } = tokenOf(url);
  if (!payload || !session || session.token !== token || session.status !== 'ready') return socket.destroy();
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
  log(`予約支援サーバー起動 port=${PORT} display=${process.env.DISPLAY || '(なし)'} 署名鍵=${SECRET ? 'あり' : 'なし!'} VNCパスワード=${VNC_PASSWORD ? 'あり' : 'なし!'}`);
});
