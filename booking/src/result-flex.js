// ============================================================
// 予約結果の LINE カード(Flex Message)。自宅サーバー(server/server.mjs)が予約完了時に push で送る
//
//   buildResultFlex({ slot, status, message, reservationNo, fee, facility }, label) → Flex Message
//   pushResult(message, { token, to })                                              → LINE push(失敗時は例外)
// ============================================================

const SITE_URL = 'https://kouen.sports.metro.tokyo.lg.jp/web/index.jsp';
const DOW = ['日', '月', '火', '水', '木', '金', '土'];

const STATUS_TEXT = {
  taken: '先に予約されていました',
  duplicate: 'サイトが申込みを断りました',
  rejected: 'サイトの認証で拒否されました',
  auth_error: 'ログインできませんでした',
  abandoned: '予約は行われませんでした(操作が完了しなかったか、中止しました)',
  error: 'サイトのエラーで完了できませんでした',
  dry_run: '動作確認(予約はしていません)',
};

export function slotText(slot) {
  const [y, m, d] = slot.date.split('-').map(Number);
  const dow = DOW[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${dow}) ${slot.startHour}:00-${Number(slot.startHour) + 2}:00`;
}

function row(k, v) {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'sm',
    contents: [
      { type: 'text', text: k, size: 'sm', color: '#777777', flex: 2 },
      { type: 'text', text: String(v || '-'), size: 'sm', color: '#111111', flex: 5, wrap: true },
    ],
  };
}

export function buildResultFlex(r, label = '') {
  const ok = r.status === 'success';
  const title = ok ? '🎾 予約完了' : '⚠️ 予約できませんでした';
  const rows = [row('予約者', label), row('日時', slotText(r.slot)), row('公園', r.facility || r.slot.park)];
  if (ok) rows.push(row('予約番号', r.reservationNo), row('料金', r.fee));
  else rows.push(row('理由', `${STATUS_TEXT[r.status] || r.status}: ${r.message || ''}`));
  const footer = ok
    ? []
    : [{ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '予約サイトを開く(手動で続ける)', uri: SITE_URL } }];
  return {
    type: 'flex',
    altText: ok ? `${title} ${label} ${slotText(r.slot)} ${r.facility || ''}` : `${title} ${slotText(r.slot)}: ${STATUS_TEXT[r.status] || r.status}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: ok ? '#06C755' : '#C0392B',
        paddingAll: '12px',
        paddingStart: '14px',
        contents: [{ type: 'text', text: title, color: '#FFFFFF', weight: 'bold', size: 'md' }],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '14px', backgroundColor: '#FFFFFF', contents: rows },
      ...(footer.length ? { footer: { type: 'box', layout: 'vertical', backgroundColor: '#FFFFFF', contents: footer } } : {}),
    },
  };
}

export async function pushResult(message, { token, to }) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, messages: [message] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`LINE通知に失敗: HTTP ${res.status} ${await res.text()}`);
}
