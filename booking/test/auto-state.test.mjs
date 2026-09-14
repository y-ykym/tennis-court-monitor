import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutoState } from '../src/auto-state.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'as-')), 'auto-state.json');

test('初回起動: 状態ファイルが無ければ既知の枠を取り直す(needsBaseline)。保存後の再起動なら差分を続ける', () => {
  const file = tmp();
  let t = 1_000_000;
  const s1 = createAutoState({ file, now: () => t });
  assert.equal(s1.needsBaseline(), true);
  s1.setKnown(['1040|2026-09-25|19:00']);
  s1.markAttempt('k1', 'queued');
  s1.addOwn({ key: 'k2', person: 'A', date: '2026-09-27' });
  s1.save();
  assert.equal(s1.needsBaseline(), false);

  t += 60_000; // 1 分後に再起動(Docker の作り直し等)
  const s2 = createAutoState({ file, now: () => t });
  assert.equal(s2.needsBaseline(), false, '新しい状態なら既知を引き継ぐ');
  assert.deepEqual([...s2.knownKeys()], ['1040|2026-09-25|19:00']);
  assert.equal(s2.attemptStatus('k1'), 'queued');
  assert.equal(s2.own().length, 1);

  t += 11 * 60_000; // 11 分止まっていた
  const s3 = createAutoState({ file, now: () => t });
  assert.equal(s3.needsBaseline(), true, '古い状態なら暴走防止のため既知を取り直す');
  assert.equal(s3.knownKeys().size, 0);
  assert.equal(s3.attemptStatus('k1'), 'queued', '試行記録と自分の予約は引き継ぐ');
});

test('prune: 2 日より古い試行記録と過ぎた自分の予約を落とす。壊れたファイルはまっさら', () => {
  const file = tmp();
  let t = Date.parse('2026-09-14T00:00:00Z');
  const s = createAutoState({ file, now: () => t });
  s.markAttempt('old', 'taken');
  s.addOwn({ key: 'past', person: 'A', date: '2026-09-13' });
  s.addOwn({ key: 'future', person: 'A', date: '2026-09-20' });
  t += 3 * 86400_000;
  s.markAttempt('new', 'taken');
  s.prune('2026-09-17');
  assert.equal(s.attemptStatus('old'), null);
  assert.equal(s.attemptStatus('new'), 'taken');
  assert.deepEqual(s.own().map((o) => o.key), ['future']);
  fs.writeFileSync(file, '{broken');
  const b = createAutoState({ file, now: () => t });
  assert.equal(b.needsBaseline(), true);
});
