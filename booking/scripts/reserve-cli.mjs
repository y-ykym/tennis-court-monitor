#!/usr/bin/env node
// ============================================================
// 予約実行(src/reserve.js)をコマンドラインから動かす。ローカル確認と GitHub Actions の両方で使う。
//
//   使い方(パスワードは画面に表示されない形で環境変数に入れる):
//     read -s SITE_PASS && export SITE_PASS
//     SITE_USER=<利用者番号> node scripts/reserve-cli.mjs --park 1050 --date 2026-09-17 --start 15 [--people 2]
//                                                        [--dry-run] [--headed] [--out result.json] [--debug-dir .debug]
//
//     --dry-run    予約内容確認画面まで進んで「予約」を押さない(動作確認用)
//     --fast       高速経路(ブラウザ内 fetch でログイン〜枠選択。UI 操作を省く)。error のときは通常どおり再試行(通常方式)
//     --headed     ブラウザを画面に出す(ローカルで様子を見るとき)
//     --out        結果 JSON の保存先(GitHub Actions が LINE 通知に使う)
//     --debug-dir  失敗時のスクリーンショット/HTML 保存先(個人情報を含むので共有しない)
//
//   終了コード: 0 = success / dry_run、2 = taken / duplicate / rejected / auth_error(やり直し無意味)、1 = error
// ============================================================
import fs from 'node:fs';
import { reserve } from '../src/reserve.js';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const slot = { park: opt('park'), date: opt('date'), startHour: Number(opt('start')), people: Number(opt('people', '2')) };
if (!slot.park || !slot.date || !slot.startHour) {
  console.error('使い方: SITE_USER=... SITE_PASS=... node scripts/reserve-cli.mjs --park 1050 --date YYYY-MM-DD --start 15 [--people 2] [--dry-run] [--headed]');
  process.exit(1);
}
const credentials = { userId: process.env.SITE_USER, password: process.env.SITE_PASS };
if (!credentials.userId || !credentials.password) {
  console.error('環境変数 SITE_USER と SITE_PASS を設定してください');
  process.exit(1);
}

const log = (m) => console.log(`[${new Date().toLocaleTimeString('ja-JP')}] ${m}`);
const options = { headless: !flag('headed'), dryRun: flag('dry-run'), log, debugDir: opt('debug-dir', null) };

// 一時的なエラー(サイトがセッションを認識しない・502 等)は新しいブラウザで最大2回やり直す。
// taken / duplicate / rejected / auth_error はやり直さない(意味が無い、または回避行為になる)
const MAX_ATTEMPTS = Number(opt('attempts', '2'));
let result;
for (let n = 1; n <= MAX_ATTEMPTS; n++) {
  result = await reserve(slot, credentials, { ...options, fastInPage: flag('fast') });
  if (result.status !== 'error' || n === MAX_ATTEMPTS) break;
  log(`一時的なエラーのためやり直します (${n}/${MAX_ATTEMPTS}): ${result.message}`);
}

console.log('\n結果: ' + JSON.stringify(result, null, 2));
const out = opt('out');
if (out) fs.writeFileSync(out, JSON.stringify({ slot, ...result }, null, 2) + '\n');

process.exit(result.status === 'success' || result.status === 'dry_run' ? 0 : result.status === 'error' ? 1 : 2);
