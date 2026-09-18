// ============================================================
// 返信テキストの整形(要件定義書 §11.2 のフォーマット)
//
//   📅 予約一覧(9/2 現在)
//   ・A  9/6(土)  9:00-11:00 猿江恩賜公園
//   ・A  9/13(土) 11:00-13:00 亀戸中央公園
//   ・B  9/10(水) 19:00-21:00 猿江恩賜公園
//
//   - 人ごと(A → B の順)にまとめ、各人の中は日付・開始時刻の昇順
//   - 全員 0件: 「予約はありません」
//   - 全員 取得失敗: 「予約サイトに繋がりませんでした。少し待ってもう一度お試しください」
//   - 片方だけ失敗: 取れた方を出し、失敗した方は「(取得失敗)」の1行
//
// フェーズ5(§15): 人に tennisbear が添えられていれば、その人の行にテニスベアの予定を日付順で混ぜる
//   ・A  9/22(火) 19:00-21:00 🐻 ストローク多め練(亀戸中央公園テニスコート)
//   テニスベアだけ失敗 → その人の末尾に「・A  (🐻 テニスベアの取得に失敗)」。都だけ失敗 → 「(取得失敗)」の下にテニスベアの予定
//   同じ 1 つの枠が都とテニスベアの両方に出るときは 1 行にまとめる(mergeSameSlot)
//   ・A  9/22(火) 19:00-21:00 大島小松川公園 🐻 ストローク多め練
//
// フェーズ6(§16): weather.js が付けた r.weather があれば末尾に天気を足す
//   ・A  9/22(火) 19:00-21:00 大島小松川公園  ☀️ 27℃ ☂30%
// ============================================================

import { courtByFacility, courtByTbCode } from './courts.js';

export const MSG_NO_RESERVATIONS = '予約はありません';
export const MSG_FETCH_FAILED = '予約サイトに繋がりませんでした。少し待ってもう一度お試しください';
export const MSG_TB_FAILED = '🐻 テニスベアの取得に失敗しました';

const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];

// "YYYY-MM-DD" → "M/D(曜)"
export function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = DOW_JA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}(${dow})`;
}

// "09:00" → "9:00"
export function formatTime(hhmm) {
  return hhmm ? hhmm.replace(/^0/, '') : '';
}

// JSTでの今日を "YYYY-MM-DD" で
export function jstTodayIso(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

export function sortReservations(list) {
  return [...list].sort(
    (a, b) => (a.date || '').localeCompare(b.date || '') || (a.start || '').localeCompare(b.start || '')
  );
}

// テニスベアの行か(tennisbear.js が source を付ける)。都の行と見分け、キャンセルボタンを付けない判定に使う
export const isTennisbear = (r) => r?.source === 'tennisbear';

// 都の予約とテニスベアの予定が同じ 1 つの枠を指しているか。
// テニスベアからは都営コートを予約できない(施設マスタの tennisbearReserveFlg が都営 42 件すべて false)ので、
// 両方に出てくるのは「都で押さえた枠を、テニスベアで練習会として募集した」場合。コートの二重予約ではなく実体は 1 枠。
// 見るのは 日付・開始時刻・公園 の 3 つ(人は index.js の mergeTennisbear が既に揃えている)。
// 終了時刻はテニスベア側で取れないことがある(datetimeForDisplay 由来)ので条件に入れない。
function isSameSlot(res, ev) {
  if (!res.date || res.date !== ev.date) return false;
  if (!res.start || res.start !== ev.start) return false;
  const site = courtByFacility(res.facility);
  // place.code が本命。取れないときだけコート名(place.name)で引く
  const tb = courtByTbCode(ev.placeCode) || courtByFacility(ev.facility);
  return !!site && !!tb && site.parkCode === tb.parkCode;
}

// 同じ枠の 2 行を 1 行にする。土台は都の予約(キャンセルボタンと予約番号を残すため)で、
// テニスベアのイベント名を tbTitle として添える。どちらの情報も落とさない。
// 相手が見つからなかったテニスベアの予定(他の人が主催する練習会など)はそのまま 1 行として残す。
export function mergeSameSlot(site, tb) {
  const rows = site.map((r) => ({ ...r }));
  const rest = [];
  for (const ev of tb) {
    // 1 つの都の予約に 2 件ぶら下げない(tbTitle が未設定のものだけを相手にする)
    const hit = rows.find((r) => r.tbTitle === undefined && isSameSlot(r, ev));
    if (hit) {
      hit.tbTitle = ev.title;
      hit.tbId = ev.id;
    } else {
      rest.push(ev);
    }
  }
  return [...rows, ...rest];
}

// 人 1 人ぶんの表示行: 都の予約(取得できていれば)+ テニスベアの予定(あれば)を日付・開始時刻の昇順に混ぜる(§15.2)
//   p: { reservations, error?, tennisbear?: { events } | { error } }
export function mergedRows(p) {
  const site = p.error ? [] : p.reservations || [];
  const tb = p.tennisbear?.events || [];
  return sortReservations(mergeSameSlot(site, tb));
}

function reservationLine(label, r) {
  const date = r.date ? formatDate(r.date) : '日付不明';
  // 時刻は "9:00" のように1桁時は先頭に空白を足して桁を揃える(§11.2 の例と同じ見え方)
  const time = r.start && r.end ? `${formatTime(r.start).padStart(5)}-${formatTime(r.end)}` : r.start ? `${formatTime(r.start).padStart(5)}-` : '';
  const what =
    isTennisbear(r) ? `🐻 ${r.title}${r.facility ? `(${r.facility})` : ''}`
    : r.tbTitle ? `${r.facility} 🐻 ${r.tbTitle}`
    : r.facility;
  return `・${label}  ${date} ${time} ${what}${weatherText(r)}`.replace(/\s+$/, '');
}

// 天気の 1 行(テキスト版)。weather.js が付けていなければ空文字
export function weatherText(r) {
  const w = r?.weather;
  if (!w) return '';
  if (w.unknown) return '  — 予報なし';
  const parts = [w.emoji];
  if (w.tempC != null) parts.push(`${w.tempC}℃`);
  if (w.pop != null) parts.push(`☂${w.pop}%`);
  return `  ${parts.join(' ')}`;
}

// people: [{ label: 'A', reservations: [...] } | { label: 'B', error: Error }](各人に tennisbear が添えられていることがある。§15)
export function formatReply(people, { today = jstTodayIso() } = {}) {
  const failed = people.filter((p) => p.error);
  const ok = people.filter((p) => !p.error);
  const hasTb = people.some((p) => (p.tennisbear?.events?.length ?? 0) > 0);
  const tbFailed = people.some((p) => p.tennisbear?.error);

  // 都が全員失敗でも、テニスベアの予定が 1 件でもあればカードを出す(§15.2「都だけ失敗」)
  if (ok.length === 0 && !hasTb) return MSG_FETCH_FAILED;
  // テニスベアの失敗は黙って 0 件に見せない(§15.2)
  if (failed.length === 0 && ok.every((p) => p.reservations.length === 0) && !hasTb && !tbFailed) return MSG_NO_RESERVATIONS;

  const lines = [`📅 予約一覧(${formatDate(today).replace(/\(.\)$/, '')} 現在)`];
  for (const p of people) {
    const rows = mergedRows(p);
    if (p.error) lines.push(`・${p.label}  (取得失敗)`);
    else if (rows.length === 0) lines.push(`・${p.label}  予約なし`);
    for (const r of rows) lines.push(reservationLine(p.label, r));
    if (p.tennisbear?.error) lines.push(`・${p.label}  (${MSG_TB_FAILED.replace('しました', '')})`);
  }
  return lines.join('\n');
}
