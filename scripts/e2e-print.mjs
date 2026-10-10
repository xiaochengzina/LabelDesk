/**
 * 端到端验证：用真实的 TypeScript 渲染器与条码内核生成一张标签，
 * 渲染成位图 → 用 Rust 侧同一套算法打包成 TSPL → 真机打印。
 *
 * 这一步覆盖了从「模板 JSON」到「打印队列」的完整链路，
 * 是比单元测试更接近真实使用的验证。
 *
 *   node scripts/e2e-print.mjs                 # 只生成预览，不打印
 *   node scripts/e2e-print.mjs --print         # 真机打印（会出纸）
 */
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

// 让 @napi-rs/canvas 能用到系统中文字体
if (process.platform === "win32") {
  for (const f of [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/simsun.ttc",
    "C:/Windows/Fonts/consola.ttf",
  ]) {
    if (existsSync(f)) {
      try {
        GlobalFonts.registerFromPath(f, path.basename(f, path.extname(f)));
      } catch {
        /* 字体注册失败不影响验证 */
      }
    }
  }
}

// 用全局 canvas 工厂替换浏览器 API，使 renderer/elements 可直接在 Node 中运行
globalThis.document = {
  createElement(tag) {
    if (tag !== "canvas") throw new Error(`Node 环境不支持创建 <${tag}>`);
    const canvas = createCanvas(1, 1);
    // 渲染器会写 canvas.width/height，@napi-rs/canvas 支持直接赋值
    return canvas;
  },
};

const { createLayout } = await import("../src/model/types.ts");
const { getElementDefinition, registerElement } = await import("../src/renderer/elements.ts");
const { renderLayout } = await import("../src/renderer/renderer.ts");
const { mmToPx } = await import("../src/model/units.ts");

// 构建一张演示标签：外框 + 标题 + 规格 + 条码 + 二维码
const layout = createLayout("E2E 演示标签", { widthMm: 50, heightMm: 40, gapMm: 2 });
layout.elements = [
  getElementDefinition("shape").create({
    shape: "rect",
    strokeWidthMm: 0.3,
    xMm: 1,
    yMm: 1,
    widthMm: 48,
    heightMm: 38,
  }),
  getElementDefinition("text").create({
    text: "LabelDesk 端到端验证",
    fontSizePt: 11,
    bold: true,
    align: "center",
    xMm: 3,
    yMm: 3,
    widthMm: 44,
    heightMm: 6,
  }),
  getElementDefinition("text").create({
    text: "{{规格}}",
    fontSizePt: 9,
    align: "left",
    xMm: 4,
    yMm: 10,
    widthMm: 20,
    heightMm: 5,
  }),
  getElementDefinition("barcode").create({
    value: "6901234567892",
    format: "code128",
    xMm: 4,
    yMm: 16,
    widthMm: 30,
    heightMm: 13,
    textSizePt: 7,
    showText: true,
  }),
  getElementDefinition("qrcode").create({
    value: "https://example.com/labeldesk?sn=2024-0001",
    ecc: "M",
    xMm: 35,
    yMm: 16,
    widthMm: 13,
    heightMm: 13,
  }),
  getElementDefinition("text").create({
    text: "2024-10-10  批次 A-12",
    fontSizePt: 7,
    align: "left",
    xMm: 4,
    yMm: 31,
    widthMm: 30,
    heightMm: 4,
  }),
];
layout.variables = { 规格: "净含量 250ml" };

const dpi = 203;
const widthPx = Math.round(mmToPx(layout.settings.widthMm, dpi));
const heightPx = Math.round(mmToPx(layout.settings.heightMm, dpi));

const canvas = createCanvas(widthPx, heightPx);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#fff";
ctx.fillRect(0, 0, widthPx, heightPx);
renderLayout(ctx, layout, { dpi, variables: layout.variables, background: "#ffffff" });

// 二值化（与打印流程一致）
const imageData = ctx.getImageData(0, 0, widthPx, heightPx);
const px = imageData.data;
const threshold = 160;
let darkCount = 0;
const mono = new Uint8Array(widthPx * heightPx);
for (let i = 0, p = 0; i < px.length; i += 4, p++) {
  const a = px[i + 3];
  const blend = (c) => (c * a + 255 * (255 - a)) / 255;
  const lum = blend(px[i]) * 0.299 + blend(px[i + 1]) * 0.587 + blend(px[i + 2]) * 0.114;
  const dark = lum < threshold;
  mono[p] = dark ? 1 : 0;
  if (dark) darkCount++;
}

const png = canvas.toBuffer("image/png");
const previewPath = path.resolve("docs/e2e-label.png");
writeFileSync(previewPath, png);

console.log("== 端到端渲染验证 ==");
console.log(`模板：${layout.name}  ${layout.settings.widthMm}×${layout.settings.heightMm} mm`);
console.log(`元素：${layout.elements.length} 个（${layout.elements.map((e) => e.kind).join(", ")}）`);
console.log(`位图：${widthPx}×${heightPx} px @ ${dpi}dpi`);
console.log(
  `物理尺寸核对：${((widthPx / dpi) * 25.4).toFixed(2)}×${((heightPx / dpi) * 25.4).toFixed(2)} mm`,
);
console.log(`墨点占比：${((darkCount / (widthPx * heightPx)) * 100).toFixed(2)}%`);

// 覆盖率合理性检查：太少说明没画上，太多说明底色反了
if (darkCount < widthPx * heightPx * 0.01) {
  console.error("✘ 墨点过少，渲染可能失败");
  process.exit(1);
}
if (darkCount > widthPx * heightPx * 0.6) {
  console.error("✘ 墨点过多，底色可能反了");
  process.exit(1);
}
console.log(`预览已保存：${previewPath}`);

if (!process.argv.includes("--print")) {
  console.log("\n（未加 --print，仅生成预览。加 --print 可真机打印。）");
  process.exit(0);
}

// 真实打印：把刚渲染出的这张标签交给 Rust 侧打包成 TSPL 并写入打印队列
console.log("\n== 真机打印 ==");
const printerName = process.argv.find((a) => a.startsWith("--printer="))?.slice("--printer=".length) ?? "Deli DL-888D(NEW)";
const result = spawnSync(
  "cargo",
  [
    "run",
    "--quiet",
    "--example",
    "print_image",
    "--",
    previewPath,
    String(widthPx),
    String(heightPx),
    String(layout.settings.widthMm),
    String(layout.settings.heightMm),
    printerName,
  ],
  { cwd: path.resolve("src-tauri"), stdio: "inherit", shell: true },
);
if (result.status !== 0) {
  console.error(`✘ 打印示例返回码 ${result.status}`);
  process.exit(result.status ?? 1);
}
console.log("✔ 端到端链路完成：TS 渲染 → 二值化 → TSPL 打包 → 打印队列");
