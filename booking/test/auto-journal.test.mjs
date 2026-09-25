import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutoJournal, JOURNAL_KEEP_DAYS } from '../src/auto-journal.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aj-')), 'auto-journal.json');
const DAY = 86400000;
// 2026-09-25(金) JST 22:30
const T0 = Date.parse('2026-09-25T13:30:00Z');

test('日ごとの集計は JST の日付で分かれ、保存すると再起動後も残る', () => {
  const file = tmp();
  let t = T0;
  const j = createAutoJournal({ file, now: () => t });
  j.countRestart();
  j.countCycle({ ok: true, newSlots: 2 });
  j.countCycle({ ok: false });
  j.countHeartbeat(false);
  j.countHeartbeat(true);
  j.addEvent({ status: 'success', key: '1040|2026-10-09|19:00', person: 'B', date: '2026-10-09', start: '19:00', facility: '猿江恩賜公園' });
  t += 2 * 3600 * 1000; // 00:30 JST → 翌日(9/26)
  j.countCycle({ ok: true });
  j.addEvent({ status: 'taken', key: '1160|2026-10-18|19:00', person: 'B', date: '2026-10-18', start: '19:00', facility: '東綾瀬公園', message: '先に取られました' });
  j.save();

  const again = createAutoJournal({ file, now: () => t });
  const s = again.summary({ days: 7, nowMs: t });
  assert.deepEqual([s.from, s.to], ['2026-09-20', '2026-09-26']);
  assert.equal(s.days.length, 7);
  const d25 = s.days.find((d) => d.date === '2026-09-25');
  const d26 = s.days.find((d) => d.date === '2026-09-26');
  assert.deepEqual(d25, { date: '2026-09-25', cycles: 2, failed: 1, heartbeatFailed: 1, newSlots: 2, restarts: 1 });
  assert.deepEqual(d26, { date: '2026-09-26', cycles: 1, failed: 0, heartbeatFailed: 0, newSlots: 0, restarts: 0 });
  assert.deepEqual(s.days.find((d) => d.date === '2026-09-20'), { date: '2026-09-20', cycles: 0, failed: 0, heartbeatFailed: 0, newSlots: 0, restarts: 0 }, '記録のない日は 0 で埋める');
  assert.deepEqual(s.events.map((e) => e.status), ['success', 'taken']);
  assert.equal(s.events[1].message, '先に取られました');
});

test('14 日より古い日と出来事は保存時に落とす。summary の days は最大 14 日', () => {
  const file = tmp();
  let t = T0;
  const j = createAutoJournal({ file, now: () => t });
  j.countCycle({ ok: true });
  j.addEvent({ status: 'success', key: 'old' });
  t += 20 * DAY;
  j.countCycle({ ok: true });
  j.addEvent({ status: 'success', key: 'new' });
  j.save();
  const snap = j.snapshot();
  assert.deepEqual(Object.keys(snap.days), ['2026-10-15']);
  assert.deepEqual(snap.events.map((e) => e.key), ['new']);
  assert.equal(j.summary({ days: 99, nowMs: t }).days.length, JOURNAL_KEEP_DAYS);
  assert.equal(j.summary({ days: 0, nowMs: t }).days.length, 1);
});

test('壊れたファイル・無いファイルはまっさらから始める', () => {
  const file = tmp();
  fs.writeFileSync(file, '{broken');
  const j = createAutoJournal({ file, now: () => T0 });
  assert.deepEqual(j.snapshot(), { days: {}, events: [] });
  assert.equal(createAutoJournal({ file: path.join(path.dirname(file), 'none.json'), now: () => T0 }).summary({ nowMs: T0 }).events.length, 0);
});
