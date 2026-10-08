// ============================================================
// フェーズ11: 「よやく」の予定を Google カレンダーに同期する(要件定義書 §21)
//
//   A の予定は A の、B の予定は B のメインカレンダー(GCAL_CALENDAR_ID_A / _B)へ。
//   元は「よやく」と同じ: 都の予約(fetchAllReservations)+ テニスベアの参加予定(fetchAllTennisbear)。
//
//   runCalendarSync(env, { fetchResults, fetchTb, now, push, gcal, persons, dryRun, reason })
//     毎時 0 分の Cron(index.js の scheduled)と、Pi・Worker からの直後の同期(/auto/calendar-sync)の両方から呼ぶ。
//     人ごとに: 望む予定(wanted)を組み → カレンダーからボットの予定(今日以降)を一覧 → 差分を 追加 / 更新 / 削除。
//     戻り値 { A: { inserted, updated, deleted, remaining, errors, wanted, existing }, B: …, skipped?, authFailed }
//   removeCalendarEvent(env, slot, key)
//     キャンセル完了直後に、その 1 件だけをカレンダーから消す(都のサイトに取りに行かない。通信 3 回)
//
// ルール(本人決定 2026-10-08):
//   - 都の予約は全件。テニスベアは確定した参加・主催のみ(tbStatus が空のもの)。キャンセル待ち・承認待ち・中止は対象外で、
//     いったん載っていた予定がその状態になったら次の同期で消える
//   - 今日(JST)以降だけ。過去の予定は触らない
//   - タイトル「🎾 公園名」「🐻 イベント名」。場所欄は公園名・会場名。説明欄に予約番号・コート種類 / 主催者・URL
//   - 予定の目印: extendedProperties.private { tennisBot: '1', tennisBotKey: 'site:<予約番号>' | 'tb:<イベントID>' }。
//     目印の無い予定(手で作ったもの)には触らない
//   - 取得に失敗した元(都 / テニスベア)の予定は、その回は削除しない(誤削除よけ)。追加・更新はする
//   - 1 回の同期で直すのは合計 MAX_CALENDAR_CHANGES 件まで(外部通信 50 回/リクエストの枠)。残りは次回
//   - 認証・権限のエラーが ALERT_AFTER_MS 続いたら LINE に ⚠️ を 1 回だけ(KV calendar_sync_state。書き込みは失敗の始まりと終わりだけ)
//   - CALENDAR_SYNC(wrangler.toml [vars]): "on" = 同期する / "dry" = やることをログに出すだけでカレンダーに触らない(初回の確認用。
//     /auto/calendar-sync の結果にも plan が返る)/ "off" = 何もしない
// ============================================================
import { createGcalClient, isGcalAuthError, BOT_MARK_KEY, BOT_MARK_VALUE, BOT_ID_KEY } from './gcal.js';
import { EVENT_INFO_URL } from './tennisbear.js';
import { pushText } from './line.js';

export const MAX_CALENDAR_CHANGES = 20;
// 終了時刻が取れないときの長さ(都のコートは 2 時間単位)
export const DEFAULT_DURATION_MIN = 120;
// 一覧を取る範囲(今日 0:00 JST からこの日数先まで。都の予約は最長 1 か月強、テニスベアは数か月先もありうる)
export const LOOKAHEAD_DAYS = 180;
export const KV_SYNC_STATE = 'calendar_sync_state';
export const ALERT_AFTER_MS = 6 * 60 * 60 * 1000;
export const MSG_CALENDAR_ALERT =
  '⚠️ Google カレンダーへの同期が 6 時間以上失敗しています(認証または権限のエラー)。サービスアカウントの共有設定(「予定の変更」)と Worker の GCAL_* の Secrets を確認してください。直るまでこの知らせは繰り返しません';
export const DESCRIPTION_FOOTER = '自動登録: テニス予約ボット(手で消しても次の同期で戻ります。消すなら LINE の「よやく」からキャンセル)';

const JST_MS = 9 * 60 * 60 * 1000;
export const jstTodayIso = (now = Date.now()) => new Date(now + JST_MS).toISOString().slice(0, 10);
export const jstMs = (dateIso, hhmm) => Date.parse(`${dateIso}T${hhmm}:00+09:00`);
// ミリ秒 → "YYYY-MM-DDTHH:MM:SS+09:00"(Google に渡す形)
export const toJstIso = (ms) => `${new Date(ms + JST_MS).toISOString().slice(0, 19)}+09:00`;

// 'on' | 'dry' | 'off'(不明な値は on)
export function calendarSyncMode(env) {
  const v = String(env.CALENDAR_SYNC || 'on').trim().toLowerCase();
  return v === 'off' || v === 'dry' ? v : 'on';
}
export function calendarSyncEnabled(env) {
  if (calendarSyncMode(env) === 'off') return false;
  return !!(env.GCAL_CLIENT_EMAIL && env.GCAL_PRIVATE_KEY);
}
// 書き先が登録されている人だけ(B が未登録なら A だけ)
export function configuredCalendars(env) {
  return ['A', 'B'].map((slot) => ({ slot, calendarId: env[`GCAL_CALENDAR_ID_${slot}`] })).filter((p) => p.calendarId);
}

export const siteKey = (id) => `site:${id}`;
export const tbKey = (id) => `tb:${id}`;
const sourceOfKey = (key) => (String(key || '').startsWith('tb:') ? 'tb' : 'site');

function endMsOf(startMs, dateIso, end) {
  if (/^\d{2}:\d{2}$/.test(end || '')) {
    const ms = jstMs(dateIso, end);
    if (Number.isFinite(ms) && ms > startMs) return ms;
  }
  return startMs + DEFAULT_DURATION_MIN * 60 * 1000;
}

// 都の予約 → 望む予定。予約番号が無いもの・日付や時刻が壊れているもの・過去のものは飛ばす
export function wantedFromSite(reservations = [], { now = Date.now() } = {}) {
  const today = jstTodayIso(now);
  const out = [];
  for (const r of reservations || []) {
    if (!r?.id || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '') || !/^\d{2}:\d{2}$/.test(r.start || '')) continue;
    if (r.date < today) continue;
    const startMs = jstMs(r.date, r.start);
    if (!Number.isFinite(startMs)) continue;
    const facility = String(r.facility || '').trim();
    out.push({
      key: siteKey(r.id),
      summary: facility ? `🎾 ${facility}` : '🎾 テニス',
      location: facility,
      description: [`予約番号: ${r.id}`, r.purpose ? String(r.purpose).trim() : '', DESCRIPTION_FOOTER].filter(Boolean).join('\n'),
      startMs,
      endMs: endMsOf(startMs, r.date, r.end),
    });
  }
  return out;
}

// テニスベアの予定 → 望む予定。確定した参加・主催(tbStatus が空)だけ。キャンセル待ち・承認待ち・中止は入れない
export function wantedFromTennisbear(events = [], { now = Date.now() } = {}) {
  const today = jstTodayIso(now);
  const out = [];
  for (const ev of events || []) {
    if (!ev?.id || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date || '') || !/^\d{2}:\d{2}$/.test(ev.start || '')) continue;
    if (ev.tbStatus) continue;
    if (ev.date < today) continue;
    const startMs = jstMs(ev.date, ev.start);
    if (!Number.isFinite(startMs)) continue;
    const title = String(ev.title || '').trim() || 'イベント';
    out.push({
      key: tbKey(ev.id),
      summary: `🐻 ${title}`,
      location: String(ev.facility || '').trim(),
      description: [ev.organizerName ? `主催: ${ev.organizerName}` : '', EVENT_INFO_URL(ev.id), DESCRIPTION_FOOTER].filter(Boolean).join('\n'),
      startMs,
      endMs: endMsOf(startMs, ev.date, ev.end),
    });
  }
  return out;
}

// Google に渡す予定の本体
export function eventBody(w) {
  return {
    summary: w.summary,
    location: w.location || '',
    description: w.description || '',
    start: { dateTime: toJstIso(w.startMs), timeZone: 'Asia/Tokyo' },
    end: { dateTime: toJstIso(w.endMs), timeZone: 'Asia/Tokyo' },
    extendedProperties: { private: { [BOT_MARK_KEY]: BOT_MARK_VALUE, [BOT_ID_KEY]: w.key } },
  };
}

const keyOf = (e) => e?.extendedProperties?.private?.[BOT_ID_KEY] || '';
const sameEvent = (w, e) =>
  (e.summary || '') === w.summary &&
  (e.location || '') === (w.location || '') &&
  (e.description || '') === (w.description || '') &&
  Date.parse(e.start?.dateTime || '') === w.startMs &&
  Date.parse(e.end?.dateTime || '') === w.endMs;

// 望む予定とカレンダーにある予定の差分。allowDelete: 元ごとに「消してよいか」(取得に失敗した元は false)
//   戻り値 { inserts: [w], updates: [{ id, w }], deletes: [{ id, key }] }。同じ目印が 2 件以上あれば 1 件を残して他は削除に回す
export function diffEvents(wanted, existing, { allowDelete = { site: true, tb: true } } = {}) {
  const byKey = new Map();
  const deletes = [];
  for (const e of existing || []) {
    const key = keyOf(e);
    if (!key) continue;
    if (byKey.has(key)) deletes.push({ id: e.id, key, reason: 'duplicate' });
    else byKey.set(key, e);
  }
  const inserts = [];
  const updates = [];
  const wantedKeys = new Set();
  for (const w of wanted) {
    wantedKeys.add(w.key);
    const e = byKey.get(w.key);
    if (!e) inserts.push(w);
    else if (!sameEvent(w, e)) updates.push({ id: e.id, w });
  }
  for (const [key, e] of byKey) {
    if (wantedKeys.has(key)) continue;
    if (!allowDelete[sourceOfKey(key)]) continue;
    deletes.push({ id: e.id, key, reason: 'gone' });
  }
  return { inserts, updates, deletes };
}

// 1 人ぶんの同期。削除 → 追加 → 更新の順に、合計 maxChanges 件まで。認証・権限のエラーは投げ、それ以外は errors に数えて続ける
export async function syncPerson(gcal, { slot, calendarId, wanted, allowDelete, now = Date.now(), maxChanges = MAX_CALENDAR_CHANGES, dryRun = false, log = () => {} }) {
  const todayMs = jstMs(jstTodayIso(now), '00:00');
  const existing = await gcal.listBotEvents(calendarId, { timeMin: toJstIso(todayMs), timeMax: toJstIso(todayMs + LOOKAHEAD_DAYS * 86400000) });
  const d = diffEvents(wanted, existing, { allowDelete });
  const stats = { inserted: 0, updated: 0, deleted: 0, errors: 0, remaining: 0, wanted: wanted.length, existing: existing.length, dryRun };
  const total = d.deletes.length + d.inserts.length + d.updates.length;
  if (dryRun) {
    stats.remaining = total;
    stats.plan = { inserts: d.inserts.map((w) => w.key), updates: d.updates.map((u) => u.w.key), deletes: d.deletes.map((x) => x.key) };
    log(`[gcal:${slot}] dry-run: 追加 ${d.inserts.length} / 更新 ${d.updates.length} / 削除 ${d.deletes.length}(カレンダーには触らない)`);
    return stats;
  }
  let budget = maxChanges;
  const run = async (fn, field) => {
    if (budget <= 0) return;
    budget -= 1;
    try {
      await fn();
      stats[field] += 1;
    } catch (e) {
      if (isGcalAuthError(e)) throw e;
      stats.errors += 1;
      log(`[gcal:${slot}] ${field} に失敗: ${e.message}`);
    }
  };
  for (const x of d.deletes) await run(() => gcal.remove(calendarId, x.id), 'deleted');
  for (const w of d.inserts) await run(() => gcal.insert(calendarId, eventBody(w)), 'inserted');
  for (const u of d.updates) await run(() => gcal.patch(calendarId, u.id, eventBody(u.w)), 'updated');
  stats.remaining = Math.max(0, total - (maxChanges - budget));
  log(`[gcal:${slot}] 追加 ${stats.inserted} / 更新 ${stats.updated} / 削除 ${stats.deleted}${stats.errors ? ` / 失敗 ${stats.errors}` : ''}${stats.remaining ? ` / 残り ${stats.remaining} 件は次回` : ''}(望む ${stats.wanted} 件・カレンダー ${stats.existing} 件)`);
  return stats;
}

// 認証・権限の失敗が続いたら 1 回だけ知らせる。KV の書き込みは「失敗の始まり」「知らせた」「直った」の 3 回だけ
export async function trackAuthFailure(env, failing, { now = Date.now(), push = pushText } = {}) {
  if (!env.BOOKING_KV) return null;
  const raw = await env.BOOKING_KV.get(KV_SYNC_STATE);
  const st = raw ? JSON.parse(raw) : null;
  if (!failing) {
    if (st) await env.BOOKING_KV.delete(KV_SYNC_STATE);
    return null;
  }
  if (!st) {
    const next = { since: now, alerted: false };
    await env.BOOKING_KV.put(KV_SYNC_STATE, JSON.stringify(next));
    return next;
  }
  if (!st.alerted && now - st.since >= ALERT_AFTER_MS) {
    if (env.LINE_CHANNEL_ACCESS_TOKEN && env.LINE_GROUP_ID) await push(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_GROUP_ID, MSG_CALENDAR_ALERT);
    const next = { ...st, alerted: true, alertedAt: now };
    await env.BOOKING_KV.put(KV_SYNC_STATE, JSON.stringify(next));
    return next;
  }
  return st;
}

// 同期の本体。fetchResults(slots) / fetchTb(slots) は index.js が渡す(Cron と /auto/calendar-sync で待ち時間が違うため)
export async function runCalendarSync(env, { fetchResults, fetchTb, now = Date.now(), push = pushText, gcal, persons = null, dryRun = false, reason = 'cron', maxChanges = MAX_CALENDAR_CHANGES } = {}) {
  if (!calendarSyncEnabled(env)) return { skipped: 'disabled' };
  const cals = configuredCalendars(env).filter((c) => !persons || persons.includes(c.slot));
  if (cals.length === 0) return { skipped: 'no-calendar' };
  if (calendarSyncMode(env) === 'dry') dryRun = true;
  const slots = cals.map((c) => c.slot);
  const started = Date.now();
  const [results, tb] = await Promise.all([
    typeof fetchResults === 'function' ? fetchResults(slots).catch((e) => (console.error(`[gcal] 都の予約の取得に失敗: ${e.message}`), null)) : Promise.resolve([]),
    typeof fetchTb === 'function' ? fetchTb(slots).catch((e) => (console.error(`[gcal] テニスベアの予定の取得に失敗: ${e.message}`), null)) : Promise.resolve([]),
  ]);
  const client = gcal || createGcalClient(env, { log: (m) => console.log(`[gcal] ${m}`) });
  const out = { reason, dryRun, authFailed: false };
  for (const c of cals) {
    const site = Array.isArray(results) ? results.find((r) => r.slot === c.slot) : null;
    const t = Array.isArray(tb) ? tb.find((x) => x.slot === c.slot) : null;
    // 都: その人の結果が無い(未設定)か error なら「取れなかった」。テニスベア: 全体が落ちた(null)か error なら「取れなかった」。
    //     テニスベアの登録が無い人(配列にいない)は「予定 0 件」として扱い、残っている tb: の予定は消してよい
    const siteOk = !!site && !site.error;
    const tbOk = Array.isArray(tb) && (!t || !t.error);
    const wanted = [
      ...(siteOk ? wantedFromSite(site.reservations, { now }) : []),
      ...(tbOk ? wantedFromTennisbear(t?.events || [], { now }) : []),
    ];
    try {
      out[c.slot] = await syncPerson(client, {
        slot: c.slot,
        calendarId: c.calendarId,
        wanted,
        allowDelete: { site: siteOk, tb: tbOk },
        now,
        maxChanges,
        dryRun,
        log: (m) => console.log(m),
      });
      if (!siteOk || !tbOk) out[c.slot].noDelete = [!siteOk ? 'site' : '', !tbOk ? 'tb' : ''].filter(Boolean);
    } catch (e) {
      const auth = isGcalAuthError(e);
      if (auth) out.authFailed = true;
      out[c.slot] = { error: e.message, auth };
      console.error(`[gcal:${c.slot}] 同期に失敗(${auth ? '認証・権限' : 'エラー'}): ${e.message}`);
    }
  }
  try {
    await trackAuthFailure(env, out.authFailed, { now, push });
  } catch (e) {
    console.error(`[gcal] 失敗の記録に失敗: ${e.message}`);
  }
  console.log(`[gcal] 同期 ${reason}${dryRun ? '(dry-run)' : ''}: ${slots.join('・')} / Google への通信 ${client.calls} 回 (${Date.now() - started}ms)`);
  return out;
}

// キャンセル完了直後に、その予約の予定だけをカレンダーから消す(都のサイトには行かない)。失敗してもログだけ。戻り値: 消した件数
export async function removeCalendarEvent(env, slot, key, { gcal } = {}) {
  if (!calendarSyncEnabled(env)) return 0;
  const cal = configuredCalendars(env).find((c) => c.slot === slot);
  if (!cal) return 0;
  if (calendarSyncMode(env) === 'dry') {
    console.log(`[gcal:${slot}] dry-run: キャンセル直後の削除はしない`);
    return 0;
  }
  const client = gcal || createGcalClient(env, { log: (m) => console.log(`[gcal] ${m}`) });
  try {
    const items = await client.listBotEvents(cal.calendarId, { key });
    let n = 0;
    for (const it of items) if (await client.remove(cal.calendarId, it.id)) n += 1;
    console.log(`[gcal:${slot}] キャンセル直後の削除: ${n} 件`);
    return n;
  } catch (e) {
    console.error(`[gcal:${slot}] キャンセル直後の削除に失敗(次の同期で消えます): ${e.message}`);
    return 0;
  }
}
