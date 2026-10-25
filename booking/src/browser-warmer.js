// ============================================================
// 予約に使うブラウザを先に起こし、トップページまで開いて待たせておく(「枠が出てから予約を押すまで」の短縮。2026-10-25)
//
//   const warmer = createBrowserWarmer({ launch, topUrl, prefetch, log, refreshMs, maxAgeMs, retryMs, now, timers })
//     launch     async () => bundle   reserve.js の launchBrowserForReserve(...) を呼ぶ関数。bundle = { page, context, browser, setPhase, close, ... }
//     topUrl     先に開いておくページ(都サイトのトップ)
//     prefetch   async (bundle) => any  トップを開いた後に呼ぶ(省略可)。返り値を bundle.prefetched に入れる(ログイン画面と検索の先取り。
//                src/site-inpage.js の prefetchInPage)。失敗(例外か { ok: false })なら bundle.prefetched = null のまま使う。30 秒で打ち切る
//     refreshMs  トップを読み直す間隔(既定 8 分。都サイトのセッションは放置 10 分で切れる。docs/site-notes.md)
//     maxAgeMs   これより古いトップは「新しい」とみなさない(既定 9 分。reserve.js 側の判定と同じ)
//     retryMs    起動や読み込みに失敗したあと次に試すまでの基本(既定 1 分。連続失敗で 2 倍ずつ、最大 10 分)
//     now / timers  テスト用の差し替え(Date.now / { setTimeout, clearTimeout })
//
//   warmer.start()     起こし始める(非同期。失敗しても retryMs 後にやり直す)
//   warmer.acquire()   → Promise<bundle | null>。予約の実行の直前に呼ぶ。使える bundle を 1 つ渡して手放す(以後は呼び出し側が閉じる。
//                      reserve() は finally で閉じる)。起動や読み直しの途中なら終わるのを待ち、何も無ければその場で起こして待ってから渡す。
//                      それでも用意できなければ null(呼び出し側が自分で起こす)。
//                      **acquire() を呼んだら、予約が終わったあと必ず resume() を呼ぶこと。** acquire() から resume() までは
//                      「予約がブラウザを使っている」とみなし、この間 warmer は新しい Chromium を一切起こさない
//                      (同じプロファイルで 2 つ目を起こすと「使用中」で失敗するため。null を返した場合も同じ)
//   warmer.resume()    予約が終わった合図。少し置いて次を起こす(手放した束が閉じられていることも確かめる)
//   warmer.stop()      止めて閉じる
//   warmer.status()    { state: 'idle'|'launching'|'ready'|'refreshing'|'handed'|'stopped', busy, topLoadedAt, launched, failures }
//
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
  maxRetryMs = 10 * 60 * 1000,
  relaunchDelayMs = 2000,
  prefetchTimeoutMs = 30 * 1000,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
} = {}) {
  let state = 'idle';
  let bundle = null; // 今持っている(まだ渡していない)ブラウザ
  let handed = null; // 渡してまだ閉じられていないブラウザ(予約の実行中)
  let busy = false; // acquire() 〜 resume() の間 = 予約がブラウザを使っている(warmer のものか自前かを問わず)
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
  const retryDelay = () => Math.min(retryMs * 2 ** Math.max(0, failures - 1), maxRetryMs);
  const isGone = (b) => !b || b.page.isClosed() || (b.browser && typeof b.browser.isConnected === 'function' && !b.browser.isConnected());

  async function loadTop(b) {
    b.setPhase('top');
    await b.page.goto(topUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!(await b.page.$('[onclick*="gRsvWTransUserLoginAction"]'))) throw new Error('トップページにログインボタンがありません(メンテナンス中の可能性)');
    b.topLoadedAt = now();
    b.prefetched = null;
    if (prefetch) {
      let to = null;
      try {
        const timeout = new Promise((_, rej) => {
          to = timers.setTimeout(() => rej(new Error(`${Math.round(prefetchTimeoutMs / 1000)} 秒で打ち切り`)), prefetchTimeoutMs);
        });
        const r = await Promise.race([prefetch(b), timeout]);
        if (r && r.ok !== false) b.prefetched = r;
        else log(`先取りできませんでした(予約時に取り直します): ${(r && r.message) || '不明'}`);
      } catch (e) {
        log(`先取りに失敗(予約時に取り直します): ${e.message.split('\n')[0]}`);
      } finally {
        if (to) timers.clearTimeout(to);
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

  // 起動してトップまで開く。失敗したら閉じて、しばらくしてやり直す(予約中は起こさない。resume() で再開)
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
        const wait = retryDelay();
        log(`先に起こせませんでした(${failures} 回目): ${e.message.split('\n')[0]}。${busy ? '予約が終わってから' : `${Math.round(wait / 1000)} 秒後に`}やり直します`);
        if (!stopped && !busy) schedule(prepare, wait);
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
        if (isGone(b)) throw new Error('ページが閉じられていました');
        await loadTop(b);
        state = 'ready';
        schedule(refresh, refreshMs);
      } catch (e) {
        failures++;
        bundle = null;
        await discard(b, `トップページを読み直せませんでした: ${e.message.split('\n')[0]}`);
        state = 'idle';
        if (!stopped && !busy) schedule(prepare, retryDelay());
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function acquire() {
    if (stopped) return null;
    busy = true; // ここから resume() まで、warmer は新しい Chromium を起こさない
    clearTimer(); // 予約中に読み直し・起こし直しが走らないように
    if (inflight) await inflight; // 起動・読み直しの途中なら終わるまで待つ(別のブラウザを起こしてはいけない)
    if (handed && !isGone(handed)) {
      // 予約の行列は直列なのでここには来ないはず。来ても 2 つ目は起こさない(同じプロファイルは 1 つしか開けない)
      log('先に起こしたブラウザはまだ使用中のため渡せません');
      return null;
    }
    handed = null;
    let b = bundle;
    if (b && (isGone(b) || !b.topLoadedAt || now() - b.topLoadedAt > maxAgeMs)) {
      bundle = null;
      await discard(b, 'ページが閉じられていたか、トップページが古すぎた');
      b = null;
    }
    if (!b) {
      // 何も無い(前の予約が終わった直後で次を起こす前、起こし直しの待ち中、古くて捨てた直後など)なら、ここで起こして待つ。
      // 予約の開始は数秒遅れるが、呼び出し側が別のブラウザを起こして「使用中」でぶつかるより安全
      await prepare();
      b = bundle;
      clearTimer(); // prepare が予約した読み直しは、使用中は要らない
      if (!b) return null; // 用意できなかった(サイトが落ちているなど)。呼び出し側が自分で起こす。warmer は resume() まで何もしない
    }
    bundle = null;
    state = 'handed';
    handed = b;
    b.context.once('close', () => {
      if (handed === b) handed = null;
    });
    return b;
  }

  // 予約が終わった合図。手放した束が閉じられているのを確かめてから、少し置いて次を起こす
  function resume() {
    busy = false;
    if (stopped) return;
    if (handed && !isGone(handed)) {
      // reserve() は finally で閉じるのでここには来ないはず。閉じられていなければ閉じる(閉じないとプロファイルを掴んだまま)
      const b = handed;
      handed = null;
      discard(b, '予約が終わっても閉じられていなかったため').finally(() => {
        if (!stopped && !bundle && !inflight) schedule(prepare, relaunchDelayMs);
      });
      return;
    }
    handed = null;
    state = bundle ? 'ready' : 'idle';
    if (!bundle && !inflight) schedule(prepare, relaunchDelayMs);
    else if (bundle && !timer) schedule(refresh, refreshMs);
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

  return { start, acquire, resume, stop, status: () => ({ state, busy, topLoadedAt: bundle?.topLoadedAt ?? null, launched, failures }) };
}
