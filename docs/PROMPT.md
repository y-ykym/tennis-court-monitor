# ローカルのClaude Codeに渡すプロンプト

以下をそのままコピーしてClaude Codeに貼り付けてください(このリポジトリのルートで実行)。

---

あなたのタスクは、このリポジトリの `lib/scrape.js` を実装することです。**変更してよいのは原則 `lib/scrape.js` のみ**(必要なら `docs/site-notes.md` の新規作成と、`package.json` への依存追加は可)。他のファイル(check.js, lib/filter.js, lib/state.js, lib/notify.js, lib/maintenance.js, .github/workflows/monitor.yml)は完成済みなので触らないでください。

## 背景

東京都スポーツ施設予約システムのテニスコート空き状況を定期チェックしLINE通知するシステム。あなたが担当するのは「サイトから空き枠を取得する」部分だけ。取得後の絞り込み・差分検出・通知は実装済み。

## 手順

### 1. Chrome DevToolsでサイトを調査する

- まず https://kouen.sports.metro.tokyo.lg.jp/web/index.jsp を開く。**2025年3月に新システムへ移行した可能性が高い**ので、エラーや案内が出たら https://yoyaku.sports.metro.tokyo.lg.jp/ や https://yoyaku.sports.metro.tokyo.jp/ を試し、現行の正しい入口URLを特定する
- ログインせずに「空き状況照会(空き施設状況の照会)」へ進む(照会だけならログイン不要のはず)
- 種目「テニス(人工芝)」、施設「猿江恩賜公園」「亀戸中央公園」「大島小松川公園」の空き状況の週表示カレンダーまで到達する
- カレンダー上で「空きあり」がどう表現されるか(🟣記号と空き面数の表示。HTML上の実体: 要素・class・alt属性など)、「次の週」への送り方、日付・時間帯・施設名の取得方法をDevToolsで特定する
- 調査でわかった画面遷移・セレクタ・注意点を `docs/site-notes.md` に記録する

### 2. `lib/scrape.js` を実装する

ファイル冒頭のコメントに書かれた契約を厳守すること。要点:

- `scrapeAvailability(): Promise<Slot[]>` をエクスポート
- `Slot = { facility: string, date: "YYYY-MM-DD", time: string, count: number }`
- Playwright(headless chromium)を使用。`playwright` は依存に追加済み
- 対象は「テニス(人工芝)」×3公園、当日から1ヶ月分(週送りで収集)
- 見つけた空き枠は絞り込まず全部返す(絞り込みは filter.js の仕事)
- ログイン・予約・キャンセル等の書き込み操作は絶対にしない(読み取り専用)
- 失敗時(メンテナンス画面・タイムアウト)は `debug/` にスクリーンショットを保存してから throw する
- GitHub Actions(ubuntu-latest)で動くこと。日本語ロケール依存やheadful前提にしない
- 待機は固定sleepでなく `waitForSelector` 等を使い、1回の実行が数分以内に収まるようにする

### 3. 動作確認

```bash
npm install
npx playwright install chromium
node check.js --dry-run
```

- 「空き枠: サイト全体 N件 / 監視対象 M件」が表示され、エラーにならないこと
- N件の内訳をいくつかサンプル表示し、実際のサイト画面と目視で一致確認すること
- 空きが1件もない場合も正常終了すること

## 禁止事項

- サイトへの過剰アクセス(調査中もリロード連打をしない)
- 予約・抽選申込などの書き込み操作
- トークン等の秘密情報をコードに書くこと

---

## (参考)旧システムの施設コード

調査の手がかり用。新システムでは変わっている可能性あり。

| コード | 内容 |
|---|---|
| 種目 23 | テニス(人工芝) |
| 施設 05 | 猿江恩賜公園(人工芝8面・照明あり) |
| 施設 06 | 亀戸中央公園(人工芝4面) |
| 施設 24 | 大島小松川公園A(人工芝4面) |
