// ============================================================
// 夜間(0:00〜8:00 JST)の自動予約の成立カードは、その場では送らず溜めておき、8:00 にまとめて送る(本人依頼 2026-10-26。寝ているため)
//
//   const d = createMorningDigest({ file, send, log, now, timers, quietFromMin = 0, quietToMin = 8 * 60, maxPerPush = 5 })
//     file      溜めたカードの置き場(JSON。volume に置けばコンテナを作り直しても残る)
//     send      async (messages, what) => boolean   まとめて送る関数(server の lineQueue.send。messages は配列。1 回の push に最大 5 件)
//   d.hold(message, what)  → boolean  夜間なら溜めて true(呼び出し側は送らない)。昼間なら false(呼び出し側がその場で送る)
//   d.flush()              → 送った件数  8:00 のタイマーから呼ぶ。夜間の途中で呼ばれたら送らず次の 8:00 を待つ
//   d.start()              起動時: 溜まっていて昼間なら今すぐ送る(8:00 を過ぎて再起動したときの取りこぼし防止)。夜間なら 8:00 に送る
//   d.status()             { held, nextFlushAt }
//
// 送り方: 1 回の push に最大 5 件(LINE の上限)。LINE の通数は push 1 回ごとに数えるので、まとめた方が安い。
// 送信そのものの失敗は lineQueue が持ち越す(1 分ごとに再送)ので、ここでは渡した時点で溜めから消す
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_MS = 9 * 60 * 60 * 1000;

export function createMorningDigest({
  file,
  send,
  log = () => {},
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  quietFromMin = 0,
  quietToMin = 8 * 60,
  maxPerPush = 5,
} = {}) {
  let timer = null;
  let nextFlushAt = null;

  const jstMinutes = (t) => Math.floor(((t + JST_MS) % DAY_MS) / 60000);
  const inQuiet = (t) => {
    const m = jstMinutes(t);
    return m >= quietFromMin && m < quietToMin;
  };
  // 次の「静かな時間の終わり」(8:00 JST)の時刻(ms)
  const nextQuietEnd = (t) => {
    const jst = t + JST_MS;
    const dayStart = jst - (jst % DAY_MS);
    let end = dayStart + quietToMin * 60000;
    if (end <= jst) end += DAY_MS;
    return end - JST_MS;
  };

  function load() {
    try {
      return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    } catch {
      return [];
    }
  }
  function save(list) {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(list));
    } catch (e) {
      log(`夜間のカードの置き場に書けません(${file}): ${e.message}`);
    }
  }

  function arm() {
    const at = nextQuietEnd(now());
    if (timer) timers.clearTimeout(timer);
    nextFlushAt = at;
    timer = timers.setTimeout(() => {
      timer = null;
      flush().catch((e) => log(`夜間のカードのまとめ送信に失敗: ${e.message}`));
    }, Math.max(1000, at - now()));
  }

  function hold(message, what) {
    if (!inQuiet(now())) return false;
    const list = load();
    list.push({ at: now(), what, message });
    save(list);
    arm();
    log(`${what}は夜間のため溜めておき、8:00 にまとめて送ります(溜まっている ${list.length} 件)`);
    return true;
  }

  async function flush() {
    if (inQuiet(now())) {
      arm();
      return 0;
    }
    const list = load();
    if (list.length === 0) {
      nextFlushAt = null;
      return 0;
    }
    save([]);
    nextFlushAt = null;
    let sent = 0;
    for (let i = 0; i < list.length; i += maxPerPush) {
      const chunk = list.slice(i, i + maxPerPush);
      const label = `夜間に成立した自動予約のカード(${chunk.length} 件まとめ)`;
      try {
        await send(chunk.map((x) => x.message), label);
        sent += chunk.length;
      } catch (e) {
        log(`${label}の送信でエラー: ${e.message}`);
      }
    }
    log(`夜間に溜めたカード ${sent} 件を送りました`);
    return sent;
  }

  function start() {
    const list = load();
    if (list.length === 0) return;
    if (inQuiet(now())) arm();
    else flush().catch((e) => log(`夜間のカードのまとめ送信に失敗: ${e.message}`));
  }

  function stop() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
  }

  return { hold, flush, start, stop, inQuiet, status: () => ({ held: load().length, nextFlushAt }) };
}
