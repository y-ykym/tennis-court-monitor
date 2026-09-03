// ============================================================
// 高速経路: ブラウザを使わず素の HTTP で「ログイン → 空き検索 → 枠の選択」まで進め、
// その状態(Cookie と、予約内容確認画面へ進むためのフォーム値)をブラウザに引き渡す。
//
//   prepareConfirmPage(slot, credentials, { log }) → Promise<Prepared>
//   Prepared = {
//     cookies:     Playwright の context.addCookies() に渡せる形(JSESSIONID など)
//     applyFields: 予約内容確認画面へ進む POST(rsvWOpeReservedApplyAction.do)のフォーム値(週表示画面の hidden 一式 + applyFlg=1)
//     facility:    公園名(サイト表記)
//     vacant:      選択時点の空き面数
//   }
//   失敗は HttpFlowError(status: 'auth_error' | 'taken' | 'error')。error は呼び出し側で全ブラウザ方式に切り替えてよい
//
// 使う理由: reCAPTCHA v2 のチェックは人間が解く前提なので、ブラウザで最初から「自然に」操作して v3 の点数を稼ぐ意味が無い。
//   HTTP なら1リクエスト 1〜4秒 × 5回で済み、ブラウザ操作(40〜60秒)より大幅に速い。
// 通信の内訳(docs/site-notes.md「フェーズ1.5 追加調査」「フェーズ2 追加調査」):
//   1. GET  /web/index.jsp                            セッション Cookie
//   2. POST /web/rsvWTransUserLoginAction.do           ログイン画面(loginJKey)
//   3. POST /web/rsvWUserAttestationLoginAction.do     ログイン(hidden 一式 + userId + password + loginCharPass×N)
//   4. POST /web/rsvWOpeInstSrchVacantAction.do        空き検索(週表示画面。hidden 一式を控える)
//   5. POST /web/rsvWOpeInstSrchVacantAjaxAction.do    週データ JSON(対象セルの空き・tzoneNo・endTime を得る)
//   6. POST /web/rsvWOpeInstReservAjaxAction.do        セルの選択(セッション上の選択状態をオンにする)
// 書き込みはここまで(予約の確定はしない)。
// ============================================================

const BASE_URL = 'https://kouen.sports.metro.tokyo.lg.jp';
const HOST = 'kouen.sports.metro.tokyo.lg.jp';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const PURPOSE = { clPpscd: '1000_1030', clsCd: '1000', cd: '1030' };
const REQUEST_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3;
const LOGGED_IN_MARKER = 'gRsvWTransUserAttestationEndAction);';

export class HttpFlowError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createSession(log) {
  const cookies = new Map();
  async function request(pathname, form) {
    const started = Date.now();
    const headers = { 'user-agent': USER_AGENT };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE_URL + pathname, {
      method: form ? 'POST' : 'GET',
      headers,
      body: form ? new URLSearchParams(form).toString() : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const body = new TextDecoder('shift_jis').decode(await res.arrayBuffer());
    log(`${form ? 'POST' : 'GET'} ${pathname.replace('/web/', '')} ${res.status} ${Date.now() - started}ms`);
    if (!res.ok) {
      const e = new HttpFlowError('error', `HTTP ${res.status}: ${pathname}`);
      e.httpStatus = res.status;
      throw e;
    }
    return body;
  }
  request.cookies = cookies;
  return request;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// form 内の hidden input を { name: value } に(同名は後勝ち)
export function hiddenFields(html) {
  const out = {};
  const re = /<input[^>]*type="hidden"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const name = m[0].match(/name="([^"]*)"/)?.[1];
    if (!name) continue;
    out[name] = decodeEntities(m[0].match(/value="([^"]*)"/)?.[1] ?? '');
  }
  return out;
}

const hiddenValue = (html, name) => html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`))?.[1] ?? null;
const pageId = (html) => html.slice(0, 500).match(/<!-- (\w+\.jsp) -->/)?.[1] ?? null;

function ymdOf(date) {
  return date.replace(/-/g, '');
}

async function attempt(slot, credentials, log) {
  const request = createSession(log);
  const ymd = ymdOf(slot.date);
  const startTime = Number(slot.startHour) * 100;

  // 1. トップ
  const top = await request('/web/index.jsp');
  if (!top.includes('rsvWTransUserLoginAction')) throw new HttpFlowError('error', 'トップページが想定外です(メンテナンス中の可能性)');

  // 2. ログイン画面
  const loginPage = await request('/web/rsvWTransUserLoginAction.do', { displayNo: 'pawab2000', displayNoFrm: 'pawab2000' });
  if (pageId(loginPage) !== 'pawab2100.jsp' || !hiddenValue(loginPage, 'loginJKey')) throw new HttpFlowError('error', 'ログイン画面が想定外です');
  if (/gRecaptchaActive\s*=\s*true/.test(loginPage)) {
    // ログインに reCAPTCHA トークンが必要 → HTTP では進めない(ブラウザ方式に切り替える)
    throw new HttpFlowError('error', 'ログイン画面で reCAPTCHA が有効のため HTTP ではログインできません');
  }

  // 3. ログイン
  const form = hiddenFields(loginPage);
  const body = new URLSearchParams(form);
  body.set('userId', credentials.userId);
  body.set('password', credentials.password);
  for (const ch of credentials.password) body.append('loginCharPass', ch);
  let home;
  try {
    home = await request('/web/rsvWUserAttestationLoginAction.do', body);
  } catch (e) {
    // 利用者番号の形式不正などではサイトが 302 を返す。認証系の失敗として扱い、やり直さない
    if (e.httpStatus === 302) throw new HttpFlowError('auth_error', 'ログインが受け付けられませんでした(利用者番号の形式・パスワードを確認)');
    throw e;
  }
  if (pageId(home) === 'pawab2100.jsp') {
    const alert = home.match(/showAlert\(["']([^"']{1,120})/)?.[1] ?? '';
    if (/データ通信|時間をあけ|再度操作/.test(alert)) throw new HttpFlowError('error', `ログイン時にサイトの一時エラー: ${alert}`);
    throw new HttpFlowError('auth_error', `ログインが拒否されました(利用者番号・パスワード・カード有効期限を確認) ${alert}`);
  }
  if (!home.includes(LOGGED_IN_MARKER)) throw new HttpFlowError('error', `ログイン後の画面が想定外です (${pageId(home) ?? '不明'})`);

  // 4. 空き検索(週表示画面)
  const week = await request('/web/rsvWOpeInstSrchVacantAction.do', {
    displayNo: 'pawab2000',
    daystarthome: slot.date,
    daystart: slot.date,
    selectPpsClPpscd: PURPOSE.clPpscd,
    selectPpsClsCd: PURPOSE.clsCd,
    selectPpsCd: PURPOSE.cd,
    selectAreaBcd: slot.park,
    selectBldCd: '',
    selectIcd: '0',
    dayofweekClearFlg: '1',
    timezoneClearFlg: '1',
  });
  const instCd = hiddenValue(week, 'selectInstCd');
  if (pageId(week) !== 'prwrc2000.jsp' || hiddenValue(week, 'selectBldCd') !== slot.park || !instCd) {
    throw new HttpFlowError('error', `検索結果画面が想定外です (${pageId(week) ?? '不明'}, 公園=${hiddenValue(week, 'selectBldCd')})`);
  }
  const facility = decodeEntities(hiddenValue(week, 'selectBldName') || '') || slot.park;

  // 5. 週データ JSON から対象セル
  const json = JSON.parse(
    await request('/web/rsvWOpeInstSrchVacantAjaxAction.do', {
      displayNo: 'prwrc2000',
      useDay: ymd,
      bldCd: slot.park,
      instCd,
      transVacantMode: '0',
      clearFlag: '0',
    }).catch(() => '{}')
  );
  if (!json.result) throw new HttpFlowError('error', '週データが取得できませんでした(セッション未認識の可能性)');
  let cell = null;
  let tzoneNo = null;
  for (const row of json.result) {
    for (const c of row.timeResult || []) {
      if (String(c.useDay) === ymd && Number(c.startTime) === startTime) {
        cell = c;
        tzoneNo = row.tzoneNo;
      }
    }
  }
  if (!cell) throw new HttpFlowError('error', `対象の枠 ${ymd} ${slot.startHour}時 が週データにありません`);
  if (cell.alt !== '空き' || Number(cell.rsvNum) < 1) throw new HttpFlowError('taken', `その枠は空きではありませんでした(${cell.alt})`);

  // 6. セルを選択(ブラウザの setReserv() と同じ Ajax)
  const sel = JSON.parse(
    await request('/web/rsvWOpeInstReservAjaxAction.do', {
      displayNo: 'prwrc2000',
      bldCd: slot.park,
      instCd,
      useDay: ymd,
      startTime: String(cell.startTime),
      endTime: String(cell.endTime),
      tzoneNo: String(tzoneNo),
      akiNum: String(cell.rsvNum),
      selectNum: String(cell.selectNum ?? 0),
    }).catch(() => '{}')
  );
  if (Number(sel.selectNum) !== 1) throw new HttpFlowError('error', `枠の選択が反映されませんでした (${JSON.stringify(sel).slice(0, 120)})`);

  // 予約内容確認画面へ進む POST の値(ブラウザの checkSelect() が送るものと同じ: form1 の hidden 一式 + applyFlg=1)
  const applyFields = { ...hiddenFields(week), daystart: slot.date, applyFlg: '1', selectSize: String(sel.selectState ?? 1) };

  const cookies = [...request.cookies].map(([name, value]) => ({
    name,
    value,
    domain: HOST,
    path: name === 'JSESSIONID' ? '/web' : '/',
    secure: true,
    httpOnly: name === 'JSESSIONID',
    sameSite: 'None',
  }));
  return { cookies, applyFields, facility, vacant: Number(cell.rsvNum) };
}

export async function prepareConfirmPage(slot, credentials, { log = () => {} } = {}) {
  if (!credentials?.userId || !credentials?.password) throw new HttpFlowError('auth_error', '利用者番号またはパスワードが未設定です');
  let last;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const started = Date.now();
    try {
      const prepared = await attempt(slot, credentials, log);
      log(`HTTP で枠選択まで完了 (${n}回目, ${Date.now() - started}ms, 空き${prepared.vacant}面)`);
      return prepared;
    } catch (e) {
      last = e instanceof HttpFlowError ? e : new HttpFlowError('error', e.message);
      if (last.status !== 'error') throw last;
      log(`HTTP 経路の失敗 (${n}回目): ${last.message}`);
    }
  }
  throw last;
}
