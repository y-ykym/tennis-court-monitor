// フェーズ9 使い方カード(「へるぷ」)のテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { HELP_COMMAND_TEXT, helpRows, buildHelpFlex, helpText, buildHelpReply } from '../src/help.js';
import { COMMAND_TEXT, pickTextCommandEvents } from '../src/line.js';
import { AUTO_COMMAND_TEXT, AUTO_ON_TEXT, AUTO_OFF_TEXT, NOTIFY_ON_TEXT, NOTIFY_OFF_TEXT } from '../src/auto.js';
import { CARD_COMMAND_TEXT } from '../src/card.js';
import { CONTACT_COMMAND_TEXT } from '../src/contacts.js';

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

test('help: 合言葉は「へるぷ」。一覧には bot が受け付ける合言葉が全部、重複なく載る', () => {
  assert.equal(HELP_COMMAND_TEXT, 'へるぷ');
  const keywords = helpRows().map((r) => r.keyword);
  assert.deepEqual(keywords, [COMMAND_TEXT, AUTO_COMMAND_TEXT, CARD_COMMAND_TEXT, CONTACT_COMMAND_TEXT, HELP_COMMAND_TEXT]);
  assert.deepEqual(keywords, ['よやく', 'せってい', 'うけつけ', 'きゃんせる', 'へるぷ']);
  assert.equal(new Set(keywords).size, keywords.length);
  // ON/OFF の打ち込み合言葉は「せってい」の行の補足に出す(行は増やさない)
  const settings = helpRows().find((r) => r.keyword === AUTO_COMMAND_TEXT);
  for (const k of [AUTO_ON_TEXT, AUTO_OFF_TEXT, NOTIFY_ON_TEXT, NOTIFY_OFF_TEXT]) assert.ok(settings.note.includes(k), `${k} が補足に載っている`);
});

test('help: カードに合言葉と説明が全部載り、行ごとに message アクション(その合言葉を送る)が付く', () => {
  const flex = buildHelpFlex();
  assert.equal(flex.type, 'flex');
  assert.equal(flex.contents.type, 'bubble');
  const t = texts(flex.contents);
  assert.ok(t.includes('📖 使い方'));
  for (const r of helpRows()) {
    assert.ok(t.includes(r.keyword), `${r.keyword} が載っている`);
    assert.ok(t.includes(r.title), `${r.title} が載っている`);
    assert.ok(t.includes(r.desc), `${r.keyword} の説明が載っている`);
  }
  const acts = actions(flex.contents);
  assert.deepEqual(acts.map((a) => a.text), helpRows().map((r) => r.keyword));
  assert.ok(acts.every((a) => a.type === 'message' && a.label === a.text));
  assert.equal(flex.contents.footer, undefined, 'フッターのボタンは置かない');
  assert.ok(flex.altText.length <= 400);
  assert.ok(JSON.stringify(flex.contents).length < 30000, 'バブルは 30KB 以内');
});

test('help: テキスト版は 1 合言葉 1 行', () => {
  const lines = helpText().split('\n');
  assert.equal(lines[0], '📖 使い方(グループで送る合言葉)');
  assert.deepEqual(lines.slice(1), helpRows().map((r) => `${r.keyword}: ${r.title}`));
  const reply = buildHelpReply();
  assert.equal(reply.flex.type, 'flex');
  assert.equal(reply.text, helpText());
});

test('help: 「へるぷ」はグループの完全一致(前後の空白は許容)だけ拾う', () => {
  const ev = (text, source = { type: 'group', groupId: 'G1' }) => ({ type: 'message', replyToken: 'r', source, message: { type: 'text', text } });
  const body = JSON.stringify({ events: [ev(' へるぷ '), ev('へるぷ', { type: 'user', userId: 'U1' }), ev('へるぷして'), ev('ヘルプ'), ev('help'), ev('へるぷ', { type: 'group', groupId: 'G2' })] });
  const picked = pickTextCommandEvents(body, 'G1', [HELP_COMMAND_TEXT]);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].message.text.trim(), 'へるぷ');
});
