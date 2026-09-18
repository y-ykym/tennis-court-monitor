// ============================================================
// フェーズ7 利用者カード: CODE128 のバーコードを PNG にする
//
// 予約サイトの「利用者カード」(ヘッダーの「利用者カード表示」で出るモーダル)は、
// バーコードを画像として配信しておらず jquery-barcode がブラウザ上で描いているだけ。
// 中身は利用者番号 8 桁そのままで、毎回変わる使い捨ての値ではない。
//   <script>$("#barcode").barcode("00000000", "code128", { barWidth:2, barHeight:150 });</script>
//
// 受付のスキャナに読ませるので、縞の並びがサイトの表示と 1 モジュールも違わないように、
// パターン表はサイトが読み込んでいる本家(BarCode Coder Library 2.0 / jquery-barcode 2.2、
// web/js/lib/jquery-barcode.min.js の配列 S)から取った値をそのまま持つ。
//
// 8 桁の数字は CODE128-C(数字 2 桁 = 1 シンボル)で符号化される。本家も「先頭 3 文字が数字なら C」
// で始めるので同じ並びになる。モジュール(最小の縞 1 本分)の列は:
//
//   クワイエットゾーン10 + START C + データ4 + チェックディジット + STOP + "11" + クワイエットゾーン10
//   = 10 + 11 + 11*4 + 11 + 11 + 2 + 10 = 99 モジュール
//
// クワイエットゾーン(前後の白い余白)はスキャナが読み始め・読み終わりを判断するために必須。
// PNG は 1bit グレースケール(白黒 2 値)で作り、圧縮は標準の CompressionStream('deflate') を使う
// (PNG の IDAT は zlib ストリームそのものなので、これだけで正しい PNG になる)。
// ============================================================

// 値 0〜102 = データ、103/104/105 = START A/B/C、106 = STOP。'1' が黒、'0' が白で 1 文字 = 1 モジュール
const PATTERNS = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100',
  '10011001000', '10011000100', '10001100100', '11001001000', '11001000100', '11000100100',
  '10110011100', '10011011100', '10011001110', '10111001100', '10011101100', '10011100110',
  '11001110010', '11001011100', '11001001110', '11011100100', '11001110100', '11101101110',
  '11101001100', '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000', '10001000110',
  '10110001000', '10001101000', '10001100010', '11010001000', '11000101000', '11000100010',
  '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110',
  '11101110110', '11010001110', '11000101110', '11011101000', '11011100010', '11011101110',
  '11101011000', '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000', '10100001100', '10010110000',
  '10010000110', '10000101100', '10000100110', '10110010000', '10110000100', '10011010000',
  '10011000010', '10000110100', '10000110010', '11000010010', '11001010000', '11110111010',
  '11000010100', '10001111010', '10100111100', '10010111100', '10010011110', '10111100100',
  '10011110100', '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
  '11011110110', '11110110110', '10101111000', '10100011110', '10001011110', '10111101000',
  '10111100010', '11110101000', '11110100010', '10111011110', '10111101110', '11101011110',
  '11110101110', '11010000100', '11010010000', '11010011100', '11000111010'
];

const START_C = 105;
const STOP = 106;
// STOP の後ろに必ず付く終端バー(本家も S[106] + "11")
const STOP_TAIL = '11';
// 前後の白い余白。本家の addQuietZone(既定 true)と同じ 10 モジュール
const QUIET = '0'.repeat(10);

// 利用者番号(偶数桁の数字列)→ モジュール列。'1' が黒、'0' が白
export function code128Modules(digits) {
  const s = String(digits);
  if (!/^\d+$/.test(s)) throw new Error('バーコードにできるのは数字だけです');
  if (s.length % 2 !== 0) throw new Error('CODE128-C は偶数桁の数字しか入れられません');
  const values = [];
  for (let i = 0; i < s.length; i += 2) values.push(Number(s.slice(i, i + 2)));
  // チェックディジット: START の値 + (位置 1,2,3… × シンボルの値) の合計を 103 で割った余り
  let sum = START_C;
  values.forEach((v, i) => {
    sum += (i + 1) * v;
  });
  const check = sum % 103;
  const body = [START_C, ...values, check, STOP].map((v) => PATTERNS[v]).join('');
  return QUIET + body + STOP_TAIL + QUIET;
}

// --- PNG の組み立て ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// 1bit グレースケールの PNG。rows は「1 行分のバイト列」の配列(上から順)
async function buildPng(width, height, rows) {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 1; // ビット深度 1(白黒 2 値)
  ihdr[9] = 0; // カラータイプ 0(グレースケール)
  // 10,11,12 = 圧縮方式 0 / フィルタ方式 0 / 非インターレース
  const idat = await deflate(concat(rows));
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// PNG の寸法。モジュール 1 本を MODULE_PX の幅で描く。
// 上下の白い余白(PAD_Y)は、スキャナを斜めに当てても縞だけを拾えるようにするため
const MODULE_PX = 12;
// 縞の高さは実物の比率に合わせる(サイトは 99 モジュール × barWidth 2 = 198px 幅 に対して barHeight 150px)。
// 縦に長いほうがスキャナを当てやすいという実利もある
const BAR_HEIGHT_PX = 840;
const PAD_Y = 30;
const MODULE_COUNT = 99; // 8 桁のときのモジュール数(code128Modules の長さ)

export const BARCODE_PNG_SIZE = {
  width: MODULE_COUNT * MODULE_PX,
  height: BAR_HEIGHT_PX + PAD_Y * 2,
};

// 利用者番号 → バーコードの PNG(Uint8Array)
export async function barcodePng(digits) {
  const modules = code128Modules(digits);
  const width = modules.length * MODULE_PX;
  const height = BAR_HEIGHT_PX + PAD_Y * 2;
  const rowBytes = Math.ceil(width / 8);

  // 1bit グレースケールでは 0 が黒・1 が白。バーのある行を 1 本だけ作って使い回す
  const bar = new Uint8Array(1 + rowBytes).fill(0xff);
  bar[0] = 0; // フィルタ方式 0(そのまま)
  for (let x = 0; x < width; x++) {
    if (modules[Math.floor(x / MODULE_PX)] !== '1') continue;
    bar[1 + (x >> 3)] &= ~(0x80 >> (x & 7));
  }
  const blank = new Uint8Array(1 + rowBytes).fill(0xff);
  blank[0] = 0;

  const rows = [];
  for (let y = 0; y < PAD_Y; y++) rows.push(blank);
  for (let y = 0; y < BAR_HEIGHT_PX; y++) rows.push(bar);
  for (let y = 0; y < PAD_Y; y++) rows.push(blank);

  return buildPng(width, height, rows);
}
