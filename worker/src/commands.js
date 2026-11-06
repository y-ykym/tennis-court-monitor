// ============================================================
// グループで受け付ける合言葉の台帳と、クイックリプライ(メッセージの下に並ぶ丸いボタン。2026-11-06 追加)
//
//   合言葉はここが唯一の定義。各モジュール(line.js・auto.js・card.js・contacts.js・event-notify.js・help.js)は
//   ここから re-export している(循環 import を避けるため、このファイルは何も import しない)。
//
//   text: 従来のひらがなの合言葉(打ちやすさ優先。打ち込みで今までどおり使える)
//   alias: クイックリプライのボタンを押したときに送られる文字(読みやすさ優先。これも合言葉として受け付ける)
//   label: ボタンに見せる文字(絵文字つき。20 文字まで)
//
//   bot が送るメッセージ(reply・push)の一番下に、この 6 つのボタンを line.js が自動で付ける。
//   LINE の決まり: ボタンは bot のメッセージにしか付かない・スマホ版 LINE だけに出る・次の発言が来ると消える・最大 13 個。
//
//   Pi と GitHub Actions 用の同じボタン一覧は lib/quick-reply.js(CommonJS)。両方が同じ中身であることを
//   test/commands.test.mjs が確かめる(ずれたらテストが落ちる)。
// ============================================================

export const COMMANDS = [
  { key: 'reservations', text: 'よやく', alias: '予約の一覧', label: '📅 予約の一覧' },
  { key: 'events', text: 'いべんと', alias: 'イベント', label: '🔎 イベント' },
  { key: 'auto', text: 'せってい', alias: '設定', label: '⚙️ 設定' }, // 2026-09-25 まで「じどう」
  { key: 'card', text: 'うけつけ', alias: '受付カード', label: '🪪 受付カード' },
  { key: 'contacts', text: 'きゃんせる', alias: '電話番号', label: '📞 電話番号' },
  { key: 'help', text: 'へるぷ', alias: '使い方', label: '📖 使い方' },
];

const byKey = (key) => COMMANDS.find((c) => c.key === key);

export const COMMAND_TEXT = byKey('reservations').text;
export const EVENT_COMMAND_TEXT = byKey('events').text;
export const AUTO_COMMAND_TEXT = byKey('auto').text;
export const CARD_COMMAND_TEXT = byKey('card').text;
export const CONTACT_COMMAND_TEXT = byKey('contacts').text;
export const HELP_COMMAND_TEXT = byKey('help').text;

// 合言葉(text)に対して、受け付ける文字列の一覧([text, alias])。台帳に無い文字列(じどうおん など)はそのまま 1 つ
export function commandTexts(text) {
  const c = COMMANDS.find((x) => x.text === text);
  return c ? [c.text, c.alias] : [text];
}

// 受け取った文字列を従来の合言葉(text)に正規化する。別名ならその合言葉、それ以外はそのまま
export function canonicalCommand(received) {
  const c = COMMANDS.find((x) => x.text === received || x.alias === received);
  return c ? c.text : received;
}

// クイックリプライのボタン一覧(lib/quick-reply.js と同じ中身)
export const QUICK_REPLY_BUTTONS = COMMANDS.map((c) => ({ label: c.label, text: c.alias }));

export function buildQuickReply(buttons = QUICK_REPLY_BUTTONS) {
  return { items: buttons.map((b) => ({ type: 'action', action: { type: 'message', label: b.label, text: b.text } })) };
}

// messages(1〜5 件の配列)の最後のメッセージにクイックリプライを付けた新しい配列を返す。
// 元の配列・オブジェクトは変えない。すでに quickReply が付いていればそのまま。空配列はそのまま
export function withQuickReply(messages, buttons = QUICK_REPLY_BUTTONS) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (!last || typeof last !== 'object' || last.quickReply) return messages;
  return [...messages.slice(0, -1), { ...last, quickReply: buildQuickReply(buttons) }];
}
