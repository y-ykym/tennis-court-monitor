import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify, slotExpiry } from '../src/token.js';

const SECRET = 'test-secret';
const payload = { park: '1050', date: '2026-09-17', startHour: 15, people: 2, person: 'A', exp: slotExpiry('2026-09-17', 15) };

test('署名したトークンは同じ鍵で検証でき、中身が戻る', () => {
  const token = sign(payload, SECRET);
  assert.deepEqual(verify(token, SECRET, Date.UTC(2026, 8, 3)), payload);
});

test('鍵が違う・改ざん・形式不正は null', () => {
  const token = sign(payload, SECRET);
  assert.equal(verify(token, 'other-secret'), null);
  assert.equal(verify(token.slice(0, -2) + 'xx', SECRET), null);
  assert.equal(verify(token.replace('.', ''), SECRET), null);
  assert.equal(verify('', SECRET), null);
  assert.equal(verify(token, ''), null);
});

test('有効期限(枠の利用開始時刻 JST)を過ぎたら null', () => {
  const token = sign(payload, SECRET);
  // 2026-09-17 15:00 JST = 06:00 UTC
  assert.equal(slotExpiry('2026-09-17', 15), Date.UTC(2026, 8, 17, 6) / 1000);
  assert.ok(verify(token, SECRET, Date.UTC(2026, 8, 17, 5, 59)));
  assert.equal(verify(token, SECRET, Date.UTC(2026, 8, 17, 6, 1)), null);
});

test('鍵が未設定なら署名できない', () => {
  assert.throws(() => sign(payload, ''), /BOOKING_SIGNING_SECRET/);
});
