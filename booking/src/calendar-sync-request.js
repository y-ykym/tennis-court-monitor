// ============================================================
// フェーズ11: 予約が成立した直後に Worker へ「その人の Google カレンダーを同期して」と頼む(待たない)。
//
// 同期は Worker が都サイトから予約一覧を取り直して行う。都サイトが混んで一覧を取れないと(結果の noDelete に 'site')、
// 「追加 0」で終わって新しい予約が載らない(2026-11-22 0 時の先着受付: 成立 2 件とも 502 で空振りし、毎時 0 分の同期まで載らなかった)。
// 空振り・失敗・頼めなかったときは retryMs 後にやり直す(maxRetries 回まで)。それでも駄目なら毎時の同期に任せる。
// 認証・権限の失敗(auth)はやり直しても直らないのでやり直さない。
//
//   const request = createCalendarSyncRequester({ trigger: (person, reason) => Promise<result>, log });
//   request('A', 'auto-booked');
// ============================================================

export const CALENDAR_RETRY_MS = 3 * 60 * 1000;
export const CALENDAR_RETRY_MAX = 3;

export function createCalendarSyncRequester({ trigger, log = () => {}, retryMs = CALENDAR_RETRY_MS, maxRetries = CALENDAR_RETRY_MAX, timers = { setTimeout, clearTimeout } } = {}) {
  const pending = new Map(); // person → やり直しのタイマー(新しい依頼が来たら入れ替える)

  function run(person, reason, attempt) {
    const again = (why) => {
      if (attempt >= maxRetries) {
        log(`[gcal] ${person} のカレンダー同期: ${why}。やり直しは ${maxRetries} 回までなので、毎時の同期に任せます`);
        return;
      }
      log(`[gcal] ${person} のカレンダー同期: ${why}。${Math.round(retryMs / 60000)} 分後にやり直します(${attempt + 1}/${maxRetries} 回目)`);
      pending.set(person, timers.setTimeout(() => {
        pending.delete(person);
        run(person, reason, attempt + 1);
      }, retryMs));
    };
    return Promise.resolve()
      .then(() => trigger(person, reason))
      .then((r) => {
        const st = r?.[person];
        if (r?.skipped) return log(`[gcal] ${person} のカレンダー同期: skipped(${r.skipped})`);
        if (st?.error) {
          if (st.auth) return log(`[gcal] ${person} のカレンダー同期: 失敗 ${st.error}(認証・権限のためやり直しません)`);
          return again(`失敗 ${st.error}`);
        }
        log(`[gcal] ${person} のカレンダー同期: 追加 ${st?.inserted ?? '-'} / 更新 ${st?.updated ?? '-'} / 削除 ${st?.deleted ?? '-'}`);
        if (Array.isArray(st?.noDelete) && st.noDelete.includes('site')) again('都サイトから予約一覧を取れず、新しい予約が載っていない可能性があります');
      })
      .catch((e) => again(`頼めませんでした(${e.message})`));
  }

  return function request(person, reason) {
    if (person !== 'A' && person !== 'B') return Promise.resolve();
    const t = pending.get(person);
    if (t) {
      timers.clearTimeout(t);
      pending.delete(person);
    }
    return run(person, reason, 0);
  };
}
