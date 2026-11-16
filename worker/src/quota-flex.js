// ============================================================
// LINE の通数の知らせ(src/monitor.js が毎時の見張りで送る)のカードとテキスト版。2026-11-16 追加。
//
//   quotaWarn: 上限の少し手前。琥珀の帯(月末までに手を打てる)。「空き通知カード」のスイッチ(設定カードと同じ見た目)を載せ、
//              押すと合言葉「つうちおふ」が送られる。何が止まって何が続くかを枡の中に書く(「つうちおふ」だけでは何が起きるか伝わらなかった)
//   quotaEnd:  上限の直前。濃紺の帯(読むだけ)。上限に達した後は何も送れないので、これが「今月は止まった」の知らせを兼ねる
//
// 色と部品は他のカードと同じ決まり(帯の色 = してほしいこと・題 19px・補足の灰 #6B7280)。定義はファイルごと(共通モジュールにはしていない)
// ============================================================

const COLOR_HEADER_READ = '#1F2A44';
const COLOR_HEADER_ACT = '#9A3412';
const COLOR_TEXT = '#111827';
const COLOR_SUB = '#4B5563';
const COLOR_MUTED = '#6B7280';
const COLOR_PANEL_BG = '#F3F4F6';
const COLOR_OK = '#15803D';
const COLOR_NG = '#B91C1C';
const NOTIFY_OFF_TEXT = 'つうちおふ'; // auto.js の NOTIFY_OFF_TEXT と同じ合言葉

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const text = (str, extra = {}) => ({ type: 'text', text: String(str), ...extra });

// 通数が戻る日(翌月 1 日。LINE の月の切り替わりは 9:00 JST)。「12/1(火) 9:00」
export function quotaResumeLabel(now) {
  const j = new Date(now + 9 * 3600 * 1000);
  const first = new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth() + 1, 1));
  return `${first.getUTCMonth() + 1}/${first.getUTCDate()}(${DOW[first.getUTCDay()]}) 9:00`;
}

const header = (title, right, color) => ({
  type: 'box',
  layout: 'horizontal',
  backgroundColor: color,
  paddingAll: '14px',
  paddingStart: '16px',
  paddingEnd: '16px',
  contents: [text(title, { color: '#FFFFFF', weight: 'bold', size: 'lg', flex: 1, gravity: 'center', wrap: true }), text(right, { color: '#E5E7EB', size: 'xs', flex: 0, gravity: 'center', align: 'end' })],
});
const bubble = (altText, head, body) => ({
  type: 'flex',
  altText: altText.slice(0, 400),
  contents: { type: 'bubble', size: 'mega', header: head, body: { type: 'box', layout: 'vertical', paddingAll: '16px', paddingTop: '14px', backgroundColor: '#FFFFFF', contents: body } },
});
// 表の 1 行(見出しは灰、値は濃い字)
const tableRow = (label, value, { bold = false, first = false } = {}) => ({
  type: 'box',
  layout: 'horizontal',
  margin: first ? 'none' : 'md',
  contents: [text(label, { size: 'sm', color: COLOR_MUTED, flex: 0 }), text(value, { size: 'sm', color: COLOR_TEXT, weight: bold ? 'bold' : 'regular', flex: 1, align: 'end', wrap: true, margin: 'md' })],
});
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

// ---- 上限の少し手前 ----
export function quotaWarnText({ usage, limit, resume, notifyOn = true }) {
  const left = Math.max(0, limit - usage);
  return (
    `⚠️ 今月の通知はあと ${left} 通です(${usage}/${limit} 通)\n` +
    `なくなると ${resume} まで通知が止まります。` +
    (notifyOn ? `「${NOTIFY_OFF_TEXT}」で空き通知カードを止めると節約できます` : '空き通知カードはすでに止めています')
  );
}
export function buildQuotaWarnFlex({ usage, limit, resume, notifyOn = true }) {
  const left = Math.max(0, limit - usage);
  const body = [
    text(`あと ${left} 通で、${resume.split(' ')[0]} まで通知が止まります`, { size: 'sm', color: COLOR_TEXT, wrap: true }),
    {
      type: 'box',
      layout: 'vertical',
      margin: 'md',
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
            text('空き通知カード', { size: 'md', weight: 'bold', color: COLOR_TEXT, flex: 1, gravity: 'center' }),
            ...(notifyOn
              ? [
                  {
                    type: 'box',
                    layout: 'vertical',
                    flex: 0,
                    margin: 'lg',
                    backgroundColor: COLOR_HEADER_READ,
                    cornerRadius: 'xl',
                    paddingTop: '9px',
                    paddingBottom: '9px',
                    paddingStart: '16px',
                    paddingEnd: '16px',
                    action: { type: 'message', label: 'OFF にする', text: NOTIFY_OFF_TEXT },
                    contents: [text('OFF にする', { size: 'xs', weight: 'bold', color: '#FFFFFF', align: 'center' })],
                  },
                ]
              : []),
          ],
        },
        {
          type: 'box',
          layout: 'horizontal',
          margin: 'md',
          alignItems: 'flex-start',
          contents: [
            badge(notifyOn),
            text(notifyOn ? 'OFF にすると通知を節約できます' : 'すでに止めています', { size: 'xs', color: COLOR_SUB, wrap: true, flex: 1, margin: 'md' }),
          ],
        },
      ],
    },
  ];
  return bubble(quotaWarnText({ usage, limit, resume, notifyOn }), header('⚠️ 通知の残りがわずか', `${usage}/${limit} 通`, COLOR_HEADER_ACT), body);
}

// ---- 上限の直前(今月はここまで) ----
export function quotaEndText({ usage, limit, resume }) {
  return (
    `🔕 今月の通知はここまでです(${usage}/${limit} 通)\n` +
    `${resume} に戻ります。自動予約は続きます。取れたかどうかは「よやく」で確認できます`
  );
}
export function buildQuotaEndFlex({ usage, limit, resume }) {
  const body = [
    tableRow('通知が戻る日', resume, { bold: true, first: true }),
    tableRow('自動予約', '続きます'),
  ];
  return bubble(quotaEndText({ usage, limit, resume }), header('🔕 今月の通知はここまで', `${usage}/${limit} 通`, COLOR_HEADER_READ), body);
}
