// ============================================================
// LINE への push を「届くまで持ち越す」小さな待ち行列。
//
// 自宅回線(SoftBank Air)は数分の断が起きる。予約の結果カードを送る瞬間に切れていると、その場の再試行(数秒)では
// 届かず、利用者には「結果が返ってこない」と見える(2026-09-13 21:34 に実際に起きた)。
// 送れなかったカードはファイルに保存し、1 分ごとに再送を試みる。届いたら消す。古すぎるものは諦める。
//
//   const q = createLineQueue({ file, push: (message) => Promise, log })
//   await q.send(message, '結果カード')   … その場で 1 回送る。失敗したら保存して後で再送
//   await q.flush()                        … 保存分をまとめて再送(タイマーからも呼ぶ)
//   q.start() / q.stop()                   … 1 分ごとの再送タイマー
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000; // これ以上古いものは送らない(6 時間後に届いても混乱するだけ)
const DEFAULT_INTERVAL_MS = 60 * 1000;

export function createLineQueue({ file, push, log = () => {}, maxAgeMs = DEFAULT_MAX_AGE_MS, intervalMs = DEFAULT_INTERVAL_MS, now = Date.now }) {
  const load = () => {
    try {
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  const save = (list) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (list.length === 0) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.writeFileSync(file, JSON.stringify(list));
  };

  let timer = null;
  let flushing = false;

  async function send(message, what) {
    try {
      await push(message);
      log(`${what}を LINE に送りました`);
      return true;
    } catch (e) {
      const list = load();
      list.push({ at: now(), what, message });
      save(list);
      log(`${what}の LINE 送信に失敗。持ち越して 1 分ごとに再送します(${e.message})`);
      return false;
    }
  }

  async function flush() {
    if (flushing) return { sent: 0, kept: 0, dropped: 0 };
    flushing = true;
    try {
      const list = load();
      if (list.length === 0) return { sent: 0, kept: 0, dropped: 0 };
      const keep = [];
      let sent = 0;
      let dropped = 0;
      for (const item of list) {
        if (now() - item.at > maxAgeMs) {
          dropped++;
          log(`持ち越していた${item.what}は古すぎるため送らずに捨てました(${Math.round((now() - item.at) / 60000)}分経過)`);
          continue;
        }
        try {
          await push(item.message);
          sent++;
          log(`持ち越していた${item.what}を LINE に送りました(${Math.round((now() - item.at) / 60000)}分遅れ)`);
        } catch {
          keep.push(item);
        }
      }
      save(keep);
      return { sent, kept: keep.length, dropped };
    } finally {
      flushing = false;
    }
  }

  return {
    send,
    flush,
    pending: () => load().length,
    start() {
      if (!timer) timer = setInterval(() => flush().catch((e) => log(`持ち越し分の再送でエラー: ${e.message}`)), intervalMs);
      return this;
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
