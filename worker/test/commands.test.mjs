// 合言葉の台帳とクイックリプライ(commands.js / lib/quick-reply.js)のテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { COMMANDS, COMMAND_TEXT, AUTO_COMMAND_TEXT, commandTexts, canonicalCommand, QUICK_REPLY_BUTTONS, buildQuickReply, withQuickReply } from '../src/commands.js';
import { pickTextCommandEvents, replyMessages, pushMessages } from '../src/line.js';
import { helpRows } from '../src/help.js';

const require = createRequire(import.meta.url);
const libQuickReply = require('../../lib/quick-reply.js');

test('台帳: 合言葉・別名・ボタン表示が重複せず、label は 20 文字以内', () => {
  const all = COMMANDS.flatMap((c) => [c.text, c.alias]);
  assert.equal(new Set(all).size, all.length);
  for (const c of COMMANDS) assert.ok([...c.label].length <= 20, c.label);
  assert.equal(COMMANDS.length, 6);
  // へるぷカードの行と同じ合言葉が同じ順で載っている
  assert.deepEqual(helpRows().map((r) => r.keyword), COMMANDS.map((c) => c.text));
});

test('commandTexts / canonicalCommand: 別名を受け付け、従来の合言葉に戻す', () => {
  assert.deepEqual(commandTexts(COMMAND_TEXT), ['よやく', '予約の一覧']);
  assert.deepEqual(commandTexts('じどうおん'), ['じどうおん']); // 台帳に無いものはそのまま
  assert.equal(canonicalCommand('設定'), AUTO_COMMAND_TEXT);
  assert.equal(canonicalCommand('せってい'), 'せってい');
  assert.equal(canonicalCommand('じどうおふ'), 'じどうおふ');
});

test('pickTextCommandEvents: ボタンが送る別名(予約の一覧)でも拾う', () => {
  const ev = (text) => ({ type: 'message', replyToken: 'rt', source: { type: 'group', groupId: 'G' }, message: { type: 'text', text } });
  const raw = JSON.stringify({ events: [ev('予約の一覧'), ev('よやく'), ev(' 設定 '), ev('予約')] });
  assert.equal(pickTextCommandEvents(raw, 'G', [COMMAND_TEXT]).length, 2);
  assert.equal(pickTextCommandEvents(raw, 'G', [AUTO_COMMAND_TEXT]).length, 1);
});

test('withQuickReply: 最後のメッセージにだけ付け、元を変えない。空配列・付与済みはそのまま', () => {
  const msgs = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }];
  const out = withQuickReply(msgs);
  assert.equal(out[0].quickReply, undefined);
  assert.equal(out[1].quickReply.items.length, 6);
  assert.deepEqual(out[1].quickReply.items[0], { type: 'action', action: { type: 'message', label: '📅 予約の一覧', text: '予約の一覧' } });
  assert.equal(msgs[1].quickReply, undefined); // 元は変えない
  assert.deepEqual(withQuickReply([]), []);
  const own = [{ type: 'text', text: 'x', quickReply: { items: [] } }];
  assert.deepEqual(withQuickReply(own), own);
});

test('ボタンが送る文字は全て合言葉として受け付けられる', () => {
  for (const b of QUICK_REPLY_BUTTONS) {
    const canon = canonicalCommand(b.text);
    assert.ok(COMMANDS.some((c) => c.text === canon), b.text);
  }
});

test('lib/quick-reply.js(Pi・Actions 用)は Worker と同じボタン一覧', () => {
  assert.deepEqual(libQuickReply.QUICK_REPLY_BUTTONS, QUICK_REPLY_BUTTONS);
  assert.deepEqual(libQuickReply.buildQuickReply(), buildQuickReply());
  assert.deepEqual(libQuickReply.withQuickReply([{ type: 'text', text: 'a' }]), withQuickReply([{ type: 'text', text: 'a' }]));
});

test('replyMessages / pushMessages: 送る本文の最後のメッセージにクイックリプライが付く', async () => {
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); };
  try {
    await replyMessages('tok', 'rt', [{ type: 'text', text: 'hi' }]);
    await pushMessages('tok', 'G', [{ type: 'text', text: '1' }, { type: 'text', text: '2' }]);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(bodies[0].messages[0].quickReply.items.length, 6);
  assert.equal(bodies[1].messages[0].quickReply, undefined);
  assert.equal(bodies[1].messages[1].quickReply.items.length, 6);
});
