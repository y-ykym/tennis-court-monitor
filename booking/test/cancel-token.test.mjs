import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signCancelToken, verifyCancelToken } from '../src/cancel-token.js';
import { signCancelToken as workerSign, verifyCancelToken as workerVerify } from '../../worker/src/cancel-token.js';

const SECRET = 'test-signing-secret';
const NOW = Date.parse('2026-09-14T03:00:00Z');
const payload = { kind: 'c', person: 'B', id: '2026001234', date: '2026-09-18', start: '19:00', end: '21:00', facility: '猿江恩賜公園', penaltyDay: 3, exp: Math.floor(NOW / 1000) + 3600 };

test('Pi(node:crypto)で作ったキャンセルトークンは Worker(Web Crypto)の実装と 1 文字も違わず、相互に検証できる', async () => {
  const mine = signCancelToken(SECRET, payload);
  const theirs = await workerSign(SECRET, payload);
  assert.equal(mine, theirs);
  assert.deepEqual(await workerVerify(SECRET, mine, NOW), { ...payload, expired: false });
  assert.deepEqual(verifyCancelToken(SECRET, theirs, NOW), { ...payload, expired: false });
  assert.equal(verifyCancelToken('other', mine, NOW), null);
  assert.equal(verifyCancelToken(SECRET, mine.replace('|B|', '|A|'), NOW), null);
  assert.equal(verifyCancelToken(SECRET, mine, (payload.exp + 1) * 1000).expired, true);
});

test('不正な値は署名しない(Worker と同じ検査)', () => {
  assert.throws(() => signCancelToken(SECRET, { ...payload, facility: 'a|b' }));
  assert.throws(() => signCancelToken(SECRET, { ...payload, person: 'C' }));
  assert.throws(() => signCancelToken(SECRET, { ...payload, date: '2026/09/18' }));
  assert.throws(() => signCancelToken('', payload));
});
