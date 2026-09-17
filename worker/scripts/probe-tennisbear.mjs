#!/usr/bin/env node
// ============================================================
// テニスベアへのログインと「今後の予定」の取得を、Worker と同じコード(src/tennisbear.js)で
// ローカルから試すスクリプト(フェーズ5)。Secrets 登録前の確認や、パスワード変更後の疎通確認に使う。
// 読み取りのみ(申し込み・キャンセル等の書き込みはしない)。
//
// 使い方(パスワードは画面に表示されない):
//   read -s TB_PASS && export TB_PASS
//   TB_EMAIL=<メールアドレス> node scripts/probe-tennisbear.mjs
//   --flex を付けると、都の予約 0 件と合流したカードの JSON も出す(Flex Simulator に貼れる)
// ============================================================
import { fetchTennisbearEvents } from '../src/tennisbear.js';
import { formatReply } from '../src/format.js';
import { buildReservationFlex } from '../src/flex.js';

const email = process.env.TB_EMAIL;
const password = process.env.TB_PASS;
if (!email || !password) {
  console.error('環境変数 TB_EMAIL と TB_PASS を設定してください');
  process.exit(1);
}

const started = Date.now();
try {
  const events = await fetchTennisbearEvents({ email, password }, { log: (m) => console.log(`  ${m}`) });
  console.log(`\n取得件数: ${events.length} (${Date.now() - started}ms)`);
  console.log(JSON.stringify(events, null, 2));
  const people = [{ label: process.env.LABEL || 'A', reservations: [], tennisbear: { events } }];
  console.log('\n--- LINEに返信される形(テキスト版。都の予約は 0 件として) ---');
  console.log(formatReply(people));
  if (process.argv.includes('--flex')) {
    console.log('\n--- Flex Message JSON(https://developers.line.biz/flex-simulator/ に貼って確認できる) ---');
    console.log(JSON.stringify(buildReservationFlex(people).contents, null, 2));
  }
} catch (e) {
  console.error(`\n失敗 (${Date.now() - started}ms): ${e.name}: ${e.message}`);
  process.exit(1);
}
