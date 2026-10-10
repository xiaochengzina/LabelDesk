/**
 * 渲染示例模板的预览图，用于确认标签版式与变量替换效果。
 * 读取应用数据目录里真实的模板文件，走真实渲染器 + 真实解析逻辑。
 *
 *   node --import ./scripts/loader-register.mjs scripts/preview-template.mjs
 */
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";

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

const { renderLayout } = await import("../src/renderer/renderer.ts");
const { buildFill } = await import("../src/model/fill.ts");
const { mmToPx, pxToMm } = await import("../src/model/units.ts");

const appData = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? ".", "AppData", "Roaming");
const layoutsDir = path.join(appData, "com.labeldesk.app", "layouts");

const wanted = process.argv[2];
const files = readdirSync(layoutsDir).filter((f) => f.endsWith(".ldl.json"));
if (files.length === 0) {
  console.error("模板目录为空，请先运行 scripts/make-sample-template.mjs");
  process.exit(1);
}
const chosen = wanted ? files.find((f) => f.includes(wanted)) ?? files[0] : files[0];
const layout = JSON.parse(readFileSync(path.join(layoutsDir, chosen), "utf8"));
console.log(`模板：${layout.name}（${chosen}）`);

// 用真实解析逻辑处理一行示例数据，验证「粘贴 → 变量」链路
// 参数：--row="型号<TAB>时间<TAB>..." 可指定自己的测试行
const fields = layout.fields ?? [];
const rowArg = process.argv.find((a) => a.startsWith("--row="));
const sampleRow = rowArg
  ? rowArg.slice("--row=".length).replace(/\\t/g, "\t")
  : fields.map((f) => f.sample ?? "").join("\t");
const fill = buildFill(layout, sampleRow);
if (!fill) {
  console.error("字段映射未配置，无法演示快速打标签");
  process.exit(1);
}
console.log(`示例行：${sampleRow}`);
console.log(`解析结果：${fill.values.map((v) => `${v.field.label}=${v.value}`).join("  ")}`);
if (fill.warnings.length) console.log(`告警：${fill.warnings.join("; ")}`);

const dpi = layout.printer?.dpi ?? 203;

/**
 * 渲染一张标签。
 * @param variables 变量值
 * @param suffix 文件名后缀
 */
function renderLabel(variables, suffix, offsetX = 0, offsetY = 0) {
  const widthPx = Math.round(mmToPx(layout.settings.widthMm, dpi));
  const heightPx = Math.round(mmToPx(layout.settings.heightMm, dpi));
  const canvas = createCanvas(widthPx, heightPx);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, widthPx, heightPx);
  renderLayout(ctx, layout, { dpi, variables, background: "#ffffff", offsetXMm: offsetX, offsetYMm: offsetY });
  const out = path.resolve("docs", `preview-${layout.name}${suffix}.png`);
  writeFileSync(out, canvas.toBuffer("image/png"));
  return { out, widthPx, heightPx };
}

// 1) 模板示例值（管理员设计时看到的样子）
const sample = renderLabel({ ...layout.variables }, "");
console.log(
  `\n示例数据版：${sample.widthPx}×${sample.heightPx} px @ ${dpi}dpi ` +
    `= ${((sample.widthPx / dpi) * 25.4).toFixed(2)}×${((sample.heightPx / dpi) * 25.4).toFixed(2)} mm`,
);
console.log(`  ${sample.out}`);
console.log(`  （1px = ${pxToMm(1, dpi).toFixed(4)} mm）`);

// 2) 粘贴数据替换后的样子——这才是操作员真正看到的
const pasted = renderLabel({ ...layout.variables, ...fill.variables }, "-粘贴后");
console.log(`\n粘贴数据版：${pasted.out}`);
console.log("  注意型号/配置/条码/二维码/入库信息都已按粘贴内容替换。");

// 3) 定位补偿演示：把内容整体右移 6mm，模拟「补偿后被左边裁掉」的修正效果
const offX = Number((process.argv.find((a) => a.startsWith("--offsetX=")) ?? "--offsetX=-6").split("=")[1]);
const offY = Number((process.argv.find((a) => a.startsWith("--offsetY=")) ?? "--offsetY=0").split("=")[1]);
if (offX !== 0 || offY !== 0) {
  const shifted = renderLabel(
    { ...layout.variables, ...fill.variables },
    `-补偿X${offX}Y${offY}`,
    offX,
    offY,
  );
  console.log(`\n定位补偿演示（横向 ${offX} mm，纵向 ${offY} mm）：`);
  console.log(`  ${shifted.out}`);
  console.log("  默认演示的是「内容偏左 6mm 时把横向补偿设为 +6」的效果。");
}