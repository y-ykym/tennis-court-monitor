// ============================================================
// フェーズ9 使い方カード: LINE で「へるぷ」と送ると、この bot が反応する合言葉の一覧をカードで返す
//
//   合言葉が増えて(よやく・せってい・うけつけ・きゃんせる…)覚えきれなくなったので、
//   「どの言葉を送ると何が返るか」を 1 枚で引けるようにする用途。
//
//   ┌──────────────────────────────────┐
//   │ 📖 使い方                             │  ← 濃紺ヘッダー(他のカードと同じ配色)
//   │    グループで送る合言葉                 │
//   ├──────────────────────────────────┤
//   │ [よやく]     予約の一覧                │  ← 行をタップするとその合言葉が送られる(message アクション)
//   │              都営コートとテニスベアの予定 │
//   │ ───────────────────────────────── │
//   │ [せってい]   設定                      │
//   │              自動予約と空き通知を止める…  │
//   │ ───────────────────────────────── │
//   │ [うけつけ]   受付で見せるカード          │
//   │ ───────────────────────────────── │
//   │ [きゃんせる] 電話でキャンセル            │
//   │ ───────────────────────────────── │
//   │ [へるぷ]     この一覧                  │
//   │ 行をタップすると、その合言葉が送られます │
//   └──────────────────────────────────┘
//
//   合言葉の文字列は各モジュールの定数を import して出す(ここに書き写さない。名前を変えたときにカードがずれないように)。
//   予約サイト・KV・Secrets には触らないので返信は 1 秒以内。フッターのボタンは置かない(行そのものが導線)。
// ============================================================
import { COMMAND_TEXT } from './line.js';
import { AUTO_COMMAND_TEXT } from './auto.js';
import { CARD_COMMAND_TEXT } from './card.js';
import { CONTACT_COMMAND_TEXT } from './contacts.js';

// グループで受け付ける合言葉(前後の空白を除いた本文との完全一致)
export const HELP_COMMAND_TEXT = 'へるぷ';

export const MSG_HELP_FAILED = '使い方を表示できませんでした';

const COLOR_HEADER_BG = '#1F2A44';
const COLOR_HEADER_SUB = '#C7CEDB';
const COLOR_TEXT = '#111827';
const COLOR_SUB = '#4B5563';
const COLOR_MUTED = '#9CA3AF';
const COLOR_LINE = '#E5E7EB';
const COLOR_PILL_BG = '#E8EDF5';
const COLOR_PILL_FG = '#1F2A44';

const text = (str, extra = {}) => ({ type: 'text', text: String(str), ...extra });

// カードに載せる合言葉の一覧(表示順)。keyword は各モジュールの定数そのもの
//   title: したいこと(1 語)。desc: 補足(1〜2 文)。読む人は家族・仲間なので、仕組みの用語(除外枠など)は使わない。
//   ON/OFF の打ち込み合言葉(じどうおん など)は載せない(設定カードのボタンで押せる。2026-09-25 本人決定)
export function helpRows() {
  return [
    { keyword: COMMAND_TEXT, title: '予約の一覧', desc: '都営コートとテニスベアの予定を日付順に。天気も出ます。キャンセルもここから' },
    { keyword: AUTO_COMMAND_TEXT, title: '設定', desc: '自動予約と空き通知を止める・戻す。予約したくない日を決める' },
    { keyword: CARD_COMMAND_TEXT, title: '受付で見せるカード', desc: '利用者カードの画像を人数分' },
    { keyword: CONTACT_COMMAND_TEXT, title: '電話でキャンセル', desc: '都営コートの電話番号。タップでかかります' },
    { keyword: HELP_COMMAND_TEXT, title: 'この一覧', desc: '合言葉と、送ると何が返るか' },
  ];
}

// 合言葉の枡の幅。一番長い「きゃんせる」(5 文字)が収まる幅に全行そろえ、右の説明の頭を縦に揃える
const PILL_WIDTH = '92px';

// 合言葉を薄い枡に入れて出す(設定カードの pill と同じ見え方)。幅は固定・中央寄せ
function keywordPill(keyword) {
  return {
    type: 'box',
    layout: 'vertical',
    width: PILL_WIDTH,
    backgroundColor: COLOR_PILL_BG,
    cornerRadius: '6px',
    paddingTop: '3px',
    paddingBottom: '3px',
    paddingStart: '4px',
    paddingEnd: '4px',
    contents: [text(keyword, { size: 'sm', weight: 'bold', color: COLOR_PILL_FG, align: 'center' })],
  };
}

function helpRow({ keyword, title, desc }, { first }) {
  const right = [
    text(title, { size: 'sm', weight: 'bold', color: COLOR_TEXT, wrap: true }),
    text(desc, { size: 'xs', color: COLOR_SUB, wrap: true, margin: 'xs' }),
  ];
  return {
    type: 'box',
    layout: 'horizontal',
    margin: first ? 'lg' : 'md',
    paddingTop: '4px',
    paddingBottom: '4px',
    spacing: 'md',
    // 行のどこを押してもその合言葉がグループに送られる(そのまま bot が反応する)
    action: { type: 'message', label: keyword, text: keyword },
    contents: [
      { type: 'box', layout: 'vertical', flex: 0, width: PILL_WIDTH, contents: [keywordPill(keyword)] },
      { type: 'box', layout: 'vertical', flex: 1, contents: right },
    ],
  };
}

// 「へるぷ」への返信カード
export function buildHelpFlex(rows = helpRows()) {
  const body = [];
  rows.forEach((r, i) => {
    if (i > 0) body.push({ type: 'separator', color: COLOR_LINE, margin: 'md' });
    body.push(helpRow(r, { first: i === 0 }));
  });
  body.push(text('行をタップすると、その合言葉が送られます', { size: 'xxs', color: COLOR_MUTED, margin: 'xl', wrap: true }));
  return {
    type: 'flex',
    altText: helpText(rows).slice(0, 400),
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: COLOR_HEADER_BG,
        paddingAll: '14px',
        paddingStart: '16px',
        paddingEnd: '16px',
        contents: [
          text('📖 使い方', { color: '#FFFFFF', weight: 'bold', size: 'lg' }),
          text('グループで送る合言葉', { color: COLOR_HEADER_SUB, size: 'xs', margin: 'xs' }),
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', paddingTop: '4px', backgroundColor: '#FFFFFF', contents: body },
    },
  };
}

// テキスト版(Flex が 400 で弾かれたときの再送と altText)。1 合言葉 1 行
export function helpText(rows = helpRows()) {
  return ['📖 使い方(グループで送る合言葉)', ...rows.map((r) => `${r.keyword}: ${r.title}`)].join('\n');
}

// 「へるぷ」への返信。予約サイトにも KV にも行かない
export function buildHelpReply() {
  const rows = helpRows();
  return { flex: buildHelpFlex(rows), text: helpText(rows) };
}
