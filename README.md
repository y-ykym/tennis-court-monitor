# テニスコート空き監視・LINE通知

東京都スポーツ施設予約システムの空き状況を GitHub Actions で定期チェックし、
新しい空きが出たときだけ LINE に通知します。ランニングコストはほぼ0円。

フェーズ1.5として、LINEグループで `よやく` と送ると A・B 2人分の予約一覧をカードで返す
予約確認ボット(Cloudflare Workers)も稼働中です(後述「フェーズ1.5 予約確認ボット」)。
フェーズ1.6として、その一覧カードの「キャンセル」ボタンから予約を取り消す機能も同じ Worker で稼働中です
(後述「フェーズ1.6 予約キャンセル」)。
フェーズ3として、監視中の空きを自宅の Raspberry Pi が 1 分おきに見つけて自動で予約する機能を実装済みです
(後述「フェーズ3 自動予約」。稼働開始は dry-run で振り分けを確認してから)。

サイトの週表示カレンダーが使う内部JSON APIをHTTP(Node標準fetch)で直接叩くため、
ブラウザ自動化(Playwright)は不要です。依存パッケージは japanese-holidays の1個だけ。

## 監視条件

- 種目: テニス(人工芝)
- 平日: 猿江恩賜公園の19時枠のみ
- 土日祝: 猿江恩賜公園・亀戸中央公園・大島小松川公園の全時間帯
- 範囲: 当日から1ヶ月分 / チェック間隔: 3分おき(cron-job.orgからの外部トリガー。下記運用メモ参照)
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
lib/auto-rules.js            フェーズ3 自動予約の判断ルール(ペナルティ境界・除外日/除外枠・公園→時間帯の優先順・予約者・通知の振り分け)。
                             Actions(check.js)と Pi(booking/src/auto-runner.js)が同じコードを使う
lib/auto-client.js           Worker の /auto/* を署名付きで呼ぶ(Actions は生存と除外一覧の取得、Pi は heartbeat と除外枠の登録)
test/auto-rules.test.mjs     上記ルールのユニットテスト(npm test)
.github/workflows/monitor.yml  空きチェックの実行(起動はcron-job.orgから3分おき)
state.json                   前回の空き状況(自動更新される)
test/mock-slots.json         ロジック動作確認用のモックデータ
docs/site-notes.md           サイト調査記録(API仕様・画面遷移・コード表・ログイン/予約一覧)
docs/予約空き監視_要件定義書.md  要件定義書(§11 がフェーズ1.5)
docs/PROMPT.md               scrape.js実装時にClaude Codeへ渡した指示(記録用)

booking/                     フェーズ2 予約支援 + フェーズ3 自動予約(自宅の Raspberry Pi 5 で動かす Docker コンテナ。lib/ を共用)
  src/reserve.js             Playwright で ログイン→検索→枠選択→予約内容確認→「予約」→完了画面の解析。v2 が出たら人間へ引き渡し。
                             完了画面に到達しなくても予約一覧で成立を確かめる(verifyByList)。
                             reservationList/beforeApply オプションでログイン直後に予約一覧を見て件数の上限を判定(フェーズ3)
  src/site-inpage.js         高速経路: ブラウザ内 fetch でログイン〜枠選択(UI 操作を省く)。withList で予約一覧も取る
  src/reservation-list.js    予約の確認一覧(prwha1000)の解析と照合(Worker の parseReservations と同じ)
  src/token.js               LINE ボタン用の署名付きトークン(枠情報+予約者+有効期限、HMAC)
  src/cancel-token.js        フェーズ1.6 の「キャンセル」postback data を Pi 側で作る(Worker と同形式。自動予約の成功カード用)
  src/result-flex.js         LINE に push するカード(予約結果 / 🔐 確認が必要です)。自動予約の表記とキャンセルボタンにも対応
  src/line-queue.js          回線断で送れなかった LINE カードを保存して 1 分ごとに再送(最長 6 時間)
  src/booking-queue.js       予約実行の行列(1 件ずつ。手動ボタンを自動予約より優先)
  src/auto-state.js          自動予約の状態ファイル(既知の枠・試行記録・自分が取った枠。/var/lib/booking/auto-state.json)
  src/auto-runner.js         フェーズ3 の中核: 1 分おきの空き照会 → 差分 → 振り分け → 行列へ → 結果カード。Worker への heartbeat
  server/server.mjs          Web アプリ(/book は Worker 向け JSON、/vnc は reCAPTCHA 時の noVNC 画面、/status /result /abort、/auto/status)。
                             WebSocket 橋渡しも内蔵。AUTO_BOOKING=on|dry-run で自動予約ループを起動
  server/register.mjs        Tunnel の現在の URL を 2 分ごとに Worker へ登録
  scripts/reserve-cli.mjs    予約実行を手元から動かす CLI(--dry-run で予約直前まで)
  scripts/auto-tick.mjs      自動予約の照会・振り分けを手元で 1 周期だけ動かす(予約しない。モック可)
  scripts/explore-flow.mjs   予約フローの調査スクリプト(本人ログイン。確定は押さない)
  Dockerfile / docker-entrypoint.sh  Playwright 公式イメージ + Xvfb + x11vnc。noVNC クライアントは esbuild で束ねる。
                             ビルドコンテキストはリポジトリ直下(lib/ を同梱するため。除外は直下の .dockerignore)
  pc/                        自宅 Pi 用: docker-compose.yml(本体+Tunnel+URL登録)、README.md(構築・運用手順)、pi-init.sh(初期化)、pi-check.sh(確認)、
                             tunnel-watchdog.sh + systemd/(Tunnel の見張り)、apt/(OS 自動更新の方針)
  test/                      node --test(トークン署名・カード・持ち越し・一覧の解析・行列・自動予約の振り分けと実行)

worker/                      フェーズ1.5 予約確認ボット + 1.6 予約キャンセル + フェーズ3 の状態置き場(Cloudflare Workers。lib/ とは独立)
  src/index.js               Webhook受け口(署名検証→「よやく」判定→A・B並行取得→reply。postback→確認カード/取消実行)
  src/line.js                LINE署名検証・イベント抽出(テキスト・postback)・reply送信
  src/site.js                予約サイトへログインして「予約の確認」一覧を取得。cancelReservation で取消 POST(1回だけ)
  src/cancel-token.js        「キャンセル」「はい」ボタンに載せる署名付き postback data(HMAC、期限付き)とペナルティ判定
  src/format.js              テキスト整形(0件・失敗時の文言)
  src/flex.js                予約一覧(人ごとのカルーセル)・キャンセル確認・結果のFlex Message。30KB/50KB制限に収まるよう行数を自動調整
  src/booking.js             フェーズ2 予約支援の玄関(予約ボタンの postback → 自宅サーバーの /book を叩く。noVNC の中継、URL 登録)
  src/monitor.js             Cron: 毎時の Pi 生存監視(LINE に ⚠️/✅)と月初のメンテのお知らせ。自動予約の照会ループが止まったときの ⚠️ も
  src/auto.js                フェーズ3: 除外日・除外枠・Pi の最終チェックを KV に持つ。/auto/state /auto/heartbeat /auto/exclusions(署名付き API)、
                             「じどう」コマンドと「解除」「日を追加」の postback、キャンセル成功時の除外枠の記録
  src/auto-flex.js           「じどう」への返信カード
  scripts/probe-site.mjs     ローカルからログイン確認(パスワード変更後の疎通確認にも)
  scripts/send-test-event.mjs 署名付きの模擬Webhookを wrangler dev に送る
  test/                      node --test のユニットテスト(fixturesは個人情報をダミー化済み)
  wrangler.toml              Workers設定(Secretsは含めない)
  .dev.vars.example          ローカル用環境変数のキー名一覧(値は書かない)
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
5. **運用開始**: 手動テストが通れば、あとは3分おきに自動実行される

## 運用メモ

- **通知が来る条件**: 前回チェック時に無かった空き枠が新たに出現したときだけ(重複通知なし)。
  「空き面数が減っただけ」では通知しない(施設×日付×時間帯の出現のみを差分とみなす)
- **通知の見た目**: カード型Flex Message(日付チップは土=青/日祝=赤、残1面はオレンジ強調、
  末尾に予約サイトへのリンクボタン)。1通に最大12件表示、超過分は「…ほかN件」と省略される
  (読みやすさの都合。バブルの上限は 30KB で、12件+A/Bボタンで約19KB。超える分は続きの通(最大5通)に分ける)
- **LINE無料枠**: 月200通まで。1回の実行で出た新規空きは1通にまとめて送信(グループ宛ては1通カウント)
- **Actions無料枠**: publicリポジトリは実行時間が無料・無制限。privateの場合は月2,000分の
  無料枠を消費する(1回約2分×3分おきだと超過するので、間隔調整かpublic化を検討)
- **定期起動の仕組み**: GitHubのschedule(cron)はこのアカウントで極端に間引かれる
  (5分指定で実効3〜4時間。最小構成の検証リポジトリ y-ykym/cron-canary でも同様)ため、
  cron-job.org から3分おきに workflow_dispatch API を叩いて起動している。
  ※ 観測用の cron-canary は観測を終了し、2026-09-10 にリポジトリを削除済み。
  GitHub cronの実行間隔が正常化したことを確認できた場合は、monitor.ymlにscheduleトリガーを
  復活させて cron-job.org 側を停止し、一本化する
- **60日ルール**: scheduleトリガーを復活させた場合、publicリポジトリは活動が60日ないと
  定期実行が自動停止する点に注意(state.jsonの自動コミットで通常は維持される)
- **サイトメンテナンス**: 毎月27日12:00〜28日8:45と年末年始(12/28 12:00〜1/4 8:45)はスキップ
- **一時的なサーバエラー(502等)**: 公園単位で新セッションからリトライ(最大3回)。
  それでも失敗した回はエラーにせず「スキップ」として次回に任せる
- **サイト改修で動かなくなったら**: Actionsの失敗ログを確認し、docs/site-notes.md を参考に
  lib/scrape.js を修正する

## フェーズ1.5 予約確認ボット(2026-09-02 稼働開始)

LINEグループで `よやく` と送ると、A・B 2人分の「予約の確認」一覧をカード(Flex Message)で返します。
reply(返信)は LINE の月200通の無料枠を消費しません。フェーズ1のコードと monitor.yml とは独立しています。

### 構成

```
LINEグループ「よやく」
  → LINE Platform が Webhook(POST /webhook)を送信
  → Cloudflare Workers(tennis-reservation-bot, 無料プラン)
      1. X-Line-Signature を LINE_CHANNEL_SECRET で検証(不一致は401)
      2. source.groupId === LINE_GROUP_ID かつ本文が「よやく」に完全一致 のイベントだけ処理。即座に200を返す
      3. (応答後に継続: ctx.waitUntil)A・B それぞれの利用者番号で予約サイトにログイン(並行)
         GET index.jsp → POST ログイン画面(loginJKey取得)→ POST ログイン → POST 予約の確認・取消画面
      4. 一覧HTML(Shift_JIS)を解析してカードに整形 → reply API で返信 → 予約サイトからログアウト
  → グループにカードが届く(通常 6〜12秒。予約サイトの応答速度に依存)
```

- 予約サイトへは読み取りだけを行い、キャンセル・予約・抽選などの操作は一切送りません
- LINE が Webhook の応答を長く待たないため、処理を先に終えてから200を返す方式は成立しません
  (実測でキャンセルされた)。200を先に返し、Cloudflare の `waitUntil`(応答後最長30秒)で処理を続けます。
  そのため取得は25秒で打ち切り、再試行は開始10秒以内の失敗のみ、ログアウトは返信後に回しています
- 返信の見た目: **人ごとに 1 枚のカードを横に並べたカルーセル**(スワイプで切り替え。1 人なら 1 枚)。各カードは濃紺ヘッダーに名前と「M/D 現在 ・ N件」、
  1予約1行で日付タイル(土=青/日祝=赤/平日=グレー)+時間+公園名。直近は「今日/明日」、当日で終了した枠はグレー+「終了」。
  フッターに「予約サイトを開く」「一覧を更新」。各カード 30KB・全体 50KB の制限に収まるまで 1 人あたりの行数を減らす(実測 2 人 × 20 件前後。超過は「…ほかN件」)
- 全員0件は「予約はありません」、全員失敗は「予約サイトに繋がりませんでした。少し待ってもう一度お試しください」、
  片方だけ失敗はその人の区画に「取得失敗」と表示
- 1分超過時の push フォールバック(§11.9)は**不採用**(2026-09-07 判断)。稼働 5 日間で返信は常に 6〜12 秒で、1 分に迫る例が無く、実装すると月 200 通の枠を消費するため。取得が遅くて返信できなかった場合は「よやく」を送り直す運用とする

### Secrets 一覧(Cloudflare Workers Secrets)

| 名前 | 内容 |
|---|---|
| `LINE_CHANNEL_SECRET` | Webhook署名検証用(LINE Developers → チャネル基本設定 → チャネルシークレット) |
| `LINE_CHANNEL_ACCESS_TOKEN` | reply送信用(GitHub Secrets と同じ値。**再発行するとフェーズ1の通知も止まる**) |
| `LINE_GROUP_ID` | 反応するグループID(GitHub Secret `LINE_USER_ID` と同じ C〜の値) |
| `SITE_USER_A` / `SITE_PASS_A` / `LABEL_A` | Aの利用者番号(8桁)・パスワード・返信に表示する名前 |
| `SITE_USER_B` / `SITE_PASS_B` / `LABEL_B` | Bの同上(未登録なら A だけで動く) |

値はコード・設定ファイル・リポジトリに一切書かず、`npx wrangler secret put <名前>` で登録します。
ローカル開発(`npm run dev`)では `worker/.dev.vars`(gitignore済み)に同じキー名で書くと読み込まれます。

### 配置手順(初回)

```bash
cd worker
npm install
npm test                       # ユニットテスト
npx wrangler login             # ブラウザでCloudflareにログイン
npx wrangler deploy            # 初回は workers.dev のサブドメイン名を聞かれる
npx wrangler secret put LINE_CHANNEL_SECRET        # 以下、Secretsを1件ずつ登録(値は対話入力)
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_GROUP_ID
npx wrangler secret put SITE_USER_A
npx wrangler secret put SITE_PASS_A
npx wrangler secret put LABEL_A
npx wrangler secret list       # 名前だけ一覧表示(値は出ない)
```

Secret の登録・更新は自動で新しい版が配置されるので、再デプロイは不要です。
コードを変えたときだけ `npx wrangler deploy` します。公開URLは `https://tennis-reservation-bot.<サブドメイン>.workers.dev`
で、`GET /` が `ok` を返せば生存確認OKです。

### LINE設定チェックリスト

LINE Developers コンソール → チャネル → Messaging API設定

- [ ] Webhook URL に `https://tennis-reservation-bot.<サブドメイン>.workers.dev/webhook`
- [ ] 「検証」で成功(Workerが署名を検証して200を返せている)
- [ ] 「Webhookの利用」ON
- [ ] 「Webhookの再送」OFF(ONだと同じ「よやく」に二重返信)
- [ ] 「グループトーク・複数人トークへの参加を許可する」ON(既にグループで通知できていれば済み)

LINE Official Account Manager → 設定 → 応答設定

- [ ] 「応答メッセージ」OFF(ONだと全発言に定型文が返る)
- [ ] 「Webhook」ON
- [ ] 「あいさつメッセージ」任意(OFF推奨)

### パスワードを変えたとき・ログインに失敗するとき

A または B が予約サイトのパスワードを変えたら、Secrets も更新します(再デプロイ不要)。

```bash
cd worker && npx wrangler secret put SITE_PASS_A     # Bなら SITE_PASS_B
```

先にローカルで新しいパスワードが通るか確かめられます(パスワードは非表示入力・保存されない):

```bash
cd worker
read -s SITE_PASS && export SITE_PASS
SITE_USER=<利用者番号> LABEL=A node scripts/probe-site.mjs
```

利用者カードの有効期限が切れるとログインできなくなり、カードのその人の区画が「取得失敗」になります
(ログには「ログインが拒否されました」と出る)。期限更新は有効期限の2週間前からサイトのマイメニューで行えます。

### トラブル時の確認手順

1. ログを流した状態でグループに `よやく` と送る:
   ```bash
   cd worker && npx wrangler tail --format pretty
   ```
   ログには通信ごとの所要時間(`[A] GET index.jsp 200 931ms` など)、取得結果、返信結果が出ます。
   利用者番号・パスワード・トークン・Cookie・グループID・表示名はログに出ない設計です
2. `webhook受信` 自体が出ない → LINE側の設定(Webhook URL・Webhookの利用ON・応答設定のWebhook ON)を確認
3. `対象イベント 0件` → グループIDの不一致(LINE_GROUP_ID)か、本文が「よやく」に完全一致していない
4. `署名不一致` → LINE_CHANNEL_SECRET の値が違う
5. `ログインが拒否されました` → 利用者番号・パスワード・利用者カードの期限を確認(再試行はしない設計)
6. `HTTP 502` や `予約確認画面が想定外です` → 予約サイト側の一時的な不調。少し待って再送。
   続く場合はサイト改修の可能性があるので docs/site-notes.md「フェーズ1.5 追加調査」を参考に worker/src/site.js を修正
7. `reCAPTCHA が有効になっており` → サイト側が画像認証を有効化した。自動ログイン不可なので方式の見直しが必要
8. 返信が来ないが `返信しました` は出ている → LINE側の一時的な遅延。`返信に失敗 ... HTTP 400` なら Flex の形式不備
   (テキスト版で自動再送する)、`HTTP 401` なら LINE_CHANNEL_ACCESS_TOKEN を確認
9. Cloudflare ダッシュボード → Workers & Pages → tennis-reservation-bot → Logs でも過去ログを見られます

## フェーズ1.6 予約キャンセル(2026-09-06 稼働開始)

「よやく」の予約一覧カードの各行に「キャンセル」ボタンが付きます。押すと確認カードが返り、「はい、キャンセルする」を押すと
Worker が予約サイトで取消を実行して結果カードを返します。ブラウザや自宅サーバーは使いません(取消導線に reCAPTCHA が無いことを
実機で確認済み。`docs/site-notes.md`「キャンセル機能の事前調査」)。要件は `docs/予約空き監視_要件定義書.md` §12、
構成図は `docs/system-overview-cancel.png`、カードの見た目は `docs/flex-design-cancel.png`。

### 使い方と挙動

1. `よやく` → 一覧カード。終了済みでない行に「キャンセル」ボタン(押した内容は「9/18 17:00 大島小松川公園 をキャンセル」としてトークに残る)
2. 確認カード「この予約をキャンセルしますか？」。利用日が 3 日以内なら「ペナルティ(1点)が付きます」の警告付き。
   「いいえ」→「キャンセルしませんでした」。ボタンは一覧表示から 60 分、確認カードから 10 分で期限切れ(「時間切れです」)
3. 「はい、キャンセルする」→ その人でログイン → 一覧を取り直し → 予約番号で行を探して日付・時刻・公園を照合 → 取消 POST(1回だけ)→
   - 成功: 緑の「キャンセルしました」カード(直後に `よやく` で消えたことを確認できる)
   - 一覧に無い: 「この予約は見つかりませんでした(既にキャンセル済みの可能性があります)」
   - 内容不一致: 「予約の内容が一覧と一致しないため中止しました」(送信しない)
   - 失敗・成否不明: グレーの「キャンセルできませんでした」カード。**取消されている可能性もあるので、必ずサイトで確認する**

誰の予約でも、グループのメンバーなら取り消せます(2 人グループの前提)。文字入力(「キャンセル」と打つ等)では受け付けません。
取消の POST は再試行しないので、二重に取り消されることはありません。

### 設定

- Secrets は追加なし(署名鍵は Worker に登録済みの `BOOKING_SIGNING_SECRET` を流用)
- `worker/wrangler.toml` の `[vars] CANCEL_ENABLED = "1"` でボタンを出す。`"0"` にして `npx wrangler deploy` すればボタンは消え、
  既に配られたカードのボタンを押しても「キャンセル機能は現在停止しています」と返す
- LINE Developers の「Webhookの再送」は OFF のまま(ON だと同じ postback が再配送される)

### 配置と実機テスト(2026-09-06 に実施済み。コードを変えたときの再確認手順)

```bash
cd worker
npm test                       # ユニットテスト(44件)
npx wrangler deploy
npx wrangler tail --format pretty
```

1. 予約サイトで**使い捨ての予約**を 1 件取る(本番の予約で試さない)
2. グループで `よやく` → その行に「キャンセル」ボタンが出ることを確認 → 押す → 確認カード → 「はい、キャンセルする」
3. 緑の「キャンセルしました」が返り、`よやく` で一覧から消えていれば OK。ログには `[cancel:A] 取消成功: 2026-09-18 17:00 大島小松川公園` と出る
4. 「いいえ」、期限切れ(10 分後に「はい」)、終了済み枠にボタンが無いことも確認する

### トラブル時

- `[cancel] 署名不正の postback を無視しました` → 署名鍵が変わった(古いカードのボタン)か、別の Worker のカード。`よやく` からやり直す
- `対象の予約が一覧にありません` → 既に取消済み、または別の人(A/B)の予約。`よやく` で確認
- `取消 POST の応答が完了画面ではありません (xxx.jsp)` → サイト改修の可能性。応答画面名を手がかりに `worker/src/site.js` の `isCancelDone` / `buildCancelForm` を見直す
- `取消 POST に失敗(成否不明)` → 通信断。サイトで状態を確認する(自動では再送しない)

## フェーズ2 予約支援(自宅 Raspberry Pi で自動予約。2026-09-13 稼働開始)

通知カードの各枠に **「<呼び名>で予約」ボタンが予約者(A/B)ごとに**付き、押すと(ブラウザは開かず)LINE に「受け付けました」と返り、
自宅の予約支援サーバーがその人として **ログイン〜枠の選択〜「予約」確定まで自動で行い**、結果(予約番号・料金)を LINE のカードで返します。
仕組み: ボタンは postback(ボットへの合図)で、Worker が署名を確かめて自宅サーバーの `/book` を叩き、返信する。
途中でロボット確認(reCAPTCHA v2 の画像問題)が出たときだけ、LINE に「確認が必要です」カードが届き、そのボタンから
予約サイトの確認画面を開いてチェックを押す(8 分以内)。それ以外に人の操作はありません。方針・経緯・調査結果は `docs/フェーズ2_予約支援_引き継ぎ.md`、
自宅サーバーの選定と手順は `docs/ラズパイ_自宅サーバー_引き継ぎ_自己完結版.md` と `booking/pc/README.md` を参照。

- なぜ自宅で動かすか: 予約サイトは確定時に reCAPTCHA v3 で採点し、**データセンターの IP(Cloud Run / GitHub Actions)からは毎回 v2 の
  画像問題が出て自動化できない**(実予約 0/3)。自宅回線からは画像問題なしで成立する(実測 4/4)。v2 が出たときだけ noVNC でスマホに画面を映して人間が解く
- 経路: LINE ボタン(postback。署名付きトークン)→ Cloudflare Worker `tennis-reservation-bot`(固定 URL の玄関。署名検証して Pi の `/book` を叩く)→ Cloudflare Tunnel →
  Raspberry Pi 5 上の Docker(予約サーバー + cloudflared + URL 登録)。Pi に届かないときは「繋がりませんでした。1〜2分後にもう一度」と返信
- 通知側の設定: GitHub Secrets に `BOOKING_SIGNING_SECRET` と `BOOKING_BASE_URL=https://tennis-reservation-bot.y-ykym.workers.dev`(どちらも登録済み。
  両方あるときだけ通知カードに予約ボタンが付く)、`LABEL_A` / `LABEL_B`(予約者の呼び名。設定した人の分だけ「<呼び名>で予約」が出る。
  どちらも無ければボタン無し)。ボタン付きは1通 12 枠まで、多いときは最大 5 通に分けて送る。通知と同時に `/warmup` を叩く
- 状態(2026-09-13): **稼働中**。自宅の Raspberry Pi 5(ホスト名 `homepi`、NVMe 起動)で Docker 3 サービスが常時動作。
  実枠で 3 回成立(最速 40 秒・完全自動)。**現在の状態・運用・残 TODO は `docs/引き継ぎ_フェーズ2運用.md`**。
  同日に追加した仕組み: Pi の生存監視(毎時、LINE に ⚠️/✅)、OS・Docker の自動更新(毎朝 4:00、必要なら 4:30 再起動)、
  月初のメンテのお知らせ、結果カードの持ち越し再送、「予約」後に一覧で成立を確かめる判定、Tunnel の見張り役。
  自宅回線(SoftBank Air)は夜に切れやすく、その間のボタンは「繋がりません」になる(1〜2 分後に押し直す。2026-09-26 に回線が安定する予定)
- 検証に使った Cloud Run と GitHub Actions からの予約は **2026-09-07 に撤去済み**: GCP プロジェクト `tennis-booking-c46c52c5` を削除(30 日以内なら `gcloud projects undelete` で復元可)、
  `booking/deploy.sh`・`.github/workflows/reserve.yml`・`booking/scripts/notify-result.mjs` を削除、GitHub Secrets の `SITE_USER_A` / `SITE_PASS_A` / `LABEL_A`(Actions 専用)を削除。
  2026-09-13 に GCS 保存(`profile-store.js`・`@google-cloud/storage`)と Node HTTP 版の高速経路(`site-http.js`)、ブラウザ向けの待機画面・予約者選択画面も削除
  (ボタンは postback になり、ブラウザを開くのは reCAPTCHA の `/vnc` だけ)

## フェーズ3 自動予約(2026-09-14 実装。稼働は dry-run で確認後に ON)

監視中の枠に空きが出たら、自宅の Raspberry Pi が **1 分おきに自分で空きを照会し、見つけたら同じプロセスで即予約**します。
要件と確定事項は `docs/PROMPT_フェーズ3_自動予約.md` §2〜§3(設計の背景データ含む)、要件定義書は `docs/予約空き監視_要件定義書.md` §13。

### 動き(要点)

| 場所 | 役割 |
|---|---|
| Pi(`booking/src/auto-runner.js`) | 1 分おき: 空き照会(`lib/scrape.js`、ログイン不要)→ 監視条件 → 前回との差分 → Worker に heartbeat(生存の合図。応答で除外日・除外枠を受け取る)→ `lib/auto-rules.js` で振り分け → 予約の行列へ。行列は 1 件ずつ実行し、LINE の予約ボタン(手動)を優先 |
| Actions(`check.js`) | 3 分おき(従来どおり): 新しい空きのうち、Worker の `/auto/state` で Pi の自動予約が生きて動いていれば **自動予約の対象(利用日 ≥ 今日+4 日、除外日以外)は通知しない**。Pi が止まっていれば従来どおり全部通知。除外枠は通知しない |
| Worker(`worker/src/auto.js`) | KV に 除外日・除外枠・Pi の最終チェック を持つ。「じどう」で一覧カード。キャンセル成功時にその枠を除外枠に記録 |

- **対象**: 利用日が今日+4 日以上先の枠(利用日 ≤ 今日+3 日はペナルティ期間なので自動予約せず、従来の通知カードに回す)。定数は `lib/config.js` の `AUTO_BOOKING`
- **締切と日付境界**: 利用日 = 今日+4 日の枠は **23:35 以降は自動予約しない**(取れても取消の猶予が無い。`LAST_DAY_DEADLINE`)。+5 日以降には締切なし。
  対象かどうかは **見つけた時と「予約」の直前の両方**で判定する(23:59 に見つけて 00:01 に予約すると +3 日 = ペナルティ期間になるため)。
  予約直前に対象外になった枠は予約せず、**Pi 自身が従来の空き通知カード(予約ボタン付き)を送る**(Actions は見つけた時点で「対象枠だから通知しない」と処理済みのことがある)。
  見つけた時点で対象外なら Pi は何もせず、Actions が従来どおり通知する。境界(23:35 前後の数分)では Actions と Pi の両方から同じ枠のカードが届くことがある
- **上限**: 利用日ごとに 2 件(手動で取った分も数える)。予約直前にログインして予約一覧を見て数える。同じ実行で複数候補があれば成立分も数え、達したら残りはログインせず見送る
- **順番**: 同じ利用日の候補は 公園(大島小松川 > 猿江恩賜 > 亀戸中央)→ 時間帯(17 > 19 > 9 > 11 > 13 > 15 時開始)。失敗したら次の候補へ
- **予約者**: 利用日が平日なら B、土日祝なら A(`isWeekendOrHoliday`)。人数は 2 人
- **通知**: 成功・失敗は既存の結果カードに「(自動予約)」を付けて送る。見送り(2 件あった・上位を取った)はカードなし。
  利用日 = 今日+4 日の成功カードには「⚠ 無料キャンセルは今日 23:59 まで」と「キャンセル」ボタン(フェーズ1.6 の取消処理に流れる。期限は今日 23:59)
- **除外日**: LINE で `じどう` → 除外日・除外枠の一覧カード。「📅 日を追加」(日付ピッカー)で追加、各行の「解除」で戻す。除外日の枠は自動予約せず従来の通知に回す。過ぎた日は自動で消える
- **除外枠**: LINE からキャンセルした枠(「よやく」の一覧、または成功カードのボタン。どちらも Worker の同じ取消処理)は、空きとして再出現しても自動予約せず、通知もしない。
  Pi が自動予約した枠がサイトで直接取り消されていた(次の予約一覧に無い)場合も除外枠に登録する。開始時刻を過ぎたら自動で消える
- **reCAPTCHA v2** が出た回は既存の「🔐 確認が必要です」カードで人が対応(自動予約でも同じ。回避・突破はしない)
- **初回起動**(状態ファイルが無い・10 分より古い): いま見えている空きを既知として登録し、予約しない(起動直後の暴走防止)
- **Worker に繋がらない**: 30 分以内に取れた除外一覧があればそれで続行、無ければ予約しない(除外日を守れないため)
- **Pi 不達の判定**(Actions 側): Pi の heartbeat が 4 分以内で、かつ mode が on のときだけ「生きている」。取れなければ全部通知(安全側)
- **同じ枠を二重に試さない**: 枠キー `公園コード|日付|開始時刻` で行列・試行記録を管理。成功した枠は再出現しても取り直さない(取り消したなら除外枠)

### 設定と起動(Pi の `.env`)

```
AUTO_BOOKING=off       # off(既定): ループを起動しない / dry-run: 照会と振り分けだけログに出す(予約しない) / on: 予約まで行う
# AUTO_POLL_MS=60000   # 照会間隔。30000 未満は 30000 に切り上げ(サイトへの配慮。要件 §7)
```

`WORKER_URL`・`BOOKING_SIGNING_SECRET`・`LINE_*` は既存の値をそのまま使います(新しい Secret は不要)。反映は他の変更と同じ:

```bash
ssh yu@homepi.local 'cd ~/tennis-court-monitor && git pull --ff-only && cd booking/pc && docker compose build booking && docker compose up -d'
docker compose logs -f booking | grep '\[auto\]'          # 振り分けのログ(見送りの理由も出る)
curl -s http://localhost:8080/auto/status | jq             # mode・最終照会・行列
curl -s https://tennis-reservation-bot.y-ykym.workers.dev/booking/status   # (従来) Pi の登録
```

Worker は `cd worker && npm test && npx wrangler deploy`(「じどう」と `/auto/*` が入る。Secrets の追加なし)。Actions は push で次回から反映(Secrets の追加なし。
`BOOKING_BASE_URL` と `BOOKING_SIGNING_SECRET` があれば `/auto/state` を見に行く)。

手元で振り分けだけ確かめる(予約しない・Worker にも繋がない):

```bash
cd booking && node scripts/auto-tick.mjs --mock ../test/mock-slots.json --all-new --today 2026-09-01
```

### 稼働開始の手順(推奨)

1. Worker を deploy → LINE で `じどう` と送ってカードが返ることを確認(除外日の追加・解除を試す)
2. Pi の `.env` に `AUTO_BOOKING=dry-run` を書いて再ビルド → 数日、`[auto]` のログで「予約するはず」「見送り」の振り分けを本人と確認。
   この間 Actions の通知は従来どおり全部届く(dry-run は active=false の合図を送るため)。「じどう」カードの「Pi の自動予約」は「停止中(dry-run)」と出る
3. 実枠テスト(本人の了解を得てから。利用日が 5 日以上先の枠。取消は「よやく」→「キャンセル」で当日中は無料)
4. `AUTO_BOOKING=on` にして再ビルド → 「じどう」カードが「稼働中」になり、Actions は対象期間の枠を通知しなくなる

### ログの読み方(`docker compose logs booking | grep '\[auto\]'`)

- `初回起動: いま見えている監視対象 N 件を既知として登録しました` … 起動直後(この分は予約しない)
- `新しい空き N 件: …` → 続いて各枠の `見送り: …(理由)` / `行列へ: …` / `[dry-run] 予約するはず: …`
- `自動予約 開始: …` → `予約一覧(予約前): N 件` → `自動予約 結果: success|taken|capped|… …`
- `見送り(予約直前の再判定): …(…。従来の空き通知カードを送る)` … 日付が変わった・23:35 を過ぎた・除外日になった(除外枠なら「通知もしない」)
- `除外一覧を更新: 除外日 N 件、除外枠 N 件` … Worker の一覧が変わったとき
- `Worker への合図に失敗(…)` … 回線断など。直近の一覧で続けるか、無ければ予約しない

### 気をつけること

- 高速経路のログイン直後に予約一覧(prwha1000)を 1 回取ってから空き検索に進む(サイトの画面遷移の順としては自然だが、実機で「検索結果画面が想定外」が出たら
  `site-inpage.js` の 2.5 の位置を枠選択の後ろに動かす)。UI 操作の経路でもログイン直後にブラウザ内 fetch で一覧を取る
- 空き照会(ログイン不要)は 1 分に 20 リクエスト程度。失敗時のレスポンスはコンテナに溜めない(`SCRAPE_DEBUG_DIR=''`)
- ログインを伴うのは予約の実行時だけ(候補 1 件につき 1 回)。dry-run では一切ログインしない
- Pi の生存監視(毎時)は従来どおり。加えて Pi は動いているのに heartbeat が 15 分止まっていれば「⚠️ 自動予約の空きチェックが止まっています」を 1 回(`AUTO_BOOKING=on` を申告しているときだけ)
