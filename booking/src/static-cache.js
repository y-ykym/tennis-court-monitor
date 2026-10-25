// ============================================================
// 都サイトの JS(/web/js/*.js)の控え(2026-10-25)
//
// サイトはこれらに「キャッシュ禁止(no-store)」を付けて配るため、ブラウザは予約のたびに同じ JS 8 本を取り直す。
// 1 本 13 KB 程度でも 1 本 4〜8 秒かかる(サーバーの応答待ち。同じホストへは同時 6 本まで)ので、確認画面の表示が 10 秒以上遅れていた。
// ここで控えを持ち、ブラウザの要求には控えを差し込む(reserve.js の route)。無ければ取って控える。
// 控えは 24 時間で古いとみなし、裏で 1 本ずつ取り直す(予約の最中に取り直しが当たらないように)。
// サイトが JS を更新した直後は最大 24 時間、古い JS で動く可能性がある。予約が失敗し続けたら STATIC_CACHE=0 で止めるか、控えの置き場を消す。
//
//   const cache = createStaticCache({ dir, maxAgeMs, log, fetchImpl, now, timers })
//     dir        控えを置く場所(無ければメモリだけ。コンテナを作り直すと消える)
//   cache.isCacheable(url, resourceType)  控える対象か(都サイトの /web/js/*.js の script だけ。CSS は高速経路では読まないので控えない。本人決定 2026-10-25)
//   cache.get(url)   → { body: Buffer, contentType, fetchedAt } | null(古くても返す。取り直しは裏で)
//   cache.put(url, body, contentType, etag)
//   cache.start() / stop()   古い控えを取り直す定期処理(10 分おきに見る)
//   cache.stats()   { entries, hits, misses, refreshed }
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE_URL = 'https://kouen.sports.metro.tokyo.lg.jp';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function createStaticCache({
  dir = null,
  maxAgeMs = 24 * 60 * 60 * 1000,
  checkEveryMs = 10 * 60 * 1000,
  log = () => {},
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timers = { setInterval, clearInterval },
} = {}) {
  const entries = new Map(); // url → { body, contentType, etag, fetchedAt }
  const stats = { hits: 0, misses: 0, refreshed: 0 };
  let timer = null;
  let refreshing = false;

  const fileOf = (url) => path.join(dir, crypto.createHash('sha1').update(url).digest('hex'));
  const indexFile = () => path.join(dir, 'index.json');

  function load() {
    if (!dir) return;
    try {
      if (!fs.existsSync(indexFile())) return;
      const index = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
      for (const [url, meta] of Object.entries(index)) {
        try {
          entries.set(url, { ...meta, body: fs.readFileSync(fileOf(url)) });
        } catch {
          /* 本体が無ければ控えなし扱い */
        }
      }
      if (entries.size) log(`静的ファイルの控えを読み込みました: ${entries.size} 件`);
    } catch (e) {
      log(`静的ファイルの控えを読めませんでした(無視): ${e.message}`);
    }
  }
  function save() {
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const index = {};
      for (const [url, e] of entries) {
        index[url] = { contentType: e.contentType, etag: e.etag, fetchedAt: e.fetchedAt };
        fs.writeFileSync(fileOf(url), e.body);
      }
      fs.writeFileSync(indexFile(), JSON.stringify(index));
    } catch (e) {
      log(`静的ファイルの控えを保存できませんでした(無視): ${e.message}`);
    }
  }

  function isCacheable(url, resourceType) {
    if (!url.startsWith(BASE_URL + '/web/')) return false;
    const p = url.slice(BASE_URL.length).split('?')[0];
    return resourceType === 'script' && p.startsWith('/web/js/') && p.endsWith('.js');
  }
  function get(url) {
    const e = entries.get(url);
    if (e) stats.hits++;
    else stats.misses++;
    return e || null;
  }
  function put(url, body, contentType, etag = null) {
    entries.set(url, { body: Buffer.from(body), contentType: contentType || guessType(url), etag, fetchedAt: now() });
    save();
  }
  const guessType = () => 'application/javascript';

  // 古い控えを 1 本ずつ取り直す(ETag が同じなら本体は取らない)
  async function refreshStale() {
    if (refreshing) return 0;
    refreshing = true;
    let n = 0;
    try {
      for (const [url, e] of [...entries]) {
        if (now() - e.fetchedAt < maxAgeMs) continue;
        try {
          const headers = { 'user-agent': USER_AGENT };
          if (e.etag) headers['if-none-match'] = e.etag;
          const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(60000) });
          if (res.status === 304) {
            e.fetchedAt = now();
          } else if (res.ok) {
            entries.set(url, { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || e.contentType, etag: res.headers.get('etag'), fetchedAt: now() });
            n++;
          } else {
            log(`静的ファイルの取り直しに失敗(控えはそのまま): HTTP ${res.status} ${url}`);
          }
        } catch (err) {
          log(`静的ファイルの取り直しに失敗(控えはそのまま): ${err.message.split('\n')[0]} ${url}`);
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      if (n) {
        stats.refreshed += n;
        save();
        log(`静的ファイルの控えを取り直しました: ${n} 件`);
      }
    } finally {
      refreshing = false;
    }
    return n;
  }

  function start() {
    load();
    if (!timer) timer = timers.setInterval(() => refreshStale().catch(() => {}), checkEveryMs);
  }
  function stop() {
    if (timer) timers.clearInterval(timer);
    timer = null;
  }

  return { isCacheable, get, put, refreshStale, start, stop, stats: () => ({ entries: entries.size, ...stats }) };
}
