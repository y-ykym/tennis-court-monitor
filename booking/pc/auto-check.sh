#!/bin/bash
# ============================================================
# フェーズ3 自動予約が「いま動いているか」を Pi 上でまとめて確認する。
#   ./auto-check.sh            判定・直近の照会・自動予約した枠・直近 2 日の試行・24 時間の振り分けログ
#   ./auto-check.sh --raw      上記に加えて /auto/status と auto-state.json をそのまま出す
# Mac から: ssh yu@homepi.local '~/tennis-court-monitor/booking/pc/auto-check.sh'
# 判定の目安: mode=on・LINE のスイッチ ON・最後の照会が 5 分以内 なら「動いている」
# (Pi に jq は無いので JSON は python3 で読む)
# ============================================================
set -u
cd "$(dirname "$0")"
WORKER_URL=$(grep -E '^WORKER_URL=' .env 2>/dev/null | cut -d= -f2- || true)
WORKER_URL=${WORKER_URL:-https://tennis-reservation-bot.y-ykym.workers.dev}
hr() { printf '\n\033[1;36m-- %s\033[0m\n' "$*"; }

echo "確認時刻: $(date '+%Y-%m-%d %H:%M:%S %Z')"

hr "コンテナ"
docker compose ps --format 'table {{.Service}}\t{{.Status}}' 2>/dev/null || echo "compose が起動していない(docker compose up -d)"
echo "Pi の .env: AUTO_BOOKING=$(grep -E '^AUTO_BOOKING=' .env 2>/dev/null | cut -d= -f2- || echo '(未設定)')"
echo "Pi のコード: $(git -C .. log --oneline -1 2>/dev/null)"

hr "判定"
STATUS_JSON=$(curl -s -m 10 http://localhost:8080/auto/status)
if [ -z "$STATUS_JSON" ]; then
  echo "✖ 予約サーバーが応答しない(/auto/status)。docker compose logs booking を確認"
  exit 1
fi
STATE_JSON=$(docker compose exec -T booking cat /var/lib/booking/auto-state.json 2>/dev/null)
export STATUS_JSON STATE_JSON
python3 - <<'PY'
import json, os, time
from datetime import datetime

def jst(ms): return datetime.fromtimestamp(ms / 1000).strftime('%m/%d %H:%M') if ms else '不明'
now = time.time() * 1000
s = json.loads(os.environ['STATUS_JSON'])
mode, enabled, notify = s.get('mode'), s.get('enabled'), s.get('notifyEnabled')
started = s.get('startedAt') or 0
lc = s.get('lastCycle') or {}
last_at, last_ms, last_err = lc.get('at') or 0, lc.get('ms') or 0, lc.get('error')
ex = s.get('exclusions') or {}
q = s.get('queue') or {}
age_min = int((now - last_at) / 60000) if last_at else None
up_min = int((now - started) / 60000)

verdict = '✔ 動いている'
if mode != 'on': verdict = f'✖ 止まっている(mode={mode}。.env の AUTO_BOOKING を確認)'
elif not enabled: verdict = '⏸ LINE の「せってい」で OFF になっている(Pi は動いているが予約しない)'
elif not last_at: verdict = '… 起動直後(まだ初回の照会が終わっていない)' if up_min < 3 else f'✖ 起動から {up_min} 分たつのに照会が 1 度も終わっていない'
elif age_min >= 5: verdict = f'✖ 最後の照会が {age_min} 分前(5 分以上止まっている。ログを確認)'
print(verdict)
print(f"  mode={mode}  LINEスイッチ={'ON' if enabled else 'OFF'}  空き通知カード={'ON' if notify else 'OFF'}  起動 {jst(started)}({up_min} 分前)")
print(f"  最後の照会: {jst(last_at)}({age_min} 分前、所要 {int(last_ms/1000)} 秒)" + (f'  エラー: {last_err}' if last_err else ''))
print(f"  いま空いている監視対象: {len(s.get('targets') or [])} 件  除外一覧: 除外日 {ex.get('dates',0)}・除外枠 {ex.get('slots',0)}(更新 {jst(ex.get('at') or 0)})  予約の行列: 実行中={q.get('running') or 'なし'} 待ち={len(q.get('waiting') or [])}")
if last_err: print('  ※ 直近の照会でエラー。回線か予約サイト側の一時的な不調が多い。下の fetch failed 件数を見る')

C = '\033[1;36m'; R = '\033[0m'
print(f"\n{C}-- 自動予約した枠(own。取消は LINE の空き通知の取消ボタンか予約サイトで){R}")
st = os.environ.get('STATE_JSON') or ''
if not st:
    print('auto-state.json が読めない')
else:
    d = json.loads(st)
    own = sorted(d.get('own') or [], key=lambda o: (o.get('date',''), o.get('start','')))
    if not own: print('なし')
    for o in own:
        print(f"  {o.get('date')} {o.get('start')}-{o.get('end')}  {o.get('facility')}  {o.get('person')}  予約番号 {o.get('id')}  (成立 {jst(o.get('at') or 0)})")
    print(f"\n{C}-- 直近 2 日の試行(attempted。success=成立 taken=先を越された conflict=重なりで見送り dry_run=試運転){R}")
    att = sorted((d.get('attempted') or {}).items(), key=lambda kv: kv[1].get('at') or 0)
    if not att: print('なし')
    for k, v in att:
        park, date, start = (k.split('|') + ['', '', ''])[:3]
        print(f"  {jst(v.get('at') or 0)}  {v.get('status',''):9}  {date} {start}  公園{park}")
PY

hr "この 24 時間のログ(照会の定期行を除いた振り分け。※コンテナ再作成でログは消える)"
docker compose logs --since 24h --no-log-prefix booking 2>/dev/null | grep '\[auto\]' | grep -v '照会: 監視対象\|除外一覧を更新' | tail -30
echo "  fetch failed: $(docker compose logs --since 24h booking 2>/dev/null | grep -c 'fetch failed') 件 / 24h(回線不調の目安)"
echo "  直近の照会 3 行:"
docker compose logs --since 24h --no-log-prefix booking 2>/dev/null | grep '\[auto\] 照会:' | tail -3 | sed 's/^/    /'

hr "Worker から見た登録(registered が true なら外から Pi に届く)"
curl -s -m 15 "$WORKER_URL/booking/status" || echo "応答なし"
echo

if [ "${1:-}" = "--raw" ]; then
  hr "/auto/status(生)"; echo "$STATUS_JSON" | python3 -m json.tool
  hr "auto-state.json(生)"; echo "$STATE_JSON" | python3 -m json.tool
fi
