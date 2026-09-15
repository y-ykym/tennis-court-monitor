// ============================================================
// 監視対象の公園と監視条件の定義
// 公園を増減したり監視条件を変えるときは、このファイルだけを編集する
//
//   name    : サイト表記の公園名(通知にもこのまま表示される)
//   code    : サイトの公園セレクトのvalue(調査結果は docs/site-notes.md 参照)
//   keyword : 取得した施設名との部分一致キーワード(「公園」の有無など表記揺れに備えて短めに)
//   weekdayStartHours : 平日に監視する枠の開始時刻(時)。空配列なら平日は監視しない
//   priority: フェーズ3 自動予約で同じ利用日に候補が複数あるときの公園の優先順(小さいほど先に試す)
//
// 土日祝は全公園・全時間帯を監視する(lib/filter.js参照)
// ============================================================
const PARKS = [
  { name: '猿江恩賜公園', code: '1040', keyword: '猿江', weekdayStartHours: [19], priority: 2 },
  { name: '亀戸中央公園', code: '1050', keyword: '亀戸中央', weekdayStartHours: [], priority: 3 },
  { name: '大島小松川公園', code: '1160', keyword: '大島小松川', weekdayStartHours: [], priority: 1 },
];

// ---- フェーズ3 自動予約の設定(要件は docs/PROMPT_フェーズ3_自動予約.md §2) ----
const AUTO_BOOKING = {
  // ペナルティ日数(サイトの penaltyday)。利用日 <= 今日 + この日数 の枠は自動予約しない(取消でペナルティが付くため)
  PENALTY_DAYS: 3,
  // 利用日 = 今日 + PENALTY_DAYS + 1(= +4 日。無料キャンセルが今日 23:59 までの枠)は、この時刻(JST "HH:MM")以降は自動予約しない
  // (取れても取消の猶予が無いため。要件 #11)。+5 日以降の枠には締切なし。判定は見つけた時と「予約」の直前の両方で行う
  LAST_DAY_DEADLINE: '23:35',
  // 利用日ごとの上限件数(手動で取った予約も数える)
  MAX_PER_DAY: 2,
  // 同じ利用日に候補が複数あるときの時間帯(開始時刻)の優先順
  HOUR_PRIORITY: [17, 19, 9, 11, 13, 15],
  // 予約者: 平日(利用日基準)は B、土日祝は A
  PERSON_BY_DAY: { weekday: 'B', holiday: 'A' },
  // 申込人数
  PEOPLE: 2,
  // Pi 側の空き照会の間隔(ミリ秒)と、その下限(これより短くしない。要件 §7)
  POLL_INTERVAL_MS: 60 * 1000,
  MIN_POLL_INTERVAL_MS: 30 * 1000,
  // 深夜は空きがほとんど出ない(実測: 出現は 23 時台に集中)ので、相手のサーバーへの負荷を減らすため間隔を広げる(JST)
  NIGHT: { FROM: '01:00', TO: '07:00', POLL_INTERVAL_MS: 3 * 60 * 1000 },
  // Pi の最後の照会がこの時間以内なら「自動予約は生きている」とみなす(Worker が Pi の /auto/status を直接聞いて判定。Actions が通知を絞る条件)。
  // 深夜の 3 分間隔 + 照会の所要でも切れないよう 5 分(worker/src/auto.js の ALIVE_WITHIN_MS と同じ値)
  ALIVE_WITHIN_MS: 5 * 60 * 1000,
};

module.exports = { PARKS, AUTO_BOOKING };
