// lib/scrape.js の createPersistentScraper(週別セッションを持ち続ける取り方)のテスト。通信は偽のセッションで置き換える
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// 失敗応答の保存先(debug/)にテストの偽応答を溜めない。lib/scrape.js は読み込み時に環境変数を見るので require より前に設定する
process.env.SCRAPE_DEBUG_DIR = '';
const { createPersistentScraper } = require('../lib/scrape.js');

const PARKS = [
  { name: '猿江恩賜公園', code: '1040' },
  { name: '亀戸中央公園', code: '1050' },
];
const TOP = '<html><form action="rsvWOpeInstSrchVacantAction.do"></form></html>';
const searchHtml = (park) => `<input name="selectInstCd" value="${park.code}0030"><input name="selectBldCd" value="${park.code}"><input name="selectBldName" value="${park.name}">`;
const weekJson = (useDay, n = 1) =>
  JSON.stringify({ result: [{ timeResult: [{ alt: '空き', useDay: Number(useDay), startTime: 900, endTime: 1100, rsvNum: n }, { alt: '予約あり', useDay: Number(useDay), startTime: 1100, endTime: 1300, rsvNum: 0 }] }] });

// 偽のサイト。セッションごとに「どの公園の検索を載せたか」を覚え、週の要求に JSON を返す。
// hooks.week(session, form) で応答を差し替えられる(空応答・エラーの再現)
function fakeSite(hooks = {}) {
  const site = { sessions: [], inflight: 0, maxInflight: 0, calls: { top: 0, search: 0, week: 0 } };
  site.createSession = () => {
    const session = { park: null, id: site.sessions.length };
    site.sessions.push(session);
    return async (pathname, form) => {
      site.inflight++;
      site.maxInflight = Math.max(site.maxInflight, site.inflight);
      await new Promise((r) => setTimeout(r, 2));
      site.inflight--;
      if (pathname === '/web/index.jsp') {
        site.calls.top++;
        return TOP;
      }
      if (pathname === '/web/rsvWOpeInstSrchVacantAction.do') {
        site.calls.search++;
        session.park = PARKS.find((p) => p.code === form.selectAreaBcd);
        return searchHtml(session.park);
      }
      if (pathname === '/web/rsvWOpeInstSrchVacantAjaxAction.do') {
        site.calls.week++;
        if (hooks.week) {
          const r = hooks.week(session, form);
          if (r !== undefined) return r;
        }
        return weekJson(form.useDay);
      }
      throw new Error(`unexpected ${pathname}`);
    };
  };
  return site;
}

function make(site, extra = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const scrape = createPersistentScraper({
    parks: PARKS, weeksPerPark: 2, createSession: site.createSession, now: clock.now, todayYmd: () => extra.today || '20261025', log: () => {}, ...extra,
  });
  return { scrape, clock };
}

test('初回は 公園×週 のセッションを作って同時に取り、2 回目はセッションを使い回して週だけ取る', async () => {
  const site = fakeSite();
  const { scrape } = make(site);
  const slots = await scrape();
  // 2 公園 × 2 週、各週に空き 1 件
  assert.equal(slots.length, 4);
  assert.deepEqual(slots[0], { facility: '猿江恩賜公園', date: '2026-10-25', time: '09:00-11:00', count: 1 });
  assert.ok(slots.some((s) => s.facility === '亀戸中央公園' && s.date === '2026-11-01'));
  assert.deepEqual(site.calls, { top: 4, search: 4, week: 4 });
  assert.equal(site.maxInflight, 4, '全セッションが同時に動く');
  assert.deepEqual(scrape.stats(), { sessions: 4, created: 4 });

  await scrape();
  assert.deepEqual(site.calls, { top: 4, search: 4, week: 8 }, '2 回目は top・検索を呼ばない');
  assert.deepEqual(scrape.stats(), { sessions: 4, created: 4 });
});

test('concurrency を絞ると同時に動く本数がその数に収まる', async () => {
  const site = fakeSite();
  const { scrape } = make(site, { concurrency: 2 });
  await scrape();
  assert.equal(site.maxInflight, 2);
  assert.equal(site.calls.week, 4);
});

test('空の応答(JSON でない)はそのセッションを捨てて新しいセッションで取り直す', async () => {
  let failOnce = true;
  const site = fakeSite({
    week(session) {
      if (failOnce && session.park.code === '1040') {
        failOnce = false;
        return ''; // 同一セッションに同時要求したときに都サイトが返す 0 バイト
      }
    },
  });
  const { scrape } = make(site);
  const slots = await scrape();
  assert.equal(slots.length, 4);
  assert.deepEqual(scrape.stats(), { sessions: 4, created: 5 }, '1 本だけ作り直した');
  assert.equal(site.calls.week, 5);
});

test('行の無い JSON(セッション未認識)も作り直しの対象', async () => {
  let n = 0;
  const site = fakeSite({ week: () => (n++ === 0 ? JSON.stringify({ result: [] }) : undefined) });
  const { scrape } = make(site);
  assert.equal((await scrape()).length, 4);
  assert.equal(scrape.stats().created, 5);
});

test('同じ週が 3 回続けて失敗したら公園名入りのエラーで照会全体が失敗する。他の週は最後まで取り終える', async () => {
  const site = fakeSite({ week: (session, form) => (session.park.code === '1050' && form.useDay === '20261101' ? '<html>error</html>' : undefined) });
  const { scrape } = make(site);
  await assert.rejects(scrape(), /亀戸中央公園 の取得に失敗: 週データがJSONではありません/);
  // 失敗した週は 3 回(セッション 3 本)、他の 3 週は 1 回ずつ
  assert.equal(site.calls.week, 6);
  assert.equal(site.inflight, 0, '投げ出した通信が残っていない');
  assert.deepEqual(scrape.stats(), { sessions: 3, created: 6 }, '失敗したセッションは持たない');
});

test('セッションは 30 分で作り直す。日付が変わっても作り直す', async () => {
  const site = fakeSite();
  let today = '20261025';
  const { scrape, clock } = make(site, { todayYmd: () => today });
  await scrape();
  clock.advance(29 * 60 * 1000);
  await scrape();
  assert.equal(scrape.stats().created, 4, '29 分では作り直さない');
  clock.advance(2 * 60 * 1000);
  await scrape();
  assert.equal(scrape.stats().created, 8, '31 分で全部作り直す');
  today = '20261026';
  const slots = await scrape();
  assert.equal(scrape.stats().created, 12, '日付が変わったら作り直す');
  assert.ok(slots.every((s) => s.date >= '2026-10-26'), '新しい日付から取る');
});

test('トップページがメンテナンス画面なら作り直しても取れず、照会全体が失敗する', async () => {
  const site = fakeSite();
  const orig = site.createSession;
  site.createSession = () => {
    const req = orig();
    return async (pathname, form) => (pathname === '/web/index.jsp' ? '<html>メンテナンス中</html>' : req(pathname, form));
  };
  const { scrape } = make(site);
  await assert.rejects(scrape(), /の取得に失敗: トップページが想定外です/);
  assert.equal(scrape.stats().sessions, 0);
});
