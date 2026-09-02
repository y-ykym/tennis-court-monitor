import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSignature, verifySignature, pickCommandEvents } from '../src/line.js';

const SECRET = 'test-channel-secret';
const GROUP = 'C1234567890abcdef1234567890abcdef';

function body(events) {
  return JSON.stringify({ destination: 'U0', events });
}
function textEvent(text, { groupId = GROUP, sourceType = 'group' } = {}) {
  return {
    type: 'message',
    replyToken: 'rt',
    source: sourceType === 'group' ? { type: 'group', groupId, userId: 'U1' } : { type: 'user', userId: 'U1' },
    message: { type: 'text', text },
  };
}

test('署名: 正しい署名は通り、改ざん・欠落は弾く', async () => {
  const raw = body([textEvent('よやく')]);
  const sig = await computeSignature(SECRET, raw);
  assert.equal(await verifySignature(SECRET, raw, sig), true);
  assert.equal(await verifySignature(SECRET, raw + ' ', sig), false);
  assert.equal(await verifySignature('other-secret', raw, sig), false);
  assert.equal(await verifySignature(SECRET, raw, null), false);
  assert.equal(await verifySignature(SECRET, raw, ''), false);
});

test('署名: LINE公式ドキュメントと同じ計算方法(HMAC-SHA256→base64)', async () => {
  // Node の crypto で独立に計算した値と一致すること
  const { createHmac } = await import('node:crypto');
  const raw = '{"events":[]}';
  const expected = createHmac('sha256', SECRET).update(raw).digest('base64');
  assert.equal(await computeSignature(SECRET, raw), expected);
});

test('抽出: 対象グループの「よやく」だけを拾う(前後の空白は許容)', () => {
  const raw = body([
    textEvent('よやく'),
    textEvent('  よやく\n'),
    textEvent('よやく!'), // 完全一致でない
    textEvent('予約'),
    textEvent('よやく', { groupId: 'Cother' }), // 別グループ
    textEvent('よやく', { sourceType: 'user' }), // 個人チャット
    { type: 'join', source: { type: 'group', groupId: GROUP }, replyToken: 'rt' },
    { type: 'message', source: { type: 'group', groupId: GROUP }, replyToken: 'rt', message: { type: 'sticker' } },
  ]);
  const picked = pickCommandEvents(raw, GROUP);
  assert.equal(picked.length, 2);
  assert.deepEqual(picked.map((e) => e.message.text), ['よやく', '  よやく\n']);
});

test('抽出: 壊れたJSON・eventsなしは空配列', () => {
  assert.deepEqual(pickCommandEvents('not json', GROUP), []);
  assert.deepEqual(pickCommandEvents('{}', GROUP), []);
  assert.deepEqual(pickCommandEvents(body([]), GROUP), []);
});
