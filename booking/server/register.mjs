// ============================================================
// 自宅 PC 用: Cloudflare Tunnel(quick tunnel)の現在の URL を、玄関の Worker に定期的に登録する。
// docker compose の registrar サービスとして、予約サーバーと同じイメージで動く(booking/pc/docker-compose.yml)。
//
//   環境変数:
//     WORKER_URL              玄関の Worker(例: https://tennis-reservation-bot.y-ykym.workers.dev)
//     BOOKING_SIGNING_SECRET  署名鍵(Worker と同じ値)。登録の認証にも使う: x-booking-auth = base64url(HMAC-SHA256(secret, url))
//     TUNNEL_METRICS_URL      cloudflared の metrics(例: http://tunnel:2000)。/quicktunnel が {"hostname": "..."} を返す
//     REGISTER_INTERVAL_MS    登録間隔(既定 240000 = 4分。Worker 側の TTL は 10 分)
//
// PC が落ちると登録が止まり、Worker 側の TTL で自然に消える(「繋がりません」案内に切り替わる)。
// ============================================================
import { createHmac } from 'node:crypto';

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '');
const SECRET = process.env.BOOKING_SIGNING_SECRET || '';
const METRICS = (process.env.TUNNEL_METRICS_URL || 'http://tunnel:2000').replace(/\/$/, '');
const INTERVAL = Number(process.env.REGISTER_INTERVAL_MS || 240000);

const log = (m) => console.log(`[${new Date().toISOString()}] [register] ${m}`);

if (!WORKER_URL || !SECRET) {
  console.error('WORKER_URL と BOOKING_SIGNING_SECRET を設定してください');
  process.exit(1);
}

async function currentTunnelUrl() {
  const res = await fetch(`${METRICS}/quicktunnel`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`metrics HTTP ${res.status}`);
  const { hostname } = await res.json();
  if (!hostname) throw new Error('hostname が未確定');
  return `https://${hostname}`;
}

async function register(url) {
  const auth = createHmac('sha256', SECRET).update(url).digest('base64url');
  const res = await fetch(`${WORKER_URL}/booking/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-booking-auth': auth },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status !== 204) throw new Error(`Worker HTTP ${res.status} ${await res.text()}`);
}

let lastUrl = null;
let retryTimer = null;
async function tick() {
  try {
    const url = await currentTunnelUrl();
    await register(url);
    if (url !== lastUrl) log(`登録しました: ${new URL(url).hostname}`);
    lastUrl = url;
  } catch (e) {
    // 起動直後はトンネルの URL 確定前で失敗しがちなので、失敗したら 15 秒後に早めにやり直す
    log(`登録に失敗(15秒後に再試行): ${e.message}`);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(tick, 15000);
  }
}

// 起動直後はトンネルの URL 確定まで少し待つ。以後は一定間隔で登録し直す
setTimeout(tick, 5000);
setInterval(tick, INTERVAL);
