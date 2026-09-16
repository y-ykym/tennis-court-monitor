// ============================================================
// 自宅の予約サーバー(Pi)の生存監視。Cloudflare の Cron Trigger(wrangler.toml [triggers])で 1 時間ごとに動く。
//
//   見るもの: (1) Pi が Worker に登録した URL が KV にあるか(registrar が 4 分ごとに登録、TTL 10 分。無い = Pi か Docker が止まっている、
//                 または Pi から外に出られない)
//             (2) あれば、その URL の /warmup がトンネル越しに応答するか(トンネルが死んでいないか)。
//                 トンネルの数秒〜10 秒の切断や、コンテナの作り直し(20〜30 秒)で鳴らさないよう、20 秒おきに 4 回(約 1 分幅)試して
//                 全部ダメなら失敗とする(2026-09-13 21:00 の初回は 10 秒幅でデプロイの瞬間に当たり誤報した)
//   知らせ方: 失敗したら LINE グループに 1 回だけ「止まっています」を push(1 時間間隔なので初回で知らせる)。
//             復帰したら「復帰しました」を 1 回 push。連続失敗中に毎回鳴らさない
//   状態:     KV の monitor_state に { fails, alerted, since, autoAlerted, pending } を保存(Worker は毎回まっさらで起きるため)
//   順番:     **状態を保存してから送る**。逆(送ってから保存)にすると、
//             (a) KV が書けないとき「知らせた」記録が残らず、毎時同じ警報を送り続ける
//             (b) LINE が失敗すると例外で保存まで届かず、次の回も同じ判定をやり直し、停止時間が実態より長く出る
//             2026-09-16 に (a)(b) が同時に起き、⚠️ を夜通し連投 → LINE の通数上限 → 復帰通知が 6 時間遅れ、
//             「停止 約960分」(実際は約10時間)と表示された。送れなかった知らせは pending に積んで次の回に再送する
//
// 手元で試す: wrangler dev --test-scheduled → curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
// ============================================================
import { pushText } from './line.js';
import { autoStatus } from './auto.js';

// 月初(1 日 9:00 JST = 0:00 UTC)に届く手動メンテのお知らせ。cron は wrangler.toml [triggers] と index.js の scheduled() で振り分ける
export const MAINTENANCE_CRON = '0 0 1 * *';
export const MAINTENANCE_TEXT = [
  '🛠 月初のお知らせ: 自宅の予約サーバー(homepi)のメンテ',
  'OS・カーネル・Docker は毎朝自動で更新されていますが、予約サイトを開くブラウザ(Chromium)だけは手動で入れ直す必要があります(数か月に 1 回で十分)。',
  '',
  'Mac から:',
  'ssh yu@homepi.local',
  'cd ~/tennis-court-monitor/booking/pc && git pull && docker compose build --pull booking && docker compose up -d && ./pi-check.sh',
  '',
  '毎時 0 分前後は避けてください(監視と重なって「繋がりません」が誤って届きます)。',
].join('\n');

export async function sendMaintenanceReminder(env, { push = pushText } = {}) {
  await push(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_GROUP_ID, MAINTENANCE_TEXT);
  console.log('[monitor] 月初のメンテのお知らせを LINE に送りました');
}

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

// フェーズ3: 予約サーバー自体は生きているのに自動予約の照会ループが止まっているとき用。
// Pi の /auto/status(トンネル越し)で mode が 'on' なのに、最後の照会がこれより古ければ知らせる(1 回だけ。復帰でも 1 回)。
// 起動直後(startedAt から AUTO_STALL_MS 以内)は初回の照会前なので判定しない
export const AUTO_STALL_MS = 15 * 60 * 1000;

// 送れずに持ち越した知らせは、これより古ければ「遅れて届いた」と断り書きを付ける
export const DELAYED_NOTE_MS = 30 * 60 * 1000;
// 持ち越しの上限(これより古い知らせは捨てる。何日も前の警報を今さら送らない)
const PENDING_MAX_AGE_MS = 24 * 3600 * 1000;
const PENDING_MAX = 5;

// 「約90分」「約11時間」
const humanDuration = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 120 ? `約${m}分` : `約${Math.round(m / 60)}時間`;
};

// 確認して状態を更新し、必要なら LINE に知らせる。
// 戻り値: { ok, fails, notified: 'down'|'up'|null, autoNotified: 'stalled'|'resumed'|null, sent, pending, saved }
export async function runMonitor(env, { now = Date.now(), probe = probeBookingServer, push = pushText } = {}) {
  const prev = JSON.parse((await env.BOOKING_KV.get(KV_STATE_KEY)) || '{"fails":0,"alerted":false,"since":null}');
  const { ok, reason } = await probe(env);
  const next = ok ? { fails: 0, alerted: false, since: null, autoAlerted: prev.autoAlerted || false } : { fails: prev.fails + 1, alerted: prev.alerted, since: prev.since ?? now, autoAlerted: prev.autoAlerted || false };
  let notified = null;
  let autoNotified = null;
  // 前回送れなかったぶんを先に積む(古すぎるものは捨てる)
  const queue = (Array.isArray(prev.pending) ? prev.pending : []).filter((m) => m && typeof m.text === 'string' && typeof m.at === 'number' && now - m.at < PENDING_MAX_AGE_MS);

  // 自動予約の照会ループの見張り(予約サーバーが応答しているときだけ判定する。サーバーごと落ちていれば上の ⚠️ で分かる)
  if (ok) {
    const auto = await autoStatus(env, now);
    const justStarted = auto.startedAt != null && now - auto.startedAt < AUTO_STALL_MS;
    const stalled = auto.reachable && auto.mode === 'on' && !justStarted && (auto.lastSeenAt == null || now - auto.lastSeenAt > AUTO_STALL_MS);
    if (stalled && !prev.autoAlerted) {
      next.autoAlerted = true;
      autoNotified = 'stalled';
      queue.push({ at: now, text: `⚠️ 自動予約の空きチェックが止まっています(最後の合図: ${auto.lastSeenAt ? jst(auto.lastSeenAt) : '不明'})\n予約サーバー自体は動いています。空き通知は従来どおり全部届きます。Pi で docker compose logs booking を確認してください` });
    } else if (!stalled && prev.autoAlerted) {
      next.autoAlerted = false;
      autoNotified = 'resumed';
      queue.push({ at: now, text: '✅ 自動予約の空きチェックが復帰しました' });
    }
  }

  if (!ok && !prev.alerted && next.fails >= ALERT_AFTER_FAILS) {
    next.alerted = true;
    notified = 'down';
    queue.push({ at: now, text: `⚠️ 自宅の予約サーバーに ${jst(next.since)} から繋がりません\n${reason}\n通知の「予約」ボタンは使えないので、必要なら予約サイトで手動で。復帰したらお知らせします` });
  } else if (ok && prev.alerted) {
    notified = 'up';
    // 停止時間は「復帰に気づいた今」で確定させる。送信が遅れても水増しされないよう、文面はここで作る
    const span = prev.since ? `(${jst(prev.since)} 〜 ${jst(now)}、${humanDuration(now - prev.since)})` : '';
    queue.push({ at: now, text: `✅ 自宅の予約サーバーが復帰しました${span}。「予約」ボタンが使えます` });
  }

  // ① 先に保存する。保存できなければ今回は送らない(送ったのに記録が残らず連投する事故を防ぐ)。
  //    KV が書けるようになった回に、溜めておいた知らせがまとめて出る
  next.pending = queue.slice(-PENDING_MAX);
  try {
    await env.BOOKING_KV.put(KV_STATE_KEY, JSON.stringify(next));
  } catch (e) {
    console.log(`[monitor] ${ok ? 'ok' : `down(${next.fails}回目): ${reason}`} / 状態を保存できず、知らせ ${next.pending.length} 件は次回に持ち越し: ${e.message}`);
    return { ok, fails: next.fails, notified: null, autoNotified: null, sent: 0, pending: next.pending.length, saved: false };
  }

  // ② 送る。1 件でも失敗したら残りはまとめて持ち越す(通数上限や障害なら続けても同じ結果になる)
  const remaining = [];
  let sent = 0;
  let failure = '';
  for (const m of next.pending) {
    if (remaining.length) {
      remaining.push(m);
      continue;
    }
    const late = now - m.at > DELAYED_NOTE_MS ? `\n(${jst(m.at)} 時点のお知らせです。送信できなかったため遅れて届いています)` : '';
    try {
      await push(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_GROUP_ID, `${m.text}${late}`);
      sent++;
    } catch (e) {
      failure = e.message;
      remaining.push(m);
    }
  }
  if (sent > 0) {
    next.pending = remaining;
    // 送信済みの記録。ここだけ失敗すると同じ知らせが次回また届く(黙って消えるよりはまし)
    try {
      await env.BOOKING_KV.put(KV_STATE_KEY, JSON.stringify(next));
    } catch (e) {
      console.log(`[monitor] 送信済みの記録に失敗(同じ知らせが再送されることがあります): ${e.message}`);
    }
  }

  console.log(
    `[monitor] ${ok ? 'ok' : `down(${next.fails}回目): ${reason}`}` +
      `${notified ? ` → ${notified}` : ''}${autoNotified ? ` / 自動予約 ${autoNotified}` : ''}` +
      `${sent ? ` / LINE に ${sent} 件送信` : ''}${remaining.length ? ` / ${remaining.length} 件は次回に再送(${failure})` : ''}`
  );
  return { ok, fails: next.fails, notified, autoNotified, sent, pending: next.pending.length, saved: true };
}
