// ============================================================
// 高速経路(ブラウザ内版): サイトのトップページを開いたブラウザの「中」で、fetch を使って
// ログイン → 空き検索 → 週データ → 枠の選択 まで進める。UI 操作(クリック・入力・描画待ち)を省いて速くする。
//
//   page.evaluate(inPageFlow, { slot, credentials }) → { ok: true, applyFields, facility, vacant }
//                                                    | { ok: false, status: 'auth_error'|'taken'|'error', message }
//
// Node 側の HTTP(src/site-http.js)ではなくブラウザ内で行う理由:
//   Cloud Run では Node の HTTP とブラウザの通信が別の出口(IP)になり得て、予約サイトのロードバランサが
//   セッションを別ノードに振ってしまう(「システム異常が発生しました」)。ブラウザ1つに通信主体をまとめると、
//   実機で成功している全ブラウザ方式と同じ条件になる。
//
// この関数はブラウザで実行されるため、Node の API や外側の変数は使えない(自己完結)。
// 通信の内訳は docs/site-notes.md「フェーズ1.5 追加調査」「フェーズ2 追加調査」を参照。書き込みは枠の選択まで。
// ============================================================

export async function inPageFlow({ slot, credentials }) {
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
    // 1. ログイン画面(loginJKey を含む hidden 一式)
    const loginPage = await req('/web/rsvWTransUserLoginAction.do', { displayNo: 'pawab2000', displayNoFrm: 'pawab2000' });
    if (loginPage.status !== 200 || pageId(loginPage.body) !== 'pawab2100.jsp' || !hiddenValue(loginPage.body, 'loginJKey')) {
      return fail('error', `ログイン画面が想定外です (HTTP ${loginPage.status}, ${pageId(loginPage.body) || '不明'})`);
    }
    if (/gRecaptchaActive\s*=\s*true/.test(loginPage.body)) return fail('error', 'ログイン画面で reCAPTCHA が有効のため fetch ではログインできません');

    // 2. ログイン(ブラウザの submitLogin() と同じ送信内容)
    const form = new URLSearchParams(hiddenFields(loginPage.body));
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
      return fail('auth_error', `ログインが拒否されました(利用者番号・パスワード・カード有効期限を確認) ${alert}`);
    }
    if (!home.body.includes('gRsvWTransUserAttestationEndAction);')) return fail('error', `ログイン後の画面が想定外です (${pageId(home.body) || '不明'})`);

    // 3. 空き検索(週表示画面。hidden 一式を控える)
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
    const instCd = hiddenValue(week.body, 'selectInstCd');
    if (pageId(week.body) !== 'prwrc2000.jsp' || hiddenValue(week.body, 'selectBldCd') !== slot.park || !instCd) {
      return fail('error', `検索結果画面が想定外です (${pageId(week.body) || '不明'}, 公園=${hiddenValue(week.body, 'selectBldCd')})`);
    }
    const facility = decodeEntities(hiddenValue(week.body, 'selectBldName') || '') || slot.park;

    // 4. 週データ JSON から対象セル(空き面数・終了時刻・時間帯番号)
    let json;
    try {
      json = JSON.parse(
        (await req('/web/rsvWOpeInstSrchVacantAjaxAction.do', { displayNo: 'prwrc2000', useDay: ymd, bldCd: slot.park, instCd, transVacantMode: '0', clearFlag: '0' })).body
      );
    } catch {
      json = {};
    }
    if (!json.result) return fail('error', '週データが取得できませんでした(セッション未認識の可能性)');
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
    if (!cell) return fail('error', `対象の枠 ${ymd} ${slot.startHour}時 が週データにありません`);
    if (cell.alt !== '空き' || Number(cell.rsvNum) < 1) return fail('taken', `その枠は空きではありませんでした(${cell.alt})`);

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
    if (Number(sel.selectNum) !== 1) return fail('error', `枠の選択が反映されませんでした (${JSON.stringify(sel).slice(0, 120)})`);

    // 予約内容確認画面へ進む POST の値(checkSelect() が送るもの: 週表示画面の hidden 一式 + applyFlg=1)
    const applyFields = { ...hiddenFields(week.body), daystart: slot.date, applyFlg: '1', selectSize: String(sel.selectState ?? 1) };
    return { ok: true, applyFields, facility, vacant: Number(cell.rsvNum) };
  } catch (e) {
    return fail('error', `ブラウザ内 fetch でエラー: ${e && e.message ? e.message : String(e)}`);
  }
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
