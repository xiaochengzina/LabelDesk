/**
 * 与独立参考实现对照完整的码字流（数据 + 纠错 + 交织）。
 *   node scripts/cmp-codewords.cjs
 */
const RSEncoder = require("qrcode/lib/core/reed-solomon-encoder.js");

// 纠错参数（版本 1-6，索引 = 版本-1）
const ECC_PER_BLOCK = {
  L: [7, 10, 15, 20, 26, 18],
  M: [10, 16, 26, 18, 24, 16],
  Q: [13, 22, 18, 26, 18, 24],
  H: [17, 28, 22, 16, 22, 28],
};
const NUM_BLOCKS = {
  L: [1, 1, 1, 1, 1, 2],
  M: [1, 1, 1, 2, 2, 4],
  Q: [1, 1, 2, 2, 4, 4],
  H: [1, 1, 2, 4, 4, 4],
};
function alignPositions(v) {
  const size = v * 4 + 17;
  if (v === 1) return [];
  const count = Math.floor(v / 7) + 2;
  if (count === 2) return [6, size - 7];
  const step = Math.ceil((size - 13) / (count - 1) / 2) * 2;
  const p = [6];
  for (let i = count - 1; i >= 1; i--) p.splice(1, 0, size - 7 - (count - 1 - i) * step);
  return p;
}
function totalCodewords(v) {
  const size = v * 4 + 17;
  let t = size * size - 3 * 64;
  const p = alignPositions(v);
  if (p.length > 0) t -= (p.length * p.length - 3) * 25;
  t -= 31;
  if (v >= 7) t -= 36;
  t -= (size - 16) * 2;
  return Math.floor(t / 8);
}

function referenceCodewords(text, level, version) {
  const bytes = Array.from(Buffer.from(text, "utf8"));
  const eccPerBlock = ECC_PER_BLOCK[level][version - 1];
  const numBlocks = NUM_BLOCKS[level][version - 1];
  const total = totalCodewords(version);
  const dataTotal = total - eccPerBlock * numBlocks;
  const countBits = version <= 9 ? 8 : 16;

  const bits = [];
  const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  push(4, 4);
  push(bytes.length, countBits);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataTotal * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[i + k];
    data.push(v);
  }
  const pad = [0xec, 0x11];
  let pi = 0;
  while (data.length < dataTotal) { data.push(pad[pi % 2]); pi++; }

  const shortLen = Math.floor(total / numBlocks) - eccPerBlock;
  const numLong = dataTotal % numBlocks;
  const numShort = numBlocks - numLong;
  const encoder = new RSEncoder(eccPerBlock);
  const blocks = [];
  const eccs = [];
  let off = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = shortLen + (i >= numShort ? 1 : 0);
    const blk = data.slice(off, off + len);
    off += len;
    blocks.push(blk);
    eccs.push(Array.from(encoder.encode(Uint8Array.from(blk))));
  }
  const inter = [];
  const maxLen = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.length) inter.push(b[i]);
  for (let i = 0; i < eccPerBlock; i++) for (const e of eccs) if (i < e.length) inter.push(e[i]);
  return inter;
}

module.exports = { referenceCodewords, totalCodewords, ECC_PER_BLOCK, NUM_BLOCKS };
