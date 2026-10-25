// ============================================================
// 東京都スポーツ施設予約システムから、テニス(人工芝)の空き状況を取得して
// 「Slotの配列」で返す。
//
// ---- 契約(この形を必ず守る。check.js側はこの形を前提に動く) ----
//
//   async function scrapeAvailability(): Promise<Slot[]>
//     公園ごとに新しいセッションで 4 週を順番に取る(GitHub Actions の空き通知用)
//   function createPersistentScraper(options): () => Promise<Slot[]>
//     公園 × 週 のセッションを持ち続け、毎回は週の JSON だけを同時に取る(Pi の自動予約用。約 10 秒。詳細は末尾)
//
//   Slot = {
//     facility: string,  // 施設名(サイト表記のまま。例 "猿江恩賜公園")
//     date:     string,  // "YYYY-MM-DD"
//     time:     string,  // 時間帯(サイト表記のまま。例 "19:00-21:00")
//     count:    number   // 空き面数(🟣とともに表示される数字)
//   }
//
// ---- 実装方式 ----
// ブラウザ(Playwright)は使わず、サイトの週表示カレンダーが内部で使っている
// JSON API を素のHTTPで叩く。サイト構造・APIの調査結果は docs/site-notes.md を参照。
//
//   1. GET  /web/index.jsp                          … セッションCookie取得
//   2. POST /web/rsvWOpeInstSrchVacantAction.do     … 検索条件をセッションに載せる(公園ごと)
//   3. POST /web/rsvWOpeInstSrchVacantAjaxAction.do … 1週間分の空き状況JSON(週送りはuseDay+7日)
//
// ログイン・予約等の書き込み操作は一切しない(読み取りのみ)。
// 失敗時(メンテナンス画面・想定外の応答)は debug/ にレスポンスを保存してから throw する
// → check.js が捕まえて「スキップ」として静かに処理し、GitHub Actionsがartifactとして回収する。
// ============================================================
const fs = require('fs');
const path = require('path');
const { PARKS } = require('./config'); // 監視対象の公園(name, code)
const { jstTodayYmd, addDays, ymdToIso } = require('./date');

const BASE_URL = 'https://kouen.sports.metro.tokyo.lg.jp';

// 種目: テニス（人工芝） (select値 "1000_1030" = 分類コード_種目コード)
const PURPOSE = { clPpscd: '1000_1030', clsCd: '1000', cd: '1030' };

// 週表示(7日)を4回読んで当日から28日分をカバーする(2026-09-15 に 5 週 → 4 週へ。相手のサーバーへの負荷を 2 割減らす)
const WEEKS_PER_PARK = 4;

const TIMEOUT_MS = 30000;
// 連続リクエストの間に置く小休止(サイトへの負荷配慮)
const REQUEST_INTERVAL_MS = 300;
// 失敗時のレスポンス保存先。環境変数 SCRAPE_DEBUG_DIR で変えられる(空文字なら保存しない。Pi の 1 分周期でファイルを溜めないため)
const DEBUG_DIR = process.env.SCRAPE_DEBUG_DIR !== undefined ? process.env.SCRAPE_DEBUG_DIR : path.join(__dirname, '..', 'debug');
// 「想定外の応答」の最新 1 件だけを残すファイル(上書き。Pi 用。空なら残さない)。
// サイトのメンテナンス中に何が返るかは 2026-09-27 時点で一度も記録が無く、確実なメンテ判定を作れない。
// 本物のメンテナンスが来たときに実物を残す目的(Pi の docker-compose.yml で /var/lib/booking/last-scrape-failure.html)
const LAST_FAILURE_FILE = process.env.SCRAPE_LAST_FAILURE_FILE || '';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 時刻コード(900, 1100, 1900など)→ "09:00"
function formatTime(code) {
  const h = String(Math.floor(code / 100)).padStart(2, '0');
  const m = String(code % 100).padStart(2, '0');
  return `${h}:${m}`;
}

function saveDebugResponse(label, body) {
  if (LAST_FAILURE_FILE) {
    try {
      fs.writeFileSync(LAST_FAILURE_FILE, `<!-- saved ${new Date().toISOString()} label=${label} -->\n${body}`);
    } catch (e) {
      console.error(`想定外の応答の保存に失敗: ${e.message}`);
    }
  }
  if (!DEBUG_DIR) return;
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(DEBUG_DIR, `error-${stamp}-${label}.html`);
    fs.writeFileSync(file, body);
    console.error(`デバッグ用にレスポンスを保存しました: ${file}`);
  } catch (e) {
    console.error(`レスポンス保存に失敗: ${e.message}`);
  }
}

// Cookie(JSESSIONID)を持ち回る簡易HTTPセッション。
// レスポンスはShift_JIS(Windows-31J)なのでデコードして文字列で返す
function createSession() {
  const cookies = new Map();
  return async function request(pathname, form) {
    await sleep(REQUEST_INTERVAL_MS);
    const headers = { 'user-agent': USER_AGENT };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (cookies.size > 0) {
      headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const res = await fetch(BASE_URL + pathname, {
      method: form ? 'POST' : 'GET',
      headers,
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const body = new TextDecoder('shift_jis').decode(await res.arrayBuffer());
    if (!res.ok) {
      saveDebugResponse(`http${res.status}`, body);
      throw new Error(`HTTP ${res.status}: ${pathname}`);
    }
    return body;
  };
}

// hidden input の value を取り出す(属性順は name → value で固定されている)
function hiddenValue(html, name) {
  const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`));
  return m ? m[1] : null;
}

// セッションを用意する: トップページで Cookie を取り、検索条件(公園・種目)をセッションに載せる。
// 返り値 { request, instCd, facility } を fetchWeek に渡す。メンテナンス画面・想定外の応答は throw
async function openSession(park, fromYmd, makeSession = createSession) {
  const request = makeSession();
  // トップページでセッションCookieを取得(メンテナンス中はここで検索画面が返らない)
  const top = await request('/web/index.jsp');
  if (!top.includes('rsvWOpeInstSrchVacantAction')) {
    saveDebugResponse('top', top);
    throw new Error('トップページが想定外です(メンテナンス中の可能性)');
  }
  const fromIso = ymdToIso(fromYmd);
  // 検索実行(ブラウザでの「検索」ボタンに相当)。以降のAjaxはこのセッション状態が前提
  const searchHtml = await request('/web/rsvWOpeInstSrchVacantAction.do', {
    displayNo: 'pawab2000',
    daystarthome: fromIso,
    daystart: fromIso,
    selectPpsClPpscd: PURPOSE.clPpscd,
    selectPpsClsCd: PURPOSE.clsCd,
    selectPpsCd: PURPOSE.cd,
    selectAreaBcd: park.code,
    selectBldCd: '',
    selectIcd: '0',
    dayofweekClearFlg: '1',
    timezoneClearFlg: '1',
  });

  // 検索結果画面のhiddenから施設コードと施設名(サイト表記)を得る。
  // 取れない場合はメンテナンス画面やエラー画面とみなす
  const instCd = hiddenValue(searchHtml, 'selectInstCd');
  const bldCd = hiddenValue(searchHtml, 'selectBldCd');
  const facility = hiddenValue(searchHtml, 'selectBldName') || park.name;
  if (!instCd || bldCd !== park.code) {
    saveDebugResponse(park.code, searchHtml);
    throw new Error(`検索結果画面が想定外です (公園:${park.name})`);
  }
  return { request, instCd, facility };
}

// 1 週分(fromYmd から week 週目)の空き状況 JSON を取り、空きセルだけ Slot にして返す。
// 同じセッションに同時に 2 本以上投げてはいけない(都サイトは片方しか処理せず、中身 0 バイトの 200 を返す。2026-10-25 実測)
async function fetchWeek(session, park, fromYmd, week) {
  const useDay = addDays(fromYmd, week * 7);
  const body = await session.request('/web/rsvWOpeInstSrchVacantAjaxAction.do', {
    displayNo: 'prwrc2000',
    useDay,
    bldCd: park.code,
    instCd: session.instCd,
    transVacantMode: '0',
    clearFlag: '0',
  });

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    // JSONでない = エラー画面(セッション切れ・メンテナンス等)
    saveDebugResponse(`${park.code}-week${week}`, body);
    throw new Error(`週データがJSONではありません (公園:${park.name} useDay:${useDay})`);
  }

  // result: 時間帯ごとの行 / timeResult: 7日分のセル。正常な応答なら空きが無くても行(時間帯)は必ずある。
  // 行が無い・配列でない = セッション未認識などの不完全な応答とみなし、やり直す
  // (黙って 0 件扱いにすると、次回その週の空きが「新しく出た」と誤検出され、二重通知や自動予約の誤動作につながる)
  if (!Array.isArray(json.result) || json.result.length === 0) {
    saveDebugResponse(`${park.code}-week${week}-empty`, body);
    throw new Error(`週データに時間帯の行がありません (公園:${park.name} useDay:${useDay})`);
  }
  const slots = [];
  // alt="空き"(画面の🟣)のセルだけが空き枠で、rsvNumが空き面数
  for (const row of json.result) {
    for (const cell of row.timeResult || []) {
      if (cell.alt !== '空き') continue;
      slots.push({
        facility: session.facility,
        date: ymdToIso(String(cell.useDay)),
        time: `${formatTime(cell.startTime)}-${formatTime(cell.endTime)}`,
        count: Number(cell.rsvNum),
      });
    }
  }
  return slots;
}

// 1公園分: 検索条件をセッションに載せ、週JSONを WEEKS_PER_PARK 週分、順番に取得する
async function scrapePark(session, park, fromYmd) {
  const slots = [];
  for (let week = 0; week < WEEKS_PER_PARK; week++) {
    slots.push(...(await fetchWeek(session, park, fromYmd, week)));
  }
  return slots;
}

// 1 公園分を、新しいセッションから最大 MAX_ATTEMPTS 回やり直しつつ取る
const MAX_ATTEMPTS = 3;
async function scrapeParkWithRetry(park, fromYmd) {
  // サーバ側が一時的に不安定なことがわりとある(502や、セッション未認識のまま
  // 検索条件が載らない応答)。公園単位で新しいセッションからやり直す
  for (let attempt = 1; ; attempt++) {
    try {
      const session = await openSession(park, fromYmd);
      return await scrapePark(session, park, fromYmd);
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`${park.name} の取得に失敗: ${e.message}`);
      console.log(`${park.name}: 取得をやり直します (${e.message})`);
    }
  }
}

// 念のため重複除去(同一 施設×日付×時間帯 は1件に)
function dedupe(slots) {
  const seen = new Set();
  return slots.filter((s) => {
    const key = `${s.facility}|${s.date}|${s.time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// options.concurrency: 同時に取る公園の数(既定 1 = 従来どおり順番に)。
// 公園ごとに新しいセッションを作り、4 週を順番に取る(1 公園 6 通信・約 40〜50 秒)。GitHub Actions の空き通知(check.js)はこれ。
// 公園ごとに別セッションなので互いに干渉しない
async function scrapeAvailability({ concurrency = 1 } = {}) {
  const fromYmd = jstTodayYmd();
  const slots = [];
  const n = Math.max(1, Math.min(Number(concurrency) || 1, PARKS.length));
  for (let i = 0; i < PARKS.length; i += n) {
    const results = await Promise.all(PARKS.slice(i, i + n).map((park) => scrapeParkWithRetry(park, fromYmd)));
    for (const r of results) slots.push(...r);
  }
  return dedupe(slots);
}

// ---- 週別セッションを持ち続ける取り方(フェーズ3 の Pi 用。2026-10-25) ----
// 公園 × 週 = 12 本のセッションを作って持ち続け、毎回の照会では各セッションで自分の週の JSON を 1 本だけ取る(12 本同時)。
// トップページと検索はセッションを作るときだけなので、1 回の照会は 18 通信・約 50 秒 → 12 通信・約 10 秒になる
// (2026-10-25 の実測: 順番取り 40 秒、週別セッションの初回 20 秒、使い回し 10 秒。結果は順番取りと一致)。
// セッションを作り直すのは、(1) 応答が JSON でない・空・HTTP エラーのとき、(2) 作ってから SESSION_MAX_AGE_MS たったとき、
// (3) 日付が変わったとき(検索条件の開始日が前日のままになるため)。失敗は従来どおり最大 MAX_ATTEMPTS 回やり直し、
// だめなら照会全体を失敗にする(auto-runner が「空き照会に失敗」として扱い、連続すれば間隔を広げる)。
// 都サイトのセッションは放置 10 分で切れる(docs/site-notes.md)。照会は 1〜3 分おきなので切れないが、念のため 30 分で作り直す。
const SESSION_MAX_AGE_MS = 30 * 60 * 1000;
// 前回使ってからこの時間たったセッションも作り直す(都サイトは放置 10 分で切れる。連続失敗で照会間隔が 10〜15 分に広がったあと、
// 12 本全部が週 JSON で一度失敗してから作り直す無駄を避ける)
const SESSION_IDLE_MAX_MS = 8 * 60 * 1000;

function createPersistentScraper({
  parks = PARKS,
  weeksPerPark = WEEKS_PER_PARK,
  concurrency = 0, // 同時に投げる本数。0 = 全部(公園数 × 週数)
  sessionMaxAgeMs = SESSION_MAX_AGE_MS,
  sessionIdleMaxMs = SESSION_IDLE_MAX_MS,
  maxAttempts = MAX_ATTEMPTS,
  createSession: makeSession = createSession, // テスト用の差し替え
  now = Date.now,
  todayYmd = jstTodayYmd,
  log = console.log,
} = {}) {
  const pool = new Map(); // `${公園コード}|${週}` → { request, instCd, facility, createdAt, fromYmd }
  let created = 0;
  // 1 回の照会の中でセッション作成(トップ + 検索)に失敗した回数。メンテナンス中などサイト全体が落ちているときに
  // 12 本 × 3 回 = 最大 72 通信を投げないよう、この回数に達したら残りはやり直さずにその照会を失敗にする
  const MAX_OPEN_FAILURES_PER_POLL = 3;

  async function fetchOne(park, week, fromYmd, state) {
    const key = `${park.code}|${week}`;
    for (let attempt = 1; ; attempt++) {
      let session = pool.get(key);
      if (session && (now() - session.createdAt > sessionMaxAgeMs || now() - session.usedAt > sessionIdleMaxMs || session.fromYmd !== fromYmd)) {
        pool.delete(key);
        session = null;
      }
      let opening = false;
      try {
        if (!session) {
          if (state.openFailures >= MAX_OPEN_FAILURES_PER_POLL) {
            throw new Error(`${park.name} の取得に失敗: この照会でセッションの用意に ${state.openFailures} 回失敗したため打ち切り(メンテナンス中の可能性)`);
          }
          opening = true;
          session = { ...(await openSession(park, fromYmd, makeSession)), createdAt: now(), usedAt: now(), fromYmd };
          opening = false;
          pool.set(key, session);
          created++;
        }
        session.usedAt = now();
        try {
          return await fetchWeek(session, park, fromYmd, week);
        } catch (e) {
          // 「時間帯の行がありません」(result が空)はセッションを失ったときだけでなく一時的にも起きる(2026-10-26 未明に 65 回中 23 回)。
          // 捨てて作り直す(トップ + 検索 + 週 = 3 通信)前に、同じセッションでもう 1 回だけ取り直す(1 通信)
          if (!/時間帯の行がありません/.test(e.message)) throw e;
          try {
            const slots = await fetchWeek(session, park, fromYmd, week);
            log(`${park.name} ${week + 1} 週目: 空の応答のあと同じセッションで取り直して成功`);
            return slots;
          } catch (e2) {
            throw e2;
          }
        }
      } catch (e) {
        pool.delete(key); // 失敗したセッションは捨てて次は新しく作る
        if (opening) state.openFailures++;
        if (attempt >= maxAttempts || state.openFailures >= MAX_OPEN_FAILURES_PER_POLL) {
          throw new Error(e.message.includes('の取得に失敗') ? e.message : `${park.name} の取得に失敗: ${e.message}`);
        }
        log(`${park.name} ${week + 1} 週目: 取得をやり直します (${e.message})`);
      }
    }
  }

  async function scrape() {
    const fromYmd = todayYmd();
    const tasks = [];
    for (const park of parks) for (let week = 0; week < weeksPerPark; week++) tasks.push({ park, week });
    const n = concurrency > 0 ? Math.min(concurrency, tasks.length) : tasks.length;
    const results = new Array(tasks.length);
    const errors = [];
    const state = { openFailures: 0 };
    let next = 0;
    // n 本の「取り手」が仕事の山から順に取る。1 本が失敗しても他は最後まで待つ
    // (途中で投げ出すと、進行中の通信が次の照会と同じセッションで重なり、空の応答になるため)
    const worker = async () => {
      while (next < tasks.length) {
        const i = next++;
        try {
          results[i] = await fetchOne(tasks[i].park, tasks[i].week, fromYmd, state);
        } catch (e) {
          errors.push(e);
        }
      }
    };
    await Promise.all(Array.from({ length: n }, worker));
    if (errors.length > 0) throw errors[0];
    return dedupe(results.flat());
  }
  // 集計・テスト用: 持っているセッション数と、これまでに作った本数
  scrape.stats = () => ({ sessions: pool.size, created });
  return scrape;
}

module.exports = { scrapeAvailability, createPersistentScraper };
