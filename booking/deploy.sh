#!/bin/bash
# ============================================================
# 予約支援サーバー(半自動 noVNC)を Cloud Run に配置する。
#
#   前提: gcloud CLI がインストール済みで、`gcloud auth login` と `gcloud config set project <ID>` が済んでいること。
#         Secret Manager に以下のシークレットが作成済みであること(初回は本ファイル末尾の「初回だけ」を参照):
#           booking-signing-secret, site-user-a, site-pass-a, label-a(B を使うなら site-user-b, site-pass-b, label-b)
#
#   使い方:  cd booking && ./deploy.sh
#
#   設定の要点:
#     --max-instances 1      画面(Xvfb)が1つなので同時に1件だけ。/book も noVNC も同じインスタンスに届く
#     --session-affinity     WebSocket と /status の問い合わせを同じインスタンスに寄せる
#     --no-cpu-throttling    リクエストの合間もブラウザの自動遷移を止めない
#     --timeout 3600         noVNC の WebSocket を長く保つ
#     --min-instances 0      使わない間は 0 円(コールドスタートは通知時の /warmup で吸収)
# ============================================================
set -euo pipefail

PROJECT=$(gcloud config get-value project 2>/dev/null)
REGION=${REGION:-asia-northeast1}
SERVICE=${SERVICE:-tennis-booking}
REPO=${REPO:-tennis}
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}:$(date +%Y%m%d-%H%M%S)"

[ -n "$PROJECT" ] || { echo "gcloud のプロジェクトが未設定です: gcloud config set project <ID>"; exit 1; }

echo "== プロジェクト: $PROJECT / リージョン: $REGION / サービス: $SERVICE"

# Artifact Registry のリポジトリ(無ければ作る)
gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPO" --repository-format docker --location "$REGION" --description "tennis-court-monitor"

# コンテナイメージをクラウド側でビルド(手元の Docker は不要。amd64 で作られる)
echo "== イメージをビルド: $IMAGE"
gcloud builds submit --tag "$IMAGE" .

SECRETS="BOOKING_SIGNING_SECRET=booking-signing-secret:latest,SITE_USER_A=site-user-a:latest,SITE_PASS_A=site-pass-a:latest,LABEL_A=label-a:latest"
if gcloud secrets describe site-user-b >/dev/null 2>&1; then
  SECRETS="$SECRETS,SITE_USER_B=site-user-b:latest,SITE_PASS_B=site-pass-b:latest,LABEL_B=label-b:latest"
fi

echo "== Cloud Run にデプロイ"
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --max-instances 1 --min-instances 0 \
  --session-affinity \
  --no-cpu-throttling \
  --cpu 2 --memory 2Gi \
  --timeout 3600 \
  --concurrency 20 \
  --port 8080 \
  --update-env-vars "SCREEN_W=600,SCREEN_H=1000,PROFILE_BUCKET=${PROJECT}-profile" \
  --set-secrets "$SECRETS"

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')
echo "== 配置完了: $URL"
echo "   GitHub Secrets に BOOKING_BASE_URL=$URL を登録すると、通知カードに「予約」ボタンが付きます"

# ------------------------------------------------------------
# 初回だけ(手作業。値は対話入力で、画面に出さない):
#   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
#   printf '%s' "$(openssl rand -base64 32)" | gcloud secrets create booking-signing-secret --data-file=-   # 同じ値を GitHub Secrets の BOOKING_SIGNING_SECRET にも
#   read -s V && printf '%s' "$V" | gcloud secrets create site-user-a --data-file=- ; unset V
#   read -s V && printf '%s' "$V" | gcloud secrets create site-pass-a --data-file=- ; unset V
#   printf '%s' '呼び名' | gcloud secrets create label-a --data-file=-
#   Cloud Run のサービスアカウントに Secret Manager の閲覧権限:
#   gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$(gcloud projects describe "$PROJECT" --format 'value(projectNumber)')-compute@developer.gserviceaccount.com" --role roles/secretmanager.secretAccessor
# ------------------------------------------------------------
