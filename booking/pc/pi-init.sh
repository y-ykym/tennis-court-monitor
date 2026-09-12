#!/bin/bash
# ============================================================
# Raspberry Pi 5(Raspberry Pi OS Lite 64-bit)の初期化。何度実行しても安全(冪等)。
#   1. apt の更新と全体アップグレード、必要ツール(git, curl, smartmontools, nvme-cli)
#   2. EEPROM(ブートローダー)の更新
#   3. Docker Engine + compose plugin の導入、実行ユーザーを docker グループへ
#   4. リポジトリの取得(既にあれば git pull)
#   5. booking/pc/.env の雛形作成(値の入力は手動)
#   6. Tunnel 見張り(tunnel-watchdog.timer)の導入
#
# 使い方(Pi に SSH して。一度保存して中身を確認してから実行する):
#   curl -fsSLo pi-init.sh https://raw.githubusercontent.com/y-ykym/tennis-court-monitor/main/booking/pc/pi-init.sh
#   less pi-init.sh
#   bash pi-init.sh
# 終わったら一度ログアウト→再ログイン(docker グループ反映)。EEPROM 更新が入ったら sudo reboot。
# 済んだ手順は飛ばすので再実行しても壊れない。失敗時はどのステップで止まったかを表示する。
# ============================================================
set -euo pipefail

REPO_URL="https://github.com/y-ykym/tennis-court-monitor.git"
REPO_DIR="$HOME/tennis-court-monitor"
CURRENT_STEP="(開始前)"
# 各ステップの前に「何をするか」を表示し、失敗時にはどのステップで止まったかを出す
step() { CURRENT_STEP="$*"; printf '\n\033[1;32m== %s\033[0m\n' "$*"; }
on_error() {
  printf '\n\033[1;31m!! 失敗: ステップ「%s」で止まりました(終了コード %s)。\033[0m\n' "$CURRENT_STEP" "$?" >&2
  echo "   原因を直してから同じコマンドを再実行してください(済んだ手順は飛ばします)" >&2
}
trap on_error ERR

if [ "$(uname -m)" != "aarch64" ]; then
  echo "64-bit の Raspberry Pi OS ではありません(uname -m = $(uname -m))。Raspberry Pi OS Lite (64-bit) を使ってください" >&2
  exit 1
fi

# 新しい Raspberry Pi OS は sudo にパスワードを要求する。SSH 越しの nohup 実行では入力できないので先に確認する
if ! sudo -n true 2>/dev/null; then
  cat >&2 <<'EOS'
sudo にパスワードが必要な設定です。このスクリプトは sudo を多数回使うため、先に次を実行してください(パスワードを 1 回聞かれます):
  echo "$USER ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/010_$USER-nopasswd && sudo chmod 440 /etc/sudoers.d/010_$USER-nopasswd
詳細は booking/pc/README.md §1
EOS
  exit 1
fi

step "1/6 パッケージの更新と必要ツール(毎回実行。既に最新なら何も変わらない)"
# 自宅回線(SoftBank Air)は一瞬切れることがあるので、apt のダウンロードは自動で再試行させる
echo 'Acquire::Retries "5";' | sudo tee /etc/apt/apt.conf.d/80-retries >/dev/null
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates smartmontools nvme-cli
sudo apt-get autoremove -y

step "2/6 EEPROM(ブートローダー)の更新(最新なら up to date と出るだけ)"
if command -v rpi-eeprom-update >/dev/null 2>&1; then
  sudo rpi-eeprom-update -a || true
  echo "※ 「UPDATE AVAILABLE」や「reboot」と出ていたら、このスクリプトの後に sudo reboot する"
fi

step "3/6 Docker(入っていれば飛ばす)"
if ! command -v docker >/dev/null 2>&1; then
  # 回線の瞬断で curl が途中で切れることがあった(52, 35)ため、再試行付きで一度ファイルに落としてから実行する
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 -o /tmp/get-docker.sh https://get.docker.com
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
else
  echo "docker は既に入っています: $(docker --version)"
fi
if ! id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
  sudo usermod -aG docker "$USER"
  echo "※ $USER を docker グループに追加した。反映には一度ログアウト→再ログインが必要"
fi
sudo systemctl enable --now docker >/dev/null 2>&1 || true

step "4/6 リポジトリ(あれば git pull、無ければ clone)"
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$REPO_DIR"
fi

step "5/6 .env の雛形(既にあれば触らない)"
PC_DIR="$REPO_DIR/booking/pc"
if [ ! -f "$PC_DIR/.env" ]; then
  cp "$PC_DIR/.env.example" "$PC_DIR/.env"
  chmod 600 "$PC_DIR/.env"
  echo ".env を作成した(値は空)。次に nano $PC_DIR/.env で値を入力する"
else
  echo ".env は既にある(触らない)"
fi
chmod +x "$PC_DIR"/*.sh 2>/dev/null || true

step "6/6 Tunnel の見張り(systemd timer。quick tunnel が自力で戻れないときに再起動する)"
sudo install -m 644 "$PC_DIR/systemd/tunnel-watchdog.service" "$PC_DIR/systemd/tunnel-watchdog.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tunnel-watchdog.timer
echo "tunnel-watchdog.timer: $(systemctl is-active tunnel-watchdog.timer)(ログは journalctl -u tunnel-watchdog)"

trap - ERR
cat <<EOF

初期化が終わりました(全 6 ステップ完了)。次にやること:
  1. exit して再ログイン(docker グループ反映)。EEPROM 更新があれば sudo reboot
  2. SSD の確認:            $PC_DIR/pi-check.sh --smart
  3. NVMe 起動へ切替:        booking/pc/README.md §5
  4. 設定を入力:            nano $PC_DIR/.env
  5. 起動:                  cd $PC_DIR && docker compose up -d --build
  6. 疎通確認:              $PC_DIR/pi-check.sh
EOF
