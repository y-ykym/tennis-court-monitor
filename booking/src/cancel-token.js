// ============================================================
// フェーズ1.6 の「キャンセル」ボタンに載せる署名付き postback data を、Pi 側(Node)で作る。
//
// 形式は worker/src/cancel-token.js と完全に同じ(Worker が検証するため):
//   c|A|2026000123|20260918|1700|1900|大島小松川公園|3|1757200000.<署名22文字>
//   署名 = base64url( HMAC-SHA256(secret, 本文) の先頭 16 バイト )
// Worker は Web Crypto、こちらは node:crypto で計算する。一致は booking/test/cancel-token.test.mjs で確かめる。
//
// 使いどころ: フェーズ3 自動予約の成功カード。利用日 = 今日+4 日の枠は無料キャンセルが今日 23:59 までなので、
// そのカードにだけ「キャンセル」ボタンを付ける(期限 exp = 今日の 23:59:59 JST)。押すと Worker の取消処理
// (確認カード →「はい」→ 取消 POST → 除外枠に登録)に流れる
// ============================================================
import { createHmac, timingSafeEqual } from 'node:crypto';

const SEP = '|';
const SIG_BYTES = 16;

const compact = (s) => String(s).replace(/[-:]/g, '');
const expandDate = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const expandTime = (s) => `${s.slice(0, 2)}:${s.slice(2, 4)}`;
const sigOf = (secret, body) => createHmac('sha256', secret).update(body).digest().subarray(0, SIG_BYTES).toString('base64url');

// payload = { kind:'c'|'y', person:'A'|'B', id, date:'YYYY-MM-DD', start:'HH:MM', end:'HH:MM', facility, penaltyDay, exp(unix秒) }
export function signCancelToken(secret, payload) {
  if (!secret) throw new Error('署名鍵が未設定です');
  const { kind, person, id, date, start, end, facility, penaltyDay, exp } = payload;
  if (!['c', 'y'].includes(kind)) throw new Error('kind が不正です');
  if (!['A', 'B'].includes(person)) throw new Error('person が不正です');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
    throw new Error('日付・時刻の形式が不正です');
  }
  const fields = [kind, person, id, compact(date), compact(start), compact(end), facility, String(penaltyDay ?? ''), String(exp)];
  if (fields.some((f) => f.includes(SEP) || f.includes('.'))) throw new Error('トークンに使えない文字が含まれています');
  if (fields.some((f, i) => i !== 7 && f === '')) throw new Error('トークンに必須の値が欠けています');
  const body = fields.join(SEP);
  const token = `${body}.${sigOf(secret, body)}`;
  if (token.length > 300) throw new Error('トークンが長すぎます');
  return token;
}

// 検証(テスト・確認用。本番で検証するのは Worker)。署名不正 → null、正しければ payload(期限切れなら expired: true)
export function verifyCancelToken(secret, token, now = Date.now()) {
  if (!secret || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sigOf(secret, body));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
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
