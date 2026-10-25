// reserve() が先に起こしたブラウザ(options.warm)を、手続きに入らず戻るときにも閉じることの確認(ブラウザは使わない経路だけ)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserve } from '../src/reserve.js';

const fakeWarm = () => {
  const w = { closed: 0, page: { isClosed: () => false }, context: {}, setPhase: () => {}, close: async () => void w.closed++ };
  return w;
};

test('利用者番号が無いときは auth_error で戻り、受け取った warm を閉じる', async () => {
  const warm = fakeWarm();
  const r = await reserve({ park: '1050', date: '2026-11-05', startHour: 11 }, { userId: '', password: 'x' }, { warm });
  assert.equal(r.status, 'auth_error');
  assert.equal(warm.closed, 1);
});

test('枠の指定が不正なときは error で戻り、受け取った warm を閉じる', async () => {
  const warm = fakeWarm();
  const r = await reserve({ park: '1050', date: '2026-11-05', startHour: 10 }, { userId: '12345678', password: 'x' }, { warm });
  assert.equal(r.status, 'error');
  assert.match(r.message, /枠の指定が不正/);
  assert.equal(warm.closed, 1);
});

test('warm を渡さないときは何も閉じない(エラーにならない)', async () => {
  const r = await reserve({ park: '1050', date: '2026-11-05', startHour: 10 }, { userId: '12345678', password: 'x' }, {});
  assert.equal(r.status, 'error');
});
