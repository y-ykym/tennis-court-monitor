// ============================================================
// フェーズ8 コートの連絡先: LINE で「きゃんせる」と送ると、監視対象の都営コートの公園名と電話番号をカードで返す
//
//   電話でキャンセルの連絡をする(サイトの「キャンセル」ボタンが使えない当日など)ときに、
//   公園のサービスセンターの番号をすぐ引けるようにする用途。
//
//   ┌──────────────────────────────────┐
//   │ 📞 キャンセルの連絡先                 │  ← 濃紺ヘッダー(他のカードと同じ配色)
//   │    都営コートのサービスセンター         │
//   ├──────────────────────────────────┤
//   │ 猿江恩賜公園                          │
//   │ 03-3631-9732                    📞  │  ← 行ごと(番号のタップ)で電話がかかる(uri: tel:)
//   │ ───────────────────────────────── │
//   │ 亀戸中央公園                          │
//   │ 03-3636-2558                    📞  │
//   │ ───────────────────────────────── │
//   │ 大島小松川公園                        │
//   │ 03-3636-9365                    📞  │
//   │ 番号をタップすると電話がかかります       │
//   └──────────────────────────────────┘
//
//   番号は courts.js の台帳(phone)から出す。予約サイト・KV・Secrets には触らないので返信は 1 秒以内。
//   フッターのボタンは置かない(ボタンを増やさない方針。行そのものが電話の導線)。
// ============================================================
import { COURTS } from './courts.js';

// グループで受け付ける合言葉(前後の空白を除いた本文との完全一致)
export const CONTACT_COMMAND_TEXT = 'きゃんせる';

export const MSG_CONTACT_FAILED = '連絡先を表示できませんでした';

const COLOR_HEADER_BG = '#1F2A44';
const COLOR_HEADER_SUB = '#C7CEDB';
const COLOR_TEXT = '#111827';
const COLOR_PHONE = '#1D4F91';
const COLOR_MUTED = '#9CA3AF';
const COLOR_LINE = '#E5E7EB';

const text = (str, extra = {}) => ({ type: 'text', text: String(str), ...extra });

// 電話番号のハイフンを外して tel: の URI にする(全角数字・空白が混ざっても落とす)
export function telUri(phone) {
  const digits = String(phone)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[^\d+]/g, '');
  return `tel:${digits}`;
}

// 台帳から連絡先を持つ公園だけ返す(phone が無い公園は出さない)
export function contactRows(courts = COURTS) {
  return courts.filter((c) => c.phone).map((c) => ({ name: c.name, phone: c.phone }));
}

function contactRow({ name, phone }, { first }) {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: first ? 'lg' : 'md',
    paddingTop: '6px',
    paddingBottom: '6px',
    alignItems: 'center',
    // 行のどこを押しても電話アプリが開く(LINE の uri アクションは tel: に対応)
    action: { type: 'uri', label: `${name}に電話`, uri: telUri(phone) },
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        contents: [
          text(name, { size: 'sm', weight: 'bold', color: COLOR_TEXT, wrap: true }),
          text(phone, { size: 'xl', weight: 'bold', color: COLOR_PHONE, margin: 'xs' }),
        ],
      },
      text('📞', { size: 'xl', flex: 0, gravity: 'center', align: 'end' }),
    ],
  };
}

// 「きゃんせる」への返信カード
export function buildContactFlex(rows = contactRows()) {
  const body = [];
  rows.forEach((r, i) => {
    if (i > 0) body.push({ type: 'separator', color: COLOR_LINE, margin: 'md' });
    body.push(contactRow(r, { first: i === 0 }));
  });
  body.push(text('番号をタップすると電話がかかります', { size: 'xxs', color: COLOR_MUTED, margin: 'xl', wrap: true }));
  return {
    type: 'flex',
    altText: contactText(rows).slice(0, 400),
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
          text('📞 キャンセルの連絡先', { color: '#FFFFFF', weight: 'bold', size: 'lg' }),
          text('都営コートのサービスセンター', { color: COLOR_HEADER_SUB, size: 'xs', margin: 'xs' }),
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', paddingTop: '4px', backgroundColor: '#FFFFFF', contents: body },
    },
  };
}

// テキスト版(Flex が 400 で弾かれたときの再送と altText)
export function contactText(rows = contactRows()) {
  return ['📞 キャンセルの連絡先', ...rows.map((r) => `${r.name} ${r.phone}`)].join('\n');
}

// 「きゃんせる」への返信。予約サイトにも KV にも行かない
export function buildContactReply() {
  const rows = contactRows();
  return { flex: buildContactFlex(rows), text: contactText(rows) };
}
