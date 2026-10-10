#!/bin/bash
# ============================================================
# フェーズ3 自動予約の記録(auto-events.jsonl)を集計する。照会間隔(lib/config.js の POLL_SCHEDULE)を調整するときの材料。
#   ./auto-stats.sh            直近 30 日
#   ./auto-stats.sh 14         直近 14 日
#   ./auto-stats.sh 30 --list  取れなかった枠の一覧も出す
# Mac から: ssh pi '~/tennis-court-monitor/booking/pc/auto-stats.sh 30 --list'
# 記録の中身は booking/src/auto-events.js の冒頭。Pi に jq は無いので python3 で読む
# ============================================================
set -u
cd "$(dirname "$0")"
DAYS="${1:-30}"
LIST=0; for a in "$@"; do [ "$a" = "--list" ] && LIST=1; done
EVENTS=$(docker compose exec -T booking cat /var/lib/booking/auto-events.jsonl 2>/dev/null)
if [ -z "$EVENTS" ]; then echo "記録がまだ無い(/var/lib/booking/auto-events.jsonl。コンテナが動いているか、記録を始めた 2026-10-11 より後か)"; exit 1; fi
export EVENTS DAYS LIST
python3 - <<'PY'
import json, os, sys, time
from datetime import datetime, timedelta, timezone
from collections import defaultdict

JST = timezone(timedelta(hours=9))
def jst(ms): return datetime.fromtimestamp(ms / 1000, JST)
days = int(os.environ['DAYS']); want_list = os.environ['LIST'] == '1'
since = time.time() * 1000 - days * 86400 * 1000
ev = []
for line in os.environ['EVENTS'].split('\n'):
    line = line.strip()
    if not line: continue
    try: ev.append(json.loads(line))
    except Exception: pass
ev = [e for e in ev if e.get('at', 0) >= since]
ev.sort(key=lambda e: e['at'])
if not ev:
    print(f'直近 {days} 日の記録が無い'); sys.exit(0)
print(f"期間: {jst(ev[0]['at']).strftime('%m/%d %H:%M')} 〜 {jst(ev[-1]['at']).strftime('%m/%d %H:%M')}(直近 {days} 日)  記録 {len(ev)} 行")

# 出現ごとに、その後の同じ枠の 消滅・結果・見送り を結びつける
by_key = defaultdict(list)
for e in ev: by_key[e.get('key')].append(e)
appear = []  # dict(at, key, facility, date, time, intervalMs, gone_at, life_min, outcome, reason)
for key, es in by_key.items():
    if not key: continue
    i = 0
    while i < len(es):
        e = es[i]
        if e['type'] != 'appeared': i += 1; continue
        a = dict(at=e['at'], key=key, facility=e.get('facility'), date=e.get('date'), time=e.get('time'), intervalMs=e.get('intervalMs'), gone_at=None, life_min=None, outcome='', reason='')
        j = i + 1
        while j < len(es) and es[j]['type'] != 'appeared':
            x = es[j]
            if x['type'] == 'gone' and a['gone_at'] is None:
                a['gone_at'] = x['at']; a['life_min'] = (x['at'] - e['at']) / 60000
            elif x['type'] == 'result':
                a['outcome'] = x.get('status', ''); a['reason'] = x.get('message') or ''
            elif x['type'] == 'skipped' and not a['outcome']:
                a['outcome'] = 'skipped_' + str(x.get('kind')); a['reason'] = x.get('reason') or ''
            elif x['type'] in ('queued', 'dry_run') and not a['outcome']:
                a['outcome'] = x['type']
            j += 1
        appear.append(a); i = j
appear.sort(key=lambda a: a['at'])

C = '\033[1;36m'; R = '\033[0m'
def hr(s): print(f'\n{C}-- {s}{R}')

hr('時台(JST)別: 出現 / 5 分未満で消えた / 成立 / 先を越された(taken) / 見送り(ルール) / 出現時の照会間隔')
by_h = defaultdict(list)
for a in appear: by_h[jst(a['at']).hour].append(a)
def cnt(xs, f): return sum(1 for x in xs if f(x))
for h in range(24):
    xs = by_h.get(h, [])
    if not xs: continue
    ivs = sorted(set(int(x['intervalMs'] / 60000) for x in xs if x.get('intervalMs')))
    print(f"  {h:2d}時  出現 {len(xs):3d}  5分未満 {cnt(xs, lambda x: x['life_min'] is not None and x['life_min'] < 5):3d}  成立 {cnt(xs, lambda x: x['outcome']=='success'):2d}  先越され {cnt(xs, lambda x: x['outcome']=='taken'):2d}  見送り {cnt(xs, lambda x: x['outcome'].startswith('skipped') or x['outcome'] in ('capped','conflict')):2d}  間隔 {'/'.join(f'{i}分' for i in ivs) or '-'}")

hr('出現時の照会間隔ごと: 出現 / 成立 / 先を越された / 5 分未満で消えた')
by_iv = defaultdict(list)
for a in appear: by_iv[int((a.get('intervalMs') or 0) / 60000)].append(a)
for iv in sorted(by_iv):
    xs = by_iv[iv]
    print(f"  {iv} 分: 出現 {len(xs):3d}  成立 {cnt(xs, lambda x: x['outcome']=='success'):2d}  先越され {cnt(xs, lambda x: x['outcome']=='taken'):2d}  5分未満で消えた {cnt(xs, lambda x: x['life_min'] is not None and x['life_min'] < 5):2d}")

hr('消えるまでの時間(分)の分布(消えた枠)')
gone = [a for a in appear if a['life_min'] is not None]
for lo, hi in [(0, 2), (2, 5), (5, 10), (10, 30), (30, 60), (60, 1e9)]:
    n = cnt(gone, lambda x: lo <= x['life_min'] < hi)
    print(f"  {lo:>3}〜{('' if hi > 1e8 else int(hi)):<3}分: {n}")

hr('結果の内訳')
oc = defaultdict(int)
for a in appear: oc[a['outcome'] or '(記録なし)'] += 1
for k, v in sorted(oc.items(), key=lambda kv: -kv[1]): print(f'  {k:28} {v}')

fails = [e for e in ev if e['type'] == 'poll_failed']
hr(f'空き照会の失敗: {len(fails)} 回(時台別)')
fh = defaultdict(int)
for e in fails: fh[jst(e['at']).hour] += 1
print('  ' + '  '.join(f'{h}時:{fh[h]}' for h in sorted(fh)) if fh else '  なし')

if want_list:
    hr('取れなかった枠(成立以外)の一覧: 出現 → 消滅(経過) 枠 / 結果')
    for a in appear:
        if a['outcome'] == 'success': continue
        g = f"→ {jst(a['gone_at']).strftime('%H:%M')} ({a['life_min']:.0f}分)" if a['gone_at'] else '→ (まだ見えている)'
        iv = f"[{int(a['intervalMs']/60000)}分]" if a.get('intervalMs') else ''
        print(f"  {jst(a['at']).strftime('%m/%d(%a) %H:%M')} {g}  {a['date']} {a['time']} {a['facility']} {iv}  {a['outcome'] or '-'} {a['reason']}")
PY
