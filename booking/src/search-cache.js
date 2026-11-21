// ============================================================
// 予約の手続きで使う「検索結果の hidden 一式」を、ブラウザの外(素の HTTP)で前もって取っておく(2026-11-21)。
//
// 背景: 先に起こしたブラウザは 8 分おきに 検索 × 公園の数 + ログイン画面 を順番に先取りしていた(同じセッションに同時には投げられない)。
// 昼間は 1 往復 3〜6 秒なので 4 公園で 15〜30 秒かかり、30 秒の打ち切りで全部捨てる回(8 日で 26 回)と、先取りの最中に空きが出て
// 終わるまで待つ回があった(docs/site-notes.md「追加調査 2026-11-21」4.)。
// 調べると、検索結果の hidden はセッションに依らず同じで、予約に使うセッションが一度も検索していなくても、別のセッションで取った hidden で
// 確認画面まで進めた(本人ログインの dry-run で確認)。そこで検索はここで公園ごとに別セッション・同時に取り、ブラウザの先取りは
// ログイン画面 1 往復だけにする。
//
//   const cache = createSearchCache({ parks: ['1040', ...], log })
//   cache.start()      すぐ 1 回取り、以後 refreshMs ごとに取り直す(取れない公園があれば retryMs 後にもう一度)
//   cache.current()    → { [park]: { park, instCd, facility, fields, date, at } }  今日の日付で取れていて maxAgeMs より新しいものだけ
//                      (inPageFlow の prefetched.searches にそのまま渡せる形)
//   cache.refresh()    今すぐ取り直す(テスト用にも)
//   cache.stop() / cache.status()
//
// 取れなかった公園は current() に出ないだけで、予約の手続きは従来どおりその場で検索する(遅くなるだけで止まらない)。
// 都サイトへの通信の数は以前と同じ(8 分ごとに公園の数だけ検索。トップは公園ごとに 1 回ずつ増える)。
// ============================================================
import { createHttpSession } from './site-http.js';

const jstTodayIso = (ms) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const dec = new TextDecoder('shift_jis');
const pageId = (html) => (html.slice(0, 500).match(/<!-- (\w+\.jsp) -->/) || [])[1] || null;
const hiddenValue = (html, name) => (html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`)) || [])[1] ?? null;
const decodeEntities = (s) =>
  s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
// src/site-inpage.js の hiddenFields と同じ(ブラウザの中で取ったものと同じ値になるように)
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

// 1 公園分: 新しいセッションで トップ → 検索。src/site-inpage.js の prefetchInPage と同じ送信内容
export async function fetchSearch(session, park, date) {
  const top = await session.fetch('/web/index.jsp');
  const topHtml = dec.decode(await top.arrayBuffer());
  if (top.status !== 200 || !topHtml.includes('rsvWTransUserLoginAction')) throw new Error(`トップページが想定外 (HTTP ${top.status}, ${pageId(topHtml) || '不明'})`);
  const res = await session.fetch('/web/rsvWOpeInstSrchVacantAction.do', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
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
    }).toString(),
  });
  const html = dec.decode(await res.arrayBuffer());
  const instCd = hiddenValue(html, 'selectInstCd');
  if (res.status !== 200 || pageId(html) !== 'prwrc2000.jsp' || hiddenValue(html, 'selectBldCd') !== park || !instCd) {
    throw new Error(`検索結果画面が想定外 (HTTP ${res.status}, ${pageId(html) || '不明'}, 公園=${hiddenValue(html, 'selectBldCd')})`);
  }
  return { park, instCd, facility: decodeEntities(hiddenValue(html, 'selectBldName') || '') || park, fields: hiddenFields(html), date };
}

export function createSearchCache({
  parks = [],
  makeSession = () => createHttpSession({ timeoutMs: 20000 }),
  log = () => {},
  refreshMs = 8 * 60 * 1000, // 以前のブラウザの先取りと同じ間隔
  retryMs = 60 * 1000,
  maxAgeMs = 20 * 60 * 1000, // 取り直しが 1 回失敗しても使える長さ。これより古ければ使わない(予約の手続きがその場で検索する)
  now = Date.now,
  timers = { setTimeout, clearTimeout },
} = {}) {
  const list = parks.map((p) => String(p || '').trim()).filter(Boolean);
  const entries = new Map(); // park → { park, instCd, facility, fields, date, at }
  let timer = null;
  let inflight = null;
  let stopped = true;
  let lastSummary = '';
  let refreshed = 0;
  let failures = 0;

  const fresh = (e, t) => e && e.date === jstTodayIso(t) && t - e.at <= maxAgeMs;
  function current() {
    const t = now();
    const out = {};
    for (const [p, e] of entries) if (fresh(e, t)) out[p] = e;
    return out;
  }

  function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      const date = jstTodayIso(now());
      const errors = [];
      await Promise.all(
        list.map(async (park) => {
          try {
            const e = await fetchSearch(makeSession(), park, date);
            entries.set(park, { ...e, at: now() });
          } catch (e) {
            errors.push(`${park}: ${String(e && e.message ? e.message : e).split('\n')[0]}`);
          }
        })
      );
      refreshed++;
      if (errors.length) failures++;
      // 毎回は書かない(1 日 180 回)。取れている公園の顔ぶれが変わったときと、失敗したときだけ
      const have = Object.keys(current()).sort().join('/');
      const summary = `${have}|${errors.length ? 'ng' : 'ok'}`;
      if (errors.length) log(`検索の先取り(別の通信): 取れなかった公園あり(${errors.join(' / ')})。使えるのは ${have || 'なし'}。無い公園は予約のときにその場で検索します`);
      else if (summary !== lastSummary) log(`検索の先取り(別の通信): ${have || 'なし'} を取得(以後 ${Math.round(refreshMs / 60000)} 分ごと。WARM_SEARCH_HTTP=0 でブラウザの中での先取りに戻す)`);
      lastSummary = summary;
      return errors.length === 0;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function schedule(ms) {
    if (timer) timers.clearTimeout(timer);
    timer = timers.setTimeout(tick, ms);
  }
  async function tick() {
    timer = null;
    if (stopped) return;
    let ok = false;
    try {
      ok = await refresh();
    } catch {
      ok = false;
    }
    if (!stopped) schedule(ok ? refreshMs : retryMs);
  }
  function start() {
    if (!stopped || list.length === 0) return;
    stopped = false;
    tick();
  }
  function stop() {
    stopped = true;
    if (timer) timers.clearTimeout(timer);
    timer = null;
  }
  const status = () => {
    const cur = current();
    const ats = Object.values(cur).map((e) => e.at);
    return { parks: Object.keys(cur).sort(), want: list.length, oldestAt: ats.length ? Math.min(...ats) : null, refreshed, failures };
  };
  return { start, stop, refresh, current, status };
}
