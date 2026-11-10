// ============================================================
// 予約支援サーバー(server/server.mjs)が LINE に push するカード(Flex Message)
//
//   buildResultFlex({ slot, status, message, reservationNo, fee, facility }, label, opts?) → 予約結果(成功/失敗)
//     opts = { auto: true }              フェーズ3 自動予約の結果(見出しに「自動予約」と入る)
//            { cancelData: 'c|…' }      成功カードに「キャンセル」ボタン(postback。Worker の取消処理に流れる)を付ける。
//                                       利用日 = 今日+4 日 の自動予約で使う(ペナルティなしで取り消せるのが今日 23:59 まで)
//   buildChallengeFlex({ slot, facility, label, url, minutes })                      → reCAPTCHA の確認をお願いするカード
//                                                                                     (url を開くと予約サイトの確認画面がそのまま出る)
//   pushResult(message, { token, to })                                              → LINE push(失敗時は例外)
// ============================================================

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withQuickReply } = require('../../lib/quick-reply.js'); // 合言葉のボタン列(クイックリプライ)

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
// 配色・形は全カード共通の決まり(2026-11-10 の見直し。docs/flex-design-final.html):
//   帯の色 = してほしいこと(緑: 良い知らせ / 琥珀: 期限つきで対応が要る / 灰: うまくいかなかった)。題は 19px・白。
//   1 件の予約についてのカードは表(予約者・日時・公園を太字)。赤は「キャンセル」と失敗の理由だけ
const COLOR_OK = '#15803D'; // 緑(白文字とのコントラスト 5.02。以前の #06C755 は 2.26 で読みにくかった)
const COLOR_FAIL = '#6B7280'; // 灰
const COLOR_ACT = '#9A3412'; // 琥珀
const COLOR_DANGER = '#B91C1C'; // 「キャンセル」ボタン
const COLOR_REASON = '#DC2626'; // 失敗の理由(「よやく」の「明日」と同じ赤)
const COLOR_TEXT = '#111827';
const COLOR_LABEL = '#6B7280';
const COLOR_LINE = '#E5E7EB';

// 帯: 題(19px・太字・白。長い題は縮めて 1 行に収める)+ 右に期限(14px・太字・白)
const header = (title, deadline, bg) => ({
  type: 'box',
  layout: 'horizontal',
  backgroundColor: bg,
  paddingAll: '14px',
  paddingStart: '16px',
  paddingEnd: '16px',
  contents: [
    { type: 'text', text: title, color: '#FFFFFF', weight: 'bold', size: 'lg', flex: 1, gravity: 'center', adjustMode: 'shrink-to-fit' },
    ...(deadline ? [{ type: 'text', text: deadline, color: '#FFFFFF', weight: 'bold', size: 'sm', flex: 0, gravity: 'center', align: 'end' }] : []),
  ],
});
const body = (contents) => ({ type: 'box', layout: 'vertical', paddingAll: '16px', paddingTop: '12px', backgroundColor: '#FFFFFF', contents });

const STATUS_TEXT = {
  taken: '先に予約されていました',
  duplicate: 'サイトが申込みを断りました',
  rejected: 'サイトの認証で拒否されました',
  auth_error: 'ログインできませんでした',
  abandoned: '予約は行われませんでした(操作が完了しなかったか、中止しました)',
  error: 'サイトのエラーで完了できませんでした',
  dry_run: '動作確認(予約はしていません)',
  capped: 'その日は既に予約があるため見送りました',
  skipped: '見送りました',
};

export function slotText(slot) {
  const [y, m, d] = slot.date.split('-').map(Number);
  const dow = DOW[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${dow}) ${slot.startHour}:00-${Number(slot.startHour) + 2}:00`;
}

// 表の 1 行。strong: 太字(予約者・日時・公園 = 大事な情報)。color: 値の色(失敗の理由だけ赤)
function row(k, v, { strong = false, color = COLOR_TEXT } = {}) {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    contents: [
      { type: 'text', text: k, size: 'sm', color: COLOR_LABEL, flex: 2 },
      { type: 'text', text: String(v || '-'), size: 'sm', color, flex: 5, wrap: true, ...(strong ? { weight: 'bold' } : {}) },
    ],
  };
}
// 予約者・日時・公園(どのカードも同じ 3 行)
const slotRows = (label, slot, facility) => [row('予約者', label, { strong: true }), row('日時', slotText(slot), { strong: true }), row('公園', facility || slot.park, { strong: true })];

// 予約結果。成功: 緑の帯 + 予約番号・料金。失敗: 灰の帯 + 理由(赤)。
//   2026-11-10 に情報量を減らした: 見出しの下の言い直し・取り消し方の案内文・フッターのリンクを外し、予約番号は他の行と同じ大きさに
//   penalty: 利用日がペナルティ期間(今日+3 日以内。「せってい」の「追加枠」の自動予約)なら、取消にペナルティが付く旨を出す(2026-10-15。10-25 に枠単位へ)
export function buildResultFlex(r, label = '', { auto = false, cancelData = null, penalty = false } = {}) {
  const ok = r.status === 'success';
  // 見出しで「自動予約」と「LINE のボタン(手動)」を見分けられるようにする(2026-09-25)。自動予約: 🤖 + 「自動予約」。手動: 🎾/⚠️ + 「(ボタン)」
  const title = auto ? (ok ? '🤖 自動予約が完了' : '🤖 自動予約できませんでした') : ok ? '🎾 予約完了(ボタン)' : '⚠️ 予約できませんでした(ボタン)';
  const rows = slotRows(label, r.slot, r.facility);
  if (ok) {
    rows.push(row('予約番号', r.reservationNo), row('料金', r.fee));
    // 注意書きは本文のいちばん下 = 赤い「キャンセル」ボタンのすぐ上に置く(2026-11-10 本人指定)
    const warn = cancelData
      ? '⚠ ペナルティなしの取消は今日中' // 利用日が 4 日後: ペナルティなしで取り消せるのは今日 23:59 まで
      : penalty
        ? '⚠ 取り消すとペナルティ 1 点が付きます' // 利用日が 3 日以内(「せってい」の追加枠)
        : null;
    if (warn) {
      rows.push({
        type: 'box',
        layout: 'vertical',
        margin: 'md',
        backgroundColor: '#FFF7E6',
        cornerRadius: 'md',
        paddingAll: '10px',
        contents: [{ type: 'text', text: warn, size: 'sm', color: '#8A4B00', wrap: true }],
      });
    }
  } else {
    rows.push(row('理由', `${STATUS_TEXT[r.status] || r.status}${r.message ? `: ${r.message}` : ''}`, { strong: true, color: COLOR_REASON }));
  }
  // フッターのリンク(予約一覧を見る・予約サイトを開く)は置かない(2026-11-10 本人決定。合言葉はクイックリプライから送れる)。
  // 「キャンセル」は postback(Worker のフェーズ1.6 の確認カード →「はい」→ 取消 → 除外枠に登録)。押した内容はトークに残る
  const footer =
    ok && cancelData
      ? {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#FFFFFF',
          paddingAll: '12px',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: COLOR_DANGER,
              height: 'sm',
              action: { type: 'postback', label: 'キャンセル', data: cancelData, displayText: `${slotText(r.slot)} ${r.facility || ''} をキャンセル`.trim() },
            },
          ],
        }
      : null;
  return {
    type: 'flex',
    altText: ok ? `${title} ${label} ${slotText(r.slot)} ${r.facility || ''}` : `${title} ${slotText(r.slot)}: ${STATUS_TEXT[r.status] || r.status}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: header(title, null, ok ? COLOR_OK : COLOR_FAIL),
      body: body(rows),
      ...(footer ? { footer } : {}),
    },
  };
}

// reCAPTCHA v2(チェックボックス・画像問題)が出て人間の操作が必要になったときのカード。
// ボタンの url は玄関の Worker 経由の noVNC 画面(/vnc?token=…)。開くと「予約」を押した直後の確認画面が表示され、
// チェック → 画像問題 → もう一度「予約」まで人間が行う。サイトのセッションが切れる前に minutes 分以内に。
export function buildChallengeFlex({ slot, facility, label = '', url, minutes = 8 }) {
  const title = '🔐 確認が必要です';
  // 手順は番号を太字にした span で 1 行ずつ
  const step = (n, text, margin = 'sm') => ({
    type: 'text',
    wrap: true,
    size: 'sm',
    margin,
    contents: [
      { type: 'span', text: `${n}  `, weight: 'bold', color: COLOR_ACT },
      { type: 'span', text, color: COLOR_TEXT },
    ],
  });
  // 期限(minutes 分)は帯の右と本文の先頭の 2 か所に出す(いちばん大事な情報。以前は最下段の小さい字だった)
  const rows = [
    { type: 'text', text: `ロボット確認が出ました。${minutes}分以内に操作してください`, size: 'md', weight: 'bold', color: COLOR_TEXT, wrap: true },
    ...slotRows(label, slot, facility),
    { type: 'separator', margin: 'lg', color: COLOR_LINE },
    step('1', '下のボタンで画面を開く', 'lg'),
    step('2', '「私はロボットではありません」を押す'),
    step('3', '画像問題が出たら解いて「確認」'),
    step('4', 'もう一度「予約」を押す'),
  ];
  return {
    type: 'flex',
    altText: `${title} ${label} ${slotText(slot)}: ${minutes}分以内にチェックを押してください`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: header(title, `${minutes}分以内`, COLOR_ACT),
      body: body(rows),
      footer: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFFFF',
        paddingAll: '12px',
        paddingTop: '0px',
        contents: [{ type: 'button', style: 'primary', height: 'sm', color: COLOR_ACT, action: { type: 'uri', label: '画面を開いて確認する', uri: url } }],
      },
    },
  };
}

// 自宅回線は数秒の瞬断が多く、1 回の fetch が "fetch failed" で落ちることがある(2026-09-13 に予約成功の結果カードが届かなかった)。
// 通信エラーと 5xx は間を置いて最大 retries 回やり直す。4xx(形式不備・認証)はやり直しても無駄なので即エラー
export async function pushResult(message, { token, to }, { retries = 3, delayMs = 3000 } = {}) {
  // 最後のメッセージにクイックリプライ(合言葉のボタン列。lib/quick-reply.js)を付ける
  const messages = withQuickReply(Array.isArray(message) ? message : [message]);
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ to, messages }), // 配列なら 1 回の push に複数件(最大 5。夜間のまとめ送り)
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return;
      const err = new Error(`LINE通知に失敗: HTTP ${res.status} ${await res.text()}`);
      if (res.status < 500) throw err;
      lastError = err;
    } catch (e) {
      if (/HTTP 4\d\d/.test(e.message)) throw e;
      lastError = e;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw lastError;
}
