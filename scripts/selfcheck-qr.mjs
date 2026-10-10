/**
 * QR 数据位流自检（不依赖任何第三方实现）。
 *
 * 做法：按 ISO/IEC 18004 的规则重建功能图案保留集，用 Z 字形顺序读回数据位，
 * 去掩码后解析「字节模式」载荷，与原始输入逐字节比对。
 * 这样可以验证数据放置、掩码、纠错分块之前的位流构造是否正确。
 *
 *   node scripts/selfcheck-qr.mjs
 */
import { encodeQr } from "../src/model/barcode.ts";

const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function alignmentPositions(version) {
  const size = version * 4 + 17;
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  if (count === 2) return [6, size - 7];
  const step = Math.ceil((size - 13) / (count - 1) / 2) * 2;
  const p = [6];
  for (let i = count - 1; i >= 1; i--) p.splice(1, 0, size - 7 - (count - 1 - i) * step);
  return p;
}

/** 按规范重建功能图案保留集（true = 不属于数据区） */
function buildReserved(size, version) {
  const res = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => {
    if (r >= 0 && c >= 0 && r < size && c < size) res[r][c] = true;
  };
  // 定位图案 + 分隔符
  for (const [rr, cc] of [[0, 0], [0, size - 8], [size - 8, 0]]) {
    for (let r = 0; r <= 7; r++) for (let c = 0; c <= 7; c++) mark(rr + r, cc + c);
  }
  // 校正图案
  for (const r of alignmentPositions(version)) {
    for (const c of alignmentPositions(version)) {
      const near = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (near) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }
  }
  // 时序图案
  for (let i = 8; i <= size - 9; i++) {
    mark(6, i);
    mark(i, 6);
  }
  // 格式信息两副本 + 固定黑模块
  for (let i = 0; i <= 8; i++) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i <= 7; i++) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  // 版本信息两副本
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3);
      const c = i % 3;
      mark(size - 11 + c, r);
      mark(r, size - 11 + c);
    }
  }
  return res;
}

/** 读回数据位（按 Z 字形顺序，去掩码） */
function readDataBits(matrix, version, mask) {
  const size = matrix.size;
  const res = buildReserved(size, version);
  const bits = [];
  let upward = true;
  for (let pair = size - 1; pair > 0; pair -= 2) {
    const rc = pair === 6 ? 5 : pair;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [rc, rc - 1]) {
        if (c < 0 || res[row][c]) continue;
        bits.push(matrix.modules[row][c] !== MASK_FNS[mask](row, c) ? 1 : 0);
      }
    }
    upward = !upward;
  }
  return bits;
}

function bytesFromBits(bits) {
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[i + k];
    out.push(v);
  }
  return out;
}

/** 解析字节模式载荷。字符计数位宽：版本 1-9 为 8 位，10-26 为 16 位。 */
function parseByteMode(bytes, version) {
  const countBits = version <= 9 ? 8 : 16;
  const read = (pos, n) => {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const p = pos + k;
      v = (v << 1) | ((bytes[p >> 3] >> (7 - (p & 7))) & 1);
    }
    return v;
  };
  const mode = read(0, 4);
  if (mode !== 4) return { error: `模式不是字节模式：${mode}` };
  const len = read(4, countBits);
  const out = [];
  for (let i = 0; i < len; i++) out.push(read(4 + countBits + i * 8, 8));
  return { mode, len, bytes: out, countBits };
}

let pass = 0;
let fail = 0;
const lengths = [1, 5, 10, 17, 20, 33, 45, 60, 78, 90, 107, 120, 150, 179, 200, 250];
const cases = lengths.map((n) => "A".repeat(n));
cases.push("中文标签测试", "https://example.com/labeldesk?id=12345", "6901234567892");

for (const text of cases) {
  const m = encodeQr(text, "M");
  if (m.size === 0) {
    console.log(`✗ 长度 ${text.length} 生成失败`);
    fail++;
    continue;
  }
  const bits = readDataBits(m, m.version, m.mask);
  const bytes = bytesFromBits(bits);
  const parsed = parseByteMode(bytes, m.version);
  const expected = [...new TextEncoder().encode(text)];
  const ok =
    !parsed.error &&
    parsed.len === expected.length &&
    parsed.bytes.every((b, i) => b === expected[i]);
  const label = `v${m.version} mask${m.mask} ${expected.length} 字节`;
  if (ok) {
    pass++;
    console.log(`  ✓ ${label} 位流正确`);
  } else {
    fail++;
    console.log(`  ✗ ${label} 期望 ${expected.length} 字节，解析得到 ${parsed.len ?? "-"}（${parsed.error ?? ""}）`);
    console.log(`     得到: ${(parsed.bytes ?? []).slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
    console.log(`     期望: ${expected.slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
