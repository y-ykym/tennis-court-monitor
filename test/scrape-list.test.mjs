// lib/scrape.js の createListScraper(空いている枠だけ返る一覧 JSON を公園ごとに取る。2026-11-08)のテスト。通信は偽のセッションで置き換える
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.SCRAPE_DEBUG_DIR = '';
const { createListScraper } = require('../lib/scrape.js');

const PARKS = [
  { name: '猿江恩賜公園', code: '1040' },
  { name: '亀戸中央公園', code: '1050' },
];
const TOP = '<html><form action="rsvWOpeInstSrchVacantAction.do"></form></html>';
const rec = (bcd, useYmd, s, e, fieldCnt, extra = {}) => ({ bcd, useYmd, sTime: Number(s.split('|')[0]), eTime: Number(e.split('|').at(-1)), sTimeZones: s, eTimeZones: e, fieldCnt, mediaFlg: 3, ...extra });
const listJson = (results, { all = results.length, next = results.length + 1 } = {}) => JSON.stringify({ all, next, hitcnt: all, results });

// 偽のサイト。hooks.list(session, form) で一覧の応答を差し替えられる
function fakeSite(hooks = {}) {
  const site = { sessions: [], calls: { top: 0, list: 0 }, forms: [] };
  site.createSession = () => {
    const session = { id: site.sessions.length };
    site.sessions.push(session);
    return async (pathname, form) => {
      await new Promise((r) => setTimeout(r, 1));
      if (pathname === '/web/index.jsp') {
        site.calls.top++;
        return TOP;
      }
      if (pathname === '/web/rsvWOpeUnreservedSearchAjaxAction.do') {
        site.calls.list++;
        site.forms.push(form);
        if (hooks.list) {
          const r = hooks.list(session, form);
          if (r !== undefined) return r;
        }
        const bcd = form.selectAreaBcd;
        return listJson(bcd === '1040' ? [rec('1040', 20261109, '1100', '1300', 1), rec('1040', 20261113, '1100|1300', '1300|1500', 1), rec('1040', 20261113, '1300', '1500', 3)] : [rec('1050', 20261110, '900', '1100', 2)]);
      }
      throw new Error(`unexpected ${pathname}`);
    };
  };
  return site;
}

function make(site, extra = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const scrape = createListScraper({ parks: PARKS, createSession: site.createSession, now: clock.now, todayYmd: () => '20261108', log: () => {}, ...extra });
  return { scrape, clock };
}

test('公園ごとに Cookie だけのセッションを作り、一覧 JSON を 1 本ずつ取る。連続した空きは時間帯ごとに分け、同じ日時の面数は足す', async () => {
  const site = fakeSite();
  const { scrape } = make(site);
  const slots = await scrape();
  assert.deepEqual(
    slots.map((s) => `${s.facility} ${s.date} ${s.time} ${s.count}`).sort(),
    ['亀戸中央公園 2026-11-10 09:00-11:00 2', '猿江恩賜公園 2026-11-09 11:00-13:00 1', '猿江恩賜公園 2026-11-13 11:00-13:00 1', '猿江恩賜公園 2026-11-13 13:00-15:00 4'].sort()
  );
  assert.deepEqual(slots.failures, []);
  assert.equal(site.calls.top, 2, '公園ごとに 1 セッション');
  assert.equal(site.calls.list, 2);
  assert.deepEqual(scrape.stats(), { sessions: 2, created: 2 });
  const f = site.forms[0];
  assert.equal(f.displayNo, 'prwre1000');
  assert.equal(f.daystart, '2026-11-08');
  assert.equal(f.days, '28');
  assert.equal(f.limit, '200');
  // 2 回目はセッションを使い回す(トップは取らない)
  await scrape();
  assert.equal(site.calls.top, 2);
  assert.equal(site.calls.list, 4);
});

test('予約ボタンの出ない行(mediaFlg=2)は空きに数えない。続き(next <= all)があれば offset を進めて取る', async () => {
  const site = fakeSite({
    list: (session, form) => {
      if (form.selectAreaBcd !== '1040') return undefined;
      if (form.offset === '0') return listJson([rec('1040', 20261109, '1100', '1300', 1), rec('1040', 20261109, '1500', '1700', 1, { mediaFlg: 2 })], { all: 3, next: 3 });
      return listJson([rec('1040', 20261120, '1900', '2100', 2)], { all: 3, next: 4 });
    },
  });
  const { scrape } = make(site);
  const slots = await scrape();
  const sarue = slots.filter((s) => s.facility === '猿江恩賜公園').map((s) => `${s.date} ${s.time} ${s.count}`).sort();
  assert.deepEqual(sarue, ['2026-11-09 11:00-13:00 1', '2026-11-20 19:00-21:00 2']);
  assert.equal(site.forms.filter((f) => f.selectAreaBcd === '1040').map((f) => f.offset).join(','), '0,3');
});

test('一覧が JSON でない・別の公園のもの(セッション未認識)なら、セッションを捨てて新しいセッションで 3 回までやり直す', async () => {
  let n = 0;
  const site = fakeSite({ list: (session, form) => (form.selectAreaBcd === '1050' && n++ < 2 ? (n === 1 ? '<html>error</html>' : listJson([rec('1040', 20261109, '1100', '1300', 1)])) : undefined) });
  const { scrape } = make(site);
  const slots = await scrape();
  assert.equal(slots.filter((s) => s.facility === '亀戸中央公園').length, 1);
  assert.equal(site.calls.top, 4, '亀戸は 3 本目のセッションで通る(2 回捨てた)');
  assert.deepEqual(slots.failures, []);
});

test('使い回したセッションで空(all=0)なら、新しいセッションで 1 回取り直してから「空きなし」と受け入れる', async () => {
  const site = fakeSite({ list: (session, form) => (form.selectAreaBcd === '1050' ? listJson([]) : undefined) });
  const { scrape } = make(site);
  let slots = await scrape(); // 初回(新しいセッション)は取り直さない
  assert.equal(slots.filter((s) => s.facility === '亀戸中央公園').length, 0);
  assert.equal(site.calls.top, 2);
  slots = await scrape(); // 2 回目(使い回し)で空 → 取り直し 1 回
  assert.equal(site.calls.top, 3);
  assert.equal(site.calls.list, 5, '亀戸は 2 回目に 2 本(使い回し + 取り直し)');
  assert.equal(slots.filter((s) => s.facility === '亀戸中央公園').length, 0);
  assert.deepEqual(slots.failures, []);
});

test('一部の公園だけ 3 回とも失敗したら、取れた分を返して failures(week: null)を添える。全部失敗なら throw', async () => {
  const site = fakeSite({ list: (session, form) => (form.selectAreaBcd === '1050' ? '<html>502</html>' : undefined) });
  const { scrape } = make(site);
  const slots = await scrape();
  assert.equal(slots.length, 3, '猿江の分は返す');
  assert.equal(slots.failures.length, 1);
  assert.equal(slots.failures[0].park.name, '亀戸中央公園');
  assert.equal(slots.failures[0].week, null);
  assert.match(slots.failures[0].error.message, /亀戸中央公園 の取得に失敗: 一覧データがJSONではありません/);
  const all = fakeSite({ list: () => '<html>502</html>' });
  await assert.rejects(make(all).scrape(), /の取得に失敗: 一覧データがJSONではありません/);
});

test('セッションは 作ってから 30 分 か 前回使ってから 8 分 で作り直す', async () => {
  const site = fakeSite();
  const { scrape, clock } = make(site);
  await scrape();
  clock.advance(7 * 60_000);
  await scrape();
  assert.equal(site.calls.top, 2, '7 分なら使い回す');
  clock.advance(9 * 60_000);
  await scrape();
  assert.equal(site.calls.top, 4, '9 分放置で作り直す');
});

test('トップが都サイトの「お知らせ」ページなら目印付きで照会全体を失敗にし、公園を変えてやり直さない', async () => {
  const site = fakeSite();
  const orig = site.createSession;
  const NOTICE = '<html><head><title>施設予約システムからのお知らせ</title></head><body>現在、ご指定のページはアクセスできません。</body></html>';
  site.createSession = () => {
    const req = orig();
    return async (pathname, form) => (pathname === '/web/index.jsp' ? NOTICE : req(pathname, form));
  };
  const { scrape } = make(site);
  await assert.rejects(scrape(), (e) => {
    assert.equal(e.siteNotice, true);
    return true;
  });
  assert.ok(site.calls.top <= 3);
  assert.equal(scrape.stats().sessions, 0);
});
