/**
 * 生成实机测试数据。
 *
 * 输出制表符分隔的文件，用 Excel / WPS 打开后整行复制即可粘贴到「打标签」页。
 * 之所以不直接在聊天窗口里贴：制表符经过聊天软件、浏览器常被折叠成空格，
 * 会导致程序按「单值」解析，测不出真实效果。
 *
 *   node scripts/make-test-rows.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT_DIR = path.resolve("testdata");

/** 列顺序：型号 / 入库时间 / 配置 / 价格 / 回收人 / 序列号 */
const ROWS = [
  ["ThinkPad X1 Carbon Gen 9", "2025-03-15", "i7-1165G7 / 16G / 512G SSD", "3280", "张伟", "PF2ABCDE"],
  ["ThinkPad T14 Gen 2", "2025-03-15", "i5-1135G7 / 16G / 512G SSD", "2450", "张伟", "PF3K7M2Q"],
  ["ThinkPad T480", "2025-03-18", "i5-8250U / 8G / 256G SSD", "1180", "李娜", "PF1X9C4D"],
  ["ThinkPad X230", "2025-03-20", "i5-3320M / 4G / 320G HDD", "450", "王强", "R9F2K7L"],
  ["Dell Latitude 5420", "2025-03-22", "i5-1135G7 / 8G / 256G SSD", "1850", "李娜", "CN0X9F2J"],
  ["Dell Latitude 7420", "2025-03-22", "i7-1185G7 / 16G / 512G SSD", "2960", "刘洋", "5CG82K4L"],
  ["Dell XPS 13 9310", "2025-03-25", "i7-1185G7 / 16G / 1T SSD", "3680", "刘洋", "8FK9D2M"],
  ["HP EliteBook 840 G8", "2025-03-25", "i5-1135G7 / 16G / 512G SSD", "2680", "陈静", "5CG0345JZ"],
  ["HP ProBook 450 G7", "2025-03-27", "i5-10210U / 8G / 256G SSD", "1520", "陈静", "CND0123A4B"],
  ["HP EliteBook 830 G6", "2025-03-27", "i5-8265U / 16G / 256G SSD", "1480", "王强", "5CG9231XYZ"],
  ["ASUS ExpertBook B1 B1500", "2025-03-29", "i5-1135G7 / 8G / 512G SSD", "1980", "赵敏", "N1N0CX03B12345"],
  ["ASUS ZenBook 14 UX425", "2025-03-29", "i5-1035G1 / 16G / 512G SSD", "2280", "赵敏", "L1N0CV02A98765"],
  ["HUAWEI MateBook D14", "2025-04-01", "i5-10210U / 8G / 512G SSD", "1750", "李娜", "MCN01234567890"],
  ["HUAWEI MateBook 14s", "2025-04-01", "i5-11300H / 16G / 512G SSD", "2950", "李娜", "MCN09876543210"],
  ["Lenovo 小新 Pro 14 2021", "2025-04-03", "R7-5800H / 16G / 512G SSD", "2750", "张伟", "PF2QW3ER"],
  ["Lenovo YOGA 14s 2021", "2025-04-03", "i5-1135G7 / 16G / 512G SSD", "2880", "张伟", "PF4TY6UI"],
  ["MacBook Pro 13 M1 2020", "2025-04-05", "Apple M1 / 8G / 256G SSD", "4380", "刘洋", "C02X1ABCD2L4"],
  ["MacBook Air M1 2020", "2025-04-05", "Apple M1 / 8G / 256G SSD", "3950", "刘洋", "FVFGH1XYQ6L4"],
  ["Acer 非凡 S3", "2025-04-07", "i5-1135G7 / 16G / 512G SSD", "2150", "陈静", "NXAB1CN0012345"],
  ["小米笔记本 Pro 15", "2025-04-07", "i7-8550U / 16G / 512G SSD", "1680", "赵敏", "XM18001234567"],
];

/** 边界情况：故意让列数不符或内容异常，用来验证告警是否合理 */
const EDGE_CASES = [
  {
    note: "只有 4 列（少了价格和回收人）→ 应提示「只有 4 列，模板需要 6 列」",
    cells: ["ThinkPad E14", "2025-04-08", "i5-10210U / 8G / 256G SSD", "王强"],
  },
  {
    note: "第 2、4 列为空 → 应提示「这些列是空的」",
    cells: ["Dell Vostro 3400", "", "i3-1115G4 / 8G / 256G SSD", "", "陈静", "CN0AB12CD"],
  },
  {
    note: "型号超长（测试自动缩小字号是否生效）",
    cells: [
      "ThinkPad X1 Extreme Gen 4 20Y5-000KCD 工作站级",
      "2025-04-10",
      "i7-11850H / 32G / 1T SSD / RTX 3050Ti",
      "5680",
      "张伟",
      "PF9ZZ9ZZ",
    ],
  },
  {
    note: "价格含千分位与货币符号",
    cells: ["HP ZBook Firefly 14 G8", "2025-04-10", "i7-1165G7 / 32G / 1T SSD", "¥4,280", "刘洋", "5CG1111ABC"],
  },
  {
    note: "配置里含逗号（验证逗号不会被误当分隔符）",
    cells: ["ASUS ROG 幻 14", "2025-04-12", "R9-5900HS,16G,1T SSD,RTX3060", "4850", "赵敏", "N1N0CX07C88888"],
  },
  {
    note: "序列号带空格与短横线（验证条码字符集）",
    cells: ["MacBook Pro 16 2019", "2025-04-12", "i7-9750H / 16G / 512G SSD", "4280", "刘洋", "C02-ABC 123"],
  },
  {
    note: "中文型号 + 分数价格",
    cells: ["联想拯救者 Y7000P 2022", "2025-04-15", "i7-12700H / 16G / 512G SSD", "5450", "王强", "PF8LK3JH"],
  },
];

mkdirSync(OUT_DIR, { recursive: true });

// 1) 基础行（可直接粘贴）
const basicPath = path.join(OUT_DIR, "测试数据-基础20行.txt");
writeFileSync(basicPath, ROWS.map((r) => r.join("\t")).join("\r\n") + "\r\n", "utf8");

// 2) 带序号列：
//    a) 序号在末尾 —— 验证「多一列」告警，前 6 列仍正确
//    b) 序号在开头 —— 验证管理员可用「忽略此列」正确对齐（这是实际表格最常见的形态）
const trailingPath = path.join(OUT_DIR, "测试数据-序号列在末尾.txt");
writeFileSync(
  trailingPath,
  ROWS.map((r, i) => [...r, String(i + 1)].join("\t")).join("\r\n") + "\r\n",
  "utf8",
);

const leadingPath = path.join(OUT_DIR, "测试数据-序号列在开头.txt");
writeFileSync(
  leadingPath,
  ROWS.map((r, i) => [String(i + 1), ...r].join("\t")).join("\r\n") + "\r\n",
  "utf8",
);

// 3) 边界情况（每行单独粘，含说明注释）
const edgePath = path.join(OUT_DIR, "测试数据-边界情况.txt");
const edgeText = EDGE_CASES.map(
  (c) => `# ${c.note}\r\n${c.cells.map((x) => (x === "" ? "" : x)).join("\t")}\r\n`,
).join("\r\n");
writeFileSync(edgePath, edgeText, "utf8");

// 4) Excel 可直接打开的 CSV（给不想用记事本的人）
const csvPath = path.join(OUT_DIR, "测试数据.csv");
const csvEscape = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
writeFileSync(
  csvPath,
  ROWS.map((r) => r.map(csvEscape).join(",")).join("\r\n") + "\r\n",
  "utf8",
);

console.log("已生成测试数据：\n");
console.log(`  基础 20 行           ${basicPath}`);
console.log(`  序号列在末尾         ${trailingPath}`);
console.log(`  序号列在开头         ${leadingPath}`);
console.log(`  边界情况 7 条        ${edgePath}`);
console.log(`  CSV（Excel 用）      ${csvPath}`);

console.log("\n字段顺序（必须与模板的字段映射一致）：");
["笔记本型号", "入库时间", "电脑配置", "入库价格", "回收人", "笔记本序列号"].forEach((label, i) =>
  console.log(`  ${i + 1}. ${label}`),
);

console.log("\n基础 20 行（制表符分隔；从聊天窗口复制可能被转成空格，建议用上面的文件）：\n");
for (const row of ROWS) console.log(row.join("\t"));

console.log("\n边界情况（每条单独粘贴测试）：\n");
for (const c of EDGE_CASES) {
  console.log(`  ${c.note}`);
  console.log(`  ${c.cells.join("\t")}\n`);
}
