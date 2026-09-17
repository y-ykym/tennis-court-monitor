// ============================================================
// フェーズ3 自動予約の中核(Pi の予約支援サーバーの中で動く。server/server.mjs から起動)
//
//   定期的に(AUTO_BOOKING.POLL_INTERVAL_MS と POLL_SCHEDULE。21:00〜翌 1:00 は 1 分、7:00〜21:00 は 2 分、1:00〜7:00 は 3 分。
//   30 秒未満にはしない。「前回の開始から間隔ぶん後」に次を始め、照会自体が間隔を超えたときは MIN_GAP_MS だけ空けて次を始める):
//     空き照会(lib/scrape.js。ログイン不要の JSON)→ 監視条件(lib/filter.js)→ 前回との差分 = 新しく出た空き
//     → Worker に「生きている」合図(heartbeat)を送り、応答で除外日・除外枠を受け取る
//     → lib/auto-rules.js で振り分け(ペナルティ期間・除外日・除外枠は見送り)、利用日ごとに公園→時間帯の優先順に並べる
//     → 候補を 1 件ずつ予約の行列(booking-queue.js)に入れる。行列は 1 件ずつ実行し、手動(LINE ボタン)を優先する
//   各候補の実行(行列の中):
//     まず「いま」の時刻で対象かどうかをもう一度判定する(要件 #11。23:59 に見つけて 00:01 に実行すると +3 日 = ペナルティ期間になる。
//     +4 日の枠は 23:35 以降は自動予約しない)。対象外になっていたら予約せず、Pi 自身が従来の空き通知カード(予約ボタン付き)を送る
//     (Actions は見つけた時点で「対象枠だから通知しない」と処理済みのことがあるため)。除外日・除外枠になっていたらカードも送らない。
//     その利用日の残り枚数が 0 なら見送り(ログイン不要)。そうでなければ reserve() を reservationList + beforeApply 付きで呼び、
//     ログイン直後の予約一覧でその日の件数を数え、上限(2 件)なら予約せず 'capped'。成立したら結果カード(自動予約の表記。
//     利用日 = 今日+4 日なら「ペナルティなしで取り消せるのは今日 23:59 まで」とキャンセルボタン)。見送りはカードなし。
//     失敗のうち「先に取られた(taken)」「サイトが断った(duplicate)」は LINE の通数を節約するためカードを送らずログのみ(人が何もできない失敗)。
//     ログインできない・reCAPTCHA で拒否・サイトのエラーは放置すると自動予約が全部止まるのでカードで知らせる
//     予約一覧に「自分が自動予約した枠」が無ければ、サイトで手放したとみなして Worker に除外枠として登録する
//
//   mode: 'on'     予約まで行う(heartbeat の active=true → Actions は対象期間の枠を通知しない)
//         'dry-run' 照会と振り分けだけ行い、予約するはずの枠をログに出す(active=false → Actions は従来どおり全部通知)
//   LINE の「じどうおふ」/「じどうおん」: Worker の KV のスイッチを heartbeat の応答(enabled)で受け取る。OFF の間は mode='on' でも
//         予約せず(dry-run と同じ動き。ログは [LINE で停止中])、Worker には mode='paused'・active=false を申告する
//
//   初回起動(状態ファイルが無い・古い): いま見えている空きを既知として登録し、予約しない(起動直後の暴走防止)
//   実枠テスト用: forgetFile(既定 /var/lib/booking/forget-keys.txt)に枠キーを 1 行ずつ書いておくと、次の周期でその枠を
//   「既知」から外す = いま見えている空きを「新しく出た」扱いにして予約の流れに乗せる(ファイルは読んだら消す)。
//   Pi 上で: docker compose exec booking sh -c 'echo "1160|2026-09-27|15:00" > /var/lib/booking/forget-keys.txt'
//   Worker に繋がらない: 直近 EXCLUSIONS_MAX_AGE_MS 以内に取れた除外一覧があればそれで続行、無ければ予約しない(除外日を守れないため)
//
//   ログには利用者番号・パスワード・鍵・Cookie を出さない。見送りの理由は必ず出す
// ============================================================
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { signCancelToken } from './cancel-token.js';
import { buildResultFlex } from './result-flex.js';

const require = createRequire(import.meta.url);
const { AUTO_BOOKING } = require('../../lib/config.js');
const { filterTargetSlots } = require('../../lib/filter.js');
const { inMaintenanceWindow } = require('../../lib/maintenance.js');
const { jstTodayIso, jstEndOfDaySec, jstHHMM } = require('../../lib/date.js');
const { slotKey, parkOf, planAutoBooking, classifySlot, isFreeCancelLastDay, startHHMM } = require('../../lib/auto-rules.js');

// 除外一覧はこれより古いものを使わない(Worker に繋がらない間は、これを過ぎたら予約しない)
const EXCLUSIONS_MAX_AGE_MS = 30 * 60 * 1000;
// これらの結果の枠は同じ枠が「新しく出た」扱いになっても再投入しない
const NO_RETRY_STATUSES = new Set(['queued', 'running', 'success']);
// 照会が間隔より長くかかったとき、次の照会までに最低これだけ空ける
export const MIN_GAP_MS = 15 * 1000;
// 「その日は既に上限まで予約がある」という記憶の有効時間。過ぎたら次の候補でまた一覧を見て数える。
// 15 分だと、同じ枠が空いたり取られたりを繰り返す(9/17 の 9/21 17:00 猿江)たびにログインしてしまうので 60 分に(2026-09-17)
export const DAY_REMAINING_TTL_MS = 60 * 60 * 1000;
// ログインが拒否された(auth_error)予約者は、この時間はその人の自動予約を止める(パスワード誤り等で繰り返すとアカウントロックの恐れ。
// カードも最初の 1 回だけ)。時間が過ぎたら次の候補で 1 回だけ試し直す
export const AUTH_PAUSE_MS = 6 * 60 * 60 * 1000;

// 次の照会までの待ち時間: 「前回の開始 + 間隔」を目標にし、既に過ぎていれば MIN_GAP_MS だけ空ける
export function nextDelayMs({ startedAt, finishedAt, intervalMs, minGapMs = MIN_GAP_MS }) {
  return Math.max(startedAt + intervalMs - finishedAt, minGapMs);
}

// その時刻(JST)に使う照会間隔。AUTO_BOOKING.POLL_SCHEDULE の時間帯(FROM <= 時刻 < TO)に当たればその間隔、当たらなければ baseIntervalMs
export function pollIntervalAt(nowMs, baseIntervalMs, schedule = AUTO_BOOKING.POLL_SCHEDULE) {
  if (!schedule || schedule.length === 0) return baseIntervalMs;
  const hhmm = jstHHMM(nowMs);
  for (const w of schedule) {
    const hit = w.FROM < w.TO ? hhmm >= w.FROM && hhmm < w.TO : hhmm >= w.FROM || hhmm < w.TO;
    if (hit) return Math.max(w.POLL_INTERVAL_MS, AUTO_BOOKING.MIN_POLL_INTERVAL_MS);
  }
  return baseIntervalMs;
}

// 結果カードを送らない結果: 見送りと、人が何もできない失敗(先に取られた・サイトが断った・サイトのエラー)。LINE の月 200 通の枠を節約する。
// 送るのは 成功、ログインできない(auth_error)、reCAPTCHA で拒否(rejected)、人に渡したが完了しなかった(abandoned)
const SILENT_STATUSES = new Set(['capped', 'skipped', 'dry_run', 'taken', 'duplicate', 'error']);

export function createAutoRunner({
  mode = 'dry-run',
  scrape, // async () => Slot[]
  queue, // booking-queue.js
  state, // auto-state.js
  worker, // { heartbeat(payload) → Promise<{ dates, slots }>, addExcludedSlots(slots) → Promise }
  book, // async (candidate, { credentials, beforeApply }) → reserve() の結果
  credentialsFor, // (person) → { userId, password, label } | null
  notify = async () => {}, // (flexMessage, what) → LINE に push(server の lineQueue.send)
  notifyVacancy = async () => {}, // (slots) → 従来の空き通知カード(予約ボタン付き)を LINE に push(予約直前に対象外になった枠用)
  signingSecret = '',
  log = () => {},
  now = Date.now,
  pollMs = AUTO_BOOKING.POLL_INTERVAL_MS,
  maintenance = inMaintenanceWindow,
  forgetFile = null,
}) {
  const interval = Math.max(Number(pollMs) || AUTO_BOOKING.POLL_INTERVAL_MS, AUTO_BOOKING.MIN_POLL_INTERVAL_MS);
  const active = mode === 'on';
  let timer = null;
  let running = false;
  let exclusions = null; // { dates, slots, at }
  let remoteEnabled = true; // LINE の「じどうおふ」で false(Worker の応答で更新)
  let remoteNotify = true; // LINE の「つうちおふ」で false(予約直前に対象外になった枠の空き通知カードを送らない)
  const effectiveMode = () => (mode === 'on' && !remoteEnabled ? 'paused' : mode);
  const bookingEnabled = () => mode === 'on' && remoteEnabled;
  let lastCycle = { at: null, ms: null, error: null, newSlots: 0 };
  let lastTargets = []; // 直近の照会で見えていた監視対象の枠(/auto/status で確認できる)
  // 利用日ごとの残り枚数(予約一覧を見た結果から)。DAY_REMAINING_TTL_MS を過ぎたら忘れて、次はまた一覧を見て数える
  // (本人が LINE やサイトで取り消した後に「まだ 1 件ある」と思い込み続けないため)
  const dayRemaining = new Map(); // date → { remaining, at }
  const authFailedAt = new Map(); // person → ログインが拒否された時刻
  const remainingFor = (date) => {
    const r = dayRemaining.get(date);
    if (!r) return null;
    if (now() - r.at > DAY_REMAINING_TTL_MS) {
      dayRemaining.delete(date);
      return null;
    }
    return r.remaining;
  };

  const describe = (s) => `${s.date} ${s.time || `${startHHMM(s.startHour)}-`} ${s.facility || parkOf(s.park)?.name || s.park}`;

  async function heartbeat(extra = {}) {
    const payload = { active: bookingEnabled(), mode: effectiveMode(), at: now(), queued: queue.waiting().length, running: queue.isBusy(), lastCycle, ...extra };
    try {
      const res = await worker.heartbeat(payload);
      if (res && typeof res.enabled === 'boolean' && res.enabled !== remoteEnabled) {
        remoteEnabled = res.enabled;
        log(remoteEnabled ? 'LINE の「じどうおん」で自動予約を再開します' : 'LINE の「じどうおふ」で自動予約を停止します(照会は続け、予約はしない)');
      }
      if (res && typeof res.notifyEnabled === 'boolean' && res.notifyEnabled !== remoteNotify) {
        remoteNotify = res.notifyEnabled;
        log(remoteNotify ? 'LINE の「つうちおん」で空き通知カードを再開します' : 'LINE の「つうちおふ」で空き通知カードを止めます(結果カードは送る)');
      }
      if (res && Array.isArray(res.dates) && Array.isArray(res.slots)) {
        const changed = !exclusions || JSON.stringify([res.dates, res.slots.map(slotKey)]) !== JSON.stringify([exclusions.dates, exclusions.slots.map(slotKey)]);
        exclusions = { dates: res.dates, slots: res.slots, at: now() };
        if (changed) log(`除外一覧を更新: 除外日 ${res.dates.length} 件、除外枠 ${res.slots.length} 件`);
      }
      return true;
    } catch (e) {
      log(`Worker への合図に失敗(${e.message})${exclusions ? `。直近の除外一覧(${Math.round((now() - exclusions.at) / 60000)} 分前)で続けます` : '。除外一覧が無いため予約はしません'}`);
      return false;
    }
  }

  function usableExclusions() {
    if (!exclusions) return null;
    if (now() - exclusions.at > EXCLUSIONS_MAX_AGE_MS) return null;
    return exclusions;
  }

  // 1 周期分。戻り値はテスト用の要約
  async function tick() {
    if (running) return { skipped: 'busy' };
    running = true;
    const started = now();
    try {
      const nowDate = new Date(started);
      if (maintenance(nowDate)) {
        await heartbeat({ note: 'maintenance' });
        return { skipped: 'maintenance' };
      }
      const today = jstTodayIso(started);
      let slots;
      try {
        slots = await scrape();
      } catch (e) {
        log(`空き照会に失敗(今回はスキップ): ${e.message}`);
        lastCycle = { at: started, ms: now() - started, error: e.message, newSlots: 0 };
        await heartbeat();
        return { skipped: 'scrape_failed' };
      }
      const targets = filterTargetSlots(slots);
      lastTargets = targets;
      const keys = targets.map(slotKey);
      const known = state.knownKeys();
      // 実枠テスト用: 指定された枠を既知から外して「新しく出た」扱いにする
      for (const k of readForgetKeys()) {
        if (known.delete(k)) log(`テスト用に既知から外しました(次の判定で新しい空きとして扱う): ${k}`);
        else log(`テスト用の指定 ${k} は既知の一覧にありません(いま空いていないか、キーの書き方が違う)`);
      }
      const newSlots = state.needsBaseline() ? [] : targets.filter((s) => !known.has(slotKey(s)));
      const baseline = state.needsBaseline();
      state.setKnown(keys);
      state.prune(today);
      lastCycle = { at: started, ms: now() - started, error: null, newSlots: newSlots.length };
      await heartbeat();
      state.save();
      // 動いていることが分かるよう毎回 1 行(1 日 1,440 行程度。docker のログ上限 10MB×3 に収まる)
      log(`照会: 監視対象 ${targets.length} 件(全体 ${slots.length} 件)、新規 ${newSlots.length} 件、所要 ${Math.round(lastCycle.ms / 1000)} 秒`);

      if (baseline) {
        log(`初回起動: いま見えている監視対象 ${targets.length} 件を既知として登録しました(この分は予約しません)`);
        return { baseline: true, known: targets.length };
      }
      if (newSlots.length === 0) return { newSlots: 0 };
      log(`新しい空き ${newSlots.length} 件: ${newSlots.map(describe).join(' / ')}`);

      const ex = usableExclusions();
      if (!ex) {
        for (const s of newSlots) log(`  見送り: ${describe(s)} (Worker から除外一覧が取れていないため)`);
        return { newSlots: newSlots.length, planned: 0, reason: 'no_exclusions' };
      }
      const { byDate, skipped } = planAutoBooking(newSlots, { now: started, exclusions: ex });
      for (const s of skipped) log(`  見送り: ${describe(s.slot)} (${s.reason}${s.kind === 'penalty' || s.kind === 'deadline' ? '。通知は Actions が行う' : s.kind === 'excluded_date' || s.kind === 'excluded_slot' ? '。通知もしない' : ''})`);

      let planned = 0;
      for (const [date, cands] of byDate) {
        const person = cands[0].person;
        const creds = credentialsFor(person);
        if (!creds) {
          for (const c of cands) log(`  見送り: ${describe(c)} (予約者 ${person} の利用者情報が未設定)`);
          continue;
        }
        const failedAt = authFailedAt.get(person);
        if (failedAt != null && now() - failedAt < AUTH_PAUSE_MS) {
          const left = Math.ceil((AUTH_PAUSE_MS - (now() - failedAt)) / 60000);
          for (const c of cands) log(`  見送り: ${describe(c)} (予約者 ${person} はログインが拒否されたため ${left} 分間は自動予約を止めている。利用者番号・パスワード・カード有効期限を確認)`);
          continue;
        }
        for (const c of cands) {
          const st = state.attemptStatus(c.key);
          if (NO_RETRY_STATUSES.has(st)) {
            log(`  見送り: ${describe(c)} (この枠は ${st === 'success' ? '既に自動予約済み' : '実行中または待ち行列にある'})`);
            continue;
          }
          if (!bookingEnabled()) {
            log(`  [${mode === 'on' ? 'LINE で停止中' : 'dry-run'}] 予約するはず: ${describe(c)} 予約者=${creds.label}(${person})`);
            state.markAttempt(c.key, 'dry_run');
            continue;
          }
          const r = queue.submit({ id: c.key, kind: 'auto', meta: c, run: () => runCandidate(c, creds) });
          if (r.status === 'duplicate') {
            log(`  見送り: ${describe(c)} (行列に既にある)`);
            continue;
          }
          state.markAttempt(c.key, 'queued');
          planned++;
          log(`  行列へ: ${describe(c)} 予約者=${creds.label}(${person}) [${r.status}]`);
        }
      }
      state.save();
      return { newSlots: newSlots.length, planned };
    } catch (e) {
      log(`照会ループでエラー(次の周期で続けます): ${e.stack || e.message}`);
      return { error: e.message };
    } finally {
      running = false;
    }
  }

  // 行列の中で実行される 1 候補分
  async function runCandidate(c, creds) {
    const key = c.key;
    // 行列で待っている間に「じどうおふ」が来ていたら予約しない(カードも送らない。Actions が従来どおり通知する)
    if (!bookingEnabled()) {
      log(`見送り(実行直前): ${describe(c)} (LINE で自動予約が停止中)`);
      state.markAttempt(key, 'dry_run');
      state.save();
      return { status: 'skipped', message: 'LINE で自動予約が停止中' };
    }
    // 予約の直前に「いま」で対象かどうかをもう一度判定する(見つけた時の判定を使い回さない。日付が変わる・23:35 を過ぎる)
    const t = now();
    const today = jstTodayIso(t);
    const again = classifySlot(c, { now: t, exclusions: usableExclusions() || exclusions || { dates: [], slots: [] } });
    if (again.kind !== 'auto') {
      state.markAttempt(key, `skipped_${again.kind}`);
      state.save();
      if (again.kind === 'excluded_slot' || again.kind === 'excluded_date') {
        log(`見送り(予約直前の再判定): ${describe(c)} (${again.reason}。通知もしない)`);
        return { status: 'skipped', message: again.reason };
      }
      if (!remoteNotify) {
        log(`見送り(予約直前の再判定): ${describe(c)} (${again.reason}。空き通知カードは「つうちおふ」で止めているため送らない)`);
        return { status: 'skipped', message: again.reason, notified: false };
      }
      log(`見送り(予約直前の再判定): ${describe(c)} (${again.reason}。従来の空き通知カードを送る)`);
      try {
        await notifyVacancy([{ facility: c.facility, date: c.date, time: c.time || `${startHHMM(c.startHour)}-${startHHMM(Number(c.startHour) + 2)}`, count: c.count ?? 1 }]);
      } catch (e) {
        log(`空き通知カードの送信に失敗: ${e.message}`);
      }
      return { status: 'skipped', message: again.reason, notified: true };
    }
    const remaining = remainingFor(c.date);
    if (remaining != null && remaining <= 0) {
      log(`見送り: ${describe(c)} (${c.date} は既に ${AUTO_BOOKING.MAX_PER_DAY} 件あるため。ログインせず)`);
      state.markAttempt(key, 'capped');
      state.save();
      return { status: 'capped' };
    }
    state.markAttempt(key, 'running');
    state.save();
    let listCount = null;
    const beforeApply = async ({ reservations }) => {
      listCount = reservations.filter((r) => r.date === c.date).length;
      await detectReleased(c.person, reservations, today);
      if (listCount >= AUTO_BOOKING.MAX_PER_DAY) {
        return { status: 'capped', message: `${c.date} は既に ${listCount} 件の予約があるため見送りました(手動分を含む)` };
      }
      return null;
    };
    log(`自動予約 開始: ${describe(c)} 予約者=${creds.label}(${c.person})`);
    let result;
    try {
      result = await book(c, { credentials: creds, beforeApply });
    } catch (e) {
      result = { status: 'error', message: e.message };
    }
    const ok = result.status === 'success';
    if (listCount != null) dayRemaining.set(c.date, { remaining: AUTO_BOOKING.MAX_PER_DAY - listCount - (ok ? 1 : 0), at: now() });
    if (result.status === 'auth_error') {
      const first = !authFailedAt.has(c.person) || now() - authFailedAt.get(c.person) >= AUTH_PAUSE_MS;
      authFailedAt.set(c.person, now());
      log(`予約者 ${c.person} のログインが拒否されたため、${Math.round(AUTH_PAUSE_MS / 3600000)} 時間は ${c.person} の自動予約を止めます`);
      if (!first) {
        state.markAttempt(key, result.status);
        state.save();
        return result;
      }
    } else if (ok) {
      authFailedAt.delete(c.person);
    }
    state.markAttempt(key, result.status);
    log(`自動予約 結果: ${result.status} ${describe(c)} ${result.message || ''}`.trim());

    if (ok) {
      const park = parkOf(c.park);
      const start = startHHMM(c.startHour);
      const end = startHHMM(Number(c.startHour) + 2);
      state.addOwn({ key, person: c.person, id: result.reservationNo || '', date: c.date, start, end, park: c.park, facility: park?.name || c.facility });
      let cancelData = null;
      if (isFreeCancelLastDay(c.date, today) && result.reservationNo && signingSecret) {
        try {
          cancelData = signCancelToken(signingSecret, {
            kind: 'c',
            person: c.person,
            id: result.reservationNo,
            date: c.date,
            start,
            end,
            facility: park?.name || c.facility,
            penaltyDay: AUTO_BOOKING.PENALTY_DAYS,
            exp: jstEndOfDaySec(today),
          });
        } catch (e) {
          log(`キャンセルボタンの署名に失敗(ボタン無しで送ります): ${e.message}`);
        }
      }
      await notify(buildResultFlex({ slot: bookingSlot(c), ...result }, creds.label, { auto: true, cancelData }), '自動予約の結果カード');
    } else if (!SILENT_STATUSES.has(result.status)) {
      await notify(buildResultFlex({ slot: bookingSlot(c), ...result, facility: result.facility || parkOf(c.park)?.name || c.facility }, creds.label, { auto: true }), '自動予約の結果カード');
    } else if (result.status === 'taken' || result.status === 'duplicate' || result.status === 'error') {
      log(`結果カードは送りません(${result.status}。人が対応できる失敗ではないため。LINE の通数節約)`);
    }
    state.save();
    return result;
  }

  // 自分が自動予約した枠が、その人の予約一覧から消えていたら「サイトで手放した」とみなして除外枠に登録する
  async function detectReleased(person, reservations, today) {
    const mine = state.own().filter((o) => o.person === person && o.date >= today);
    if (mine.length === 0) return;
    const inList = new Set(reservations.map(slotKey));
    const released = mine.filter((o) => !inList.has(o.key));
    if (released.length === 0) return;
    for (const o of released) log(`自動予約した枠が予約一覧に無いため除外枠に登録します: ${o.date} ${o.start} ${o.facility}`);
    try {
      await worker.addExcludedSlots(released.map((o) => ({ park: o.park, date: o.date, start: o.start, end: o.end, facility: o.facility, reason: 'released' })));
      for (const o of released) state.removeOwn(o.key);
      state.save();
    } catch (e) {
      log(`除外枠の登録に失敗(次回また試します): ${e.message}`);
    }
  }

  const bookingSlot = (c) => ({ park: c.park, date: c.date, startHour: Number(c.startHour), people: AUTO_BOOKING.PEOPLE });

  // forgetFile を読んで枠キーの配列を返し、ファイルは消す(無ければ空)
  function readForgetKeys() {
    if (!forgetFile) return [];
    try {
      const keys = fs.readFileSync(forgetFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      fs.rmSync(forgetFile, { force: true });
      return keys;
    } catch {
      return [];
    }
  }

  function start() {
    if (timer) return api;
    const sched = (AUTO_BOOKING.POLL_SCHEDULE || []).map((w) => `${w.FROM}〜${w.TO} は ${Math.round(w.POLL_INTERVAL_MS / 1000)} 秒`).join('、');
    log(`自動予約の照会ループを開始: mode=${mode} 間隔=${Math.round(interval / 1000)}秒${sched ? `(${sched})` : ''}`);
    const loop = async () => {
      const startedAt = now();
      await tick();
      timer = setTimeout(loop, nextDelayMs({ startedAt, finishedAt: now(), intervalMs: pollIntervalAt(startedAt, interval) }));
    };
    timer = setTimeout(loop, 3000);
    return api;
  }
  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  const api = {
    tick, start, stop, mode, active, intervalMs: interval,
    effectiveMode, remoteEnabled: () => remoteEnabled, remoteNotify: () => remoteNotify,
    exclusions: () => exclusions, lastCycle: () => lastCycle, lastTargets: () => lastTargets, dayRemaining,
  };
  return api;
}

// 空き照会の関数を作る。MOCK_SLOTS_FILE があればファイルを読む(dry-run の確認用)。
// 実サイトは 3 公園を並行して取る(AUTO_SCRAPE_CONCURRENCY、既定 3。1 にすると Actions と同じ順番取り)
export function createScraper({ mockFile = process.env.MOCK_SLOTS_FILE, concurrency = Number(process.env.AUTO_SCRAPE_CONCURRENCY) || 3 } = {}) {
  if (mockFile) {
    return async () => JSON.parse(fs.readFileSync(mockFile, 'utf8'));
  }
  const { scrapeAvailability } = require('../../lib/scrape.js');
  return () => scrapeAvailability({ concurrency });
}
