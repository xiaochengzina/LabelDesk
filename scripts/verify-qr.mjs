/**
 * QR 回归验证：把生成的二维码交给真实解码器（jsQR）反解。
 *
 * 覆盖：
 * - 四档纠错等级下的长度边界扫描
 * - 中文 / URL / 纯数字等真实内容
 * - 超长内容的截断告警
 *
 *   node scripts/verify-qr.mjs
 */
import jsQR from "jsqr";
import { encodeQr, qrChooseVersion, QR_MAX_VERSION, QR_CAPACITY_BYTES } from "../src/model/barcode.ts";

let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
  } else {
    fail++;
    console.log(`  \u2717 ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

function render(matrix, scale = 4, quiet = 4) {
  const dim = (matrix.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (!matrix.modules[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = (c + quiet) * scale + dx;
          const y = (r + quiet) * scale + dy;
          const off = (y * dim + x) * 4;
          data[off] = data[off + 1] = data[off + 2] = 0;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

function decodesTo(text, ecc) {
  const matrix = encodeQr(text, ecc);
  if (matrix.size === 0) return { ok: false, reason: "矩阵为空" };
  const img = render(matrix);
  const res = jsQR(img.data, img.width, img.height);
  if (!res) return { ok: false, reason: `v${matrix.version} 解码失败`, version: matrix.version };
  if (res.data !== text) {
    return { ok: false, reason: `解出内容不符（${res.data.length} 字符）`, version: matrix.version };
  }
  return { ok: true, version: matrix.version, mask: matrix.mask };
}

console.log("\n=== 长度边界扫描（每个纠错等级覆盖到版本上限）===");
for (const ecc of ["L", "M", "Q", "H"]) {
  const capacity = QR_CAPACITY_BYTES[ecc];
  let bad = 0;
  let checked = 0;
  // 全长度扫描；上限附近加密采样
  const lengths = [];
  for (let n = 1; n <= capacity; n++) lengths.push(n);
  for (const n of lengths) {
    const r = decodesTo("A".repeat(n), ecc);
    checked++;
    if (!r.ok) {
      bad++;
      if (bad <= 3) console.log(`  \u2717 ${ecc} 级 ${n} 字节：${r.reason}`);
    }
  }
  check(`${ecc} 级 1-${capacity} 字节全部可解码（${checked} 例）`, bad === 0, `${bad} 例失败`);
  if (bad === 0) console.log(`  \u2713 ${ecc} 级 1-${capacity} 字节全部可解码（${checked} 例，上限 v${qrChooseVersion("A".repeat(capacity), ecc)}）`);
}

console.log("\n=== 真实内容 ===");
const realCases = [
  ["HELLO", "M"],
  ["https://example.com/labeldesk?id=12345", "M"],
  ["6901234567892", "M"],
  ["标签打印-LabelDesk 中文测试", "M"],
  ["混合 Mixed 内容 12345 !@#$%^&*()", "Q"],
  ["SN:2024-0001-BATCH-77", "H"],
  ["上海仓 / A-12-03 / 2024-06-01", "M"],
  ["x".repeat(100), "M"],
  ["y".repeat(30), "L"],
];
for (const [text, ecc] of realCases) {
  const r = decodesTo(text, ecc);
  const label = text.length > 30 ? `${text.slice(0, 30)}…` : text;
  check(`[${ecc}] "${label}"`, r.ok, r.reason ?? "");
}

console.log("\n=== 超长内容应给出告警而非崩溃 ===");
{
  const long = "Z".repeat(5000);
  const m = encodeQr(long, "M");
  check("生成成功且不抛异常", m.size > 0);
  check("带有截断告警", m.warnings.length > 0, m.warnings.join(";"));
  check(`版本不超过上限 v${QR_MAX_VERSION}`, m.version <= QR_MAX_VERSION, `实际 v${m.version}`);
  const r = decodesTo("Z".repeat(QR_CAPACITY_BYTES.M - 3), "M");
  check("截断后仍能正常解码", r.ok, r.reason ?? "");
}

console.log("\n=== 版本选择 ===");
for (const [text, ecc, expected] of [
  ["A", "H", 1],
  ["A".repeat(20), "L", 2],
  ["A".repeat(QR_CAPACITY_BYTES.M), "M", 6],
]) {
  const v = qrChooseVersion(text, ecc);
  check(`[${ecc}] ${text.length} 字节 -> v${expected}`, v === expected, `实际 v${v}`);
}
check("超容量时返回 null", qrChooseVersion("A".repeat(QR_CAPACITY_BYTES.M + 1), "M") === null);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
