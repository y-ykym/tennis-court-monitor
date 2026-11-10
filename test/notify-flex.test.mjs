import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildFlexMessages } = require('../lib/notify.js');
const { jstTodayYmd, ymdToIso } = require('../lib/date.js');

const find = (n, pred, out = []) => {
  if (!n || typeof n !== 'object') return out;
  if (pred(n)) out.push(n);
  for (const c of n.contents || []) find(c, pred, out);
  return out;
};
const dayOffset = (n) => {
  const [y, m, d] = ymdToIso(jstTodayYmd()).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const slot = (date, h, facility, count) => ({ date, time: `${String(h).padStart(2, '0')}:00-${String(h + 2).padStart(2, '0')}:00`, facility, count });

test('空き通知カード(2026-11-10): 日ごとに日付タイル 1 つ。「明後日」「取消にペナルティ」は日付の右隣に 1 回だけ', () => {
  const near = dayOffset(2); // ペナルティ期間(今日+3 日以内)
  const far = dayOffset(6);
  const [msg] = buildFlexMessages([slot(near, 9, '猿江恩賜公園', 1), slot(near, 13, '木場公園', 2), slot(far, 15, '大島小松川公園', 1)]);
  const b = msg.contents;
  assert.equal(b.size, 'mega');
  assert.equal(b.header.backgroundColor, '#15803D', '帯は緑(白文字が読める濃さ)');
  assert.deepEqual(find(b.header, (n) => n.type === 'text').map((n) => [n.text, n.size]), [['🎾 新しい空き 3件', 'lg']], '題だけ(日付範囲は出さない)');
  assert.equal(b.footer, undefined);
  const tiles = find(b.body, (n) => n.width === '58px');
  assert.equal(tiles.length, 2, '同じ日の 2 枠はタイル 1 つ');
  const spans = find(b.body, (n) => n.type === 'span').map((n) => n.text);
  assert.equal(spans.filter((t) => t === '明後日').length, 1);
  assert.equal(spans.filter((t) => t.includes('取消にペナルティ')).length, 1, '枠ごとに繰り返さない');
  assert.ok(spans.includes('9:00 - 11:00') && spans.includes('\n猿江恩賜公園'), '時間 / 公園名');
  assert.deepEqual(find(b.body, (n) => n.type === 'text' && /面$/.test(n.text || '')).map((n) => [n.text, n.size]), [['残1面', 'xs'], ['2面', 'xs'], ['残1面', 'xs']]);
  assert.equal(find(b.body, (n) => n.size === 'xxs').length, 0, '11px の文字は使わない');
});
