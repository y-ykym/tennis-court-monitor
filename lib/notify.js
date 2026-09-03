// ============================================================
// LINE Messaging API での push 通知 (Flex Message)
// 必要な環境変数(GitHub Secrets経由で渡される):
//   LINE_CHANNEL_ACCESS_TOKEN … チャネルアクセストークン(長期)
//   LINE_USER_ID              … 通知先のユーザーID(U〜)またはグループID(C〜)
//
// 通知はカード型のFlex Messageで送る:
//   - ヘッダー: 「🎾 新しい空き N件」
//   - 日付ごとのチップ(土=青/日祝=赤/平日=グレー、直近は「今日/明日/明後日」ラベル付き)
//   - 各枠: 時間帯 + 施設名 + 面数バッジ(残1面はオレンジで強調)
//   - フッター: 予約サイト(トップページ)へのリンクボタン
//     ※該当枠への直リンクは不可(予約画面はセッション前提のPOST遷移のため)
//   - 各枠の「予約」ボタン(フェーズ2): 環境変数 BOOKING_BASE_URL と BOOKING_SIGNING_SECRET が両方あるときだけ付く。
//     予約支援サーバー(booking/server)の /book に、枠情報+有効期限を HMAC 署名したトークン付きで飛ぶ。
//     ボタンを付けると1件あたりのサイズが増えるので、バブル 10KB を超えないよう件数を自動で減らす
// altText(プッシュ通知バナーに出る文字列)は開かなくても内容が分かる要約にする。
// formatMessage() はdry-run表示用のプレーンテキスト版。
// ============================================================
const Holidays = require('japanese-holidays');
const { PARKS } = require('./config');
const { jstTodayYmd, ymdToIso } = require('./date');

// フェーズ2 予約ボタン用の署名モジュール(booking/src/token.js は ESM。Node 22.12+ は require() で読める)
let tokenLib = null;
try {
  tokenLib = require('../booking/src/token.js');
} catch (e) {
  tokenLib = null; // 読めない環境ではボタン無しで送る(通知自体は止めない)
}

// 予約ボタンの設定。両方揃っていなければ無効(従来どおりボタン無し)
function bookingConfig() {
  const base = (process.env.BOOKING_BASE_URL || '').replace(/\/$/, '');
  const secret = process.env.BOOKING_SIGNING_SECRET || '';
  if (!base || !secret || !tokenLib) return null;
  return { base, secret };
}

// 枠 → 「予約」ボタン(予約支援サーバーへの署名付きURL)。公園コードが分からない枠には付けない
function bookingButton(slot, cfg) {
  const park = PARKS.find((p) => String(slot.facility).includes(p.keyword));
  const startHour = Number(String(slot.time).match(/^0?(\d{1,2}):/)?.[1]);
  if (!park || !startHour) return null;
  const token = tokenLib.sign(
    { park: park.code, date: slot.date, startHour, people: 2, exp: tokenLib.slotExpiry(slot.date, startHour) },
    cfg.secret
  );
  return {
    type: 'button',
    style: 'primary',
    height: 'sm',
    color: '#06C755',
    flex: 0,
    margin: 'sm',
    action: { type: 'uri', label: '予約', uri: `${cfg.base}/book?token=${token}` },
  };
}

const SITE_URL = 'https://kouen.sports.metro.tokyo.lg.jp/web/index.jsp';
// 1通に載せる枠数の上限(超過分は「…ほかN件」)
// ※LINEのFlex Messageはバブルあたり10KBの制限があり、20件だと約11.7KBで超過して
//   400エラーになるため12件に設定(実測: 1件あたり約520B+固定部約1.4KB ≒ 12件で約7.6KB)
//   予約ボタン付きは1件あたり約900B増えるため、buildFlexMessage() が実サイズを測って件数を減らす
const MAX_SLOTS = 12;
// バブルの JSON サイズ上限(LINE の 10KB 制限に余裕を持たせる)
const MAX_BUBBLE_BYTES = 9800;

const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];

// 日付チップ・バッジの配色
const DAY_COLORS = {
  sat: { bg: '#E6F1FB', fg: '#0C447C' }, // 土曜: 青
  sun: { bg: '#FCEBEB', fg: '#791F1F' }, // 日曜・祝日: 赤
  weekday: { bg: '#F0F0F0', fg: '#3F3F3F' },
};
const BADGE_LAST_ONE = { bg: '#FAECE7', fg: '#993C1D' }; // 残1面: オレンジで強調
const BADGE_NORMAL = { bg: '#E1F5EE', fg: '#085041' };

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
      lines.push('', `📅 ${dateLabel(s.date)}${rel ? ` (${rel})` : ''}`);
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

// 角丸の色付きラベル(日付チップ・面数バッジ共用)
function chip(text, { bg, fg }, size) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    backgroundColor: bg,
    cornerRadius: '10px',
    paddingAll: '2px',
    paddingStart: '9px',
    paddingEnd: '9px',
    contents: [{ type: 'text', text, size, weight: 'bold', color: fg, align: 'center' }],
  };
}

function buildFlexMessage(slots) {
  const sorted = sortSlots(slots);
  // 予約ボタン付きだと1件が大きくなるので、10KB に収まるまで件数を減らす(最低1件)
  let n = Math.min(MAX_SLOTS, sorted.length);
  let message = buildFlexMessageN(sorted, n);
  while (n > 1 && Buffer.byteLength(JSON.stringify(message.contents), 'utf8') > MAX_BUBBLE_BYTES) {
    n -= 1;
    message = buildFlexMessageN(sorted, n);
  }
  return message;
}

function buildFlexMessageN(sorted, n) {
  const shown = sorted.slice(0, n);
  const cfg = bookingConfig();

  const body = [];
  let prevDate = null;
  for (const s of shown) {
    if (s.date !== prevDate) {
      const rel = relativeLabel(s.date);
      body.push({
        type: 'box',
        layout: 'horizontal',
        margin: prevDate === null ? 'md' : 'xl',
        contents: [
          chip(dateLabel(s.date).replace('(', ' ').replace(')', ''), dayColors(s.date), 'xs'),
          ...(rel
            ? [
                {
                  type: 'text',
                  text: rel,
                  size: 'xs',
                  weight: 'bold',
                  color: '#B03A3A',
                  gravity: 'center',
                  margin: 'md',
                  flex: 0,
                },
              ]
            : []),
          { type: 'filler' },
        ],
      });
      prevDate = s.date;
    }
    body.push({
      type: 'box',
      layout: 'horizontal',
      margin: 'sm',
      contents: [
        { type: 'text', text: String(s.time), size: 'sm', weight: 'bold', color: '#111111', flex: 0 },
        {
          type: 'text',
          text: String(s.facility),
          size: 'sm',
          color: '#333333',
          margin: 'md',
          flex: 1,
          gravity: 'center',
        },
        chip(
          s.count === 1 ? '残1面' : `${s.count}面`,
          s.count === 1 ? BADGE_LAST_ONE : BADGE_NORMAL,
          'xxs'
        ),
        ...(cfg ? [bookingButton(s, cfg)].filter(Boolean) : []),
      ],
    });
  }
  if (sorted.length > n) {
    body.push({
      type: 'text',
      text: `…ほか${sorted.length - n}件`,
      size: 'xs',
      color: '#999999',
      align: 'center',
      margin: 'lg',
    });
  }

  return {
    type: 'flex',
    altText: buildAltText(sorted),
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#06C755',
        paddingAll: '12px',
        paddingStart: '14px',
        contents: [
          {
            type: 'text',
            text: `🎾 新しい空き ${sorted.length}件`,
            color: '#FFFFFF',
            weight: 'bold',
            size: 'md',
          },
        ],
      },
      // 文字色を濃色で決め打ちしているため、背景もアプリのテーマ(ダークモード)に
      // 依存しないよう白を明示する
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '14px',
        paddingTop: '2px',
        backgroundColor: '#FFFFFF',
        contents: body,
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFFFF',
        contents: [
          { type: 'separator', color: '#EEEEEE' },
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: { type: 'uri', label: '予約サイトを開く', uri: SITE_URL },
          },
        ],
      },
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
    body: JSON.stringify({ to, messages: [buildFlexMessage(slots)] }),
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

module.exports = { sendLineMessage, formatMessage, buildFlexMessage, warmupBookingServer };
