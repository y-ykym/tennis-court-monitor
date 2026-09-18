import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, normalizeEvents, normalizeTime, parseDisplayRange, fetchTennisbearEvents, TennisbearAuthError } from '../src/tennisbear.js';

// 2026-09-17 に実機で見た 1 件の形(要件定義書 §15.3)
const RAW = {
  id: 1621297,
  eventTitle: 'ストローク多め練',
  datetimeForDisplay: '9/22(火祝) 19:00-21:00',
  startDatetimeString: '2026-09-22T19:00:00.000+09:00',
  place: { code: '0100010009', name: '亀戸中央公園テニスコート' },
  myInfo: { isOrganizer: false },
};

test('tennisbear: 1 件を都の予約と同じ形に(0 埋めの HH:MM・終了時刻は表示文字列から)', () => {
  assert.deepEqual(normalizeEvent(RAW), {
    source: 'tennisbear',
    id: '1621297',
    title: 'ストローク多め練',
    date: '2026-09-22',
    start: '19:00',
    end: '21:00',
    facility: '亀戸中央公園テニスコート',
    placeCode: '0100010009',
    organizer: false,
  });
  // 朝 9 時: 表示は "9:00" でも start/end は "09:00"(都の予約と桁を揃えないと日付順がずれる)
  const morning = normalizeEvent({ ...RAW, datetimeForDisplay: '9/27(日) 9:00-11:00', startDatetimeString: '2026-09-27T09:00:00.000+09:00', myInfo: { isOrganizer: true } });
  assert.equal(morning.start, '09:00');
  assert.equal(morning.end, '11:00');
  assert.equal(morning.organizer, true);
  // place が無い件でも落ちず、placeCode は空文字(courts.js の突き合わせはコート名に落ちる)
  assert.equal(normalizeEvent({ ...RAW, place: null }).placeCode, '');
});

test('tennisbear: 時刻・表示文字列の解析(全角コロン・波ダッシュ・不正値)', () => {
  assert.equal(normalizeTime('9:00'), '09:00');
  assert.equal(normalizeTime('19：30'), '19:30');
  assert.equal(normalizeTime('25:00'), '');
  assert.equal(normalizeTime(undefined), '');
  assert.deepEqual(parseDisplayRange('9/22(火祝) 19:00〜21:00'), { start: '19:00', end: '21:00' });
  assert.deepEqual(parseDisplayRange('9/22(火祝) 19:00'), { start: '', end: '' });
  assert.deepEqual(parseDisplayRange(null), { start: '', end: '' });
});

test('tennisbear: 形が崩れた件は飛ばし、UTC 表記でも JST に直す', () => {
  const list = normalizeEvents([
    RAW,
    { id: 2, eventTitle: '日付なし' }, // startDatetimeString 無し → 落とす
    null,
    // Z 表記(UTC 9/22 10:00 = JST 9/22 19:00)。表示文字列も無い → end は ''
    { id: 3, eventTitle: '  UTC表記  ', startDatetimeString: '2026-09-22T10:00:00.000Z', place: null },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[1].id, '3');
  assert.equal(list[1].title, 'UTC表記');
  assert.equal(list[1].date, '2026-09-22');
  assert.equal(list[1].start, '19:00');
  assert.equal(list[1].end, '');
  assert.equal(list[1].facility, '');
  // 配列以外(想定外の形)は例外(黙って 0 件にしない)
  assert.throws(() => normalizeEvents({ message: 'x' }), /配列ではありません/);
  assert.equal(normalizeEvents({ events: [RAW] }).length, 1, 'events で包まれていても読む');
});

// fetch を差し替えて ログイン → 一覧 の流れを確かめる
function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return fn(calls).finally(() => {
    globalThis.fetch = real;
  });
}

test('tennisbear: ログインしてトークンを付けて今後の予定を取る(ログにメール・トークン・イベント名を出さない)', async () => {
  const logs = [];
  await withFetch(
    (url, init) => {
      if (url.endsWith('/api/v3/auth/login/email')) {
        assert.equal(init.method, 'POST');
        assert.deepEqual(JSON.parse(init.body), { email: 'a@example.com', password: 'pw' });
        return Response.json({ user: { id: 1 }, token: { accessToken: 'TOKEN123' } });
      }
      if (url.endsWith('/api/v3/events/me/future')) {
        assert.equal(init.headers.authorization, 'Bearer TOKEN123');
        return Response.json([RAW]);
      }
      throw new Error(`unexpected ${url}`);
    },
    async (calls) => {
      const events = await fetchTennisbearEvents({ email: 'a@example.com', password: 'pw' }, { log: (m) => logs.push(m) });
      assert.equal(events.length, 1);
      assert.equal(events[0].title, 'ストローク多め練');
      assert.equal(calls.length, 2);
      const joined = logs.join('\n');
      assert.match(joined, /POST auth\/login\/email 200/);
      assert.match(joined, /GET events\/me\/future 200/);
      assert.match(joined, /今後の予定 1件/);
      assert.doesNotMatch(joined, /a@example\.com|TOKEN123|pw\b|ストローク/);
    }
  );
});

test('tennisbear: 認証失敗(401 / トークン無し)は TennisbearAuthError。その他の HTTP エラーは普通の Error', async () => {
  await withFetch(
    () => new Response('{}', { status: 401 }),
    async () => {
      await assert.rejects(fetchTennisbearEvents({ email: 'a', password: 'b' }), TennisbearAuthError);
    }
  );
  await withFetch(
    () => Response.json({ user: {} }),
    async () => {
      await assert.rejects(fetchTennisbearEvents({ email: 'a', password: 'b' }), TennisbearAuthError);
    }
  );
  await withFetch(
    () => new Response('oops', { status: 502 }),
    async () => {
      await assert.rejects(fetchTennisbearEvents({ email: 'a', password: 'b' }), (e) => !(e instanceof TennisbearAuthError) && /502/.test(e.message));
    }
  );
});
