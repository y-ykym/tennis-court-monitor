import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStaticCache } from '../src/static-cache.js';

const JS = 'https://kouen.sports.metro.tokyo.lg.jp/web/js/paw_common.js';
const CSS = 'https://kouen.sports.metro.tokyo.lg.jp/web/css/fgnp.min.css';
const JS2 = 'https://kouen.sports.metro.tokyo.lg.jp/web/js/prwea1000.js';

test('控える対象は都サイトの /web/js/*.js(script)だけ。CSS は控えない', () => {
  const c = createStaticCache();
  assert.equal(c.isCacheable(JS, 'script'), true);
  assert.equal(c.isCacheable(CSS, 'stylesheet'), false, 'CSS は高速経路で読まないので対象外(本人決定)');
  assert.equal(c.isCacheable(JS + '?v=1', 'script'), true, 'クエリ付きも対象');
  assert.equal(c.isCacheable('https://kouen.sports.metro.tokyo.lg.jp/web/index.jsp', 'document'), false);
  assert.equal(c.isCacheable('https://kouen.sports.metro.tokyo.lg.jp/web/rsvWOpeInstSrchVacantAjaxAction.do', 'fetch'), false);
  assert.equal(c.isCacheable('https://www.google.com/recaptcha/api.js', 'script'), false, 'Google は対象外');
  assert.equal(c.isCacheable(JS, 'xhr'), false);
});

test('put/get と、ディスクへの保存・読み戻し', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-cache-'));
  let t = 1_000_000;
  const c = createStaticCache({ dir, now: () => t });
  c.start();
  assert.equal(c.get(JS), null);
  c.put(JS, Buffer.from('var a=1;'), 'application/javascript;charset=Shift_JIS', 'W/"x"');
  const e = c.get(JS);
  assert.equal(e.body.toString(), 'var a=1;');
  assert.equal(e.contentType, 'application/javascript;charset=Shift_JIS');
  assert.deepEqual(c.stats(), { entries: 1, hits: 1, misses: 1, refreshed: 0 });
  c.stop();
  // 別のインスタンスで読み戻す
  const c2 = createStaticCache({ dir, now: () => t });
  c2.start();
  assert.equal(c2.get(JS).body.toString(), 'var a=1;');
  assert.equal(c2.get(JS).etag, 'W/"x"');
  c2.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('24 時間たった控えは裏で取り直す(ETag が同じなら本体は取らない)。新しい控えは触らない', async () => {
  let t = 1_000_000;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, inm: init.headers['if-none-match'] });
    if (url === JS) return { status: 304, ok: false, headers: new Map() };
    return { status: 200, ok: true, headers: new Map([['content-type', 'application/javascript'], ['etag', 'W/"new"']]), arrayBuffer: async () => Buffer.from('var b=2;') };
  };
  const logs = [];
  const c = createStaticCache({ fetchImpl, now: () => t, log: (m) => logs.push(m) });
  c.put(JS, 'old js', 'application/javascript', 'W/"js"');
  c.put(JS2, 'old js2', 'application/javascript', 'W/"js2"');
  t += 23 * 60 * 60 * 1000;
  assert.equal(await c.refreshStale(), 0);
  assert.equal(calls.length, 0, '23 時間では取り直さない');
  t += 2 * 60 * 60 * 1000;
  const n = await c.refreshStale();
  assert.equal(n, 1, '2 本目だけ本体を取り直した(1 本目は 304)');
  assert.deepEqual(calls.map((x) => [x.url, x.inm]), [[JS, 'W/"js"'], [JS2, 'W/"js2"']]);
  assert.equal(c.get(JS).body.toString(), 'old js');
  assert.equal(c.get(JS).fetchedAt, t, '304 でも取得時刻は更新');
  assert.equal(c.get(JS2).body.toString(), 'var b=2;');
  assert.equal(c.get(JS2).etag, 'W/"new"');
  assert.equal(c.stats().refreshed, 1);
});

test('取り直しに失敗しても控えはそのまま残る', async () => {
  let t = 1_000_000;
  const c = createStaticCache({ fetchImpl: async () => { throw new Error('fetch failed'); }, now: () => t });
  c.put(JS, 'old', 'application/javascript');
  t += 25 * 60 * 60 * 1000;
  assert.equal(await c.refreshStale(), 0);
  assert.equal(c.get(JS).body.toString(), 'old');
});
