// ============================================================
// 予約支援サーバー(server/server.mjs)が LINE に push するカード(Flex Message)
//
//   buildResultFlex({ slot, status, message, reservationNo, fee, facility }, label) → 予約結果(成功/失敗)
//   buildChallengeFlex({ slot, facility, label, url, minutes })                      → reCAPTCHA の確認をお願いするカード
//                                                                                     (url を開くと予約サイトの確認画面がそのまま出る)
//   pushResult(message, { token, to })                                              → LINE push(失敗時は例外)
// ============================================================

const SITE_URL = 'https://kouen.sports.metro.tokyo.lg.jp/web/index.jsp';
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
// 「よやく」コマンド(worker/src/line.js の COMMAND_TEXT と同じ文言)。メッセージアクションで送ると Worker が予約一覧を返す
const COMMAND_TEXT = 'よやく';
const COLOR_OK = '#06C755';
const COLOR_NG = '#C0392B';
const COLOR_WARN = '#E67E22';
const COLOR_LINE = '#EEEEEE';

const siteLinkButton = (label = '予約サイトを開く') => ({ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label, uri: SITE_URL } });
const listButton = () => ({ type: 'button', style: 'link', height: 'sm', action: { type: 'message', label: '予約一覧を見る', text: COMMAND_TEXT } });
const linkFooter = (buttons) => ({
  type: 'box',
  layout: 'vertical',
  backgroundColor: '#FFFFFF',
  contents: [{ type: 'separator', color: COLOR_LINE }, { type: 'box', layout: 'horizontal', contents: buttons }],
});
const header = (title, sub, bg) => ({
  type: 'box',
  layout: 'vertical',
  backgroundColor: bg,
  paddingAll: '12px',
  paddingStart: '14px',
  contents: [
    { type: 'text', text: title, color: '#FFFFFF', weight: 'bold', size: 'md' },
    ...(sub ? [{ type: 'text', text: sub, color: '#FFFFFF', size: 'xs', wrap: true, margin: 'xs' }] : []),
  ],
});

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

// 予約結果。成功: 緑ヘッダー + 予約番号を大きく + 取消の案内。失敗: 赤ヘッダー + 理由 + 手動で続けるリンク
export function buildResultFlex(r, label = '') {
  const ok = r.status === 'success';
  const title = ok ? '🎾 予約完了' : '⚠️ 予約できませんでした';
  const rows = [row('予約者', label), row('日時', slotText(r.slot)), row('公園', r.facility || r.slot.park)];
  if (ok) {
    rows.push(
      {
        type: 'box',
        layout: 'horizontal',
        margin: 'md',
        alignItems: 'center',
        contents: [
          { type: 'text', text: '予約番号', size: 'sm', color: '#777777', flex: 2 },
          { type: 'text', text: String(r.reservationNo || '-'), size: 'xl', weight: 'bold', color: '#111111', flex: 5, adjustMode: 'shrink-to-fit' },
        ],
      },
      row('料金', r.fee),
      {
        type: 'text',
        text: '取り消すときは「予約一覧を見る」→ その行の「キャンセル」。利用日の4日前まで無料です。',
        size: 'xs',
        color: '#777777',
        wrap: true,
        margin: 'lg',
      }
    );
  } else {
    rows.push(row('理由', `${STATUS_TEXT[r.status] || r.status}${r.message ? `: ${r.message}` : ''}`));
  }
  return {
    type: 'flex',
    altText: ok ? `${title} ${label} ${slotText(r.slot)} ${r.facility || ''}` : `${title} ${slotText(r.slot)}: ${STATUS_TEXT[r.status] || r.status}`,
    contents: {
      type: 'bubble',
      header: header(title, ok ? '自宅の予約サーバーが自動で予約しました' : null, ok ? COLOR_OK : COLOR_NG),
      body: { type: 'box', layout: 'vertical', paddingAll: '14px', backgroundColor: '#FFFFFF', contents: rows },
      footer: ok ? linkFooter([listButton(), siteLinkButton()]) : linkFooter([siteLinkButton('予約サイトを開く(手動で続ける)')]),
    },
  };
}

// reCAPTCHA v2(チェックボックス・画像問題)が出て人間の操作が必要になったときのカード。
// ボタンの url は玄関の Worker 経由の noVNC 画面(/vnc?token=…)。開くと「予約」を押した直後の確認画面が表示され、
// チェック → 画像問題 → もう一度「予約」まで人間が行う。サイトのセッションが切れる前に minutes 分以内に。
export function buildChallengeFlex({ slot, facility, label = '', url, minutes = 8 }) {
  const title = '🔐 確認が必要です';
  // 手順は番号を太字にした span で 1 行ずつ
  const step = (n, text) => ({
    type: 'text',
    wrap: true,
    size: 'sm',
    margin: 'sm',
    contents: [
      { type: 'span', text: `${n}  `, weight: 'bold', color: COLOR_WARN },
      { type: 'span', text, color: '#111111' },
    ],
  });
  const rows = [
    row('予約者', label),
    row('日時', slotText(slot)),
    row('公園', facility || slot.park),
    { type: 'separator', margin: 'lg', color: COLOR_LINE },
    { type: 'text', text: 'やること', size: 'sm', color: '#777777', margin: 'lg' },
    step('1', '下のボタンで画面を開く(ログイン〜「予約」まで済んでいます)'),
    step('2', '「私はロボットではありません」のチェックを押す'),
    step('3', '画像問題が出たら解いて「確認」'),
    step('4', 'もう一度「予約」を押す → 完了画面になれば結果が届きます'),
    {
      type: 'text',
      text: `⏱ ${minutes}分以内に(予約サイトの制限時間)。過ぎると予約されずに終わります`,
      size: 'xs',
      color: COLOR_WARN,
      weight: 'bold',
      wrap: true,
      margin: 'lg',
    },
  ];
  return {
    type: 'flex',
    altText: `${title} ${label} ${slotText(slot)}: ${minutes}分以内にチェックを押してください`,
    contents: {
      type: 'bubble',
      header: header(title, 'ロボット確認(reCAPTCHA)が出たので、そこだけ人の操作が必要です', COLOR_WARN),
      body: { type: 'box', layout: 'vertical', paddingAll: '14px', backgroundColor: '#FFFFFF', contents: rows },
      footer: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFFFF',
        paddingAll: '12px',
        contents: [{ type: 'button', style: 'primary', color: COLOR_WARN, action: { type: 'uri', label: '画面を開いて確認する', uri: url } }],
      },
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
