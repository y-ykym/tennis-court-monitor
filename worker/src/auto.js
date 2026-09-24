// ============================================================
// フェーズ3 自動予約の Worker 側(状態の置き場・API・「じどう」コマンドの postback)
//
//   KV(BOOKING_KV):
//     auto_exclusions  { dates: ['YYYY-MM-DD'], slots: [{ park, date, start, end, facility, reason, at }] }  除外日・除外枠(A/B 共通)
//   Pi の生存・モードは KV に書かない(2026-09-16 変更)。1 分ごとに書くと KV 無料枠(書き込み 1 日 1,000 回)を URL 登録と合わせて超え、
//   Worker がエラーを返して Pi が除外一覧を取れなくなった。代わりに、必要なときだけ登録済みの URL(トンネル)越しに Pi の /auto/status を聞く
//
//   API(Pi と Actions から。認証は lib/auto-client.js と同じ HMAC + 時刻):
//     GET  /auto/state        → { alive, active, mode, lastSeenAt, dates, slots }   Actions が通知を絞る判断に使う(Pi を直接 probe する)
//     POST /auto/heartbeat    { active, mode, ... } → 除外一覧 { dates, slots }     Pi が 1 分おきに呼ぶ(除外一覧の取得。KV には書かない)
//     POST /auto/exclusions   { addSlots: [{ park, date, start, end, facility, reason }] } → 除外一覧   Pi が「手放した枠」を登録
//     POST /auto/tennisbear   { person: 'A'|'B' } → { configured, events: [{ date, start, end, park, facility, source:'tennisbear' }] }
//                             Pi が予約直前に呼ぶ(2026-09-24)。その人のテニスベアの今後の予定(tennisbear.js)を、公園コードを付けて返す。
//                             隣の時間帯に別の場所の予定があれば Pi は自動予約を見送る。TB_EMAIL_*/TB_PASS_* が無い人は configured:false・events:[]。
//                             取得に失敗したら 502(Pi は直近の結果があればそれで判定し、無ければ見送る)。イベント名は返さない・ログにも出さない
//
//   LINE:
//     「じどう」→ 除外日・除外枠の一覧カード(各行に「解除」、フッターに「日を追加」= 日付ピッカー)。auto-flex.js
//     「じどうおふ」/「じどうおん」→ 自動予約の一時停止 / 再開(KV auto_switch。Pi は heartbeat の応答で受け取り、次の照会から従う。
//       停止中は Pi が mode='paused' を申告し、Actions は従来どおり全部通知する。Pi 側の .env が dry-run/off のときは LINE から ON にはできない)
//     「つうちおふ」/「つうちおん」→ 空き通知カードを止める / 戻す(KV notify_switch)。Actions は /auto/state の notifyEnabled、
//       Pi は heartbeat の応答の notifyEnabled で受け取る。自動予約の結果カード・フェーズ4 の予告・「よやく」の返信は止めない
//     postback 'x|a|-|<exp>.<sig>'(日を追加。params.date に選んだ日)/ 'x|d|YYYYMMDD|<exp>.<sig>'(除外日を解除)/
//              'x|s|<公園コード>_YYYYMMDD_HHMM|<exp>.<sig>'(除外枠を解除)。署名は cancel-token.js と同じ HMAC 先頭 16 バイト
//     キャンセル成功時(index.js)→ addExcludedSlots() で除外枠に(LINE の返信より先に KV へ書く)
//
//   枠キーは lib/auto-rules.js と同じ "<公園コード>|<YYYY-MM-DD>|<HH:MM>"。過ぎた除外日・開始時刻を過ぎた除外枠は読むときに落とす
// ============================================================
import { PARK_NAMES, courtByTbCode, courtByFacility } from './courts.js';
import { buildAutoSettingsFlex, autoSettingsText } from './auto-flex.js';
import { fetchTennisbearEvents } from './tennisbear.js';

export const AUTO_COMMAND_TEXT = 'じどう';
export const AUTO_ON_TEXT = 'じどうおん';
export const AUTO_OFF_TEXT = 'じどうおふ';
export const KV_SWITCH = 'auto_switch'; // { enabled: boolean, at }。無ければ有効
export const NOTIFY_ON_TEXT = 'つうちおん';
export const NOTIFY_OFF_TEXT = 'つうちおふ';
export const KV_NOTIFY_SWITCH = 'notify_switch'; // { enabled: boolean, at }。無ければ有効(空き通知カードを送る)
export const AUTO_POSTBACK_PREFIX = 'x|';
export const KV_EXCLUSIONS = 'auto_exclusions';
const KV_URL_KEY = 'booking_url'; // booking.js と同じ(Pi のトンネル URL)
// Pi の最後の照会がこの時間以内なら「照会ループは生きている」扱い(lib/config.js の AUTO_BOOKING.ALIVE_WITHIN_MS と同じ値。
// Pi は日中 1 分・深夜 3 分おきに照会するので、その間隔 + 照会の所要でも切れない 5 分)
export const ALIVE_WITHIN_MS = 5 * 60 * 1000;
// Pi の /auto/status をトンネル越しに聞くときの再試行(瞬断対策)とタイムアウト
export const PROBE_ATTEMPTS = 2;
const PROBE_RETRY_MS = 1500;
const PROBE_TIMEOUT_MS = 8000;
// 署名付きリクエストの時刻のずれの許容(リプレイ防止)
export const AUTH_WINDOW_MS = 5 * 60 * 1000;
// /auto/tennisbear でテニスベアを取るときの上限(Pi 側の待ち 10 秒に収める)
const TENNISBEAR_BUDGET_MS = 8000;
// 「じどう」カードのボタンの有効期限
const SETTINGS_BUTTON_TTL_SEC = 60 * 60;
// 除外日に指定できる範囲(今日から)
export const MAX_DAYS_AHEAD = 35;
const SIG_BYTES = 16;

const enc = new TextEncoder();
const b64u = (bytes) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
function safeEqual(a, b) {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// ---- 日付(JST) ----
export const jstTodayIso = (now = Date.now()) => new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
export function jstDateTimeMs(iso, hhmm) {
  const [y, m, d] = iso.split('-').map(Number);
  const [hh, mm] = String(hhmm).split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh - 9, mm || 0, 0);
}
function addDaysIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// ---- 枠キー(lib/auto-rules.js と同じ形式) ----
export function parkCodeOf(facilityOrCode) {
  const s = String(facilityOrCode ?? '');
  if (PARK_NAMES[s]) return s;
  const hit = Object.entries(PARK_NAMES).find(([, name]) => s.includes(name.replace(/公園$/, '')));
  return hit ? hit[0] : null;
}
export function slotKeyOf(s) {
  const code = parkCodeOf(s.park ?? s.facility) ?? String(s.park ?? s.facility ?? '?');
  return `${code}|${s.date}|${s.start}`;
}
// 除外枠を保存する形に揃える(公園コード・公園名・終了時刻を補う)
function normalizeSlot(s, now) {
  const park = parkCodeOf(s.park ?? s.facility);
  if (!park || !/^\d{4}-\d{2}-\d{2}$/.test(s.date || '') || !/^\d{2}:\d{2}$/.test(s.start || '')) return null;
  const end = /^\d{2}:\d{2}$/.test(s.end || '') ? s.end : `${String(Number(s.start.slice(0, 2)) + 2).padStart(2, '0')}:00`;
  return { park, date: s.date, start: s.start, end, facility: PARK_NAMES[park], reason: s.reason === 'released' ? 'released' : 'cancel', at: s.at ?? now };
}

// ---- 除外一覧 ----
export function pruneExclusions(ex, now = Date.now()) {
  const today = jstTodayIso(now);
  const dates = [...new Set((ex?.dates || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today))].sort();
  const seen = new Set();
  const slots = (ex?.slots || []).filter((s) => {
    if (!s?.date || !s?.start || jstDateTimeMs(s.date, s.start) <= now) return false;
    const k = slotKeyOf(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  slots.sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
  return { dates, slots };
}
export async function loadExclusions(env, now = Date.now()) {
  let raw = null;
  try {
    raw = JSON.parse((await env.BOOKING_KV.get(KV_EXCLUSIONS)) || 'null');
  } catch {
    raw = null;
  }
  return pruneExclusions(raw || { dates: [], slots: [] }, now);
}
async function saveExclusions(env, ex, now = Date.now()) {
  const pruned = pruneExclusions(ex, now);
  await env.BOOKING_KV.put(KV_EXCLUSIONS, JSON.stringify(pruned));
  return pruned;
}
// 除外枠を追加(キャンセル成功時・Pi からの「手放し」登録)。戻り値は保存後の一覧
export async function addExcludedSlots(env, slots, now = Date.now()) {
  const ex = await loadExclusions(env, now);
  const keys = new Set(ex.slots.map(slotKeyOf));
  let added = 0;
  for (const raw of slots || []) {
    const s = normalizeSlot(raw, now);
    if (!s) continue;
    const k = slotKeyOf(s);
    if (keys.has(k)) continue;
    keys.add(k);
    ex.slots.push(s);
    added++;
  }
  if (added) console.log(`[auto] 除外枠を ${added} 件追加(合計 ${ex.slots.length} 件)`);
  return saveExclusions(env, ex, now);
}
export async function addExcludedDate(env, dateIso, now = Date.now()) {
  const ex = await loadExclusions(env, now);
  if (!ex.dates.includes(dateIso)) ex.dates.push(dateIso);
  return saveExclusions(env, ex, now);
}
export async function removeExcludedDate(env, dateIso, now = Date.now()) {
  const ex = await loadExclusions(env, now);
  ex.dates = ex.dates.filter((d) => d !== dateIso);
  return saveExclusions(env, ex, now);
}
export async function removeExcludedSlot(env, key, now = Date.now()) {
  const ex = await loadExclusions(env, now);
  ex.slots = ex.slots.filter((s) => slotKeyOf(s) !== key);
  return saveExclusions(env, ex, now);
}

// ---- LINE からの一時停止スイッチ(既定は有効) ----
export async function loadAutoSwitch(env) {
  try {
    const v = JSON.parse((await env.BOOKING_KV.get(KV_SWITCH)) || 'null');
    return v && typeof v.enabled === 'boolean' ? v : { enabled: true, at: null };
  } catch {
    return { enabled: true, at: null };
  }
}
export async function setAutoSwitch(env, enabled, now = Date.now()) {
  const v = { enabled: !!enabled, at: now };
  await env.BOOKING_KV.put(KV_SWITCH, JSON.stringify(v));
  console.log(`[auto] LINE から自動予約を ${enabled ? 'ON' : 'OFF'} にしました`);
  return v;
}

// ---- 空き通知のスイッチ(既定は有効) ----
export async function loadNotifySwitch(env) {
  try {
    const v = JSON.parse((await env.BOOKING_KV.get(KV_NOTIFY_SWITCH)) || 'null');
    return v && typeof v.enabled === 'boolean' ? v : { enabled: true, at: null };
  } catch {
    return { enabled: true, at: null };
  }
}
export async function setNotifySwitch(env, enabled, now = Date.now()) {
  const v = { enabled: !!enabled, at: now };
  await env.BOOKING_KV.put(KV_NOTIFY_SWITCH, JSON.stringify(v));
  console.log(`[auto] LINE から空き通知を ${enabled ? 'ON' : 'OFF'} にしました`);
  return v;
}

// ---- Pi の生存(KV ではなく、登録済みの URL 越しに Pi の /auto/status を聞く) ----
// 戻り値: { registered, reachable, alive, active, mode, lastSeenAt, startedAt, reason }
//   registered  Pi の URL 登録があるか(無ければ Pi・Docker・回線のどれかが止まっている)
//   reachable   /auto/status が応答したか
//   alive       reachable かつ照会ループが動いている(mode が on/dry-run で、最後の照会が ALIVE_WITHIN_MS 以内)
//   active      alive かつ mode='on'(このときだけ Actions は対象期間の枠を通知しない)
export async function autoStatus(env, now = Date.now(), { attempts = PROBE_ATTEMPTS, retryMs = PROBE_RETRY_MS } = {}) {
  const base = { registered: false, reachable: false, alive: false, active: false, mode: null, lastSeenAt: null, startedAt: null, reason: '' };
  const registered = await env.BOOKING_KV.get(KV_URL_KEY);
  if (!registered) return { ...base, reason: 'Pi からの URL 登録がありません' };
  let reason = '';
  for (let n = 1; n <= attempts; n++) {
    try {
      const res = await fetch(`${registered}/auto/status`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!res.ok) {
        reason = `HTTP ${res.status}`;
      } else {
        const st = await res.json();
        const mode = typeof st.mode === 'string' ? st.mode : 'off'; // 'on' | 'paused'(LINE で OFF) | 'dry-run' | 'off'
        const lastSeenAt = typeof st.lastCycle?.at === 'number' ? st.lastCycle.at : null;
        const looping = mode === 'on' || mode === 'dry-run' || mode === 'paused';
        const alive = looping && lastSeenAt != null && now - lastSeenAt <= ALIVE_WITHIN_MS;
        return { registered: true, reachable: true, alive, active: alive && mode === 'on', mode, lastSeenAt, startedAt: typeof st.startedAt === 'number' ? st.startedAt : null, reason: '' };
      }
    } catch (e) {
      reason = e.name === 'TimeoutError' ? 'タイムアウト' : e.message;
    }
    if (n < attempts) await new Promise((r) => setTimeout(r, retryMs));
  }
  return { ...base, registered: true, reason: `Pi に届きません(${reason})` };
}

// ---- 署名付きリクエストの検証(lib/auto-client.js の signRequest と対) ----
export async function verifyAutoRequest(secret, { method, path, body = '', ts, auth }, now = Date.now()) {
  if (!secret || !ts || !auth) return false;
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now - t) > AUTH_WINDOW_MS) return false;
  const expected = b64u(await hmac(secret, `${ts}\n${method.toUpperCase()} ${path}\n${body}`));
  return safeEqual(expected, auth);
}

// ---- テニスベアの予定(Pi が予約直前の隣接判定に使う。2026-09-24) ----
// テニスベアのイベントを Pi が照合しやすい形に。公園コードは place.code(courts.js の台帳)→ コート名の順で引き、都営以外は park:null
export function tennisbearPlanOf(ev) {
  const court = courtByTbCode(ev.placeCode) || courtByFacility(ev.facility);
  return { source: 'tennisbear', date: ev.date, start: ev.start, end: ev.end || '', park: court ? court.parkCode : null, facility: ev.facility || '' };
}
export async function fetchTennisbearPlans(env, person, { fetchEvents = fetchTennisbearEvents, budgetMs = TENNISBEAR_BUDGET_MS } = {}) {
  const p = String(person || '').toUpperCase();
  if (p !== 'A' && p !== 'B') throw new Error('person は A か B');
  const email = env[`TB_EMAIL_${p}`];
  const password = env[`TB_PASS_${p}`];
  if (!email || !password) return { person: p, configured: false, events: [] };
  const events = await fetchEvents({ email, password }, { signal: AbortSignal.timeout(budgetMs), log: (msg) => console.log(`[tb:${p}] ${msg}`) });
  return { person: p, configured: true, events: events.map(tennisbearPlanOf) };
}

// このモジュールが扱うパス(/auto/*)なら Response、それ以外は null
export async function handleAuto(request, env, ctx, { now = Date.now(), fetchEvents } = {}) {
  const url = new URL(request.url);
  const p = url.pathname;
  if (!p.startsWith('/auto/')) return null;
  if (!env.BOOKING_SIGNING_SECRET || !env.BOOKING_KV) return new Response('server misconfigured', { status: 500 });
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  const ok = await verifyAutoRequest(
    env.BOOKING_SIGNING_SECRET,
    { method: request.method, path: p, body, ts: request.headers.get('x-booking-ts'), auth: request.headers.get('x-booking-auth') },
    now
  );
  if (!ok) {
    console.warn(`[auto] 認証に失敗: ${request.method} ${p}`);
    return new Response('unauthorized', { status: 401 });
  }
  let json = {};
  if (body) {
    try {
      json = JSON.parse(body);
    } catch {
      return new Response('bad request', { status: 400 });
    }
  }

  if (p === '/auto/state' && request.method === 'GET') {
    const [status, ex, sw, ns] = await Promise.all([autoStatus(env, now), loadExclusions(env, now), loadAutoSwitch(env), loadNotifySwitch(env)]);
    return Response.json({ ...status, ...ex, enabled: sw.enabled, notifyEnabled: ns.enabled });
  }
  if (p === '/auto/heartbeat' && request.method === 'POST') {
    // KV には何も書かない(書き込みは無料枠 1 日 1,000 回。生存は /auto/state が Pi を直接 probe して判定する)
    const [ex, sw, ns] = await Promise.all([loadExclusions(env, now), loadAutoSwitch(env), loadNotifySwitch(env)]);
    return Response.json({ ...ex, enabled: sw.enabled, notifyEnabled: ns.enabled, serverTime: now });
  }
  if (p === '/auto/exclusions' && request.method === 'POST') {
    const ex = await addExcludedSlots(env, Array.isArray(json.addSlots) ? json.addSlots : [], now);
    return Response.json(ex);
  }
  if (p === '/auto/tennisbear' && request.method === 'POST') {
    if (json.person !== 'A' && json.person !== 'B') return new Response('bad request', { status: 400 });
    try {
      return Response.json(await fetchTennisbearPlans(env, json.person, fetchEvents ? { fetchEvents } : {}));
    } catch (e) {
      console.error(`[tb:${json.person}] 自動予約向けの取得に失敗: ${e.message}`);
      return Response.json({ error: `テニスベアの予定を取得できませんでした(${e.name === 'TennisbearAuthError' ? '認証エラー' : e.name === 'TimeoutError' ? 'タイムアウト' : 'エラー'})` }, { status: 502 });
    }
  }
  return new Response('not found', { status: 404 });
}

// ---- 「じどう」カードの postback data(短い署名付き) ----
export async function signAutoData(secret, kind, value, exp) {
  if (!secret) throw new Error('署名鍵が未設定です');
  if (!['a', 'd', 's'].includes(kind)) throw new Error('kind が不正です');
  const v = String(value || '-');
  if (/[|.]/.test(v)) throw new Error('値に使えない文字');
  const body = `x|${kind}|${v}|${exp}`;
  const sig = b64u((await hmac(secret, body)).slice(0, SIG_BYTES));
  return `${body}.${sig}`;
}
export async function verifyAutoData(secret, data, now = Date.now()) {
  if (!secret || typeof data !== 'string' || !data.startsWith(AUTO_POSTBACK_PREFIX)) return null;
  const dot = data.lastIndexOf('.');
  if (dot < 0) return null;
  const body = data.slice(0, dot);
  const expected = b64u((await hmac(secret, body)).slice(0, SIG_BYTES));
  if (!safeEqual(expected, data.slice(dot + 1))) return null;
  const f = body.split('|');
  if (f.length !== 4 || !['a', 'd', 's'].includes(f[1]) || !/^\d+$/.test(f[3])) return null;
  return { kind: f[1], value: f[2], exp: Number(f[3]), expired: Number(f[3]) * 1000 < now };
}

// 「じどうおん」「じどうおふ」への返信。スイッチを KV に保存し、状態カードに結果を添えて返す
export async function handleAutoSwitchCommand(env, enabled, { now = Date.now() } = {}) {
  await setAutoSwitch(env, enabled, now);
  const status = await autoStatus(env, now);
  let note;
  if (enabled) {
    note = '自動予約を ON にしました。Pi は次の照会(1〜3 分以内)から予約を再開します';
    if (status.reachable && status.mode !== 'on' && status.mode !== 'paused') {
      note += `。ただし Pi 側の設定が ${status.mode}(.env の AUTO_BOOKING)のため、Pi の設定を on にするまで実際には予約しません`;
    } else if (!status.reachable) {
      note += '(いま Pi に届いていません。Pi が動いていれば、復帰後に反映されます)';
    }
  } else {
    note = '自動予約を OFF にしました。Pi は次の照会(1〜3 分以内)から予約せず、空きは従来どおり通知カードで届きます。再開は「じどうおん」';
  }
  return buildAutoSettingsReply(env, { now, note });
}

// 「つうちおん」「つうちおふ」への返信。空き通知カードのスイッチを KV に保存し、状態カードに結果を添えて返す
export async function handleNotifySwitchCommand(env, enabled, { now = Date.now() } = {}) {
  await setNotifySwitch(env, enabled, now);
  const note = enabled
    ? '空き通知を ON にしました。次の空きチェック(3 分以内)から、新しい空きのカードが届きます'
    : '空き通知を OFF にしました。新しい空きのカードは届きません(自動予約と、その結果カード・予告カード・「よやく」は動きます)。戻すのは「つうちおん」';
  return buildAutoSettingsReply(env, { now, note });
}

// 「じどう」への返信(一覧カード)。戻り値 { flex, text }
export async function buildAutoSettingsReply(env, { now = Date.now(), note = null } = {}) {
  const [status, ex, sw, ns] = await Promise.all([autoStatus(env, now), loadExclusions(env, now), loadAutoSwitch(env), loadNotifySwitch(env)]);
  status.enabled = sw.enabled;
  status.notifyEnabled = ns.enabled;
  const today = jstTodayIso(now);
  const exp = Math.floor(now / 1000) + SETTINGS_BUTTON_TTL_SEC;
  const secret = env.BOOKING_SIGNING_SECRET;
  const dates = [];
  for (const d of ex.dates) dates.push({ date: d, removeData: await signAutoData(secret, 'd', d.replace(/-/g, ''), exp) });
  const slots = [];
  for (const s of ex.slots) {
    slots.push({ ...s, removeData: await signAutoData(secret, 's', `${s.park}_${s.date.replace(/-/g, '')}_${s.start.replace(':', '')}`, exp) });
  }
  const addData = await signAutoData(secret, 'a', '-', exp);
  const model = { status, dates, slots, addData, today, maxDate: addDaysIso(today, MAX_DAYS_AHEAD), note };
  return { flex: buildAutoSettingsFlex(model), text: autoSettingsText(model) };
}

export const MSG_AUTO_EXPIRED = '時間切れです。「じどう」からやり直してください';
export const MSG_AUTO_BAD_DATE = 'その日は指定できません(今日から 35 日先まで)。「じどう」からやり直してください';

// 「じどう」カードのボタン(postback)を処理する。戻り値 { flex, text } | { text } | null(無視)
export async function handleAutoPostback(env, data, params, { now = Date.now() } = {}) {
  const t = await verifyAutoData(env.BOOKING_SIGNING_SECRET, data, now);
  if (!t) {
    console.warn('[auto] 署名不正の postback を無視しました');
    return null;
  }
  if (t.expired) return { text: MSG_AUTO_EXPIRED };
  const today = jstTodayIso(now);
  const fmt = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return `${m}/${d}(${'日月火水木金土'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
  };
  let note;
  if (t.kind === 'a') {
    const picked = params?.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(picked || '') || picked < today || picked > addDaysIso(today, MAX_DAYS_AHEAD)) return { text: MSG_AUTO_BAD_DATE };
    await addExcludedDate(env, picked, now);
    note = `${fmt(picked)} を除外日に追加しました(この日は自動予約せず、空き通知もしません)`;
    console.log(`[auto] 除外日を追加: ${picked}`);
  } else if (t.kind === 'd') {
    const iso = `${t.value.slice(0, 4)}-${t.value.slice(4, 6)}-${t.value.slice(6, 8)}`;
    await removeExcludedDate(env, iso, now);
    note = `${fmt(iso)} の除外を解除しました(この日も自動予約の対象になります)`;
    console.log(`[auto] 除外日を解除: ${iso}`);
  } else {
    const [park, ymd, hhmm] = t.value.split('_');
    const key = `${park}|${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}|${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`;
    await removeExcludedSlot(env, key, now);
    note = `${fmt(key.split('|')[1])} ${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)} ${PARK_NAMES[park] || park} の除外を解除しました(空きが出れば自動予約の対象になります)`;
    console.log(`[auto] 除外枠を解除: ${key}`);
  }
  return buildAutoSettingsReply(env, { now, note });
}
