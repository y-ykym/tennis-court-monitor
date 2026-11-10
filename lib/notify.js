// ============================================================
// LINE Messaging API での push 通知 (Flex Message)
// 必要な環境変数(GitHub Secrets経由で渡される):
//   LINE_CHANNEL_ACCESS_TOKEN … チャネルアクセストークン(長期)
//   LINE_USER_ID              … 通知先のユーザーID(U〜)またはグループID(C〜)
//
// 通知はカード型のFlex Messageで送る(2026-11-10 に全カード共通の決まりで作り直した。docs/flex-design-final.html):
//   - 帯: 「🎾 新しい空き N件」(緑 = 良い知らせ。19px・白)
//   - 日ごとに 1 かたまり: 左に日付タイル(「よやく」と同じ形。土=青/日祝=赤/平日=グレー)、右にその日の枠を縦に並べる。
//     日付についての情報(「今日/明日/明後日」と、利用日が今日+3 日以内 = 取り消すとペナルティが付く日の「⚠ 取消にペナルティ」)は
//     タイルの右隣に 1 回だけ出す(枠ごとに繰り返さない)
//   - 各枠: 時間(太字)/ 施設名 + 面数バッジ(残1面はオレンジで強調)→ その下に予約ボタン
//   - フッター: 予約サイト(トップページ)へのリンクボタン
//     ※該当枠への直リンクは不可(予約画面はセッション前提のPOST遷移のため)
//   - 各枠の予約ボタン(フェーズ2): 環境変数 BOOKING_BASE_URL と BOOKING_SIGNING_SECRET が両方あるときだけ付く。
//     予約支援サーバー(booking/server)の /book に、枠情報+予約者+有効期限を HMAC 署名したトークン付きで飛ぶ。
//     LABEL_A / LABEL_B(予約者の呼び名)がある人の分だけ「<呼び名>で予約」ボタンを出す。postback ボタンなので
//     押してもブラウザは開かず、Worker が自宅サーバーに予約開始を指示して「受け付けました」と返信する(結果はカードで届く)。
//     呼び名が 1 つも無ければボタンは出ない(予約者を選ぶ画面は廃止)。
//     A/B のボタンは色を分ける(A=緑、B=青)。ボタンを付けると1件あたりのサイズが増えるので、バブル 30KB を超えないよう
//     1通の件数を自動で減らし、余りは続きの通に分ける
//   - フッターのリンク(予約サイトを開く・予約一覧を見る)は 2026-11-10 に外した(本人決定。「よやく」はクイックリプライから送れる)
// altText(プッシュ通知バナーに出る文字列)は開かなくても内容が分かる要約にする。
// formatMessage() はdry-run表示用のプレーンテキスト版。
// ============================================================
const Holidays = require('japanese-holidays');
const { PARKS } = require('./config');
const { jstTodayYmd, ymdToIso } = require('./date');
const { isPenaltyPeriod } = require('./auto-rules');
const { withQuickReply } = require('./quick-reply'); // 合言葉のボタン列(クイックリプライ)

// フェーズ2 予約ボタン用の署名モジュール(booking/src/token.js は ESM。Node 22.12+ は require() で読める)
let tokenLib = null;
try {
  tokenLib = require('../booking/src/token.js');
} catch (e) {
  tokenLib = null; // 読めない環境ではボタン無しで送る(通知自体は止めない)
}

// 予約ボタンの設定。URL・鍵・呼び名(1 人以上)が揃っていなければ無効(ボタン無し)。
// people: ボタンを出す予約者。LABEL_A / LABEL_B が設定されている人だけ(呼び名がボタンの文字になる)
function bookingConfig() {
  const base = (process.env.BOOKING_BASE_URL || '').replace(/\/$/, '');
  const secret = process.env.BOOKING_SIGNING_SECRET || '';
  if (!base || !secret || !tokenLib) return null;
  const people = ['A', 'B']
    .map((person) => ({ person, label: String(process.env[`LABEL_${person}`] || '').trim() }))
    .filter((p) => p.label);
  return people.length ? { base, secret, people } : null;
}

// 枠 → 予約ボタンの列(予約支援サーバーへの署名付きURL)。公園コードが分からない枠には付けない(空配列)
function bookingButtons(slot, cfg) {
  const park = PARKS.find((p) => String(slot.facility).includes(p.keyword));
  const startHour = Number(String(slot.time).match(/^0?(\d{1,2}):/)?.[1]);
  if (!park || !startHour) return [];
  const base = { park: park.code, date: slot.date, startHour, people: 2, exp: tokenLib.slotExpiry(slot.date, startHour) };
  const button = (label, action, color) => ({
    type: 'button',
    style: 'primary',
    height: 'sm',
    color,
    adjustMode: 'shrink-to-fit', // 呼び名が長くても1行に収める(ベストエフォート)
    action,
  });
  // postback: ブラウザを開かず、Worker が自宅サーバーに予約開始を指示して「受け付けました」と返信する。
  // displayText は押した人のメッセージとしてトークに出る(誰がどの枠を押したか全員に分かる)。data は 300 文字まで(実際は 171 文字で固定長)。
  // URL 型ボタン(Worker の GET /book)は 2026-09-25 に廃止。開いただけで予約が始まる作りで、LINE のリンク先読みロボットが
  // 古い署名 URL を開いて予約が成立したため。長さが万一 300 を超えたらボタン無しで送り、ログに残す
  return cfg.people.flatMap((p) => {
    const label = `${p.label}で予約`.slice(0, 40); // Flex のボタン label 上限
    const token = tokenLib.sign({ ...base, person: p.person }, cfg.secret);
    const data = `book|${token}`;
    if (data.length > 300) {
      console.warn(`予約ボタンの data が ${data.length} 文字で LINE の上限 300 を超えるためボタンを付けません: ${slot.date} ${slot.time} ${slot.facility}`);
      return [];
    }
    const displayText = `${p.label}で予約: ${dateLabel(slot.date)} ${shortTime(slot.time)} ${shortFacility(slot.facility)}`.slice(0, 300);
    return [button(label, { type: 'postback', label, data, displayText }, PERSON_COLORS[p.person])];
  });
}

// 予約者ごとのボタン色(押し間違い防止。A=LINE 緑、B=青)
const PERSON_COLORS = { A: '#15803D', B: '#2563EB' }; // A の緑は白文字が読める濃さに(以前の #06C755 はコントラスト 2.26)
// 1通(1バブル)に載せる枠数の上限(読みやすさの都合。12件を超える分は続きの通へ)
// ※LINEのFlex Messageはバブルあたり30KBの制限(以前は10KB)。予約ボタン付きは1件あたり約1.5KB(A/B 2つ)なので
//   12件で約20KBに収まる。buildFlexMessages() が実サイズも測り、超えるときは1通の件数を減らして続きの通
//   (最大 MAX_MESSAGES 通。push API の上限は5通)に分ける。それでも余る分だけ「…ほかN件」
const MAX_SLOTS = 12;
const MAX_MESSAGES = 5;
// バブルの JSON サイズ上限(LINE の 30KB 制限に余裕を持たせる)
const MAX_BUBBLE_BYTES = 28000;

const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];

// 日付チップ・バッジの配色
const DAY_COLORS = {
  sat: { bg: '#E3EEFB', fg: '#1D4F91' }, // 土曜: 青(「よやく」の日付タイルと同じ色)
  sun: { bg: '#FBE4E4', fg: '#9B2C2C' }, // 日曜・祝日: 赤
  weekday: { bg: '#EEF0F3', fg: '#374151' },
};
const BADGE_LAST_ONE = { bg: '#FAECE7', fg: '#993C1D' }; // 残1面: オレンジで強調
const BADGE_NORMAL = { bg: '#E1F5EE', fg: '#085041' };
// 取り消すとペナルティが付く期間(利用日 <= 今日+3 日)の注意書き
const PENALTY_LABEL = '⚠ 取消にペナルティ';
const PENALTY_COLOR = '#8A4B00';
const COLOR_HEADER = '#15803D'; // 帯の緑
const COLOR_TEXT = '#111827';
const COLOR_SUB = '#4B5563';
const COLOR_MUTED = '#6B7280';
const COLOR_LINE = '#E5E7EB';
const COLOR_SOON = '#DC2626'; // 今日/明日/明後日

function toDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dateLabel(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}(${DOW_JA[toDate(dateStr).getDay()]})`;
}

function dayColors(dateStr) {
  const date = toDate(dateStr);
  if (Holidays.isHoliday(date) || date.getDay() === 0) return DAY_COLORS.sun;
  if (date.getDay() === 6) return DAY_COLORS.sat;
  return DAY_COLORS.weekday;
}

// 直近の日付だけ「今日/明日/明後日」の補足ラベルを返す(それ以外はnull)
function relativeLabel(dateStr) {
  const today = toDate(ymdToIso(jstTodayYmd()));
  const diff = Math.round((toDate(dateStr) - today) / 86400000);
  return ['今日', '明日', '明後日'][diff] || null;
}

// 施設名を短縮表記に(config.jsのkeywordを流用。altText等の文字数対策)
function shortFacility(facility) {
  const park = PARKS.find((p) => String(facility).includes(p.keyword));
  return park ? park.keyword : facility;
}

// "09:00-11:00" → "9-11時"(分が00でない枠が現れたらそのまま返す)
function shortTime(time) {
  const m = String(time).match(/^0?(\d{1,2}):00-0?(\d{1,2}):00$/);
  return m ? `${m[1]}-${m[2]}時` : String(time);
}

function sortSlots(slots) {
  return [...slots].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.time.localeCompare(b.time) ||
      a.facility.localeCompare(b.facility)
  );
}

// dry-run表示用のプレーンテキスト(実際に送られるFlexと同じ並び順・内容)
function formatMessage(slots) {
  const sorted = sortSlots(slots);
  const shown = sorted.slice(0, MAX_SLOTS);
  const lines = ['🎾 新しい空きが出ました!'];
  let prevDate = null;
  for (const s of shown) {
    if (s.date !== prevDate) {
      const rel = relativeLabel(s.date);
      const penalty = isPenaltyPeriod(s.date, ymdToIso(jstTodayYmd()));
      lines.push('', `📅 ${dateLabel(s.date)}${rel ? ` (${rel})` : ''}${penalty ? ` ${PENALTY_LABEL}` : ''}`);
      prevDate = s.date;
    }
    lines.push(`・${s.time} ${s.facility} (${s.count === 1 ? '残1面' : `${s.count}面`})`);
  }
  if (sorted.length > MAX_SLOTS) lines.push('', `…ほか${sorted.length - MAX_SLOTS}件`);
  return lines.join('\n');
}

// プッシュ通知バナーに出る要約(Flexの必須項目。上限400字)
function buildAltText(sorted) {
  const head = sorted
    .slice(0, 2)
    .map((s) => `${dateLabel(s.date)}${shortFacility(s.facility)} ${shortTime(s.time)}`)
    .join('、');
  const rest = sorted.length > 2 ? ' ほか' : '';
  return `🎾 空き${sorted.length}件: ${head}${rest}`.slice(0, 400);
}

// 面数バッジ(角丸)
function badge(text, { bg, fg }) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    backgroundColor: bg,
    cornerRadius: 'xl',
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingStart: '9px',
    paddingEnd: '9px',
    contents: [{ type: 'text', text, size: 'xs', weight: 'bold', color: fg, align: 'center' }],
  };
}

// 左の日付タイル: 「11/14」を大きく、その下に曜日(worker/src/flex.js の dateTile と同じ形)
const TILE_WIDTH = '58px';
function dateTile(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  const { bg, fg } = dayColors(dateStr);
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    width: TILE_WIDTH,
    backgroundColor: bg,
    cornerRadius: 'md',
    paddingAll: '6px',
    contents: [
      { type: 'text', text: `${m}/${d}`, size: 'lg', weight: 'bold', color: fg, align: 'center', adjustMode: 'shrink-to-fit' },
      { type: 'text', text: DOW_JA[toDate(dateStr).getDay()], size: 'xs', color: fg, align: 'center' },
    ],
  };
}

// "09:00-11:00" → "9:00 - 11:00"(「よやく」と同じ書き方。形が違えばそのまま返す)
function tileTime(time) {
  const m = String(time).match(/^0?(\d{1,2}:\d{2})-0?(\d{1,2}:\d{2})$/);
  return m ? `${m[1]} - ${m[2]}` : String(time);
}

// 新しい空きを 1〜MAX_MESSAGES 通の Flex Message に分けて返す(1通目が要約の altText を持つ)
function buildFlexMessages(slots) {
  const sorted = sortSlots(slots);
  const chunks = [];
  let i = 0;
  while (i < sorted.length && chunks.length < MAX_MESSAGES) {
    // この通に載る件数を、10KB に収まるまで減らす(最低1件)。見出しの通番は最終形と数バイトしか変わらないので仮の値で測る
    let n = Math.min(MAX_SLOTS, sorted.length - i);
    const probe = (k) => buildBubble(sorted.slice(i, i + k), { total: sorted.length, part: 9, parts: 9, rest: 99 });
    while (n > 1 && Buffer.byteLength(JSON.stringify(probe(n).contents), 'utf8') > MAX_BUBBLE_BYTES) n -= 1;
    chunks.push(sorted.slice(i, i + n));
    i += n;
  }
  const rest = sorted.length - i;
  return chunks.map((chunk, k) =>
    buildBubble(chunk, { total: sorted.length, part: k + 1, parts: chunks.length, rest: k === chunks.length - 1 ? rest : 0, altText: k === 0 ? buildAltText(sorted) : `🎾 空き(続き ${k + 1}/${chunks.length})` })
  );
}

// 互換用: 1通目だけ返す(テスト・dry-run 表示で使う)
function buildFlexMessage(slots) {
  return buildFlexMessages(slots)[0];
}

// 1バブル分。shown はこの通に載せる枠、total は全体の件数、part/parts は通番、rest は最後の通にだけ付く「…ほかN件」
function buildBubble(shown, { total, part, parts, rest, altText }) {
  const cfg = bookingConfig();
  const today = ymdToIso(jstTodayYmd());

  // 日ごとにまとめる(shown は日付 → 時間の順に並んでいる)
  const days = [];
  for (const s of shown) {
    const last = days[days.length - 1];
    if (last && last[0].date === s.date) last.push(s);
    else days.push([s]);
  }

  const body = [];
  days.forEach((slots, di) => {
    const date = slots[0].date;
    if (di > 0) body.push({ type: 'separator', margin: 'lg', color: COLOR_LINE });
    const right = [];
    // 日付についての情報は、タイルの右隣に 1 回だけ(枠ごとに繰り返さない)。
    // 「⚠ 取消にペナルティ」= この日の枠は取り消すとペナルティ(1 点)が付く = 自動予約の対象外で、押すなら本気で
    const rel = relativeLabel(date);
    const penalty = isPenaltyPeriod(date, today);
    if (rel || penalty) {
      right.push({
        type: 'text',
        contents: [
          ...(rel ? [{ type: 'span', text: rel, size: 'xs', weight: 'bold', color: COLOR_SOON }] : []),
          ...(penalty ? [{ type: 'span', text: `${rel ? '  ' : ''}${PENALTY_LABEL}`, size: 'xs', weight: 'bold', color: PENALTY_COLOR }] : []),
        ],
      });
    }
    slots.forEach((s, i) => {
      const buttons = cfg ? bookingButtons(s, cfg) : [];
      right.push({
        type: 'box',
        layout: 'vertical',
        ...(right.length ? { margin: i === 0 ? 'sm' : 'lg' } : {}),
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            alignItems: 'center',
            contents: [
              {
                type: 'text',
                flex: 1,
                wrap: true,
                lineSpacing: '3px',
                contents: [
                  { type: 'span', text: tileTime(s.time), size: 'md', weight: 'bold', color: COLOR_TEXT },
                  { type: 'span', text: `\n${s.facility}`, size: 'sm', color: COLOR_SUB },
                ],
              },
              badge(s.count === 1 ? '残1面' : `${s.count}面`, s.count === 1 ? BADGE_LAST_ONE : BADGE_NORMAL),
            ],
          },
          // 予約者ごとのボタンは枠の下に1行で並べる(横幅が足りないため)
          ...(buttons.length ? [{ type: 'box', layout: 'horizontal', margin: 'sm', spacing: 'sm', contents: buttons }] : []),
        ],
      });
    });
    body.push({
      type: 'box',
      layout: 'horizontal',
      alignItems: 'flex-start',
      margin: 'lg',
      contents: [dateTile(date), { type: 'box', layout: 'vertical', flex: 1, margin: 'md', contents: right }],
    });
  });
  if (rest > 0) {
    body.push({ type: 'text', text: `…ほか${rest}件`, size: 'xs', color: COLOR_MUTED, align: 'center', margin: 'lg' });
  }

  return {
    type: 'flex',
    altText: altText || buildAltText(shown),
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'horizontal',
        backgroundColor: COLOR_HEADER,
        paddingAll: '14px',
        paddingStart: '16px',
        paddingEnd: '16px',
        contents: [
          {
            type: 'text',
            text: parts > 1 ? `🎾 新しい空き ${total}件 (${part}/${parts})` : `🎾 新しい空き ${total}件`,
            color: '#FFFFFF',
            weight: 'bold',
            size: 'lg',
            adjustMode: 'shrink-to-fit',
          },
        ],
      },
      // 文字色を濃色で決め打ちしているため、背景もアプリのテーマ(ダークモード)に依存しないよう白を明示する
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', paddingTop: '4px', backgroundColor: '#FFFFFF', contents: body },
    },
  };
}

async function sendLineMessage(slots) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const to = process.env.LINE_USER_ID;
  if (!token || !to) {
    throw new Error('環境変数 LINE_CHANNEL_ACCESS_TOKEN / LINE_USER_ID が未設定です');
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to, messages: withQuickReply(buildFlexMessages(slots)) }), // 最後のカードに合言葉のボタン列を付ける
  });
  if (!res.ok) {
    throw new Error(`LINE通知に失敗: HTTP ${res.status} ${await res.text()}`);
  }
}

// 予約支援サーバーのウォームアップ(BOOKING_BASE_URL が無ければ何もしない)。結果は通知に影響させない
async function warmupBookingServer() {
  const base = (process.env.BOOKING_BASE_URL || '').replace(/\/$/, '');
  if (!base) return;
  try {
    const res = await fetch(`${base}/warmup`, { signal: AbortSignal.timeout(8000) });
    console.log(`予約支援サーバーをウォームアップしました (HTTP ${res.status})`);
  } catch (e) {
    console.log(`予約支援サーバーのウォームアップに失敗(無視): ${e.message}`);
  }
}

module.exports = { sendLineMessage, formatMessage, buildFlexMessage, buildFlexMessages, warmupBookingServer };
