# 都立公園スポーツ施設予約システム 調査メモ (2026-08-31 Chrome DevToolsで調査)

## 【現行実装】ブラウザ不要のJSON API

週表示カレンダーはページ遷移後にJSON APIから描画されており、素のHTTP(Cookie持ち回り)だけで取得できる。
lib/scrape.js はこの方式で実装している(Playwright不使用。依存もNode標準機能のみ)。

1. `GET /web/index.jsp` — セッションCookie(JSESSIONID)取得。メンテナンス中はこの応答に検索画面が含まれない
2. `POST /web/rsvWOpeInstSrchVacantAction.do` — 検索条件をセッションに載せる(公園ごとに1回)
   - `displayNo=pawab2000` `daystart=YYYY-MM-DD` `selectPpsClPpscd=1000_1030` `selectPpsClsCd=1000`
     `selectPpsCd=1030` `selectAreaBcd=<公園コード>` `dayofweekClearFlg=1` `timezoneClearFlg=1`
   - 応答HTMLのhiddenから `selectInstCd`(施設コード。例 猿江=10400030)と `selectBldName`(施設名)を取る
   - **これを飛ばしていきなり3を叩くとエラー画面(HTML)が返る**(セッション状態が前提)
3. `POST /web/rsvWOpeInstSrchVacantAjaxAction.do` — 1週間分の空き状況JSON
   - `displayNo=prwrc2000` `useDay=YYYYMMDD` `bldCd=<公園>` `instCd=<施設>` `transVacantMode=0` `clearFlag=0`
   - 週送りはブラウザだと `transVacantMode=4` だが、`useDay` を+7日して `mode=0` で取り直す方が簡単
   - `result[].timeResult[]` に7日分のセル: `alt`("空き"=画面の🟣 / "予約あり" / "保守日")、
     `rsvNum`(空き面数)、`startTime`/`endTime`(900, 1100 等の時刻コード)、`useDay`(YYYYMMDD)
   - 週表示のHTML(td.available等)はこのJSONから `createWeekInfo()` が生成しているので、両者は常に一致する

注意:
- レスポンスは **Shift_JIS(Windows-31J)**。`TextDecoder('shift_jis')` でデコードする(JSONも同様のcontent-typeで返る)
- CSRFトークン等は無し。Cookieだけで動く
- **一時的な502がわりと出る**(観測では数十リクエストに1回程度)。公園単位で新セッションからリトライすれば回復する
- 502のほかに、**セッションを認識しないまま200が返る**パターンもある: 検索POSTへの応答が
  「公園未指定」状態の空き状況画面(hiddenの `selectBldCd`/`selectInstCd` が空)になる。
  ロードバランサ配下でセッションが引けないノードに当たる系の症状と思われ、これも新セッションでのリトライで回復する。
  検索応答の `selectBldCd` が期待した公園コードかを必ず検証すること

---

以下はブラウザ(DevTools)での画面調査の記録。HTML構造の話はPlaywright実装時代の参考情報だが、
画面遷移・コード類・ハマりどころはAPI方式でも前提知識として有効。

## 入口URL

- **https://kouen.sports.metro.tokyo.lg.jp/web/index.jsp が現行の正しい入口**(2023年リニューアル版のSPA風JSPサイト。旧URLのまま新システムに置き換わっており、リダイレクトやエラーは出ない)
- `yoyaku.sports.metro.tokyo.lg.jp` 系は使わない
- 空き状況の照会はログイン不要。ホーム画面の「空き状況検索」フォームから直接カレンダーまで到達できる

## 画面遷移

1. **ホーム** `GET /web/index.jsp`
   - 利用日: `input#daystart-home` (`type=date`, name=`daystarthome`) — `YYYY-MM-DD` でfill可能
   - 種目: `select#purpose-home` — **テニス（人工芝）= value `1000_1030`**(テニス（ハード）は `1000_1020`)
   - 公園: `select#bname-home` — 種目選択のchangeイベント(`changePurpose()`)で有効化・選択肢投入されるので、目的のoptionが現れるまで待つこと
     - **猿江恩賜公園 = `1040` / 亀戸中央公園 = `1050` / 大島小松川公園 = `1160`**(旧システムの05/06/24から変更されている)
   - 検索ボタン: `button#btn-go` → `POST /web/rsvWOpeInstSrchVacantAction.do` へ画面遷移
2. **空き状況画面(施設ごと)** `rsvWOpeInstSrchVacantAction.do`
   - 「１ヶ月空き表示」(`table#month-info`、初期は非表示・0行)と「１週間空き表示」(`table#week-info`)がある。**週表示は初期状態で展開済み**
   - 週表示は指定した利用日を1列目として7日分(列=日付、行=時間帯)
   - hiddenフォームに現在の状態が入っている: `form1.selectBldName`(公園名)、`form1.selectInstCd`(施設コード 例 `10400030`)、`form1.viewDay1`〜`viewDay7`(表示中の7日分 `YYYYMMDD`)

## 週表示カレンダー (`table#week-info`) の構造

- 行: ヘッダ行 + 時間帯6行。時間帯は **9時/11時/13時/15時/17時/19時 開始の2時間枠**(行見出し `th` は「　９時」のような全角表記)
- セルは全て `td` に **`id="YYYYMMDD_NN"`**(NN=時間帯インデックス 10,20,...,60)が付く → 日付はここから取れる(列ヘッダを読む必要なし)
- **空きセル**: `td.available` かつ中身が
  - `img[alt="空き"]`(`calendar_available_outline.svg`。画面上は🟣の丸)
  - `.calendar-availability span` に空き面数の数字
  - hidden input 3つ:
    - `input#A_YYYYMMDD_NN` = **空き面数**
    - `input#S_...` = 選択状態
    - `input#P_...` = `施設コード_YYYYMMDD_開始時刻_0`(例 `10400030_20260902_900_0` → 9:00開始)
- 空き以外のセル: `img[alt="予約あり"]`(グレー)、`img[alt="保守日"]` など。alt属性で区別できる
- **セルをクリックすると未ログインalert(`showAlert(msgNotLoggedIn)`)が出る予約導線なので、スクレイピングでは絶対にクリックしない**(読むだけ)

## 週送り

- 「<<前週 / <前日 / 次日> / 次週>>」はhrefなしの`a`要素で、`onclick="getWeekInfoAjax(4,0,0)"`(4=次週)による **Ajax更新(ページ遷移なし)**
- 更新完了は `#week-info` 内の `td` のidが翌週の日付(`現在の先頭日+7日`)に変わることで検知できる(`td[id^="YYYYMMDD_"]` をwaitForSelector)
- ローディング表示は `#loadingweek` / `#loadedweek` のdisplay切替

## ハマりどころ(自動化時の競合)

- **検索(`doSearch`)が送信に使うのは `#bname-home` ではなく、同期先の `#bname`(こだわり検索モーダル側)と hidden `#selectAreaBcd`**。同期は `#bname-home` のonchange(`filterInst3`)が行う
- 種目変更(`changePurpose`)は **500ms遅延(`gWaitTime`)+Ajax** で公園セレクトを**丸ごと再構築**する(`isProcessing1` フラグで多重実行防止)。タイミングが悪いと公園の選択が `0` に戻され、**公園未指定のまま検索が通ってしまう**(`doSearch` の検証は `$('#bname').val() < 1` なので val がnullだと素通りする)。結果画面に「「公園：」を選択して下さい。」と出て空のカレンダーになる
  - 対策: 公園選択後に `#bname-home` / `#bname` / `#selectAreaBcd` の3つが目的のvalueになったのを確認してから検索ボタンを押す。到達後も `form1.selectBldCd` が期待の公園コードか検証する
- 週テーブル(`#week-info`)の中身は**遷移直後はまだ無く、Ajaxで注入される**。`#loadedweek` が表示状態(ローディング中は `#loadingweek` と入れ替わる)になり、`td[id]` が現れてからパースすること

## その他の注意

- 公園を変えるには週表示画面の公園コンボは使えない(検索した1公園しか選択肢に出ない)ため、**公園ごとにホームから検索し直す**のが確実
- 定期メンテナンス(毎月27日12:00〜28日8:45等)中はフォームが出ないはず → `#purpose-home` のwaitForSelectorタイムアウトで検知
- 日付・種目・公園はid/valueで指定できるため日本語ロケール非依存。曜日表記(pc-text/sp-text)もパースには使わない

---

# フェーズ1.5 追加調査: ログインと予約一覧 (2026-09-02 Chrome DevTools + HTTP直叩きで調査)

「よやく」ボット(Cloudflare Workers)が使う、ログイン → 予約の確認 → ログアウトの流れ。
**読み取り専用。キャンセル(`rsvWCancelRsvAction.do` / `selectCancel=1`)は絶対に送らない。**

## 全体像

1. `GET /web/index.jsp` — セッションCookie(JSESSIONID)取得(フェーズ1と同じ)
2. `POST /web/rsvWTransUserLoginAction.do` — ログイン画面(`pawab2100.jsp`)を表示。**hiddenの `loginJKey`(128桁・表示ごとに変わる)を取る**
   - body: `displayNo=pawab2000&displayNoFrm=pawab2000`
3. `POST /web/rsvWUserAttestationLoginAction.do` — ログイン実行。成功するとログイン後ホーム(`pawab2000.jsp`、ヘッダーに「マイメニュー」「利用者カード表示」)が200で返る
4. `POST /web/rsvWGetCancelRsvDataAction.do` — 予約の確認・取消画面(`prwha1000.jsp`)。ここに予約一覧が **サーバ描画のHTML** で入っている(Ajax無し)
   - body: `displayNo=pawab2000&displayNoFrm=pawab2000`(直前画面のdisplayNo)
5. `POST /web/rsvWTransUserAttestationEndAction.do` — ログアウト(`displayNo=prwha1000&displayNoFrm=prwha1000`)。ログアウト後ホームが返る
   - ログアウト直後にホームの Ajax(お気に入り取得)が失敗して「データ通信を正しく行うことができませんでした」の alert が出ることがあるが、ログアウト自体は完了している

文字コードは全て **Shift_JIS(Windows-31J)**、`content-type: text/html;charset=Windows-31J`。CSRFトークンは無く、`loginJKey` だけがページ由来の値。

## ログインの詳細(`pawab2100.jsp` + `js/pawab2100.js` の `submitLogin()`)

- 入力項目: `userId`(半角数字8桁・`type=tel`)、`password`(最大24文字)
- hidden: `fcflg`(空)、`displayNo=pawab2100`、`loginJKey`
- **ブラウザはパスワードを1文字ずつ `loginCharPass` という hidden に分解して追加してから送る**(`loginCharPass=a&loginCharPass=b&...` の形)。自動化でも同じ形で送る
- 送信先: `POST /web/rsvWUserAttestationLoginAction.do`。フォーム(form1)の hidden 一式 + `userId` + `password` + `loginCharPass`×N
- reCAPTCHA: 組み込みはあるが `var gRecaptchaActive = false;` で **現在は無効**。有効化されると `recaptchaToken` が必要になり自動ログイン不可 → ログイン画面でこの変数を確認して true ならエラー扱いにする
- MFA(多要素認証): 設定画面 `rsvWTransSetMfaAction.do` は存在するが、**2026-09-02 の実機ログイン(利用者A)では認証コード等の追加画面は出なかった**
- 成功判定: 応答HTMLに `loginJKey` が無く、「マイメニュー」(`gRsvWTransMenuAction`)と `利用者カード表示` ボタンが含まれる
- 失敗時: ログイン画面(`pawab2100.jsp`)が再表示され、hidden のエラーメッセージを `showAlert()` で出す(例: 「パスワードは10桁以上で入力して下さい。…」)
- ログイン画面は約5分(`gTimerValue = 300`)で `rsvWTransUserAttestationEndAction.do` へタイムアウト遷移する
- **未ログインで手順4を叩いてもエラーにならず、ホーム画面(`pawab2000.jsp`)が200で返る**。応答の `<!-- prwha1000.jsp -->` コメント(または `id="rsvacceptlist"`)で画面種別を必ず確認する

## 予約一覧の構造(`prwha1000.jsp`)

- `<table id="rsvacceptlist" class="table sp-block-table">` の `<tbody>` に **1予約=1行**(`<tr>`)
- 各行の列: 予約番号 / 利用日 / 時間 / 公園・施設 / 設備予約 / 支払状況 / キャンセル(ボタン) / 使用券ダウンロード
- 各行には詳細モーダル(`<div class="modal" id="rsvDetailN">`)が埋め込まれ、その中の `<table class="mx-auto">` が **項目名付きで一番解析しやすい**:

  ```html
  <tr><th scope="row">予約番号</th><td>2026000001</td></tr>
  <tr><th scope="row">利用日</th><td><span class="dow-sunday">9月6日(日曜)</span>2026年</td></tr>
  <tr><th scope="row">時間</th><td>19時00分～21時00分</td></tr>
  <tr><th scope="row">公園・施設</th><td>猿江恩賜公園&nbsp;テニス（人工芝）</td></tr>
  <tr><th scope="row">利用目的</th><td>テニス（人工芝）</td></tr>
  <tr><th scope="row">利用人数</th><td>1人</td></tr>
  <tr><th scope="col">設備予約</th><td>あり</td></tr>
  <tr><th scope="col">支払状況</th><td>支払前</td></tr>
  <tr><th scope="col">施設利用料金</th><td>3,600円</td></tr>
  ```

- 機械可読な hidden も行ごとにある: `useday0=20260906`(YYYYMMDD)、`stime0=1900`(開始時刻コード)、`penaltyday0=3`。終了時刻は hidden に無いので「時間」列(`19時00分～21時00分`)から取る
- 利用日の `<span>` は日曜・祝日で `class="dow-sunday"`、平日は class 無し(土曜は未確認。パースには使わない)
- 「状態」列は無い。この画面に載るのは **有効な(キャンセルされていない)予約のみ** で、キャンセル済みは消える想定。「支払状況」(支払前/支払済 等)が唯一の状態情報
- ページング: hidden `pageNo` / `cancelPageNo` があり、ページ送りは `submitPageIndex()` → `rsvWGetConfirmRsvDataAction.do`。予約3件の実機では1ページのみで、ページ送りUIは出ていない(件数上限は未確認)
- 0件のときの表示は未確認(該当利用者がいなかった)。`rsvacceptlist` に行が無い、または表自体が無いの両方を「0件」として扱う
- 抽選当選を確定した予約がこの一覧に載るかは未確認(該当データ無し)
- その他の hidden: `displayNo=prwha1000`、`procType=1`、`delIRsvJKey`(キャンセル用トークン。使わない)、`selectCancel`(行ごと、空)、`selectIndex=-1`

## 「予約の確認」以外のマイメニュー(参考。今回は使わない)

| メニュー | action |
|---|---|
| 予約の確認 | `rsvWGetCancelRsvDataAction.do` |
| 利用履歴(過去分) | `rsvWTransGetRsvDataListAction.do` |
| 抽選申込みの確認 | `lotWTransLotCancelListAction.do` |
| 抽選結果 | `lotWTransLotElectListAction.do` |
| オンライン支払い | `rsvWRsvGetNotPaymentRsvDataListAction.do` |
| ログアウト | `rsvWTransUserAttestationEndAction.do` |
