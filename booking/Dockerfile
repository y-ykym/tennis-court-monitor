# フェーズ2 予約支援サーバー(半自動 noVNC 方式)。Cloud Run で動かす1コンテナ。
#   Node Webアプリ(server/server.mjs) + Xvfb(仮想ディスプレイ) + headful Chromium(Playwright) + x11vnc + noVNC(自前の WebSocket 橋渡し)
# Playwright 公式イメージ(Chromium と依存ライブラリ入り)に Xvfb と x11vnc を足す。
# バージョンは package.json の playwright と揃える(ずれると「ブラウザが見つからない」になる)。
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb x11vnc x11-utils fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY server ./server
# noVNC クライアントをブラウザ用に束ねてから、開発用パッケージを落とす
RUN npm run build:novnc && npm prune --omit=dev
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# 仮想ディスプレイ(スマホで見やすいよう縦長)。server 側の Chromium ウィンドウサイズもこれに合わせる
ENV DISPLAY=:99 \
    SCREEN_W=600 \
    SCREEN_H=1000 \
    PORT=8080 \
    NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["./docker-entrypoint.sh"]
