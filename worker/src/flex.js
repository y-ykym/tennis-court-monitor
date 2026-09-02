// ============================================================
// 予約一覧の Flex Message(カード型)。スマホで一目で読めることを優先した設計。
//
//   ┌──────────────────────────────────────┐
//   │ 予約一覧                    9/2 現在 │  ← ヘッダー(濃紺・白文字)
//   ├──────────────────────────────────────┤
//   │ ゆうたそ                        3件  │  ← 人ごとの見出し
//   │ ┌────┐ 19:00 - 21:00                 │
//   │ │9/6 │ 猿江恩賜公園                   │  ← 左: 日付タイル(土=青/日祝=赤/平日=グレー)
//   │ │ 日 │                               │     右: 時間(大きく太字)・公園名
//   │ └────┘                               │
//   │ ┌────┐  9:00 - 11:00  明日            │
//   │ │9/24│ 大島小松川公園                 │
//   │ │ 木 │                               │
//   │ └────┘                               │
//   │ ─────────────────────────────────── │
//   │ B                           取得失敗 │
//   ├──────────────────────────────────────┤
//   │           予約サイトを開く            │  ← フッター(リンク)
//   └──────────────────────────────────────┘
//
// Flex Message はバブルあたり 10KB の制限があるため、表示は MAX_ROWS 件まで(超過は「…ほかN件」)。
// 実測: 固定部 約1.8KB + 1行 約0.75KB(今日/明日ラベル付きは約0.9KB)→ 9行で最大約9KB
// ============================================================
import Holidays from 'japanese-holidays';
import { formatTime, jstTodayIso } from './format.js';

const SITE_URL = 'https://kouen.sports.metro.tokyo.lg.jp/web/index.jsp';
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

function text(str, extra = {}) {
  return { type: 'text', text: String(str), ...extra };
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
function isPast(r, today, nowHHMM) {
  if (!r.date) return false;
  if (r.date < today) return true;
  return r.date === today && !!r.end && r.end <= nowHHMM;
}

// 左の日付タイル: 「9/6」を大きく、その下に曜日
function dateTile(iso, past) {
  const colors = !iso ? TILE_COLORS.weekday : past ? TILE_COLORS.past : TILE_COLORS[dayKind(iso)];
  const [, m, d] = iso ? iso.split('-').map(Number) : [null, null, null];
  const dow = iso ? DOW_JA[toUtcDate(iso).getUTCDay()] : '-';
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    width: '58px',
    backgroundColor: colors.bg,
    cornerRadius: '8px',
    paddingTop: '7px',
    paddingBottom: '7px',
    contents: [
      text(iso ? `${m}/${d}` : '-', { size: 'lg', weight: 'bold', color: colors.fg, align: 'center' }),
      text(dow, { size: 'xs', color: colors.fg, align: 'center' }),
    ],
  };
}

// 1予約 = 1行: [日付タイル] 時間(大きく) + 公園名
// 終了済み(当日で時間を過ぎたもの)は全体をグレーにして「終了」を添える
function reservationRow(r, today, nowHHMM) {
  const past = isPast(r, today, nowHHMM);
  const rel = past ? '終了' : r.date ? relativeLabel(r.date, today) : null;
  const time = r.start && r.end ? `${formatTime(r.start)} - ${formatTime(r.end)}` : '時間不明';
  const mainColor = past ? COLOR_PAST : COLOR_TEXT;
  // 直近なら時間の右に「今日/明日」を赤字で添える(無ければ text 1つで軽くする)
  const timeText = text(time, { size: 'lg', weight: 'bold', color: mainColor, flex: 0 });
  const timeLine = rel
    ? {
        type: 'box',
        layout: 'horizontal',
        contents: [
          timeText,
          text(rel, { size: 'xs', weight: 'bold', color: past ? COLOR_PAST : COLOR_SOON, flex: 1, margin: 'md', gravity: 'center' }),
        ],
      }
    : timeText;

  // 公園名は時間と同格の情報なので濃い色・md サイズで(支払状況は表示しない。利用者の要望)
  const placeLine = text(r.facility || '施設不明', { size: 'md', color: mainColor, wrap: true, margin: 'xs' });

  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'lg',
    alignItems: 'center',
    contents: [
      dateTile(r.date, past),
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        margin: 'lg',
        contents: [timeLine, placeLine],
      },
    ],
  };
}

// 人ごとの見出し行: 名前を色付きラベルで目立たせ、右に件数(または「取得失敗」「予約なし」)
function personHeader(label, right, rightColor, first) {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: first ? 'lg' : 'xl',
    alignItems: 'center',
    contents: [
      {
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
      },
      text(right, { size: 'sm', color: rightColor, flex: 1, align: 'end', gravity: 'center' }),
    ],
  };
}

// プッシュ通知バナーに出る要約(必須項目。上限400字)
function buildAltText(people, total) {
  const first = people.find((p) => !p.error && p.reservations.length > 0);
  let head = '';
  if (first) {
    const r = sortReservations(first.reservations)[0];
    const [, m, d] = r.date ? r.date.split('-').map(Number) : [];
    const date = r.date ? `${m}/${d}(${DOW_JA[toUtcDate(r.date).getUTCDay()]})` : '';
    head = `: ${first.label} ${date} ${formatTime(r.start)}-${formatTime(r.end)} ${r.facility}`;
    if (total > 1) head += ' ほか';
  }
  return `📅 予約一覧 ${total}件${head}`.slice(0, 400);
}

// people: [{ label, reservations: [...] } | { label, error }]
// 前提: 少なくとも1人は取得に成功している(全員失敗・全員0件はテキストで返す。index.js 参照)
export function buildReservationFlex(people, { today = jstTodayIso(), nowHHMM = jstNowHHMM() } = {}) {
  const total = people.reduce((n, p) => n + (p.error ? 0 : p.reservations.length), 0);
  const body = [];
  let shown = 0;
  let hidden = 0;

  people.forEach((p, i) => {
    if (i > 0) body.push({ type: 'separator', margin: 'xl', color: COLOR_LINE });
    if (p.error) {
      body.push(personHeader(p.label, '取得失敗', COLOR_ERROR, i === 0));
      return;
    }
    if (p.reservations.length === 0) {
      body.push(personHeader(p.label, '予約なし', COLOR_SUB, i === 0));
      return;
    }
    body.push(personHeader(p.label, `${p.reservations.length}件`, COLOR_SUB, i === 0));
    sortReservations(p.reservations).forEach((r, j) => {
      if (shown >= MAX_ROWS) {
        hidden++;
        return;
      }
      // 行と行の間に薄い罫線(目が滑らないように)
      if (j > 0) body.push({ type: 'separator', margin: 'lg', color: COLOR_LINE });
      body.push(reservationRow(r, today, nowHHMM));
      shown++;
    });
  });
  if (hidden > 0) {
    body.push(text(`…ほか${hidden}件`, { size: 'xs', color: COLOR_MUTED, align: 'center', margin: 'lg' }));
  }

  const [, tm, td] = today.split('-').map(Number);
  return {
    type: 'flex',
    altText: buildAltText(people, total),
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'horizontal',
        backgroundColor: COLOR_HEADER_BG,
        paddingAll: '14px',
        paddingStart: '16px',
        paddingEnd: '16px',
        contents: [
          text('予約一覧', { color: '#FFFFFF', weight: 'bold', size: 'lg', flex: 1, gravity: 'center' }),
          text(`${tm}/${td} 現在`, { color: '#C7D2E5', size: 'xs', flex: 0, gravity: 'center', align: 'end' }),
        ],
      },
      // 文字色を濃色で決め打ちしているため、背景もダークモードに依存しないよう白を明示
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        paddingTop: '4px',
        backgroundColor: '#FFFFFF',
        contents: body,
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFFFF',
        contents: [
          { type: 'separator', color: COLOR_LINE },
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: { type: 'uri', label: '予約サイトを開く', uri: SITE_URL },
          },
        ],
      },
    },
  };
}
