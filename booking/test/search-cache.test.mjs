// src/search-cache.js(検索結果の hidden をブラウザの外で前もって取る。2026-11-21)と、reserve.js の mergeSearches のテスト。通信は偽のセッションで置き換える
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearchCache } from '../src/search-cache.js';
import { mergeSearches } from '../src/reserve.js';

const TOP = "<html><!-- pawab2000.jsp --><script>var gRsvWTransUserLoginAction = '/web/rsvWTransUserLoginAction.do';</script></html>";
const week = (park, inst) =>
  `<!doctype html><html><!-- prwrc2000.jsp --><input type="hidden" name="selectBldCd" value="${park}"><input type="hidden" name="selectInstCd" value="${inst}"><input type="hidden" name="selectBldName" value="Park&amp;${park}"><input type="hidden" name="displayNo" value="prwrc2000"></html>`;
const bytes = (s) => new TextEncoder().encode(s).buffer;

function fakeSite(hooks = {}) {
  const site = { sessions: 0, calls: [], concurrent: 0, maxConcurrent: 0 };
  site.makeSession = () => {
    const id = site.sessions++;
    return {
      fetch: async (path, init = {}) => {
        site.calls.push({ id, path, body: init.body || null });
        site.concurrent++;
        site.maxConcurrent = Math.max(site.maxConcurrent, site.concurrent);
        await new Promise((r) => setTimeout(r, 2));
        site.concurrent--;
        if (path === '/web/index.jsp') return { status: 200, arrayBuffer: async () => bytes(TOP) };
        const park = new URLSearchParams(init.body).get('selectAreaBcd');
        const custom = hooks.search ? hooks.search(park) : undefined;
        if (custom instanceof Error) throw custom;
        return { status: 200, arrayBuffer: async () => bytes(custom ?? week(park, `${park}0030`)) };
      },
    };
  };
  return site;
}
// 2026-11-08 12:00 JST から始まる時計
function clockAt(iso = '2026-11-08T03:00:00Z') {
  let t = Date.parse(iso);
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('公園ごとに別のセッションで トップ → 検索 を同時に行い、今日の日付の hidden 一式を持つ', async () => {
  const site = fakeSite();
  const clock = clockAt();
  const cache = createSearchCache({ parks: ['1040', '1050'], makeSession: site.makeSession, now: clock.now });
  assert.deepEqual(cache.current(), {});
  assert.equal(await cache.refresh(), true);
  assert.equal(site.sessions, 2, '公園ごとに別のセッション');
  assert.ok(site.maxConcurrent >= 2, '同時に取る');
  const cur = cache.current();
  assert.deepEqual(Object.keys(cur).sort(), ['1040', '1050']);
  assert.equal(cur['1040'].instCd, '10400030');
  assert.equal(cur['1040'].facility, 'Park&1040');
  assert.equal(cur['1040'].date, '2026-11-08');
  assert.equal(cur['1040'].fields.displayNo, 'prwrc2000');
  const sent = new URLSearchParams(site.calls.find((c) => c.body && c.body.includes('selectAreaBcd=1050')).body);
  assert.equal(sent.get('daystart'), '2026-11-08');
  assert.equal(sent.get('selectPpsClPpscd'), '1000_1030');
  assert.deepEqual(cache.status().parks, ['1040', '1050']);
});

test('一部の公園が取れなくても他は使える。取れなかった公園は前の結果を maxAgeMs まで使い、古くなれば出さない', async () => {
  let fail = false;
  const site = fakeSite({ search: (park) => (fail && park === '1050' ? '<html><!-- pawfa1000.jsp --></html>' : undefined) });
  const clock = clockAt();
  const logs = [];
  const cache = createSearchCache({ parks: ['1040', '1050'], makeSession: site.makeSession, now: clock.now, log: (m) => logs.push(m), maxAgeMs: 20 * 60 * 1000 });
  await cache.refresh();
  fail = true;
  clock.advance(8 * 60 * 1000);
  assert.equal(await cache.refresh(), false);
  assert.deepEqual(Object.keys(cache.current()).sort(), ['1040', '1050'], '1050 は 8 分前の結果がまだ使える');
  assert.ok(logs.some((l) => l.includes('取れなかった公園あり') && l.includes('1050')));
  clock.advance(13 * 60 * 1000);
  await cache.refresh();
  assert.deepEqual(Object.keys(cache.current()), ['1040'], '1050 は 21 分前の結果なので使わない');
});

test('日付が変わったら前日の結果は出さない(取り直すまで、予約の手続きがその場で検索する)', async () => {
  const site = fakeSite();
  const clock = clockAt('2026-11-08T14:55:00Z'); // 23:55 JST
  const cache = createSearchCache({ parks: ['1040'], makeSession: site.makeSession, now: clock.now });
  await cache.refresh();
  assert.deepEqual(Object.keys(cache.current()), ['1040']);
  clock.advance(6 * 60 * 1000); // 0:01 JST
  assert.deepEqual(cache.current(), {});
  await cache.refresh();
  assert.equal(cache.current()['1040'].date, '2026-11-09');
});

test('start: すぐ 1 回取り、成功なら refreshMs 後・失敗なら retryMs 後にもう一度。stop で止まる', async () => {
  let fail = true;
  const site = fakeSite({ search: () => (fail ? new Error('fetch failed') : undefined) });
  const clock = clockAt();
  const scheduled = [];
  const timers = { setTimeout: (fn, ms) => scheduled.push({ fn, ms }) && scheduled.length, clearTimeout: () => {} };
  const cache = createSearchCache({ parks: ['1040'], makeSession: site.makeSession, now: clock.now, timers, refreshMs: 480000, retryMs: 60000 });
  cache.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(scheduled.at(-1).ms, 60000, '失敗したので 1 分後');
  fail = false;
  await scheduled.at(-1).fn();
  assert.equal(scheduled.at(-1).ms, 480000, '成功したので 8 分後');
  assert.deepEqual(Object.keys(cache.current()), ['1040']);
  cache.stop();
  const n = scheduled.length;
  await scheduled.at(-1).fn();
  assert.equal(scheduled.length, n, '止めた後は次を予約しない');
});

test('mergeSearches: ブラウザの先取り(ログイン画面)に、外で取った検索結果を足す。今日のものだけ。足すものが無ければそのまま', () => {
  const S = (date) => ({ park: '1040', instCd: '10400030', facility: 'x', fields: { a: '1' }, date });
  const warm = { ok: true, loginFields: { loginJKey: 'K' }, loginRecaptcha: false, search: null, searches: {} };
  const m = mergeSearches(warm, { 1040: S('2026-11-08'), 1050: S('2026-11-07'), 1060: null }, '2026-11-08');
  assert.equal(m.loginFields.loginJKey, 'K');
  assert.deepEqual(Object.keys(m.searches), ['1040'], '前日のもの・空のものは足さない');
  // 先に起こしたブラウザが無くても(null)、検索だけは使える。ログイン画面は予約のときに取る
  const alone = mergeSearches(null, { 1040: S('2026-11-08') }, '2026-11-08');
  assert.equal(alone.loginFields, null);
  assert.equal(alone.searches['1040'].instCd, '10400030');
  assert.equal(mergeSearches(warm, null, '2026-11-08'), warm);
  assert.equal(mergeSearches(null, {}, '2026-11-08'), null);
});
