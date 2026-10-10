/**
 * 「打标签」页解析逻辑测试。
 *
 * 覆盖真实复制粘贴的几种形态：Excel 制表符、CSV 逗号、单元格逐行复制，
 * 以及列数不匹配、内容含逗号等容易出错的情况。
 *
 *   node --import ./scripts/loader-register.mjs scripts/verify-fill.mjs
 */
import { parseRow, buildFill, inferFields, isReadyForQuickPrint } from "../src/model/fill.ts";
import { createLayout } from "../src/model/types.ts";

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

// 一台笔记本的真实一行数据（制表符分隔，Excel 复制出来的形态）
const ROW = [
  "ThinkPad X1 Carbon Gen 9",
  "2024-03-15",
  "i7-1165G7 / 16G / 512G SSD",
  "3280",
  "张伟",
  "PF2ABCDE",
].join("\t");

const FIELDS = [
  { column: 0, label: "笔记本型号", variable: "型号", sample: "" },
  { column: 1, label: "入库时间", variable: "入库时间", sample: "" },
  { column: 2, label: "电脑配置", variable: "配置", sample: "" },
  { column: 3, label: "入库价格", variable: "价格", sample: "" },
  { column: 4, label: "回收人", variable: "回收人", sample: "" },
  { column: 5, label: "序列号", variable: "SN", sample: "" },
];

function makeLayout() {
  const layout = createLayout("笔记本标签", { widthMm: 50, heightMm: 30 });
  layout.variables = Object.fromEntries(FIELDS.map((f) => [f.variable, ""]));
  layout.fields = FIELDS.map((f) => ({ ...f }));
  return layout;
}

console.log("\n=== 解析分隔符 ===");
{
  const r = parseRow(ROW, 6);
  check("制表符分隔被正确识别", r?.separator === "tab", `实际 ${r?.separator}`);
  check("拆出 6 列", r?.cells.length === 6, `实际 ${r?.cells.length}`);
  check("首列内容正确", r?.cells[0] === "ThinkPad X1 Carbon Gen 9", r?.cells[0]);
  check("空格未被当作分隔符", r?.cells[2] === "i7-1165G7 / 16G / 512G SSD", r?.cells[2]);
}
{
  const r = parseRow("A,B,C", 3);
  check("逗号分隔且列数吻合时采用", r?.separator === "comma" && r.cells.length === 3);
}
{
  const r = parseRow("i7-9750H, 16G, 512G", 6);
  check("逗号分隔但列数不吻合时不采用（避免切碎配置文本）", r?.separator === "single", `实际 ${r?.separator}`);
}
{
  const r = parseRow("甲\n乙\n丙", 3);
  check("逐单元格复制成多行时按顺序解析", r?.separator === "newline" && r.cells.length === 3, `实际 ${r?.separator}/${r?.cells.length}`);
}
{
  const r = parseRow(ROW + "\n" + ROW, 6);
  check("粘贴多行时只用第一行（一次一台）", r?.cells.length === 6 && r.cells[0].startsWith("ThinkPad"));
}
{
  check("空内容返回 null", parseRow("   ", 6) === null);
  check("全角空格被归一化为半角", parseRow("A\u3000B", 1)?.cells[0] === "A B");
  check("BOM 被去除", parseRow("\uFEFF型号A", 1)?.cells[0] === "型号A");
}

console.log("\n=== 映射到变量 ===");
{
  const layout = makeLayout();
  const fill = buildFill(layout, ROW);
  check("解析成功", fill !== null);
  check("6 个字段全部有值", fill.values.every((v) => v.value !== ""), JSON.stringify(fill.values.map((v) => v.value)));
  check("型号映射正确", fill.variables["型号"] === "ThinkPad X1 Carbon Gen 9");
  check("价格映射正确", fill.variables["价格"] === "3280");
  check("序列号映射正确", fill.variables["SN"] === "PF2ABCDE");
  check("无告警", fill.warnings.length === 0, fill.warnings.join("; "));
  check("状态为可打印", fill.ok === true);
}

console.log("\n=== 异常情况 ===");
{
  const layout = makeLayout();
  const fill = buildFill(layout, "只有一列");
  check("列数不足时给出告警", fill.warnings.some((w) => w.includes("只有 1 列")), fill.warnings.join("; "));
  check("缺失字段被标记", fill.values.filter((v) => v.missing).length === 5);
  check("已填的字段仍可用", fill.variables["型号"] === "只有一列");
}
{
  const layout = makeLayout();
  const fill = buildFill(layout, ROW + "\t多出来的一列");
  check("列数多余时给出告警", fill.warnings.some((w) => w.includes("多出的")), fill.warnings.join("; "));
  check("前 6 列映射不受影响", fill.variables["SN"] === "PF2ABCDE");
}
{
  const layout = makeLayout();
  const fill = buildFill(layout, "型号A\t\t配置C\t\t回收人E\t");
  check("空单元格被识别并告警", fill.warnings.some((w) => w.includes("这些列是空的")), fill.warnings.join("; "));
  check("空单元格值为空字符串", fill.variables["入库时间"] === "");
}
{
  const layout = makeLayout();
  check("完全空内容不产生解析结果", buildFill(layout, "  ") === null);
}
{
  const layout = createLayout("无映射");
  check("未配置字段映射时返回 null", buildFill(layout, ROW) === null);
  check("未配置映射时不可快速打印", isReadyForQuickPrint(layout) === false);
  check("配置后可用于快速打印", isReadyForQuickPrint(makeLayout()) === true);
}

console.log("\n=== 从模板变量自动生成映射 ===");
{
  const layout = createLayout("推断测试", { widthMm: 40, heightMm: 30 });
  layout.elements = [
    // 故意打乱数组顺序，验证按画布位置排序（先上后下、再左到右）
    { id: "c", kind: "text", name: "c", xMm: 2, yMm: 20, widthMm: 30, heightMm: 5, rotation: 0, locked: false, visible: true, opacity: 1, text: "{{价格}}", fontFamily: "sans", fontSizePt: 9, bold: false, italic: false, underline: false, align: "left", verticalAlign: "top", lineHeight: 1.2, letterSpacingPt: 0, autoShrink: true, clip: true },
    { id: "a", kind: "text", name: "a", xMm: 2, yMm: 2, widthMm: 30, heightMm: 5, rotation: 0, locked: false, visible: true, opacity: 1, text: "{{型号}}", fontFamily: "sans", fontSizePt: 9, bold: false, italic: false, underline: false, align: "left", verticalAlign: "top", lineHeight: 1.2, letterSpacingPt: 0, autoShrink: true, clip: true },
    { id: "b", kind: "text", name: "b", xMm: 2, yMm: 10, widthMm: 30, heightMm: 5, rotation: 0, locked: false, visible: true, opacity: 1, text: "{{SN}}", fontFamily: "sans", fontSizePt: 9, bold: false, italic: false, underline: false, align: "left", verticalAlign: "top", lineHeight: 1.2, letterSpacingPt: 0, autoShrink: true, clip: true },
  ];
  const inferred = inferFields(layout);
  check("推断出 3 个字段", inferred.length === 3, `实际 ${inferred.length}`);
  check(
    "按画布位置排序（型号 → SN → 价格）",
    inferred.map((f) => f.variable).join(",") === "型号,SN,价格",
    inferred.map((f) => f.variable).join(","),
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
