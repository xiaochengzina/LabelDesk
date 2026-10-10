/**
 * 用真实解析器与渲染器过一遍测试数据，确认：
 * 1) 每条基础行都能填满 6 个字段
 * 2) 带序号列时告警合理
 * 3) 边界情况的表现符合预期（尤其条码字符集与超长型号）
 *
 *   node --import ./scripts/loader-register.mjs scripts/verify-testdata.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { existsSync, readdirSync } from "node:fs";

if (process.platform === "win32") {
  for (const f of ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/consola.ttf"]) {
    if (existsSync(f)) {
      try {
        GlobalFonts.registerFromPath(f);
      } catch {
        /* 忽略 */
      }
    }
  }
}
globalThis.document = { createElement: () => createCanvas(1, 1) };

const { buildFill } = await import("../src/model/fill.ts");
const { renderLayout } = await import("../src/renderer/renderer.ts");
const { mmToPx } = await import("../src/model/units.ts");

const appData = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? ".", "AppData", "Roaming");
const layoutsDir = path.join(appData, "com.labeldesk.app", "layouts");
const files = readdirSync(layoutsDir).filter((f) => f.endsWith(".ldl.json"));
if (files.length === 0) {
  console.error("没有模板，请先运行 npm run sample:template");
  process.exit(1);
}
const layout = JSON.parse(readFileSync(path.join(layoutsDir, files[0]), "utf8"));

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  \u2717 ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const readRows = (file) =>
  readFileSync(path.join("testdata", file), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

console.log(`模板：${layout.name}，字段数 ${layout.fields.length}\n`);

// ---- 基础 20 行
const basic = readRows("测试数据-基础20行.txt");
console.log(`=== 基础行（${basic.length} 条）===`);
let allFilled = 0;
for (const row of basic) {
  const fill = buildFill(layout, row);
  const filled = fill.values.filter((v) => v.value !== "").length;
  const noWarn = fill.warnings.length === 0;
  if (filled === 6 && noWarn && fill.ok) allFilled++;
  else console.log(`  \u2717 「${row.split("\t")[0]}」filled=${filled} warnings=${fill.warnings.join("; ")}`);
}
check(`全部 ${basic.length} 条都填满 6 个字段且无告警`, allFilled === basic.length, `仅 ${allFilled} 条正常`);
console.log(`  通过 ${allFilled}/${basic.length}`);

// ---- 带序号列
console.log("\n=== 序号列 ===");
{
  // a) 序号在末尾：应提示多出一列，前 6 列映射不变
  const rows = readRows("测试数据-序号列在末尾.txt");
  const fill = buildFill(layout, rows[0]);
  check("序号在末尾时给出「多出的」告警", fill.warnings.some((w) => w.includes("多出的")), fill.warnings.join("; "));
  check("序号在末尾：型号映射正确", fill.variables["型号"] === "ThinkPad X1 Carbon Gen 9", fill.variables["型号"]);
  check("序号在末尾：SN 映射正确", fill.variables["SN"] === "PF2ABCDE", fill.variables["SN"]);
}
{
  // b) 序号在开头：默认映射会整体错位（这是设计上的必然，程序用告警提示）
  const rows = readRows("测试数据-序号列在开头.txt");
  const fill = buildFill(layout, rows[0]);
  check(
    "序号在开头且未标记忽略时，告警提示去配「忽略」",
    fill.warnings.some((w) => w.includes("忽略")),
    fill.warnings.join("; "),
  );

  // c) 管理员把第 1 列标记为忽略后，映射应完全正确
  const withSkip = {
    ...layout,
    fields: [
      { column: 0, label: "序号", variable: "", sample: "", skip: true },
      ...layout.fields.map((f, i) => ({ ...f, column: i + 1 })),
    ],
  };
  const fixed = buildFill(withSkip, rows[0]);
  check("标记忽略后不再有告警", fixed.warnings.length === 0, fixed.warnings.join("; "));
  check("标记忽略后型号正确", fixed.variables["型号"] === "ThinkPad X1 Carbon Gen 9", fixed.variables["型号"]);
  check("标记忽略后 SN 正确", fixed.variables["SN"] === "PF2ABCDE", fixed.variables["SN"]);
  check("序号列不产生变量", !Object.values(fixed.variables).includes("1"), JSON.stringify(fixed.variables));
  check("被忽略的列不参与「空列」告警", !fixed.warnings.some((w) => w.includes("序号")));
}

// ---- 边界情况逐条验证
console.log("\n=== 边界情况 ===");
const edgeRaw = readFileSync(path.join("testdata", "测试数据-边界情况.txt"), "utf8");
const edgeBlocks = edgeRaw
  .split(/\r?\n\r?\n/)
  .map((b) => b.trim())
  .filter((b) => b.startsWith("#"))
  .map((b) => {
    const lines = b.split(/\r?\n/);
    return { note: lines[0].replace(/^#\s*/, ""), row: lines.slice(1).join("\n") };
  });

const expectations = [
  { match: "只有 4 列", warn: "只有 4 列", filled: 4 },
  { match: "第 2、4 列为空", warn: "这些列是空的", filled: 4 },
  { match: "型号超长", warn: null, filled: 6 },
  { match: "千分位", warn: null, filled: 6 },
  { match: "含逗号", warn: null, filled: 6 },
  { match: "空格与短横线", warn: null, filled: 6 },
  { match: "中文型号", warn: null, filled: 6 },
];

for (const block of edgeBlocks) {
  const expect = expectations.find((e) => block.note.includes(e.match));
  const fill = buildFill(layout, block.row);
  if (!fill) {
    check(`${block.note} → 能解析`, false, "返回 null");
    continue;
  }
  const filled = fill.values.filter((v) => v.value !== "").length;
  const warnOk = expect?.warn ? fill.warnings.some((w) => w.includes(expect.warn)) : fill.warnings.length === 0;
  check(
    `${block.note.slice(0, 24)} → ${expect?.warn ? "有对应告警" : "无告警"}且填入 ${expect?.filled} 项`,
    warnOk && filled === expect?.filled,
    `filled=${filled}${fill.warnings.length ? ` warnings=${fill.warnings.join("; ")}` : ""}`,
  );
}

// ---- 逐条渲染，确认没有渲染异常（尤其条码内容含空格/短横线）
console.log("\n=== 渲染检查 ===");
mkdirSync("docs/testdata", { recursive: true });
const dpi = layout.printer?.dpi ?? 203;
const widthPx = Math.round(mmToPx(layout.settings.widthMm, dpi));
const heightPx = Math.round(mmToPx(layout.settings.heightMm, dpi));
let rendered = 0;
for (const block of [...basic.map((r) => ({ note: r.split("\t")[0], row: r })), ...edgeBlocks]) {
  const fill = buildFill(layout, block.row);
  if (!fill) continue;
  try {
    const canvas = createCanvas(widthPx, heightPx);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, widthPx, heightPx);
    renderLayout(ctx, layout, {
      dpi,
      variables: { ...layout.variables, ...fill.variables },
      background: "#ffffff",
    });
    const data = ctx.getImageData(0, 0, widthPx, heightPx).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark++;
    const ratio = dark / (widthPx * heightPx);
    check(`渲染「${block.note.slice(0, 20)}」墨点比例正常`, ratio > 0.02 && ratio < 0.6, `${(ratio * 100).toFixed(2)}%`);
    // 长型号与含空格序列号各存一张，便于人工看
    if (block.note.includes("超长") || block.note.includes("短横线") || block.note.includes("千分位")) {
      const safe = block.note.replace(/[\\/:*?"<>|\s]/g, "_").slice(0, 24);
      writeFileSync(path.join("docs/testdata", `${safe}.png`), canvas.toBuffer("image/png"));
    }
    rendered++;
  } catch (e) {
    check(`渲染「${block.note.slice(0, 20)}」`, false, e instanceof Error ? e.message : String(e));
  }
}
console.log(`  已渲染 ${rendered} 张，重点样本存于 docs/testdata/`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
