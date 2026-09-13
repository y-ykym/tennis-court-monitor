// ============================================================
// 自宅の予約サーバー(Pi)の生存監視。Cloudflare の Cron Trigger(wrangler.toml [triggers])で 1 時間ごとに動く。
//
//   見るもの: (1) Pi が Worker に登録した URL が KV にあるか(registrar が 2 分ごとに登録、TTL 5 分。無い = Pi か Docker が止まっている、
//                 または Pi から外に出られない)
//             (2) あれば、その URL の /warmup がトンネル越しに応答するか(トンネルが死んでいないか)。
//                 トンネルの数秒〜10 秒の切断や、コンテナの作り直し(20〜30 秒)で鳴らさないよう、20 秒おきに 4 回(約 1 分幅)試して
//                 全部ダメなら失敗とする(2026-09-13 21:00 の初回は 10 秒幅でデプロイの瞬間に当たり誤報した)
//   知らせ方: 失敗したら LINE グループに 1 回だけ「止まっています」を push(1 時間間隔なので初回で知らせる)。
//             復帰したら「復帰しました」を 1 回 push。連続失敗中に毎回鳴らさない
//   状態:     KV の monitor_state に { fails, alerted, since } を保存(Worker は毎回まっさらで起きるため)
//
// 手元で試す: wrangler dev --test-scheduled → curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
// ============================================================
import { pushText } from './line.js';

const KV_URL_KEY = 'booking_url'; // booking.js と同じキー
const KV_STATE_KEY = 'monitor_state';
// 何回連続で失敗したら知らせるか(1 時間間隔なので初回。一時的な切断は probe 内の再試行で吸収する)
export const ALERT_AFTER_FAILS = 1;
const WARMUP_TIMEOUT_MS = 8000;
export const PROBE_ATTEMPTS = 4;
const PROBE_RETRY_MS = 20000;

const jst = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ').replace(/^0/, '').replace('-', '/');

// 1 回分の確認。戻り値: { ok, reason }
export async function probeBookingServer(env, { attempts = PROBE_ATTEMPTS, retryMs = PROBE_RETRY_MS } = {}) {
  const registered = await env.BOOKING_KV.get(KV_URL_KEY);
  if (!registered) return { ok: false, reason: 'Pi からの登録がありません(Pi・Docker・回線のどれかが止まっている可能性)' };
  let reason = '';
  for (let n = 1; n <= attempts; n++) {
    try {
      const res = await fetch(`${registered}/warmup`, { signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS) });
      if (res.ok) return { ok: true };
      reason = `トンネル越しの応答が HTTP ${res.status}`;
    } catch (e) {
      reason = `トンネル越しに届きません(${e.name === 'TimeoutError' ? 'タイムアウト' : e.message})`;
    }
    if (n < attempts) await new Promise((r) => setTimeout(r, retryMs));
  }
  return { ok: false, reason: `${reason}(${attempts} 回試行)` };
}

// 確認して状態を更新し、必要なら LINE に知らせる。戻り値: { ok, fails, notified: 'down'|'up'|null }
export async function runMonitor(env, { now = Date.now(), probe = probeBookingServer, push = pushText } = {}) {
  const prev = JSON.parse((await env.BOOKING_KV.get(KV_STATE_KEY)) || '{"fails":0,"alerted":false,"since":null}');
  const { ok, reason } = await probe(env);
  const next = ok ? { fails: 0, alerted: false, since: null } : { fails: prev.fails + 1, alerted: prev.alerted, since: prev.since ?? now };
  let notified = null;

  if (!ok && !prev.alerted && next.fails >= ALERT_AFTER_FAILS) {
    next.alerted = true;
    notified = 'down';
    await push(
      env.LINE_CHANNEL_ACCESS_TOKEN,
      env.LINE_GROUP_ID,
      `⚠️ 自宅の予約サーバーに ${jst(next.since)} から繋がりません\n${reason}\n通知の「予約」ボタンは使えないので、必要なら予約サイトで手動で。復帰したらお知らせします`
    );
  } else if (ok && prev.alerted) {
    notified = 'up';
    const mins = prev.since ? Math.round((now - prev.since) / 60000) : null;
    await push(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_GROUP_ID, `✅ 自宅の予約サーバーが復帰しました${mins != null ? `(停止 約${mins}分)` : ''}。「予約」ボタンが使えます`);
  }

  await env.BOOKING_KV.put(KV_STATE_KEY, JSON.stringify(next));
  console.log(`[monitor] ${ok ? 'ok' : `down(${next.fails}回目): ${reason}`}${notified ? ` → LINE に ${notified} を通知` : ''}`);
  return { ok, fails: next.fails, notified };
}
