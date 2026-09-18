import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachWeather, coordsOf, fetchForecasts, summarize, skyOf, POP_ALERT } from '../src/weather.js';
import { formatReply, weatherText } from '../src/format.js';
import { buildReservationFlex } from '../src/flex.js';

// Open-Meteo の応答を組み立てる。hours は [["2026-09-22T19:00", 気温, 降水確率, WMOコード], ...]
const mkSeries = (hours) => ({
  latitude: 35.7,
  longitude: 139.8125,
  hourly: {
    time: hours.map((h) => h[0]),
    temperature_2m: hours.map((h) => h[1]),
    precipitation_probability: hours.map((h) => h[2]),
    weather_code: hours.map((h) => h[3]),
  },
});
const mkFetch = (payload, spy = {}) => async (url) => {
  spy.calls = (spy.calls || 0) + 1;
  spy.url = url;
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
};

test('weather: WMO コードを絵文字にする。知らないコードでも落とさない', () => {
  assert.equal(skyOf(0).emoji, '☀️');
  assert.equal(skyOf(63).label, '雨');
  assert.equal(skyOf(95).emoji, '⚡️');
  assert.equal(skyOf(999).label, '天気不明');
});

test('weather: 枠の時間だけを見て、気温は平均・降水確率は最大・空は一番悪い時間に合わせる', () => {
  const series = new Map([
    ['2026-09-22T18:00', { temp: 30, pop: 0, code: 0 }], // 枠の外。使わない
    ['2026-09-22T19:00', { temp: 20, pop: 10, code: 1 }],
    ['2026-09-22T20:00', { temp: 22, pop: 80, code: 63 }],
    ['2026-09-22T21:00', { temp: 40, pop: 99, code: 95 }], // 終了時刻ちょうどは使わない
  ]);
  assert.deepEqual(summarize(series, '2026-09-22', '19:00', '21:00'), { emoji: '🌧', label: '雨', tempC: 21, pop: 80 });
  // 終了時刻が取れない予定(テニスベア)は開始の 1 時間だけ
  assert.deepEqual(summarize(series, '2026-09-22', '19:00', ''), { emoji: '🌤', label: '晴れ', tempC: 20, pop: 10 });
  // 予報の範囲外は null(呼び出し側が「予報なし」にする)
  assert.equal(summarize(series, '2026-10-30', '19:00', '21:00'), null);
});

test('weather: 座標の決め方。テニスベアの行も台帳にあるコートなら都と同じ座標を使う', () => {
  // 都の予約は公園名から
  assert.deepEqual(coordsOf({ facility: '大島小松川公園' }), { lat: 35.69144, lng: 139.84726 });
  // テニスベアの行: place.code が台帳にあれば台帳の座標(place.lat/lng がズレていても都と揃える)
  const tb = { source: 'tennisbear', placeCode: '0100010020', facility: '大島小松川公園Ａ', lat: 35.1, lng: 139.1 };
  assert.deepEqual(coordsOf(tb), { lat: 35.69144, lng: 139.84726 });
  // 台帳に無いコート(都営以外)は place.lat/lng をそのまま使う
  assert.deepEqual(coordsOf({ source: 'tennisbear', placeCode: '2000015271', facility: 'PATTAYA', lat: 12.9, lng: 100.9 }), { lat: 12.9, lng: 100.9 });
  // 座標が無い施設・(0,0) 付近の壊れた値(マスタに実在)は天気を出さない
  assert.equal(coordsOf({ source: 'tennisbear', placeCode: 'x', facility: '府中市白糸台体育館', lat: null, lng: null }), null);
  assert.equal(coordsOf({ source: 'tennisbear', placeCode: 'x', facility: '王子公園テニスコート', lat: 0.71305, lng: 0.21406 }), null);
  // 台帳に無い公園名の都の予約
  assert.equal(coordsOf({ facility: '有明テニスの森' }), null);
});

test('weather: 同じ格子点の地点は 1 つにまとめ、1 リクエストで取る', async () => {
  const spy = {};
  const hours = [
    ['2026-09-22T19:00', 21, 10, 0],
    ['2026-09-22T20:00', 21, 10, 0],
  ];
  const people = [
    {
      label: 'A',
      // 大島小松川は都とテニスベアで同じ座標なので 1 つに畳まれる(要求は常に台帳の 3 公園ぶん)
      reservations: [
        { date: '2026-09-22', start: '19:00', end: '21:00', facility: '大島小松川公園' },
        { date: '2026-09-22', start: '19:00', end: '21:00', facility: '猿江恩賜公園' },
      ],
      tennisbear: { events: [{ source: 'tennisbear', placeCode: '0100010020', facility: '大島小松川公園Ａ', date: '2026-09-22', start: '19:00', end: '21:00' }] },
    },
  ];
  await attachWeather(people, { fetchImpl: mkFetch([mkSeries(hours), mkSeries(hours), mkSeries(hours)], spy), today: '2026-09-18' });
  assert.equal(spy.calls, 1, 'HTTP は 1 回');
  assert.equal((spy.url.match(/35\./g) || []).length, 3, '台帳の 3 公園ぶんを常に要求する(キャッシュのキーを固定するため)');
  assert.ok(!spy.url.includes('35.69144,35.69144'), '同じ座標を 2 回並べない');
  assert.deepEqual(people[0].reservations[0].weather, { emoji: '☀️', label: '快晴', tempC: 21, pop: 10 });
  assert.deepEqual(people[0].tennisbear.events[0].weather, people[0].reservations[0].weather, '同じコートなら同じ天気');
});

test('weather: 16 日より先は「予報なし」、終了した予定と場所不明には何も付けない', async () => {
  const people = [
    {
      label: 'A',
      reservations: [
        { date: '2026-09-22', start: '19:00', end: '21:00', facility: '大島小松川公園' }, // 予報あり
        { date: '2026-10-15', start: '19:00', end: '21:00', facility: '大島小松川公園' }, // 範囲外
        { date: '2026-09-01', start: '19:00', end: '21:00', facility: '大島小松川公園' }, // 終了済み
        { date: '2026-09-22', start: '19:00', end: '21:00', facility: '有明テニスの森' }, // 台帳に無い
      ],
    },
  ];
  const hours = [['2026-09-22T19:00', 21, 10, 0], ['2026-09-22T20:00', 21, 10, 0]];
  await attachWeather(people, {
    fetchImpl: mkFetch([mkSeries(hours), mkSeries(hours), mkSeries(hours)]),
    today: '2026-09-18',
  });
  const [ok, far, past, unknownPlace] = people[0].reservations;
  assert.equal(ok.weather.tempC, 21);
  assert.deepEqual(far.weather, { unknown: true });
  assert.equal(past.weather, undefined);
  assert.equal(unknownPlace.weather, undefined);
});

test('weather: 取得に失敗しても例外を投げず、天気なしで続行する', async () => {
  const people = [{ label: 'A', reservations: [{ date: '2026-09-22', start: '19:00', end: '21:00', facility: '大島小松川公園' }] }];
  await attachWeather(people, { fetchImpl: async () => new Response('', { status: 500 }), today: '2026-09-18' });
  assert.equal(people[0].reservations[0].weather, undefined);
  await attachWeather(people, { fetchImpl: async () => { throw new Error('network'); }, today: '2026-09-18' });
  assert.equal(people[0].reservations[0].weather, undefined);
});

test('weather: 1 地点だけのときは応答が配列でなくても読める', async () => {
  const one = mkSeries([['2026-09-22T19:00', 18, 60, 61], ['2026-09-22T20:00', 18, 70, 61]]);
  const map = await fetchForecasts([{ lat: 35.69144, lng: 139.84726 }], { fetchImpl: mkFetch(one) });
  assert.equal(map.size, 1);
  assert.deepEqual(summarize(map.get('35.6914,139.8473'), '2026-09-22', '19:00', '21:00'), { emoji: '🌧', label: '雨', tempC: 18, pop: 70 });
});

test('weather: 表示(テキスト版と Flex)。降水確率が高い枠は赤く太字にする', () => {
  const dry = { emoji: '☀️', label: '快晴', tempC: 27, pop: 30 };
  const wet = { emoji: '🌧', label: '雨', tempC: 22, pop: 90 };
  assert.equal(weatherText({ weather: dry }), '  ☀️ 27℃ ☂30%');
  assert.equal(weatherText({ weather: { unknown: true } }), '  — 予報なし');
  assert.equal(weatherText({}), '');

  const people = [
    {
      label: 'A',
      reservations: [
        { date: '2099-09-22', start: '19:00', end: '21:00', facility: '大島小松川公園', weather: dry },
        { date: '2099-09-23', start: '19:00', end: '21:00', facility: '大島小松川公園', weather: wet },
        { date: '2099-10-15', start: '19:00', end: '21:00', facility: '大島小松川公園', weather: { unknown: true } },
      ],
    },
  ];
  assert.match(formatReply(people, { today: '2099-09-18' }), /大島小松川公園 {2}☀️ 27℃ ☂30%/);

  const msg = buildReservationFlex(people, { today: '2099-09-18', nowHHMM: '12:00' });
  // カード全体から span(type: 'span')を拾う
  const spans = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'span') spans.push(n);
    for (const v of Object.values(n)) (Array.isArray(v) ? v : [v]).forEach((c) => (c && typeof c === 'object' ? walk(c) : null));
  };
  walk(msg.contents);
  const find = (t) => spans.find((s) => s.text.includes(t));
  assert.ok(find('☀️'), '晴れの絵文字が出る');
  assert.equal(find('27℃').color, '#4B5563', '普通の日は通常色');
  assert.equal(find(`☂ 90%`).color, '#DC2626', `降水確率 ${POP_ALERT}% 以上は赤`);
  assert.equal(find('☂ 90%').weight, 'bold');
  assert.equal(find('☂ 30%').color, '#4B5563', `${POP_ALERT}% 未満は赤くしない`);
  assert.ok(find('— 予報なし'), '16 日より先は「予報なし」');
});
