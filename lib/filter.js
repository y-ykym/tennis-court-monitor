// ============================================================
// 監視条件での絞り込み
//   土日祝 : 監視対象の全公園・全時間帯
//   平日   : 公園ごとに設定された開始時刻の枠のみ(lib/config.js の weekdayStartHours)
// 祝日判定には japanese-holidays を使用
// ============================================================
const Holidays = require('japanese-holidays');
const { PARKS } = require('./config');

// "YYYY-MM-DD" が土日または日本の祝日か
function isWeekendOrHoliday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow = date.getDay(); // 0=日, 6=土
  if (dow === 0 || dow === 6) return true;
  return !!Holidays.isHoliday(date);
}

// 時間帯文字列("19:00-21:00" や "19時〜21時" 等)から開始時刻(時)を取り出す
function startHour(time) {
  const m = String(time).match(/\d{1,2}/);
  return m ? parseInt(m[0], 10) : null;
}

function isTargetSlot(slot) {
  // 施設名はサイト表記の揺れ(「公園」の有無など)に備えて部分一致で判定する
  const park = PARKS.find((p) => String(slot.facility).includes(p.keyword));
  if (!park) return false;
  if (isWeekendOrHoliday(slot.date)) return true; // 土日祝は全公園・全時間帯
  return park.weekdayStartHours.includes(startHour(slot.time));
}

function filterTargetSlots(slots) {
  return slots.filter(isTargetSlot);
}

module.exports = { filterTargetSlots, isTargetSlot, isWeekendOrHoliday, startHour };
