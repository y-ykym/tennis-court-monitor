// ============================================================
// コートの台帳。都(都立公園予約システム)とテニスベアで同じコートを指す情報を 1 か所にまとめる。
//
//   parkCode : 都のサイトの公園セレクトの value(lib/config.js の PARKS.code と同じ)
//   name     : 都のサイト表記の公園名。予約一覧の facility(site.js の place[0])と完全一致する
//   tbCodes  : テニスベアの place.code の配列。名前が変わっても壊れない安定した ID。
//              1 つの公園がテニスベアではコート別に分かれていることがあるので配列で持つ
//              (例: 有明テニスの森は A/B/C/ショーコートの 4 件、城北中央公園は A/B の 2 件)
//   lat/lng  : 緯度経度。フェーズ6 の天気の取得に使う
//
// 座標はテニスベアの施設マスタ(GET /api/v3/places、認証不要)の値をそのまま採用した
// (2026-09-18 取得)。テニスベアの予定(place.lat/lng)と都の予約で同じ座標になり、
// 同じコートなのに違う天気が出る、という食い違いが起きない。
//
// 公園を増やすときは lib/config.js の PARKS とこの表の両方に足す
// (Worker は Pi 側の lib/ を読まないため、定義が 2 か所に分かれている)。
// ============================================================

export const COURTS = [
  // tbCodes の横のコメントはテニスベア側の place.name(都の表記と揃っていないため)
  { parkCode: '1040', name: '猿江恩賜公園', tbCodes: ['0100010008'], lat: 35.69048, lng: 139.81919 }, // 猿江恩賜公園
  { parkCode: '1050', name: '亀戸中央公園', tbCodes: ['0100010009'], lat: 35.70064, lng: 139.83786 }, // 亀戸中央公園
  { parkCode: '1160', name: '大島小松川公園', tbCodes: ['0100010020'], lat: 35.69144, lng: 139.84726 }, // 大島小松川公園Ａ
];

// 公園コード → 公園名。予約ボタンの返信文(booking.js)と除外枠の表示(auto.js)で使う
export const PARK_NAMES = Object.fromEntries(COURTS.map((c) => [c.parkCode, c.name]));

// 都の予約の facility(公園名)から 1 件返す。見つからなければ null。
// サイト表記が変わっても落ちないよう、完全一致 → 部分一致の順に見る
export function courtByFacility(facility) {
  const s = String(facility || '').trim();
  if (!s) return null;
  return COURTS.find((c) => c.name === s) || COURTS.find((c) => s.includes(c.name) || c.name.includes(s)) || null;
}

// テニスベアの place.code から 1 件返す。見つからなければ null(都営以外のコートはここに無い)
export function courtByTbCode(code) {
  const s = String(code || '').trim();
  return s ? COURTS.find((c) => c.tbCodes.includes(s)) || null : null;
}
