// ============================================================
// フェーズ6: 「よやく」の予約一覧に、その時間帯の天気を出す
//
//   attachWeather(people, { fetchImpl, now, log }) → Promise<void>
//     各予定に r.weather を付ける(副作用のみ。失敗しても例外は投げない)
//       { emoji, label, tempC, pop }  … 予報あり。pop は降水確率(%)
//       { unknown: true }             … コートは分かるが予報の範囲外(16 日より先)
//       付かない                        … 場所が分からない / 終了した予定 / 取得失敗
//
// 使う API: Open-Meteo(https://api.open-meteo.com/v1/forecast)
//   - API キー不要・非商用は無料(10,000 回/日、300,000 回/月)。データは CC BY 4.0
//   - 1 時間刻みで 16 日先まで。複数地点を 1 リクエストでまとめて取れる(応答は配列)
//   - 座標は約 5km 四方の格子点に丸められる。猿江と亀戸中央(2.5km 離れ)は同じ格子点になるため、
//     数百 m の座標のズレは結果に出ない
//   - 降水確率は欧米モデル(ECMWF/GFS)ベースなので、気象庁の発表値とは一致しないことがある
//
// キャッシュ: Workers の Cache API に 30 分。KV は使わない
//   (KV は自動予約が 1 日 1,000 回の書き込み上限を使っているため。要件 §16)
// ============================================================

import { COURTS, courtByFacility, courtByTbCode } from './courts.js';
import { isTennisbear } from './format.js';

const API = 'https://api.open-meteo.com/v1/forecast';
const FORECAST_DAYS = 16; // Open-Meteo の上限
const CACHE_SEC = 30 * 60;
const TIMEOUT_MS = 4000; // 「よやく」の返信を待たせないための上限。超えたら天気なしで返す
export const POP_ALERT = 50; // この降水確率(%)以上は赤字にする(表示側で使う)

// WMO weather code → 絵文字と呼び名。severity は 1 つの枠に複数の時間が入るときに「悪いほう」を選ぶための順位
const WMO = [
  { codes: [0], emoji: '☀️', label: '快晴', severity: 0 },
  { codes: [1], emoji: '🌤', label: '晴れ', severity: 1 },
  { codes: [2], emoji: '⛅', label: '薄ぐもり', severity: 2 },
  { codes: [3], emoji: '☁️', label: 'くもり', severity: 3 },
  { codes: [45, 48], emoji: '🌫', label: '霧', severity: 4 },
  { codes: [51, 53, 55, 56, 57], emoji: '🌦', label: '霧雨', severity: 5 },
  { codes: [80, 81, 82], emoji: '🌦', label: 'にわか雨', severity: 6 },
  { codes: [61, 63, 65, 66, 67], emoji: '🌧', label: '雨', severity: 7 },
  { codes: [71, 73, 75, 77, 85, 86], emoji: '❄️', label: '雪', severity: 8 },
  { codes: [95, 96, 99], emoji: '⚡️', label: '雷雨', severity: 9 },
];
const BY_CODE = new Map(WMO.flatMap((w) => w.codes.map((c) => [c, w])));
// 知らないコードが来ても落とさない(モデルの更新で増えることがある)
const UNKNOWN_SKY = { emoji: '❓', label: '天気不明', severity: 3 };
export const skyOf = (code) => BY_CODE.get(Number(code)) || UNKNOWN_SKY;

// 予定 1 件の座標。テニスベアの行も台帳に載っているコートなら台帳の座標を使い、
// 同じコートを指す都の行と必ず同じ天気になるようにする(座標が食い違うと違う値が出うる)
export function coordsOf(r) {
  if (isTennisbear(r)) {
    const court = courtByTbCode(r.placeCode) || courtByFacility(r.facility);
    if (court) return { lat: court.lat, lng: court.lng };
    return validCoords(r.lat, r.lng);
  }
  const court = courtByFacility(r.facility);
  return court ? { lat: court.lat, lng: court.lng } : null;
}

// テニスベアの施設マスタには緯度経度が欠けた施設(全国 5,643 件中 26 件)と、
// (0, 0) 付近を指す壊れた値(1 件)が混ざっている。そのまま使うとギニア湾の天気が出るので弾く
function validCoords(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (Math.abs(a) < 1 && Math.abs(b) < 1) return null;
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: a, lng: b };
}

// 同じ格子点に落ちる座標をまとめるためのキー(小数 4 桁 = 約 10m。API の格子はもっと粗い)
const keyOf = ({ lat, lng }) => `${lat.toFixed(4)},${lng.toFixed(4)}`;

// 枠が使う時間(開始時刻から終了時刻の直前まで)。終了が取れない予定は開始の 1 時間だけ見る
function hoursOf(start, end) {
  const from = Number(String(start).slice(0, 2));
  if (!Number.isInteger(from)) return [];
  const toRaw = Number(String(end).slice(0, 2));
  const to = Number.isInteger(toRaw) && toRaw > from ? toRaw : from + 1;
  return Array.from({ length: to - from }, (_, i) => from + i);
}

// 1 枠ぶんの要約。気温は平均、降水確率は最大(中止の判断に使うので安全側)、空は一番悪い時間に合わせる
export function summarize(series, date, start, end) {
  const hours = hoursOf(start, end);
  const picked = hours.map((h) => series.get(`${date}T${String(h).padStart(2, '0')}:00`)).filter(Boolean);
  if (picked.length === 0) return null;
  const temps = picked.map((p) => p.temp).filter((t) => Number.isFinite(t));
  const pops = picked.map((p) => p.pop).filter((n) => Number.isFinite(n));
  const sky = picked.map((p) => skyOf(p.code)).reduce((a, b) => (b.severity > a.severity ? b : a));
  return {
    emoji: sky.emoji,
    label: sky.label,
    tempC: temps.length ? Math.round(temps.reduce((a, b) => a + b, 0) / temps.length) : null,
    pop: pops.length ? Math.max(...pops) : null,
  };
}

// Cache API に 30 分だけ置く。テストや Cache API の無い環境では素通し
async function cachedJson(url, { fetchImpl, signal, log }) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      log('天気: キャッシュから');
      return hit.json();
    }
  }
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  if (cache) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set('Cache-Control', `max-age=${CACHE_SEC}`);
    await cache.put(url, copy);
  }
  return res.json();
}

// 地点ごとに「"YYYY-MM-DDTHH:00" → { temp, pop, code }」の Map を作る
export async function fetchForecasts(points, { fetchImpl = fetch, signal, log = () => {} } = {}) {
  if (points.length === 0) return new Map();
  const url =
    `${API}?latitude=${points.map((p) => p.lat).join(',')}&longitude=${points.map((p) => p.lng).join(',')}` +
    `&hourly=temperature_2m,precipitation_probability,weather_code&timezone=Asia%2FTokyo&forecast_days=${FORECAST_DAYS}`;
  const started = Date.now();
  const payload = await cachedJson(url, { fetchImpl, signal, log });
  // 1 地点のときは配列にならない
  const list = Array.isArray(payload) ? payload : [payload];
  const out = new Map();
  points.forEach((p, i) => {
    const h = list[i]?.hourly;
    if (!h?.time) return;
    const series = new Map();
    h.time.forEach((t, j) => {
      series.set(t, { temp: h.temperature_2m?.[j], pop: h.precipitation_probability?.[j], code: h.weather_code?.[j] });
    });
    out.set(keyOf(p), series);
  });
  log(`天気: ${points.length}地点 (${Date.now() - started}ms)`);
  return out;
}

// people の各予定に r.weather を付ける。天気は「あれば嬉しい」情報なので、
// 失敗しても握りつぶして一覧の返信は必ず出す
export async function attachWeather(people, { fetchImpl = fetch, today, signal, log = () => {} } = {}) {
  // 終了した予定には付けない(グレー表示で天気を出しても意味がない)
  const targets = [];
  for (const p of people) {
    for (const r of [...(p.reservations || []), ...(p.tennisbear?.events || [])]) {
      if (!r.date || (today && r.date < today)) continue;
      const at = coordsOf(r);
      if (at) targets.push({ r, at });
    }
  }
  if (targets.length === 0) return;

  // 台帳の 3 公園は予約の有無にかかわらず常に要求する。URL(= キャッシュのキー)が
  // 予約のある公園の組み合わせで変わらなくなり、30 分のキャッシュがほぼ必ず当たる。
  // 3 地点でも 1 リクエストなので取得のコストは変わらない
  const points = COURTS.map((c) => ({ lat: c.lat, lng: c.lng }));
  const seen = new Set(points.map(keyOf));
  for (const { at } of targets) {
    const k = keyOf(at);
    if (!seen.has(k)) {
      seen.add(k);
      points.push(at);
    }
  }

  let forecasts;
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const merged = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal || timeout;
    forecasts = await fetchForecasts(points, { fetchImpl, signal: merged, log });
  } catch (e) {
    log(`天気: 取得に失敗したので天気なしで続行 (${e.message})`);
    return;
  }

  for (const { r, at } of targets) {
    const series = forecasts.get(keyOf(at));
    if (!series) continue;
    // 予報は 16 日先まで。それより先の枠は「予報なし」と出す(消すと不具合に見えるため)
    r.weather = summarize(series, r.date, r.start, r.end) || { unknown: true };
  }
}
