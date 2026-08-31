// ============================================================
// サイトの定期メンテナンス時間帯の判定(この間はチェック自体をスキップ)
//   ・毎月27日 12:00 〜 28日 8:45 (JST)
//   ・年末年始 12/28 12:00 〜 1/4 8:45 (JST)
// ※旧システムの公表値。新システムで変わっていたらここを修正する
// ============================================================

function toJstParts(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return {
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
    minutes: jst.getUTCHours() * 60 + jst.getUTCMinutes(), // 0:00からの経過分
  };
}

function inMaintenanceWindow(now) {
  const { month, day, minutes } = toJstParts(now);
  const NOON = 12 * 60;
  const M0845 = 8 * 60 + 45;

  // 年末年始: 12/28 12:00 〜 1/4 8:45
  if (month === 12 && (day > 28 || (day === 28 && minutes >= NOON))) return true;
  if (month === 1 && (day < 4 || (day === 4 && minutes < M0845))) return true;

  // 毎月: 27日 12:00 〜 28日 8:45
  if (day === 27 && minutes >= NOON) return true;
  if (day === 28 && minutes < M0845) return true;

  return false;
}

module.exports = { inMaintenanceWindow };
