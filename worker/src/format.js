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
// ============================================================

export const MSG_NO_RESERVATIONS = '予約はありません';
export const MSG_FETCH_FAILED = '予約サイトに繋がりませんでした。少し待ってもう一度お試しください';

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

function sortReservations(list) {
  return [...list].sort(
    (a, b) => (a.date || '').localeCompare(b.date || '') || (a.start || '').localeCompare(b.start || '')
  );
}

function reservationLine(label, r) {
  const date = r.date ? formatDate(r.date) : '日付不明';
  // 時刻は "9:00" のように1桁時は先頭に空白を足して桁を揃える(§11.2 の例と同じ見え方)
  const time = r.start && r.end ? `${formatTime(r.start).padStart(5)}-${formatTime(r.end)}` : '';
  return `・${label}  ${date} ${time} ${r.facility}`.replace(/\s+$/, '');
}

// people: [{ label: 'A', reservations: [...] } | { label: 'B', error: Error }]
export function formatReply(people, { today = jstTodayIso() } = {}) {
  const failed = people.filter((p) => p.error);
  const ok = people.filter((p) => !p.error);

  if (ok.length === 0) return MSG_FETCH_FAILED;
  if (failed.length === 0 && ok.every((p) => p.reservations.length === 0)) return MSG_NO_RESERVATIONS;

  const lines = [`📅 予約一覧(${formatDate(today).replace(/\(.\)$/, '')} 現在)`];
  for (const p of people) {
    if (p.error) {
      lines.push(`・${p.label}  (取得失敗)`);
    } else if (p.reservations.length === 0) {
      lines.push(`・${p.label}  予約なし`);
    } else {
      for (const r of sortReservations(p.reservations)) lines.push(reservationLine(p.label, r));
    }
  }
  return lines.join('\n');
}
