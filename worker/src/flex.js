// ============================================================
// 予約一覧の Flex Message と、キャンセル確認・結果のカード。スマホで一目で読めることを優先した設計。
//
// 予約一覧は「人ごとに 1 枚」のカードを横に並べたカルーセル(2026-09-13 変更。人が 1 人なら 1 枚のバブル):
//
//   ┌──────────────────────────────┐ ┌──────────────────────────────┐
//   │ ゆうたそ          9/6 現在 ・ 3件 │ │ B                9/6 現在 ・ 1件 │  ← ヘッダー(濃紺・白文字)。名前が見出し
//   ├──────────────────────────────┤ ├──────────────────────────────┤
//   │ ┌────┐ 9:00 - 11:00            │ │ ┌────┐ 19:00 - 21:00          │
//   │ │9/6 │ 猿江恩賜公園  終了       │ │ │9/21│ 猿江恩賜公園   (キャンセル)│  ← 終了済み: 全体グレー、ボタン無し
//   │ │ 日 │                         │ │ │ 月 │                         │     右端: 「キャンセル」ピル(postback。フェーズ1.6)
//   │ └────┘                         │ │ └────┘                         │
//   │ ┌────┐ 17:00 - 19:00 (キャンセル)│ │                               │
//   │ │9/7 │ 大島小松川公園  明日     │ │                               │  ← 同じ日の予定は 1 つのタイルの右に時間順で縦に並ぶ
//   │ │ 月 │ 19:00 - 21:00            │ │                               │     (2026-09-17 変更。キャンセルボタンは予定ごと)
//   │ └────┘ 🐻 ストローク多め練      │ │                               │
//   ├──────────────────────────────┤ ├──────────────────────────────┤
//   │ 予約サイトを開く   一覧を更新  │ │ 予約サイトを開く   一覧を更新  │  ← フッター
//   └──────────────────────────────┘ └──────────────────────────────┘
//      ←── 横にスワイプで切り替え ──→
//
// 取得に失敗した人のカードはグレーのヘッダー「取得失敗」、0 件は「予約なし」と本文に 1 行。
//
// フェーズ5(§15): 人に tennisbear が添えられていれば、テニスベアの予定を同じカードに日付順で混ぜる。
//   │ ┌────┐ 19:00 - 21:00                  │
//   │ │9/22│ 🐻 ストローク多め練              │  ← テニスベアの行: 🐻 + イベント名、その下にコート名。キャンセルボタンは付けない
//   │ │ 火 │ 亀戸中央公園テニスコート         │
//   テニスベアだけ失敗 → カード末尾に小さく「🐻 テニスベアの取得に失敗しました」。都だけ失敗 → 「繋がりませんでした」の下に予定を出す
//
// 左の日付タイルは 土=青 / 日祝=赤 / 平日=グレー / 終了=薄グレー。時間は太字(md)、公園名は小さめ、
// 「今日/明日/明後日/終了」の補足は公園名の右(ピルの幅を確保するため時間の行には置かない)。
//
// Flex Message はバブルあたり 30KB、カルーセル全体で 50KB の制限がある(Messaging API リファレンス)。
// JSON を軽くするため「時間+公園名+補足」は span 付きの 1 テキストにまとめる。表示行数は固定せず、
// 各カードが MAX_BUBBLE_BYTES、全体が MAX_CAROUSEL_BYTES に収まるまで 1 人あたりの行数を減らす(超過分は「…ほかN件」)。
// 実測: 固定部 約1.8KB、1行 約1.1KB(ボタン込み)→ 2 人 × 20 行で約 48KB。
// フッターの「一覧を更新」はメッセージアクション(押すとその人が「よやく」と送った扱いになり、この Worker が一覧を返す)。
// ============================================================
import Holidays from 'japanese-holidays';
import { formatTime, jstTodayIso, sortReservations, mergedRows, isTennisbear, MSG_TB_FAILED } from './format.js';

const SITE_URL = 'https://kouen.sports.metro.tokyo.lg.jp/web/index.jsp';
// バブル JSON の上限(LINE の 30KB 制限に余裕を持たせる)と、カルーセル全体の上限(50KB 制限に余裕を持たせる)
export const MAX_BUBBLE_BYTES = 28000;
export const MAX_CAROUSEL_BYTES = 49000;
// 1 人あたりで試す最大行数(これ以上はバイト数で必ず溢れる)
const MAX_ROWS = 24;
// 「よやく」コマンド(line.js の COMMAND_TEXT と同じ。循環 import を避けて直書き)
const COMMAND_TEXT = 'よやく';

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

// 「時間(太字) / 公園名 + 補足(今日/明日/終了)」の span 1テキスト。
// テニスベアの行は「時間 / 🐻 イベント名 / コート名 + 補足」(§15.4。主催の印は付けない)
function detailText(r, { past, rel, timeSize = 'md', strike = false }) {
  const main = past ? COLOR_PAST : COLOR_TEXT;
  const sub = past ? COLOR_PAST : COLOR_SUB;
  const time = r.start && r.end ? `${formatTime(r.start)} - ${formatTime(r.end)}` : r.start ? `${formatTime(r.start)} -` : '時間不明';
  const spans = [span(time, { size: timeSize, weight: 'bold', color: main, ...(strike ? { decoration: 'line-through' } : {}) })];
  if (isTennisbear(r)) {
    spans.push(span(`\n🐻 ${r.title || 'イベント'}`, { size: 'sm', weight: 'bold', color: main }));
    if (r.facility) spans.push(span(`\n${r.facility}`, { size: 'xs', color: sub }));
  } else {
    spans.push(span(`\n${r.facility || '施設不明'}`, { size: 'sm', color: sub }));
  }
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

// 1 予定ぶん: 時間 / 公園名 + 補足 [キャンセル](日付タイルは持たない。同じ日の予定と 1 つのタイルを共有する)
// 終了済み(当日で時間を過ぎたもの)は文字をグレーにして「終了」を添え、ボタンは付けない
function entry(r, today, nowHHMM, { first }) {
  const past = isPast(r, today, nowHHMM);
  const rel = past ? '終了' : r.date ? relativeLabel(r.date, today) : null;
  const contents = [detailText(r, { past, rel })];
  // テニスベアの行にはキャンセルボタンを付けない(表示のみ。§15.2)
  if (!past && !isTennisbear(r) && r.cancelData && r.date && r.start) contents.push(cancelPill(r, r.cancelData));
  return { type: 'box', layout: 'horizontal', alignItems: 'center', ...(first ? {} : { margin: 'md' }), contents };
}

// 1 日 = 1 行: [日付タイル] その日の予定を時間順に縦積み(1 件ならこれまでと同じ見え方)。
// タイルはその日の予定が全部終了していればグレー。日付の無い予定は 1 件ずつ別の行にする
function dayRow(group, today, nowHHMM) {
  const allPast = group.every((r) => isPast(r, today, nowHHMM));
  const entries = group.map((r, i) => entry(r, today, nowHHMM, { first: i === 0 }));
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'lg',
    alignItems: 'center',
    contents: [dateTile(group[0].date, allPast), { type: 'box', layout: 'vertical', flex: 1, contents: entries }],
  };
}

// 日付・開始時刻の昇順に並んだ予定を、同じ日付ごとにまとめる(日付が無いものは 1 件ずつ)
export function groupByDate(rows) {
  const groups = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (r.date && last && last[0].date === r.date) last.push(r);
    else groups.push([r]);
  }
  return groups;
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

const siteLinkButton = () => ({ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '予約サイトを開く', uri: SITE_URL } });
// 押した人が「よやく」と送った扱いになり、最新の一覧が返る
const refreshButton = (label = '一覧を更新') => ({ type: 'button', style: 'link', height: 'sm', action: { type: 'message', label, text: COMMAND_TEXT } });

// フッター: 区切り線 + リンク風ボタンを横並び(2つまで)
function linkFooter(buttons) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: '#FFFFFF',
    contents: [{ type: 'separator', color: COLOR_LINE }, { type: 'box', layout: 'horizontal', contents: buttons }],
  };
}
const siteLinkFooter = () => linkFooter([siteLinkButton()]);

// 文字色を濃色で決め打ちしているため、背景もダークモードに依存しないよう白を明示
function body(contents, extra = {}) {
  return { type: 'box', layout: 'vertical', paddingAll: '16px', paddingTop: '4px', backgroundColor: '#FFFFFF', contents, ...extra };
}

// プッシュ通知バナーに出る要約(必須項目。上限400字)。テニスベアの予定も件数に含め、先頭なら 🐻 イベント名で
function buildAltText(people, total) {
  const first = people.find((p) => mergedRows(p).length > 0);
  let head = '';
  if (first) {
    const r = mergedRows(first)[0];
    const date = r.date ? `${shortDate(r.date)}(${dowOf(r.date)})` : '';
    const what = isTennisbear(r) ? `🐻 ${r.title}` : r.facility;
    head = `: ${first.label} ${date} ${formatTime(r.start)}-${formatTime(r.end)} ${what}`;
    if (total > 1) head += ' ほか';
  }
  return `📅 予約一覧 ${total}件${head}`.slice(0, 400);
}

// people: [{ label, reservations: [...] } | { label, error }]
//   reservations の各要素に cancelData(署名付き postback data)があれば、その行に「キャンセル」ピルを付ける
//   各人に tennisbear: { events } | { error } が添えられていれば、テニスベアの予定を同じカードに混ぜる(§15。index.js の mergeTennisbear)
// 前提: 少なくとも1人は何か表示できる(全員失敗・全員0件はテキストで返す。index.js 参照)
// 戻り値の contents は、人が 2 人以上ならカルーセル(1 人 1 枚)、1 人ならそのバブル
export function buildReservationFlex(people, { today = jstTodayIso(), nowHHMM = jstNowHHMM() } = {}) {
  const total = people.reduce((n, p) => n + mergedRows(p).length, 0);
  const [, tm, td] = today.split('-').map(Number);
  const asOf = `${tm}/${td} 現在`;

  // 1 人分のカード。maxRows を超える分は「…ほかN件」
  const personBubble = (p, maxRows) => {
    const rows = [];
    const merged = mergedRows(p);
    let right = '';
    let bg = COLOR_HEADER_BG;
    if (p.error) {
      // 都だけ失敗: 従来どおりの断り書きを出したうえで、テニスベアの予定があれば下に出す(§15.2)
      right = '取得失敗';
      bg = COLOR_NG_BG;
      rows.push(text('予約サイトに繋がりませんでした。少し待って「一覧を更新」を押してください', { size: 'sm', color: COLOR_SUB, wrap: true, margin: 'lg' }));
    } else if (merged.length === 0) {
      right = `${asOf} ・ 0件`;
      rows.push(text('予約はありません', { size: 'sm', color: COLOR_SUB, margin: 'lg' }));
    } else {
      right = `${asOf} ・ ${merged.length}件`;
    }
    // maxRows は「予定の数」で数える(同じ日をまとめても件数の上限の意味は変えない)
    const shown = merged.slice(0, maxRows);
    const hidden = merged.length - shown.length;
    groupByDate(shown).forEach((group, j) => {
      // 日と日の間に薄い罫線(目が滑らないように)。同じ日の中は罫線を引かない
      if (j > 0 || p.error) rows.push({ type: 'separator', margin: 'lg', color: COLOR_LINE });
      rows.push(dayRow(group, today, nowHHMM));
    });
    if (hidden > 0) rows.push(text(`…ほか${hidden}件`, { size: 'xs', color: COLOR_MUTED, align: 'center', margin: 'lg' }));
    // テニスベアだけ失敗: 黙って 0 件に見せず、末尾に小さく 1 行(§15.2)
    if (p.tennisbear?.error) rows.push(text(MSG_TB_FAILED, { size: 'xxs', color: COLOR_MUTED, margin: 'lg', wrap: true }));
    return {
      type: 'bubble',
      size: 'mega',
      header: header(p.label, right, bg),
      body: body(rows),
      footer: linkFooter([siteLinkButton(), refreshButton()]),
    };
  };

  const render = (maxRows) => people.map((p) => personBubble(p, maxRows));
  const fits = (bubbles) => bubbles.every((b) => bubbleBytes(b) <= MAX_BUBBLE_BYTES) && bubbles.reduce((n, b) => n + bubbleBytes(b), 0) <= MAX_CAROUSEL_BYTES;

  // 30KB/50KB 制限: 収まるまで 1 人あたりの行数を減らす
  const most = Math.max(1, ...people.map((p) => mergedRows(p).length));
  let rows = Math.min(most, MAX_ROWS);
  let bubbles = render(rows);
  while (rows > 1 && !fits(bubbles)) bubbles = render(--rows);

  const contents = bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles };
  return { type: 'flex', altText: buildAltText(people, total), contents };
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
      // 成功したら残りの予約をすぐ確かめられるように「一覧を見る」、失敗はサイトで確認してもらう
      footer: ok ? linkFooter([refreshButton('一覧を見る'), siteLinkButton()]) : siteLinkFooter(),
    },
  };
}

// ---- フェーズ4 ペナルティ予告アラート ----
//
// 「今日 23:59 までにキャンセルすればペナルティが付かない」予約だけを並べたカード(src/penalty-alert.js から使う)。
// 一覧カードと違い人ごとに分けず、1 枚に A・B 混ぜて日付順に並べる(対象は普通 0〜2 件で、
// カルーセルにすると横スワイプが必要になり、締切前に見落とすため)。
//
//   ┌────────────────────────────────────────┐
//   │ ⏰ 今日中にキャンセル          9/17 9:00 現在 │ ← 琥珀ヘッダー(確認カードと同色)
//   ├────────────────────────────────────────┤
//   │ 今日 23:59 までなら、ペナルティなしで取り消せます │
//   │ ┌────┐ 9:00 - 11:00            (キャンセル) │
//   │ │9/21│ 猿江恩賜公園  ゆうたそ                │
//   │ │ 日 │                                    │
//   │ └────┘                                    │
//   │ ⚠ 明日 0:00 を過ぎると、取り消しにペナルティ(1点) │
//   ├────────────────────────────────────────┤
//   │ 予約サイトを開く            一覧を更新        │
//   └────────────────────────────────────────┘

const ALERT_MAX_ROWS = 15;

// 1 行: [日付タイル] 時間 / 公園名 + 予約者 [キャンセル]
function penaltyRow(label, r) {
  const spans = [
    span(r.start && r.end ? `${formatTime(r.start)} - ${formatTime(r.end)}` : '時間不明', { size: 'md', weight: 'bold', color: COLOR_TEXT }),
    span(`\n${r.facility || '施設不明'}`, { size: 'sm', color: COLOR_SUB }),
    span(`  ${label}`, { size: 'xs', weight: 'bold', color: COLOR_LABEL_FG }),
  ];
  const contents = [dateTile(r.date, false), { type: 'text', flex: 1, margin: 'md', wrap: true, contents: spans }];
  if (r.cancelData && r.date && r.start) contents.push(cancelPill(r, r.cancelData));
  return { type: 'box', layout: 'horizontal', margin: 'lg', alignItems: 'center', contents };
}

// rows: [{ label, reservation }](日付・開始時刻の昇順で渡す)
// kind: 'morning'(朝 9 時の予告)| 'deadline'(23:35 の最終確認)
// failedLabels: 予約サイトから取得できなかった人の名前(いれば「確認できていません」の断り書きを出す)
export function buildPenaltyAlertFlex({ rows, kind = 'morning', nowText = '', failedLabels = [] }) {
  const deadline = kind === 'deadline';
  const contents = [
    text(deadline ? 'まもなく期限です。今日 23:59 までならペナルティなしで取り消せます' : '今日 23:59 までにキャンセルすれば、ペナルティは付きません', {
      size: 'sm',
      weight: 'bold',
      color: COLOR_TEXT,
      margin: 'lg',
      wrap: true,
    }),
  ];
  // 対象は普通 0〜2 件だが、念のため 30KB 制限に当たらないよう上限を設ける
  const shown = rows.slice(0, ALERT_MAX_ROWS);
  shown.forEach(({ label, reservation }, i) => {
    if (i > 0) contents.push({ type: 'separator', margin: 'lg', color: COLOR_LINE });
    contents.push(penaltyRow(label, reservation));
  });
  if (rows.length > shown.length) {
    contents.push(text(`…ほか${rows.length - shown.length}件(「よやく」で全部見られます)`, { size: 'xs', color: COLOR_MUTED, align: 'center', margin: 'lg' }));
  }
  contents.push({
    type: 'box',
    layout: 'vertical',
    margin: 'lg',
    backgroundColor: COLOR_WARN_BG,
    cornerRadius: 'md',
    paddingAll: '10px',
    contents: [
      text('⚠ 日付が変わると取り消しにペナルティ(1点)が付きます。このボタンも 23:59 で使えなくなります', { size: 'xxs', color: COLOR_WARN_FG, wrap: true }),
    ],
  });
  if (failedLabels.length > 0) {
    contents.push(text(`※ ${failedLabels.join('・')} は予約サイトに繋がらず確認できていません`, { size: 'xxs', color: COLOR_ERROR, margin: 'md', wrap: true }));
  }
  const first = rows[0];
  const alt = first
    ? `⏰ 今日23:59までにキャンセル: ${reservationText(first.label, first.reservation)}${rows.length > 1 ? ` ほか${rows.length - 1}件` : ''}`
    : '⏰ 今日23:59までにキャンセル';
  return {
    type: 'flex',
    altText: alt.slice(0, 400),
    contents: {
      type: 'bubble',
      size: 'mega',
      header: header(deadline ? '⏰ まもなく期限(23:59)' : '⏰ 今日中にキャンセル', nowText || null, COLOR_CONFIRM_BG),
      body: body(contents),
      footer: linkFooter([siteLinkButton(), refreshButton()]),
    },
  };
}
