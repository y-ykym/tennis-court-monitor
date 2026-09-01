# テニスコート空き監視・LINE通知

東京都スポーツ施設予約システムの空き状況を GitHub Actions で定期チェックし、
新しい空きが出たときだけ LINE に通知します。ランニングコストはほぼ0円。

サイトの週表示カレンダーが使う内部JSON APIをHTTP(Node標準fetch)で直接叩くため、
ブラウザ自動化(Playwright)は不要です。依存パッケージは japanese-holidays の1個だけ。

## 監視条件

- 種目: テニス(人工芝)
- 平日: 猿江恩賜公園の19時枠のみ
- 土日祝: 猿江恩賜公園・亀戸中央公園・大島小松川公園の全時間帯
- 範囲: 当日から1ヶ月分 / チェック間隔: 5分おき(cron-job.orgからの外部トリガー。下記運用メモ参照)
- 条件を変えたいとき(公園の増減・平日の時間変更)は `lib/config.js` だけを編集

## ファイル構成

```
check.js                     メイン処理(取得→絞込→差分→通知→保存)
lib/scrape.js                内部APIから空き枠を取得(リトライ最大3回)
lib/config.js                公園定義・監視条件の一元管理
lib/filter.js                監視条件(平日/土日祝)での絞り込み
lib/state.js                 前回結果(state.json)との差分検出
lib/notify.js                LINEへのpush通知(カード型Flex Message)
lib/date.js                  JST基準の日付ユーティリティ
lib/maintenance.js           サイトの定期メンテ時間帯のスキップ判定
.github/workflows/monitor.yml  空きチェックの実行(起動はcron-job.orgから5分おき)
state.json                   前回の空き状況(自動更新される)
test/mock-slots.json         ロジック動作確認用のモックデータ
docs/site-notes.md           サイト調査記録(API仕様・画面遷移・コード表)
docs/予約空き監視_要件定義書.md  要件定義書
docs/PROMPT.md               scrape.js実装時にClaude Codeへ渡した指示(記録用)
```

## セットアップ手順

1. **LINE Developersでボットを用意**: Messaging APIチャネルを作成し、
   チャネルアクセストークン(長期)を発行。通知の受信先(自分)と友だちになるか、
   通知先グループにボットを招待しておく
2. **GitHub Secretsを登録**: Settings → Secrets and variables → Actions で
   `LINE_CHANNEL_ACCESS_TOKEN` と `LINE_USER_ID` を登録
   - `LINE_USER_ID` にはユーザーID(`U`〜)のほか**グループID(`C`〜)も指定可能**(グループ通知運用)
   - IDが分からないときは、Webhook URLに [webhook.site](https://webhook.site) を一時設定し、
     ボットへのメッセージ送信(ユーザーID)やグループ招待(グループID)のイベントJSONの
     `source` から拾う。取得後はWebhookをOFFに戻し、応答メッセージも無効化しておく
3. **ローカルで動作確認**(任意):
   ```bash
   npm install
   npm run test:logic   # モックデータでロジック確認(サイトアクセスなし)
   npm run dry-run      # 実サイト取得→通知内容の表示のみ(LINE送信なし)
   ```
4. **手動テスト**: GitHubの Actions タブ → tennis-court-monitor → Run workflow。
   実行モードで `mock-test` を選ぶと、サイトにアクセスせずモックデータで実際にLINEへ
   送信でき、通知経路とFlexカードの見た目を確認できる(state.jsonは更新されない)。
   `normal` は本番同等の実行。初回は state.json が空なので、監視対象の空きがあれば通知が届く
5. **運用開始**: 手動テストが通れば、あとは5分おきに自動実行される

## 運用メモ

- **通知が来る条件**: 前回チェック時に無かった空き枠が新たに出現したときだけ(重複通知なし)。
  「空き面数が減っただけ」では通知しない(施設×日付×時間帯の出現のみを差分とみなす)
- **通知の見た目**: カード型Flex Message(日付チップは土=青/日祝=赤、残1面はオレンジ強調、
  末尾に予約サイトへのリンクボタン)。1通に最大12件表示、超過分は「…ほかN件」と省略される
  (Flex Messageの10KB制限対策。20件載せると超過して400エラーになるため)
- **LINE無料枠**: 月200通まで。1回の実行で出た新規空きは1通にまとめて送信(グループ宛ては1通カウント)
- **Actions無料枠**: publicリポジトリは実行時間が無料・無制限。privateの場合は月2,000分の
  無料枠を消費する(1回約2分×5分おきだと超過するので、間隔調整かpublic化を検討)
- **定期起動の仕組み**: GitHubのschedule(cron)はこのアカウントで極端に間引かれる
  (5分指定で実効3〜4時間。最小構成の検証リポジトリ y-ykym/cron-canary でも同様)ため、
  cron-job.org から5分おきに workflow_dispatch API を叩いて起動している。
  canaryの実行間隔が5分に正常化したら、monitor.ymlにscheduleトリガーを復活させて
  cron-job.org側を停止し、一本化する
- **60日ルール**: scheduleトリガーを復活させた場合、publicリポジトリは活動が60日ないと
  定期実行が自動停止する点に注意(state.jsonの自動コミットで通常は維持される)
- **サイトメンテナンス**: 毎月27日12:00〜28日8:45と年末年始(12/28 12:00〜1/4 8:45)はスキップ
- **一時的なサーバエラー(502等)**: 公園単位で新セッションからリトライ(最大3回)。
  それでも失敗した回はエラーにせず「スキップ」として次回に任せる
- **サイト改修で動かなくなったら**: Actionsの失敗ログを確認し、docs/site-notes.md を参考に
  lib/scrape.js を修正する
