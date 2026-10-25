import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBrowserWarmer } from '../src/browser-warmer.js';

// 偽の時計とタイマー(時間を進めると期限の来たタイマーが順に動く)
function fakeClock() {
  let t = 1_000_000;
  const pending = new Map();
  let seq = 0;
  const timers = {
    setTimeout: (fn, ms) => {
      const id = ++seq;
      pending.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
  };
  async function advance(ms) {
    const until = t + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, p]) => p.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      t = due[1].at;
      pending.delete(due[0]);
      await due[1].fn();
      await flush();
    }
    t = until;
  }
  return { now: () => t, timers, advance, pendingCount: () => pending.size };
}
const flush = () => new Promise((r) => setImmediate(r));

// 偽のブラウザ束。gotoResult で goto の成否、hasButton でログインボタンの有無を制御
function fakeLaunch(opts = {}) {
  const launched = [];
  const launch = async () => {
    if (opts.failLaunch?.(launched.length)) throw new Error('launch failed');
    const context = new EventEmitter();
    let closed = false;
    const b = {
      context,
      phases: [],
      gotos: 0,
      page: {
        isClosed: () => closed,
        goto: async () => {
          b.gotos++;
          if (opts.holdGoto?.(b)) await opts.holdGoto(b); // 読み直しの途中を再現する(解放されるまで止まる)
          if (opts.failGoto?.(b)) throw new Error('goto failed');
        },
        $: async () => (opts.noButton ? null : {}),
      },
      setPhase: (p) => b.phases.push(p),
      close: async () => {
        closed = true;
        context.emit('close');
      },
    };
    launched.push(b);
    return b;
  };
  return { launch, launched };
}
const TOP = 'https://example.test/web/index.jsp';

test('起こしてトップを開き、acquire で渡す。渡した束が閉じられたら次を起こす', async () => {
  const clock = fakeClock();
  const { launch, launched } = fakeLaunch();
  const logs = [];
  const w = createBrowserWarmer({ launch, topUrl: TOP, log: (m) => logs.push(m), now: clock.now, timers: clock.timers });
  w.start();
  await flush();
  assert.equal(w.status().state, 'ready');
  assert.equal(launched.length, 1);
  assert.deepEqual(launched[0].phases, ['top']);
  const b = await w.acquire();
  assert.equal(b, launched[0]);
  assert.equal(b.topLoadedAt, clock.now());
  assert.equal(w.status().state, 'handed');
  assert.equal(await w.acquire(), null, '使用中にもう一度頼まれても渡さない');
  assert.equal(launched.length, 1, '使用中は 2 つ目を起こさない(同じプロファイルは 1 つしか開けない)');
  // 予約が終わって閉じられても、resume() が来るまでは起こさない
  await b.close();
  await clock.advance(60_000);
  assert.equal(launched.length, 1, 'resume() 前は起こさない');
  w.resume();
  await clock.advance(2500);
  assert.equal(launched.length, 2, 'resume() の 2 秒後に次を起こす');
  assert.equal(w.status().state, 'ready');
});

test('8 分ごとにトップを読み直す。acquire は読み直しの途中なら終わるまで待ってから渡す', async () => {
  const clock = fakeClock();
  let release = null;
  const { launch, launched } = fakeLaunch({ holdGoto: (b) => (b.gotos === 3 ? new Promise((r) => (release = r)) : null) });
  const w = createBrowserWarmer({ launch, topUrl: TOP, now: clock.now, timers: clock.timers });
  w.start();
  await flush();
  assert.equal(launched[0].gotos, 1);
  await clock.advance(8 * 60 * 1000);
  assert.equal(launched[0].gotos, 2, '8 分で読み直す');
  // 3 回目の読み直しは途中で止めておき、その最中に acquire する
  const adv = clock.advance(8 * 60 * 1000);
  await flush();
  assert.equal(w.status().state, 'refreshing');
  let got = null;
  const pending = w.acquire().then((b) => (got = b));
  await flush();
  assert.equal(got, null, '読み直しが終わるまで渡さない');
  assert.equal(launched.length, 1, '待っている間に別のブラウザを起こさない');
  release();
  await adv;
  await pending;
  assert.equal(got, launched[0]);
  assert.equal(got.topLoadedAt, clock.now(), '直近の読み直しの時刻');
});

test('起動に失敗したら 1 分後にやり直す。読み直しに失敗したら閉じて起こし直す', async () => {
  const clock = fakeClock();
  let failFirst = true;
  const { launch, launched } = fakeLaunch({ failLaunch: (n) => n === 0 && failFirst, failGoto: (b) => b.gotos === 2 });
  const logs = [];
  const w = createBrowserWarmer({ launch, topUrl: TOP, log: (m) => logs.push(m), now: clock.now, timers: clock.timers });
  w.start();
  await flush();
  assert.equal(w.status().state, 'idle');
  assert.equal(w.status().failures, 1);
  failFirst = false;
  await clock.advance(60 * 1000);
  assert.equal(w.status().state, 'ready');
  assert.equal(launched.length, 1);
  // 2 回目の goto(読み直し)で失敗 → 閉じて 1 分後に起こし直す
  await clock.advance(8 * 60 * 1000);
  assert.equal(launched[0].page.isClosed(), true);
  assert.equal(w.status().state, 'idle');
  await clock.advance(60 * 1000);
  assert.equal(launched.length, 2);
  assert.equal(w.status().state, 'ready');
});

test('トップページが古すぎる束は閉じて、その場で起こし直してから渡す(null にして呼び出し側に起こさせない)', async () => {
  const clock = fakeClock();
  const { launch, launched } = fakeLaunch();
  // refresh を長くして「古くなる」状況を作る
  const w = createBrowserWarmer({ launch, topUrl: TOP, refreshMs: 60 * 60 * 1000, now: clock.now, timers: clock.timers });
  w.start();
  await flush();
  await clock.advance(10 * 60 * 1000);
  const b = await w.acquire();
  assert.equal(launched[0].page.isClosed(), true, '古い束は閉じる');
  assert.equal(b, launched[1], '新しく起こした束を渡す');
  assert.equal(launched.length, 2);
});

test('起こせなかったとき(サイトが落ちている)の acquire は null。resume() が来るまで起こし直さず、resume() で再開する', async () => {
  const clock = fakeClock();
  let down = true;
  const { launch, launched } = fakeLaunch({ failLaunch: () => down });
  const w = createBrowserWarmer({ launch, topUrl: TOP, now: clock.now, timers: clock.timers });
  w.start();
  await flush();
  assert.equal(launched.length, 0);
  assert.equal(await w.acquire(), null);
  const tries = w.status().failures;
  await clock.advance(10 * 60 * 1000);
  assert.equal(w.status().failures, tries, '予約中(resume 前)は起こし直さない');
  down = false;
  w.resume();
  await clock.advance(2500);
  assert.equal(launched.length, 1);
  assert.equal(w.status().state, 'ready');
});

test('連続で起こせないときは間隔を 1 → 2 → 4 分と広げる(最大 10 分)', async () => {
  const clock = fakeClock();
  const { launch } = fakeLaunch({ failLaunch: () => true });
  const w = createBrowserWarmer({ launch, topUrl: TOP, now: clock.now, timers: clock.timers });
  w.start();
  await flush();
  assert.equal(w.status().failures, 1);
  await clock.advance(60 * 1000);
  assert.equal(w.status().failures, 2, '1 分後に 2 回目');
  await clock.advance(60 * 1000);
  assert.equal(w.status().failures, 2, '次は 2 分後なのでまだ');
  await clock.advance(60 * 1000);
  assert.equal(w.status().failures, 3);
  await clock.advance(4 * 60 * 1000);
  assert.equal(w.status().failures, 4);
});

test('トップにログインボタンが無ければ(メンテナンス)失敗扱いで起こし直し続ける', async () => {
  const clock = fakeClock();
  const { launch, launched } = fakeLaunch({ noButton: true });
  const w = createBrowserWarmer({ launch, topUrl: TOP, now: clock.now, timers: clock.timers });
  w.start();
  await flush();
  assert.equal(w.status().state, 'idle');
  assert.equal(launched[0].page.isClosed(), true);
  await clock.advance(60 * 1000);
  assert.equal(launched.length, 2);
});

test('何も無いときの acquire は起こして待ってから渡す。stop 後は null', async () => {
  const clock = fakeClock();
  const { launch, launched } = fakeLaunch();
  const w = createBrowserWarmer({ launch, topUrl: TOP, now: clock.now, timers: clock.timers });
  const b = await w.acquire();
  assert.equal(b, launched[0]);
  await b.close();
  await w.stop();
  assert.equal(await w.acquire(), null);
  assert.equal(w.status().state, 'stopped');
  await clock.advance(10 * 60 * 1000);
  assert.equal(launched.length, 1, 'stop 後は起こさない');
});

test('閉じた直後(次を起こす前)の acquire は、起こして待ってから渡す(UI 操作でのやり直しの場面。2 つ同時には起こさない)', async () => {
  const clock = fakeClock();
  const { launch, launched } = fakeLaunch();
  const w = createBrowserWarmer({ launch, topUrl: TOP, now: clock.now, timers: clock.timers });
  w.start();
  await flush();
  const first = await w.acquire();
  await first.close();
  // resume() を待たずに(UI 操作でのやり直し)すぐ頼む → 閉じ済みを確かめて、その場で起こして渡す
  const second = await w.acquire();
  assert.ok(second && second !== first);
  assert.equal(launched.length, 2);
  await clock.advance(10_000);
  assert.equal(launched.length, 2, '使用中は何も起こさない');
  await second.close();
  w.resume();
  await clock.advance(2500);
  assert.equal(launched.length, 3, 'resume() で次を起こす');
});

test('prefetch を渡すとトップを開くたびに呼び、結果を bundle.prefetched に入れる。失敗しても束は使える', async () => {
  const clock = fakeClock();
  const { launch, launched } = fakeLaunch();
  let n = 0;
  const prefetch = async (b) => {
    n++;
    assert.equal(b.topLoadedAt, clock.now(), 'トップを開いた後に呼ばれる');
    if (n === 2) throw new Error('fetch failed');
    if (n === 3) return { ok: false, message: 'ログイン画面が想定外' };
    return { ok: true, loginFields: { loginJKey: 'K' + n }, search: { park: '1040' } };
  };
  const logs = [];
  const w = createBrowserWarmer({ launch, topUrl: TOP, prefetch, log: (m) => logs.push(m), now: clock.now, timers: clock.timers });
  w.start();
  await flush();
  assert.equal(launched[0].prefetched.loginFields.loginJKey, 'K1');
  assert.ok(logs.some((m) => /先取り: ログイン画面あり・検索1040/.test(m)));
  await clock.advance(8 * 60 * 1000); // 読み直し → prefetch が例外
  assert.equal(w.status().state, 'ready', '先取りの失敗では束を捨てない');
  assert.equal(launched[0].prefetched, null);
  await clock.advance(8 * 60 * 1000); // 読み直し → ok:false
  assert.equal(launched[0].prefetched, null);
  await clock.advance(8 * 60 * 1000); // 読み直し → 成功
  assert.equal(launched[0].prefetched.loginFields.loginJKey, 'K4');
  const b = await w.acquire();
  assert.equal(b.prefetched.loginFields.loginJKey, 'K4');
});
