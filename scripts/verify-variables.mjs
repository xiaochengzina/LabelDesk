import { resolveVariables, extractVariableNames, isValidVariableName } from "../src/renderer/elements.ts";
const cases = [
  ["{{规格}}", { 规格: "净含量 250ml" }, "净含量 250ml"],
  ["{{ 规格 }}", { 规格: "X" }, "X"],
  ["A{{名}}B", { 名: "-" }, "A-B"],
  ["{{order_no}}", { order_no: "SO-1" }, "SO-1"],
  ["{{未定义}}", { 规格: "X" }, "{{未定义}}"],
  ["没有变量", { a: "b" }, "没有变量"],
  ["{{混合}}", { 混合: "OK" }, "OK"],
];
let pass = 0, fail = 0;
for (const [input, vars, expected] of cases) {
  const got = resolveVariables(input, vars);
  if (got === expected) { pass++; } else { fail++; console.log(`✗ "${input}" -> "${got}" 期望 "${expected}"`); }
}
console.log(`替换: ${pass} 通过 / ${fail} 失败`);
console.log("提取中文变量:", JSON.stringify(extractVariableNames("{{品名}} {{条码}} {{qty}}")));
console.log("校验 中文名:", isValidVariableName("规格"), " 带空格:", isValidVariableName("a b"), " 英文:", isValidVariableName("order_no"));

