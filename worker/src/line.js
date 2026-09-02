// ============================================================
// LINE Messaging API まわりの共通処理(Webhook署名検証・イベント抽出・reply送信)
//
// Cloudflare Workers と Node(node --test)の両方で動くよう、Web標準API
// (crypto.subtle / fetch / TextEncoder / btoa)だけを使う。
// ============================================================

const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';

// グループで受け付ける合言葉(前後の空白を除いた本文との完全一致)
export const COMMAND_TEXT = 'よやく';

function toBase64(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// 文字列比較を長さに関係なく一定時間で行う(タイミング攻撃対策)
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

// リクエスト本文(生の文字列)を channel secret で HMAC-SHA256 → base64 にしたものが X-Line-Signature
export async function computeSignature(channelSecret, rawBody) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  return toBase64(mac);
}

// X-Line-Signature ヘッダーが本文と一致するか
export async function verifySignature(channelSecret, rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = await computeSignature(channelSecret, rawBody);
  return safeEqual(expected, signatureHeader);
}

// Webhook本文(JSON文字列)から「対象グループで『よやく』と送られたテキストメッセージ」だけを返す。
// それ以外(参加イベント・他グループ・個人チャット・別の文言)は全て無視する。
export function pickCommandEvents(rawBody, groupId) {
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return [];
  }
  const events = Array.isArray(payload?.events) ? payload.events : [];
  return events.filter(
    (ev) =>
      ev?.type === 'message' &&
      ev.message?.type === 'text' &&
      ev.source?.type === 'group' &&
      ev.source.groupId === groupId &&
      typeof ev.message.text === 'string' &&
      ev.message.text.trim() === COMMAND_TEXT &&
      typeof ev.replyToken === 'string'
  );
}

// reply API でメッセージ(最大5件)を返す(replyToken は受信から1分以内・1回限り)。
// 失敗時は例外(呼び出し側でログに出して握りつぶす。LINEには200を返す必要があるため)。
// 例外には status を持たせ、400(メッセージ形式の不備)ならテキストで再送する判断に使う
export async function replyMessages(accessToken, replyToken, messages) {
  const res = await fetch(LINE_REPLY_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) {
    const err = new Error(`LINE reply失敗: HTTP ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
}

// テキスト1件を返す
export function replyText(accessToken, replyToken, text) {
  return replyMessages(accessToken, replyToken, [{ type: 'text', text }]);
}
