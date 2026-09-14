// ============================================================
// JST基準の日付ユーティリティ
// GitHub Actions(UTC)でも正しく動くよう、実行環境のタイムゾーンに依存しない
// ============================================================

// JSTでの「今日」を "YYYYMMDD" で返す
function jstTodayYmd(now = Date.now()) {
  const jst = new Date(now + 9 * 60 * 60 * 1000);
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${jst.getUTCFullYear()}${m}${d}`;
}

// JSTでの「今日」を "YYYY-MM-DD" で返す
function jstTodayIso(now = Date.now()) {
  return ymdToIso(jstTodayYmd(now));
}

// JST の現在時刻を "HH:MM" で返す
function jstHHMM(now = Date.now()) {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

// "YYYYMMDD" に日数を加算して "YYYYMMDD" を返す
function addDays(ymd, days) {
  const dt = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  dt.setUTCDate(dt.getUTCDate() + days);
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}${m}${d}`;
}

// "YYYY-MM-DD" に日数を加算して "YYYY-MM-DD" を返す
function addDaysIso(iso, days) {
  return ymdToIso(addDays(isoToYmd(iso), days));
}

// "YYYYMMDD" → "YYYY-MM-DD"
function ymdToIso(ymd) {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

// "YYYY-MM-DD" → "YYYYMMDD"
function isoToYmd(iso) {
  return String(iso).replace(/-/g, '');
}

// "YYYY-MM-DD" 同士の日数差(b - a)。日付だけで比較する(時刻は見ない)
function daysBetween(aIso, bIso) {
  const toUtc = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(bIso) - toUtc(aIso)) / 86400000);
}

// JST の "YYYY-MM-DD" と "HH:MM" → その時刻の unix ミリ秒
function jstDateTimeMs(iso, hhmm) {
  const [y, m, d] = iso.split('-').map(Number);
  const [hh, mm] = String(hhmm).split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh - 9, mm || 0, 0);
}

// JST のその日の 23:59:59 の unix 秒(無料キャンセル期限などに使う)
function jstEndOfDaySec(iso) {
  return Math.floor(jstDateTimeMs(iso, '23:59') / 1000) + 59;
}

module.exports = { jstTodayYmd, jstTodayIso, jstHHMM, addDays, addDaysIso, ymdToIso, isoToYmd, daysBetween, jstDateTimeMs, jstEndOfDaySec };
