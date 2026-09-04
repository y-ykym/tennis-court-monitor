#!/usr/bin/env node
// ============================================================
// 予約実行の結果(reserve-cli.mjs --out の JSON)を LINE グループに push 通知する(GitHub Actions 用)。
//   LINE_CHANNEL_ACCESS_TOKEN=... LINE_USER_ID=<グループID> LABEL=<予約者の呼び名> node scripts/notify-result.mjs result.json
// カードの組み立ては src/result-flex.js(自宅 PC のサーバーと共用)。push は LINE 無料枠(月200通)を1通消費する。
// ============================================================
import fs from 'node:fs';
import { buildResultFlex, pushResult } from '../src/result-flex.js';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('使い方: node scripts/notify-result.mjs result.json');
  process.exit(1);
}
const result = JSON.parse(fs.readFileSync(file, 'utf8'));
const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const to = process.env.LINE_USER_ID;
if (!token || !to) {
  console.error('環境変数 LINE_CHANNEL_ACCESS_TOKEN / LINE_USER_ID が未設定です');
  process.exit(1);
}
await pushResult(buildResultFlex(result, process.env.LABEL || ''), { token, to });
console.log(`LINE通知を送信しました (${result.status})`);
