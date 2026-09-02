// ============================================================
// 予約サイト(東京都スポーツ施設予約システム)にログインして「予約の確認」一覧を取る。
//
//   fetchReservations({ userId, password }, { signal }) → Promise<Reservation[]>
//
//   Reservation = {
//     id:       string,  // 予約番号
//     date:     string,  // "YYYY-MM-DD"
//     start:    string,  // "HH:MM"
//     end:      string,  // "HH:MM"
//     facility: string,  // 公園名(サイト表記。例 "猿江恩賜公園")
//     purpose:  string,  // 種目(例 "テニス（人工芝）")
//     status:   string,  // 支払状況(例 "支払前")。この画面に載るのは有効な予約のみ
//   }
//
// 通信の流れ(調査記録は docs/site-notes.md「フェーズ1.5 追加調査」):
//   1. GET  /web/index.jsp                             セッションCookie
//   2. POST /web/rsvWTransUserLoginAction.do            ログイン画面(loginJKey を取る)
//   3. POST /web/rsvWUserAttestationLoginAction.do      ログイン実行
//   4. POST /web/rsvWGetCancelRsvDataAction.do          予約の確認・取消画面(一覧をHTMLで含む)
//   5. POST /web/rsvWTransUserAttestationEndAction.do   ログアウト(失敗しても無視)
//
// 読み取り専用。キャンセル・予約・抽選など書き込み操作は一切送らない
// (rsvWCancelRsvAction / selectCancel=1 を送ってはいけない)。
//
// サイトの癖への対策(lib/scrape.js と同じ考え方):
//   - レスポンスは Shift_JIS → TextDecoder('shift_jis')
//   - 一時的な 502 や、セッション未認識のまま 200 でホームが返るパターンがある
//     → 新しいセッションからやり直す(最大 MAX_ATTEMPTS 回)。ただし認証エラーはリトライしない
//   - ログに利用者番号・パスワード・Cookie を出さない
// ============================================================

const BASE_URL = 'https://kouen.sports.metro.tokyo.lg.jp';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// 新セッションからのやり直し回数(初回込み)。LINE reply の1分制限があるので少なめ
const MAX_ATTEMPTS = 3;
// 1リクエストの上限
const REQUEST_TIMEOUT_MS = 15000;

// 認証そのものの失敗(パスワード誤り・カード期限切れ・reCAPTCHA有効化など)。
// リトライしても直らず、繰り返すとアカウントロックの恐れがあるため即座に諦める
export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

// Cookie(JSESSIONID)を持ち回る簡易セッション。応答は Shift_JIS をデコードした文字列。
// log には「メソッド パス ステータス 所要時間」だけを出す(Cookie や送信内容は出さない)
function createSession(signal, log) {
  const cookies = new Map();
  async function request(pathname, form, useSignal = signal) {
    const started = Date.now();
    const headers = { 'user-agent': USER_AGENT };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (cookies.size > 0) {
      headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await fetch(BASE_URL + pathname, {
      method: form ? 'POST' : 'GET',
      headers,
      body: form ? form.toString() : undefined,
      redirect: 'manual',
      signal: useSignal && typeof AbortSignal.any === 'function' ? AbortSignal.any([useSignal, timeout]) : useSignal || timeout,
    });
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const body = new TextDecoder('shift_jis').decode(await res.arrayBuffer());
    log(`${form ? 'POST' : 'GET'} ${pathname.replace('/web/', '')} ${res.status} ${Date.now() - started}ms`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${pathname}`);
    return body;
  }
  // タイムアウト用 signal に縛られない版(返信後のログアウトに使う)
  request.withoutSignal = (pathname, form) => request(pathname, form, null);
  return request;
}

// hidden input を全部 URLSearchParams に(ブラウザが送るのと同じ内容にするため)
function hiddenFields(html) {
  const params = new URLSearchParams();
  const re = /<input[^>]*type="hidden"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const name = m[0].match(/name="([^"]*)"/)?.[1];
    if (!name) continue;
    const value = m[0].match(/value="([^"]*)"/)?.[1] ?? '';
    params.append(name, decodeEntities(value));
  }
  return params;
}

function hiddenValue(html, name) {
  return html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`))?.[1] ?? null;
}

// 画面種別(JSPファイル名)。応答先頭付近の <!-- xxx.jsp --> コメント
function pageId(html) {
  return html.slice(0, 300).match(/<!-- (\w+\.jsp) -->/)?.[1] ?? null;
}

// ログイン済み画面にだけある「ログアウト」リンク
const LOGGED_IN_MARKER = 'gRsvWTransUserAttestationEndAction);';

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// "9月6日(日曜)2026年" → "2026-09-06"("2026年9月6日" 形式にも対応)
function parseDate(text) {
  const iso = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  let m = text.match(/(\d{4})年\s*(\d{1,2})月(\d{1,2})日/);
  if (m) return iso(m[1], m[2], m[3]);
  m = text.match(/(\d{1,2})月(\d{1,2})日[^0-9]*(\d{4})年/);
  if (m) return iso(m[3], m[1], m[2]);
  return null;
}

// "19時00分～21時00分" → ["19:00", "21:00"]
function parseTimeRange(text) {
  const m = text.match(/(\d{1,2})時(\d{2})分\s*[～〜~-]\s*(\d{1,2})時(\d{2})分/);
  if (!m) return [null, null];
  return [`${m[1].padStart(2, '0')}:${m[2]}`, `${m[3].padStart(2, '0')}:${m[4]}`];
}

// 予約の確認・取消画面(prwha1000.jsp)の HTML から予約を取り出す。
// 一覧の各行に埋め込まれた詳細モーダル(id="rsvDetailN")内の項目名付きの表を読む。
// HTML全文を一気に正規表現で舐めず、モーダルごとの短い断片だけを処理する(Workers の CPU 制限対策)
export function parseReservations(html) {
  const reservations = [];
  const re = /id="rsvDetail\d+"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const from = html.indexOf('<table', m.index);
    if (from < 0) break;
    const to = html.indexOf('</table>', from);
    const chunk = html.slice(from, to < 0 ? undefined : to);
    const fields = {};
    const rowRe = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
    let r;
    while ((r = rowRe.exec(chunk)) !== null) {
      fields[stripTags(r[1])] = stripTags(r[2]);
    }
    if (!fields['利用日']) continue;
    const [start, end] = parseTimeRange(fields['時間'] || '');
    // "猿江恩賜公園 テニス（人工芝）" → 公園名と種目に分ける(&nbsp; 区切り)
    const place = (fields['公園・施設'] || '').split(' ');
    reservations.push({
      id: fields['予約番号'] || '',
      date: parseDate(fields['利用日']),
      start,
      end,
      facility: place[0] || '',
      purpose: fields['利用目的'] || place.slice(1).join(' ') || '',
      status: fields['支払状況'] || '',
    });
  }
  return reservations;
}

// 1回分の試行: 新セッションでログイン → 一覧取得 → ログアウト。
// deferLogout が渡された場合、ログアウトは待たずに関数として渡す(返信を先に送るため)
async function attempt({ userId, password }, { signal, log, deferLogout }) {
  const request = createSession(signal, log);

  // 1. トップ(メンテナンス中は検索画面が無い)
  const top = await request('/web/index.jsp');
  if (!top.includes('rsvWTransUserLoginAction')) {
    throw new Error('トップページが想定外です(メンテナンス中の可能性)');
  }

  // 2. ログイン画面(loginJKey を含む hidden 一式を取る)
  const loginPage = await request(
    '/web/rsvWTransUserLoginAction.do',
    new URLSearchParams({ displayNo: 'pawab2000', displayNoFrm: 'pawab2000' })
  );
  if (pageId(loginPage) !== 'pawab2100.jsp' || !hiddenValue(loginPage, 'loginJKey')) {
    throw new Error('ログイン画面が想定外です');
  }
  if (/gRecaptchaActive\s*=\s*true/.test(loginPage)) {
    throw new AuthError('ログイン画面で reCAPTCHA が有効になっており、自動ログインできません');
  }

  // 3. ログイン実行(ブラウザの submitLogin() と同じ: hidden一式 + userId + password + 1文字ずつの loginCharPass)
  const form = hiddenFields(loginPage);
  form.set('userId', userId);
  form.set('password', password);
  for (const ch of password) form.append('loginCharPass', ch);
  const home = await request('/web/rsvWUserAttestationLoginAction.do', form);
  const homeId = pageId(home);
  if (homeId === 'pawab2100.jsp') {
    // ログイン画面に戻された = 認証エラー(利用者番号/パスワード誤り、カード期限切れ等)。リトライしない
    throw new AuthError('ログインが拒否されました(利用者番号・パスワード・カード有効期限を確認)');
  }
  if (!home.includes(LOGGED_IN_MARKER)) {
    throw new Error(`ログイン後の画面が想定外です (${homeId ?? '不明'})`);
  }

  // 5. ログアウト(失敗しても結果には影響させない)。タイムアウト用 signal には縛らない
  const logout = async () => {
    try {
      await request.withoutSignal(
        '/web/rsvWTransUserAttestationEndAction.do',
        new URLSearchParams({ displayNo: 'prwha1000', displayNoFrm: 'prwha1000' })
      );
    } catch (e) {
      log(`ログアウト失敗(無視): ${e.message}`);
    }
  };

  try {
    // 4. 予約の確認・取消画面(表示のみ。キャンセルは送らない)
    const displayNo = hiddenValue(home, 'displayNo') || 'pawab2000';
    const list = await request(
      '/web/rsvWGetCancelRsvDataAction.do',
      new URLSearchParams({ displayNo, displayNoFrm: displayNo })
    );
    const listId = pageId(list);
    if (listId !== 'prwha1000.jsp' && !list.includes('id="rsvacceptlist"')) {
      // セッション未認識でホームが返る等
      throw new Error(`予約確認画面が想定外です (${listId ?? '不明'})`);
    }
    return parseReservations(list);
  } finally {
    if (deferLogout) deferLogout(logout);
    else await logout();
  }
}


// 外部から使う本体。失敗時は新セッションから最大 MAX_ATTEMPTS 回。
//   signal      : 全体のタイムアウト(AbortController)
//   log(msg)    : 進行状況の出力用(利用者番号などは渡さない)
//   retryUntil  : この時刻(ms)を過ぎていたら再試行しない(返信期限に間に合わせるため)
//   deferLogout : 渡すと、ログアウト処理を待たずに関数として受け取れる(返信を先に送るため)
export async function fetchReservations(credentials, { signal, log = () => {}, retryUntil = Infinity, deferLogout } = {}) {
  if (!credentials?.userId || !credentials?.password) {
    throw new AuthError('利用者番号またはパスワードが未設定です');
  }
  let lastError;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    if (signal?.aborted) throw new Error('タイムアウトのため中断しました');
    const started = Date.now();
    try {
      const result = await attempt(credentials, { signal, log, deferLogout });
      log(`取得成功 (${n}回目, ${Date.now() - started}ms, ${result.length}件)`);
      return result;
    } catch (e) {
      lastError = e;
      if (e instanceof AuthError || signal?.aborted || e.name === 'AbortError') throw e;
      log(`取得失敗 (${n}回目, ${Date.now() - started}ms): ${e.message}`);
      if (Date.now() > retryUntil) {
        log('返信期限が近いため再試行しません');
        break;
      }
    }
  }
  throw lastError;
}
