// ============================================================
// フェーズ1.5 予約確認ボット + フェーズ1.6 予約キャンセル(Cloudflare Workers)
//
//   LINEグループで「よやく」と送る → LINEがこのWorkerの POST /webhook を呼ぶ
//   → 署名を検証 → 対象グループの「よやく」だけ拾う
//   → A・B それぞれの利用者番号で予約サイトにログインして予約一覧を取得(並行)
//   → §11.2 の形に整形して reply で返信(各行に「キャンセル」ボタン。§12)
//
//   一覧カードの「キャンセル」(postback) → 署名・期限を検証 → 確認カードを reply(サイトへは行かない)
//   確認カードの「はい」(postback)       → 署名・期限を検証 → その人でログイン → 一覧から予約番号で行を探し
//                                         日付・時刻・公園を照合 → 取消 POST(1回だけ)→ 結果を reply
//
// 必要な Secrets(`wrangler secret put`。値はコードや設定ファイルに書かない):
//   LINE_CHANNEL_SECRET        Webhook署名の検証用
//   LINE_CHANNEL_ACCESS_TOKEN  reply送信用
//   LINE_GROUP_ID              受け付けるグループのID(C〜)
//   SITE_USER_A / SITE_PASS_A / LABEL_A   Aの利用者番号・パスワード・表示名
//   SITE_USER_B / SITE_PASS_B / LABEL_B   Bの同上(未登録なら A だけで動く)
//   BOOKING_SIGNING_SECRET     「予約」ボタン(フェーズ2)と「キャンセル」ボタン(フェーズ1.6)の署名鍵。KV BOOKING_KV も必要(wrangler.toml)
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
//   - ログに利用者番号・パスワード・トークン・Cookie・グループID・表示名・予約番号は出さない
// ============================================================
import { verifySignature, pickCommandEvents, pickPostbackEvents, replyText, replyMessages } from './line.js';
import { fetchReservations, cancelReservation, AuthError } from './site.js';
import { formatReply, MSG_FETCH_FAILED, MSG_NO_RESERVATIONS, jstTodayIso } from './format.js';
import { buildReservationFlex, buildCancelConfirmFlex, buildCancelResultFlex, isPast, jstNowHHMM } from './flex.js';
import { signCancelToken, verifyCancelToken, penaltyApplies } from './cancel-token.js';
import { handleBooking } from './booking.js';

// 予約サイトからの取得全体の上限(waitUntil の30秒枠に返信の時間を残す)
const FETCH_BUDGET_MS = 25000;
// これより後に失敗した場合は再試行せず諦める(再試行しても30秒枠に収まらないため)
const RETRY_UNTIL_MS = 10000;
// キャンセルボタン(kind='c')と「はい」(kind='y')の有効期限
const CANCEL_BUTTON_TTL_SEC = 60 * 60;
const CANCEL_CONFIRM_TTL_SEC = 10 * 60;
// 「いいえ」の postback data(署名不要)
const POSTBACK_NO = 'n';

export const MSG_CANCEL_EXPIRED = '時間切れです。「よやく」からやり直してください';
export const MSG_CANCEL_NOT_FOUND = 'この予約は見つかりませんでした(既にキャンセル済みの可能性があります)。「よやく」で確認してください';
export const MSG_CANCEL_MISMATCH = '予約の内容が一覧と一致しないため中止しました。「よやく」で確認してください';
export const MSG_CANCEL_DECLINED = 'キャンセルしませんでした';
export const MSG_CANCEL_DISABLED = 'キャンセル機能は現在停止しています。予約サイトから操作してください';

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

    // フェーズ2 予約支援の玄関(/book の転送、自宅 PC の URL 登録、/warmup)。src/booking.js
    const booking = await handleBooking(request, env, ctx);
    if (booking) return booking;

    return new Response('not found', { status: 404 });
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
  const postbacks = pickPostbackEvents(rawBody, env.LINE_GROUP_ID);
  console.log(`webhook受信: 対象イベント ${targets.length}件, postback ${postbacks.length}件`);

  // 取得と返信は応答後に続ける(即座に200を返さないとLINE側に切られる)
  for (const ev of targets) {
    ctx.waitUntil(replyReservations(env, ev.replyToken));
  }
  for (const ev of postbacks) {
    ctx.waitUntil(handlePostback(env, ev.replyToken, ev.postback.data));
  }

  return new Response('ok', { status: 200 });
}

// Flex を reply し、形式不備(400)ならテキスト版で再送する。それ以外(401等)は再送しても無駄なので投げる
async function replyFlexOrText(env, replyToken, flex, fallbackText) {
  try {
    await replyMessages(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [flex]);
  } catch (e) {
    if (e.status !== 400) throw e;
    console.error(`Flex返信が400のためテキストで再送: ${e.message}`);
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

// Secrets から取得対象の一覧を組む(未登録の人は飛ばす)
export function configuredPeople(env) {
  return [
    { slot: 'A', label: env.LABEL_A || 'A', userId: env.SITE_USER_A, password: env.SITE_PASS_A },
    { slot: 'B', label: env.LABEL_B || 'B', userId: env.SITE_USER_B, password: env.SITE_PASS_B },
  ].filter((p) => p.userId && p.password);
}

// 一覧の各予約に「キャンセル」ボタン用の署名付き data を付ける(終了済みの予約には付けない)
export async function attachCancelData(env, results, { today = jstTodayIso(), nowHHMM = jstNowHHMM(), now = Date.now() } = {}) {
  if (!cancelEnabled(env)) return results;
  const exp = Math.floor(now / 1000) + CANCEL_BUTTON_TTL_SEC;
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

// A・B を並行取得して返信内容にする。全体で FETCH_BUDGET_MS を超えたら打ち切る。
// 戻り値: { text }(全員失敗・全員0件はテキストのみ)または { flex, text }(Flex + 400時のテキスト版)
export async function buildReservationReply(env, { budgetMs = FETCH_BUDGET_MS, deferLogout } = {}) {
  const started = Date.now();
  const people = configuredPeople(env);
  if (people.length === 0) {
    console.error('SITE_USER_A / SITE_PASS_A が未設定です');
    return { text: MSG_FETCH_FAILED };
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
    const results = settled.map((r, i) => {
      const p = people[i];
      if (r.status === 'fulfilled') return { slot: p.slot, label: p.label, reservations: r.value };
      const kind = r.reason instanceof AuthError ? '認証エラー' : controller.signal.aborted ? 'タイムアウト' : 'エラー';
      console.error(`[${p.slot}] 取得失敗(${kind}): ${r.reason?.message}`);
      return { slot: p.slot, label: p.label, error: r.reason };
    });
    const text = formatReply(results);
    if (text === MSG_FETCH_FAILED || text === MSG_NO_RESERVATIONS) return { text };
    await attachCancelData(env, results);
    return { flex: buildReservationFlex(results), text };
  } finally {
    clearTimeout(timer);
  }
}

// ---- フェーズ1.6 キャンセル ----

const slotText = (t) => `${t.person} ${t.date} ${t.start} ${t.facility}`;

// postback を処理して reply する(waitUntil 内。例外は全て握ってログに出す)
async function handlePostback(env, replyToken, data) {
  const started = Date.now();
  const logouts = [];
  try {
    const reply = await buildPostbackReply(env, data, { deferLogout: (fn) => logouts.push(fn) });
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
export async function buildPostbackReply(env, data, { deferLogout, now = Date.now(), budgetMs = FETCH_BUDGET_MS } = {}) {
  if (data === POSTBACK_NO) return { text: MSG_CANCEL_DECLINED };
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
    const yesData = await signCancelToken(env.BOOKING_SIGNING_SECRET, {
      ...token,
      kind: 'y',
      penaltyDay: token.penaltyDay ?? '',
      exp: Math.floor(now / 1000) + CANCEL_CONFIRM_TTL_SEC,
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
    result = await cancelReservation(
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
  const nowText = `${jstTodayIso(new Date()).slice(5).replace(/^0/, '').replace('-0', '/').replace('-', '/')} ${jstNowHHMM()}`;
  return {
    flex: buildCancelResultFlex({ ok, label: person.label, reservation, nowText }),
    text: ok
      ? `キャンセルしました: ${person.label} ${token.date} ${token.start}-${token.end} ${token.facility}`
      : 'キャンセルできませんでした。予約サイトで状態を確認してください',
  };
}
