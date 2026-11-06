// ============================================================
// LINE のクイックリプライ(メッセージの下に並ぶ丸いボタン。2026-11-06 追加)
//
//   この bot が送るメッセージ(返信・通知)の一番下のメッセージに、合言葉のボタン列を付ける。
//   ボタンを押すと text がグループに送られ、Worker が合言葉として反応する(打ち込み不要)。
//   ボタンの表示(label)は分かりやすい日本語、送られる文字(text)は従来のひらがなの合言葉そのもの。
//
//   LINE の決まり: ボタンは bot のメッセージにしか付かない・スマホ版 LINE だけに出る・
//   次の発言が来ると消える・最大 13 個・label は 20 文字まで。
//
//   このファイルは Pi(booking/)と GitHub Actions(lib/notify.js)用の CommonJS。
//   Worker 用の同じ一覧は worker/src/commands.js(ESM)にあり、両方が同じ中身であることを
//   worker/test/commands.test.mjs が確かめる(ずれたらテストが落ちる)。
// ============================================================

// 表示順。label: ボタンに見せる文字(絵文字つき)、text: 押したときに送られる文字(ひらがなの合言葉)
const QUICK_REPLY_BUTTONS = [
  { label: '📅 予約の一覧', text: 'よやく' },
  { label: '🔎 イベント', text: 'いべんと' },
  { label: '⚙️ 設定', text: 'せってい' },
  { label: '🪪 受付カード', text: 'うけつけ' },
  { label: '📞 電話番号', text: 'きゃんせる' },
  { label: '📖 使い方', text: 'へるぷ' },
];

function buildQuickReply(buttons = QUICK_REPLY_BUTTONS) {
  return { items: buttons.map((b) => ({ type: 'action', action: { type: 'message', label: b.label, text: b.text } })) };
}

// messages(1〜5 件の配列)の最後のメッセージにクイックリプライを付けた新しい配列を返す。
// 元の配列・オブジェクトは変えない。すでに quickReply が付いていればそのまま。空配列はそのまま
function withQuickReply(messages, buttons = QUICK_REPLY_BUTTONS) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (!last || typeof last !== 'object' || last.quickReply) return messages;
  return [...messages.slice(0, -1), { ...last, quickReply: buildQuickReply(buttons) }];
}

module.exports = { QUICK_REPLY_BUTTONS, buildQuickReply, withQuickReply };
