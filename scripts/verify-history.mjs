/**
 * 打印去重的关键逻辑验证：序列号识别。
 *
 * 这里最容易出的错不是"漏判"，而是"误判"——把型号当序列号去重，
 * 会让同型号的机器全被判成重复，那功能就没法用了。
 * 所以重点验证：型号、配置、日期、价格都不能被当成序列号。
 *
 *   node --import ./scripts/loader-register.mjs scripts/verify-history.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { buildFill, serialCandidates, summarizeForHistory } from "../src/model/fill.ts";

const appData = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? ".", "AppData", "Roaming");
const layoutsDir = path.join(appData, "com.labeldesk.app", "layouts");
const localLayouts = path.join(
  process.env.LOCALAPPDATA ?? "",
  "LabelDesk",
  "data",
  "layouts",
);

function loadTemplate() {
  for (const dir of [localLayouts, layoutsDir]) {
    if (!existsSync(dir)) continue;
    const f = readdirSync(dir).find((n) => n.endsWith(".ldl.json"));
    if (f) return JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  }
  return null;
}

/** 富余的测试模板：不依赖用户环境，保证脚本到哪都能跑 */
function fallbackTemplate() {
  const field = (column, label, variable, sample) => ({ column, label, variable, sample });
  return {
    version: 1,
    id: "测试",
    name: "测试",
    settings: {
      widthMm: 50, heightMm: 30, gapMm: 2, gapOffsetMm: 0,
      gapMode: "gap", columns: 1, marginMm: 1, showGrid: true, gridStepMm: 2,
    },
    elements: [
      { id: "t1", kind: "text", name: "型号", xMm: 2, yMm: 2, widthMm: 40, heightMm: 6, text: "{{型号}}" },
      { id: "t2", kind: "text", name: "配置", xMm: 2, yMm: 8, widthMm: 40, heightMm: 6, text: "{{配置}}" },
      { id: "t3", kind: "text", name: "SN", xMm: 2, yMm: 22, widthMm: 40, heightMm: 6, text: "{{SN}}" },
    ],
    variables: { 型号: "X", 配置: "Y", SN: "Z", 入库时间: "2024-01-01", 价格: "0", 回收人: "某" },
    fields: [
      field(0, "笔记本型号", "型号", "ThinkPad X1 Carbon Gen 9"),
      field(1, "入库时间", "入库时间", "2024-03-15"),
      field(2, "电脑配置", "配置", "i7-1165G7 / 16G / 512G SSD"),
      field(3, "入库价格", "价格", "3280"),
      field(4, "回收人", "回收人", "张伟"),
      field(5, "笔记本序列号", "SN", "PF2ABCDE"),
    ],
  };
}

const layout = loadTemplate() ?? fallbackTemplate();
const source = loadTemplate() ? "真实模板" : "内置测试模板";
console.log(`模板：${layout.name}（${source}）\n`);

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}

// ---------------------------------------------------------------- 正例
const positives = [
  ["标准序列号", "ThinkPad X1\t2024-03-15\ti7-1165G7 / 16G / 512G SSD\t3280\t张伟\tPF2ABCDE", "PF2ABCDE"],
  ["戴尔序列号", "Dell Latitude 5420\t2025-06-02\ti5-1135G7 / 8G / 256G SSD\t1850\t李娜\tCN0X9F2J"],
  ["混合大小写", "X\t2024-01-01\tA / B\t1\t某人\tabC12345"],
  ["带短横线", "X\t2024-01-01\tA / B\t1\t某人\tSN-2024-001"],
];
console.log("=== 应被识别为序列号 ===");
for (const [name, row, expect] of positives) {
  const fill = buildFill(layout, row);
  const got = serialCandidates(fill);
  const want = expect ?? row.split("\t").at(-1);
  check(name, got.length === 1 && got[0] === want, JSON.stringify(got));
  console.log(`  ${got.length === 1 && got[0] === want ? "\u2713" : "\u2717"} ${name} → ${JSON.stringify(got)}`);
}

// ---------------------------------------------------------------- 反例（关键）
console.log("\n=== 不应被误判为序列号 ===");
const row1 = positives[0][1];
const fill1 = buildFill(layout, row1);
const candidates1 = serialCandidates(fill1);
const mustNot = [
  ["型号（含数字和空格）", "ThinkPad X1 Carbon Gen 9"],
  ["配置字符串（含空格）", "i7-1165G7 / 16G / 512G SSD"],
  ["日期", "2024-03-15"],
  ["价格（纯数字）", "3280"],
  ["人名", "张伟"],
];
for (const [name, value] of mustNot) {
  const ok = !candidates1.includes(value);
  check(name, ok, `被误判为 ${JSON.stringify(value)}`);
  console.log(`  ${ok ? "\u2713" : "\u2717"} ${name} 未被误判`);
}

// ---------------------------------------------------------------- 形状规则
//
// 注意：形状启发式**只作用于未声明为序列号的字段**。
// 如果模板里某列的变量名就是 SN / 序列号，那说明管理员明确声明了
// "这一列就是序列号"，此时无条件信任它（哪怕它短、是纯数字）。
// 所以这组测试要换成一个"最后一列不叫序列号"的模板。
console.log("\n=== 形状规则（仅对未声明为序列号的字段生效）===");
const noDeclaredSerial = {
  ...layout,
  fields: layout.fields.map((f) =>
    f.variable === layout.fields.at(-1).variable
      ? { ...f, label: "备注", variable: "备注" }
      : f,
  ),
};
const shapes = [
  ["过短（5 位）", "A1B2C", false],
  ["纯数字且长", "10123456789", false],
  ["无数字", "ABCDEFG", false],
  ["含空格", "AB 12345", false],
  ["正常", "CN0X9F2J", true],
];
for (const [name, value, expected] of shapes) {
  const row = `X\t2024-01-01\tA\t1\t人\t${value}`;
  const got = serialCandidates(buildFill(noDeclaredSerial, row)).includes(value);
  check(name, got === expected, `实际 ${got}`);
  console.log(`  ${got === expected ? "\u2713" : "\u2717"} ${name} → ${got ? "识别" : "忽略"}`);
}

// ---------------------------------------------------------------- 显式声明优先
console.log("\n=== 声明为序列号的字段被无条件信任 ===");
const declaredShapes = [
  ["短序列号", "A1B2C"],
  ["纯数字序列号", "10123456789"],
  ["含空格序列号", "AB 12345"],
];
for (const [name, value] of declaredShapes) {
  const row = `X\t2024-01-01\tA\t1\t人\t${value}`;
  const got = serialCandidates(buildFill(layout, row));
  const ok = got.length === 1 && got[0] === value;
  check(name, ok, JSON.stringify(got));
  console.log(`  ${ok ? "\u2713" : "\u2717"} ${name}（${value}）被采纳`);
}

// ---------------------------------------------------------------- 优先级
console.log("\n=== 变量名优先 ===");
const withSn = {
  ...layout,
  fields: layout.fields.map((f) =>
    f.variable === layout.fields.at(-1).variable ? { ...f, variable: "SN" } : f,
  ),
};
const fillSn = buildFill(withSn, row1);
const gotSn = serialCandidates(fillSn);
check("变量名为 SN 时只取该字段", gotSn.length === 1 && gotSn[0] === "PF2ABCDE", JSON.stringify(gotSn));
console.log(`  ${gotSn.length === 1 && gotSn[0] === "PF2ABCDE" ? "\u2713" : "\u2717"} → ${JSON.stringify(gotSn)}`);

// ---------------------------------------------------------------- 摘要
console.log("\n=== 历史摘要 ===");
const summary = summarizeForHistory(fill1);
check("摘要取型号", summary.includes("ThinkPad") || summary.includes(layout.name), summary);
console.log(`  → ${JSON.stringify(summary)}`);

const empty = buildFill(layout, "\t\t\t\t\t");
if (empty) {
  const none = serialCandidates(empty);
  check("全空行不产生候选", none.length === 0, JSON.stringify(none));
  console.log(`  ${none.length === 0 ? "\u2713" : "\u2717"} 全空行 → ${JSON.stringify(none)}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
