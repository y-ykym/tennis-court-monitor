import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarSyncRequester } from '../src/calendar-sync-request.js';

const flush = () => new Promise((r) => setImmediate(r));
function setup(results) {
  const calls = [];
  const logs = [];
  const scheduled = [];
  const timers = {
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; scheduled.push(t); return t; },
    clearTimeout: (t) => { t.cleared = true; },
  };
  let i = 0;
  const trigger = async (person, reason) => {
    calls.push(`${person} ${reason}`);
    const r = results[Math.min(i++, results.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  const request = createCalendarSyncRequester({ trigger, log: (m) => logs.push(m), timers });
  const fire = async () => { const t = scheduled.filter((x) => !x.cleared && !x.done).pop(); t.done = true; t.fn(); await flush(); };
  const live = () => scheduled.filter((x) => !x.cleared && !x.done);
  return { request, calls, logs, scheduled, fire, live };
}
const ok = { A: { inserted: 1, updated: 0, deleted: 0 } };
const empty = { A: { inserted: 0, updated: 0, deleted: 0, noDelete: ['site'] } };

test('同期がふつうに済めばやり直さない', async () => {
  const h = setup([ok]);
  await h.request('A', 'auto-booked');
  assert.deepEqual(h.calls, ['A auto-booked']);
  assert.equal(h.live().length, 0);
  assert.ok(h.logs[0].includes('追加 1 / 更新 0 / 削除 0'));
});

test('都サイトから一覧を取れず空振り(noDelete に site)なら 3 分後にやり直し、取れたら終わる', async () => {
  const h = setup([empty, ok]);
  await h.request('A', 'auto-booked');
  assert.equal(h.live().length, 1);
  assert.equal(h.live()[0].ms, 3 * 60 * 1000);
  assert.ok(h.logs.some((m) => m.includes('3 分後にやり直します(1/3 回目)')), h.logs.join('\n'));
  await h.fire();
  assert.equal(h.calls.length, 2);
  assert.equal(h.live().length, 0);
});

test('やり直しは 3 回まで。頼めなかったとき・失敗のときもやり直す。認証の失敗はやり直さない', async () => {
  const h = setup([new Error('fetch failed'), { A: { error: 'HTTP 500' } }, empty, empty]);
  await h.request('A', 'booked');
  for (let k = 0; k < 3; k++) await h.fire();
  assert.equal(h.calls.length, 4, '初回 + やり直し 3 回');
  assert.equal(h.live().length, 0);
  assert.ok(h.logs.some((m) => m.includes('毎時の同期に任せます')), h.logs.join('\n'));
  const a = setup([{ A: { error: 'forbidden', auth: true } }]);
  await a.request('A', 'booked');
  assert.equal(a.live().length, 0);
  // テニスベアだけ取れなかった(site は取れた)ならやり直さない
  const t = setup([{ A: { inserted: 1, updated: 0, deleted: 0, noDelete: ['tb'] } }]);
  await t.request('A', 'booked');
  assert.equal(t.live().length, 0);
});

test('やり直し待ちの間に新しい依頼が来たら、待ちを捨ててその場で同期する。A・B 以外は何もしない', async () => {
  const h = setup([empty, ok]);
  await h.request('A', 'auto-booked');
  await h.request('A', 'auto-booked');
  assert.equal(h.calls.length, 2);
  assert.equal(h.live().length, 0);
  await h.request('C', 'x');
  assert.equal(h.calls.length, 2);
});
