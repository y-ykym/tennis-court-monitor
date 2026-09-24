// ============================================================
// 「せってい」への返信カード(bot の設定メニュー)。flex.js と同じ配色・部品の考え方
//
//   2026-09-25 まで合言葉は「じどう」で、除外日・除外枠の一覧が主だった。中身は bot の設定全般
//   (自動予約の ON/OFF・空き通知カードの ON/OFF・除外日・除外枠)なので、合言葉を「せってい」にし、
//   打ち込みが必要だったスイッチ(「じどうおん」など)もこのカードのボタンから切り替えられる設定メニューにした。
//   スイッチのボタンは message アクション(押すとその合言葉が送られる)。署名も有効期限も要らず、
//   古いカードから押しても「ON にする」「OFF にする」と向きが決まっているので結果は同じ
//
//   ┌──────────────────────────────────┐
//   │ ⚙️ 設定                      9/25 現在 │  ← 濃紺ヘッダー
//   ├──────────────────────────────────┤
//   │ ┌ 自動予約                   ■OFF にする┐ │  ← 薄いグレーの枡。ボタンは濃紺の塗り
//   │ │ [ON] 稼働中(最終チェック 10:31)         │ │  ← 2 行目に 緑/赤 のバッジと説明
//   │ └──────────────────────────────┘ │
//   │ ┌ 空き通知カード              ■OFF にする┐ │
//   │ │ [ON] 新しい空きをカードで知らせます       │ │
//   │ └──────────────────────────────┘ │
//   │ ───────────────────────────────── │
//   │ 除外日  この日は自動予約も空き通知もしない    │
//   │  9/27(土)                         [解除] │
//   │ 除外枠  手放した枠。空きが出ても取り直さない  │
//   │  9/27(土) 13:00 大島小松川公園(キャンセル済み) [解除] │
//   ├──────────────────────────────────┤
//   │ 📅 除外日を追加(日付ピッカー)   ↻ 更新    │
//   └──────────────────────────────────┘
// ============================================================

const COMMAND_TEXT = 'せってい';
// スイッチのボタンが送る合言葉(auto.js の AUTO_ON_TEXT ほかと同じ値。auto.js → auto-flex.js の一方向 import を保つため、ここにも書く)
const AUTO_ON_TEXT = 'じどうおん';
const AUTO_OFF_TEXT = 'じどうおふ';
const NOTIFY_ON_TEXT = 'つうちおん';
const NOTIFY_OFF_TEXT = 'つうちおふ';

const COLOR_HEADER_BG = '#1F2A44';
const COLOR_TEXT = '#111827';
const COLOR_SUB = '#4B5563';
const COLOR_MUTED = '#9CA3AF';
const COLOR_LINE = '#E5E7EB';
const COLOR_PILL_BG = '#E8EDF5';
const COLOR_PANEL_BG = '#F3F4F6';
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

// 自動予約の行。スイッチ(LINE で切り替えられる)と、Pi の実際の状態(情報)を分けて出す
//   on: スイッチが ON か。detail: Pi の状態の説明。color: その説明の色(予約できる状態なら緑、そうでなければ赤)
export function autoSwitchView(status) {
  // LINE で OFF にした直後は Pi がまだ「稼働中」を申告していることがある(次の照会で反映)ので、スイッチの表示を優先する
  if (status.enabled === false) {
    return { on: false, detail: `停止中${status.active ? '(Pi への反映待ち 1〜3 分)' : ''}。空きは通知カードで届きます`, color: COLOR_NG };
  }
  if (status.alive && status.active) return { on: true, detail: `稼働中(最終チェック ${jstHHMM(status.lastSeenAt)})`, color: COLOR_OK };
  if (status.alive) {
    if (status.mode === 'dry-run') return { on: true, detail: 'Pi は照会だけの試運転(dry-run)。予約はしません', color: COLOR_NG };
    if (status.mode === 'paused') return { on: true, detail: 'ON の反映待ち(1〜3 分)', color: COLOR_SUB };
    return { on: true, detail: `Pi の設定が mode=${status.mode || '?'} のため予約しません`, color: COLOR_NG };
  }
  return { on: true, detail: `Pi からの合図なし${status.lastSeenAt ? `(最後は ${jstHHMM(status.lastSeenAt)})` : ''}。空きは通知カードで届きます`, color: COLOR_NG };
}
export function notifySwitchView(status) {
  const on = status.notifyEnabled !== false;
  return on
    ? { on, detail: '新しい空きをカードで知らせます', color: COLOR_OK }
    : { on, detail: '止めています(自動予約・結果カード・予告・「よやく」は動きます)', color: COLOR_NG };
}

// 角丸の小さいボタン(「解除」「OFF にする」など)。filled は濃紺の塗り(スイッチ用。薄い「解除」と区別がつくように)
function pill(label, action, { filled = false } = {}) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    margin: 'lg',
    backgroundColor: filled ? COLOR_HEADER_BG : COLOR_PILL_BG,
    cornerRadius: 'xl',
    paddingTop: '9px',
    paddingBottom: '9px',
    paddingStart: '16px',
    paddingEnd: '16px',
    action,
    contents: [text(label, { size: 'xs', weight: 'bold', color: filled ? '#FFFFFF' : COLOR_PILL_FG, align: 'center' })],
  };
}
const removePill = (data, displayText) => pill('解除', { type: 'postback', label: '解除', data, displayText });
// ON / OFF のバッジ(緑 / 赤の塗りに白文字)
const badge = (on) => ({
  type: 'box',
  layout: 'vertical',
  flex: 0,
  backgroundColor: on ? COLOR_OK : COLOR_NG,
  cornerRadius: 'sm',
  paddingTop: '2px',
  paddingBottom: '2px',
  paddingStart: '8px',
  paddingEnd: '8px',
  contents: [text(on ? 'ON' : 'OFF', { size: 'xs', weight: 'bold', color: '#FFFFFF' })],
});

// スイッチの枡(薄いグレー): 1 行目は「名前 … [OFF にする]」、2 行目は「[ON/OFF バッジ] 状態の説明」。
// 名前・バッジ・ボタンを 1 行に並べると「空き通知カード」の行で幅が足りず重なる。説明をボタンの横に置くと細い列に
// 押し込まれて読みにくい。ボタンは message アクション(押すと合言葉が送られる)
function switchRow(title, view, { onText, offText, first = false }) {
  const label = view.on ? 'OFF にする' : 'ON にする';
  return {
    type: 'box',
    layout: 'vertical',
    margin: first ? 'md' : 'md',
    backgroundColor: COLOR_PANEL_BG,
    cornerRadius: 'md',
    paddingAll: '12px',
    paddingStart: '14px',
    paddingEnd: '12px',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        alignItems: 'center',
        contents: [
          text(title, { size: 'md', weight: 'bold', color: COLOR_TEXT, flex: 1, gravity: 'center' }),
          pill(label, { type: 'message', label, text: view.on ? offText : onText }, { filled: true }),
        ],
      },
      {
        type: 'box',
        layout: 'horizontal',
        margin: 'md',
        alignItems: 'flex-start',
        contents: [badge(view.on), text(view.detail, { size: 'xs', color: view.color, wrap: true, flex: 1, margin: 'md' })],
      },
    ],
  };
}

// 見出し(名前 + 薄い説明)
const heading = (title, desc) => ({
  type: 'box',
  layout: 'vertical',
  margin: 'xl',
  contents: [text(title, { size: 'sm', weight: 'bold', color: COLOR_TEXT }), text(desc, { size: 'xs', color: COLOR_SUB, wrap: true, margin: 'xs' })],
});
const row = (label, pillBox) => ({ type: 'box', layout: 'horizontal', margin: 'md', alignItems: 'center', contents: [text(label, { size: 'md', color: COLOR_TEXT, flex: 1, wrap: true, gravity: 'center' }), pillBox] });
const reasonText = (r) => (r === 'released' ? 'サイトで取消' : 'キャンセル済み');

// model = { status, dates: [{ date, removeData }], slots: [{ date, start, facility, reason, removeData }], addData, today, maxDate, note }
export function buildAutoSettingsFlex({ status, dates, slots, addData, today, maxDate, note = null }) {
  const body = [];
  if (note) {
    body.push({ type: 'box', layout: 'vertical', margin: 'md', backgroundColor: COLOR_NOTE_BG, cornerRadius: 'md', paddingAll: '10px', contents: [text(note, { size: 'sm', color: COLOR_NOTE_FG, wrap: true })] });
  }

  // スイッチ 2 つ
  body.push(switchRow('自動予約', autoSwitchView(status), { onText: AUTO_ON_TEXT, offText: AUTO_OFF_TEXT, first: true }));
  body.push(switchRow('空き通知カード', notifySwitchView(status), { onText: NOTIFY_ON_TEXT, offText: NOTIFY_OFF_TEXT }));
  body.push({ type: 'separator', color: COLOR_LINE, margin: 'xl' });

  // 除外日・除外枠
  body.push(heading('除外日', 'この日は自動予約も空き通知もしない'));
  if (dates.length === 0) body.push(text('なし', { size: 'md', color: COLOR_MUTED, margin: 'sm' }));
  dates.slice(0, MAX_ROWS).forEach((d) => body.push(row(fmtDate(d.date), removePill(d.removeData, `${fmtDate(d.date)} の除外を解除`))));
  if (dates.length > MAX_ROWS) body.push(text(`…ほか${dates.length - MAX_ROWS}件`, { size: 'xs', color: COLOR_MUTED, margin: 'sm' }));

  body.push(heading('除外枠', '手放した枠。空きが出ても取り直さない'));
  if (slots.length === 0) body.push(text('なし', { size: 'md', color: COLOR_MUTED, margin: 'sm' }));
  slots.slice(0, MAX_ROWS).forEach((s) => {
    const label = `${fmtDate(s.date)} ${fmtTime(s.start)} ${s.facility}(${reasonText(s.reason)})`;
    body.push(row(label, removePill(s.removeData, `${fmtDate(s.date)} ${fmtTime(s.start)} ${s.facility} の除外を解除`)));
  });
  if (slots.length > MAX_ROWS) body.push(text(`…ほか${slots.length - MAX_ROWS}件`, { size: 'xs', color: COLOR_MUTED, margin: 'sm' }));

  body.push(text('除外日・除外枠は日が過ぎると自動で消えます。切り替えは 1〜3 分で Pi に届きます。', { size: 'xs', color: COLOR_SUB, wrap: true, margin: 'xl' }));

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
        contents: [text('⚙️ 設定', { color: '#FFFFFF', weight: 'bold', size: 'lg', flex: 1, gravity: 'center' }), text(`${tm}/${td} 現在`, { color: '#E5E7EB', size: 'xs', flex: 0, gravity: 'center', align: 'end' })],
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
              { type: 'button', style: 'link', height: 'sm', action: { type: 'datetimepicker', label: '📅 除外日を追加', data: addData, mode: 'date', initial: today, min: today, max: maxDate } },
              { type: 'button', style: 'link', height: 'sm', action: { type: 'message', label: '↻ 更新', text: COMMAND_TEXT } },
            ],
          },
        ],
      },
    },
  };
}

// テキスト版(Flex が 400 で弾かれたときの再送と altText)。ボタンが無いので合言葉を添える
export function autoSettingsText({ status, dates, slots, today }) {
  const auto = autoSwitchView(status);
  const notify = notifySwitchView(status);
  const lines = [`⚙️ 設定(${fmtDate(today)})`, `自動予約: ${auto.on ? 'ON' : 'OFF'} / ${auto.detail}`, `空き通知カード: ${notify.on ? 'ON' : 'OFF'} / ${notify.detail}`];
  lines.push(`除外日: ${dates.length ? dates.map((d) => fmtDate(d.date)).join('、') : 'なし'}`);
  lines.push(`除外枠: ${slots.length ? slots.map((s) => `${fmtDate(s.date)} ${fmtTime(s.start)} ${s.facility}`).join('、') : 'なし'}`);
  lines.push(`切り替えは「${AUTO_ON_TEXT}」「${AUTO_OFF_TEXT}」「${NOTIFY_ON_TEXT}」「${NOTIFY_OFF_TEXT}」`);
  return lines.join('\n');
}
