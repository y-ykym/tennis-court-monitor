#!/bin/bash
# ============================================================
# Raspberry Pi 上の状態をまとめて確認する。
#   ./pi-check.sh          起動ディスク・温度・Docker・予約サーバー(/warmup)・Worker の登録状況
#   ./pi-check.sh --smart  上記に加えて NVMe SSD の SMART(バルク品の使用時間チェック)
# ============================================================
set -u
cd "$(dirname "$0")"
WORKER_URL=$(grep -E '^WORKER_URL=' .env 2>/dev/null | cut -d= -f2- || true)
WORKER_URL=${WORKER_URL:-https://tennis-reservation-bot.y-ykym.workers.dev}
hr() { printf '\n\033[1;36m-- %s\033[0m\n' "$*"; }

hr "起動ディスクと空き容量"
findmnt / -o SOURCE,FSTYPE,SIZE,USED,AVAIL 2>/dev/null || df -h /
lsblk -o NAME,SIZE,TYPE,MOUNTPOINTS 2>/dev/null | grep -E "nvme|mmcblk|NAME" || true

hr "温度・電源"
command -v vcgencmd >/dev/null 2>&1 && vcgencmd measure_temp
command -v vcgencmd >/dev/null 2>&1 && vcgencmd get_throttled  # 0x0 なら電力不足・過熱なし

if [ "${1:-}" = "--smart" ]; then
  hr "NVMe SSD の SMART(Power On Hours が 0 付近・Percentage Used 0% なら未使用に近い)"
  if [ -e /dev/nvme0n1 ]; then
    sudo smartctl -a /dev/nvme0n1 | grep -E "Model Number|Serial Number|Firmware Version|Critical Warning|Temperature:|Percentage Used|Data Units Written|Power Cycles|Power On Hours|Unsafe Shutdowns|Media and Data Integrity Errors" || true
  else
    echo "/dev/nvme0n1 が見つかりません(HAT+ の接続・FPC ケーブルの向きを確認)"
  fi
  hr "PCIe の世代(Speed 5GT/s=Gen2, 8GT/s=Gen3)"
  sudo lspci -vv 2>/dev/null | grep -E "Non-Volatile|LnkSta:" | head -2 || true
fi

hr "Docker とコンテナ"
docker --version 2>/dev/null || echo "docker が無い(pi-init.sh を実行)"
docker compose ps 2>/dev/null || echo "compose が起動していない(docker compose up -d --build)"

hr "予約サーバー(ローカル)"
curl -s -m 10 http://localhost:8080/warmup || echo "応答なし"
echo

hr "Tunnel(ready なら Cloudflare と繋がっている)"
if curl -sf -m 5 http://127.0.0.1:2000/ready >/dev/null; then
  echo "ready: $(curl -s -m 5 http://127.0.0.1:2000/quicktunnel)"
else
  echo "not ready(回線断か quick tunnel 失効。tunnel-watchdog が 3 分以内に再起動する)"
fi
systemctl is-active --quiet tunnel-watchdog.timer && echo "watchdog timer: active" || echo "watchdog timer: 未導入(pi-init.sh を再実行)"
journalctl -u tunnel-watchdog --since "-24h" --no-pager -o cat 2>/dev/null | grep -E "再起動|復帰" | tail -3 || true

hr "Worker の登録状況(registered が true なら外から届く)"
curl -s -m 15 "$WORKER_URL/booking/status" || echo "応答なし"
echo

hr "URL 登録の直近ログ"
docker compose logs --no-log-prefix --tail 3 registrar 2>/dev/null || true
