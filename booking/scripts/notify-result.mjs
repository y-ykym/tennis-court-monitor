#!/usr/bin/env node
// ============================================================
// 予約実行の結果(reserve-cli.mjs --out の JSON)を LINE グループに push 通知する(GitHub Actions 用)。
//
//   LINE_CHANNEL_ACCESS_TOKEN=... LINE_USER_ID=<グループID> LABEL=<予約者の呼び名> \
//     node scripts/notify-result.mjs result.json
//
// 成功: 緑ヘッダー「予約完了」+ 予約者・日時・公園・予約番号・料金
// 失敗: 赤ヘッダー「予約できませんでした」+ 理由 + 予約サイトを開くボタン(手動で続きをするため)
// push は LINE 無料枠(月200通)を1通消費する。
// ============================================================
import fs from 'node:fs';

const SITE_URL = 'https://kouen.sports.metro.tokyo.lg.jp/web/index.jsp';
const DOW = ['日', '月', '火', '水', '木', '金', '土'];

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('使い方: node scripts/notify-result.mjs result.json');
  process.exit(1);
}
const result = JSON.parse(fs.readFileSync(file, 'utf8'));
const label = process.env.LABEL || '';

function slotText(slot) {
  const [y, m, d] = slot.date.split('-').map(Number);
  const dow = DOW[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${dow}) ${slot.startHour}:00-${Number(slot.startHour) + 2}:00`;
}

const STATUS_TEXT = {
  taken: '先に予約されていました',
  duplicate: 'サイトが申込みを断りました',
  rejected: 'サイトの認証で拒否されました',
  auth_error: 'ログインできませんでした',
  error: 'サイトのエラーで完了できませんでした',
  dry_run: '動作確認(予約はしていません)',
};

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

export function buildResultFlex(r) {
  const ok = r.status === 'success';
  const title = ok ? '🎾 予約完了' : `⚠️ 予約できませんでした`;
  const rows = [row('予約者', label), row('日時', slotText(r.slot)), row('公園', r.facility || r.slot.park)];
  if (ok) rows.push(row('予約番号', r.reservationNo), row('料金', r.fee));
  else rows.push(row('理由', `${STATUS_TEXT[r.status] || r.status}: ${r.message}`));
  const footer = ok
    ? []
    : [
        {
          type: 'button',
          style: 'link',
          height: 'sm',
          action: { type: 'uri', label: '予約サイトを開く(手動で続ける)', uri: SITE_URL },
        },
      ];
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

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const to = process.env.LINE_USER_ID;
if (!token || !to) {
  console.error('環境変数 LINE_CHANNEL_ACCESS_TOKEN / LINE_USER_ID が未設定です');
  process.exit(1);
}
const res = await fetch('https://api.line.me/v2/bot/message/push', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ to, messages: [buildResultFlex(result)] }),
});
if (!res.ok) {
  console.error(`LINE通知に失敗: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`LINE通知を送信しました (${result.status})`);
