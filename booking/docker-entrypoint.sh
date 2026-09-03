#!/bin/bash
# 仮想ディスプレイ → VNC サーバー → Web アプリ の順に起こす。
#   Xvfb   : 画面の無いコンテナに「画面」を作る(Chromium はここに描く)
#   x11vnc : その画面を VNC で配信(ローカルの 5900 番のみ。外にはノードの WebSocket 経由でしか出さない)
#   node   : /book(自動遷移)と noVNC の画面配信(WebSocket 橋渡し)
set -eu

: "${DISPLAY:=:99}"; : "${SCREEN_W:=600}"; : "${SCREEN_H:=1000}"; : "${PORT:=8080}"

Xvfb "$DISPLAY" -screen 0 "${SCREEN_W}x${SCREEN_H}x24" -nolisten tcp -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
# ディスプレイが上がるのを待つ
for i in $(seq 1 50); do xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break; sleep 0.1; done

# VNC のパスワード(環境変数 VNC_PASSWORD。noVNC 側にも同じ値を渡す)。無ければ乱数を作って node に渡す
if [ -z "${VNC_PASSWORD:-}" ]; then
  VNC_PASSWORD=$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 8)
  export VNC_PASSWORD
fi
x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vncpass >/dev/null 2>&1
x11vnc -display "$DISPLAY" -rfbauth /tmp/vncpass -rfbport 5900 -localhost -forever -shared -noxdamage -nopw -quiet -bg -o /tmp/x11vnc.log

exec node server/server.mjs
