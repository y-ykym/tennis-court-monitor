import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMorningDigest } from '../src/morning-digest.js';

// JST の時刻(ms)。'2026-10-26 02:30' のように書く
const jst = (s) => Date.parse(`${s.replace(' ', 'T')}:00+09:00`);
function fakeClock(start) {
  let t = start;
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
  async function advanceTo(target) {
    for (;;) {
      const due = [...pending.entries()].filter(([, p]) => p.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      t = due[1].at;
      pending.delete(due[0]);
      await due[1].fn();
      await new Promise((r) => setImmediate(r));
    }
    t = target;
  }
  return { now: () => t, timers, advanceTo, set: (v) => (t = v) };
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'digest-')), 'pending-morning.json');

test('夜間(0:00〜8:00)の成立カードは溜めて、8:00 にまとめて 1 回の push で送る。昼間はその場で送る(false)', async () => {
  const clock = fakeClock(jst('2026-10-26 02:30'));
  const sent = [];
  const d = createMorningDigest({ file: tmpFile(), send: async (messages, what) => void sent.push({ messages, what }), now: clock.now, timers: clock.timers });
  assert.equal(d.hold({ id: 1 }, '自動予約の成立カード'), true);
  clock.set(jst('2026-10-26 05:10'));
  assert.equal(d.hold({ id: 2 }, '自動予約の成立カード'), true);
  assert.deepEqual(d.status().held, 2);
  assert.equal(sent.length, 0);
  await clock.advanceTo(jst('2026-10-26 07:59'));
  assert.equal(sent.length, 0, '7:59 ではまだ送らない');
  await clock.advanceTo(jst('2026-10-26 08:00:30'.replace(':30', '')) + 30000);
  assert.equal(sent.length, 1, '8:00 に 1 回の push');
  assert.deepEqual(sent[0].messages, [{ id: 1 }, { id: 2 }]);
  assert.match(sent[0].what, /2 件まとめ/);
  assert.equal(d.status().held, 0);
  // 昼間は溜めない
  clock.set(jst('2026-10-26 12:00'));
  assert.equal(d.hold({ id: 3 }, '自動予約の成立カード'), false);
  // 23:59 も昼間扱い(0:00 から夜間)
  clock.set(jst('2026-10-26 23:59'));
  assert.equal(d.hold({ id: 4 }, '自動予約の成立カード'), false);
  clock.set(jst('2026-10-27 00:00'));
  assert.equal(d.hold({ id: 5 }, '自動予約の成立カード'), true);
});

test('6 件以上は 5 件ずつに分けて送る', async () => {
  const clock = fakeClock(jst('2026-10-26 01:00'));
  const sent = [];
  const d = createMorningDigest({ file: tmpFile(), send: async (messages) => void sent.push(messages), now: clock.now, timers: clock.timers });
  for (let i = 0; i < 7; i++) d.hold({ id: i }, 'x');
  await clock.advanceTo(jst('2026-10-26 08:01'));
  assert.deepEqual(sent.map((m) => m.length), [5, 2]);
});

test('8:00 を過ぎて起動したとき(再起動など)、溜まっていればすぐ送る。夜間に起動したら 8:00 に送る', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify([{ at: 1, what: 'x', message: { id: 9 } }]));
  const sent = [];
  const clock = fakeClock(jst('2026-10-26 08:30'));
  const d = createMorningDigest({ file, send: async (messages) => void sent.push(messages), now: clock.now, timers: clock.timers });
  d.start();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [[{ id: 9 }]]);
  // 夜間に起動
  fs.writeFileSync(file, JSON.stringify([{ at: 1, what: 'x', message: { id: 10 } }]));
  const clock2 = fakeClock(jst('2026-10-27 03:00'));
  const sent2 = [];
  const d2 = createMorningDigest({ file, send: async (messages) => void sent2.push(messages), now: clock2.now, timers: clock2.timers });
  d2.start();
  await clock2.advanceTo(jst('2026-10-27 07:00'));
  assert.equal(sent2.length, 0);
  await clock2.advanceTo(jst('2026-10-27 08:00') + 2000);
  assert.deepEqual(sent2, [[{ id: 10 }]]);
});

test('送る関数が失敗しても溜めは消える(送信の持ち越しは lineQueue が受け持つ)', async () => {
  const clock = fakeClock(jst('2026-10-26 01:00'));
  const logs = [];
  const d = createMorningDigest({ file: tmpFile(), send: async () => { throw new Error('boom'); }, log: (m) => logs.push(m), now: clock.now, timers: clock.timers });
  d.hold({ id: 1 }, 'x');
  await clock.advanceTo(jst('2026-10-26 08:01'));
  assert.equal(d.status().held, 0);
  assert.ok(logs.some((m) => /エラー: boom/.test(m)));
});
