#!/usr/bin/env node
// ============================================================
// フェーズ10 新着イベント通知の「取り込み」を、Worker と同じコード(src/event-notify.js)でローカルから試すスクリプト。
// テニスベアの検索・詳細(認証不要)だけを叩き、LINE には送らない。KV も使わない(控えは無い前提 = 全件が新着扱い)。
//
// 使い方:
//   node scripts/probe-events.mjs              対象イベントの一覧と、カードの枚数・バイト数を出す
//   node scripts/probe-events.mjs --flex       Flex Message JSON も出す(https://developers.line.biz/flex-simulator/ に貼れる)
//   LINE_CHANNEL_ACCESS_TOKEN=... node scripts/probe-events.mjs --validate
//                                              LINE の検証 API(送らずに形式だけ確かめる)にカードを通す
// ============================================================
import { searchEvents, inScope, sortEvents, fetchPrices, buildEventMessages, eventText, EVENT_PLACES } from '../src/event-notify.js';
import { jstTodayIso } from '../src/format.js';
import { bubbleBytes } from '../src/flex.js';

const today = jstTodayIso();
const started = Date.now();
const log = (m) => console.log(`  ${m}`);
try {
  const all = await searchEvents({ log });
  const scoped = sortEvents(all.filter((ev) => inScope(ev, today)));
  console.log(`\n検索 ${all.length} 件 → 対象 ${scoped.length} 件(今日 ${today} から 31 日先までの土日祝・6 コート・募集中) (${Date.now() - started}ms)`);
  const prices = await fetchPrices(
    scoped.map((e) => e.id),
    { log }
  );
  console.log(`料金の取得まで ${Date.now() - started}ms\n`);
  console.log(eventText(scoped, prices, { mode: 'all' }));

  const messages = buildEventMessages(scoped, prices, { mode: 'all' });
  console.log('\n--- カード ---');
  for (const [i, m] of messages.entries()) {
    const bubbles = m.contents.type === 'carousel' ? m.contents.contents : [m.contents];
    const total = new TextEncoder().encode(JSON.stringify(m)).length;
    console.log(`メッセージ ${i + 1}: ${bubbles.length} 枚 / 合計 ${total} バイト(上限 50,000) / 枚ごと ${bubbles.map((b) => bubbleBytes(b)).join(', ')} バイト(上限 30,000)`);
  }
  const byPlace = Object.fromEntries(EVENT_PLACES.map((p) => [p.short, scoped.filter((e) => e.placeCode === p.code).length]));
  console.log(`コート別: ${JSON.stringify(byPlace)}`);

  if (process.argv.includes('--flex')) {
    console.log('\n--- Flex Message JSON ---');
    console.log(JSON.stringify(messages, null, 2));
  }
  if (process.argv.includes('--validate')) {
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!token) {
      console.error('--validate には環境変数 LINE_CHANNEL_ACCESS_TOKEN が必要です');
      process.exit(1);
    }
    const res = await fetch('https://api.line.me/v2/bot/message/validate/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages }),
    });
    console.log(`\nLINE の検証 API: HTTP ${res.status} ${res.status === 200 ? '(形式 OK。送信はしていません)' : await res.text()}`);
  }
} catch (e) {
  console.error(`\n失敗 (${Date.now() - started}ms): ${e.name}: ${e.message}`);
  process.exit(1);
}
