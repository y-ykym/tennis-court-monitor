// ============================================================
// フェーズ1.6 予約キャンセル: LINE の postback ボタンに載せる署名付きトークン
//
//   一覧カードの「キャンセル」ボタン(kind='c', 有効 60 分)と、確認カードの「はい」(kind='y', 有効 10 分)に使う。
//   LINE の postback data は 300 文字までなので、JSON ではなく '|' 区切りの短い形にする(約 80 文字):
//
//     c|A|2026000123|20260918|1700|1900|大島小松川公園|3|1757200000.<署名22文字>
//     ^  ^  予約番号   利用日    開始 終了  公園名        ^ 期限(unix秒)
//     種別 人(A/B)                                    ペナルティ日数(サイトの penaltyday)
//
//   署名は HMAC-SHA256(secret, 本文) の先頭 16 バイトを base64url にしたもの(22 文字)。
//   鍵は既存の BOOKING_SIGNING_SECRET を流用する。
//   検証で署名が合わなければ null(無視する)。署名は合うが期限切れなら payload に expired=true を付けて返す
//   (「時間切れです」と案内するため)。
// ============================================================

const SEP = '|';
const SIG_BYTES = 16;

const enc = new TextEncoder();

function b64u(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function safeEqual(a, b) {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const compact = (s) => String(s).replace(/[-:]/g, ''); // "2026-09-18" → "20260918", "17:00" → "1700"
const expandDate = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const expandTime = (s) => `${s.slice(0, 2)}:${s.slice(2, 4)}`;

// payload = { kind:'c'|'y', person:'A'|'B', id, date:'YYYY-MM-DD', start:'HH:MM', end:'HH:MM', facility, penaltyDay, exp(unix秒) }
export async function signCancelToken(secret, payload) {
  if (!secret) throw new Error('署名鍵が未設定です');
  const { kind, person, id, date, start, end, facility, penaltyDay, exp } = payload;
  if (!['c', 'y'].includes(kind)) throw new Error('kind が不正です');
  if (!['A', 'B'].includes(person)) throw new Error('person が不正です');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
    throw new Error('日付・時刻の形式が不正です');
  }
  const fields = [kind, person, id, compact(date), compact(start), compact(end), facility, String(penaltyDay ?? ''), String(exp)];
  if (fields.some((f) => f.includes(SEP) || f.includes('.'))) throw new Error('トークンに使えない文字が含まれています');
  // penaltyDay(7番目)だけは空を許す(一覧から取れなかったとき)。それ以外は必須
  if (fields.some((f, i) => i !== 7 && f === '')) throw new Error('トークンに必須の値が欠けています');
  const body = fields.join(SEP);
  const sig = b64u((await hmac(secret, body)).slice(0, SIG_BYTES));
  const token = `${body}.${sig}`;
  if (token.length > 300) throw new Error('トークンが長すぎます');
  return token;
}

// 戻り値: 署名不正・形式不正 → null。正しければ payload(期限切れなら expired: true)
export async function verifyCancelToken(secret, token, now = Date.now()) {
  if (!secret || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64u((await hmac(secret, body)).slice(0, SIG_BYTES));
  if (!safeEqual(expected, sig)) return null;
  const f = body.split(SEP);
  if (f.length !== 9) return null;
  const [kind, person, id, date, start, end, facility, penaltyDay, exp] = f;
  if (!['c', 'y'].includes(kind) || !['A', 'B'].includes(person)) return null;
  if (!/^\d{8}$/.test(date) || !/^\d{4}$/.test(start) || !/^\d{4}$/.test(end) || !/^\d+$/.test(exp)) return null;
  return {
    kind,
    person,
    id,
    date: expandDate(date),
    start: expandTime(start),
    end: expandTime(end),
    facility,
    penaltyDay: penaltyDay === '' ? null : Number(penaltyDay),
    exp: Number(exp),
    expired: Number(exp) * 1000 < now,
  };
}

// サイトの取消ボタン(prwha1000.js の rsvcancel)と同じ判定: 利用日 <= 今日 + penaltyday 日 ならペナルティ対象。
// 日付だけで比較する(時刻は見ない)。today は JST の "YYYY-MM-DD"
export function penaltyApplies(dateIso, penaltyDay, todayIso) {
  if (!dateIso || penaltyDay == null || !todayIso) return false;
  const toUtc = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const limit = toUtc(todayIso) + Number(penaltyDay) * 86400000;
  return toUtc(dateIso) <= limit;
}
