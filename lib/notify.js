// ============================================================
// LINE Messaging API での push 通知
// 必要な環境変数(GitHub Secrets経由で渡される):
//   LINE_CHANNEL_ACCESS_TOKEN … チャネルアクセストークン(長期)
//   LINE_USER_ID              … 通知先(自分)のユーザーID
// ============================================================

const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];

function dateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = DOW_JA[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${dow})`;
}

// 通知メッセージ本文を組み立てる(施設名・日付・時間帯・空き枠数)
function formatMessage(slots) {
  const MAX_LINES = 20; // LINEの文字数制限(5000字)対策
  const lines = slots
    .slice(0, MAX_LINES)
    .map((s) => `・${s.facility} ${dateLabel(s.date)} ${s.time} 空き${s.count}面`);
  if (slots.length > MAX_LINES) lines.push(`…ほか${slots.length - MAX_LINES}件`);
  return `🎾 新しい空きが出ました!\n${lines.join('\n')}`;
}

async function sendLineMessage(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const to = process.env.LINE_USER_ID;
  if (!token || !to) {
    throw new Error('環境変数 LINE_CHANNEL_ACCESS_TOKEN / LINE_USER_ID が未設定です');
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  });
  if (!res.ok) {
    throw new Error(`LINE通知に失敗: HTTP ${res.status} ${await res.text()}`);
  }
}

module.exports = { sendLineMessage, formatMessage };
