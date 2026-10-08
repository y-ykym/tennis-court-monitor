#!/bin/bash
# ============================================================
# フェーズ11 Google カレンダー同期を Pi から手で 1 回頼む(Worker の /auto/calendar-sync。署名鍵はコンテナの .env にある)。
#   ./calendar-sync.sh            A・B とも同期して結果(人ごとの 追加/更新/削除 の件数)を表示
#   ./calendar-sync.sh A          A だけ
#   ./calendar-sync.sh --dry      何をするかだけ表示(カレンダーには触らない。初回の確認に)
#   ./calendar-sync.sh B --dry
# Mac から: ssh pi '~/tennis-court-monitor/booking/pc/calendar-sync.sh --dry'
# ============================================================
set -u
cd "$(dirname "$0")"
PERSON=""
DRY=false
for a in "$@"; do
  case "$a" in
    A|B) PERSON="$a" ;;
    --dry|--dry-run) DRY=true ;;
    *) echo "使い方: $0 [A|B] [--dry]"; exit 2 ;;
  esac
done
docker compose exec -T -e SYNC_PERSON="$PERSON" -e SYNC_DRY="$DRY" booking node -e '
const { triggerCalendarSync } = require("/app/lib/auto-client.js");
const person = process.env.SYNC_PERSON || undefined;
const dryRun = process.env.SYNC_DRY === "true";
const base = (process.env.WORKER_URL || process.env.BOOKING_PUBLIC_URL || "").replace(/\/$/, "");
triggerCalendarSync(base, process.env.BOOKING_SIGNING_SECRET, person, { dryRun, reason: "manual" })
  .then((r) => { console.log(JSON.stringify(r, null, 2)); })
  .catch((e) => { console.error("失敗:", e.message); process.exit(1); });
'
