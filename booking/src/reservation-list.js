// ============================================================
// 予約の確認・取消画面(prwha1000.jsp)の HTML から予約一覧を取り出し、指定の枠が入っているか探す。
//
// 使いどころ: 「予約」を押した後に完了画面(prwec1000)へ行かず確認画面(prwea1000)のままになることがあり、
// その場合でも予約は成立していた(2026-09-13 21:32 に実際に起きた。回線が不安定なときに出る)。
// 画面遷移だけで成否を決めず、一覧を見て確かめるために使う(src/reserve.js の verifyByList)。
//
// 解析は worker/src/site.js の parseReservations と同じ(Docker イメージには booking/ しか入らないため写している)。
// ============================================================

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// "9月6日(日曜)2026年" → "2026-09-06"("2026年9月6日" 形式にも対応)
function parseDate(text) {
  const iso = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  let m = text.match(/(\d{4})年\s*(\d{1,2})月(\d{1,2})日/);
  if (m) return iso(m[1], m[2], m[3]);
  m = text.match(/(\d{1,2})月(\d{1,2})日[^0-9]*(\d{4})年/);
  if (m) return iso(m[3], m[1], m[2]);
  return null;
}

// "19時00分～21時00分" → ["19:00", "21:00"]
function parseTimeRange(text) {
  const m = text.match(/(\d{1,2})時(\d{2})分\s*[～〜~-]\s*(\d{1,2})時(\d{2})分/);
  if (!m) return [null, null];
  return [`${m[1].padStart(2, '0')}:${m[2]}`, `${m[3].padStart(2, '0')}:${m[4]}`];
}

// 各行の詳細モーダル(id="rsvDetailN")内の「項目名 → 値」の表を読む
export function parseReservations(html) {
  const reservations = [];
  const re = /id="rsvDetail(\d+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const from = html.indexOf('<table', m.index);
    if (from < 0) break;
    const to = html.indexOf('</table>', from);
    const chunk = html.slice(from, to < 0 ? undefined : to);
    const fields = {};
    const rowRe = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
    let r;
    while ((r = rowRe.exec(chunk)) !== null) fields[stripTags(r[1])] = stripTags(r[2]);
    if (!fields['利用日']) continue;
    const [start, end] = parseTimeRange(fields['時間'] || '');
    const place = (fields['公園・施設'] || '').split(' ');
    reservations.push({
      id: fields['予約番号'] || '',
      date: parseDate(fields['利用日']),
      start,
      end,
      facility: place[0] || '',
      fee: fields['利用料金'] || '',
      status: fields['支払状況'] || '',
    });
  }
  return reservations;
}

// 公園名の照合用に「No.1」「公園」などの飾りと空白を落とす
const normalizePark = (s) => String(s || '').replace(/No\.?\s*\d+/g, '').replace(/[\s　]/g, '').replace(/公園$/, '');

// 一覧から「日付・開始時刻・公園」が一致する予約を探す。facility は完了/確認画面の見出し(例 "No.1亀戸中央公園")か公園名
export function findReservation(list, { date, startHour }, facility) {
  const start = `${String(startHour).padStart(2, '0')}:00`;
  const park = normalizePark(facility);
  return (
    list.find((r) => {
      if (r.date !== date || r.start !== start) return false;
      if (!park) return true;
      const rp = normalizePark(r.facility);
      return rp.includes(park) || park.includes(rp);
    }) || null
  );
}
