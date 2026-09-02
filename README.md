# テニスコート空き監視・LINE通知

東京都スポーツ施設予約システムの空き状況を GitHub Actions で定期チェックし、
新しい空きが出たときだけ LINE に通知します。ランニングコストはほぼ0円。

フェーズ1.5として、LINEグループで `よやく` と送ると A・B 2人分の予約一覧をカードで返す
予約確認ボット(Cloudflare Workers)も稼働中です(後述「フェーズ1.5 予約確認ボット」)。

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
.github/workflows/monitor.yml  空きチェックの実行(起動はcron-job.orgから3分おき)
state.json                   前回の空き状況(自動更新される)
test/mock-slots.json         ロジック動作確認用のモックデータ
docs/site-notes.md           サイト調査記録(API仕様・画面遷移・コード表・ログイン/予約一覧)
docs/予約空き監視_要件定義書.md  要件定義書(§11 がフェーズ1.5)
docs/PROMPT.md               scrape.js実装時にClaude Codeへ渡した指示(記録用)

worker/                      フェーズ1.5 予約確認ボット(Cloudflare Workers。lib/ とは独立)
  src/index.js               Webhook受け口(署名検証→「よやく」判定→A・B並行取得→reply)
  src/line.js                LINE署名検証・イベント抽出・reply送信
  src/site.js                予約サイトへログインして「予約の確認」一覧を取得(読み取りのみ)
  src/format.js              テキスト整形(0件・失敗時の文言)
  src/flex.js                予約一覧のFlex Message(カード)
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
  (Flex Messageの10KB制限対策。20件載せると超過して400エラーになるため)
- **LINE無料枠**: 月200通まで。1回の実行で出た新規空きは1通にまとめて送信(グループ宛ては1通カウント)
- **Actions無料枠**: publicリポジトリは実行時間が無料・無制限。privateの場合は月2,000分の
  無料枠を消費する(1回約2分×3分おきだと超過するので、間隔調整かpublic化を検討)
- **定期起動の仕組み**: GitHubのschedule(cron)はこのアカウントで極端に間引かれる
  (5分指定で実効3〜4時間。最小構成の検証リポジトリ y-ykym/cron-canary でも同様)ため、
  cron-job.org から3分おきに workflow_dispatch API を叩いて起動している。
  canaryの実行間隔が5分に正常化したら、monitor.ymlにscheduleトリガーを復活させて
  cron-job.org側を停止し、一本化する
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
- 返信の見た目: 濃紺ヘッダー「予約一覧 / M/D 現在」、人ごとに名前ラベルと件数、1予約1行で
  日付タイル(土=青/日祝=赤/平日=グレー)+時間+公園名。直近は「今日/明日」、当日で終了した枠はグレー+「終了」。
  Flexの10KB制限のため表示は9件まで(超過は「…ほかN件」)
- 全員0件は「予約はありません」、全員失敗は「予約サイトに繋がりませんでした。少し待ってもう一度お試しください」、
  片方だけ失敗はその人の区画に「取得失敗」と表示
- 1分超過時の push フォールバック(§11.9)は未実装。必要になったら追加する(200通枠を消費するため)

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
