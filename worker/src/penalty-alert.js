// ============================================================
// フェーズ4 ペナルティ予告アラート(Cloudflare の Cron Trigger。wrangler.toml [triggers])
//
//   目的: 「今日 23:59 までにキャンセルすればペナルティが付かない」予約を取りこぼさないようにする。
//         予約サイトの取消は 利用日 <= 今日 + penaltyday(=3)日 になるとペナルティ 1 点が付く(cancel-token.js の penaltyApplies)。
//         つまり 利用日 = 今日 + 4 日 の予約は「今日中」が無料で手放せる最後の日。日付が変わると自動的にペナルティ対象になる。
//
//   いつ: 毎朝 9:00 JST(予告)と 毎日 23:35 JST(最終確認)。
//         23:35 は フェーズ3 自動予約の LAST_DAY_DEADLINE(lib/config.js)と同じ時刻で、
//         「この時刻以降は +4 日の枠を自動では取らない」= 対象の予約がこれ以上増えなくなる瞬間。
//
//   何を: 対象の予約だけを並べた Flex カードを LINE グループに push。各行に「キャンセル」ボタン(フェーズ1.6 と同じ postback)。
//         ボタンの期限は今日の 23:59:59。日付が変わると「時間切れです」になり、うっかり 0 時過ぎに押して
//         ペナルティ付きで取り消す事故を防ぐ(承知のうえで消すときは「よやく」からやり直せば警告付きで消せる)。
//
//   送らない場合: 対象が 0 件なら何も送らない(グループ宛の push は 1 回で 2 通消費し、無料枠は月 200 通)。
//         ただし 23:35 に予約サイトへ繋がらず確認できなかったときだけ、テキスト 1 通で「確認できませんでした」と知らせる
//         (朝 9 時は 23:35 に再挑戦できるので黙っておく)。
//         23:35 の対象が 朝 9:00 に送った内容と同じ(または減っているだけ)なら送らない(2026-09-17 本人決定。通数の節約)。
//         朝に送った予約番号を KV の penalty_alert_sent に控え(1 日 1 回の書き込み)、23:35 は朝に無かった予約があるときだけ送る。
//         朝のカードのボタンは 23:59 まで押せるので、同じ内容をもう一度送る必要はない。
//
//   手元で試す: cd worker && npx wrangler dev --test-scheduled
//              curl "http://localhost:8787/__scheduled?cron=0+0+*+*+*"    (朝 9 時ぶん)
//              curl "http://localhost:8787/__scheduled?cron=35+14+*+*+*"  (23:35 ぶん)
// ============================================================
import { pushMessages } from './line.js';
import { buildPenaltyAlertFlex } from './flex.js';
import { penaltyApplies } from './cancel-token.js';
import { formatDate, formatTime } from './format.js';

// 9:00 JST = 0:00 UTC / 23:35 JST = 14:35 UTC
export const MORNING_CRON = '0 0 * * *';
export const DEADLINE_CRON = '35 14 * * *';
export const PENALTY_ALERT_CRONS = [MORNING_CRON, DEADLINE_CRON];

// 一覧から penaltyday が取れなかった予約の既定値(サイトの hidden と lib/config.js の AUTO_BOOKING.PENALTY_DAYS は 3)
export const DEFAULT_PENALTY_DAYS = 3;
// その日に送った予約番号の控え(KV)。{ date: 'YYYY-MM-DD', ids: ['予約番号', ...] }
export const KV_SENT_KEY = 'penalty_alert_sent';

const JST_OFFSET_MS = 9 * 3600 * 1000;
const DAY_MS = 86400000;

// unix ミリ秒 → JST の "YYYY-MM-DD"
export const jstDayIso = (ms) => new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
// unix ミリ秒 → JST の今日 23:59:59 の unix 秒(キャンセルボタンの期限)
export function endOfJstDaySec(ms) {
  const startOfDayMs = Math.floor((ms + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
  return Math.floor((startOfDayMs + DAY_MS) / 1000) - 1;
}
// ヘッダー右上の「9/17 23:35 現在」
const asOfText = (ms) => {
  const jst = new Date(ms + JST_OFFSET_MS).toISOString();
  const [, m, d] = jst.slice(0, 10).split('-').map(Number);
  return `${m}/${d} ${jst.slice(11, 16)} 現在`;
};

// 今日はペナルティ対象でないが、明日になると対象になる = 今日 23:59 が無料キャンセルの期限
export function isFreeCancelDeadlineToday(r, today, tomorrow) {
  if (!r?.date) return false;
  const days = r.penaltyDay ?? DEFAULT_PENALTY_DAYS;
  return !penaltyApplies(r.date, days, today) && penaltyApplies(r.date, days, tomorrow);
}

// results: buildReservationReply と同じ形 [{ slot, label, reservations } | { slot, label, error }]
// 戻り値 { rows: [{ label, slot, reservation }](日付・開始時刻順), failed: [label] }
export function pickDeadlineToday(results, { today, tomorrow }) {
  const rows = [];
  const failed = [];
  for (const p of results) {
    if (p.error) {
      failed.push(p.label);
      continue;
    }
    for (const r of p.reservations || []) {
      if (isFreeCancelDeadlineToday(r, today, tomorrow)) rows.push({ label: p.label, slot: p.slot, reservation: r });
    }
  }
  rows.sort(
    (a, b) =>
      (a.reservation.date || '').localeCompare(b.reservation.date || '') ||
      (a.reservation.start || '').localeCompare(b.reservation.start || '') ||
      (a.slot || '').localeCompare(b.slot || '')
  );
  return { rows, failed };
}

// Flex が 400(形式不備)で弾かれたときのテキスト版
export function alertText(rows, { deadline }) {
  const lines = [
    deadline
      ? '⏰ まもなく期限です。今日 23:59 までにキャンセルすればペナルティは付きません'
      : '⏰ 今日 23:59 までにキャンセルすればペナルティが付かない予約があります',
  ];
  for (const { label, reservation: r } of rows) {
    lines.push(`・${label}  ${r.date ? formatDate(r.date) : '日付不明'} ${formatTime(r.start)}-${formatTime(r.end)} ${r.facility}`);
  }
  lines.push('「よやく」と送ると一覧からキャンセルできます');
  return lines.join('\n');
}

export const MSG_ALERT_FETCH_FAILED = (labels) =>
  `⏰ 今日 23:59 が無料キャンセルの期限ですが、予約サイトに繋がらず${labels.length ? `${labels.join('・')}の` : ''}予約を確認できませんでした\n心当たりがあれば予約サイトで確認してください`;

// Flex を push し、形式不備(400)ならテキストで送り直す
async function pushFlexOrText(env, flex, fallbackText, push) {
  try {
    await push(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_GROUP_ID, [flex]);
    return 'flex';
  } catch (e) {
    if (e.status !== 400) throw e;
    console.error(`[alert] Flex の push が 400 のためテキストで再送: ${e.message}`);
    await push(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_GROUP_ID, [{ type: 'text', text: fallbackText }]);
    return 'text';
  }
}

// Cron から呼ばれる本体。
//   kind         'morning'(9:00)| 'deadline'(23:35)
//   fetchResults A・B の予約一覧を取ってくる関数(index.js の fetchAllReservations を渡す)
//   attach       予約に「キャンセル」ボタンの署名付き data を付ける関数(index.js の attachCancelData)
// 戻り値 { rows, failed, sent }(sent: 'flex' | 'text' | null)
export async function runPenaltyAlert(env, { kind = 'morning', now = Date.now(), fetchResults, attach, push = pushMessages } = {}) {
  const started = Date.now();
  const today = jstDayIso(now);
  const tomorrow = jstDayIso(now + DAY_MS);
  const deadline = kind === 'deadline';

  let results;
  try {
    results = await fetchResults();
  } catch (e) {
    console.error(`[alert] 予約一覧の取得に失敗: ${e.message}`);
    results = null;
  }
  if (!results || results.length === 0) {
    if (deadline) {
      await push(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_GROUP_ID, [{ type: 'text', text: MSG_ALERT_FETCH_FAILED([]) }]);
      return { rows: 0, failed: [], sent: 'text' };
    }
    return { rows: 0, failed: [], sent: null };
  }

  // ボタンの期限は今日の 23:59:59(日付が変わるとペナルティ対象になるため、それ以降は押せなくする)
  if (attach) {
    try {
      await attach(results, { now, today, nowHHMM: new Date(now + JST_OFFSET_MS).toISOString().slice(11, 16), exp: endOfJstDaySec(now) });
    } catch (e) {
      console.error(`[alert] キャンセルボタンの署名に失敗(ボタン無しで続行): ${e.message}`);
    }
  }

  const { rows, failed } = pickDeadlineToday(results, { today, tomorrow });

  // 23:35: 朝 9:00 に送った内容と同じ(または減っているだけ)なら送らない。朝のカードのボタンは 23:59 まで使える
  const sentToday = await loadSentToday(env, today);
  if (deadline && rows.length > 0 && sentToday) {
    const newOnes = rows.filter((r) => !sentToday.ids.includes(r.reservation.id));
    if (newOnes.length === 0) {
      console.log(`[alert] ${kind}: 対象 ${rows.length} 件はすべて朝 9:00 に送った内容と同じ → 送信なし (${Date.now() - started}ms)`);
      return { rows: rows.length, failed, sent: null, skipped: 'same_as_morning' };
    }
  }

  if (rows.length === 0) {
    // 対象なしは送らない(通数の節約)。ただし 23:35 に「確認できなかった」ときだけは知らせる
    if (deadline && failed.length > 0) {
      await push(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_GROUP_ID, [{ type: 'text', text: MSG_ALERT_FETCH_FAILED(failed) }]);
      console.log(`[alert] ${kind}: 対象 0 件 / 取得失敗 ${failed.length} 人 → 確認できなかった旨を送信 (${Date.now() - started}ms)`);
      return { rows: 0, failed, sent: 'text' };
    }
    console.log(`[alert] ${kind}: 対象 0 件${failed.length ? ` / 取得失敗 ${failed.length} 人` : ''} → 送信なし (${Date.now() - started}ms)`);
    return { rows: 0, failed, sent: null };
  }

  const flex = buildPenaltyAlertFlex({ rows, kind, nowText: asOfText(now), failedLabels: failed });
  const sent = await pushFlexOrText(env, flex, alertText(rows, { deadline }), push);
  console.log(`[alert] ${kind}: 対象 ${rows.length} 件を ${sent} で送信${failed.length ? ` / 取得失敗 ${failed.length} 人` : ''} (${Date.now() - started}ms)`);
  await saveSentToday(env, today, [...(sentToday?.ids || []), ...rows.map((r) => r.reservation.id)]);
  return { rows: rows.length, failed, sent };
}

// 今日送った予約番号の控えを読む(無い・別の日・KV なし → null)
async function loadSentToday(env, today) {
  if (!env.BOOKING_KV) return null;
  try {
    const v = JSON.parse((await env.BOOKING_KV.get(KV_SENT_KEY)) || 'null');
    return v && v.date === today && Array.isArray(v.ids) ? v : null;
  } catch {
    return null;
  }
}
// 送った予約番号を控える(KV の書き込みは 1 日 1〜2 回。失敗しても送信自体には影響させない)
async function saveSentToday(env, today, ids) {
  if (!env.BOOKING_KV) return;
  try {
    await env.BOOKING_KV.put(KV_SENT_KEY, JSON.stringify({ date: today, ids: [...new Set(ids.filter(Boolean))] }), { expirationTtl: 2 * 86400 });
  } catch (e) {
    console.error(`[alert] 送信済みの控えを保存できませんでした(次回は同じ内容でも送る): ${e.message}`);
  }
}
