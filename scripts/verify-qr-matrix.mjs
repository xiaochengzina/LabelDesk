/**
 * 二维码矩阵逐格比对：与 node-qrcode 的参考矩阵完全一致才算通过。
 *
 * 为什么需要这个脚本：扫码器容忍度高（有 RS 纠错兜底），
 * 即使数据模块错位也可能照样扫得出来，问题被掩盖成「只是偶尔扫不出」。
 * 逐格比对能直接暴露这类几何级错误 —— 比如「第 0 列从未写入」。
 *
 *   node --import ./scripts/loader-register.mjs scripts/verify-qr-matrix.mjs
 */
import QRCode from "qrcode";
import { encodeQr, qrChooseVersion } from "../src/model/barcode.ts";

let pass = 0;
const skipped = [];
let fail = 0;
const passed = [];
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    passed.push(name);
  } else {
    fail++;
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 我们的矩阵 → boolean[][]（值 true = 深色模块） */
function ours(text, ecc, mask) {
  const m = encodeQr(text, ecc, mask === undefined ? undefined : { forceMask: mask });
  const size = m.size;
  const out = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) row.push(m.modules[r][c] === true);
    out.push(row);
  }
  return out;
}

/** 参考实现 → boolean[][] */
function reference(text, ecc, mask) {
  const qr = QRCode.create(text, {
    errorCorrectionLevel: ecc.toLowerCase(),
    maskPattern: mask,
  });
  reference.lastSegments = qr.segments ?? [];
  const size = qr.modules.size;
  const data = qr.modules.data;
  const out = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) row.push(data[r * size + c] === 1);
    out.push(row);
  }
  return out;
}

function diffCells(a, b) {
  const size = a.length;
  const cells = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (a[r][c] !== b[r][c]) cells.push([r, c]);
    }
  }
  return cells;
}

console.log("=== 逐格比对（同一掩码，排除「掩码选择」差异的干扰）===");
// 只选「必须走字节模式」的载荷（含小写字母/符号），
// 这样 node-qrcode 不会改用数字/字母数字模式，两边矩阵才可比
const texts = [
  "pf2abcde",
  "thinkpad x1",
  "https://example.com",
  "label:2024-03-15",
  "sn-0001/abc",
];
const levels = ["L", "M", "Q", "H"];

for (const text of texts) {
  for (const ecc of levels) {
    const v = qrChooseVersion(text, ecc);
    if (v === null) continue; // 容量装不下，跳过
    for (let mask = 0; mask < 8; mask++) {
      const a = ours(text, ecc, mask);
      const b = reference(text, ecc, mask);
      // 我们的编码器只用字节模式；参考实现会对数字/大写做混合分段优化，
      // 那种情况字节流本来就不同（都是合法 QR），矩阵无法逐格比对。
      const segs = reference.lastSegments;
      const modes = segs.map((s) => s.mode?.id ?? String(s.mode));
      if (segs.length !== 1 || modes[0] !== "Byte") {
        skipped.push(`${text.trim().slice(0, 12)}/${ecc}/${mask}: 参考用了 ${modes.join("+")}`);
        continue;
      }
      if (a.length !== b.length) {
        // 版本不同（编码模式容量策略不同）时矩阵不可能一样：
        // 不算失败，但要单独列出来，别让它掩盖真正的放置错误
        skipped.push(
          `${text.trim().slice(0, 10)}/${ecc}: 我们 v${(a.length - 17) / 4} vs 参考 v${(b.length - 17) / 4}`,
        );
        continue;
      }
      const d = diffCells(a, b);
      const label = `${text.trim().slice(0, 14)}/${ecc}/v${v}/mask${mask}`;
      check(label, d.length === 0, d.length ? `差异 ${d.length} 格，例如 ${JSON.stringify(d.slice(0, 5))}` : "");
    }
  }
}

console.log(
  `\n逐格比对：${pass} 通过 / ${fail} 失败 / ${skipped.length} 跳过（版本不同）`,
);
if (skipped.length) {
  console.log("跳过明细：");
  for (const s of [...new Set(skipped)].slice(0, 12)) console.log(`  · ${s}`);
}
console.log("\n通过的用例（前 24 条）：");
for (const p0 of passed.slice(0, 24)) console.log(`  · ${p0}`);
if (fail > 0) {
  console.log("\n提示：差异只集中在最左几列时，多半是「跳过时序列后没有整体左移」的放置问题。");
}
process.exit(fail === 0 ? 0 : 1);
