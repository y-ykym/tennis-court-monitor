// ============================================================
// 予約実行の行列(フェーズ3)。ブラウザは 1 つしかないので予約は 1 件ずつ順に実行する。
//
//   const q = createBookingQueue({ log })
//   q.submit({ id, kind: 'manual'|'auto', run: () => Promise<result> })
//     → { status: 'started'|'queued'|'duplicate', promise }
//        started   すぐ実行を始めた(空いていた)
//        queued    いま別の予約を実行中なので待たせた(実行が終わると順に始まる)
//        duplicate 同じ id が実行中または待ち行列にある(二重投入しない)
//        promise   その予約の実行結果 { ok: true, result } | { ok: false, error }
//   q.current() / q.waiting() / q.isBusy() / q.has(id)
//
// 優先順位: 手動(LINE の予約ボタン = kind 'manual')は自動予約(kind 'auto')より先。
//   手動を submit すると、待っている自動予約の前に割り込む(実行中のものは中断しない。40〜90 秒で終わるのを待つ)
// ============================================================

export function createBookingQueue({ log = () => {} } = {}) {
  const waiting = [];
  let current = null;

  function has(id) {
    return (current && current.id === id) || waiting.some((j) => j.id === id);
  }

  function pump() {
    if (current || waiting.length === 0) return;
    const job = waiting.shift();
    current = job;
    job.startedAt = Date.now();
    log(`行列: 実行開始 ${job.kind} ${job.id}(待ち ${waiting.length} 件)`);
    Promise.resolve()
      .then(() => job.run())
      .then(
        (result) => job.resolve({ ok: true, result }),
        (error) => job.resolve({ ok: false, error })
      )
      .finally(() => {
        current = null;
        pump();
      });
  }

  function submit(job) {
    if (!job || !job.id || typeof job.run !== 'function') throw new Error('job には id と run が必要です');
    if (has(job.id)) return { status: 'duplicate', promise: null };
    const entry = { id: job.id, kind: job.kind === 'manual' ? 'manual' : 'auto', run: job.run, meta: job.meta || null, queuedAt: Date.now() };
    entry.promise = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    if (entry.kind === 'manual') {
      // 待っている自動予約の前、既に待っている手動の後ろに入れる
      const firstAuto = waiting.findIndex((j) => j.kind === 'auto');
      if (firstAuto < 0) waiting.push(entry);
      else waiting.splice(firstAuto, 0, entry);
    } else {
      waiting.push(entry);
    }
    const willStart = !current;
    pump();
    return { status: willStart ? 'started' : 'queued', promise: entry.promise };
  }

  return {
    submit,
    has,
    current: () => current,
    waiting: () => [...waiting],
    isBusy: () => !!current,
  };
}
