#!/usr/bin/env node
// ============================================================
// 予約サイトへのログインと予約一覧の取得を、Worker と同じコード(src/site.js)で
// ローカルから試すスクリプト。Secrets 登録前の確認や、パスワード変更後の疎通確認に使う。
// 読み取りのみ(キャンセル等の書き込みはしない)。
//
// 使い方(パスワードは画面に表示されない):
//   read -s SITE_PASS && export SITE_PASS
//   SITE_USER=<利用者番号> node scripts/probe-site.mjs
// ============================================================
import { fetchReservations } from '../src/site.js';
import { formatReply } from '../src/format.js';
import { buildReservationFlex } from '../src/flex.js';

const userId = process.env.SITE_USER;
const password = process.env.SITE_PASS;
if (!userId || !password) {
  console.error('環境変数 SITE_USER と SITE_PASS を設定してください');
  process.exit(1);
}

const started = Date.now();
try {
  const reservations = await fetchReservations({ userId, password }, { log: (m) => console.log(`  ${m}`) });
  console.log(`\n取得件数: ${reservations.length} (${Date.now() - started}ms)`);
  console.log(JSON.stringify(reservations, null, 2));
  const people = [{ label: process.env.LABEL || 'A', reservations }];
  console.log('\n--- LINEに返信される形(テキスト版) ---');
  console.log(formatReply(people));
  if (process.argv.includes('--flex')) {
    console.log('\n--- Flex Message JSON(https://developers.line.biz/flex-simulator/ に貼って確認できる) ---');
    console.log(JSON.stringify(buildReservationFlex(people).contents, null, 2));
  }
} catch (e) {
  console.error(`\n失敗 (${Date.now() - started}ms): ${e.name}: ${e.message}`);
  process.exit(1);
}
