#!/bin/bash
# ============================================================
# Cloudflare Tunnel(quick tunnel)の見張り。systemd timer から 1 分ごとに呼ばれる。
#
# 背景: 自宅回線(SoftBank Air)の瞬断が長引くと、cloudflared は
#   "Unauthorized: Tunnel not found" を返し続けて自力では復帰しない(2026-09-12 に実際に起きた)。
#   quick tunnel は Cloudflare 側で忘れられると再発行が必要で、それにはプロセスの再起動しかない。
#
# 判定:
#   1. tunnel のログに "Tunnel not found" が直近 2 分以内にあれば即 restart
#   2. metrics の /ready が 3 回連続(3 分)失敗したら restart
# restart すると URL が変わるが、registrar が 2 分以内に Worker へ登録し直すので LINE 側の設定変更は不要。
#
# 導入: pi-init.sh が systemd/ 配下のユニットを入れる。手動なら README §8 参照。
# ログ: journalctl -u tunnel-watchdog --since today
# ============================================================
set -u
cd "$(dirname "$0")"
STATE=/tmp/tunnel-watchdog.fails   # 連続失敗回数。yu で書ける場所(/run は root 専用)
READY_URL=${TUNNEL_READY_URL:-http://127.0.0.1:2000/ready}
MAX_FAILS=${TUNNEL_MAX_FAILS:-3}

restart_tunnel() {
  echo "tunnel を再起動します: $1"
  docker compose restart tunnel >/dev/null 2>&1 && echo "再起動しました" || echo "再起動に失敗"
  echo 0 > "$STATE"
}

# コンテナがそもそも動いていなければ compose の restart ポリシーに任せる
if ! docker compose ps --status running --services 2>/dev/null | grep -qx tunnel; then
  echo "tunnel コンテナが running ではない(compose に任せる)"; exit 0
fi

if docker compose logs --since 2m --no-log-prefix tunnel 2>/dev/null | grep -q "Tunnel not found"; then
  restart_tunnel "ログに 'Tunnel not found'"; exit 0
fi

if curl -sf -m 5 "$READY_URL" >/dev/null; then
  [ -s "$STATE" ] && [ "$(cat "$STATE")" != "0" ] && echo "復帰(ready)"
  echo 0 > "$STATE"; exit 0
fi

fails=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$STATE"
echo "ready ではない($fails/$MAX_FAILS)"
[ "$fails" -ge "$MAX_FAILS" ] && restart_tunnel "/ready が ${MAX_FAILS} 分連続で失敗"
exit 0
