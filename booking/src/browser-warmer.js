// ============================================================
// 予約に使うブラウザを先に起こし、トップページまで開いて待たせておく(「枠が出てから予約を押すまで」の短縮。2026-10-25)
//
//   const warmer = createBrowserWarmer({ launch, topUrl, prefetch, log, refreshMs, maxAgeMs, retryMs, now, timers })
//     launch     async () => bundle   reserve.js の launchBrowserForReserve(...) を呼ぶ関数。bundle = { page, context, setPhase, close, ... }
//     topUrl     先に開いておくページ(都サイトのトップ)
//     prefetch   async (bundle) => any  トップを開いた後に呼ぶ(省略可)。返り値を bundle.prefetched に入れる(ログイン画面と検索の先取り。
//                src/site-inpage.js の prefetchInPage)。失敗(例外か { ok: false })なら bundle.prefetched = null のまま使う
//     refreshMs  トップを読み直す間隔(既定 8 分。都サイトのセッションは放置 10 分で切れる。docs/site-notes.md)
//     maxAgeMs   これより古いトップは「新しい」とみなさない(既定 9 分。reserve.js 側の判定と同じ)
//     retryMs    起動や読み込みに失敗したあと次に試すまで(既定 1 分)
//     now / timers  テスト用の差し替え(Date.now / { setTimeout, clearTimeout })
//
//   warmer.start()     起こし始める(非同期。失敗しても retryMs 後にやり直す)
//   warmer.acquire()   → Promise<bundle | null>。使える bundle を 1 つ渡して手放す(以後は呼び出し側が閉じる。reserve() は finally で閉じる)。
//                      起動や読み直しの途中なら、終わるのを待ってから渡す(同じプロファイルで 2 つ目の Chromium を起こすと
//                      「使用中」で失敗するため、待たずに別のブラウザを起こしてはいけない)。使えなければ閉じてから null
//   warmer.stop()      止めて閉じる
//   warmer.status()    { state: 'idle'|'launching'|'ready'|'refreshing'|'handed'|'stopped', topLoadedAt, launched, failures }
//
// 手放した bundle のコンテキストが閉じられたら(reserve() が終わった合図)、少し置いて次を起こす。
// 予約の行列は直列なので、同時に使われる bundle は常に 1 つ。
// ============================================================

export function createBrowserWarmer({
  launch,
  topUrl,
  prefetch = null,
  log = () => {},
  refreshMs = 8 * 60 * 1000,
  maxAgeMs = 9 * 60 * 1000,
  retryMs = 60 * 1000,
  relaunchDelayMs = 2000,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
} = {}) {
  let state = 'idle';
  let bundle = null; // 今持っている(まだ渡していない)ブラウザ
  let handed = null; // 渡してまだ閉じられていないブラウザ(予約の実行中)
  let inflight = null; // 起動または読み直しの Promise(acquire はこれを待つ)
  let timer = null;
  let launched = 0;
  let failures = 0;
  let stopped = false;

  const clearTimer = () => {
    if (timer) timers.clearTimeout(timer);
    timer = null;
  };
  const schedule = (fn, ms) => {
    clearTimer();
    timer = timers.setTimeout(fn, ms);
  };

  async function loadTop(b) {
    b.setPhase('top');
    await b.page.goto(topUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!(await b.page.$('[onclick*="gRsvWTransUserLoginAction"]'))) throw new Error('トップページにログインボタンがありません(メンテナンス中の可能性)');
    b.topLoadedAt = now();
    b.prefetched = null;
    if (prefetch) {
      try {
        const r = await prefetch(b);
        if (r && r.ok !== false) b.prefetched = r;
        else log(`先取りできませんでした(予約時に取り直します): ${(r && r.message) || '不明'}`);
      } catch (e) {
        log(`先取りに失敗(予約時に取り直します): ${e.message.split('\n')[0]}`);
      }
    }
  }
  const prefetchSummary = (b) => (b.prefetched ? `、先取り: ログイン画面${b.prefetched.loginFields ? 'あり' : 'なし'}・検索${b.prefetched.search ? b.prefetched.search.park : 'なし'}` : '');

  async function discard(b, why) {
    if (!b) return;
    try {
      await b.close();
    } catch {
      /* 閉じられなくても次に進む */
    }
    if (why) log(`先に起こしたブラウザを閉じました: ${why}`);
  }

  // 起動してトップまで開く。失敗したら閉じて retryMs 後にやり直す
  function prepare() {
    if (stopped || inflight || bundle) return inflight || Promise.resolve();
    state = 'launching';
    const started = now();
    inflight = (async () => {
      let b = null;
      try {
        b = await launch();
        launched++;
        await loadTop(b);
        if (stopped) {
          await discard(b);
          return;
        }
        bundle = b;
        state = 'ready';
        failures = 0;
        log(`先に起こしました(${Math.round((now() - started) / 1000)} 秒。${launched} 回目${prefetchSummary(b)})`);
        schedule(refresh, refreshMs);
      } catch (e) {
        failures++;
        await discard(b);
        state = 'idle';
        log(`先に起こせませんでした(${failures} 回目): ${e.message.split('\n')[0]}。${Math.round(retryMs / 1000)} 秒後にやり直します`);
        if (!stopped) schedule(prepare, retryMs);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  // トップページを読み直してセッションを保つ。失敗したら閉じて起こし直す
  function refresh() {
    if (stopped || !bundle || inflight) return inflight || Promise.resolve();
    state = 'refreshing';
    const b = bundle;
    inflight = (async () => {
      try {
        if (b.page.isClosed()) throw new Error('ページが閉じられていました');
        await loadTop(b);
        state = 'ready';
        schedule(refresh, refreshMs);
      } catch (e) {
        failures++;
        bundle = null;
        await discard(b, `トップページを読み直せませんでした: ${e.message.split('\n')[0]}`);
        state = 'idle';
        if (!stopped) schedule(prepare, retryMs);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function acquire() {
    if (stopped) return null;
    if (inflight) await inflight; // 起動・読み直しの途中なら終わるまで待つ(別のブラウザを起こしてはいけない)
    if (handed && !handed.page.isClosed()) {
      // 予約の行列は直列なのでここには来ないはず。来ても 2 つ目は起こさない(同じプロファイルは 1 つしか開けない)
      log('先に起こしたブラウザはまだ使用中のため渡せません');
      return null;
    }
    let b = bundle;
    if (!b) {
      // 何も無い(前の予約が終わった直後で次を起こす前など)なら、ここで起こして待つ。
      // 予約の開始は数秒遅れるが、呼び出し側が別のブラウザを起こして「使用中」でぶつかるより安全
      clearTimer();
      await prepare();
      b = bundle;
      if (!b) return null;
    }
    bundle = null;
    clearTimer();
    if (b.page.isClosed() || !b.topLoadedAt || now() - b.topLoadedAt > maxAgeMs) {
      await discard(b, 'ページが閉じられていたか、トップページが古すぎた');
      state = 'idle';
      schedule(prepare, relaunchDelayMs);
      return null;
    }
    state = 'handed';
    handed = b;
    // 使い終わって閉じられたら次を起こす(reserve() は finally で context を閉じる)
    b.context.once('close', () => {
      if (handed === b) handed = null;
      if (stopped) return;
      state = 'idle';
      schedule(prepare, relaunchDelayMs);
    });
    return b;
  }

  function start() {
    stopped = false;
    prepare();
  }

  async function stop() {
    stopped = true;
    clearTimer();
    if (inflight) await inflight.catch(() => {});
    const b = bundle;
    bundle = null;
    await discard(b);
    state = 'stopped';
  }

  return { start, acquire, stop, status: () => ({ state, topLoadedAt: bundle?.topLoadedAt ?? null, launched, failures }) };
}
