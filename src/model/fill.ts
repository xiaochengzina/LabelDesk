/**
 * 「打标签」页的解析逻辑。
 *
 * 操作员的实际操作是：在 Excel / WPS / 网页表格里选中一台笔记本那一行，
 * Ctrl+C，然后 Ctrl+V 到本程序的粘贴框。复制出来的是**制表符分隔的一行**。
 *
 * 这里的原则是「尽量解析成功，并把解析结果明确展示给操作员核对」——
 * 打印一张废标签的成本，比多看一眼解析结果高得多。
 */

import type { LabelLayout, TemplateField } from "./types";
import { extractVariableNames } from "../renderer/elements";

export interface ParsedRow {
  /** 按列拆出的原始值 */
  cells: string[];
  /** 实际使用的分隔符，用于给操作员提示 */
  separator: "tab" | "comma" | "newline" | "single";
}

export interface FieldValue {
  field: TemplateField;
  /** 解析出的值；为空字符串表示这一列没有数据 */
  value: string;
  /** 该列是否超出粘贴内容的列数 */
  missing: boolean;
}

export interface FillResult {
  parsed: ParsedRow;
  /** 与模板 fields 一一对应的结果（含缺失项与被忽略的列） */
  values: FieldValue[];
  /** 变量名 → 值，可直接喂给渲染器 */
  variables: Record<string, string>;
  /** 面向操作员的告警（列数不符、必填缺失等） */
  warnings: string[];
  /** 是否为可用状态（有内容且至少填上一个变量） */
  ok: boolean;
}

/**
 * 归一化粘贴内容：
 * - 去掉首尾空白与 BOM
 * - 全角空格换成半角（中文输入法下容易混入）
 * - 统一换行符
 */
function normalize(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/\u3000/g, " ")
    .replace(/\r\n?/g, "\n")
    .trim();
}

/**
 * 解析一行数据。
 *
 * 分隔符判定优先级：制表符 > 逗号 > 换行 > 单值。
 * 之所以把逗号也当分隔符，是因为有些表格复制出来是 CSV 形态；
 * 但如果内容里本来就有逗号又没有制表符，就只在「逗号分隔出的列数与字段数吻合」时才采用，
 * 否则宁可当成单值，避免把「i7-9750H, 16G」这种配置文本切碎。
 */
export function parseRow(raw: string, expectedColumns: number): ParsedRow | null {
  const text = normalize(raw);
  if (!text) return null;

  // 1) 制表符：Excel 复制的标准形态，最可信
  if (text.includes("\t")) {
    const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? text;
    return { cells: firstLine.split("\t").map((c) => c.trim()), separator: "tab" };
  }

  // 2) 逗号：仅在列数吻合时才采用，否则视为内容中的普通字符
  if (text.includes(",") && !text.includes("\n")) {
    const byComma = text.split(",").map((c) => c.trim());
    if (expectedColumns > 1 && byComma.length === expectedColumns) {
      return { cells: byComma, separator: "comma" };
    }
  }

  // 3) 多行且没有制表符：可能每个单元格被复制成了单独一行
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length > 1 && expectedColumns > 1 && lines.length === expectedColumns) {
    return { cells: lines, separator: "newline" };
  }
  // 多行但列数不吻合：只用第一行，并提示
  if (lines.length > 1) {
    return { cells: [lines[0]], separator: "single" };
  }

  // 4) 单值：只有一个字段的模板
  return { cells: [text], separator: "single" };
}

/** 一次性完成「解析 → 映射到变量 → 生成告警」 */
export function buildFill(layout: LabelLayout, raw: string): FillResult | null {
  const fields = layout.fields ?? [];
  if (fields.length === 0) return null;

  const parsed = parseRow(raw, fields.length);
  if (!parsed) return null;

  const values: FieldValue[] = fields.map((field, index) => {
    const cell = parsed.cells[index];
    const missing = cell === undefined;
    return { field, value: cell ?? "", missing };
  });

  const variables: Record<string, string> = {};
  for (const item of values) {
    // skip 列占用位置但不填变量；variable 为空同样视为忽略
    if (item.field.skip || !item.field.variable) continue;
    variables[item.field.variable] = item.value;
  }

  const warnings: string[] = [];
  if (parsed.cells.length < fields.length) {
    warnings.push(
      `粘贴内容只有 ${parsed.cells.length} 列，模板需要 ${fields.length} 列。` +
        `后面 ${fields.length - parsed.cells.length} 个字段会是空的，请确认是否复制完整。`,
    );
  } else if (parsed.cells.length > fields.length) {
    warnings.push(
      `粘贴内容有 ${parsed.cells.length} 列，模板只用前 ${fields.length} 列，多出的 ${parsed.cells.length - fields.length} 列已忽略。` +
        `如果表格前面多了序号之类的列，请在「字段映射」里把那几列标记为「忽略」。`,
    );
  }
  if (parsed.separator === "single" && fields.length > 1) {
    warnings.push(
      "没有检测到制表符或逗号分隔，整段被当成第一列。请回表格里重新复制一整行（不是单个单元格）。",
    );
  }
  const emptyFields = values.filter(
    (v) => !v.missing && !v.field.skip && v.field.variable && v.value === "",
  );
  if (emptyFields.length > 0) {
    warnings.push(
      `这些列是空的：${emptyFields.map((v) => v.field.label || v.field.variable).join("、")}`,
    );
  }

  const filledAny = values.some((v) => !v.field.skip && v.value !== "");
  return { parsed, values, variables, warnings, ok: filledAny };
}

/**
 * 从模板中推断字段定义（管理员一键初始化用）。
 *
 * 依据是模板里已定义的变量顺序：元素在画布上的阅读顺序（先上后下、再左到右）
 * 通常就等于表格列顺序，所以按这个顺序生成初稿，管理员再微调。
 */
export function inferFields(layout: LabelLayout): TemplateField[] {
  const names = new Set<string>();
  // 按元素位置排序，保证推断顺序稳定且符合视觉阅读顺序（先上后下、再左到右）
  const ordered = [...layout.elements].sort((a, b) =>
    Math.abs(a.yMm - b.yMm) > 1 ? a.yMm - b.yMm : a.xMm - b.xMm,
  );
  for (const element of ordered) {
    const record = element as unknown as Record<string, unknown>;
    for (const field of ["text", "value"]) {
      for (const name of extractVariableNames(String(record[field] ?? ""))) names.add(name);
    }
  }
  // 模板里显式声明但元素中没用到的变量也要保留
  for (const key of Object.keys(layout.variables ?? {})) names.add(key);

  return [...names].map((variable, index) => ({
    column: index,
    label: variable,
    variable,
    sample: layout.variables?.[variable] ?? "",
  }));
}

/** 该模板是否已配好字段映射，可用于快速打标签 */
export function isReadyForQuickPrint(layout: LabelLayout): boolean {
  return (layout.fields ?? []).length > 0;
}

/**
 * 从解析结果里挑出「看起来是唯一标识」的值（序列号、资产号等），用于打印去重。
 *
 * 难点：不能把所有字段都当标识——型号 `ThinkPad X1 Carbon Gen 9` 也含数字，
 * 拿它去重会把同型号的机器全判成重复。所以规则收得很紧：
 *
 * 1. 优先取变量名本身就表明是序列号的字段（sn / serial / 序列号）
 * 2. 其余字段必须满足：不含空白、长度 6–40、至少含一位数字、
 *    且不是纯数字、不是 `YYYY-MM-DD` 这类日期
 *
 * 这样 `PF2ABCDE`、`CN0X9F2J` 会被认定为标识，
 * 而 `i7-1165G7 / 16G / 512G SSD`（含空格）、`2024-03-15`（日期）、
 * `3280`（纯数字且短）都不会。
 */
export function serialCandidates(fill: FillResult): string[] {
  const serialish = /(^|[^a-z])(sn|s\/n|serial|serialno|serialnumber)([^a-z]|$)|序列号|资产编号/i;
  const picked: string[] = [];

  // 1) 变量名表明身份的优先
  for (const item of fill.values) {
    if (item.field.skip || !item.field.variable) continue;
    if (!serialish.test(item.field.variable) && !serialish.test(item.field.label ?? "")) continue;
    const v = item.value.trim();
    if (v) return [v]; // 明确的序列号字段，直接用
  }

  // 2) 按形态启发式筛选
  for (const item of fill.values) {
    if (item.field.skip) continue;
    const v = item.value.trim();
    if (!v) continue;
    if (picked.includes(v)) continue;
    if (/\s/.test(v)) continue; // 含空格 → 更像描述文字
    if (v.length < 6 || v.length > 40) continue;
    if (!/\d/.test(v)) continue; // 必须含数字
    if (/^\d+$/.test(v)) continue; // 纯数字（价格/数量）
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) continue; // 日期
    picked.push(v);
  }
  return picked;
}

/** 给历史记录用的简短摘要：优先型号，其次前两个非空字段 */
export function summarizeForHistory(fill: FillResult): string {
  const nonEmpty = fill.values.filter((v) => !v.field.skip && v.value.trim());
  const model = nonEmpty.find((v) => /型号|model/i.test(v.field.label ?? "") || /型号/i.test(v.field.variable ?? ""));
  if (model) return model.value.trim();
  return nonEmpty.slice(0, 2).map((v) => v.value.trim()).join(" · ").slice(0, 80);
}