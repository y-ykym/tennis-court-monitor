// ============================================================
// 「じどう」への返信カード(フェーズ3 自動予約の除外設定)。flex.js と同じ配色・部品の考え方
//
//   ┌──────────────────────────────────┐
//   │ 🤖 自動予約の設定            9/14 現在 │  ← 濃紺ヘッダー
//   ├──────────────────────────────────┤
//   │ Pi の自動予約: 稼働中(最終チェック 10:31) │
//   │ 除外日(この日は自動予約しない)            │
//   │  9/27(土)                        [解除] │
//   │ 除外枠(手放した枠。取り直さない)          │
//   │  9/27(土) 13:00 大島小松川公園 (キャンセル) [解除] │
//   ├──────────────────────────────────┤
//   │ 📅 日を追加(日付ピッカー)   ↻ 更新       │
//   └──────────────────────────────────┘
// ============================================================

const COMMAND_TEXT = 'じどう';
const COLOR_HEADER_BG = '#1F2A44';
const COLOR_TEXT = '#111827';
const COLOR_SUB = '#4B5563';
const COLOR_MUTED = '#9CA3AF';
const COLOR_LINE = '#E5E7EB';
const COLOR_PILL_BG = '#E8EDF5';
const COLOR_PILL_FG = '#1F2A44';
const COLOR_OK = '#15803D';
const COLOR_NG = '#B91C1C';
const COLOR_NOTE_BG = '#ECFDF5';
const COLOR_NOTE_FG = '#065F46';
const MAX_ROWS = 15;
const DOW = ['日', '月', '火', '水', '木', '金', '土'];

const text = (str, extra = {}) => ({ type: 'text', text: String(str), ...extra });
function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}(${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
}
const fmtTime = (hhmm) => String(hhmm).replace(/^0/, '');
const jstHHMM = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(11, 16);

function statusLine(status) {
  if (status.alive && status.active) return { label: `稼働中(最終チェック ${jstHHMM(status.lastSeenAt)})`, color: COLOR_OK };
  if (status.alive) return { label: `停止中(${status.mode === 'dry-run' ? '照会だけの試運転 dry-run' : `mode=${status.mode || '?'}`}。空きは従来どおり通知)`, color: COLOR_NG };
  return { label: `停止中(Pi からの合図なし${status.lastSeenAt ? `。最後は ${jstHHMM(status.lastSeenAt)}` : ''}。空きは従来どおり通知)`, color: COLOR_NG };
}

function removePill(data, displayText) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    margin: 'sm',
    backgroundColor: COLOR_PILL_BG,
    cornerRadius: 'xl',
    paddingAll: '6px',
    paddingStart: '10px',
    paddingEnd: '10px',
    action: { type: 'postback', label: '解除', data, displayText },
    contents: [text('解除', { size: 'xxs', weight: 'bold', color: COLOR_PILL_FG })],
  };
}
const heading = (str) => text(str, { size: 'xs', color: COLOR_SUB, weight: 'bold', margin: 'xl' });
const row = (label, pill) => ({ type: 'box', layout: 'horizontal', margin: 'sm', alignItems: 'center', contents: [text(label, { size: 'sm', color: COLOR_TEXT, flex: 1, wrap: true, gravity: 'center' }), pill] });
const reasonText = (r) => (r === 'released' ? 'サイトで取消' : 'キャンセル済み');

// model = { status, dates: [{ date, removeData }], slots: [{ date, start, facility, reason, removeData }], addData, today, maxDate, note }
export function buildAutoSettingsFlex({ status, dates, slots, addData, today, maxDate, note = null }) {
  const st = statusLine(status);
  const body = [];
  if (note) {
    body.push({ type: 'box', layout: 'vertical', margin: 'md', backgroundColor: COLOR_NOTE_BG, cornerRadius: 'md', paddingAll: '10px', contents: [text(note, { size: 'xs', color: COLOR_NOTE_FG, wrap: true })] });
  }
  body.push({ type: 'text', margin: 'md', wrap: true, contents: [{ type: 'span', text: 'Pi の自動予約: ', size: 'xs', color: COLOR_SUB }, { type: 'span', text: st.label, size: 'xs', weight: 'bold', color: st.color }] });

  body.push(heading('除外日(この日は自動予約も空き通知もしない)'));
  if (dates.length === 0) body.push(text('なし', { size: 'sm', color: COLOR_MUTED, margin: 'sm' }));
  dates.slice(0, MAX_ROWS).forEach((d) => body.push(row(fmtDate(d.date), removePill(d.removeData, `${fmtDate(d.date)} の除外を解除`))));
  if (dates.length > MAX_ROWS) body.push(text(`…ほか${dates.length - MAX_ROWS}件`, { size: 'xs', color: COLOR_MUTED, margin: 'sm' }));

  body.push(heading('除外枠(手放した枠。空きが出ても取り直さない)'));
  if (slots.length === 0) body.push(text('なし', { size: 'sm', color: COLOR_MUTED, margin: 'sm' }));
  slots.slice(0, MAX_ROWS).forEach((s) => {
    const label = `${fmtDate(s.date)} ${fmtTime(s.start)} ${s.facility}(${reasonText(s.reason)})`;
    body.push(row(label, removePill(s.removeData, `${fmtDate(s.date)} ${fmtTime(s.start)} ${s.facility} の除外を解除`)));
  });
  if (slots.length > MAX_ROWS) body.push(text(`…ほか${slots.length - MAX_ROWS}件`, { size: 'xs', color: COLOR_MUTED, margin: 'sm' }));

  body.push(text('除外日・除外枠は日が過ぎると自動で消えます。除外した日・枠の空きは自動予約されず、空き通知も届きません。', { size: 'xxs', color: COLOR_MUTED, wrap: true, margin: 'xl' }));

  const [, tm, td] = today.split('-').map(Number);
  return {
    type: 'flex',
    altText: autoSettingsText({ status, dates, slots, today }).slice(0, 400),
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
        contents: [text('🤖 自動予約の設定', { color: '#FFFFFF', weight: 'bold', size: 'lg', flex: 1, gravity: 'center' }), text(`${tm}/${td} 現在`, { color: '#E5E7EB', size: 'xs', flex: 0, gravity: 'center', align: 'end' })],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', paddingTop: '4px', backgroundColor: '#FFFFFF', contents: body },
      footer: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFFFF',
        contents: [
          { type: 'separator', color: COLOR_LINE },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              // 日付ピッカー(LINE の datetimepicker)。選ぶと postback に params.date が付いて返る
              { type: 'button', style: 'link', height: 'sm', action: { type: 'datetimepicker', label: '📅 日を追加', data: addData, mode: 'date', initial: today, min: today, max: maxDate } },
              { type: 'button', style: 'link', height: 'sm', action: { type: 'message', label: '↻ 更新', text: COMMAND_TEXT } },
            ],
          },
        ],
      },
    },
  };
}

// テキスト版(Flex が 400 で弾かれたときの再送と altText)
export function autoSettingsText({ status, dates, slots, today }) {
  const lines = [`🤖 自動予約の設定(${fmtDate(today)})`, `Pi: ${statusLine(status).label}`];
  lines.push(`除外日: ${dates.length ? dates.map((d) => fmtDate(d.date)).join('、') : 'なし'}`);
  lines.push(`除外枠: ${slots.length ? slots.map((s) => `${fmtDate(s.date)} ${fmtTime(s.start)} ${s.facility}`).join('、') : 'なし'}`);
  return lines.join('\n');
}
