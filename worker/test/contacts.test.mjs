// フェーズ8 コートの連絡先(「きゃんせる」)のテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTACT_COMMAND_TEXT, telUri, contactRows, buildContactFlex, contactText, buildContactReply } from '../src/contacts.js';
import { COURTS } from '../src/courts.js';
import { pickTextCommandEvents } from '../src/line.js';

function texts(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (node && typeof node === 'object') {
    if ((node.type === 'text' || node.type === 'span') && typeof node.text === 'string') out.push(node.text);
    Object.values(node).forEach((v) => texts(v, out));
  }
  return out;
}
function actions(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => actions(n, out));
  else if (node && typeof node === 'object') {
    if (node.action) out.push(node.action);
    Object.values(node).forEach((v) => actions(v, out));
  }
  return out;
}

test('contacts: 台帳の 3 公園すべてに電話番号がある(03-XXXX-XXXX)', () => {
  assert.equal(COURTS.length, 3);
  for (const c of COURTS) assert.match(c.phone, /^03-\d{4}-\d{4}$/, `${c.name} の電話番号`);
  assert.deepEqual(
    contactRows().map((r) => r.name),
    ['猿江恩賜公園', '亀戸中央公園', '大島小松川公園']
  );
});

test('contacts: phone の無い公園は行に出さない', () => {
  const rows = contactRows([{ name: 'A', phone: '03-0000-0000' }, { name: 'B' }, { name: 'C', phone: '' }]);
  assert.deepEqual(rows, [{ name: 'A', phone: '03-0000-0000' }]);
});

test('contacts: tel: の URI はハイフン・全角・空白を落とす', () => {
  assert.equal(telUri('03-3631-9732'), 'tel:0336319732');
  assert.equal(telUri('０３ ３６３６ ２５５８'), 'tel:0336362558');
});

test('contacts: カードに公園名と番号が全部載り、行ごとに電話のアクションが付く', () => {
  const flex = buildContactFlex();
  assert.equal(flex.type, 'flex');
  assert.equal(flex.contents.type, 'bubble');
  const t = texts(flex.contents);
  assert.ok(t.includes('📞 キャンセルの連絡先'));
  for (const c of COURTS) {
    assert.ok(t.includes(c.name), `${c.name} が載っている`);
    assert.ok(t.includes(c.phone), `${c.phone} が載っている`);
  }
  const acts = actions(flex.contents);
  assert.deepEqual(
    acts.map((a) => a.uri),
    COURTS.map((c) => `tel:${c.phone.replace(/-/g, '')}`)
  );
  assert.ok(acts.every((a) => a.type === 'uri'));
  assert.equal(flex.contents.footer, undefined, 'フッターのボタンは置かない');
  assert.ok(flex.altText.length <= 400);
  assert.ok(JSON.stringify(flex.contents).length < 30000, 'バブルは 30KB 以内');
});

test('contacts: テキスト版は 1 公園 1 行', () => {
  const lines = contactText().split('\n');
  assert.equal(lines[0], '📞 キャンセルの連絡先');
  assert.deepEqual(lines.slice(1), COURTS.map((c) => `${c.name} ${c.phone}`));
  const reply = buildContactReply();
  assert.equal(reply.flex.type, 'flex');
  assert.equal(reply.text, contactText());
});

test('contacts: 「きゃんせる」はグループの完全一致(前後の空白は許容)だけ拾う', () => {
  const ev = (text, source = { type: 'group', groupId: 'G1' }) => ({ type: 'message', replyToken: 'r', source, message: { type: 'text', text } });
  const body = JSON.stringify({ events: [ev(' きゃんせる '), ev('きゃんせる', { type: 'user', userId: 'U1' }), ev('きゃんせるして'), ev('キャンセル'), ev('きゃんせる', { type: 'group', groupId: 'G2' })] });
  const picked = pickTextCommandEvents(body, 'G1', [CONTACT_COMMAND_TEXT]);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].message.text.trim(), 'きゃんせる');
});
