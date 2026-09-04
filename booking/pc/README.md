# 自宅 PC で予約支援サーバーを動かす(Windows + Docker Desktop)

自宅回線(SoftBank Air)から予約サイトへ出ると reCAPTCHA v3 で通り、「予約」までサーバーが自動で押せます。
このディレクトリの `docker-compose.yml` で、サーバー本体・Cloudflare Tunnel・URL 登録の3つをまとめて起こします。

```
LINE「予約」ボタン → Worker(固定URL) → Cloudflare Tunnel → この PC の予約サーバー → 予約サイト(自宅IPで v3 通過)
                                   ↑ registrar が Tunnel の現在の URL を 4 分ごとに登録
```

## 前提(Windows 側)

- Windows 10/11(64 ビット)。常時電源オン(電源設定で「スリープしない」「フタを閉じても何もしない」)
- Docker Desktop(WSL2 バックエンド)がインストール済みで、`docker run hello-world` が通る
- Git for Windows(リポジトリを取得するため)。無ければ ZIP でダウンロードしても可

## 初回の手順

1. リポジトリを取得(PowerShell)

   ```powershell
   git clone https://github.com/y-ykym/tennis-court-monitor.git
   cd tennis-court-monitor\booking\pc
   copy .env.example .env
   notepad .env
   ```

2. `.env` に値を書く(パスワード等は本人が入力。ファイルは gitignore 済み)

   | キー | 値 |
   |---|---|
   | `SITE_USER_A` / `SITE_PASS_A` / `LABEL_A` | 予約サイトの利用者番号・パスワード・呼び名(B は任意) |
   | `BOOKING_SIGNING_SECRET` | GitHub Secrets / Worker と同じ署名鍵 |
   | `WORKER_URL` | 玄関の Worker の URL(既定値のまま) |
   | `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_USER_ID` | 結果を LINE に push したいとき(任意) |

3. 起動(初回はイメージのビルドに 10 分前後)

   ```powershell
   docker compose up -d --build
   docker compose logs -f registrar
   ```

   `登録しました: xxxx.trycloudflare.com` と出れば、外(スマホ)から届く状態です。`Ctrl+C` でログ表示を抜けてもコンテナは動き続けます。

4. 動作確認: PC のブラウザで http://localhost:8080/warmup を開いて `ok` が出ること。
   スマホで玄関の Worker の `/booking/status` を開いて `"registered": true` になっていること。

## 自動起動(PC を再起動しても復帰させる)

- Docker Desktop の設定 → General → **Start Docker Desktop when you sign in** をオン
- Windows の設定 → アカウント → サインイン オプション → 自動サインイン(またはロック画面のまま Docker が動く構成)を確認
- `docker-compose.yml` の各サービスは `restart: unless-stopped` なので、Docker Desktop が上がればコンテナも自動で復帰します

## 更新(コードが変わったとき)

```powershell
cd tennis-court-monitor\booking\pc
git pull
docker compose up -d --build
```

## よくある確認

- 状態: `docker compose ps` / ログ: `docker compose logs -f booking`
- 止める: `docker compose down`(登録は 10 分以内に自然に消え、Worker は「繋がりません」を案内します)
- Tunnel の URL は起動ごとに変わりますが、Worker が最新の URL に転送するので、LINE 側の設定を変える必要はありません
- 予約サイトのセッションは約 10 分で切れます。noVNC 画面(reCAPTCHA v2 が出たときだけ)が出たら数分以内に操作してください
