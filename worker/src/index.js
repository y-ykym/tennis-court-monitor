// ============================================================
// フェーズ1.5 予約確認ボット + フェーズ1.6 予約キャンセル + フェーズ4 ペナルティ予告アラート(Cloudflare Workers)
//
//   LINEグループで「よやく」と送る → LINEがこのWorkerの POST /webhook を呼ぶ
//   → 署名を検証 → 対象グループの「よやく」だけ拾う
//   → A・B それぞれの利用者番号で予約サイトにログインして予約一覧を取得(並行)
//   → 同時にテニスベアの「今後の予定」も取り(フェーズ5。TB_EMAIL_*/TB_PASS_* がある人だけ)、人ごとのカードで日付順に混ぜる
//   → §11.2 の形に整形して reply で返信(都の予約の行だけ「キャンセル」ボタン。§12)
//
//   一覧カードの「キャンセル」(postback) → 署名・期限を検証 → 確認カードを reply(サイトへは行かない)
//   確認カードの「はい」(postback)       → 署名・期限を検証 → その人でログイン → 一覧から予約番号で行を探し
//                                         日付・時刻・公園を照合 → 取消 POST(1回だけ)→ 結果を reply
//   空き通知の「<呼び名>で予約」(postback, data='book|<署名トークン>') → 自宅 PC の /book を叩いて予約フローを開始
//                                         → 「受け付けました」を reply(ブラウザは開かない。結果は PC が LINE にカードで push)
//   Cron(1 時間ごと)                    → 自宅 PC の生存確認。止まっていたら LINE に 1 回知らせ、復帰も知らせる(src/monitor.js)
//   Cron(毎月 1 日 9:00 JST)             → 手動メンテ(ブラウザのイメージ再ビルド)のお知らせを LINE に
//   Cron(毎日 9:00 と 23:35 JST)         → 今日 23:59 までにキャンセルしないとペナルティ対象になる予約を
//                                         キャンセルボタン付きのカードで知らせる(フェーズ4。src/penalty-alert.js)
//   フェーズ7(src/card.js): 「うけつけ」→ 受付で見せる利用者カードの画像を人数分だけ返す(文章は添えない)。
//                          画像は KV に入れたスクショを GET /card/<A|B>.png?s=<署名> で返す。予約サイトには行かない
//   フェーズ3(src/auto.js): 「じどう」→ 自動予約の除外日・除外枠のカード。その「解除」「日を追加」(postback 'x|…')。
//                          /auto/state /auto/heartbeat /auto/exclusions(Pi・Actions からの署名付き API)。
//                          キャンセル成功時にその枠を除外枠として KV に記録する(LINE の返信より先に)
//
// 必要な Secrets(`wrangler secret put`。値はコードや設定ファイルに書かない):
//   LINE_CHANNEL_SECRET        Webhook署名の検証用
//   LINE_CHANNEL_ACCESS_TOKEN  reply送信用
//   LINE_GROUP_ID              受け付けるグループのID(C〜)
//   SITE_USER_A / SITE_PASS_A / LABEL_A   Aの利用者番号・パスワード・表示名
//   SITE_USER_B / SITE_PASS_B / LABEL_B   Bの同上(未登録なら A だけで動く)
//   TB_EMAIL_A / TB_PASS_A                 A のテニスベアのメールアドレス・パスワード(フェーズ5。未登録なら黙って飛ばす)
//   TB_EMAIL_B / TB_PASS_B                 B の同上
//   BOOKING_SIGNING_SECRET     「予約」ボタン(フェーズ2)・「キャンセル」ボタン(フェーズ1.6)・利用者カードの画像URL(フェーズ7)の署名鍵。KV BOOKING_KV も必要(wrangler.toml)
// 設定(wrangler.toml [vars]):
//   CANCEL_ENABLED             "1" のときキャンセルボタンを出し、postback を受け付ける
//
// 方針:
//   - LINE には即座に 200 を返す(署名不一致だけ 401)。取得と返信は ctx.waitUntil() で応答後に続ける。
//     LINE は Webhook の応答を長く待ってくれず、応答前に処理していると接続を切られて
//     Worker ごと打ち切られる(実測: 予約サイトの取得に約20秒かかりキャンセルされた)ため
//   - waitUntil で応答後に処理できるのは Cloudflare の仕様で最長30秒。予約サイトは1通信 1〜4.5秒と
//     遅いので、取得は 25秒で打ち切り、再試行は開始10秒以内の失敗のみ、ログアウトは返信後に回す
//   - 取消の POST は絶対に再試行しない(成否不明のまま2回送らない)
//   - テニスベアは都と並行で取り、12 秒で打ち切る。失敗しても都の予約は普通に返し、カード末尾に 1 行だけ知らせる(§15.2)
//   - テニスベアの行にキャンセル用の署名を付けてはならない。署名(attachCancelData)は都の一覧だけに済ませてから合流する
//   - ログに利用者番号・パスワード・トークン・Cookie・グループID・表示名・予約番号は出さない
//   - このファイル(エントリポイント)から export してよいのは default と「関数」だけ。
//     文字列やオブジェクトの定数を export すると workerd がそれを別 Worker の入口とみなし、
//     `npm run dev` が "not of type 'function or ExportedHandler'" で起動しなくなる
//     (deploy は通ってしまうので気づきにくい)。定数は src/messages.js などに置く
// ============================================================
import { verifySignature, pickCommandEvents, pickTextCommandEvents, pickPostbackEvents, replyText, replyMessages } from './line.js';
import { fetchReservations, cancelReservation, AuthError } from './site.js';
import { fetchTennisbearEvents, TennisbearAuthError } from './tennisbear.js';
import { formatReply, MSG_FETCH_FAILED, MSG_NO_RESERVATIONS, jstTodayIso } from './format.js';
import { buildReservationFlex, buildCancelConfirmFlex, buildCancelResultFlex, isPast, jstNowHHMM } from './flex.js';
import { signCancelToken, verifyCancelToken, penaltyApplies } from './cancel-token.js';
import { attachWeather } from './weather.js';
import { handleBooking, startBooking, BOOK_POSTBACK_PREFIX, MSG_BOOK, bookSlotText } from './booking.js';
import { runMonitor, sendMaintenanceReminder, MAINTENANCE_CRON } from './monitor.js';
import { handleAuto, addExcludedSlots, buildAutoSettingsReply, handleAutoPostback, handleAutoSwitchCommand, handleNotifySwitchCommand, AUTO_COMMAND_TEXT, AUTO_ON_TEXT, AUTO_OFF_TEXT, NOTIFY_ON_TEXT, NOTIFY_OFF_TEXT, AUTO_POSTBACK_PREFIX } from './auto.js';
import { runPenaltyAlert, PENALTY_ALERT_CRONS, DEADLINE_CRON, endOfJstDaySec, DEFAULT_PENALTY_DAYS } from './penalty-alert.js';
import { CARD_COMMAND_TEXT, buildCardReply, handleCardImage, MSG_CARD_FAILED } from './card.js';
import { MSG_CANCEL_EXPIRED, MSG_CANCEL_NOT_FOUND, MSG_CANCEL_MISMATCH, MSG_CANCEL_DECLINED, MSG_CANCEL_DISABLED, MSG_AUTO_UNAVAILABLE } from './messages.js';

// 予約サイトからの取得全体の上限(waitUntil の30秒枠に返信の時間を残す)
const FETCH_BUDGET_MS = 25000;
// これより後に失敗した場合は再試行せず諦める(再試行しても30秒枠に収まらないため)
const RETRY_UNTIL_MS = 10000;
// テニスベアの取得全体の上限(都より短く。遅れても都の予約は返す)
const TB_BUDGET_MS = 12000;
// キャンセルボタン(kind='c')と「はい」(kind='y')の有効期限
const CANCEL_BUTTON_TTL_SEC = 60 * 60;
const CANCEL_CONFIRM_TTL_SEC = 10 * 60;
// 「いいえ」の postback data(署名不要)
const POSTBACK_NO = 'n';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 生存確認
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('ok', { status: 200 });
    }

    if (request.method === 'POST' && url.pathname === '/webhook') {
      return handleWebhook(request, env, ctx);
    }

    // フェーズ7 利用者カードのバーコード画像(LINE の Flex から参照される。署名付き)。src/card.js
    const card = await handleCardImage(request, env);
    if (card) return card;

    // フェーズ3 自動予約の API(/auto/*。Pi と Actions から署名付きで)。src/auto.js
    const auto = await handleAuto(request, env, ctx);
    if (auto) return auto;

    // フェーズ2 予約支援の玄関(/book の転送、自宅 PC の URL 登録、/warmup)。src/booking.js
    const booking = await handleBooking(request, env, ctx);
    if (booking) return booking;

    return new Response('not found', { status: 404 });
  },

  // Cron Trigger(wrangler.toml [triggers])。自宅 PC の生存監視
  async scheduled(event, env, ctx) {
    if (!env.BOOKING_KV || !env.LINE_CHANNEL_ACCESS_TOKEN || !env.LINE_GROUP_ID) {
      console.error('[monitor] BOOKING_KV / LINE_CHANNEL_ACCESS_TOKEN / LINE_GROUP_ID が未設定です');
      return;
    }
    if (event.cron === MAINTENANCE_CRON) {
      ctx.waitUntil(sendMaintenanceReminder(env).catch((e) => console.error(`[monitor] お知らせの送信に失敗: ${e.message}`)));
      return;
    }
    // フェーズ4: 今日 23:59 までにキャンセルしないとペナルティ対象になる予約を知らせる(朝 9:00 と 23:35)
    if (PENALTY_ALERT_CRONS.includes(event.cron)) {
      ctx.waitUntil(
        runPenaltyAlert(env, {
          kind: event.cron === DEADLINE_CRON ? 'deadline' : 'morning',
          fetchResults: () => fetchAllReservations(env),
          attach: (results, opts) => attachCancelData(env, results, opts),
        }).catch((e) => console.error(`[alert] 送信に失敗: ${e.message}`))
      );
      return;
    }
    ctx.waitUntil(runMonitor(env).catch((e) => console.error(`[monitor] 失敗: ${e.message}`)));
  },
};

const cancelEnabled = (env) => env.CANCEL_ENABLED === '1' && !!env.BOOKING_SIGNING_SECRET;

async function handleWebhook(request, env, ctx) {
  if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN || !env.LINE_GROUP_ID) {
    console.error('Secrets(LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN / LINE_GROUP_ID)が未設定です');
    return new Response('server misconfigured', { status: 500 });
  }

  // 署名検証は「生の本文」で行う必要があるため、JSONに解釈する前に文字列で読む
  const rawBody = await request.text();
  const ok = await verifySignature(env.LINE_CHANNEL_SECRET, rawBody, request.headers.get('x-line-signature'));
  if (!ok) {
    console.warn('署名不一致のリクエストを拒否しました');
    return new Response('invalid signature', { status: 401 });
  }

  const targets = pickCommandEvents(rawBody, env.LINE_GROUP_ID);
  const autoCommands = pickTextCommandEvents(rawBody, env.LINE_GROUP_ID, [AUTO_COMMAND_TEXT, AUTO_ON_TEXT, AUTO_OFF_TEXT, NOTIFY_ON_TEXT, NOTIFY_OFF_TEXT]);
  const cardCommands = pickTextCommandEvents(rawBody, env.LINE_GROUP_ID, [CARD_COMMAND_TEXT]);
  const postbacks = pickPostbackEvents(rawBody, env.LINE_GROUP_ID);
  console.log(`webhook受信: 対象イベント ${targets.length}件, じどう ${autoCommands.length}件, うけつけ ${cardCommands.length}件, postback ${postbacks.length}件`);

  // 取得と返信は応答後に続ける(即座に200を返さないとLINE側に切られる)
  for (const ev of targets) {
    ctx.waitUntil(replyReservations(env, ev.replyToken));
  }
  for (const ev of autoCommands) {
    ctx.waitUntil(replyAutoSettings(env, ev.replyToken, ev.message.text.trim()));
  }
  // フェーズ7: バーコード画像の URL に自分自身の origin が必要なので、Webhook を受けた URL から取る
  for (const ev of cardCommands) {
    ctx.waitUntil(replyUserCard(env, ev.replyToken, new URL(request.url).origin));
  }
  for (const ev of postbacks) {
    ctx.waitUntil(handlePostback(env, ev.replyToken, ev.postback.data, ev.postback.params));
  }

  return new Response('ok', { status: 200 });
}

// Flex(1 件)またはメッセージの配列を reply し、形式不備(400)ならテキスト版で再送する。
// それ以外(401等)は再送しても無駄なので投げる
async function replyFlexOrText(env, replyToken, message, fallbackText) {
  try {
    await replyMessages(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, Array.isArray(message) ? message : [message]);
  } catch (e) {
    if (e.status !== 400) throw e;
    console.error(`返信が400のためテキストで再送: ${e.message}`);
    await replyText(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, fallbackText);
  }
}

// 予約一覧を取得して reply する(waitUntil 内で実行。例外は全て握ってログに出す)
async function replyReservations(env, replyToken) {
  const started = Date.now();
  const logouts = [];
  let reply;
  try {
    reply = await buildReservationReply(env, { deferLogout: (fn) => logouts.push(fn) });
  } catch (e) {
    console.error(`予約一覧の作成に失敗: ${e.message}`);
    reply = { text: MSG_FETCH_FAILED };
  }
  try {
    if (reply.flex) await replyFlexOrText(env, replyToken, reply.flex, reply.text);
    else await replyText(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, reply.text);
    console.log(`返信しました (${Date.now() - started}ms)`);
  } catch (e) {
    console.error(`返信に失敗 (${Date.now() - started}ms): ${e.message}`);
  }
  // 返信を優先し、予約サイトからのログアウトは最後に行う(30秒枠を超えたら打ち切られても構わない)
  await Promise.allSettled(logouts.map((fn) => fn()));
}

// フェーズ7: 利用者カードを reply する。予約サイトには行かないので速い(waitUntil 内。例外は全て握ってログに出す)
async function replyUserCard(env, replyToken, origin) {
  const started = Date.now();
  let reply;
  try {
    reply = await buildCardReply(env, origin);
  } catch (e) {
    console.error(`利用者カードの作成に失敗: ${e.message}`);
    reply = { text: MSG_CARD_FAILED };
  }
  try {
    if (reply.messages) await replyFlexOrText(env, replyToken, reply.messages, reply.text);
    else await replyText(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, reply.text);
    console.log(`利用者カードを返信しました (${Date.now() - started}ms)`);
  } catch (e) {
    console.error(`利用者カードの返信に失敗 (${Date.now() - started}ms): ${e.message}`);
  }
}

// Secrets から取得対象の一覧を組む(未登録の人は飛ばす)
export function configuredPeople(env) {
  return [
    { slot: 'A', label: env.LABEL_A || 'A', userId: env.SITE_USER_A, password: env.SITE_PASS_A },
    { slot: 'B', label: env.LABEL_B || 'B', userId: env.SITE_USER_B, password: env.SITE_PASS_B },
  ].filter((p) => p.userId && p.password);
}

// テニスベアの取得対象(フェーズ5)。TB_EMAIL_*/TB_PASS_* が揃っている人だけ。都の利用者番号が無い人は「よやく」のカードが無いので対象外
export function configuredTennisbear(env) {
  return [
    { slot: 'A', email: env.TB_EMAIL_A, password: env.TB_PASS_A },
    { slot: 'B', email: env.TB_EMAIL_B, password: env.TB_PASS_B },
  ].filter((p) => p.email && p.password);
}

// 一覧の各予約に「キャンセル」ボタン用の署名付き data を付ける(終了済みの予約には付けない)
export async function attachCancelData(env, results, { today = jstTodayIso(), nowHHMM = jstNowHHMM(), now = Date.now(), exp: expOverride } = {}) {
  if (!cancelEnabled(env)) return results;
  // 既定は 60 分。フェーズ4 のアラートは「今日 23:59 まで」を渡す(0 時を過ぎるとペナルティ対象になるため)
  const exp = expOverride ?? Math.floor(now / 1000) + CANCEL_BUTTON_TTL_SEC;
  for (const p of results) {
    if (p.error) continue;
    for (const r of p.reservations) {
      if (!r.id || !r.date || !r.start || !r.end || isPast(r, today, nowHHMM)) continue;
      try {
        r.cancelData = await signCancelToken(env.BOOKING_SIGNING_SECRET, {
          kind: 'c',
          person: p.slot,
          id: r.id,
          date: r.date,
          start: r.start,
          end: r.end,
          facility: r.facility,
          penaltyDay: r.penaltyDay ?? '',
          exp,
        });
      } catch (e) {
        console.warn(`キャンセルボタンの署名に失敗(ボタン無しで続行): ${e.message}`);
      }
    }
  }
  return results;
}

// A・B の予約一覧を並行取得する。全体で FETCH_BUDGET_MS を超えたら打ち切る。
// 戻り値: [{ slot, label, reservations } | { slot, label, error }](利用者が未設定なら空配列)
export async function fetchAllReservations(env, { budgetMs = FETCH_BUDGET_MS, deferLogout } = {}) {
  const started = Date.now();
  const people = configuredPeople(env);
  if (people.length === 0) {
    console.error('SITE_USER_A / SITE_PASS_A が未設定です');
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const settled = await Promise.allSettled(
      people.map((p) =>
        fetchReservations(
          { userId: p.userId, password: p.password },
          {
            signal: controller.signal,
            log: (msg) => console.log(`[${p.slot}] ${msg}`),
            retryUntil: started + RETRY_UNTIL_MS,
            deferLogout,
          }
        )
      )
    );
    return settled.map((r, i) => {
      const p = people[i];
      if (r.status === 'fulfilled') return { slot: p.slot, label: p.label, reservations: r.value };
      const kind = r.reason instanceof AuthError ? '認証エラー' : controller.signal.aborted ? 'タイムアウト' : 'エラー';
      console.error(`[${p.slot}] 取得失敗(${kind}): ${r.reason?.message}`);
      return { slot: p.slot, label: p.label, error: r.reason };
    });
  } finally {
    clearTimeout(timer);
  }
}

// テニスベアの今後の予定を A・B ぶん並行取得する(フェーズ5)。全体で budgetMs を超えたら打ち切る。
// 戻り値: [{ slot, events } | { slot, error }](未登録の人は含めない)。例外は投げず、失敗はその人の error に入れる
export async function fetchAllTennisbear(env, { budgetMs = TB_BUDGET_MS, fetchEvents = fetchTennisbearEvents } = {}) {
  const people = configuredTennisbear(env);
  if (people.length === 0) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const settled = await Promise.allSettled(
      people.map((p) => fetchEvents({ email: p.email, password: p.password }, { signal: controller.signal, log: (msg) => console.log(`[tb:${p.slot}] ${msg}`) }))
    );
    return settled.map((r, i) => {
      const p = people[i];
      if (r.status === 'fulfilled') return { slot: p.slot, events: r.value };
      const kind = r.reason instanceof TennisbearAuthError ? '認証エラー' : controller.signal.aborted ? 'タイムアウト' : 'エラー';
      console.error(`[tb:${p.slot}] 取得失敗(${kind}): ${r.reason?.message}`);
      return { slot: p.slot, error: r.reason };
    });
  } finally {
    clearTimeout(timer);
  }
}

// 都の一覧(results)に、同じ人のテニスベアの結果を p.tennisbear として添える(§15.2)。
//   { events } なら予定あり(0 件もありうる)、{ error } なら取得失敗、登録が無い人には何も付けない。
//   都の reservations 配列には混ぜない(キャンセルの署名・フェーズ4 の対象にしないため。混ぜるのは表示側 format.js / flex.js)
export function mergeTennisbear(results, tb) {
  for (const p of results) {
    const t = tb.find((x) => x.slot === p.slot);
    if (!t) continue;
    p.tennisbear = t.error ? { error: t.error } : { events: t.events };
  }
  return results;
}

// 「よやく」への返信内容を組む。都の予約とテニスベアの予定を並行で取り、人ごとに合流する。
// 戻り値: { text }(全員失敗・全員0件はテキストのみ)または { flex, text }(Flex + 400時のテキスト版)
//   フェーズ6: 最後に天気を添える(weather.js)。取れなくても天気なしで一覧は必ず返す
//   fetchSite / fetchTb / fetchWeather はテストで差し替える
export async function buildReservationReply(
  env,
  { budgetMs = FETCH_BUDGET_MS, deferLogout, fetchSite = fetchAllReservations, fetchTb = fetchAllTennisbear, addWeather = attachWeather } = {}
) {
  const [results, tb] = await Promise.all([
    fetchSite(env, { budgetMs, deferLogout }),
    fetchTb(env).catch((e) => {
      console.error(`[tb] 取得に失敗: ${e.message}`);
      return [];
    }),
  ]);
  if (results.length === 0) return { text: MSG_FETCH_FAILED };
  // 署名は都の一覧にだけ付け、その後でテニスベアを添える(テニスベアの行にキャンセルボタンが付かないように)
  await attachCancelData(env, results);
  mergeTennisbear(results, tb);
  // 天気は「あれば嬉しい」情報。attachWeather は中で失敗を握りつぶすが、念のためここでも守る
  try {
    await addWeather(results, { today: jstTodayIso(), log: (m) => console.log(`[weather] ${m}`) });
  } catch (e) {
    console.error(`[weather] ${e.message}`);
  }
  const text = formatReply(results);
  if (text === MSG_FETCH_FAILED || text === MSG_NO_RESERVATIONS) return { text };
  return { flex: buildReservationFlex(results), text };
}

// ---- フェーズ3 「じどう」(自動予約の除外設定) ----
// command: 「じどう」(表示のみ)/「じどうおん」「じどうおふ」(自動予約の ON/OFF)/「つうちおん」「つうちおふ」(空き通知カードの ON/OFF)
async function replyAutoSettings(env, replyToken, command = AUTO_COMMAND_TEXT) {
  const started = Date.now();
  try {
    if (!env.BOOKING_SIGNING_SECRET || !env.BOOKING_KV) {
      await replyText(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, MSG_AUTO_UNAVAILABLE);
      return;
    }
    const reply =
      command === AUTO_ON_TEXT ? await handleAutoSwitchCommand(env, true)
      : command === AUTO_OFF_TEXT ? await handleAutoSwitchCommand(env, false)
      : command === NOTIFY_ON_TEXT ? await handleNotifySwitchCommand(env, true)
      : command === NOTIFY_OFF_TEXT ? await handleNotifySwitchCommand(env, false)
      : await buildAutoSettingsReply(env);
    await replyFlexOrText(env, replyToken, reply.flex, reply.text);
    console.log(`[auto] 設定カードを返信しました (${Date.now() - started}ms)`);
  } catch (e) {
    console.error(`[auto] 設定カードの返信に失敗 (${Date.now() - started}ms): ${e.message}`);
  }
}

// ---- フェーズ1.6 キャンセル ----

const slotText = (t) => `${t.person} ${t.date} ${t.start} ${t.facility}`;

// postback を処理して reply する(waitUntil 内。例外は全て握ってログに出す)
async function handlePostback(env, replyToken, data, params) {
  const started = Date.now();
  const logouts = [];
  try {
    const reply = await buildPostbackReply(env, data, { deferLogout: (fn) => logouts.push(fn), params });
    if (!reply) return; // 無視するべき postback(署名不正など)
    if (reply.flex) await replyFlexOrText(env, replyToken, reply.flex, reply.text);
    else await replyText(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, reply.text);
    console.log(`[cancel] 返信しました (${Date.now() - started}ms)`);
  } catch (e) {
    console.error(`[cancel] 処理に失敗 (${Date.now() - started}ms): ${e.message}`);
  }
  await Promise.allSettled(logouts.map((fn) => fn()));
}

// postback data から返信内容を決める。戻り値: { text } | { flex, text } | null(無視)
//   params: LINE の postback.params(日付ピッカーで選んだ日 { date })。cancel: 取消の実行関数(テストで差し替える)
export async function buildPostbackReply(env, data, { deferLogout, now = Date.now(), budgetMs = FETCH_BUDGET_MS, params = null, cancel = cancelReservation } = {}) {
  if (data === POSTBACK_NO) return { text: MSG_CANCEL_DECLINED };
  // フェーズ3 「じどう」カードのボタン(除外日の追加・解除、除外枠の解除)
  if (data.startsWith(AUTO_POSTBACK_PREFIX)) {
    if (!env.BOOKING_SIGNING_SECRET || !env.BOOKING_KV) return { text: MSG_AUTO_UNAVAILABLE };
    return handleAutoPostback(env, data, params, { now });
  }
  // 空き通知の予約ボタン(フェーズ2)。キャンセル機能の ON/OFF とは独立
  if (data.startsWith(BOOK_POSTBACK_PREFIX)) {
    if (!env.BOOKING_SIGNING_SECRET || !env.BOOKING_KV) return { text: MSG_BOOK.offline() };
    const { status, payload } = await startBooking(env, data.slice(BOOK_POSTBACK_PREFIX.length));
    const who = payload ? env[`LABEL_${payload.person}`] || payload.person || '' : '';
    console.log(`[book] ${status}${payload ? `: ${payload.date} ${payload.startHour}時 park=${payload.park}` : ''}`);
    return { text: (MSG_BOOK[status] || MSG_BOOK.error)(who, payload ? bookSlotText(payload) : '') };
  }
  if (!cancelEnabled(env)) {
    console.warn('[cancel] 停止中のため postback を無視せず案内を返します');
    return { text: MSG_CANCEL_DISABLED };
  }
  const token = await verifyCancelToken(env.BOOKING_SIGNING_SECRET, data, now);
  if (!token) {
    console.warn('[cancel] 署名不正の postback を無視しました');
    return null;
  }
  if (token.expired) {
    console.log(`[cancel] 期限切れ (${token.kind}): ${slotText(token)}`);
    return { text: MSG_CANCEL_EXPIRED };
  }
  const person = configuredPeople(env).find((p) => p.slot === token.person);
  if (!person) {
    console.error(`[cancel] ${token.person} の利用者情報が未設定です`);
    return { text: MSG_CANCEL_DISABLED };
  }
  const reservation = { id: token.id, date: token.date, start: token.start, end: token.end, facility: token.facility };

  // 1段階目: 確認カード(サイトへはアクセスしない)
  if (token.kind === 'c') {
    const today = jstTodayIso(new Date(now));
    const penalty = penaltyApplies(token.date, token.penaltyDay, today);
    // 「はい」の期限は 10 分。ただし今はペナルティ対象でなく、日付が変われば対象になる予約(= 今日 23:59 が無料の期限)は
    // 今日中で切る。0 時をまたいで「はい」を押し、知らないうちにペナルティ 1 点を負う事故を防ぐ(フェーズ4)
    const tomorrow = jstTodayIso(new Date(now + 86400000));
    const becomesPenaltyTomorrow = !penalty && penaltyApplies(token.date, token.penaltyDay ?? DEFAULT_PENALTY_DAYS, tomorrow);
    const yesData = await signCancelToken(env.BOOKING_SIGNING_SECRET, {
      ...token,
      kind: 'y',
      penaltyDay: token.penaltyDay ?? '',
      exp: Math.min(Math.floor(now / 1000) + CANCEL_CONFIRM_TTL_SEC, becomesPenaltyTomorrow ? endOfJstDaySec(now) : Infinity),
    });
    console.log(`[cancel] 確認カード: ${slotText(token)}${penalty ? ' (ペナルティ対象)' : ''}`);
    return {
      flex: buildCancelConfirmFlex(
        { label: person.label, reservation, penalty, penaltyDay: token.penaltyDay ?? 3, yesData, noData: POSTBACK_NO },
        { today }
      ),
      text: 'キャンセルの確認カードを表示できませんでした。「よやく」からやり直してください',
    };
  }

  // 2段階目: 取消を実行
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  let result;
  try {
    result = await cancel(
      { userId: person.userId, password: person.password },
      reservation,
      { signal: controller.signal, log: (msg) => console.log(`[cancel:${person.slot}] ${msg}`), retryUntil: started + RETRY_UNTIL_MS, deferLogout }
    );
  } catch (e) {
    const kind = e instanceof AuthError ? '認証エラー' : controller.signal.aborted ? 'タイムアウト' : 'エラー';
    console.error(`[cancel] 取消に失敗(${kind}): ${e.message}`);
    result = { status: 'failed' };
  } finally {
    clearTimeout(timer);
  }
  console.log(`[cancel] 結果 ${result.status}: ${slotText(token)} (${Date.now() - started}ms)`);

  if (result.status === 'not_found') return { text: MSG_CANCEL_NOT_FOUND };
  if (result.status === 'mismatch') return { text: MSG_CANCEL_MISMATCH };
  const ok = result.status === 'success';
  // フェーズ3: 人が意図して手放した枠は、空きとして再出現しても自動予約しない(除外枠)。Pi の次の照会(1 分)より先に KV へ載せるため、返信の前に書く
  if (ok && env.BOOKING_KV) {
    try {
      await addExcludedSlots(env, [{ facility: token.facility, date: token.date, start: token.start, end: token.end, reason: 'cancel' }], now);
    } catch (e) {
      console.error(`[auto] 除外枠の登録に失敗(取消自体は成功): ${e.message}`);
    }
  }
  const nowText = `${jstTodayIso(new Date()).slice(5).replace(/^0/, '').replace('-0', '/').replace('-', '/')} ${jstNowHHMM()}`;
  return {
    flex: buildCancelResultFlex({ ok, label: person.label, reservation, nowText }),
    text: ok
      ? `キャンセルしました: ${person.label} ${token.date} ${token.start}-${token.end} ${token.facility}`
      : 'キャンセルできませんでした。予約サイトで状態を確認してください',
  };
}
