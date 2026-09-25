// ============================================================
// フェーズ3 自動予約の週報(Cloudflare の Cron Trigger。wrangler.toml [triggers])。2026-09-25 追加。
//
//   目的: 「自動予約が正しく動いているか」を人が毎週ひと目で確かめられるようにする。
//         毎時の生存監視(monitor.js)は「Pi が落ちた・照会が止まった」しか見ない。成立したか、なぜ見送ったか、
//         照会の失敗が増えていないか、は Pi のログにしか無く、そのログもコンテナの作り直しで消える。
//         そこで Pi が日ごとの記録(booking/src/auto-journal.js)を 14 日分残し、Worker が週 1 回まとめて LINE に送る。
//
//   いつ: 毎週月曜 9:00 JST(= 月曜 0:00 UTC)。前の週(月〜日)の 7 日分。
//   何を: Pi の /auto/report(トンネル越し。予約番号・利用者情報は含まれない)を読み、1 枚のカード(Flex)で
//         成立した枠 / 取れなかった・見送った件数(理由別)/ 照会の回数と失敗率 / いまの状態 / 今後の自動予約 を出す。
//         気になる点(ON になっていない・失敗率が高い・照会の無い日・ログイン拒否 など)があれば一番上に琥珀色で並べる。
//         ボタンは付けない(見るだけのカード)。
//   Pi に繋がらないとき: 「集計できませんでした」とテキスト 1 通(Pi が落ちているなら毎時の監視が別に知らせている)。
//   通数: グループ宛の push 1 回 = 2 通 / 週(月 8〜10 通)。KV には書かない。
//
//   手元で試す: cd worker && npx wrangler dev --test-scheduled → curl "http://localhost:8787/__scheduled?cron=0+0+*+*+1"
// ============================================================
import { pushMessages, pushText } from './line.js';

// 月曜 9:00 JST = 月曜 0:00 UTC
export const WEEKLY_REPORT_CRON = '0 0 * * 1';
export const REPORT_DAYS = 7;

const KV_URL_KEY = 'booking_url'; // booking.js / auto.js と同じ(Pi のトンネル URL)
const FETCH_ATTEMPTS = 3;
const FETCH_RETRY_MS = 15000;
const FETCH_TIMEOUT_MS = 10000;
// 「最後の照会が古い」とみなす閾値(monitor.js の AUTO_STALL_MS と同じ 15 分)
const STALE_MS = 15 * 60 * 1000;
// 気になる点にする閾値
export const FAIL_RATE_WARN = 0.2; // 照会の失敗率(cycles が MIN_CYCLES_FOR_RATE 以上のときだけ判定)
const MIN_CYCLES_FOR_RATE = 30;
const RESTARTS_WARN = 4;
const HEARTBEAT_FAIL_RATE_WARN = 0.1;
const ERROR_EVENTS_WARN = 3;
const MAX_SUCCESS_ROWS = 10;
const MAX_UPCOMING_ROWS = 6;

const COLOR_HEADER_BG = '#1F2A44';
const COLOR_TEXT = '#111827';
const COLOR_SUB = '#4B5563';
const COLOR_MUTED = '#9CA3AF';
const COLOR_LINE = '#E5E7EB';
const COLOR_PANEL_BG = '#F3F4F6';
const COLOR_LABEL_BG = '#E8EDF5';
const COLOR_LABEL_FG = '#1F2A44';
const COLOR_OK = '#15803D';
const COLOR_NG = '#B91C1C';
const COLOR_WARN_BG = '#FFF7E6';
const COLOR_WARN_FG = '#8A4B00';
const DOW = ['日', '月', '火', '水', '木', '金', '土'];

const JST_OFFSET_MS = 9 * 3600 * 1000;
export const jstDayIso = (ms) => new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
const jstHHMM = (ms) => new Date(ms + JST_OFFSET_MS).toISOString().slice(11, 16);
const jstMD = (ms) => {
  const [, m, d] = jstDayIso(ms).split('-').map(Number);
  return `${m}/${d}`;
};
function fmtDate(iso, { dow = true } = {}) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return dow ? `${m}/${d}(${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})` : `${m}/${d}`;
}
const fmtTime = (hhmm) => String(hhmm || '').replace(/^0/, '');
const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : '-');
const text = (str, extra = {}) => ({ type: 'text', text: String(str), ...extra });

// 候補ごとの結果(auto-runner.js の status)を、人に見せる理由にまとめる
export const REASON_LABELS = [
  ['taken', '先に他の人に取られた'],
  ['conflict', '予定と重なる・隣が別の場所'],
  ['capped', 'その日は既に予約あり(上限)'],
  ['skipped_tennisbear', 'テニスベアの予定が取れず'],
  ['dry_run', '自動予約が OFF だった'],
  ['not_target', '予約直前に対象外(日付が変わった等)'],
  ['duplicate', 'サイトが断った'],
  ['error', 'サイトのエラー'],
  ['auth_error', 'ログインが拒否された'],
  ['rejected', 'reCAPTCHA で拒否'],
  ['abandoned', '人の確認が終わらなかった'],
  ['other', 'その他'],
];
export function reasonOf(status) {
  if (status === 'success') return null;
  if (status.startsWith('skipped_')) return status === 'skipped_tennisbear' ? 'skipped_tennisbear' : 'not_target';
  return REASON_LABELS.some(([k]) => k === status) ? status : 'other';
}

// Pi の /auto/report を読む。戻り値: { ok: true, report } | { ok: false, reason }
export async function fetchAutoReport(env, { days = REPORT_DAYS + 1, attempts = FETCH_ATTEMPTS, retryMs = FETCH_RETRY_MS, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const registered = await env.BOOKING_KV.get(KV_URL_KEY);
  if (!registered) return { ok: false, reason: 'Pi からの URL 登録がありません(Pi・Docker・回線のどれかが止まっている可能性)' };
  let reason = '';
  for (let n = 1; n <= attempts; n++) {
    try {
      const res = await fetch(`${registered}/auto/report?days=${days}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const report = await res.json();
        if (report && Array.isArray(report.days)) return { ok: true, report };
        reason = 'Pi の応答が想定と違います(古いコードのままかも。Pi を再ビルドしてください)';
      } else {
        reason = `トンネル越しの応答が HTTP ${res.status}`;
      }
    } catch (e) {
      reason = `トンネル越しに届きません(${e.name === 'TimeoutError' ? 'タイムアウト' : e.message})`;
    }
    if (n < attempts) await new Promise((r) => setTimeout(r, retryMs));
  }
  return { ok: false, reason: `${reason}(${attempts} 回試行)` };
}

// Pi の report → カードに出す形。now は JST の「今日」を決めるのに使う(今日の分は集計から外し、前日までの REPORT_DAYS 日にする)
export function summarizeReport(report, { now = Date.now(), days = REPORT_DAYS } = {}) {
  const today = jstDayIso(now);
  let dayList = (report.days || []).filter((d) => d.date < today);
  dayList = dayList.slice(-days);
  const from = dayList[0]?.date || report.from || today;
  const to = dayList.at(-1)?.date || report.to || today;
  const inRange = (e) => {
    const d = jstDayIso(e.at);
    return d >= from && d <= to;
  };
  const events = (report.events || []).filter((e) => e && typeof e.at === 'number' && typeof e.status === 'string' && inRange(e));

  const total = (k) => dayList.reduce((s, d) => s + (Number(d[k]) || 0), 0);
  const cycles = total('cycles');
  const failed = total('failed');
  const heartbeatFailed = total('heartbeatFailed');
  const restarts = total('restarts');
  const newSlots = total('newSlots');
  const quietDays = dayList.filter((d) => !(Number(d.cycles) > 0)).map((d) => d.date);

  const successes = events
    .filter((e) => e.status === 'success')
    .sort((a, b) => a.at - b.at)
    .map((e) => ({ at: e.at, person: e.person, date: e.date, start: e.start, facility: e.facility }));
  const reasons = new Map();
  for (const e of events) {
    const r = reasonOf(e.status);
    if (r) reasons.set(r, (reasons.get(r) || 0) + 1);
  }
  const misses = REASON_LABELS.filter(([k]) => reasons.has(k)).map(([k, label]) => ({ key: k, label, count: reasons.get(k) }));
  const missTotal = misses.reduce((s, m) => s + m.count, 0);

  const upcoming = (report.own || [])
    .filter((o) => o && o.date >= today)
    .sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`))
    .map((o) => ({ person: o.person, date: o.date, start: o.start, end: o.end, facility: o.facility }));

  const lastCycleAt = typeof report.lastCycle?.at === 'number' ? report.lastCycle.at : null;
  const mode = typeof report.mode === 'string' ? report.mode : 'off';
  const stale = lastCycleAt == null || now - lastCycleAt > STALE_MS;
  const status = { mode, enabled: report.enabled, lastCycleAt, stale, authPaused: Array.isArray(report.authPaused) ? report.authPaused : [] };

  // 気になる点(上から重要な順)
  const warnings = [];
  if (mode !== 'on') {
    const modeText = mode === 'paused' ? '「せってい」で OFF になっている' : mode === 'dry-run' ? 'Pi が試運転(dry-run)' : `Pi の設定が ${mode}`;
    warnings.push(`自動予約が ON になっていません(${modeText})`);
  }
  if (stale) warnings.push(`最後の照会が古いです(${lastCycleAt ? `${jstMD(lastCycleAt)} ${jstHHMM(lastCycleAt)}` : '記録なし'})。Pi で docker compose logs booking を確認`);
  const authPersons = new Set(status.authPaused);
  for (const e of events) if (e.status === 'auth_error' && e.person) authPersons.add(e.person);
  if (authPersons.size > 0) warnings.push(`ログインが拒否されました(予約者 ${[...authPersons].join('・')})。利用者番号・パスワード・カードの有効期限を確認`);
  if (events.some((e) => e.status === 'rejected')) warnings.push('reCAPTCHA で拒否された回があります');
  if (quietDays.length > 0) warnings.push(`照会が 1 回もない日: ${quietDays.map((d) => fmtDate(d)).join('・')}`);
  if (cycles >= MIN_CYCLES_FOR_RATE && failed / cycles >= FAIL_RATE_WARN) warnings.push(`照会の失敗が多いです(${pct(failed, cycles)})。自宅の回線か予約サイトの不調かも`);
  if (cycles >= MIN_CYCLES_FOR_RATE && heartbeatFailed / cycles >= HEARTBEAT_FAIL_RATE_WARN) warnings.push(`Worker への合図の失敗が多いです(${heartbeatFailed} 回)。自宅の回線の不調かも`);
  if (restarts >= RESTARTS_WARN) warnings.push(`予約サーバーの再起動が ${restarts} 回ありました`);
  const tbMiss = reasons.get('skipped_tennisbear') || 0;
  if (tbMiss > 0) warnings.push(`テニスベアの予定が取れず見送った候補が ${tbMiss} 件`);
  const siteErrors = reasons.get('error') || 0;
  if (siteErrors >= ERROR_EVENTS_WARN) warnings.push(`サイトのエラーで失敗した候補が ${siteErrors} 件`);

  return { from, to, days: dayList, cycles, failed, heartbeatFailed, restarts, newSlots, successes, misses, missTotal, upcoming, status, warnings };
}

// ---- カード ----
const labelOf = (labels, person) => labels?.[person] || person || '?';
// 予約者の名前ラベル(「よやく」の一覧と同じ薄い紺)
const personChip = (label) => ({
  type: 'box',
  layout: 'vertical',
  flex: 0,
  backgroundColor: COLOR_LABEL_BG,
  cornerRadius: 'sm',
  paddingTop: '2px',
  paddingBottom: '2px',
  paddingStart: '6px',
  paddingEnd: '6px',
  contents: [text(label, { size: 'xxs', weight: 'bold', color: COLOR_LABEL_FG })],
});
const heading = (title, count = null) => ({
  type: 'box',
  layout: 'horizontal',
  margin: 'xl',
  alignItems: 'center',
  contents: [
    text(title, { size: 'sm', weight: 'bold', color: COLOR_TEXT, flex: 1 }),
    ...(count != null ? [text(`${count} 件`, { size: 'sm', weight: 'bold', color: count > 0 ? COLOR_TEXT : COLOR_MUTED, flex: 0, align: 'end' })] : []),
  ],
});
const slotRow = (s, label) => ({
  type: 'box',
  layout: 'horizontal',
  margin: 'sm',
  alignItems: 'center',
  contents: [text(`${fmtDate(s.date)} ${fmtTime(s.start)}${s.end ? `-${fmtTime(s.end)}` : ''} ${s.facility || ''}`, { size: 'sm', color: COLOR_TEXT, flex: 1, wrap: true }), personChip(label)],
});
const kvRow = (k, v, { color = COLOR_TEXT } = {}) => ({
  type: 'box',
  layout: 'horizontal',
  margin: 'sm',
  contents: [text(k, { size: 'sm', color: COLOR_SUB, flex: 1, wrap: true }), text(v, { size: 'sm', color, flex: 0, align: 'end' })],
});

// model = summarizeReport() の戻り値。labels = { A: '呼び名', B: '呼び名' }
export function buildAutoReportFlex(model, { labels = {}, nowText = '' } = {}) {
  const body = [];
  if (model.warnings.length > 0) {
    body.push({
      type: 'box',
      layout: 'vertical',
      margin: 'md',
      backgroundColor: COLOR_WARN_BG,
      cornerRadius: 'md',
      paddingAll: '10px',
      contents: [text('⚠ 気になる点', { size: 'xs', weight: 'bold', color: COLOR_WARN_FG }), ...model.warnings.map((w) => text(`・${w}`, { size: 'xs', color: COLOR_WARN_FG, wrap: true, margin: 'xs' }))],
    });
  } else {
    body.push({
      type: 'box',
      layout: 'vertical',
      margin: 'md',
      backgroundColor: COLOR_PANEL_BG,
      cornerRadius: 'md',
      paddingAll: '10px',
      contents: [text('✅ 気になる点はありません', { size: 'xs', weight: 'bold', color: COLOR_OK })],
    });
  }

  body.push(heading('成立した自動予約', model.successes.length));
  if (model.successes.length === 0) body.push(text('なし', { size: 'sm', color: COLOR_MUTED, margin: 'sm' }));
  model.successes.slice(0, MAX_SUCCESS_ROWS).forEach((s) => body.push(slotRow(s, labelOf(labels, s.person))));
  if (model.successes.length > MAX_SUCCESS_ROWS) body.push(text(`…ほか${model.successes.length - MAX_SUCCESS_ROWS}件`, { size: 'xs', color: COLOR_MUTED, margin: 'sm' }));

  body.push(heading('取れなかった・見送った候補', model.missTotal));
  if (model.misses.length === 0) body.push(text('なし', { size: 'sm', color: COLOR_MUTED, margin: 'sm' }));
  model.misses.forEach((m) => body.push(kvRow(m.label, `${m.count} 件`)));

  body.push({ type: 'separator', color: COLOR_LINE, margin: 'xl' });
  body.push(heading('空きの照会'));
  body.push(kvRow('照会した回数', `${model.cycles.toLocaleString('ja-JP')} 回`));
  body.push(kvRow('うち失敗(回線・サイトの不調)', `${model.failed.toLocaleString('ja-JP')} 回(${pct(model.failed, model.cycles)})`, { color: model.cycles > 0 && model.failed / model.cycles >= FAIL_RATE_WARN ? COLOR_NG : COLOR_TEXT }));
  body.push(kvRow('新しく出た空き', `${model.newSlots} 件`));
  body.push(kvRow('Worker 合図の失敗 / 再起動', `${model.heartbeatFailed} 回 / ${model.restarts} 回`));

  body.push({ type: 'separator', color: COLOR_LINE, margin: 'xl' });
  body.push(heading('いまの状態'));
  const st = model.status;
  const on = st.mode === 'on' && !st.stale;
  body.push(
    kvRow('自動予約', on ? `稼働中(最終チェック ${jstHHMM(st.lastCycleAt)})` : st.mode === 'on' ? '合図なし' : st.mode === 'paused' ? 'OFF(せってい)' : st.mode === 'dry-run' ? '試運転(dry-run)' : `停止(${st.mode})`, { color: on ? COLOR_OK : COLOR_NG })
  );
  body.push(heading('今後の自動予約', model.upcoming.length));
  if (model.upcoming.length === 0) body.push(text('なし', { size: 'sm', color: COLOR_MUTED, margin: 'sm' }));
  model.upcoming.slice(0, MAX_UPCOMING_ROWS).forEach((s) => body.push(slotRow(s, labelOf(labels, s.person))));
  if (model.upcoming.length > MAX_UPCOMING_ROWS) body.push(text(`…ほか${model.upcoming.length - MAX_UPCOMING_ROWS}件(「よやく」で全部見られます)`, { size: 'xs', color: COLOR_MUTED, margin: 'sm' }));

  body.push(text('毎週月曜 9:00 に前の週(月〜日)の分を送ります。細かい経緯は Pi の docker compose logs booking で。', { size: 'xxs', color: COLOR_SUB, wrap: true, margin: 'xl' }));

  return {
    type: 'flex',
    altText: autoReportAltText(model),
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'horizontal',
        backgroundColor: COLOR_HEADER_BG,
        paddingAll: '14px',
        paddingStart: '16px',
        paddingEnd: '16px',
        contents: [
          text('📋 自動予約の週報', { color: '#FFFFFF', weight: 'bold', size: 'lg', flex: 1, gravity: 'center' }),
          text(nowText || `${fmtDate(model.from, { dow: false })}〜${fmtDate(model.to, { dow: false })}`, { color: '#E5E7EB', size: 'xs', flex: 0, gravity: 'center', align: 'end' }),
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', paddingTop: '4px', backgroundColor: '#FFFFFF', contents: body },
    },
  };
}

export function autoReportAltText(model) {
  const head = `📋 自動予約の週報(${fmtDate(model.from, { dow: false })}〜${fmtDate(model.to, { dow: false })}): 成立 ${model.successes.length} 件・見送り ${model.missTotal} 件・照会失敗 ${pct(model.failed, model.cycles)}`;
  return `${head}${model.warnings.length > 0 ? ` ⚠ 気になる点 ${model.warnings.length} 件` : ''}`.slice(0, 400);
}

// Flex が弾かれたときのテキスト版
export function autoReportText(model, { labels = {} } = {}) {
  const lines = [`📋 自動予約の週報(${fmtDate(model.from)}〜${fmtDate(model.to)})`];
  if (model.warnings.length > 0) lines.push('⚠ 気になる点:', ...model.warnings.map((w) => `・${w}`));
  else lines.push('✅ 気になる点はありません');
  lines.push('', `成立 ${model.successes.length} 件`);
  for (const s of model.successes) lines.push(`・${fmtDate(s.date)} ${fmtTime(s.start)} ${s.facility || ''} ${labelOf(labels, s.person)}`);
  lines.push(`取れなかった・見送り ${model.missTotal} 件${model.misses.length ? `(${model.misses.map((m) => `${m.label} ${m.count}`).join('、')})` : ''}`);
  lines.push(`照会 ${model.cycles} 回(失敗 ${model.failed} 回・${pct(model.failed, model.cycles)})、新しい空き ${model.newSlots} 件、合図の失敗 ${model.heartbeatFailed} 回、再起動 ${model.restarts} 回`);
  lines.push(`いま: ${model.status.mode === 'on' && !model.status.stale ? `稼働中(最終チェック ${jstHHMM(model.status.lastCycleAt)})` : `mode=${model.status.mode}${model.status.stale ? '・合図なし' : ''}`}`);
  if (model.upcoming.length > 0) lines.push(`今後の自動予約: ${model.upcoming.map((s) => `${fmtDate(s.date)} ${fmtTime(s.start)} ${s.facility || ''} ${labelOf(labels, s.person)}`).join(' / ')}`);
  return lines.join('\n');
}

export const MSG_REPORT_UNAVAILABLE = (reason) => `📋 自動予約の週報: 自宅の予約サーバー(Pi)から記録を取れず、集計できませんでした\n${reason}\nPi が動いていれば来週また送ります。いま止まっているなら毎時の監視が別に知らせます`;

// 週報を作って LINE に送る。戻り値: { ok, sent: 'flex'|'text'|null, model?, reason? }
export async function runWeeklyReport(env, { now = Date.now(), fetchReport = fetchAutoReport, push = pushMessages, pushPlain = pushText } = {}) {
  const r = await fetchReport(env);
  if (!r.ok) {
    console.log(`[report] Pi から記録を取れず: ${r.reason}`);
    await pushPlain(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_GROUP_ID, MSG_REPORT_UNAVAILABLE(r.reason));
    return { ok: false, sent: 'text', reason: r.reason };
  }
  const model = summarizeReport(r.report, { now });
  const labels = { A: env.LABEL_A || 'A', B: env.LABEL_B || 'B' };
  const summary = `${model.from}〜${model.to} 成立 ${model.successes.length} 件・見送り ${model.missTotal} 件・照会 ${model.cycles} 回(失敗 ${model.failed})・気になる点 ${model.warnings.length} 件`;
  try {
    await push(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_GROUP_ID, [buildAutoReportFlex(model, { labels })]);
    console.log(`[report] 週報を送信: ${summary}`);
    return { ok: true, sent: 'flex', model };
  } catch (e) {
    if (e.status !== 400) throw e;
    console.log(`[report] Flex が弾かれたためテキストで送ります: ${e.message}`);
    await pushPlain(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_GROUP_ID, autoReportText(model, { labels }));
    console.log(`[report] 週報をテキストで送信: ${summary}`);
    return { ok: true, sent: 'text', model };
  }
}
