// ============================================================
// LINE に返す固定メッセージ(キャンセル・自動予約)
//
// なぜ index.js ではなくここに置くか:
//   エントリポイント(wrangler.toml の main = src/index.js)の名前付き export は、
//   workerd が「もう 1 つの Worker の入口(handler)」として解釈する。
//   そのため関数以外の値を export すると、起動時に
//     Uncaught TypeError: Incorrect type for map entry '...':
//     the provided value is not of type 'function or ExportedHandler'
//   で `wrangler dev` が落ちる(deploy の dry-run は通ってしまうので気づきにくい)。
//   文字列・オブジェクトの定数は、この種の別モジュールに置いて index.js からは re-export しないこと。
// ============================================================

// ---- フェーズ1.6 予約キャンセル ----
export const MSG_CANCEL_EXPIRED = '時間切れです。「よやく」からやり直してください';
export const MSG_CANCEL_NOT_FOUND = 'この予約は見つかりませんでした(既にキャンセル済みの可能性があります)。「よやく」で確認してください';
export const MSG_CANCEL_MISMATCH = '予約の内容が一覧と一致しないため中止しました。「よやく」で確認してください';
export const MSG_CANCEL_DECLINED = 'キャンセルしませんでした';
export const MSG_CANCEL_DISABLED = 'キャンセル機能は現在停止しています。予約サイトから操作してください';

// ---- フェーズ3 自動予約(「せってい」) ----
export const MSG_AUTO_UNAVAILABLE = '自動予約の設定は現在使えません(署名鍵または KV が未設定)';
