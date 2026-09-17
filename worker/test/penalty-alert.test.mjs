// フェーズ4 ペナルティ予告アラートのテスト(送信は偽の push 関数で受け止め、予約サイトへは行かない)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFreeCancelDeadlineToday,
  pickDeadlineToday,
  endOfJstDaySec,
  jstDayIso,
  alertText,
  runPenaltyAlert,
  MSG_ALERT_FETCH_FAILED,
  MORNING_CRON,
  DEADLINE_CRON,
} from '../src/penalty-alert.js';
import { attachCancelData } from '../src/index.js';
import { verifyCancelToken } from '../src/cancel-token.js';

const SECRET = 'test-signing-secret';
const env = {
  CANCEL_ENABLED: '1',
  BOOKING_SIGNING_SECRET: SECRET,
  LINE_CHANNEL_ACCESS_TOKEN: 'token',
  LINE_GROUP_ID: 'Cgroup',
  SITE_USER_A: '10000000',
  SITE_PASS_A: 'pw',
  LABEL_A: 'ゆうたそ',
  SITE_USER_B: '20000000',
  SITE_PASS_B: 'pw',
  LABEL_B: 'B',
};

// JST 2026-09-17(木)の 9:00 と 23:35
const MORNING = Date.parse('2026-09-17T00:00:00Z');
const DEADLINE = Date.parse('2026-09-17T14:35:00Z');
const TODAY = '2026-09-17';
const TOMORROW = '2026-09-18';

const res = (over = {}) => ({ id: '2026000123', date: '2026-09-21', start: '09:00', end: '11:00', facility: '猿江恩賜公園', penaltyDay: 3, ...over });

function nodes(node, type, out = []) {
  if (Array.isArray(node)) node.forEach((n) => nodes(n, type, out));
  else if (node && typeof node === 'object') {
    if (node.type === type) out.push(node);
    Object.values(node).forEach((v) => nodes(v, type, out));
  }
  return out;
}
const allText = (node) => [...nodes(node, 'text'), ...nodes(node, 'span')].map((n) => n.text).filter((t) => typeof t === 'string').join('\n');

test('対象は「利用日 = 今日 + penaltyday + 1」の予約だけ(今日はまだ無料、明日から有料)', () => {
  // 今日 9/17、penaltyday 3 → 9/20 以前は既にペナルティ対象、9/21 が今日中が期限、9/22 以降はまだ猶予あり
  assert.equal(isFreeCancelDeadlineToday(res({ date: '2026-09-20' }), TODAY, TOMORROW), false);
  assert.equal(isFreeCancelDeadlineToday(res({ date: '2026-09-21' }), TODAY, TOMORROW), true);
  assert.equal(isFreeCancelDeadlineToday(res({ date: '2026-09-22' }), TODAY, TOMORROW), false);
  // penaltyday が一覧から取れなかったときは 3 として扱う
  assert.equal(isFreeCancelDeadlineToday(res({ date: '2026-09-21', penaltyDay: null }), TODAY, TOMORROW), true);
  assert.equal(isFreeCancelDeadlineToday({ date: null }, TODAY, TOMORROW), false);
  // penaltyday が違う施設(例 5 日)なら境界もずれる
  assert.equal(isFreeCancelDeadlineToday(res({ date: '2026-09-23', penaltyDay: 5 }), TODAY, TOMORROW), true);
});

test('ボタンの期限は朝に作っても 23:35 に作っても「今日 23:59:59」', () => {
  assert.equal(new Date(endOfJstDaySec(MORNING) * 1000).toISOString(), '2026-09-17T14:59:59.000Z');
  assert.equal(endOfJstDaySec(DEADLINE), endOfJstDaySec(MORNING));
  assert.equal(jstDayIso(DEADLINE), TODAY);
  // 23:35 の時点で残りは 25 分弱
  assert.ok(endOfJstDaySec(DEADLINE) * 1000 - DEADLINE < 25 * 60 * 1000);
});

test('A・B をまとめて日付・開始時刻順に並べ、取得失敗した人は failed に入る', () => {
  const { rows, failed } = pickDeadlineToday(
    [
      { slot: 'A', label: 'ゆうたそ', reservations: [res({ date: '2026-09-21', start: '15:00' }), res({ date: '2026-09-25' })] },
      { slot: 'B', label: 'B', reservations: [res({ date: '2026-09-21', start: '09:00' })] },
    ],
    { today: TODAY, tomorrow: TOMORROW }
  );
  assert.deepEqual(
    rows.map((r) => `${r.label} ${r.reservation.start}`),
    ['B 09:00', 'ゆうたそ 15:00']
  );
  assert.deepEqual(failed, []);

  const withError = pickDeadlineToday(
    [
      { slot: 'A', label: 'ゆうたそ', error: new Error('x') },
      { slot: 'B', label: 'B', reservations: [res()] },
    ],
    { today: TODAY, tomorrow: TOMORROW }
  );
  assert.deepEqual(withError.failed, ['ゆうたそ']);
  assert.equal(withError.rows.length, 1);
});

test('対象があれば Flex を push し、各行に今日 23:59 までのキャンセルボタンが付く', async () => {
  const sent = [];
  const out = await runPenaltyAlert(env, {
    kind: 'morning',
    now: MORNING,
    fetchResults: async () => [
      { slot: 'A', label: 'ゆうたそ', reservations: [res(), res({ date: '2026-09-30', id: '2026000999' })] },
      { slot: 'B', label: 'B', reservations: [] },
    ],
    attach: (results, opts) => attachCancelData(env, results, opts),
    push: async (token, to, messages) => sent.push({ to, messages }),
  });

  assert.deepEqual({ rows: out.rows, failed: out.failed, sent: out.sent }, { rows: 1, failed: [], sent: 'flex' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, env.LINE_GROUP_ID);
  const flex = sent[0].messages[0];
  assert.equal(flex.type, 'flex');
  assert.match(flex.altText, /今日23:59までにキャンセル/);
  assert.match(flex.altText, /ゆうたそ/);
  // 対象外(9/30)は載せない
  const body = allText(flex.contents);
  assert.match(body, /猿江恩賜公園/);
  assert.match(body, /9\/21/);
  assert.doesNotMatch(body, /9\/30/);

  const buttons = nodes(flex.contents, 'postback');
  assert.equal(buttons.length, 1);
  const token = await verifyCancelToken(SECRET, buttons[0].data, MORNING);
  assert.equal(token.kind, 'c');
  assert.equal(token.person, 'A');
  assert.equal(token.date, '2026-09-21');
  assert.equal(token.exp, endOfJstDaySec(MORNING));
  assert.equal(token.expired, false);
  // 日付が変わると押しても「時間切れ」になる
  assert.equal((await verifyCancelToken(SECRET, buttons[0].data, MORNING + 24 * 3600 * 1000)).expired, true);
});

test('対象が 0 件なら何も送らない(朝も 23:35 も)', async () => {
  for (const [kind, now] of [['morning', MORNING], ['deadline', DEADLINE]]) {
    const sent = [];
    const out = await runPenaltyAlert(env, {
      kind,
      now,
      fetchResults: async () => [{ slot: 'A', label: 'ゆうたそ', reservations: [res({ date: '2026-09-30' })] }],
      attach: (results, opts) => attachCancelData(env, results, opts),
      push: async (...args) => sent.push(args),
    });
    assert.deepEqual({ ...out, failed: out.failed.length }, { rows: 0, failed: 0, sent: null });
    assert.equal(sent.length, 0);
  }
});

test('23:35 に予約サイトへ繋がらなかったときだけテキストで知らせる(朝は黙っている)', async () => {
  const failing = [{ slot: 'A', label: 'ゆうたそ', error: new Error('timeout') }];

  const morning = [];
  await runPenaltyAlert(env, { kind: 'morning', now: MORNING, fetchResults: async () => failing, push: async (...a) => morning.push(a) });
  assert.equal(morning.length, 0);

  const night = [];
  const out = await runPenaltyAlert(env, { kind: 'deadline', now: DEADLINE, fetchResults: async () => failing, push: async (t, to, messages) => night.push(messages) });
  assert.equal(out.sent, 'text');
  assert.equal(night[0][0].text, MSG_ALERT_FETCH_FAILED(['ゆうたそ']));

  // 取得そのものが投げた場合も 23:35 なら知らせる
  const thrown = [];
  await runPenaltyAlert(env, {
    kind: 'deadline',
    now: DEADLINE,
    fetchResults: async () => {
      throw new Error('boom');
    },
    push: async (t, to, messages) => thrown.push(messages),
  });
  assert.match(thrown[0][0].text, /確認できませんでした/);
});

test('Flex が 400 で弾かれたらテキストで送り直す', async () => {
  const sent = [];
  const out = await runPenaltyAlert(env, {
    kind: 'deadline',
    now: DEADLINE,
    fetchResults: async () => [{ slot: 'A', label: 'ゆうたそ', reservations: [res()] }],
    attach: (results, opts) => attachCancelData(env, results, opts),
    push: async (token, to, messages) => {
      sent.push(messages);
      if (messages[0].type === 'flex' && sent.length === 1) {
        const e = new Error('bad request');
        e.status = 400;
        throw e;
      }
    },
  });
  assert.equal(out.sent, 'text');
  assert.equal(sent.length, 2);
  assert.equal(sent[1][0].type, 'text');
  assert.match(sent[1][0].text, /まもなく期限/);
  assert.match(sent[1][0].text, /ゆうたそ {2}9\/21\(月\) 9:00-11:00 猿江恩賜公園/);
});

test('テキスト版は朝と 23:35 で書き出しが変わる', () => {
  const rows = [{ label: 'ゆうたそ', reservation: res() }];
  assert.match(alertText(rows, { deadline: false }), /^⏰ 今日 23:59 までに/);
  assert.match(alertText(rows, { deadline: true }), /^⏰ まもなく期限です/);
});

test('cron は JST の 9:00 と 23:35(UTC で書く)', () => {
  assert.equal(MORNING_CRON, '0 0 * * *');
  assert.equal(DEADLINE_CRON, '35 14 * * *');
});

test('23:35 は朝 9:00 と同じ内容(または減っているだけ)なら送らない。朝に無かった予約が増えていれば送る。控えは KV に 1 日分', async () => {
  const store = new Map();
  const kv = { async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } };
  const env2 = { ...env, BOOKING_KV: kv };
  const pushed = [];
  const push = async (_t, _to, messages) => pushed.push(messages);
  const two = [{ slot: 'A', label: 'ゆうたそ', reservations: [res({ id: '1' }), res({ id: '2', start: '13:00', end: '15:00' })] }];
  const one = [{ slot: 'A', label: 'ゆうたそ', reservations: [res({ id: '2', start: '13:00', end: '15:00' })] }];
  const three = [{ slot: 'A', label: 'ゆうたそ', reservations: [res({ id: '1' }), res({ id: '2', start: '13:00', end: '15:00' }), res({ id: '3', start: '15:00', end: '17:00' })] }];

  // 朝: 2 件送る → 控えが残る
  const m = await runPenaltyAlert(env2, { kind: 'morning', now: MORNING, fetchResults: async () => two, push });
  assert.equal(m.sent, 'flex');
  assert.deepEqual(JSON.parse(store.get('penalty_alert_sent')), { date: TODAY, ids: ['1', '2'] });
  // 夜: 同じ 2 件 → 送らない
  const d1 = await runPenaltyAlert(env2, { kind: 'deadline', now: DEADLINE, fetchResults: async () => two, push });
  assert.deepEqual([d1.sent, d1.skipped, pushed.length], [null, 'same_as_morning', 1]);
  // 夜: 1 件取り消して減っただけ → 送らない
  const d2 = await runPenaltyAlert(env2, { kind: 'deadline', now: DEADLINE, fetchResults: async () => one, push });
  assert.deepEqual([d2.sent, pushed.length], [null, 1]);
  // 夜: 日中に自動予約で 1 件増えた → 送る(全件載せる)
  const d3 = await runPenaltyAlert(env2, { kind: 'deadline', now: DEADLINE, fetchResults: async () => three, push });
  assert.equal(d3.sent, 'flex');
  assert.equal(pushed.length, 2);
  assert.match(allText(pushed[1][0].contents), /15:00 - 17:00|15:00-17:00/);
  assert.deepEqual(JSON.parse(store.get('penalty_alert_sent')).ids, ['1', '2', '3']);
  // 別の日の控えは無視して送る
  store.set('penalty_alert_sent', JSON.stringify({ date: '2026-09-16', ids: ['1', '2'] }));
  const d4 = await runPenaltyAlert(env2, { kind: 'deadline', now: DEADLINE, fetchResults: async () => two, push });
  assert.equal(d4.sent, 'flex');
  // 朝に送れていなければ(控えなし)夜は送る。KV が無い環境でも動く
  store.clear();
  const d5 = await runPenaltyAlert(env2, { kind: 'deadline', now: DEADLINE, fetchResults: async () => two, push });
  assert.equal(d5.sent, 'flex');
  const d6 = await runPenaltyAlert(env, { kind: 'deadline', now: DEADLINE, fetchResults: async () => two, push });
  assert.equal(d6.sent, 'flex');
});
