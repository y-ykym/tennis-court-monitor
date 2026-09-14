import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBookingQueue } from '../src/booking-queue.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

test('行列: 1 件ずつ実行し、手動は待っている自動より先に入る', async () => {
  const q = createBookingQueue();
  const order = [];
  const gates = {};
  const job = (id, kind) => ({
    id,
    kind,
    run: async () => {
      order.push(`start:${id}`);
      gates[id] = deferred();
      await gates[id].promise;
      order.push(`end:${id}`);
      return id;
    },
  });
  const a1 = q.submit(job('auto1', 'auto'));
  assert.equal(a1.status, 'started');
  assert.equal(q.submit(job('auto2', 'auto')).status, 'queued');
  assert.equal(q.submit(job('auto3', 'auto')).status, 'queued');
  const m = q.submit(job('manual1', 'manual'));
  assert.equal(m.status, 'queued', '実行中の自動は中断しない');
  assert.deepEqual(q.waiting().map((j) => j.id), ['manual1', 'auto2', 'auto3'], '手動が先頭に割り込む');
  assert.equal(q.submit(job('manual1', 'manual')).status, 'duplicate');
  assert.equal(q.has('auto2'), true);

  await new Promise((r) => setImmediate(r));
  gates.auto1.resolve();
  assert.deepEqual(await a1.promise, { ok: true, result: 'auto1' });
  await new Promise((r) => setImmediate(r));
  assert.equal(q.current().id, 'manual1');
  gates.manual1.resolve();
  await m.promise;
  await new Promise((r) => setImmediate(r));
  gates.auto2.resolve();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  gates.auto3.resolve();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ['start:auto1', 'end:auto1', 'start:manual1', 'end:manual1', 'start:auto2', 'end:auto2', 'start:auto3', 'end:auto3']);
  assert.equal(q.isBusy(), false);
  assert.equal(q.has('auto1'), false, '終わったものは無い');
});

test('行列: 失敗しても止まらず次へ進む。結果は promise で受け取れる', async () => {
  const q = createBookingQueue();
  const bad = q.submit({ id: 'x', kind: 'auto', run: async () => { throw new Error('boom'); } });
  const good = q.submit({ id: 'y', kind: 'auto', run: async () => 'fine' });
  const r1 = await bad.promise;
  assert.equal(r1.ok, false);
  assert.match(r1.error.message, /boom/);
  assert.deepEqual(await good.promise, { ok: true, result: 'fine' });
});
