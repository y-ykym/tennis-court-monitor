// ============================================================
// サーバーのログを日付ごとのファイルにも残す(2026-10-25)
//
// docker のログ(json-file)はコンテナを作り直すと消え、予約の試行の原因が追えなかった(10/25 に 2 回)。
// ここで /var/lib/booking/logs/server-YYYY-MM-DD.log(JST の日付。volume なので作り直しても残る)に追記し、7 日より古いものは消す。
// 量の目安: 照会 1 行/分 + 予約の行 ≈ 2,000 行・300 KB/日
//
//   const fileLog = createFileLog({ dir, keepDays = 7, now, log })
//   fileLog.write(line)   1 行追記(改行は付ける)。書けなくても例外は出さない(最初の 1 回だけ log に知らせる)
//   fileLog.close()
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

const jstDate = (ms) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

export function createFileLog({ dir, keepDays = 7, now = Date.now, log = () => {} } = {}) {
  let currentDate = null;
  let fd = null;
  let warned = false;

  function prune() {
    try {
      const cutoff = jstDate(now() - keepDays * 86400 * 1000);
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^server-(\d{4}-\d{2}-\d{2})\.log$/);
        if (m && m[1] < cutoff) fs.rmSync(path.join(dir, f), { force: true });
      }
    } catch {
      /* 消せなくても動作には影響しない */
    }
  }

  function open(date) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 無視 */
      }
      fd = null;
    }
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(path.join(dir, `server-${date}.log`), 'a');
    currentDate = date;
    prune();
  }

  function write(line) {
    if (!dir) return;
    try {
      const date = jstDate(now());
      if (date !== currentDate || fd === null) open(date);
      fs.writeSync(fd, `${line}\n`);
    } catch (e) {
      if (!warned) {
        warned = true;
        log(`ログファイルに書けません(${dir}): ${e.message}`);
      }
    }
  }

  function close() {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 無視 */
      }
      fd = null;
    }
  }

  return { write, close, currentFile: () => (currentDate ? path.join(dir, `server-${currentDate}.log`) : null) };
}
