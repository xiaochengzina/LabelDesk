/**
 * 一维码反向解码：把 BarPattern 还原成原始内容，验证编码确实可被扫码器识别。
 *
 * 做法与真实扫码器一致：把宽度量化成宽/窄（或对 Code128 用参考宽度表打分），
 * 再按各自规则校验起始符、校验位和内容。
 */
import {
  encodeCode128,
  encodeCode39,
  encodeEan13,
  encodeEan8,
  encodeUpcA,
  encodeItf14,
} from "../src/model/barcode.ts";

/** 把 widths 量化成模块数：以最小宽度为 1 个单位 */
function quantize(widths) {
  const min = Math.min(...widths);
  return widths.map((w) => Math.max(1, Math.round(w / min)));
}

// ---------------------------------------------------------------------------
// Code 39 解码（按 9 元素的宽/窄组合查表，宽=3 窄=1）
// ---------------------------------------------------------------------------
const CODE39_BINARY = {
  "0": "101001101101", "1": "110100101011", "2": "101100101011", "3": "110110010101",
  "4": "101001101011", "5": "110100110101", "6": "101100110101", "7": "101001011011",
  "8": "110100101101", "9": "101100101101",
  A: "110101001011", B: "101101001011", C: "110110100101", D: "101011001011",
  E: "110101100101", F: "101101100101", G: "101010011011", H: "110101001101",
  I: "101101001101", J: "101011001101", K: "110101010011", L: "101101010011",
  M: "110110101001", N: "101011010011", O: "110101101001", P: "101101101001",
  Q: "101010110011", R: "110101011001", S: "101101011001", T: "101011011001",
  U: "110010101011", V: "100110101011", W: "110011010101", X: "100101101011",
  Y: "110010110101", Z: "100110110101",
  "-": "100101011011", ".": "110010101101", " ": "100110101101",
  $: "100100100101", "/": "100100101001", "+": "100101001001", "%": "101001001001",
  "*": "100101101101",
};

/** 由二进制图案得到宽元素位置（元素下标 0..8） */
function widePositions(binary) {
  const widths = [];
  let i = 0;
  while (i < binary.length) {
    const bit = binary[i];
    let run = 1;
    while (i + run < binary.length && binary[i + run] === bit) run++;
    widths.push(run);
    i += run;
  }
  if (widths.length !== 9) throw new Error(`元素数不是 9: ${binary}`);
  const wide = [];
  widths.forEach((w, idx) => {
    if (w >= 2) wide.push(idx);
  });
  return wide.join(",");
}

const CODE39_LOOKUP = new Map();
for (const [ch, binary] of Object.entries(CODE39_BINARY)) {
  CODE39_LOOKUP.set(widePositions(binary), ch);
}

function decodeCode39(pattern) {
  const q = quantize(pattern.widths);
  const total = q.length;
  if ((total - 9 - 1 - 9) % 10 !== 0) return { error: `元素个数不对: ${total}` };
  const charCount = (total - 9 - 1 - 9) / 10;
  if (charCount < 0) return { error: "元素太少" };

  const readChar = (offset) => {
    const wide = [];
    for (let i = 0; i < 9; i++) {
      const w = q[offset + i];
      if (w >= 2) wide.push(i);
      else if (w !== 1) return { error: `宽度异常 ${w}` };
    }
    const ch = CODE39_LOOKUP.get(wide.join(","));
    return ch ? { ch } : { error: `未识别的宽元素组合 [${wide.join(",")}]` };
  };

  const first = readChar(0);
  if (first.error) return first;
  if (first.ch !== "*") return { error: `起始符不是 *，而是 ${first.ch}` };

  let text = "";
  let offset = 9;
  for (let i = 0; i < charCount; i++) {
    if (q[offset] !== 1) return { error: `字符间隔不是窄空 (${q[offset]})` };
    offset += 1;
    const r = readChar(offset);
    if (r.error) return r;
    text += r.ch;
    offset += 9;
  }
  if (q[offset] !== 1) return { error: "终止符前不是窄空" };
  offset += 1;
  const last = readChar(offset);
  if (last.error) return last;
  if (last.ch !== "*") return { error: `终止符不是 *，而是 ${last.ch}` };
  return { text };
}

// ---------------------------------------------------------------------------
// Code 128 解码
// ---------------------------------------------------------------------------
const CODE128_TABLE = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

function decodeCode128(pattern) {
  const widths = pattern.widths;
  // 用元素宽度串匹配码表（不受条/空极性影响）
  const tokens = [];
  let i = 0;
  while (i < widths.length) {
    let matched = null;
    for (let len = 7; len >= 6; len--) {
      if (i + len > widths.length) continue;
      const key = widths.slice(i, i + len).join("");
      const idx = CODE128_TABLE.indexOf(key);
      if (idx >= 0) {
        matched = { idx, len };
        break;
      }
    }
    if (!matched) return { error: `第 ${i} 个元素起无法匹配码表（宽度 ${widths.slice(i, i + 7).join("")}）` };
    tokens.push(matched.idx);
    i += matched.len;
  }

  if (tokens.length < 4) return { error: `符号数太少: ${tokens.length}` };
  const start = tokens[0];
  if (start !== 103 && start !== 104 && start !== 105) return { error: `起始符非法: ${start}` };
  const stop = tokens[tokens.length - 1];
  if (stop !== 106) return { error: `缺少终止符，末符号为 ${stop}` };

  const body = tokens.slice(1, -1);
  const checksum = body[body.length - 1];
  const data = body.slice(0, -1);

  let sum = start;
  data.forEach((c, index) => {
    sum += c * (index + 1);
  });
  if (sum % 103 !== checksum) {
    return { error: `校验位不符：期望 ${sum % 103}，实际 ${checksum}` };
  }

  let set = start === 103 ? "A" : start === 104 ? "B" : "C";
  let text = "";
  for (const code of data) {
    if (set === "C") {
      if (code <= 99) {
        text += String(code).padStart(2, "0");
        continue;
      }
      if (code === 100) { set = "B"; continue; }
      if (code === 101) { set = "A"; continue; }
      return { error: `C 集出现非法码字 ${code}` };
    }
    if (code <= 95) {
      text += String.fromCharCode(code + 32);
      continue;
    }
    if (code === 99) { set = "C"; continue; }
    if (code === 100) { set = "B"; continue; }
    if (code === 101) { set = "A"; continue; }
    return { error: `${set} 集出现非法码字 ${code}` };
  }
  return { text };
}

// ---------------------------------------------------------------------------
// EAN / UPC 解码（按模块序列反查）
// ---------------------------------------------------------------------------
const EAN_L = {
  "0001101": "0", "0011001": "1", "0010011": "2", "0111101": "3", "0100011": "4",
  "0110001": "5", "0101111": "6", "0111011": "7", "0110111": "8", "0001011": "9",
};
const EAN_G = {
  "0100111": "0", "0110011": "1", "0011011": "2", "0100001": "3", "0011101": "4",
  "0111001": "5", "0000101": "6", "0010001": "7", "0001001": "8", "0010111": "9",
};
const EAN_R = {
  "1110010": "0", "1100110": "1", "1101100": "2", "1000010": "3", "1011100": "4",
  "1001110": "5", "1010000": "6", "1000100": "7", "1001000": "8", "1110100": "9",
};
const EAN13_PARITY = {
  LLLLLL: "0", LLGLGG: "1", LLGGLG: "2", LLGGGL: "3", LGLLGG: "4",
  LGGLLG: "5", LGGGLL: "6", LGLGLG: "7", LGLGGL: "8", LGGLGL: "9",
};

function modulesOf(pattern) {
  const q = quantize(pattern.widths);
  if (q.some((w) => w !== 1)) return null;
  return pattern.bars.map((b) => (b ? "1" : "0")).join("");
}

function decodeEan13(pattern) {
  const m = modulesOf(pattern);
  if (!m) return { error: "EAN-13 出现非单位宽度模块" };
  if (m.length !== 95) return { error: `模块数应为 95，实际 ${m.length}` };
  if (!m.startsWith("101") || !m.endsWith("101")) return { error: "护线不符" };
  if (m.slice(45, 50) !== "01010") return { error: "中护线不符" };

  let left = "";
  let parity = "";
  for (let i = 0; i < 6; i++) {
    const seg = m.slice(3 + i * 7, 10 + i * 7);
    if (EAN_L[seg] !== undefined) { left += EAN_L[seg]; parity += "L"; }
    else if (EAN_G[seg] !== undefined) { left += EAN_G[seg]; parity += "G"; }
    else return { error: `左侧第 ${i} 位无法解码: ${seg}` };
  }
  const first = EAN13_PARITY[parity];
  if (first === undefined) return { error: `奇偶模式非法: ${parity}` };

  let right = "";
  for (let i = 0; i < 6; i++) {
    const seg = m.slice(50 + i * 7, 57 + i * 7);
    if (EAN_R[seg] === undefined) return { error: `右侧第 ${i} 位无法解码: ${seg}` };
    right += EAN_R[seg];
  }
  return { text: first + left + right };
}

function decodeUpcLike(pattern, leftCount, totalDigits) {
  const m = modulesOf(pattern);
  if (!m) return { error: "出现非单位宽度模块" };
  const expected = 3 + leftCount * 7 + 5 + (totalDigits - leftCount) * 7 + 3;
  if (m.length !== expected) return { error: `模块数应为 ${expected}，实际 ${m.length}` };
  if (!m.startsWith("101") || !m.endsWith("101")) return { error: "护线不符" };
  let left = "";
  for (let i = 0; i < leftCount; i++) {
    const seg = m.slice(3 + i * 7, 10 + i * 7);
    if (EAN_L[seg] === undefined) return { error: `左侧第 ${i} 位无法解码: ${seg}` };
    left += EAN_L[seg];
  }
  const midStart = 3 + leftCount * 7;
  if (m.slice(midStart, midStart + 5) !== "01010") return { error: "中护线不符" };
  let right = "";
  for (let i = 0; i < totalDigits - leftCount; i++) {
    const seg = m.slice(midStart + 5 + i * 7, midStart + 12 + i * 7);
    if (EAN_R[seg] === undefined) return { error: `右侧第 ${i} 位无法解码: ${seg}` };
    right += EAN_R[seg];
  }
  return { text: left + right };
}

function decodeItf14(pattern) {
  const q = quantize(pattern.widths);
  const bits = pattern.bars.map((b) => (b ? "1" : "0")).join("");
  if (bits.length !== 4 + 70 + 3) return { error: `元素个数应为 77，实际 ${bits.length}` };
  if (!bits.startsWith("1010")) return { error: "起始符不符" };
  // 7 组，每组 5 条 + 5 空 = 10 个元素
  let digits = "";
  for (let group = 0; group < 7; group++) {
    let bars = "";
    let spaces = "";
    for (let k = 0; k < 5; k++) {
      bars += q[4 + group * 10 + k * 2] >= 2 ? "1" : "0";
      spaces += q[4 + group * 10 + k * 2 + 1] >= 2 ? "1" : "0";
    }
    const a = ITF_PATTERNS.indexOf(bars);
    const b = ITF_PATTERNS.indexOf(spaces);
    if (a < 0 || b < 0) return { error: `第 ${group} 组无法解码: bars=${bars} spaces=${spaces}` };
    digits += String(a) + String(b);
  }
  const tail = q.slice(4 + 70);
  if (tail.join("") !== "311") return { error: `终止符不符: "${tail.join("")}"` };
  return { text: digits };
}

const ITF_PATTERNS = ["00110", "10001", "01001", "11000", "00101", "10100", "01100", "00011", "10010", "01010"];

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
function expect(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    pass++;
    console.log(`  \u2713 ${label}`);
  } else {
    fail++;
    console.log(`  \u2717 ${label} -- 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

console.log("\n=== Code 128 解码回读 ===");
for (const value of ["ABC-12345", "12345678", "HELLO WORLD", "a1B2c3", "1234567890123456789012"]) {
  const p = encodeCode128(value);
  const r = decodeCode128(p);
  expect(`Code128 "${value}"`, r.text ?? `ERR:${r.error}`, value);
}
// 奇偶混合：数字串 + 文字，触发 B→C→B 切换
for (const value of ["ABC1234567890123XYZ", "ITEM001234567890"]) {
  const p = encodeCode128(value);
  const r = decodeCode128(p);
  expect(`Code128 混合 "${value}"`, r.text ?? `ERR:${r.error}`, value);
}

console.log("\n=== Code 39 解码回读 ===");
for (const value of ["ABC-123", "CODE39", "0123456789", "A B.C/D+E$F%G"]) {
  const p = encodeCode39(value);
  const r = decodeCode39(p);
  expect(`Code39 "${value}"`, r.text ?? `ERR:${r.error}`, value);
}

console.log("\n=== EAN/UPC/ITF 解码回读 ===");
{
  const p = encodeEan13("690123456789");
  const r = decodeEan13(p);
  expect(`EAN13 "690123456789" → 自动补校验位`, r.text ?? `ERR:${r.error}`, "6901234567892");
}
{
  const p = encodeEan13("4006381333931");
  const r = decodeEan13(p);
  expect("EAN13 已知样本", r.text ?? `ERR:${r.error}`, "4006381333931");
}
{
  const p = encodeEan8("9638507");
  const r = decodeUpcLike(p, 4, 8);
  expect("EAN8 回读", r.text ?? `ERR:${r.error}`, "96385074");
}
{
  const p = encodeUpcA("03600029145");
  const r = decodeUpcLike(p, 6, 12);
  expect("UPC-A 回读", r.text ?? `ERR:${r.error}`, "036000291452");
}
{
  const p = encodeItf14("1234567890123");
  const r = decodeItf14(p);
  expect("ITF-14 回读", r.text ?? `ERR:${r.error}`, "12345678901231");
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
