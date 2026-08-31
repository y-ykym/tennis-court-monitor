// ============================================================
// JST基準の日付ユーティリティ
// GitHub Actions(UTC)でも正しく動くよう、実行環境のタイムゾーンに依存しない
// ============================================================

// JSTでの「今日」を "YYYYMMDD" で返す
function jstTodayYmd() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${jst.getUTCFullYear()}${m}${d}`;
}

// "YYYYMMDD" に日数を加算して "YYYYMMDD" を返す
function addDays(ymd, days) {
  const dt = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  dt.setUTCDate(dt.getUTCDate() + days);
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}${m}${d}`;
}

// "YYYYMMDD" → "YYYY-MM-DD"
function ymdToIso(ymd) {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

module.exports = { jstTodayYmd, addDays, ymdToIso };
