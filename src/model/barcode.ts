/**
 * 条码/二维码生成内核（零依赖，纯函数）。
 *
 * 输出约定：所有一维码函数返回 `BarPattern` =
 *   { bars: boolean[]; widths: number[]; humanText: string; warnings: string[] }
 * - `bars[i]` 表示第 i 个元素是黑条（true）还是空白（false）
 * - `widths[i]` 为该元素占用的窄条单位数
 * 渲染层只需画「单位宽度 × widths[i]」即可精确成像，避免浮点误差累积。
 *
 * 正确性由两套真实解码验证保证：
 * - scripts/verify-1d.mjs：把生成的一维码反向解码回原值
 * - scripts/verify-qr.mjs：把生成的二维码交给真实解码器 jsQR 反解
 */

export interface BarPattern {
  /** 每个元素是否为黑条 */
  bars: boolean[];
  /** 每个元素的宽度（窄条单位） */
  widths: number[];
  /** 人类可读文本（一般显示在条码下方） */
  humanText: string;
  /** 生成过程中的告警（内容被替换、截断等） */
  warnings: string[];
}

function emptyPattern(): BarPattern {
  return { bars: [], widths: [], humanText: "", warnings: [] };
}

/** 由「模块字符串」构造图案：'1' = 黑，'0' = 白，每字符宽度 1。 */
function fromModules(modules: string, humanText: string): BarPattern {
  const bars: boolean[] = [];
  const widths: number[] = [];
  for (const ch of modules) {
    bars.push(ch === "1");
    widths.push(1);
  }
  return { bars, widths, humanText, warnings: [] };
}

/** 由「宽度序列」构造图案：数字为宽度，条空交替（从黑条开始）。 */
function patternFromWidths(widths: string, humanText: string, warnings: string[]): BarPattern {
  const bars: boolean[] = [];
  const outWidths: number[] = [];
  let isBar = true;
  for (const ch of widths) {
    const w = Number(ch);
    if (!Number.isFinite(w) || w <= 0) continue;
    bars.push(isBar);
    outWidths.push(w);
    isBar = !isBar;
  }
  return { bars, widths: outWidths, humanText, warnings };
}

// ---------------------------------------------------------------------------
// Code 128
// ---------------------------------------------------------------------------

/**
 * Code 128 标准图案表：索引 0..106。
 * 每个条目是 6 个元素的宽度（条空交替），索引 106（Stop）为 7 个元素。
 */
const CODE128_TABLE: string[] = [
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

type Code128Set = "A" | "B" | "C";
const START_B = 104;
const START_C = 105;

/**
 * 为内容挑选码集并生成码字序列（不含起始符/校验位/终止符）。
 *
 * - 全数字且长度为偶数 → 整串用 C 集（每两数字一个码字，密度最高）
 * - 全数字且长度为奇数（≥ 5）→ 首位用 B 集，随后切 C 集成对编码
 * - 一般内容 → 用 B 集；遇到长度 ≥ 6 的数字串时切 C 集，之后再切回 B 集
 */
function code128Optimize(data: string): { codes: number[]; set: Code128Set; warnings: string[] } | null {
  const warnings: string[] = [];
  const chars: number[] = [];
  for (const ch of data) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code <= 126) {
      chars.push(code - 32);
    } else if (ch === "\n" || ch === "\r") {
      chars.push(0);
      warnings.push("换行符在 Code 128 中按空格处理");
    } else {
      chars.push(31); // '?'
      warnings.push(`字符「${ch}」不在 Code 128 字符集内，已替换为「?」`);
    }
  }
  if (chars.length === 0) return null;

  const isAllDigits = /^[0-9]+$/.test(data);

  if (isAllDigits && data.length % 2 === 0) {
    const codes: number[] = [];
    for (let i = 0; i < data.length; i += 2) codes.push(Number(data.slice(i, i + 2)));
    return { codes, set: "C", warnings };
  }

  if (isAllDigits && data.length >= 5) {
    const codes: number[] = [chars[0], 99];
    for (let i = 1; i + 1 < data.length; i += 2) codes.push(Number(data.slice(i, i + 2)));
    return { codes, set: "B", warnings };
  }

  // 找出长度 ≥ 6 的连续数字段，交给 C 集处理
  const digitRuns: Array<[number, number]> = [];
  let i = 0;
  while (i < data.length) {
    if (/\d/.test(data[i])) {
      let j = i;
      while (j < data.length && /\d/.test(data[j])) j++;
      if (j - i >= 6) digitRuns.push([i, j]);
      i = j;
    } else {
      i++;
    }
  }

  if (digitRuns.length === 0) return { codes: chars, set: "B", warnings };

  const codes: number[] = [];
  let cursor = 0;
  for (const [start, end] of digitRuns) {
    for (let k = cursor; k < start; k++) codes.push(chars[k]);

    let k = start;
    // 奇数个数字时先用 B 集发掉首位，剩下的才能两两成对进 C 集
    if ((end - start) % 2 === 1) {
      codes.push(chars[k]);
      k++;
    }
    codes.push(99); // Code C
    for (; k < end; k += 2) codes.push(Number(data.slice(k, k + 2)));

    cursor = end;
    if (cursor < data.length) codes.push(100); // Code B
  }
  for (let k = cursor; k < chars.length; k++) codes.push(chars[k]);
  return { codes, set: "B", warnings };
}

export function encodeCode128(raw: string): BarPattern {
  const data = raw ?? "";
  if (!data) return { ...emptyPattern(), warnings: ["Code 128 内容为空"] };

  const optimized = code128Optimize(data);
  if (!optimized) return { ...emptyPattern(), warnings: ["Code 128 内容无法编码"] };
  const { codes, set, warnings } = optimized;

  const startCode = set === "C" ? START_C : START_B;
  let sum = startCode;
  codes.forEach((c, index) => {
    sum += c * (index + 1);
  });
  const checksum = sum % 103;

  const widths = [startCode, ...codes, checksum, 106].map((code) => CODE128_TABLE[code]).join("");
  return patternFromWidths(widths, data, warnings);
}

// ---------------------------------------------------------------------------
// Code 39
// ---------------------------------------------------------------------------

/**
 * Code 39 字符表。数据源是规范中每个字符的 12 模块二进制图案，
 * 由它推导「9 个元素中哪 3 个是宽的」——手工抄录宽元素极易出错，
 * 而抄错一位就会生成扫不出来的条码，因此这里由图案程序化推导。
 */
const CODE39_BINARY: Record<string, string> = {
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

/** 把 12 模块图案转成 9 个元素的宽度序列（宽 = 3，窄 = 1）。 */
function code39WidthsFromBinary(binary: string): string {
  const widths: string[] = [];
  let i = 0;
  while (i < binary.length) {
    const bit = binary[i];
    let run = 1;
    while (i + run < binary.length && binary[i + run] === bit) run++;
    widths.push(String(run));
    i += run;
  }
  if (widths.length !== 9) {
    throw new Error(`Code 39 图案元素数应为 9，实际 ${widths.length}：${binary}`);
  }
  return widths.join("");
}

const CODE39_WIDTHS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [ch, binary] of Object.entries(CODE39_BINARY)) out[ch] = code39WidthsFromBinary(binary);
  return out;
})();

const CODE39_START_STOP = CODE39_WIDTHS["*"];

/** Code 39 字符顺序，决定可选校验位的数值 */
const CODE39_ORDER = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%";

export function encodeCode39(raw: string, includeChecksum = false): BarPattern {
  const warnings: string[] = [];
  const source = (raw ?? "").toUpperCase();
  if (!source) return { ...emptyPattern(), warnings: ["Code 39 内容为空"] };

  const cleaned = source
    .split("")
    .map((ch) => {
      if (CODE39_WIDTHS[ch]) return ch;
      warnings.push(`字符「${ch}」不在 Code 39 字符集内，已忽略`);
      return "";
    })
    .join("");

  if (!cleaned) return { ...emptyPattern(), warnings: ["Code 39 内容不含可编码字符"] };

  let payload = cleaned;
  if (includeChecksum) {
    const sum = cleaned.split("").reduce((acc, ch) => acc + CODE39_ORDER.indexOf(ch), 0);
    payload += CODE39_ORDER[sum % 43];
  }

  const parts: string[] = [CODE39_START_STOP];
  for (const ch of payload) {
    parts.push("1"); // 字符间隔：一个窄空白
    parts.push(CODE39_WIDTHS[ch]);
  }
  parts.push("1");
  parts.push(CODE39_START_STOP);

  return patternFromWidths(parts.join(""), raw, warnings);
}

// ---------------------------------------------------------------------------
// EAN-13 / EAN-8 / UPC-A / ITF-14
// ---------------------------------------------------------------------------

const EAN_L: Record<string, string> = {
  "0": "0001101", "1": "0011001", "2": "0010011", "3": "0111101", "4": "0100011",
  "5": "0110001", "6": "0101111", "7": "0111011", "8": "0110111", "9": "0001011",
};
const EAN_G: Record<string, string> = {
  "0": "0100111", "1": "0110011", "2": "0011011", "3": "0100001", "4": "0011101",
  "5": "0111001", "6": "0000101", "7": "0010001", "8": "0001001", "9": "0010111",
};
const EAN_R: Record<string, string> = {
  "0": "1110010", "1": "1100110", "2": "1101100", "3": "1000010", "4": "1011100",
  "5": "1001110", "6": "1010000", "7": "1000100", "8": "1001000", "9": "1110100",
};
/** EAN-13 首位数字决定左侧 6 位的 L/G（奇/偶）组合 */
const EAN13_PARITY: Record<string, string> = {
  "0": "LLLLLL", "1": "LLGLGG", "2": "LLGGLG", "3": "LLGGGL", "4": "LGLLGG",
  "5": "LGGLLG", "6": "LGGGLL", "7": "LGLGLG", "8": "LGLGGL", "9": "LGGLGL",
};

/** 通用模 10 校验位（从右往左，奇数位权重 3） */
function eanChecksum(digits: string): number {
  let sum = 0;
  const reversed = digits.split("").reverse();
  reversed.forEach((d, index) => {
    sum += Number(d) * (index % 2 === 0 ? 3 : 1);
  });
  return (10 - (sum % 10)) % 10;
}

function digitsOnly(input: string): string {
  return (input ?? "").replace(/\D/g, "");
}

export function encodeEan13(raw: string): BarPattern {
  const warnings: string[] = [];
  let digits = digitsOnly(raw);
  if (digits.length === 12) {
    digits += String(eanChecksum(digits));
    warnings.push(`已自动补全校验位：${digits[12]}`);
  } else if (digits.length === 13) {
    const expected = eanChecksum(digits.slice(0, 12));
    if (Number(digits[12]) !== expected) {
      warnings.push(`校验位与内容不符（应为 ${expected}），已按内容原样打印`);
    }
  } else {
    return { ...emptyPattern(), warnings: [`EAN-13 需要 12 或 13 位数字，当前 ${digits.length} 位`] };
  }

  const parity = EAN13_PARITY[digits[0]] ?? "LLLLLL";
  let modules = "101";
  for (let i = 0; i < 6; i++) {
    const d = digits[i + 1];
    modules += parity[i] === "L" ? EAN_L[d] : EAN_G[d];
  }
  modules += "01010";
  for (let i = 7; i < 13; i++) modules += EAN_R[digits[i]];
  modules += "101";

  const pattern = fromModules(modules, digits);
  pattern.warnings = warnings;
  return pattern;
}

export function encodeEan8(raw: string): BarPattern {
  const warnings: string[] = [];
  let digits = digitsOnly(raw);
  if (digits.length === 7) {
    digits += String(eanChecksum(digits));
    warnings.push(`已自动补全校验位：${digits[7]}`);
  } else if (digits.length !== 8) {
    return { ...emptyPattern(), warnings: [`EAN-8 需要 7 或 8 位数字，当前 ${digits.length} 位`] };
  }

  let modules = "101";
  for (let i = 0; i < 4; i++) modules += EAN_L[digits[i]];
  modules += "01010";
  for (let i = 4; i < 8; i++) modules += EAN_R[digits[i]];
  modules += "101";

  const pattern = fromModules(modules, digits);
  pattern.warnings = warnings;
  return pattern;
}

export function encodeUpcA(raw: string): BarPattern {
  const warnings: string[] = [];
  let digits = digitsOnly(raw);
  if (digits.length === 11) {
    digits += String(eanChecksum(digits));
    warnings.push(`已自动补全校验位：${digits[11]}`);
  } else if (digits.length !== 12) {
    return { ...emptyPattern(), warnings: [`UPC-A 需要 11 或 12 位数字，当前 ${digits.length} 位`] };
  }

  let modules = "101";
  for (let i = 0; i < 6; i++) modules += EAN_L[digits[i]];
  modules += "01010";
  for (let i = 6; i < 12; i++) modules += EAN_R[digits[i]];
  modules += "101";

  const pattern = fromModules(modules, digits);
  pattern.warnings = warnings;
  return pattern;
}

/** ITF（交叉二五码）数字图案：5 个元素，1 = 宽 */
const ITF_PATTERNS: string[] = [
  "00110", "10001", "01001", "11000", "00101", "10100", "01100", "00011", "10010", "01010",
];

export function encodeItf14(raw: string): BarPattern {
  const warnings: string[] = [];
  let digits = digitsOnly(raw);
  if (digits.length === 13) {
    digits += String(eanChecksum(digits));
    warnings.push(`已自动补全校验位：${digits[13]}`);
  } else if (digits.length !== 14) {
    return { ...emptyPattern(), warnings: [`ITF-14 需要 13 或 14 位数字，当前 ${digits.length} 位`] };
  }
  if (digits.length % 2 !== 0) digits = "0" + digits;

  // 起始符：窄窄窄窄（条空条空）
  let widths = "1111";
  for (let i = 0; i < digits.length; i += 2) {
    const a = ITF_PATTERNS[Number(digits[i])];
    const b = ITF_PATTERNS[Number(digits[i + 1])];
    for (let k = 0; k < 5; k++) {
      widths += a[k] === "1" ? "3" : "1"; // 条
      widths += b[k] === "1" ? "3" : "1"; // 空
    }
  }
  widths += "311"; // 终止符：宽条窄空窄条

  return patternFromWidths(widths, digits, warnings);
}

// ---------------------------------------------------------------------------
// QR Code（字节模式，纠错等级 L/M/Q/H）
// ---------------------------------------------------------------------------

/**
 * 各纠错等级下经过真机解码验证的版本上限。
 *
 * 版本 1-2：四个等级全部通过 jsQR 全长度扫描。
 * 版本 3-6：M/Q/H 通过；L 级在版本 3 起存在数据区错误（功能图案、版本信息、
 *   码字流、RS 纠错均已用独立参考实现逐字节核对一致，问题定位在矩阵位放置），
 *   在修复前把 L 级收敛到版本 2。
 *
 * 宁可缩小容量并给出明确告警，也不输出扫不出来的二维码。
 */
const QR_MAX_VERSION_BY_LEVEL: Record<string, number> = { L: 2, M: 6, Q: 6, H: 6 };

/** 兼容旧调用：整体上限取最大值 */
export const QR_MAX_VERSION = 6;

/** 各等级在当前版本上限下的最大内容字节数 */
export const QR_CAPACITY_BYTES: Record<string, number> = { L: 32, M: 106, Q: 74, H: 58 };

/** 每个纠错块的纠错码字数，索引 = 版本 - 1（ISO/IEC 18004 表 13-22） */
const QR_ECC_CODEWORDS_PER_BLOCK: Record<string, number[]> = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};

/** 纠错块数量，索引 = 版本 - 1 */
const QR_NUM_BLOCKS: Record<string, number[]> = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};

/** 校正图案中心坐标（ISO/IEC 18004 附录 E） */
function qrAlignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  if (count === 2) return [6, size - 7];
  const step = Math.ceil((size - 13) / (count - 1) / 2) * 2;
  const positions = [6];
  for (let i = count - 1; i >= 1; i--) {
    positions.splice(1, 0, size - 7 - (count - 1 - i) * step);
  }
  return positions;
}

/** 版本总码字数（不含 remainder bits） */
function qrTotalCodewords(version: number): number {
  const size = version * 4 + 17;
  let total = size * size;
  total -= 3 * 64; // 三个定位图案 + 分隔符
  const positions = qrAlignmentPositions(version);
  if (positions.length > 0) {
    const n = positions.length;
    total -= (n * n - 3) * 25; // n×n 个校正图案，去掉与定位图案重叠的 3 个
  }
  total -= 31; // 格式信息两个副本 + 固定黑模块
  if (version >= 7) total -= 36; // 版本信息两个副本
  total -= (size - 16) * 2; // 时序图案
  return Math.floor(total / 8);
}

// GF(256)，本原多项式 0x11D
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Reed-Solomon 生成多项式（首项系数恒为 1） */
function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/**
 * 计算纠错码字。
 *
 * 注意：这里用的是「余数寄存器留在开头」的实现，而不是教科书式的
 * `remainder 追加在数据尾部`。两者在余数宽度恰好等于纠错位数时等价，
 * 但实现细节不同会导致结果不同——本函数已用 ISO/IEC 18004 附录 I 的
 * 标准测试向量（16 字节数据 → 10 字节纠错 `a5 24 d4 c1 ed 36 c7 87 2c 55`）验证。
 */
function rsEncode(data: number[], eccCount: number): number[] {
  const gen = rsGeneratorPoly(eccCount);
  const result = new Array(eccCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.shift();
    result.push(0);
    if (factor !== 0) {
      for (let i = 0; i < eccCount; i++) {
        result[i] ^= gfMul(gen[i + 1], factor);
      }
    }
  }
  return result;
}

function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

/** 字节模式的字符计数位宽：版本 1-9 为 8 位，10-26 为 16 位 */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function qrDataCapacityCodewords(version: number, ecc: string): number {
  const total = qrTotalCodewords(version);
  const eccPerBlock = QR_ECC_CODEWORDS_PER_BLOCK[ecc][version - 1];
  const blocks = QR_NUM_BLOCKS[ecc][version - 1];
  return total - eccPerBlock * blocks;
}

/** 选择能容纳内容的最小版本（不超过该等级的上限）；内容过长时返回 null */
export function qrChooseVersion(text: string, ecc: string): number | null {
  const bytes = utf8Bytes(text);
  const maxVersion = QR_MAX_VERSION_BY_LEVEL[ecc] ?? 6;
  for (let version = 1; version <= maxVersion; version++) {
    const capacityBits = qrDataCapacityCodewords(version, ecc) * 8;
    if (4 + charCountBits(version) + bytes.length * 8 <= capacityBits) return version;
  }
  return null;
}

export interface QrMatrix {
  size: number;
  /** true = 黑模块 */
  modules: boolean[][];
  version: number;
  ecc: string;
  /** 实际使用的掩码编号 0-7 */
  mask: number;
  warnings: string[];
}

/**
 * 生成 QR 矩阵。
 * @param ecc 纠错等级 L/M/Q/H
 * @param options.forceMask 固定掩码（仅供测试比对；正常渲染不要传）
 */
export function encodeQr(text: string, ecc: string = "M", options?: { forceMask?: number }): QrMatrix {
  const warnings: string[] = [];
  const level = ["L", "M", "Q", "H"].includes(ecc) ? ecc : "M";
  const content = text ?? "";
  if (!content) {
    return { size: 0, modules: [], version: 0, ecc: level, mask: 0, warnings: ["二维码内容为空"] };
  }

  let version = qrChooseVersion(content, level);
  let bytes = utf8Bytes(content);
  if (version === null) {
    // 超出该等级支持范围：截断到上限容量并给出可操作提示，
    // 既不静默生成扫不出来的二维码，也不让渲染直接失败。
    const maxVersion = QR_MAX_VERSION_BY_LEVEL[level] ?? 6;
    version = maxVersion;
    const maxBytes = Math.max(1, qrDataCapacityCodewords(version, level) - 3);
    bytes = bytes.slice(0, maxBytes);
    warnings.push(
      `内容过长（${utf8Bytes(content).length} 字节），已截断到 ${bytes.length} 字节。` +
        `${level} 级最多支持 ${QR_CAPACITY_BYTES[level] ?? maxBytes} 字节，请缩短内容或把纠错等级调低为 L。`,
    );
  }

  // 1) 数据位流：模式指示符 + 字符计数 + 内容 + 终止符 + 补齐
  const bits: number[] = [];
  const pushBits = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  pushBits(0b0100, 4); // 字节模式
  pushBits(bytes.length, charCountBits(version));
  for (const b of bytes) pushBits(b, 8);

  const totalDataCodewords = qrDataCapacityCodewords(version, level);
  const capacityBits = totalDataCodewords * 8;
  pushBits(0, Math.min(4, capacityBits - bits.length)); // 终止符
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCodewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let k = 0; k < 8; k++) byte = (byte << 1) | bits[i + k];
    dataCodewords.push(byte);
  }
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (dataCodewords.length < totalDataCodewords) {
    dataCodewords.push(padBytes[padIndex % 2]);
    padIndex++;
  }

  // 2) 分块 + RS 纠错 + 交织
  //
  // 分块公式：长块数量由「每块平均总码字数」对块数取余决定，而不是总码字数对块数取余。
  // 两者在块数不能整除每块码字数时结果不同，用错会导致多块版本（版本 3 以上）整体错位。
  const eccPerBlock = QR_ECC_CODEWORDS_PER_BLOCK[level][version - 1];
  const numBlocks = QR_NUM_BLOCKS[level][version - 1];
  const totalCodewords = qrTotalCodewords(version);
  const dataCodewordsTotal = totalCodewords - eccPerBlock * numBlocks;
  const shortBlockLen = Math.floor(totalCodewords / numBlocks) - eccPerBlock;
  const numLongBlocks = dataCodewordsTotal % numBlocks;
  const numShortBlocks = numBlocks - numLongBlocks;

  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = shortBlockLen + (i >= numShortBlocks ? 1 : 0);
    const block = dataCodewords.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    eccBlocks.push(rsEncode(block, eccPerBlock));
  }
  if (offset !== dataCodewords.length) {
    warnings.push(`二维码分块异常：已使用 ${offset} 个码字，实际有 ${dataCodewords.length} 个`);
  }

  // 交织：先按列取各数据块，再按列取各纠错块
  const interleaved: number[] = [];
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) if (i < block.length) interleaved.push(block[i]);
  }
  for (let i = 0; i < eccPerBlock; i++) {
    for (const block of eccBlocks) if (i < block.length) interleaved.push(block[i]);
  }

  // 3) 构建矩阵
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const setModule = (r: number, c: number, dark: boolean) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = dark;
    reserved[r][c] = true;
  };

  const placeFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inArea = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const inRing = inArea && (r === 0 || r === 6 || c === 0 || c === 6);
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setModule(rr, cc, inArea && (inRing || inCore));
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  const alignPositions = qrAlignmentPositions(version);
  for (const r of alignPositions) {
    for (const c of alignPositions) {
      const nearFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setModule(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    setModule(6, i, i % 2 === 0);
    setModule(i, 6, i % 2 === 0);
  }
  setModule(size - 8, 8, true); // 固定黑模块

  // 预留格式信息位置（值稍后按掩码写入）
  for (let i = 0; i <= 8; i++) {
    if (!reserved[8][i]) setModule(8, i, false);
    if (!reserved[i][8]) setModule(i, 8, false);
  }
  for (let i = 0; i <= 7; i++) {
    if (!reserved[8][size - 1 - i]) setModule(8, size - 1 - i, false);
    if (!reserved[size - 1 - i][8]) setModule(size - 1 - i, 8, false);
  }
  if (version >= 7) {
    const versionInfo = qrVersionInfo(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((versionInfo >> i) & 1) === 1;
      const r = Math.floor(i / 3);
      const c = i % 3;
      setModule(size - 11 + c, r, bit);
      setModule(r, size - 11 + c, bit);
    }
  }

  // 4) 放置数据（右下角起，两列一组上下往返）
  const dataBits: number[] = [];
  for (const byte of interleaved) {
    for (let i = 7; i >= 0; i--) dataBits.push((byte >> i) & 1);
  }

  let bitIndex = 0;
  let upward = true;
  for (let pair = size - 1; pair > 0; pair -= 2) {
    // 第 6 列是纵向时序图案：整对左移，而不是只改当前列（否则会重复处理第 5 列）
    const rightCol = pair === 6 ? 5 : pair;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [rightCol, rightCol - 1]) {
        if (c < 0 || reserved[row][c]) continue;
        modules[row][c] = bitIndex < dataBits.length ? dataBits[bitIndex] === 1 : false;
        bitIndex++;
      }
    }
    upward = !upward;
  }

  // 5) 掩码：按标准罚分选最优
  const maskFns: Array<(r: number, c: number) => boolean> = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestMatrix: boolean[][] | null = null;
  const maskList = options?.forceMask !== undefined ? [options.forceMask & 7] : [0, 1, 2, 3, 4, 5, 6, 7];

  for (const mask of maskList) {
    const candidate = modules.map((row) => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (reserved[r][c]) continue;
        if (maskFns[mask](r, c)) candidate[r][c] = !candidate[r][c];
      }
    }
    applyFormatInfo(candidate, size, level, mask);
    const score = qrPenalty(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestMatrix = candidate;
    }
  }

  if (!bestMatrix) {
    bestMatrix = modules.map((row) => row.slice());
    applyFormatInfo(bestMatrix, size, level, 0);
  }

  return { size, modules: bestMatrix, version, ecc: level, mask: bestMask, warnings };
}

/**
 * 写入 15 位格式信息（纠错等级 + 掩码）。
 * 两个副本必须互为镜像：格式串最高位落在 (8,0)，最低位落在 (size-1,8)。
 */
function applyFormatInfo(matrix: boolean[][], size: number, ecc: string, mask: number) {
  const eccBits: Record<string, number> = { L: 1, M: 0, Q: 3, H: 2 };
  const data = (eccBits[ecc] << 3) | mask;
  let value = data << 10;
  for (let i = 14; i >= 10; i--) {
    if (((value >> i) & 1) === 1) value ^= 0x537 << (i - 10);
  }
  const format = ((data << 10) | value) ^ 0x5412;
  const bit = (i: number) => ((format >> (14 - i)) & 1) === 1;

  for (let i = 0; i <= 5; i++) matrix[8][i] = bit(i);
  matrix[8][7] = bit(6);
  matrix[8][8] = bit(7);
  matrix[7][8] = bit(8);
  for (let i = 9; i <= 14; i++) matrix[14 - i][8] = bit(i);

  for (let i = 0; i <= 7; i++) matrix[size - 1 - i][8] = bit(i);
  for (let i = 8; i <= 14; i++) matrix[8][size - 15 + i] = bit(i);
  matrix[size - 8][8] = true;
}

/**
 * 版本信息（版本 ≥ 7）：6 位版本号 + 12 位 BCH(18,6) 校验位。
 * 已逐条核对 ISO/IEC 18004 表 D.1。
 */
function qrVersionInfo(version: number): number {
  let value = version << 12;
  for (let i = 17; i >= 12; i--) {
    if (((value >> i) & 1) === 1) value ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | (value & 0xfff);
}

/**
 * 四项罚分（N1=3、N2=3、N3=40、N4=10），用于挑选掩码。
 * 口径与主流实现一致，避免选出「结构合法但扫码器难识别」的图案。
 */
function qrPenalty(matrix: boolean[][], size: number): number {
  let score = 0;

  // N1：行/列连续同色 ≥ 5
  const linePenalty = (line: boolean[]) => {
    let points = 0;
    let run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) points += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) points += 3 + (run - 5);
    return points;
  };
  for (let r = 0; r < size; r++) {
    score += linePenalty(matrix[r]);
    const col: boolean[] = [];
    for (let c = 0; c < size; c++) col.push(matrix[c][r]);
    score += linePenalty(col);
  }

  // N2：2×2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const a = matrix[r][c];
      if (a === matrix[r][c + 1] && a === matrix[r + 1][c] && a === matrix[r + 1][c + 1]) score += 3;
    }
  }

  // N3：1:1:3:1:1 类定位图案，11 位窗口（0x5D0 / 0x05D）
  for (let r = 0; r < size; r++) {
    let bitsRow = 0;
    let bitsCol = 0;
    for (let c = 0; c < size; c++) {
      bitsRow = ((bitsRow << 1) & 0x7ff) | (matrix[r][c] ? 1 : 0);
      if (c >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) score += 40;
      bitsCol = ((bitsCol << 1) & 0x7ff) | (matrix[c][r] ? 1 : 0);
      if (c >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) score += 40;
    }
  }

  // N4：黑模块比例偏离 50%
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (matrix[r][c]) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.abs(Math.ceil(ratio / 5) - 10) * 10;

  return score;
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

export type BarcodeKind = "code128" | "code39" | "ean13" | "ean8" | "upca" | "itf14";

export function encodeBarcode(
  kind: BarcodeKind,
  value: string,
  options?: { code39Checksum?: boolean },
): BarPattern {
  switch (kind) {
    case "code128":
      return encodeCode128(value);
    case "code39":
      return encodeCode39(value, options?.code39Checksum ?? false);
    case "ean13":
      return encodeEan13(value);
    case "ean8":
      return encodeEan8(value);
    case "upca":
      return encodeUpcA(value);
    case "itf14":
      return encodeItf14(value);
    default:
      return { ...emptyPattern(), warnings: [`未知的一维码格式：${kind}`] };
  }
}

/** 一维码需要的静区宽度（窄条单位数）。静区不足会导致扫码枪读不出。 */
export function quietZoneUnits(kind: BarcodeKind): number {
  switch (kind) {
    case "ean13":
    case "ean8":
    case "upca":
      return 11;
    case "itf14":
      return 10;
    default:
      return 10;
  }
}
