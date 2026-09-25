// フェーズ3 自動予約の週報のテスト(Pi の /auto/report は偽の fetch 関数で受け止め、LINE へは行かない)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReport, buildAutoReportFlex, autoReportText, autoReportAltText, runWeeklyReport, fetchAutoReport, reasonOf, WEEKLY_REPORT_CRON, MSG_REPORT_UNAVAILABLE } from '../src/auto-report.js';
import { bubbleBytes } from '../src/flex.js';

// 2026-09-28(月) 9:00 JST = 0:00 UTC
const NOW = Date.parse('2026-09-28T00:00:00Z');
const H = 3600 * 1000;
const at = (isoJst) => Date.parse(`${isoJst}+09:00`);
const day = (date, cycles, failed = 0, extra = {}) => ({ date, cycles, failed, heartbeatFailed: 0, newSlots: 0, restarts: 0, ...extra });

function sampleReport() {
  return {
    mode: 'on',
    enabled: true,
    startedAt: at('2026-09-25T22:19:00'),
    now: NOW,
    lastCycle: { at: NOW - 2 * 60 * 1000, ms: 40000, error: null, newSlots: 0 },
    authPaused: [],
    from: '2026-09-21',
    to: '2026-09-28',
    days: [
      day('2026-09-21', 1300, 10, { newSlots: 4 }),
      day('2026-09-22', 1310, 12, { newSlots: 6 }),
      day('2026-09-23', 1290, 8),
      day('2026-09-24', 1250, 20, { restarts: 2, newSlots: 5 }),
      day('2026-09-25', 1200, 90, { heartbeatFailed: 30, restarts: 1, newSlots: 7 }),
      day('2026-09-26', 1320, 5, { newSlots: 3 }),
      day('2026-09-27', 1330, 3, { newSlots: 2 }),
      day('2026-09-28', 400, 1, { newSlots: 1 }), // 今日(月曜 9:00 まで)は集計に入れない
    ],
    events: [
      { at: at('2026-09-25T13:40:58'), status: 'success', key: '1040|2026-10-09|19:00', person: 'B', date: '2026-10-09', start: '19:00', facility: '猿江恩賜公園' },
      { at: at('2026-09-25T17:30:43'), status: 'success', key: '1040|2026-10-13|19:00', person: 'B', date: '2026-10-13', start: '19:00', facility: '猿江恩賜公園' },
      { at: at('2026-09-25T17:55:00'), status: 'taken', key: '1050|2026-10-03|15:00', person: 'A', date: '2026-10-03', start: '15:00', facility: '亀戸中央公園', message: '先に取られました' },
      { at: at('2026-09-26T02:01:00'), status: 'taken', key: '1160|2026-10-18|19:00', person: 'A', date: '2026-10-18', start: '19:00', facility: '東綾瀬公園' },
      { at: at('2026-09-24T23:16:00'), status: 'dry_run', key: '1050|2026-10-12|09:00', person: 'A', date: '2026-10-12', start: '09:00', facility: '亀戸中央公園' },
      { at: at('2026-09-23T10:00:00'), status: 'conflict', key: '1050|2026-10-04|11:00', person: 'A', date: '2026-10-04', start: '11:00', facility: '亀戸中央公園', message: '直前に別の場所の予定' },
      { at: at('2026-09-23T10:05:00'), status: 'skipped_deadline', key: '1050|2026-09-27|11:00', person: 'A', date: '2026-09-27', start: '11:00', facility: '亀戸中央公園' },
      { at: at('2026-09-28T08:00:00'), status: 'success', key: '1160|2026-10-20|19:00', person: 'B', date: '2026-10-20', start: '19:00', facility: '東綾瀬公園' }, // 今日の分(来週に載る)
      { at: at('2026-09-20T08:00:00'), status: 'success', key: '1160|2026-09-30|19:00', person: 'B', date: '2026-09-30', start: '19:00', facility: '東綾瀬公園' }, // 先々週の分
    ],
    own: [
      { key: '1050|2026-09-27|17:00', person: 'A', date: '2026-09-27', start: '17:00', end: '19:00', park: '1050', facility: '亀戸中央公園' }, // 過ぎた
      { key: '1040|2026-10-13|19:00', person: 'B', date: '2026-10-13', start: '19:00', end: '21:00', park: '1040', facility: '猿江恩賜公園' },
      { key: '1040|2026-10-09|19:00', person: 'B', date: '2026-10-09', start: '19:00', end: '21:00', park: '1040', facility: '猿江恩賜公園' },
    ],
  };
}

test('集計: 前の週(月〜日)の 7 日分だけ。今日と先々週の出来事は入れない。成立・理由別の見送り・照会の合計・今後の予約', () => {
  const m = summarizeReport(sampleReport(), { now: NOW });
  assert.deepEqual([m.from, m.to], ['2026-09-21', '2026-09-27']);
  assert.equal(m.days.length, 7);
  assert.equal(m.cycles, 1300 + 1310 + 1290 + 1250 + 1200 + 1320 + 1330);
  assert.equal(m.failed, 148);
  assert.equal(m.heartbeatFailed, 30);
  assert.equal(m.restarts, 3);
  assert.equal(m.newSlots, 27);
  assert.deepEqual(m.successes.map((s) => `${s.date} ${s.start} ${s.person}`), ['2026-10-09 19:00 B', '2026-10-13 19:00 B']);
  assert.deepEqual(m.misses.map((x) => `${x.key}:${x.count}`), ['taken:2', 'conflict:1', 'dry_run:1', 'not_target:1']);
  assert.equal(m.missTotal, 5);
  assert.deepEqual(m.upcoming.map((s) => `${s.date} ${s.person}`), ['2026-10-09 B', '2026-10-13 B'], '過ぎた予約は出さず、日付順');
  assert.deepEqual([m.status.mode, m.status.stale], ['on', false]);
  assert.deepEqual(m.warnings, [], '正常なら気になる点なし');
});

test('気になる点: OFF・照会が古い・失敗率・照会の無い日・再起動・ログイン拒否・テニスベア・合図の失敗', () => {
  const rep = sampleReport();
  rep.mode = 'paused';
  rep.lastCycle.at = NOW - 40 * 60 * 1000;
  rep.days[2].cycles = 0; // 9/23 に照会なし
  rep.days[1].failed = 1310; // 失敗率を 20% 以上に
  rep.days[4].failed = 1000;
  rep.days[1].heartbeatFailed = 900;
  rep.days[0].restarts = 5;
  rep.authPaused = ['A'];
  rep.events.push({ at: at('2026-09-22T10:00:00'), status: 'skipped_tennisbear', key: 'k', person: 'B', date: '2026-10-05', start: '19:00', facility: '猿江恩賜公園' });
  rep.events.push({ at: at('2026-09-22T11:00:00'), status: 'auth_error', key: 'k2', person: 'B', date: '2026-10-05', start: '19:00', facility: '猿江恩賜公園' });
  rep.events.push({ at: at('2026-09-22T12:00:00'), status: 'rejected', key: 'k3', person: 'B', date: '2026-10-06', start: '19:00', facility: '猿江恩賜公園' });
  for (let i = 0; i < 3; i++) rep.events.push({ at: at('2026-09-22T13:00:00') + i, status: 'error', key: `e${i}`, person: 'B', date: '2026-10-07', start: '19:00', facility: '猿江恩賜公園' });
  const m = summarizeReport(rep, { now: NOW });
  const w = m.warnings.join('\n');
  assert.match(w, /ON になっていません\(「せってい」で OFF になっている\)/);
  assert.match(w, /最後の照会が古いです\(9\/28 08:20\)/);
  assert.match(w, /ログインが拒否されました\(予約者 A・B\)/);
  assert.match(w, /reCAPTCHA/);
  assert.match(w, /照会が 1 回もない日: 9\/23\(水\)/);
  assert.match(w, /照会の失敗が多いです/);
  assert.match(w, /合図の失敗が多いです\(930 回\)/);
  assert.match(w, /再起動が 8 回/);
  assert.match(w, /テニスベアの予定が取れず見送った候補が 1 件/);
  assert.match(w, /サイトのエラーで失敗した候補が 3 件/);
  assert.equal(m.warnings[0].startsWith('自動予約が ON になっていません'), true, 'OFF が一番上');
});

test('reasonOf: skipped_* は「対象外」にまとめる(テニスベアだけ別)。未知の status は「その他」。success は理由なし', () => {
  assert.equal(reasonOf('skipped_deadline'), 'not_target');
  assert.equal(reasonOf('skipped_excluded_slot'), 'not_target');
  assert.equal(reasonOf('skipped_tennisbear'), 'skipped_tennisbear');
  assert.equal(reasonOf('weird'), 'other');
  assert.equal(reasonOf('success'), null);
});

test('カード: 見出し・期間・成立の行(呼び名ラベル)・理由別の件数・照会の失敗率・今後の予約。ボタンは無し。30KB 以内', () => {
  const m = summarizeReport(sampleReport(), { now: NOW });
  const flex = buildAutoReportFlex(m, { labels: { A: 'ゆうたそ', B: 'まきたそ' } });
  assert.equal(flex.type, 'flex');
  const json = JSON.stringify(flex.contents);
  assert.equal(flex.contents.header.contents[0].text, '📋 自動予約の週報');
  assert.equal(flex.contents.header.contents[1].text, '9/21〜9/27');
  assert.match(json, /✅ 気になる点はありません/);
  assert.match(json, /10\/9\(金\) 19:00 猿江恩賜公園/);
  assert.match(json, /まきたそ/);
  assert.doesNotMatch(json, /ゆうたそ/, 'A の成立は無いのでラベルも出ない');
  assert.match(json, /先に他の人に取られた/);
  assert.match(json, /9,000 回/);
  assert.match(json, /148 回\(1\.6%\)/);
  assert.match(json, /稼働中\(最終チェック 08:58\)/);
  assert.doesNotMatch(json, /"type":"button"/);
  assert.doesNotMatch(json, /postback/);
  assert.equal(flex.contents.footer, undefined);
  assert.ok(bubbleBytes(flex.contents) < 28000);
  assert.equal(flex.altText, autoReportAltText(m));
  assert.match(flex.altText, /^📋 自動予約の週報\(9\/21〜9\/27\): 成立 2 件・見送り 5 件・照会失敗 1\.6%$/);
});

test('カード: 気になる点があれば琥珀色の枡で一番上に。alt にも件数', () => {
  const rep = sampleReport();
  rep.mode = 'paused';
  const m = summarizeReport(rep, { now: NOW });
  const flex = buildAutoReportFlex(m);
  const first = flex.contents.body.contents[0];
  assert.equal(first.backgroundColor, '#FFF7E6');
  assert.match(first.contents[0].text, /気になる点/);
  assert.match(first.contents[1].text, /ON になっていません/);
  assert.match(flex.altText, /⚠ 気になる点 1 件/);
  assert.match(JSON.stringify(flex.contents), /OFF\(せってい\)/);
});

test('テキスト版: 同じ中身を行で', () => {
  const m = summarizeReport(sampleReport(), { now: NOW });
  const t = autoReportText(m, { labels: { A: 'ゆうたそ', B: 'まきたそ' } });
  assert.match(t, /^📋 自動予約の週報\(9\/21\(月\)〜9\/27\(日\)\)/);
  assert.match(t, /成立 2 件\n・10\/9\(金\) 19:00 猿江恩賜公園 まきたそ/);
  assert.match(t, /照会 9000 回\(失敗 148 回・1\.6%\)/);
  assert.match(t, /今後の自動予約: 10\/9\(金\)/);
});

test('runWeeklyReport: Pi の記録を読んでカードを push。Flex が 400 で弾かれたらテキストで送り直す。取れなければ「集計できませんでした」のテキスト', async () => {
  const env = { BOOKING_KV: {}, LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_GROUP_ID: 'C1', LABEL_A: 'ゆうたそ', LABEL_B: 'まきたそ' };
  const pushed = [];
  const plain = [];
  const push = async (_t, to, messages) => pushed.push({ to, messages });
  const pushPlain = async (_t, to, text) => plain.push({ to, text });
  let r = await runWeeklyReport(env, { now: NOW, fetchReport: async () => ({ ok: true, report: sampleReport() }), push, pushPlain });
  assert.deepEqual([r.ok, r.sent], [true, 'flex']);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].to, 'C1');
  assert.equal(pushed[0].messages[0].type, 'flex');
  assert.match(JSON.stringify(pushed[0].messages[0]), /まきたそ/);

  const reject400 = async () => {
    const e = new Error('LINE push失敗: HTTP 400');
    e.status = 400;
    throw e;
  };
  r = await runWeeklyReport(env, { now: NOW, fetchReport: async () => ({ ok: true, report: sampleReport() }), push: reject400, pushPlain });
  assert.deepEqual([r.ok, r.sent], [true, 'text']);
  assert.match(plain.at(-1).text, /自動予約の週報/);

  const reject429 = async () => {
    const e = new Error('LINE push失敗: HTTP 429');
    e.status = 429;
    throw e;
  };
  await assert.rejects(() => runWeeklyReport(env, { now: NOW, fetchReport: async () => ({ ok: true, report: sampleReport() }), push: reject429, pushPlain }), /429/, '通数上限は握りつぶさない');

  r = await runWeeklyReport(env, { now: NOW, fetchReport: async () => ({ ok: false, reason: 'テスト理由' }), push, pushPlain });
  assert.deepEqual([r.ok, r.sent], [false, 'text']);
  assert.equal(plain.at(-1).text, MSG_REPORT_UNAVAILABLE('テスト理由'));
  assert.equal(pushed.length, 1, 'カードは送らない');
});

test('fetchAutoReport: KV に URL が無ければ失敗。トンネル越しに /auto/report?days=8 を読み、応答が古い形なら失敗の理由に出す', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return { ok: false, status: 502 };
    return { ok: true, json: async () => ({ mode: 'on', days: [], events: [], own: [] }) };
  };
  try {
    const kv = (v) => ({ get: async () => v });
    assert.equal((await fetchAutoReport({ BOOKING_KV: kv(null) })).ok, false);
    const r = await fetchAutoReport({ BOOKING_KV: kv('https://x.trycloudflare.com') }, { retryMs: 1 });
    assert.equal(r.ok, true);
    assert.deepEqual(calls, ['https://x.trycloudflare.com/auto/report?days=8', 'https://x.trycloudflare.com/auto/report?days=8'], '1 回目の 502 は再試行');
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ mode: 'on' }) });
    const old = await fetchAutoReport({ BOOKING_KV: kv('https://x.trycloudflare.com') }, { retryMs: 1, attempts: 1 });
    assert.equal(old.ok, false);
    assert.match(old.reason, /古いコードのままかも/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('cron は月曜 0:00 UTC(= 9:00 JST)', () => {
  assert.equal(WEEKLY_REPORT_CRON, '0 0 * * 1');
});
