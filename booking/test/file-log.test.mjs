import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileLog } from '../src/file-log.js';

test('JST の日付ごとのファイルに追記し、日付が変わったら切り替え、7 日より古いものを消す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-log-'));
  // 古いファイルを用意(8 日前と 6 日前)
  fs.writeFileSync(path.join(dir, 'server-2026-10-17.log'), 'old\n');
  fs.writeFileSync(path.join(dir, 'server-2026-10-19.log'), 'keep\n');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'x');
  let t = Date.UTC(2026, 9, 25, 14, 59, 0); // JST 10/25 23:59
  const fl = createFileLog({ dir, now: () => t });
  fl.write('a');
  t += 2 * 60 * 1000; // JST 10/26 00:01
  fl.write('b');
  fl.close();
  assert.equal(fs.readFileSync(path.join(dir, 'server-2026-10-25.log'), 'utf8'), 'a\n');
  assert.equal(fs.readFileSync(path.join(dir, 'server-2026-10-26.log'), 'utf8'), 'b\n');
  assert.equal(fs.existsSync(path.join(dir, 'server-2026-10-17.log')), false, '8 日前は消える');
  assert.equal(fs.existsSync(path.join(dir, 'server-2026-10-19.log')), true, '6 日前は残る(10/26 時点で 7 日)');
  assert.equal(fs.existsSync(path.join(dir, 'other.txt')), true, '別のファイルは触らない');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dir が無ければ何もしない。書けない場所でも例外を出さず 1 回だけ知らせる', () => {
  const none = createFileLog({ dir: '' });
  none.write('x');
  const logs = [];
  const bad = createFileLog({ dir: '/proc/no-such-dir/logs', log: (m) => logs.push(m) });
  bad.write('x');
  bad.write('y');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /ログファイルに書けません/);
});
