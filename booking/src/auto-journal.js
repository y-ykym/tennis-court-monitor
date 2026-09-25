// ============================================================
// フェーズ3 自動予約の「日ごとの記録」(docker volume /var/lib/booking/auto-journal.json)。2026-09-25 追加。
//
//   なぜ別に残すか: docker のログはコンテナを作り直すと消え(再ビルドのたび)、auto-state.js の試行記録も 2 日で消える。
//   「先週どうだったか」を後から見られるように、照会の回数・失敗、Worker への合図の失敗、再起動、候補ごとの結果を
//   JST の日付ごとに 14 日分だけ残す。Worker の週報(worker/src/auto-report.js)が /auto/report で読む。
//
//   days   : 'YYYY-MM-DD'(JST)→ { cycles, failed, heartbeatFailed, newSlots, restarts }
//            cycles = 照会を始めた回数(成功 + 失敗)、failed = 空き照会に失敗した回数、newSlots = 新しく出た空きの合計
//   events : 候補ごとの結果 [{ at, status, key, person, date, start, facility, message }]
//            status は auto-state の試行記録と同じ('success' 'taken' 'conflict' 'capped' 'dry_run' 'skipped_*' 'error' 'auth_error' …)。
//            queued / running(途中の状態)は記録しない
//
//   利用者番号・パスワード・予約番号は書かない(予約番号は auto-state の own にある)
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { jstTodayIso, addDaysIso } = require('../../lib/date.js');

export const JOURNAL_KEEP_DAYS = 14;
// 1 日 1,440 周期 × 14 日でも数百件に収まるが、念のため events の上限
const EVENTS_MAX = 2000;

const emptyDay = () => ({ cycles: 0, failed: 0, heartbeatFailed: 0, newSlots: 0, restarts: 0 });

export function createAutoJournal({ file, now = Date.now, keepDays = JOURNAL_KEEP_DAYS } = {}) {
  let data = { days: {}, events: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      data = { days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {}, events: Array.isArray(parsed.events) ? parsed.events : [] };
    }
  } catch {
    /* 初回、または壊れている → まっさら */
  }

  const dayOf = (ms) => jstTodayIso(ms);
  const day = (ms = now()) => {
    const iso = dayOf(ms);
    if (!data.days[iso]) data.days[iso] = emptyDay();
    return data.days[iso];
  };

  function prune(nowMs = now()) {
    const oldest = addDaysIso(dayOf(nowMs), -(keepDays - 1));
    for (const iso of Object.keys(data.days)) if (iso < oldest) delete data.days[iso];
    data.events = data.events.filter((e) => dayOf(e.at) >= oldest);
    if (data.events.length > EVENTS_MAX) data.events = data.events.slice(-EVENTS_MAX);
  }

  function save() {
    prune();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  return {
    countCycle({ ok, newSlots = 0 } = {}) {
      const d = day();
      d.cycles++;
      if (!ok) d.failed++;
      else d.newSlots += newSlots;
    },
    countHeartbeat(ok) {
      if (!ok) day().heartbeatFailed++;
    },
    countRestart() {
      day().restarts++;
    },
    addEvent({ status, key, person = null, date = null, start = null, facility = null, message = null }) {
      const e = { at: now(), status: String(status), key: String(key), person, date, start, facility };
      if (message) e.message = String(message).slice(0, 200);
      data.events.push(e);
    },
    // 直近 days 日分(今日を含む。JST)。Worker の週報用
    summary({ days = 7, nowMs = now() } = {}) {
      const to = dayOf(nowMs);
      const from = addDaysIso(to, -(Math.max(1, Math.min(days, keepDays)) - 1));
      const dayList = [];
      for (let iso = from; iso <= to; iso = addDaysIso(iso, 1)) dayList.push({ date: iso, ...(data.days[iso] || emptyDay()) });
      const events = data.events.filter((e) => {
        const d = dayOf(e.at);
        return d >= from && d <= to;
      });
      return { from, to, days: dayList, events };
    },
    prune,
    save,
    snapshot: () => JSON.parse(JSON.stringify(data)),
  };
}
