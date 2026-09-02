// ============================================================
// フェーズ1.5 予約確認ボット(Cloudflare Workers)
//
//   LINEグループで「よやく」と送る → LINEがこのWorkerの POST /webhook を呼ぶ
//   → 署名を検証 → 対象グループの「よやく」だけ拾う
//   → A・B それぞれの利用者番号で予約サイトにログインして予約一覧を取得(並行)
//   → §11.2 の形に整形して reply で返信
//
// 必要な Secrets(`wrangler secret put`。値はコードや設定ファイルに書かない):
//   LINE_CHANNEL_SECRET        Webhook署名の検証用
//   LINE_CHANNEL_ACCESS_TOKEN  reply送信用
//   LINE_GROUP_ID              受け付けるグループのID(C〜)
//   SITE_USER_A / SITE_PASS_A / LABEL_A   Aの利用者番号・パスワード・表示名
//   SITE_USER_B / SITE_PASS_B / LABEL_B   Bの同上(未登録なら A だけで動く)
//
// 方針:
//   - LINE には即座に 200 を返す(署名不一致だけ 401)。取得と返信は ctx.waitUntil() で応答後に続ける。
//     LINE は Webhook の応答を長く待ってくれず、応答前に処理していると接続を切られて
//     Worker ごと打ち切られる(実測: 予約サイトの取得に約20秒かかりキャンセルされた)ため
//   - waitUntil で応答後に処理できるのは Cloudflare の仕様で最長30秒。予約サイトは1通信 1〜4.5秒と
//     遅いので、取得は 25秒で打ち切り、再試行は開始10秒以内の失敗のみ、ログアウトは返信後に回す
//   - ログに利用者番号・パスワード・トークン・Cookie・グループID・表示名は出さない
// ============================================================
import { verifySignature, pickCommandEvents, replyText, replyMessages } from './line.js';
import { fetchReservations, AuthError } from './site.js';
import { formatReply, MSG_FETCH_FAILED, MSG_NO_RESERVATIONS } from './format.js';
import { buildReservationFlex } from './flex.js';

// 予約サイトからの取得全体の上限(waitUntil の30秒枠に返信の時間を残す)
const FETCH_BUDGET_MS = 25000;
// これより後に失敗した場合は再試行せず諦める(再試行しても30秒枠に収まらないため)
const RETRY_UNTIL_MS = 10000;

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

    return new Response('not found', { status: 404 });
  },
};

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
  console.log(`webhook受信: 対象イベント ${targets.length}件`);

  // 取得と返信は応答後に続ける(即座に200を返さないとLINE側に切られる)
  for (const ev of targets) {
    ctx.waitUntil(replyReservations(env, ev.replyToken));
  }

  return new Response('ok', { status: 200 });
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
    if (reply.flex) {
      try {
        await replyMessages(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [reply.flex]);
      } catch (e) {
        // Flex の形式不備(400)ならテキスト版で再送を試みる。それ以外(401等)は再送しても無駄
        if (e.status !== 400) throw e;
        console.error(`Flex返信が400のためテキストで再送: ${e.message}`);
        await replyText(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, reply.text);
      }
    } else {
      await replyText(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, reply.text);
    }
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
      if (r.status === 'fulfilled') return { label: p.label, reservations: r.value };
      const kind = r.reason instanceof AuthError ? '認証エラー' : controller.signal.aborted ? 'タイムアウト' : 'エラー';
      console.error(`[${p.slot}] 取得失敗(${kind}): ${r.reason?.message}`);
      return { label: p.label, error: r.reason };
    });
    const text = formatReply(results);
    if (text === MSG_FETCH_FAILED || text === MSG_NO_RESERVATIONS) return { text };
    return { flex: buildReservationFlex(results), text };
  } finally {
    clearTimeout(timer);
  }
}
