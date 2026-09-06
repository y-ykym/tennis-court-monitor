import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signCancelToken, verifyCancelToken, penaltyApplies } from '../src/cancel-token.js';

const SECRET = 'test-signing-secret';
const NOW = Date.parse('2026-09-06T03:00:00Z');
const payload = {
  kind: 'c',
  person: 'A',
  id: '2026000123',
  date: '2026-09-18',
  start: '17:00',
  end: '19:00',
  facility: '大島小松川公園',
  penaltyDay: 3,
  exp: Math.floor(NOW / 1000) + 3600,
};

test('token: 署名して検証すると同じ内容が戻る(期限内)', async () => {
  const token = await signCancelToken(SECRET, payload);
  assert.match(token, /^c\|A\|2026000123\|20260918\|1700\|1900\|大島小松川公園\|3\|\d+\.[A-Za-z0-9_-]{22}$/);
  assert.ok(token.length <= 300, `postback data は300文字以内 (${token.length})`);
  assert.ok(token.length < 90, `十分短い (${token.length})`);
  const v = await verifyCancelToken(SECRET, token, NOW);
  assert.deepEqual(v, { ...payload, expired: false });
});

test('token: 改ざん・別の鍵・形式不正は null', async () => {
  const token = await signCancelToken(SECRET, payload);
  assert.equal(await verifyCancelToken(SECRET, token.replace('2026000123', '2026000124'), NOW), null, '予約番号の改ざん');
  assert.equal(await verifyCancelToken(SECRET, token.replace('|A|', '|B|'), NOW), null, '人の改ざん');
  assert.equal(await verifyCancelToken('other', token, NOW), null, '別の鍵');
  assert.equal(await verifyCancelToken(SECRET, 'n', NOW), null, '署名なし');
  assert.equal(await verifyCancelToken(SECRET, '', NOW), null);
  assert.equal(await verifyCancelToken(SECRET, null, NOW), null);
  assert.equal(await verifyCancelToken('', token, NOW), null, '鍵未設定');
});

test('token: 期限切れは expired=true で返る(署名は正しい)', async () => {
  const token = await signCancelToken(SECRET, { ...payload, exp: Math.floor(NOW / 1000) - 1 });
  const v = await verifyCancelToken(SECRET, token, NOW);
  assert.equal(v.expired, true);
  assert.equal(v.id, '2026000123');
});

test('token: kind=y(確認)も同じ形式。penaltyDay 空も可', async () => {
  const token = await signCancelToken(SECRET, { ...payload, kind: 'y', penaltyDay: '' });
  const v = await verifyCancelToken(SECRET, token, NOW);
  assert.equal(v.kind, 'y');
  assert.equal(v.penaltyDay, null);
});

test('token: 区切り文字を含む値・不正な値は署名しない', async () => {
  await assert.rejects(signCancelToken(SECRET, { ...payload, facility: 'a|b' }));
  await assert.rejects(signCancelToken(SECRET, { ...payload, id: '1.2' }));
  await assert.rejects(signCancelToken(SECRET, { ...payload, kind: 'x' }));
  await assert.rejects(signCancelToken(SECRET, { ...payload, person: 'C' }));
  await assert.rejects(signCancelToken(SECRET, { ...payload, date: '2026/09/18' }));
  await assert.rejects(signCancelToken('', payload));
});

test('penalty: 利用日 <= 今日 + penaltyday ならペナルティ対象(サイトの判定と同じ)', () => {
  assert.equal(penaltyApplies('2026-09-09', 3, '2026-09-06'), true, '3日後は対象');
  assert.equal(penaltyApplies('2026-09-10', 3, '2026-09-06'), false, '4日後は対象外');
  assert.equal(penaltyApplies('2026-09-06', 3, '2026-09-06'), true, '当日');
  assert.equal(penaltyApplies('2026-09-18', 3, '2026-09-06'), false);
  assert.equal(penaltyApplies('2026-09-18', null, '2026-09-06'), false, 'penaltyday 不明なら警告しない');
});
