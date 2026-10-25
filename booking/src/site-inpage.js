// ============================================================
// 高速経路(ブラウザ内版): サイトのトップページを開いたブラウザの「中」で、fetch を使って
// ログイン → 空き検索 → 週データ → 枠の選択 まで進める。UI 操作(クリック・入力・描画待ち)を省いて速くする。
//
//   page.evaluate(inPageFlow, { slot, credentials, withList, prefetched }) → { ok: true, applyFields, facility, vacant, skippedWeek, skippedLoginPage, skippedSearch, listHtml? }
//                                                                          | { ok: false, status: 'auth_error'|'taken'|'error', message }
//   prefetched(省略可): 先に起こしてあるブラウザで prefetchInPage() が取っておいたもの { loginFields, loginRecaptcha, search: { park, instCd, facility, fields } }。
//     loginFields があればログイン画面(1 往復 3〜4.5 秒)を飛ばしていきなりログインを送る(鍵 loginJKey は 9 分後も有効。2026-10-25 実測)。
//     search.park が slot.park と同じなら検索(1 往復 4〜5.5 秒)も飛ばす(検索条件はセッションに残り、ログインをまたぐ。別の公園なら検索し直す。
//     検索時の日付が今日でも先の日付の枠を選べる。2026-10-25 実測)
//   slot.vacant / slot.tzoneNo(省略可): 空き照会で分かっている面数と時間帯番号。両方あれば週データ JSON(1 往復 約 10 秒)を取らず、
//     その値で枠を選ぶ(フェーズ3 の自動予約。2026-10-25)。無ければ従来どおり週データで空きを確かめてから選ぶ(LINE の「よやく」)。
//     **ただし現在は使っていない(server.mjs は vacant を渡さない)**。実測(2026-10-25)で、サーバーは枠選択 Ajax でも確認画面でも
//     空きを検証しないと分かったため(akiNum=0 を送ったときだけ { selectNum: 0, selectState: 0, akiNum: 0 } で断る。1 以上なら
//     空きでないセルでも選べて確認画面に到達する)。飛ばすと先に取られていた回に「予約」送信まで進んでしまう。
//     「予約」送信に対するサイトの応答が分かれば使える余地はある
//   withList: true のとき、枠が選べた後に「予約の確認・取消」画面(prwha1000)を取って listHtml に入れて返す
//   (フェーズ3: 予約する前にその利用日の予約件数を数えるため。Node 側で reservation-list.js の parseReservations に渡す。
//    ログイン直後ではなく枠選択の後に取るのは、先に取られていた回に 1 往復(約 5 秒)を省くため。2026-10-25)
//
// Node 側の HTTP ではなくブラウザ内で行う理由:
//   Cloud Run では Node の HTTP とブラウザの通信が別の出口(IP)になり得て、予約サイトのロードバランサが
//   セッションを別ノードに振ってしまう(「システム異常が発生しました」)。ブラウザ1つに通信主体をまとめると、
//   実機で成功している全ブラウザ方式と同じ条件になる。
//
// この関数はブラウザで実行されるため、Node の API や外側の変数は使えない(自己完結)。
// 通信の内訳は docs/site-notes.md「フェーズ1.5 追加調査」「フェーズ2 追加調査」を参照。書き込みは枠の選択まで。
// ============================================================

export async function inPageFlow({ slot, credentials, withList = false, prefetched = null }) {
  const dec = new TextDecoder('shift_jis');
  const ymd = slot.date.replace(/-/g, '');
  const startTime = Number(slot.startHour) * 100;
  const fail = (status, message) => ({ ok: false, status, message });

  async function req(path, form) {
    const res = await fetch(path, {
      method: form ? 'POST' : 'GET',
      headers: form ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
      body: form ? (form instanceof URLSearchParams ? form.toString() : new URLSearchParams(form).toString()) : undefined,
      credentials: 'include',
      redirect: 'manual',
    });
    const body = dec.decode(await res.arrayBuffer());
    return { status: res.status, type: res.type, body };
  }
  const pageId = (html) => (html.slice(0, 500).match(/<!-- (\w+\.jsp) -->/) || [])[1] || null;
  const hiddenValue = (html, name) => (html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`)) || [])[1] ?? null;
  const decodeEntities = (s) =>
    s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  function hiddenFields(html) {
    const out = {};
    const re = /<input[^>]*type="hidden"[^>]*>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const name = (m[0].match(/name="([^"]*)"/) || [])[1];
      if (!name) continue;
      out[name] = decodeEntities((m[0].match(/value="([^"]*)"/) || [])[1] ?? '');
    }
    return out;
  }

  try {
    // 1. ログイン画面(loginJKey を含む hidden 一式)。先に取ってあればそれを使う
    let loginFields;
    let loginRecaptcha = false;
    const skippedLoginPage = !!(prefetched && prefetched.loginFields && prefetched.loginFields.loginJKey);
    if (skippedLoginPage) {
      loginFields = prefetched.loginFields;
      loginRecaptcha = !!prefetched.loginRecaptcha;
    } else {
      const loginPage = await req('/web/rsvWTransUserLoginAction.do', { displayNo: 'pawab2000', displayNoFrm: 'pawab2000' });
      if (loginPage.status !== 200 || pageId(loginPage.body) !== 'pawab2100.jsp' || !hiddenValue(loginPage.body, 'loginJKey')) {
        return fail('error', `ログイン画面が想定外です (HTTP ${loginPage.status}, ${pageId(loginPage.body) || '不明'})`);
      }
      loginFields = hiddenFields(loginPage.body);
      loginRecaptcha = /gRecaptchaActive\s*=\s*true/.test(loginPage.body);
    }
    if (loginRecaptcha) return fail('error', 'ログイン画面で reCAPTCHA が有効のため fetch ではログインできません');

    // 2. ログイン(ブラウザの submitLogin() と同じ送信内容)
    const form = new URLSearchParams(loginFields);
    form.set('userId', credentials.userId);
    form.set('password', credentials.password);
    for (const ch of credentials.password) form.append('loginCharPass', ch);
    const home = await req('/web/rsvWUserAttestationLoginAction.do', form);
    if (home.type === 'opaqueredirect' || home.status === 0 || (home.status >= 300 && home.status < 400)) {
      return fail('auth_error', 'ログインが受け付けられませんでした(利用者番号の形式・パスワードを確認)');
    }
    if (pageId(home.body) === 'pawab2100.jsp') {
      const alert = (home.body.match(/showAlert\(["']([^"']{1,120})/) || [])[1] || '';
      if (/データ通信|時間をあけ|再度操作/.test(alert)) return fail('error', `ログイン時にサイトの一時エラー: ${alert}`);
      // 理由の文言が無いままログイン画面に戻された = サイト側の不調の可能性が高い(2026-09-17 に Worker では通るのに Pi だけ拒否された)。
      // auth_error にすると 6 時間止まるので、ここでは error にして UI 操作の経路で 1 回やり直す(本当にパスワード誤りなら UI 側で alert が出て auth_error になる)
      if (!alert) return fail('error', 'ログイン画面に戻されました(理由の表示なし。サイトの一時的な不調の可能性。UI 操作でやり直す)');
      return fail('auth_error', `ログインが拒否されました(利用者番号・パスワード・カード有効期限を確認) ${alert}`);
    }
    if (!home.body.includes('gRsvWTransUserAttestationEndAction);')) return fail('error', `ログイン後の画面が想定外です (${pageId(home.body) || '不明'})`);

    // 3. 空き検索(週表示画面。hidden 一式を控える)。同じ公園を先に検索してあれば飛ばす(検索条件はセッションに残っている)
    let instCd;
    let facility;
    let weekFields;
    const skippedSearch = !!(prefetched && prefetched.search && prefetched.search.park === slot.park && prefetched.search.instCd && prefetched.search.fields);
    if (skippedSearch) {
      instCd = prefetched.search.instCd;
      facility = prefetched.search.facility || slot.park;
      weekFields = prefetched.search.fields;
    } else {
      const week = await req('/web/rsvWOpeInstSrchVacantAction.do', {
        displayNo: 'pawab2000',
        daystarthome: slot.date,
        daystart: slot.date,
        selectPpsClPpscd: '1000_1030',
        selectPpsClsCd: '1000',
        selectPpsCd: '1030',
        selectAreaBcd: slot.park,
        selectBldCd: '',
        selectIcd: '0',
        dayofweekClearFlg: '1',
        timezoneClearFlg: '1',
      });
      instCd = hiddenValue(week.body, 'selectInstCd');
      if (pageId(week.body) !== 'prwrc2000.jsp' || hiddenValue(week.body, 'selectBldCd') !== slot.park || !instCd) {
        return fail('error', `検索結果画面が想定外です (${pageId(week.body) || '不明'}, 公園=${hiddenValue(week.body, 'selectBldCd')})`);
      }
      facility = decodeEntities(hiddenValue(week.body, 'selectBldName') || '') || slot.park;
      weekFields = hiddenFields(week.body);
    }

    // 4. 対象セル(空き面数・終了時刻・時間帯番号)。空き照会で分かっていれば週データ JSON(約 10 秒)は取らない
    let cell = null;
    let tzoneNo = null;
    const skippedWeek = slot.vacant != null && Number(slot.vacant) >= 1 && !!slot.tzoneNo;
    if (skippedWeek) {
      // 枠は 2 時間固定(終了 = 開始 + 2 時間)。時間帯番号は reserve.js の HOUR_TO_TZ
      cell = { startTime, endTime: startTime + 200, rsvNum: Number(slot.vacant), selectNum: 0 };
      tzoneNo = slot.tzoneNo;
    } else {
      let json;
      try {
        json = JSON.parse(
          (await req('/web/rsvWOpeInstSrchVacantAjaxAction.do', { displayNo: 'prwrc2000', useDay: ymd, bldCd: slot.park, instCd, transVacantMode: '0', clearFlag: '0' })).body
        );
      } catch {
        json = {};
      }
      if (!json.result) return fail('error', '週データが取得できませんでした(セッション未認識の可能性)');
      for (const row of json.result) {
        for (const c of row.timeResult || []) {
          if (String(c.useDay) === ymd && Number(c.startTime) === startTime) {
            cell = c;
            tzoneNo = row.tzoneNo;
          }
        }
      }
      if (!cell) return fail('error', `対象の枠 ${ymd} ${slot.startHour}時 が週データにありません`);
      if (cell.alt !== '空き' || Number(cell.rsvNum) < 1) return fail('taken', `その枠は空きではありませんでした(${cell.alt})`);
    }

    // 5. 枠の選択(setReserv() と同じ Ajax)
    let sel;
    try {
      sel = JSON.parse(
        (
          await req('/web/rsvWOpeInstReservAjaxAction.do', {
            displayNo: 'prwrc2000',
            bldCd: slot.park,
            instCd,
            useDay: ymd,
            startTime: String(cell.startTime),
            endTime: String(cell.endTime),
            tzoneNo: String(tzoneNo),
            akiNum: String(cell.rsvNum),
            selectNum: String(cell.selectNum ?? 0),
          })
        ).body
      );
    } catch {
      sel = {};
    }
    if (Number(sel.selectNum) !== 1) {
      // akiNum=0 で選ぼうとするとサーバーは { selectNum: 0, selectState: 0, akiNum: 0 } で断る(2026-10-25 実測。週データで面数 0 と分かった直後に起きうる)
      if (Number(sel.selectNum) === 0 && Number(sel.selectState) === 0 && Number(sel.akiNum) === 0) {
        return fail('taken', 'その枠は空きではありませんでした(枠の選択が断られました)');
      }
      return fail('error', `枠の選択が反映されませんでした (${JSON.stringify(sel).slice(0, 120)})`);
    }

    // 6. (フェーズ3)予約の確認・取消画面を取る(この人の予約一覧。件数の上限判定と、手放した枠の検出に使う)。枠が選べた後に取る
    let listHtml = null;
    if (withList) {
      const displayNo = hiddenValue(home.body, 'displayNo') || 'pawab2000';
      const list = await req('/web/rsvWGetCancelRsvDataAction.do', { displayNo, displayNoFrm: displayNo });
      if (pageId(list.body) !== 'prwha1000.jsp' && !list.body.includes('id="rsvacceptlist"')) {
        return fail('error', `予約一覧画面が想定外です (${pageId(list.body) || '不明'})`);
      }
      listHtml = list.body;
    }

    // 予約内容確認画面へ進む POST の値(checkSelect() が送るもの: 週表示画面の hidden 一式 + applyFlg=1)
    const applyFields = { ...weekFields, daystart: slot.date, applyFlg: '1', selectSize: String(sel.selectState ?? 1) };
    return { ok: true, applyFields, facility, vacant: Number(cell.rsvNum), skippedWeek, skippedLoginPage, skippedSearch, listHtml };
  } catch (e) {
    return fail('error', `ブラウザ内 fetch でエラー: ${e && e.message ? e.message : String(e)}`);
  }
}

// ログイン済みのブラウザの中で「予約の確認・取消」画面(prwha1000)を fetch して HTML を返す(画面は遷移させない)。
// UI 操作の経路(reserve.js の fastInPage=false)でフェーズ3 の件数判定に使う。ブラウザ内で実行されるので自己完結
export async function fetchReservationListInPage() {
  const displayNo = document.querySelector('input[name="displayNo"]')?.value || 'pawab2000';
  const res = await fetch('/web/rsvWGetCancelRsvDataAction.do', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ displayNo, displayNoFrm: displayNo }).toString(),
    credentials: 'include',
    redirect: 'manual',
  });
  return new TextDecoder('shift_jis').decode(await res.arrayBuffer());
}

// 予約内容確認画面へ進むフォームを、サイトの画面上に作って送信する(ブラウザ内で実行)
export function submitApplyForm(fields) {
  const f = document.createElement('form');
  f.method = 'post';
  f.action = '/web/rsvWOpeReservedApplyAction.do';
  f.acceptCharset = 'Shift_JIS';
  for (const [k, v] of Object.entries(fields)) {
    const i = document.createElement('input');
    i.type = 'hidden';
    i.name = k;
    i.value = v;
    f.appendChild(i);
  }
  document.body.appendChild(f);
  f.submit();
}

// 先に起こしてあるブラウザの中で、予約の手続きの最初の 2 往復を前もって済ませておく(src/browser-warmer.js が 8 分おきに呼ぶ。2026-10-25)。
//   page.evaluate(prefetchInPage, { park, date }) → { ok, loginFields, loginRecaptcha, search: { park, instCd, facility, fields, date } | null, message }
//   - 検索(park が空なら行わない): 検索条件がセッションに載り、ログインをまたいで残る。date は今日でよい(先の日付の枠も選べる)
//   - ログイン画面: loginJKey を含む hidden 一式。9 分後も有効
//   順番は 検索 → ログイン画面(実測した順)。ログインはしない。ブラウザで実行されるので自己完結
export async function prefetchInPage({ park = null, date }) {
  const dec = new TextDecoder('shift_jis');
  const out = { ok: false, loginFields: null, loginRecaptcha: false, search: null, message: '' };
  async function req(path, form) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      credentials: 'include',
      redirect: 'manual',
    });
    return { status: res.status, body: dec.decode(await res.arrayBuffer()) };
  }
  const pageId = (html) => (html.slice(0, 500).match(/<!-- (\w+\.jsp) -->/) || [])[1] || null;
  const hiddenValue = (html, name) => (html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`)) || [])[1] ?? null;
  const decodeEntities = (s) =>
    s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  function hiddenFields(html) {
    const o = {};
    const re = /<input[^>]*type="hidden"[^>]*>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const name = (m[0].match(/name="([^"]*)"/) || [])[1];
      if (name) o[name] = decodeEntities((m[0].match(/value="([^"]*)"/) || [])[1] ?? '');
    }
    return o;
  }
  try {
    if (park) {
      const week = await req('/web/rsvWOpeInstSrchVacantAction.do', {
        displayNo: 'pawab2000',
        daystarthome: date,
        daystart: date,
        selectPpsClPpscd: '1000_1030',
        selectPpsClsCd: '1000',
        selectPpsCd: '1030',
        selectAreaBcd: park,
        selectBldCd: '',
        selectIcd: '0',
        dayofweekClearFlg: '1',
        timezoneClearFlg: '1',
      });
      const instCd = hiddenValue(week.body, 'selectInstCd');
      if (pageId(week.body) === 'prwrc2000.jsp' && hiddenValue(week.body, 'selectBldCd') === park && instCd) {
        out.search = { park, instCd, facility: decodeEntities(hiddenValue(week.body, 'selectBldName') || '') || park, fields: hiddenFields(week.body), date };
      } else {
        out.message += `検索結果画面が想定外 (${pageId(week.body) || '不明'}, 公園=${hiddenValue(week.body, 'selectBldCd')}) `;
      }
    }
    const loginPage = await req('/web/rsvWTransUserLoginAction.do', { displayNo: 'pawab2000', displayNoFrm: 'pawab2000' });
    if (loginPage.status === 200 && pageId(loginPage.body) === 'pawab2100.jsp' && hiddenValue(loginPage.body, 'loginJKey')) {
      out.loginFields = hiddenFields(loginPage.body);
      out.loginRecaptcha = /gRecaptchaActive\s*=\s*true/.test(loginPage.body);
    } else {
      out.message += `ログイン画面が想定外 (HTTP ${loginPage.status}, ${pageId(loginPage.body) || '不明'}) `;
    }
    out.ok = !!out.loginFields;
  } catch (e) {
    out.message += `ブラウザ内 fetch でエラー: ${e && e.message ? e.message : String(e)}`;
  }
  return out;
}
