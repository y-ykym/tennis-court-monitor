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
  // 予約が終わって閉じられたら 2 秒後に次を起こす
  await b.close();
  await clock.advance(2500);
  assert.equal(launched.length >= 2, true);
  assert.equal(w.status().state, 'ready');
});

test('8 分ごとにトップを読み直す。acquire は読み直しの途中なら終わるまで待つ', async () => {
  const clock = fakeClock();
  const { launch, launched } = fakeLaunch();
  const w = createBrowserWarmer({ launch, topUrl: TOP, now: clock.now, timers: clock.timers });
  w.start();
  await flush();
  assert.equal(launched[0].gotos, 1);
  await clock.advance(8 * 60 * 1000);
  assert.equal(launched[0].gotos, 2, '8 分で読み直す');
  await clock.advance(8 * 60 * 1000);
  assert.equal(launched[0].gotos, 3);
  const b = await w.acquire();
  assert.equal(b, launched[0]);
  assert.equal(b.topLoadedAt, clock.now(), '直近の読み直しの時刻');
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

test('トップページが古すぎる束は渡さず閉じて起こし直す(acquire は null)', async () => {
  const clock = fakeClock();
  const { launch, launched } = fakeLaunch();
  // refresh を長くして「古くなる」状況を作る
  const w = createBrowserWarmer({ launch, topUrl: TOP, refreshMs: 60 * 60 * 1000, now: clock.now, timers: clock.timers });
  w.start();
  await flush();
  await clock.advance(10 * 60 * 1000);
  assert.equal(await w.acquire(), null);
  assert.equal(launched[0].page.isClosed(), true);
  await clock.advance(2500);
  assert.equal(launched.length, 2);
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
  // 2 秒後の起こし直しを待たずにすぐ頼む
  const second = await w.acquire();
  assert.ok(second && second !== first);
  assert.equal(launched.length, 2);
  await clock.advance(10_000);
  assert.equal(launched.length, 2, '予約してあった起こし直しは取り消されている');
});
