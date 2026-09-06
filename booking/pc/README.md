# 自宅サーバー(Raspberry Pi 5)で予約支援サーバーを動かす

自宅回線(SoftBank Air)から予約サイトへ出ると reCAPTCHA v3 で通り、「予約」までサーバーが自動で押せます。
このディレクトリの `docker-compose.yml` で、サーバー本体・Cloudflare Tunnel・URL 登録の3つをまとめて起こします。

```
LINE「予約」ボタン → Worker(固定URL) → Cloudflare Tunnel → Pi 上の予約サーバー → 予約サイト(自宅IPで v3 通過)
                                   ↑ registrar が Tunnel の現在の URL を 2 分ごとに登録
```

## 実機構成(2026-09-06 購入)

| 部品 | 製品 |
|---|---|
| 本体 | Raspberry Pi 5 / 8GB(SC1112) |
| 冷却 | 公式 Active Cooler(SC1148) |
| M.2 | 公式 M.2 HAT+(SC1166。16mm スタッキングヘッダ付属)。SSD は **2230 側の固定穴** を使う |
| SSD | WD PC SN530 256GB、M.2 2230、NVMe Gen3 x4(SDBPTPZ-256G。バルク品、店の初期不良対応 180 日) |
| 電源 | 公式 27W USB-C PSU(SC1418、5.1V/5A) |
| ケース | Geekworm P579 V4(内寸高 37mm。Active Cooler + トップマウント M.2 HAT 対応、スペーサー 17mm 以下)。到着が遅いので**ケース無しで先に動作確認**する |
| microSD | KIOXIA 32GB(初期設定と NVMe 起動への切替に使う。切替後は予備) |

画面・キーボード・マウスは不要(Mac から SSH)。

## 手順の全体像

1. Mac の Raspberry Pi Imager で microSD に OS を書く(§1)
2. 組み立て(ケース無し)→ 電源投入 → SSH(§2)
3. 初期化スクリプト `pi-init.sh`(更新・EEPROM・Docker・リポジトリ取得)(§3)
4. SSD の SMART 確認(バルク品なので使用時間がほぼ 0 か見る)(§4)
5. microSD の中身を SSD に複製し、NVMe 起動へ切替(§5)
6. `.env` を書いて `docker compose up -d --build` → 疎通確認(§6)
7. 実枠で通し → GitHub Secrets に BOOKING_BASE_URL を登録して運用開始(§7)
8. ケース到着後に組み替え。自動復帰・更新の運用(§8)

---

## §1 OS の書き込み(Mac、Raspberry Pi Imager)

- デバイス: Raspberry Pi 5 / OS: **Raspberry Pi OS Lite (64-bit)** / ストレージ: microSD(KIOXIA 32GB)
- 「設定を編集」で:
  - ホスト名 `tennis-pi`、ユーザー名 `yu`(パスワードも設定)
  - Wi-Fi: SoftBank Air の SSID/パスワード、国 `JP`(有線 LAN で繋ぐなら省略可)
  - ロケール: タイムゾーン `Asia/Tokyo`、キーボード `jp`
  - サービス: **SSH を有効化 → 公開鍵認証のみ**。公開鍵は `~/.ssh/id_ed25519.pub` の内容(`pbcopy < ~/.ssh/id_ed25519.pub`)

## §2 組み立てと初回起動(ケース無し)

1. Pi の基板に Active Cooler を載せ、ファンのケーブルを FAN コネクタへ
2. M.2 HAT+ を 16mm スタッキングヘッダで載せ、PCIe の FPC ケーブルを Pi 側と HAT+ 側に差す(向きと止め具に注意)
3. SN530 を HAT+ の M.2 スロットに差し、**2230 側の穴**でネジ止め
4. microSD を差し、電源(27W)を入れる。基板むき出しなので、絶縁物(紙・ケースの箱など)の上に置き、金属に触れないように
5. 1〜2 分待って Mac から接続。`.local` が引けない場合はルーターの DHCP 一覧で IP を確認

```bash
ssh yu@tennis-pi.local
```

## §3 初期化スクリプト

初回のみ。更新・EEPROM 更新・Docker 導入・リポジトリ取得・`.env` の雛形作成までを行います(値の入力は手動)。
済んでいる手順は飛ばすので、途中で失敗しても直し次第そのまま再実行できます(失敗時はどのステップで止まったかを表示します)。

推奨は「一度保存して中身を確認してから実行」の2段階です。

```bash
curl -fsSLo pi-init.sh https://raw.githubusercontent.com/y-ykym/tennis-court-monitor/main/booking/pc/pi-init.sh
less pi-init.sh        # 中身を確認(q で閉じる)
bash pi-init.sh
```

終わったら一度ログアウトして再ログイン(docker グループを反映)。EEPROM 更新が入った場合は `sudo reboot`。

```bash
exit
ssh yu@tennis-pi.local
docker run --rm hello-world
```

## §4 SSD の SMART 確認(バルク品)

```bash
lsblk                                  # nvme0n1 が見えること
sudo smartctl -a /dev/nvme0n1 | grep -E "Model Number|Serial Number|Firmware|Power On Hours|Power Cycles|Percentage Used|Data Units Written|Critical Warning|Temperature"
```

見るところ: `Power On Hours` が 0〜数時間、`Percentage Used` が 0%、`Data Units Written` が小さい値なら未使用に近い品です。
`Critical Warning` は `0x00` であること。数値が大きければ中古の可能性があるので、購入店の初期不良対応(180 日)の範囲で相談します。
`pi-check.sh` でもまとめて表示できます(§6)。

## §5 NVMe 起動への切替(microSD → SSD)

microSD で動いている今の状態(ユーザー・Wi-Fi・SSH 設定込み)を丸ごと SSD に複製し、起動順を NVMe 優先にします。
まずは PCIe Gen2(既定)で安定を確認し、Gen3 化は任意です。

```bash
# 0. 複製の前に EEPROM(ブートローダー)を最新にしておく(pi-init.sh で済んでいれば「up to date」と出るだけ)
sudo rpi-eeprom-update -a          # 更新が入ったら sudo reboot してから次へ

# 1. SSD が見えていることを確認
lsblk                              # nvme0n1 が 238.5G で見えること

# 2. 複製ツール(rpi-clone)を入れて、SD → NVMe に複製(数分。NVMe の中身は消える)
git clone https://github.com/geerlingguy/rpi-clone.git ~/rpi-clone
sudo install -m 755 ~/rpi-clone/rpi-clone /usr/local/sbin/
sudo rpi-clone nvme0n1 -f

# 3. 起動順を「NVMe → SD」にする
sudo raspi-config                  # Advanced Options → Boot Order → NVMe/USB Boot(NVMe を SD より先に)→ Finish → 再起動
```

`raspi-config` の代わりに `sudo rpi-eeprom-config --edit` で `BOOT_ORDER=0xf416` と書いても同じです(6 = NVMe, 4 = USB, 1 = SD の順に試す)。

再起動後に、SSD から起動していることを確認:

```bash
findmnt /                          # SOURCE が /dev/nvme0n1p2 なら SSD 起動
lsblk -o NAME,SIZE,MOUNTPOINTS     # nvme0n1p2 の MOUNTPOINTS が / になっている
sudo rpi-eeprom-config | grep BOOT_ORDER
```

確認できたら **電源を切って microSD を抜き、電源を入れ直して SSD 単独で起動する**ことを確認します(再度 `findmnt /`)。
microSD は予備として保管します(挿したままでも NVMe が優先されますが、切替の確認は抜いた状態で行うこと)。

Gen3 化(任意。数日安定してから): `/boot/firmware/config.txt` に `dtparam=pciex1_gen=3` を追記して再起動。
不安定(SSD が見えなくなる・エラー)なら行を消して戻します。この用途では Gen2 で十分です。

## §6 予約サーバーの起動と疎通確認

```bash
cd ~/tennis-court-monitor/booking/pc
nano .env          # 値を入力(下表)。パスワードは本人が入力。ファイルは git 管理外
docker compose up -d --build      # 初回ビルド 10〜15 分
docker compose logs -f registrar  # 「登録しました: xxxx.trycloudflare.com」が出たら Ctrl+C
```

| キー | 値 |
|---|---|
| `SITE_USER_A` / `SITE_PASS_A` / `LABEL_A` | 予約サイトの利用者番号・パスワード・呼び名(B は任意) |
| `BOOKING_SIGNING_SECRET` | GitHub Secrets / Worker と同じ署名鍵(GCP Secret Manager `booking-signing-secret`) |
| `WORKER_URL` | 玄関の Worker の URL(既定値のまま) |
| `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_USER_ID` | 結果を LINE に push したいとき(任意。GitHub Secrets と同じ値) |

疎通確認(まとめて表示するスクリプトもあります: `./pi-check.sh`):

```bash
curl -s http://localhost:8080/warmup                                   # ok
curl -s https://tennis-reservation-bot.y-ykym.workers.dev/booking/status   # {"registered":true,"host":"....trycloudflare.com"}
docker compose ps                                                      # 3 サービスが Up
```

## §7 実枠で通し → 運用開始

1. 署名付きの予約 URL(Mac 側で発行。`booking/src/token.js` の `sign()`)をスマホで開く → 予約者を選ぶ → 30〜60 秒で自動予約 → 結果画面と LINE
2. 予約サイトでテスト予約をキャンセル(テニスは利用日の 4 日前まで無料)
3. GitHub Secrets に `BOOKING_BASE_URL=https://tennis-reservation-bot.y-ykym.workers.dev` を登録 → 次の空き通知から「予約」ボタンが付く

## §8 運用

- **自動復帰**: 各サービスは `restart: unless-stopped`。Pi が再起動すれば Docker と一緒に上がる。`sudo reboot` で一度確認しておく
- **ケース到着後**: 電源を切って P579 に組み込む(Active Cooler と HAT+ をそのまま収める。スペーサーは付属の 16mm)
- **更新**: `cd ~/tennis-court-monitor/booking/pc && git pull && docker compose up -d --build`
- **OS の更新**: `sudo apt update && sudo apt full-upgrade -y`(手動。`unattended-upgrades` を入れる場合も自動再起動はさせない)
- **状態確認**: `docker compose ps` / `docker compose logs -f booking` / `./pi-check.sh`
- **止める**: `docker compose down`(Worker の登録は 5 分で消え、ボタンは「繋がりません」を案内)
- Tunnel の URL は起動ごとに変わるが Worker が最新へ中継するので、LINE 側の設定変更は不要
- 予約サイトのセッションは約 10 分で切れる。noVNC 画面(reCAPTCHA v2 が出たときだけ)は数分以内に操作
