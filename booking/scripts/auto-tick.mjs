#!/usr/bin/env node
// ============================================================
// フェーズ3 自動予約の照会・振り分けを手元で 1 周期だけ動かして確かめる(予約はしない = dry-run 固定。Worker にも繋がない)。
//
//   node scripts/auto-tick.mjs --mock ../test/mock-slots.json            モックの空きで振り分けを表示(初回は「既知として登録」になる)
//   node scripts/auto-tick.mjs --mock ../test/mock-slots.json --all-new  すべて「新しく出た空き」として振り分けを表示
//   node scripts/auto-tick.mjs --all-new --exclusions ex.json            実サイトを 1 回照会(ログイン不要の JSON。短時間に繰り返さない)
//   --exclusions ex.json   除外一覧 { "dates": ["YYYY-MM-DD"], "slots": [{ "park": "1160", "date": "YYYY-MM-DD", "start": "13:00" }] }
//   --state file           状態ファイル(既定は一時ファイル)
//   --today YYYY-MM-DD     今日を指定(境界の確認用。既定は実際の今日 JST)
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutoRunner, createScraper } from '../src/auto-runner.js';
import { createAutoState } from '../src/auto-state.js';
import { createBookingQueue } from '../src/booking-queue.js';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const stateFile = opt('state', path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auto-tick-')), 'auto-state.json'));
const exclusions = opt('exclusions') ? JSON.parse(fs.readFileSync(opt('exclusions'), 'utf8')) : { dates: [], slots: [] };
const todayOpt = opt('today');
const now = todayOpt ? () => Date.parse(`${todayOpt}T03:00:00Z`) : Date.now;
if (flag('all-new')) {
  // 「既知の枠なし・状態は新しい」を作って、見えている空きが全部「新しく出た」扱いになるようにする
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ known: [], attempted: {}, own: [], updatedAt: now() }));
}
const log = (m) => console.log(`[auto] ${m}`);
const runner = createAutoRunner({
  mode: 'dry-run',
  scrape: createScraper({ mockFile: opt('mock', process.env.MOCK_SLOTS_FILE) }),
  queue: createBookingQueue({ log }),
  state: createAutoState({ file: stateFile, now }),
  worker: { heartbeat: async () => exclusions, addExcludedSlots: async () => {} },
  book: async () => ({ status: 'dry_run' }),
  credentialsFor: (p) => ({ userId: 'x', password: 'x', label: process.env[`LABEL_${p}`] || p }),
  log,
  now,
});
const r = await runner.tick();
console.log(`\n結果: ${JSON.stringify(r)}\n状態ファイル: ${stateFile}`);
