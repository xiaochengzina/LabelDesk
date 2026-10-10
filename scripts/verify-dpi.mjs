/**
 * 验证「毫米为准」的核心承诺：
 * 同一模板在 203 / 300 / 600 dpi 下渲染，物理尺寸必须一致，
 * 且内容墨点覆盖率接近（说明内容按比例缩放而不是被裁切）。
 *
 *   node --import ./scripts/loader-register.mjs scripts/verify-dpi.mjs
 */
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { existsSync } from "node:fs";

if (process.platform === "win32") {
  for (const f of ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simsun.ttc", "C:/Windows/Fonts/consola.ttf"]) {
    if (existsSync(f)) {
      try {
        GlobalFonts.registerFromPath(f);
      } catch {
        /* 忽略 */
      }
    }
  }
}

globalThis.document = {
  createElement() {
    return createCanvas(1, 1);
  },
};

const { createLayout } = await import("../src/model/types.ts");
const { getElementDefinition } = await import("../src/renderer/elements.ts");
const { renderLayout } = await import("../src/renderer/renderer.ts");
const { mmToPx } = await import("../src/model/units.ts");

const layout = createLayout("DPI 验证", { widthMm: 40, heightMm: 30 });
layout.elements = [
  getElementDefinition("shape").create({ xMm: 1, yMm: 1, widthMm: 38, heightMm: 28, strokeWidthMm: 0.3 }),
  getElementDefinition("text").create({ text: "尺寸一致性", fontSizePt: 10, bold: true, xMm: 3, yMm: 3, widthMm: 34, heightMm: 6 }),
  getElementDefinition("barcode").create({ value: "6901234567892", format: "code128", xMm: 3, yMm: 10, widthMm: 34, heightMm: 14, textSizePt: 7 }),
];

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const results = [];
for (const dpi of [203, 300, 600]) {
  const w = Math.round(mmToPx(layout.settings.widthMm, dpi));
  const h = Math.round(mmToPx(layout.settings.heightMm, dpi));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  renderLayout(ctx, layout, { dpi, variables: layout.variables, background: "#ffffff" });

  const data = ctx.getImageData(0, 0, w, h).data;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    if (lum < 160) dark++;
  }
  const physicalW = (w / dpi) * 25.4;
  const physicalH = (h / dpi) * 25.4;
  results.push({ dpi, w, h, physicalW, physicalH, coverage: dark / (w * h) });
  console.log(
    `  ${String(dpi).padStart(3)}dpi -> ${String(w).padStart(4)}×${String(h).padStart(4)} px  ` +
      `物理 ${physicalW.toFixed(2)}×${physicalH.toFixed(2)} mm  墨点 ${(dark / (w * h) * 100).toFixed(2)}%`,
  );
}

console.log("\n== 校验 ==");
const targetW = layout.settings.widthMm;
const targetH = layout.settings.heightMm;
for (const r of results) {
  check(
    `${r.dpi}dpi 物理宽度 ≈ ${targetW}mm`,
    Math.abs(r.physicalW - targetW) < 0.06,
    `实际 ${r.physicalW.toFixed(3)}mm`,
  );
  check(
    `${r.dpi}dpi 物理高度 ≈ ${targetH}mm`,
    Math.abs(r.physicalH - targetH) < 0.06,
    `实际 ${r.physicalH.toFixed(3)}mm`,
  );
}

// 覆盖率应当接近：差异过大说明内容在不同 DPI 下被裁切或缩放错误
const coverages = results.map((r) => r.coverage);
const minCov = Math.min(...coverages);
const maxCov = Math.max(...coverages);
check(
  "三个 DPI 下墨点覆盖率接近（±25% 相对差）",
  maxCov / minCov < 1.25,
  `最低 ${(minCov * 100).toFixed(2)}%，最高 ${(maxCov * 100).toFixed(2)}%`,
);

// 像素宽高比一致性
for (const r of results) {
  check(
    `${r.dpi}dpi 像素宽高比与物理比例一致`,
    Math.abs(r.w / r.h - targetW / targetH) < 0.01,
    `${(r.w / r.h).toFixed(4)} vs ${(targetW / targetH).toFixed(4)}`,
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
