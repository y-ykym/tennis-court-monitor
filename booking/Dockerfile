# フェーズ2 予約支援サーバー + フェーズ3 自動予約。自宅の Raspberry Pi 上の Docker で動かす1コンテナ(booking/pc/docker-compose.yml)。
#   Node Webアプリ(server/server.mjs) + Xvfb(仮想ディスプレイ) + headful Chromium(Playwright) + x11vnc + noVNC(自前の WebSocket 橋渡し)
# Playwright 公式イメージ(Chromium と依存ライブラリ入り)に Xvfb と x11vnc を足す。
# バージョンは package.json の playwright と揃える(ずれると「ブラウザが見つからない」になる)。
#
# ビルドコンテキストはリポジトリ直下(docker compose の build.context: ../..)。フェーズ3 で lib/(空き照会・監視条件・
# 自動予約のルール)を Pi でも使うため、リポジトリと同じ配置(/app/lib と /app/booking)でイメージに入れる。
# 除外するファイルはリポジトリ直下の .dockerignore
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb x11vnc x11-utils fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

# root の依存(japanese-holidays。lib/filter.js が使う)を /app/node_modules に
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY lib ./lib

WORKDIR /app/booking
COPY booking/package.json booking/package-lock.json ./
RUN npm ci
COPY booking/src ./src
COPY booking/server ./server
# noVNC クライアントをブラウザ用に束ねてから、開発用パッケージを落とす
RUN npm run build:novnc && npm prune --omit=dev
# Google Chrome 安定版(素の Chromium より reCAPTCHA に疑われにくい)。Linux 版は amd64 のみなので、それ以外(手元の arm64)では入れない
RUN if [ "$(dpkg --print-architecture)" = "amd64" ]; then npx playwright install chrome; fi
COPY booking/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# 仮想ディスプレイ(スマホで見やすいよう縦長)。server 側の Chromium ウィンドウサイズもこれに合わせる
ENV BROWSER_CHANNEL=chrome \
    DISPLAY=:99 \
    SCREEN_W=600 \
    SCREEN_H=1000 \
    PORT=8080 \
    NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["./docker-entrypoint.sh"]
