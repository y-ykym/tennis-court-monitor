import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLineQueue } from '../src/line-queue.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lq-')), 'pending.json');

test('送れたら保存しない。失敗したら保存し、flush で届いたら消える', async () => {
  const file = tmpFile();
  let online = false;
  const sent = [];
  const push = async (m) => {
    if (!online) throw new Error('fetch failed');
    sent.push(m);
  };
  const q = createLineQueue({ file, push });
  assert.equal(await q.send({ type: 'text', text: 'A' }, '結果カード'), false);
  assert.equal(q.pending(), 1);
  assert.deepEqual(await q.flush(), { sent: 0, kept: 1, dropped: 0 }, 'まだ回線断');
  online = true;
  assert.deepEqual(await q.flush(), { sent: 1, kept: 0, dropped: 0 });
  assert.equal(sent[0].text, 'A');
  assert.equal(q.pending(), 0);
  assert.equal(fs.existsSync(file), false, '空になったらファイルも消す');
  assert.equal(await q.send({ type: 'text', text: 'B' }, '確認カード'), true);
  assert.equal(q.pending(), 0);
});

test('古すぎる持ち越しは送らずに捨てる。順番は保つ', async () => {
  const file = tmpFile();
  let t = 1_000_000;
  const sent = [];
  let online = false;
  const q = createLineQueue({ file, push: async (m) => { if (!online) throw new Error('x'); sent.push(m.text); }, now: () => t, maxAgeMs: 60_000 });
  await q.send({ text: 'old' }, 'a');
  t += 30_000;
  await q.send({ text: 'new' }, 'b');
  t += 40_000; // old は 70 秒、new は 40 秒経過
  online = true;
  assert.deepEqual(await q.flush(), { sent: 1, kept: 0, dropped: 1 });
  assert.deepEqual(sent, ['new']);
});

test('壊れたファイルは空として扱う', async () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{broken');
  const q = createLineQueue({ file, push: async () => {} });
  assert.equal(q.pending(), 0);
  assert.deepEqual(await q.flush(), { sent: 0, kept: 0, dropped: 0 });
});
