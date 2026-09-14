// ============================================================
// フェーズ3 自動予約の Pi 側の状態(docker volume /var/lib/booking/auto-state.json)。Actions の state.json とは別物。
//
//   known     : 前回の照会で見えていた監視対象の枠キー(差分 = 「新しく出た空き」の検出用)
//   attempted : 枠キー → { status, at }。同じ枠を二重に試さない(queued/running/success は再投入しない)
//   own       : 自分(この Pi)が自動予約した枠 [{ key, person, id, date, start, end, park, facility, at }]。
//               次に予約一覧を見たときに消えていたら「サイトで手放した」とみなして除外枠に登録する
//   updatedAt : 最後に保存した時刻。これが古い(staleMs 超)状態で起動したら「初回起動」と同じ扱い
//               (いま見えている空きを既知として登録し、まとめて予約しに行かない = 暴走防止)
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_STALE_MS = 10 * 60 * 1000;
const ATTEMPT_KEEP_MS = 2 * 24 * 60 * 60 * 1000;

export function createAutoState({ file, now = Date.now, staleMs = DEFAULT_STALE_MS } = {}) {
  let data = { known: [], attempted: {}, own: [], updatedAt: null };
  let loadedFresh = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      data = { known: [], attempted: {}, own: [], updatedAt: null, ...parsed };
      loadedFresh = typeof data.updatedAt === 'number' && now() - data.updatedAt <= staleMs;
    }
  } catch {
    /* 初回、または壊れている → まっさら */
  }
  // 古い状態(長時間止まっていた)は既知の枠を捨てて、次の照会で「いま見えている空き」を既知として取り直す
  if (!loadedFresh) data.known = [];
  let baselineDone = loadedFresh;

  function save() {
    data.updatedAt = now();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  return {
    // 初回起動(または長時間停止からの復帰)で、まだ既知の枠を取り直していないか
    needsBaseline: () => !baselineDone,
    knownKeys: () => new Set(data.known),
    setKnown(keys) {
      data.known = [...new Set(keys)];
      baselineDone = true;
    },
    attemptStatus: (key) => data.attempted[key]?.status ?? null,
    markAttempt(key, status) {
      data.attempted[key] = { status, at: now() };
    },
    addOwn(entry) {
      data.own = data.own.filter((o) => o.key !== entry.key);
      data.own.push({ ...entry, at: now() });
    },
    removeOwn(key) {
      data.own = data.own.filter((o) => o.key !== key);
    },
    own: () => [...data.own],
    // 古い試行記録・過ぎた自分の予約を落とす
    prune(todayIso) {
      const t = now();
      for (const [k, v] of Object.entries(data.attempted)) if (t - (v.at || 0) > ATTEMPT_KEEP_MS) delete data.attempted[k];
      if (todayIso) data.own = data.own.filter((o) => o.date >= todayIso);
    },
    save,
    // テスト・表示用
    snapshot: () => JSON.parse(JSON.stringify(data)),
  };
}
