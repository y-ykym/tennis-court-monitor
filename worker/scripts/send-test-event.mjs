#!/usr/bin/env node
// ============================================================
// LINEのWebhookを模したリクエストを、正しい署名付きで Worker に送るテスト用スクリプト。
//
// 使い方(別ターミナルで `npm run dev` を起動しておく):
//   node scripts/send-test-event.mjs                    「よやく」を対象グループから送る
//   node scripts/send-test-event.mjs --text こんにちは   別の文言(無視されるはず)
//   node scripts/send-test-event.mjs --other-group      別グループから(無視されるはず)
//   node scripts/send-test-event.mjs --bad-signature    署名を壊して送る(401になるはず)
//   node scripts/send-test-event.mjs --url https://xxx.workers.dev/webhook   デプロイ先に送る
//
// LINE_CHANNEL_SECRET / LINE_GROUP_ID は環境変数、無ければ worker/.dev.vars から読む。
// ============================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { computeSignature } from '../src/line.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

// .dev.vars(KEY=VALUE 形式)を読む。無ければ空
function loadDevVars() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.dev.vars');
  const vars = {};
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* .dev.vars が無い場合は環境変数のみ */
  }
  return vars;
}

const devVars = loadDevVars();
const channelSecret = process.env.LINE_CHANNEL_SECRET || devVars.LINE_CHANNEL_SECRET;
const groupId = process.env.LINE_GROUP_ID || devVars.LINE_GROUP_ID;
if (!channelSecret || !groupId) {
  console.error('LINE_CHANNEL_SECRET と LINE_GROUP_ID を環境変数か worker/.dev.vars に設定してください');
  process.exit(1);
}

const url = opt('--url', 'http://localhost:8787/webhook');
const text = opt('--text', 'よやく');
const body = JSON.stringify({
  destination: 'Udummydestination000000000000000000',
  events: [
    {
      type: 'message',
      mode: 'active',
      timestamp: Date.now(),
      webhookEventId: '01TESTEVENT0000000000000000',
      deliveryContext: { isRedelivery: false },
      source: { type: 'group', groupId: flag('--other-group') ? 'Cotherdummygroup0000000000000000' : groupId, userId: 'Udummyuser00000000000000000000000' },
      replyToken: 'dummyreplytoken0000000000000000',
      message: { id: '1', type: 'text', quoteToken: 'q', text },
    },
  ],
});

let signature = await computeSignature(channelSecret, body);
if (flag('--bad-signature')) signature = 'x' + signature.slice(1);

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-line-signature': signature },
  body,
});
console.log(`→ ${url}\n   本文: "${text}" ${flag('--other-group') ? '(別グループ)' : ''}${flag('--bad-signature') ? '(署名を破損)' : ''}`);
console.log(`← HTTP ${res.status} ${await res.text()}`);
