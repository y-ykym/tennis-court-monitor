// ============================================================
// フェーズ3 自動予約の記録(照会間隔の調整に使う。2026-10-11)
//   1 行 1 件の JSON(JSONL)を /var/lib/booking/auto-events.jsonl に追記する(docker volume。コンテナを作り直しても消えない)。
//   docker のログは作り直しで消えるため、「枠がいつ出て・いつ消えて・どう扱ったか」をここに残す。
//   集計は booking/pc/auto-stats.sh(Pi 上で python3)。
//
//   種類(type)と主な項目(すべて at = 記録時刻 ms):
//     appeared    新しく出た監視対象の枠 { key, facility, date, time, intervalMs(その時刻の照会間隔) }
//     gone        見えていた枠が消えた   { key, facility, date, time, firstSeenAt, sinceBaseline, attempt(その枠の試行状態) }
//     skipped     振り分けで見送り       { key, kind, reason }
//     queued      予約の行列へ           { key, person }
//     dry_run     予約するはずだった     { key, person }(dry-run か LINE で停止中)
//     result      予約の実行の結果       { key, status, person, message }(success / taken / capped / conflict / skipped_* / error …)
//     poll_failed 空き照会の失敗         { consecutive, message }
//   量の目安: 1 日 10〜60 行(照会の成功は記録しない)
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

export function createEventLog({ file, log = () => {} }) {
  let warned = false;
  return {
    file,
    append(obj) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
      } catch (e) {
        if (!warned) {
          warned = true;
          log(`[auto] 記録ファイルに書けません(${file}): ${e.message}`);
        }
      }
    },
  };
}

// テスト・集計用: ファイルを読んで配列で返す(壊れた行は飛ばす)
export function readEvents(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 途中で切れた行など */
    }
  }
  return out;
}
