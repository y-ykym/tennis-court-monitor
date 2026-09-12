# 自宅サーバー(Raspberry Pi 5)で予約支援サーバーを動かす

自宅回線(SoftBank Air)から予約サイトへ出ると reCAPTCHA v3 で通り、「予約」までサーバーが自動で押せます。
このディレクトリの `docker-compose.yml` で、サーバー本体・Cloudflare Tunnel・URL 登録の3つをまとめて起こします。

```
LINE「<呼び名>で予約」ボタン → Worker(固定URL) → Cloudflare Tunnel → Pi 上の予約サーバー → 予約サイト(自宅IPで v3 通過)
                                                                          └ v2(画像問題)が出たら LINE に「確認が必要です」カード → ボタンで noVNC 画面
                                                                          └ 終わったら結果カードを LINE へ
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

## §1 OS の書き込み(Raspberry Pi Imager)

会社 Mac は記録メディアの接続がポリシーで禁止されているため、書き込みは**個人の Windows PC**で行う(Imager は Windows 版でよい)。以降の作業はすべて Mac から SSH。

Imager v2.0 系はステップ形式のウィザード。順に:

| 画面 | 入力 |
|---|---|
| Device / OS / Storage | Raspberry Pi 5 / **Raspberry Pi OS Lite (64-bit)**(「OS (other)」の中) / SDHC Card(32GB) |
| Hostname | `homepi` |
| Localisation | Capital city `Tokyo`(Time zone が `Asia/Tokyo` になる)、Keyboard `jp` |
| User | `yu` / パスワード(非常用。必ずメモ) |
| Wi-Fi | 有線 LAN なので空欄で Next |
| Remote access | Enable SSH → **「Use password authentication」** |
| Raspberry Pi Connect | Sign in して ON(個人利用は無料。外出先からブラウザでシェルが開ける) |

**公開鍵は Imager では登録しない。** v2.0.11 時点で「公開鍵認証のみ」を選ぶと SSH 鍵と Connect の設定が反映されないことがあった(2026-09-12 に実際に踏んだ。ホスト名は反映されるのに `Permission denied (publickey)` になる)。
鍵は初回 SSH 後に Mac から登録する:

```bash
ssh-copy-id yu@homepi.local        # Pi のパスワードを聞かれる(本人が入力)
ssh yu@homepi.local                # パスワード無しで入れれば OK
```

鍵で入れることを確認したら、**`sudo` をパスワード無しにする**(Pi 上で。パスワードを 1 回聞かれる)。
新しい Raspberry Pi OS は最初のユーザーにも sudo パスワードを要求するため、これを入れないと `pi-init.sh` や以降の管理コマンドを SSH 越しに流せない。鍵認証のみの家庭内サーバーなので、昔の Raspberry Pi OS の既定に戻す判断:

```bash
echo 'yu ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/010_yu-nopasswd && sudo chmod 440 /etc/sudoers.d/010_yu-nopasswd && sudo -n true && echo OK
```

続けてパスワード認証を閉じる:

```bash
echo 'PasswordAuthentication no' | sudo tee /etc/ssh/sshd_config.d/10-no-password.conf
sudo sshd -t && sudo systemctl restart ssh
```

Raspberry Pi Connect は Imager で Sign in しておけば初回起動で紐づく(`rpi-connect status` で `Signed in: yes`)。connect.raspberrypi.com の Devices に `homepi` が出る。

## §2 組み立てと初回起動(ケース無し)

1. Pi の基板に Active Cooler を載せ、ファンのケーブルを FAN コネクタへ
2. M.2 HAT+ を 16mm スタッキングヘッダで載せ、PCIe の FPC ケーブルを Pi 側と HAT+ 側に差す(向きと止め具に注意)
3. SN530 を HAT+ の M.2 スロットに差し、**2230 側の穴**でネジ止め
4. microSD を差し、電源(27W)を入れる。基板むき出しなので、絶縁物(紙・ケースの箱など)の上に置き、金属に触れないように
5. 1〜2 分待って Mac から接続。`.local` が引けない場合はルーターの DHCP 一覧で IP を確認

```bash
ssh yu@homepi.local
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
ssh yu@homepi.local
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

# 2. 複製ツール(rpi-clone)を入れて、SD → NVMe に複製(約 1 分。NVMe の中身は消える)
#    git clone は回線の瞬断で落ちたので、1 ファイルを再試行付きで取る
curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 -o /tmp/rpi-clone https://raw.githubusercontent.com/geerlingguy/rpi-clone/master/rpi-clone
sudo install -m 755 /tmp/rpi-clone /usr/local/sbin/rpi-clone
sudo apt-get install -y rsync      # Lite には入っていない
sudo rpi-clone nvme0n1 -f          # 「Initialize and clone ...? (yes/no)」に yes、ラベルは Enter。-q は初期化時に使えない

# 3. 起動順を「NVMe → SD」にする(非対話。raspi-config でも可)
sudo rpi-eeprom-config > /tmp/boot.conf
sed -i 's/^BOOT_ORDER=.*/BOOT_ORDER=0xf416/' /tmp/boot.conf   # 行が無ければ echo 'BOOT_ORDER=0xf416' >> /tmp/boot.conf
sudo rpi-eeprom-config --apply /tmp/boot.conf
sudo reboot
```

`BOOT_ORDER=0xf416` は 6 = NVMe, 4 = USB, 1 = SD の順に試す設定(右から読む)。SSH から流すときは `/usr/local/sbin` が PATH に無いので `sudo /usr/local/sbin/rpi-clone` のようにフルパスで呼ぶ。2026-09-12 実測: 複製 1 分、再起動から SSH 復帰まで約 40 秒。

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
| `BOOKING_SIGNING_SECRET` | GitHub Secrets / Worker と同じ署名鍵。手元に値が無ければ `openssl rand -base64 32` で作り直し、GitHub Secrets(`gh secret set BOOKING_SIGNING_SECRET`)・Worker(`npx wrangler secret put BOOKING_SIGNING_SECRET`)・この `.env` の 3 か所に同じ値を入れる(GCP は撤去済み) |
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
- **Tunnel の見張り**: 回線の瞬断が長引くと quick tunnel が `Unauthorized: Tunnel not found` のまま自力で戻れない(2026-09-12 に発生。Worker 側の登録も 5 分で消え、ボタンは「繋がりません」になる)。`tunnel-watchdog.timer`(1 分ごと)が、ログにその文言が出るか `/ready` が 3 分連続で失敗したら `docker compose restart tunnel` する。状態は `./pi-check.sh` の「Tunnel」欄と `journalctl -u tunnel-watchdog --since today`
- 予約サイトのセッションは約 10 分で切れる。noVNC 画面(reCAPTCHA v2 が出たときだけ)は数分以内に操作
