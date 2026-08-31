// ============================================================
// 東京都スポーツ施設予約システムから、テニス(人工芝)の空き状況を取得して
// 「Slotの配列」で返す。
//
// ---- 契約(この形を必ず守る。check.js側はこの形を前提に動く) ----
//
//   async function scrapeAvailability(): Promise<Slot[]>
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

const BASE_URL = 'https://kouen.sports.metro.tokyo.lg.jp';

// 種目: テニス（人工芝） (select値 "1000_1030" = 分類コード_種目コード)
const PURPOSE = { clPpscd: '1000_1030', clsCd: '1000', cd: '1030' };

// 週表示(7日)を5回読めば当日から35日分 ≒ 1ヶ月をカバーできる
const WEEKS_PER_PARK = 5;

const TIMEOUT_MS = 30000;
// 連続リクエストの間に置く小休止(サイトへの負荷配慮)
const REQUEST_INTERVAL_MS = 300;
const DEBUG_DIR = path.join(__dirname, '..', 'debug');

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 実行環境のタイムゾーンに依存せず、JSTでの「今日」を "YYYYMMDD" で返す
function jstTodayYmd() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// "YYYYMMDD" に日数を加算して "YYYYMMDD" を返す
function addDays(ymd, days) {
  const dt = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  dt.setUTCDate(dt.getUTCDate() + days);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// 時刻コード(900, 1100, 1900など)→ "09:00"
function formatTime(code) {
  const h = String(Math.floor(code / 100)).padStart(2, '0');
  const m = String(code % 100).padStart(2, '0');
  return `${h}:${m}`;
}

function saveDebugResponse(label, body) {
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

// 1公園分: 検索条件をセッションに載せ、週JSONを5週分取得する
async function scrapePark(request, park, fromYmd) {
  const fromIso = `${fromYmd.slice(0, 4)}-${fromYmd.slice(4, 6)}-${fromYmd.slice(6, 8)}`;

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

  const slots = [];
  for (let week = 0; week < WEEKS_PER_PARK; week++) {
    const useDay = addDays(fromYmd, week * 7);
    const body = await request('/web/rsvWOpeInstSrchVacantAjaxAction.do', {
      displayNo: 'prwrc2000',
      useDay,
      bldCd: park.code,
      instCd,
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

    // result: 時間帯ごとの行 / timeResult: 7日分のセル。
    // alt="空き"(画面の🟣)のセルだけが空き枠で、rsvNumが空き面数
    for (const row of json.result || []) {
      for (const cell of row.timeResult || []) {
        if (cell.alt !== '空き') continue;
        const ymd = String(cell.useDay);
        slots.push({
          facility,
          date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
          time: `${formatTime(cell.startTime)}-${formatTime(cell.endTime)}`,
          count: Number(cell.rsvNum),
        });
      }
    }
  }
  return slots;
}

async function scrapeAvailability() {
  const fromYmd = jstTodayYmd();
  const slots = [];

  for (const park of PARKS) {
    // サーバ側が一時的に不安定なことがわりとある(502や、セッション未認識のまま
    // 検索条件が載らない応答)。公園単位で新しいセッションからやり直す
    const MAX_ATTEMPTS = 3;
    let parkSlots;
    for (let attempt = 1; ; attempt++) {
      const request = createSession();
      try {
        // トップページでセッションCookieを取得(メンテナンス中はここで検索画面が返らない)
        const top = await request('/web/index.jsp');
        if (!top.includes('rsvWOpeInstSrchVacantAction')) {
          saveDebugResponse('top', top);
          throw new Error('トップページが想定外です(メンテナンス中の可能性)');
        }
        parkSlots = await scrapePark(request, park, fromYmd);
        break;
      } catch (e) {
        if (attempt >= MAX_ATTEMPTS) throw new Error(`${park.name} の取得に失敗: ${e.message}`);
        console.log(`${park.name}: 取得をやり直します (${e.message})`);
      }
    }
    slots.push(...parkSlots);
  }

  // 念のため重複除去(同一 施設×日付×時間帯 は1件に)
  const seen = new Set();
  return slots.filter((s) => {
    const key = `${s.facility}|${s.date}|${s.time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { scrapeAvailability };
