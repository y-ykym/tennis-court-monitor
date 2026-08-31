# テニスコート空き監視・LINE通知

東京都スポーツ施設予約システムの空き状況を GitHub Actions で定期チェックし、
新しい空きが出たときだけ LINE に通知します。ランニングコストはほぼ0円。

サイトの週表示カレンダーが使う内部JSON APIをHTTP(Node標準fetch)で直接叩くため、
ブラウザ自動化(Playwright)は不要です。依存パッケージは japanese-holidays の1個だけ。

## 監視条件

- 種目: テニス(人工芝)
- 平日: 猿江恩賜公園の19時枠のみ
- 土日祝: 猿江恩賜公園・亀戸中央公園・大島小松川公園の全時間帯
- 範囲: 当日から1ヶ月分 / チェック間隔: 5分おき設定(実効5〜20分)
- 条件を変えたいとき(公園の増減・平日の時間変更)は `lib/config.js` だけを編集

## ファイル構成

```
check.js                     メイン処理(取得→絞込→差分→通知→保存)
lib/scrape.js                内部APIから空き枠を取得(リトライ最大3回)
lib/config.js                公園定義・監視条件の一元管理
lib/filter.js                監視条件(平日/土日祝)での絞り込み
lib/state.js                 前回結果(state.json)との差分検出
lib/notify.js                LINE Messaging APIでのpush通知
lib/maintenance.js           サイトの定期メンテ時間帯のスキップ判定
.github/workflows/monitor.yml  5分おきの定期実行(GitHub Actions)
state.json                   前回の空き状況(自動更新される)
test/mock-slots.json         ロジック動作確認用のモックデータ
docs/site-notes.md           サイト調査記録(API仕様・画面遷移・コード表)
docs/予約空き監視_要件定義書.md  要件定義書
```

## セットアップ手順

1. **このリポジトリをpush**(public推奨: Actions実行時間が無料・無制限)
2. **GitHub Secretsを登録**: Settings → Secrets and variables → Actions で
   `LINE_CHANNEL_ACCESS_TOKEN` と `LINE_USER_ID` を登録
3. **ローカルで動作確認**(任意):
   ```bash
   npm install
   npm run test:logic   # モックデータでロジック確認(サイトアクセスなし)
   npm run dry-run      # 実サイト取得→通知内容の表示のみ(LINE送信なし)
   ```
4. **手動テスト**: GitHubの Actions タブ → tennis-court-monitor → Run workflow。
   初回は state.json が空なので、監視対象の空きがあればLINEに通知が届く
5. **運用開始**: 手動テストが通れば、あとは5分おきに自動実行される

## 運用メモ

- **通知が来る条件**: 前回チェック時に無かった空き枠が新たに出現したときだけ(重複通知なし)
- **LINE無料枠**: 月200通まで。1回の実行で出た新規空きは1通にまとめて送信
- **60日ルール**: publicリポジトリはコミット等の活動が60日ないと定期実行が自動停止する。
  state.jsonの自動コミットで通常は維持されるが、止まったらActionsタブから再有効化する
- **サイトメンテナンス**: 毎月27日12:00〜28日8:45と年末年始(12/28 12:00〜1/4 8:45)はスキップ
- **一時的なサーバエラー(502等)**: 公園単位で新セッションからリトライ(最大3回)。
  それでも失敗した回はエラーにせず「スキップ」として次回に任せる
- **サイト改修で動かなくなったら**: Actionsの失敗ログを確認し、docs/site-notes.md を参考に
  lib/scrape.js を修正する
