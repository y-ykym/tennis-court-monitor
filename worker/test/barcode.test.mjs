// フェーズ7 バーコード生成のテスト。
// 期待値の「モジュール列」は、予約サイトが実際に読み込んでいる jquery-barcode を
// ブラウザで動かして描かせた縞と 1 モジュールずつ突き合わせて確認したもの(2026-09-18)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { code128Modules, barcodePng, BARCODE_PNG_SIZE } from '../src/barcode.js';

const QUIET = '0'.repeat(10);
// 実機の利用者カードと同じ番号での期待値(本家ライブラリの描画と一致)
const EXPECTED_00000000 =
  '000000000011010011100110110011001101100110011011001100110110011001100110011011000111010110000000000';

test('barcode: 8 桁の利用者番号 → 99 モジュール。本家ライブラリと同じ縞になる', () => {
  const m = code128Modules('00000000');
  assert.equal(m.length, 99);
  assert.equal(m, EXPECTED_00000000);
  // 前後のクワイエットゾーン(白 10 モジュール)はスキャナが読み始めを判断するのに必須
  assert.ok(m.startsWith(QUIET) && m.endsWith(QUIET));
  // バーコード本体は必ず黒で始まり黒で終わる
  const core = m.slice(10, -10);
  assert.ok(core.startsWith('1') && core.endsWith('1'));
});

test('barcode: CODE128 の構造(11 モジュール × シンボル + 終端 13、各シンボルは黒 3 本・偶数パリティ)', () => {
  const core = code128Modules('00000000').slice(10, -10);
  // START + データ4 + チェック + STOP(13 モジュール)
  assert.equal(core.length, 11 * 6 + 13);
  const symbols = [];
  for (let i = 0; i + 11 <= 11 * 6; i += 11) symbols.push(core.slice(i, i + 11));
  for (const s of symbols) {
    // 黒→白→黒→白→黒→白 の 6 要素・合計 11 モジュール
    const runs = s.match(/(.)\1*/g);
    assert.equal(runs.length, 6, `要素数 ${s}`);
    assert.equal(runs.join('').length, 11);
    // 黒(1)の合計が偶数 = CODE128 の偶数パリティ。1 本でも表を写し間違えると崩れる
    const black = runs.filter((r) => r[0] === '1').reduce((n, r) => n + r.length, 0);
    assert.equal(black % 2, 0, `黒の本数が奇数 ${s}`);
  }
  // 終端は CODE128 の STOP パターン
  assert.equal(core.slice(11 * 6), '1100011101011');
});

test('barcode: 番号が違えば縞も変わる。数字以外・奇数桁は作らない', () => {
  assert.notEqual(code128Modules('00000000'), code128Modules('00000001'));
  assert.throws(() => code128Modules('1028543'), /偶数桁/);
  assert.throws(() => code128Modules('1028543a'), /数字/);
});

test('barcode: PNG として正しく、展開した画素が縞と一致する', async () => {
  const png = await barcodePng('00000000');
  // シグネチャ
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR(先頭チャンク)
  const v = new DataView(png.buffer, png.byteOffset);
  assert.equal(String.fromCharCode(...png.slice(12, 16)), 'IHDR');
  const width = v.getUint32(16);
  const height = v.getUint32(20);
  assert.equal(width, BARCODE_PNG_SIZE.width);
  assert.equal(height, BARCODE_PNG_SIZE.height);
  assert.equal(png[24], 1, 'ビット深度 1(白黒 2 値)');
  assert.equal(png[25], 0, 'グレースケール');

  // IDAT を展開して、バーのある行の画素を読む
  let at = 8;
  let idat = null;
  while (at < png.length) {
    const len = v.getUint32(at);
    const type = String.fromCharCode(...png.slice(at + 4, at + 8));
    if (type === 'IDAT') idat = png.slice(at + 8, at + 8 + len);
    at += 12 + len;
  }
  assert.ok(idat, 'IDAT がある');
  const raw = inflateSync(Buffer.from(idat));
  const rowBytes = Math.ceil(width / 8);
  assert.equal(raw.length, (1 + rowBytes) * height, '1 行 = フィルタ 1 バイト + 画素');

  // 真ん中の行を 1 モジュールずつ読み直す(0 が黒・1 が白)
  const mid = Math.floor(height / 2);
  const row = raw.subarray(mid * (1 + rowBytes) + 1);
  const modulePx = width / code128Modules('00000000').length;
  let read = '';
  for (let i = 0; i < width; i += modulePx) {
    const bit = (row[i >> 3] >> (7 - (i & 7))) & 1;
    read += bit ? '0' : '1';
  }
  assert.equal(read, EXPECTED_00000000, '画素から読み直した縞');

  // 上下の余白は真っ白
  const topRow = raw.subarray(1);
  assert.ok([...topRow.subarray(0, rowBytes)].every((b) => b === 0xff), '上の余白は白');
});

test('barcode: PNG は十分に小さい(電波の弱い受付でもすぐ出る)', async () => {
  const png = await barcodePng('00000000');
  assert.ok(png.length < 5000, `${png.length} バイト`);
});
