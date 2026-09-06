// ============================================================
// 予約一覧の Flex Message(カード型)と、キャンセル確認・結果のカード。スマホで一目で読めることを優先した設計。
//
//   ┌──────────────────────────────────────────┐
//   │ 予約一覧                 9/6 現在 ・ 4件  │  ← ヘッダー(濃紺・白文字)
//   ├──────────────────────────────────────────┤
//   │ ゆうたそ                            3件  │  ← 人ごとの見出し
//   │ ┌────┐ 9:00 - 11:00                      │  ← 終了済み: 全体グレー、ボタン無し
//   │ │9/6 │ 猿江恩賜公園  終了                 │
//   │ │ 日 │                                   │
//   │ └────┘                                   │
//   │ ┌────┐ 17:00 - 19:00           (キャンセル)│  ← 右端: 「キャンセル」ピル(postback。フェーズ1.6)
//   │ │9/7 │ 大島小松川公園  明日                │
//   │ │ 月 │                                   │
//   │ └────┘                                   │
//   │ ───────────────────────────────────────  │
//   │ B                             取得失敗   │
//   ├──────────────────────────────────────────┤
//   │             予約サイトを開く              │  ← フッター(リンク)
//   └──────────────────────────────────────────┘
//
// 左の日付タイルは 土=青 / 日祝=赤 / 平日=グレー / 終了=薄グレー。時間は太字(md)、公園名は小さめ、
// 「今日/明日/明後日/終了」の補足は公園名の右(ピルの幅を確保するため時間の行には置かない)。
//
// Flex Message はバブルあたり 10KB の制限がある。JSON を軽くするため「時間+公園名+補足」は span 付きの 1 テキストに
// まとめる。表示行数は固定せず、MAX_BUBBLE_BYTES に収まるまで行を減らす(超過分は「…ほかN件」)。
// 実測: 固定部 約1.8KB、1行 約1.1KB(ボタン込み)→ 7行で約9.5KB。
// ============================================================
import Holidays from 'japanese-holidays';
import { formatTime, jstTodayIso } from './format.js';

const SITE_URL = 'https://kouen.sports.metro.tokyo.lg.jp/web/index.jsp';
// バブル JSON の上限(LINE の 10KB 制限に余裕を持たせる)
export const MAX_BUBBLE_BYTES = 9800;
// 上限を試す最大行数(これ以上はバイト数で必ず溢れる)
const MAX_ROWS = 9;

const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];

// 日付タイルの配色(背景 / 文字)
const TILE_COLORS = {
  sat: { bg: '#E3EEFB', fg: '#1D4F91' }, // 土曜: 青
  sun: { bg: '#FBE4E4', fg: '#9B2C2C' }, // 日曜・祝日: 赤
  weekday: { bg: '#EEF0F3', fg: '#374151' }, // 平日: グレー
  past: { bg: '#F3F4F6', fg: '#B0B5BD' }, // 終了済み: 薄いグレー
};
const COLOR_PAST = '#B0B5BD'; // 終了済みの文字色
const COLOR_HEADER_BG = '#1F2A44'; // 濃紺
const COLOR_LABEL_BG = '#E8EDF5'; // 人の名前ラベル(薄い紺)
const COLOR_LABEL_FG = '#1F2A44';
const COLOR_TEXT = '#111827';
const COLOR_SUB = '#4B5563';
const COLOR_MUTED = '#9CA3AF';
const COLOR_LINE = '#E5E7EB';
const COLOR_ERROR = '#B91C1C';
const COLOR_SOON = '#DC2626'; // 今日/明日 の強調
const COLOR_PILL_BG = '#FDECEC'; // キャンセルピル
const COLOR_PILL_FG = '#B91C1C';
const COLOR_CONFIRM_BG = '#9A3412'; // 確認カードのヘッダー(琥珀)
const COLOR_OK_BG = '#15803D'; // 成功
const COLOR_NG_BG = '#6B7280'; // 失敗
const COLOR_WARN_BG = '#FFF7E6'; // ペナルティ警告
const COLOR_WARN_FG = '#8A4B00';
const COLOR_PANEL_BG = '#F8FAFC';

function toUtcDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function dayKind(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = toUtcDate(iso).getUTCDay();
  // japanese-holidays はローカル日付で判定する
  if (dow === 0 || Holidays.isHoliday(new Date(y, m - 1, d))) return 'sun';
  if (dow === 6) return 'sat';
  return 'weekday';
}

// 直近だけ「今日/明日/明後日」
function relativeLabel(iso, today) {
  const diff = Math.round((toUtcDate(iso) - toUtcDate(today)) / 86400000);
  return ['今日', '明日', '明後日'][diff] || null;
}

const shortDate = (iso) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${m}/${d}`;
};
const dowOf = (iso) => DOW_JA[toUtcDate(iso).getUTCDay()];

function text(str, extra = {}) {
  return { type: 'text', text: String(str), ...extra };
}
function span(str, extra = {}) {
  return { type: 'span', text: String(str), ...extra };
}

function sortReservations(list) {
  return [...list].sort(
    (a, b) => (a.date || '').localeCompare(b.date || '') || (a.start || '').localeCompare(b.start || '')
  );
}

// JSTの現在時刻を "HH:MM" で
export function jstNowHHMM(now = new Date()) {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

// 終了済みか(当日で終了時刻を過ぎている、または過去の日付)。サイトは当日中は一覧に残すため
export function isPast(r, today, nowHHMM) {
  if (!r.date) return false;
  if (r.date < today) return true;
  return r.date === today && !!r.end && r.end <= nowHHMM;
}

export function bubbleBytes(bubble) {
  return new TextEncoder().encode(JSON.stringify(bubble)).length;
}

// 左の日付タイル: 「9/6」を大きく、その下に曜日。
// span 1テキスト + 改行で軽くする案は、実機(文字サイズ大)で「9/1」「8」に折れたため 2 テキストに戻した。
// 日付は shrink-to-fit で幅に収める(折り返しも省略記号も出さない)
function dateTile(iso, past) {
  const colors = !iso ? TILE_COLORS.weekday : past ? TILE_COLORS.past : TILE_COLORS[dayKind(iso)];
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    width: '58px',
    backgroundColor: colors.bg,
    cornerRadius: 'md',
    paddingAll: '6px',
    contents: [
      text(iso ? shortDate(iso) : '-', { size: 'lg', weight: 'bold', color: colors.fg, align: 'center', adjustMode: 'shrink-to-fit' }),
      text(iso ? dowOf(iso) : '-', { size: 'xs', color: colors.fg, align: 'center' }),
    ],
  };
}

// 「時間(太字) / 公園名 + 補足(今日/明日/終了)」の span 1テキスト
function detailText(r, { past, rel, timeSize = 'md', strike = false }) {
  const main = past ? COLOR_PAST : COLOR_TEXT;
  const sub = past ? COLOR_PAST : COLOR_SUB;
  const time = r.start && r.end ? `${formatTime(r.start)} - ${formatTime(r.end)}` : '時間不明';
  const spans = [
    span(time, { size: timeSize, weight: 'bold', color: main, ...(strike ? { decoration: 'line-through' } : {}) }),
    span(`\n${r.facility || '施設不明'}`, { size: 'sm', color: sub }),
  ];
  if (rel) spans.push(span(`  ${rel}`, { size: 'xs', weight: 'bold', color: past ? COLOR_PAST : COLOR_SOON }));
  return { type: 'text', flex: 1, margin: 'md', wrap: true, contents: spans };
}

// 右端の「キャンセル」ピル(postback)。data は cancel-token.js の署名付きトークン
function cancelPill(r, data) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    margin: 'sm',
    backgroundColor: COLOR_PILL_BG,
    cornerRadius: 'xl',
    paddingAll: '6px',
    action: {
      type: 'postback',
      label: 'キャンセル',
      data,
      displayText: `${shortDate(r.date)} ${formatTime(r.start)} ${r.facility} をキャンセル`,
    },
    contents: [text('キャンセル', { size: 'xxs', weight: 'bold', color: COLOR_PILL_FG })],
  };
}

// 1予約 = 1行: [日付タイル] 時間 / 公園名 + 補足 [キャンセル]
// 終了済み(当日で時間を過ぎたもの)は全体をグレーにして「終了」を添え、ボタンは付けない
function reservationRow(r, today, nowHHMM) {
  const past = isPast(r, today, nowHHMM);
  const rel = past ? '終了' : r.date ? relativeLabel(r.date, today) : null;
  const contents = [dateTile(r.date, past), detailText(r, { past, rel })];
  if (!past && r.cancelData && r.date && r.start) contents.push(cancelPill(r, r.cancelData));
  return { type: 'box', layout: 'horizontal', margin: 'lg', alignItems: 'center', contents };
}

// 人の名前ラベル(薄い紺の角丸)
function personLabel(label) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    backgroundColor: COLOR_LABEL_BG,
    cornerRadius: '6px',
    paddingTop: '3px',
    paddingBottom: '3px',
    paddingStart: '10px',
    paddingEnd: '10px',
    contents: [text(label, { size: 'md', weight: 'bold', color: COLOR_LABEL_FG })],
  };
}

// 人ごとの見出し行: 名前ラベル + 右に件数(または「取得失敗」「予約なし」)
function personHeader(label, right, rightColor, first) {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: first ? 'lg' : 'xl',
    alignItems: 'center',
    contents: [personLabel(label), text(right, { size: 'sm', color: rightColor, flex: 1, align: 'end', gravity: 'center' })],
  };
}

function header(title, right, bg) {
  return {
    type: 'box',
    layout: 'horizontal',
    backgroundColor: bg,
    paddingAll: '14px',
    paddingStart: '16px',
    paddingEnd: '16px',
    contents: [
      text(title, { color: '#FFFFFF', weight: 'bold', size: 'lg', flex: 1, gravity: 'center' }),
      ...(right ? [text(right, { color: '#E5E7EB', size: 'xs', flex: 0, gravity: 'center', align: 'end' })] : []),
    ],
  };
}

function siteLinkFooter() {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: '#FFFFFF',
    contents: [
      { type: 'separator', color: COLOR_LINE },
      { type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '予約サイトを開く', uri: SITE_URL } },
    ],
  };
}

// 文字色を濃色で決め打ちしているため、背景もダークモードに依存しないよう白を明示
function body(contents, extra = {}) {
  return { type: 'box', layout: 'vertical', paddingAll: '16px', paddingTop: '4px', backgroundColor: '#FFFFFF', contents, ...extra };
}

// プッシュ通知バナーに出る要約(必須項目。上限400字)
function buildAltText(people, total) {
  const first = people.find((p) => !p.error && p.reservations.length > 0);
  let head = '';
  if (first) {
    const r = sortReservations(first.reservations)[0];
    const date = r.date ? `${shortDate(r.date)}(${dowOf(r.date)})` : '';
    head = `: ${first.label} ${date} ${formatTime(r.start)}-${formatTime(r.end)} ${r.facility}`;
    if (total > 1) head += ' ほか';
  }
  return `📅 予約一覧 ${total}件${head}`.slice(0, 400);
}

// people: [{ label, reservations: [...] } | { label, error }]
//   reservations の各要素に cancelData(署名付き postback data)があれば、その行に「キャンセル」ピルを付ける
// 前提: 少なくとも1人は取得に成功している(全員失敗・全員0件はテキストで返す。index.js 参照)
export function buildReservationFlex(people, { today = jstTodayIso(), nowHHMM = jstNowHHMM() } = {}) {
  const total = people.reduce((n, p) => n + (p.error ? 0 : p.reservations.length), 0);
  const [, tm, td] = today.split('-').map(Number);

  const render = (maxRows) => {
    const rows = [];
    let shown = 0;
    let hidden = 0;
    people.forEach((p, i) => {
      if (i > 0) rows.push({ type: 'separator', margin: 'xl', color: COLOR_LINE });
      if (p.error) {
        rows.push(personHeader(p.label, '取得失敗', COLOR_ERROR, i === 0));
        return;
      }
      if (p.reservations.length === 0) {
        rows.push(personHeader(p.label, '予約なし', COLOR_SUB, i === 0));
        return;
      }
      rows.push(personHeader(p.label, `${p.reservations.length}件`, COLOR_SUB, i === 0));
      sortReservations(p.reservations).forEach((r, j) => {
        if (shown >= maxRows) {
          hidden++;
          return;
        }
        // 行と行の間に薄い罫線(目が滑らないように)
        if (j > 0) rows.push({ type: 'separator', margin: 'lg', color: COLOR_LINE });
        rows.push(reservationRow(r, today, nowHHMM));
        shown++;
      });
    });
    if (hidden > 0) rows.push(text(`…ほか${hidden}件`, { size: 'xs', color: COLOR_MUTED, align: 'center', margin: 'lg' }));
    return {
      type: 'bubble',
      size: 'mega',
      header: header('予約一覧', `${tm}/${td} 現在 ・ ${total}件`, COLOR_HEADER_BG),
      body: body(rows),
      footer: siteLinkFooter(),
    };
  };

  // 10KB 制限: 収まるまで行数を減らす
  let bubble = render(Math.min(total, MAX_ROWS));
  for (let rows = Math.min(total, MAX_ROWS) - 1; rows >= 1 && bubbleBytes(bubble) > MAX_BUBBLE_BYTES; rows--) {
    bubble = render(rows);
  }

  return { type: 'flex', altText: buildAltText(people, total), contents: bubble };
}

// ---- フェーズ1.6 キャンセル ----

// 対象の予約を示すパネル(日付タイル + 時間 / 公園名)。確認カード・結果カードで共用
function reservationPanel(r, { past = false, rel = null } = {}) {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'lg',
    alignItems: 'center',
    backgroundColor: COLOR_PANEL_BG,
    cornerRadius: 'lg',
    paddingAll: '10px',
    contents: [dateTile(r.date, past), detailText(r, { past, rel, timeSize: 'lg', strike: past })],
  };
}

function metaLine(label, id) {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    alignItems: 'center',
    contents: [personLabel(label), text(`予約番号 ${id}`, { size: 'xs', color: COLOR_SUB, margin: 'md', flex: 1, gravity: 'center' })],
  };
}

const reservationText = (label, r) =>
  `${label} ${r.date ? `${shortDate(r.date)}(${dowOf(r.date)})` : ''} ${formatTime(r.start)}-${formatTime(r.end)} ${r.facility}`.replace(/\s+/g, ' ').trim();

// 確認カード: 「この予約をキャンセルしますか？」+ 対象 + (該当時)ペナルティ警告 + [いいえ][はい、キャンセルする]
//   yesData: kind='y' の署名付きトークン(10分)。noData: 「いいえ」の postback data
export function buildCancelConfirmFlex({ label, reservation: r, penalty = false, penaltyDay = 3, yesData, noData }, { today = jstTodayIso() } = {}) {
  const rel = r.date ? relativeLabel(r.date, today) : null;
  const contents = [
    text('この予約をキャンセルしますか？', { size: 'md', weight: 'bold', color: COLOR_TEXT, margin: 'lg', wrap: true }),
    reservationPanel(r, { rel }),
    metaLine(label, r.id),
  ];
  if (penalty) {
    contents.push({
      type: 'box',
      layout: 'vertical',
      margin: 'lg',
      backgroundColor: COLOR_WARN_BG,
      cornerRadius: 'md',
      paddingAll: '10px',
      contents: [text(`⚠ 利用日が${penaltyDay}日以内のため、キャンセルするとペナルティ(1点)が付きます`, { size: 'xs', color: COLOR_WARN_FG, wrap: true })],
    });
  }
  return {
    type: 'flex',
    altText: `キャンセルの確認: ${reservationText(label, r)}`.slice(0, 400),
    contents: {
      type: 'bubble',
      size: 'mega',
      header: header('キャンセルの確認', '10分以内に選択', COLOR_CONFIRM_BG),
      body: body(contents),
      // ボタンは縦積み・全幅(横並びだと「はい、キャンセル…」と省略された)。赤の「はい」を上、「いいえ」を下
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '12px',
        backgroundColor: '#FFFFFF',
        contents: [
          { type: 'button', style: 'primary', color: COLOR_PILL_FG, height: 'sm', action: { type: 'postback', label: 'はい、キャンセルする', data: yesData, displayText: 'はい' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: 'いいえ', data: noData, displayText: 'いいえ' } },
        ],
      },
    },
  };
}

// 結果カード。ok=true: 緑「キャンセルしました」+ 取り消した予約(打ち消し線)。ok=false: グレー「キャンセルできませんでした」
export function buildCancelResultFlex({ ok, label, reservation: r, nowText }) {
  const contents = ok
    ? [reservationPanel(r, { past: true }), metaLine(label, r.id)]
    : [
        text('予約サイトで状態を確認してください。', { size: 'sm', color: COLOR_TEXT, margin: 'lg', wrap: true }),
        text('既にキャンセル済みの場合は一覧に表示されません。', { size: 'sm', color: COLOR_TEXT, wrap: true }),
      ];
  return {
    type: 'flex',
    altText: (ok ? `キャンセルしました: ${reservationText(label, r)}` : `キャンセルできませんでした: ${reservationText(label, r)}`).slice(0, 400),
    contents: {
      type: 'bubble',
      size: 'mega',
      header: header(ok ? 'キャンセルしました' : 'キャンセルできませんでした', ok ? nowText : null, ok ? COLOR_OK_BG : COLOR_NG_BG),
      body: body(contents),
      footer: siteLinkFooter(),
    },
  };
}
