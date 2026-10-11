/**
 * 元素注册表：LabelDesk 的扩展点。
 *
 * 新增一种元素类型只需要：
 * 1. 在 `model/types.ts` 里加一个 `XxxProps` 并并入 `LabelElement` 联合类型
 * 2. 写一个 `ElementDefinition`（create / measure / draw / properties）
 * 3. `registerElement(...)` 注册（或直接加进本文件的 BUILTIN 数组）
 *
 * 渲染器、命中测试、属性面板、图层列表全部由注册表驱动，
 * 因此不需要改动任何 UI 代码即可支持新元素。
 */

import type { LabelElement, ElementType } from "../model/types";
import type { IconName } from "../components/icons";
import { newElementId } from "../model/types";
import { encodeBarcode, encodeQr, quietZoneUnits, type BarcodeKind } from "../model/barcode";
import { getImageSync, loadImage } from "./images";
import { ptToPx } from "../model/units";

// ---------------------------------------------------------------------------
// 渲染上下文
// ---------------------------------------------------------------------------

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  /** 目标 DPI（203 / 300 / 600）。毫米与磅都按它换算成像素。 */
  dpi: number;
  /** 标签物理尺寸（毫米） */
  widthMm: number;
  heightMm: number;
  /** 变量替换表（{{key}}） */
  variables: Record<string, string>;
  /** 是否为打印渲染（打印时不做抗锯齿妥协、不画辅助线） */
  forPrint: boolean;
}

/**
 * 变量占位符的匹配规则。
 *
 * 注意 `\w` 在 JavaScript 里只匹配 ASCII 单词字符，**不包含中文**。
 * 若写成 `[\w.-]+`，中文变量名（如 `{{规格}}`）将永远不会被替换，
 * 因此这里用 Unicode 属性类 `\p{L}` / `\p{N}` 覆盖所有语言的字母与数字。
 */
export const VARIABLE_NAME_PATTERN = "[\\p{L}\\p{N}_.\\-]+";

/** 新建一个带全局标志的变量正则（避免共享 `lastIndex` 状态） */
export function variableRegex(): RegExp {
  return new RegExp(`\\{\\{\\s*(${VARIABLE_NAME_PATTERN})\\s*\\}\\}`, "gu");
}

/** 变量名合法性校验（用于「新增变量」输入框） */
export function isValidVariableName(name: string): boolean {
  return new RegExp(`^${VARIABLE_NAME_PATTERN}$`, "u").test(name);
}

/** 把 `{{key}}` 替换为变量值；未定义的变量保留原样便于发现拼写错误。 */
export function resolveVariables(text: string, variables: Record<string, string>): string {
  if (!text || !text.includes("{{")) return text;
  return text.replace(variableRegex(), (match, key: string) => {
    const value = variables[key];
    return value === undefined ? match : value;
  });
}

/** 从一段文本中提取所有变量名 */
export function extractVariableNames(text: string): string[] {
  if (!text || !text.includes("{{")) return [];
  return [...text.matchAll(variableRegex())].map((m) => m[1]);
}

export const FONT_STACKS: Record<string, string> = {
  sans: '"Microsoft YaHei", "微软雅黑", "Segoe UI", Arial, sans-serif',
  serif: '"SimSun", "宋体", "Times New Roman", serif',
  mono: '"Consolas", "Courier New", monospace',
};

// ---------------------------------------------------------------------------
// 元素定义
// ---------------------------------------------------------------------------

export interface PropertyField {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "boolean" | "select" | "color" | "image";
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  /** 单位提示，仅用于展示 */
  unit?: string;
  /** 条件显示：仅当该字段为指定值时显示本字段 */
  visibleWhen?: { key: string; equals: unknown };
  hint?: string;
}

export interface ElementDefinition<T extends LabelElement = LabelElement> {
  /** 元素类型标识（与 props.kind 一致） */
  type: ElementType;
  /** 显示名 */
  label: string;
  /** Lucide 图标名（见 src/components/icons.ts，由 scripts/make-icons.mjs 生成） */
  icon: IconName;
  /** 一句话说明 */
  description: string;
  /** 新建时的默认属性 */
  create: (partial?: Partial<T>) => T;
  /**
   * 测量内容在给定框内的自然尺寸建议（毫米）。
   * 用于「适应内容」按钮；返回 null 表示不适用。
   */
  measure?: (element: T, ctx: RenderContext) => { widthMm: number; heightMm: number } | null;
  /** 绘制到画布（坐标原点已平移到元素左上角，并已应用旋转） */
  draw: (element: T, ctx: RenderContext) => void;
  /** 属性面板字段 */
  properties: PropertyField[];
}

const registry = new Map<ElementType, ElementDefinition>();

export function registerElement(def: ElementDefinition): void {
  registry.set(def.type, def);
}

export function getElementDefinition(type: ElementType): ElementDefinition {
  const def = registry.get(type);
  if (!def) throw new Error(`未注册的元素类型：${type}`);
  return def;
}

export function listElementDefinitions(): ElementDefinition[] {
  return [...registry.values()];
}

/** 统一的元素基类字段 */
export function baseElement(type: ElementType, name: string) {
  return {
    id: newElementId(type),
    name,
    xMm: 2,
    yMm: 2,
    widthMm: 20,
    heightMm: 8,
    rotation: 0,
    locked: false,
    visible: true,
    opacity: 1,
  };
}

// ---------------------------------------------------------------------------
// 绘制辅助
// ---------------------------------------------------------------------------

function mm(v: number, ctx: RenderContext): number {
  return (v / 25.4) * ctx.dpi;
}

/** 圆角矩形路径（兼容不支持 roundRect 的环境） */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  if (typeof (ctx as unknown as { roundRect?: unknown }).roundRect === "function") {
    (ctx as unknown as CanvasRenderingContext2D & {
      roundRect: (x: number, y: number, w: number, h: number, r: number) => void;
    }).roundRect(x, y, w, h, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/** 把一行文字按最大宽度拆成多行（支持显式换行）。 */
function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const paragraphs = text.split("\n");
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let current = "";
    // 中文没有空格，需要逐字测量；英文按词断行
    const tokens = paragraph.match(/[\u4e00-\u9fff\u3000-\u303f]|[^\s\u4e00-\u9fff]+|\s+/g) ?? [paragraph];
    for (const token of tokens) {
      const candidate = current + token;
      if (current !== "" && ctx.measureText(candidate).width > maxWidth) {
        lines.push(current.trimEnd());
        current = token.trimStart();
      } else {
        current = candidate;
      }
      // 单个 token 本身就超宽时强制切分
      while (ctx.measureText(current).width > maxWidth && current.length > 1) {
        let cut = current.length - 1;
        while (cut > 1 && ctx.measureText(current.slice(0, cut)).width > maxWidth) cut--;
        lines.push(current.slice(0, cut));
        current = current.slice(cut);
      }
    }
    lines.push(current.trimEnd());
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 文本
// ---------------------------------------------------------------------------

const textDef: ElementDefinition = {
  type: "text",
  label: "文本",
  icon: "type",
  description: "单行或多行文字，支持中文、自动换行与自动缩小",
  create: (partial = {}) => ({
    ...baseElement("text", "文本"),
    kind: "text",
    text: "示例文本",
    fontFamily: "sans",
    fontSizePt: 10,
    bold: false,
    italic: false,
    underline: false,
    align: "left",
    verticalAlign: "top",
    lineHeight: 1.25,
    letterSpacingPt: 0,
    autoShrink: true,
    clip: true,
    widthMm: 30,
    heightMm: 8,
    ...partial,
  }) as LabelElement,
  draw: (element, rc) => {
    if (element.kind !== "text") return;
    const { ctx } = rc;
    const w = mm(element.widthMm, rc);
    const h = mm(element.heightMm, rc);
    const raw = resolveVariables(element.text, rc.variables);
    if (!raw) return;

    let fontSize = ptToPx(element.fontSizePt, rc.dpi);
    let letterSpacing = ptToPx(element.letterSpacingPt, rc.dpi);
    const buildFont = (size: number) => {
      const style = element.italic ? "italic " : "";
      const weight = element.bold ? "bold " : "";
      ctx.font = `${style}${weight}${size}px ${FONT_STACKS[element.fontFamily] ?? FONT_STACKS.sans}`;
      try {
        (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${letterSpacing}px`;
      } catch {
        /* 某些环境不支持 letterSpacing，忽略即可 */
      }
    };

    buildFont(fontSize);
    let lines = wrapLines(ctx, raw, w);

    // 自动缩小：整体高度超出时按比例缩字号，避免文字被裁掉
    if (element.autoShrink) {
      const maxLines = 80;
      for (let guard = 0; guard < maxLines; guard++) {
        const lineHeight = fontSize * element.lineHeight;
        if (lines.length * lineHeight <= h || fontSize <= 3) break;
        const shrink = Math.max(0.85, Math.sqrt(h / (lines.length * lineHeight)) * 0.98);
        fontSize = Math.max(3, fontSize * shrink);
        letterSpacing = letterSpacing * shrink;
        buildFont(fontSize);
        lines = wrapLines(ctx, raw, w);
      }
    }

    const lineHeight = fontSize * element.lineHeight;
    const totalHeight = lines.length * lineHeight;
    let startY: number;
    switch (element.verticalAlign) {
      case "middle":
        startY = (h - totalHeight) / 2;
        break;
      case "bottom":
        startY = h - totalHeight;
        break;
      default:
        startY = 0;
    }

    if (element.clip) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.clip();
    }

    ctx.textBaseline = "top";
    ctx.fillStyle = "#000";
    ctx.textAlign = element.align === "center" ? "center" : element.align === "right" ? "right" : "left";
    const anchorX = element.align === "center" ? w / 2 : element.align === "right" ? w : 0;

    lines.forEach((line, index) => {
      const y = startY + index * lineHeight;
      // 逐字绘制以便在缺少 letterSpacing 支持时仍能保证字距
      ctx.fillText(line, anchorX, y);
      if (element.underline) {
        const lineW = ctx.measureText(line).width;
        const ux = element.align === "center" ? anchorX - lineW / 2 : element.align === "right" ? anchorX - lineW : anchorX;
        const thickness = Math.max(1, fontSize * 0.06);
        ctx.fillRect(ux, y + fontSize * 0.92, lineW, thickness);
      }
    });

    if (element.clip) ctx.restore();
  },
  properties: [
    { key: "text", label: "内容", type: "textarea", hint: "支持 {{变量名}} 占位符与换行" },
    {
      key: "fontFamily",
      label: "字体",
      type: "select",
      options: [
        { value: "sans", label: "黑体（推荐）" },
        { value: "serif", label: "宋体" },
        { value: "mono", label: "等宽" },
      ],
    },
    { key: "fontSizePt", label: "字号", type: "number", min: 4, max: 72, step: 0.5, unit: "pt" },
    { key: "bold", label: "加粗", type: "boolean" },
    { key: "italic", label: "斜体", type: "boolean" },
    { key: "underline", label: "下划线", type: "boolean" },
    {
      key: "align",
      label: "水平对齐",
      type: "select",
      options: [
        { value: "left", label: "左对齐" },
        { value: "center", label: "居中" },
        { value: "right", label: "右对齐" },
      ],
    },
    {
      key: "verticalAlign",
      label: "垂直对齐",
      type: "select",
      options: [
        { value: "top", label: "顶部" },
        { value: "middle", label: "居中" },
        { value: "bottom", label: "底部" },
      ],
    },
    { key: "lineHeight", label: "行距", type: "number", min: 0.8, max: 3, step: 0.05 },
    { key: "letterSpacingPt", label: "字距", type: "number", min: -2, max: 10, step: 0.1, unit: "pt" },
    { key: "autoShrink", label: "自动缩小以适配", type: "boolean" },
    { key: "clip", label: "超出裁切", type: "boolean" },
  ],
};

// ---------------------------------------------------------------------------
// 一维码
// ---------------------------------------------------------------------------

const BARCODE_FORMATS = [
  { value: "code128", label: "Code 128（通用，支持字母数字）" },
  { value: "code39", label: "Code 39（工业，简单）" },
  { value: "ean13", label: "EAN-13（商品条码，12/13 位数字）" },
  { value: "ean8", label: "EAN-8（小商品，7/8 位数字）" },
  { value: "upca", label: "UPC-A（北美商品，11/12 位数字）" },
  { value: "itf14", label: "ITF-14（物流外箱，13/14 位数字）" },
];

const barcodeDef: ElementDefinition = {
  type: "barcode",
  label: "一维码",
  icon: "barcode",
  description: "Code128 / Code39 / EAN / UPC / ITF，含校验位自动补全与静区",
  create: (partial = {}) => ({
    ...baseElement("barcode", "一维码"),
    kind: "barcode",
    value: "6901234567892",
    format: "code128",
    textGapMm: 0.8,
    showText: true,
    textSizePt: 7,
    showCheckDigit: true,
    autoFit: true,
    moduleWidthMm: 0.25,
    barHeightRatio: 0.75,
    widthMm: 32,
    heightMm: 12,
    ...partial,
  }) as LabelElement,
  draw: (element, rc) => {
    if (element.kind !== "barcode") return;
    const { ctx } = rc;
    const w = mm(element.widthMm, rc);
    const h = mm(element.heightMm, rc);
    const value = resolveVariables(element.value, rc.variables);

    const pattern = encodeBarcode(element.format as BarcodeKind, value);
    if (pattern.bars.length === 0) {
      // 内容非法时画出提示框，便于设计时立刻发现问题
      ctx.strokeStyle = "#c33";
      ctx.lineWidth = Math.max(1, mm(0.2, rc));
      ctx.strokeRect(0, 0, w, h);
      ctx.fillStyle = "#c33";
      ctx.font = `${Math.max(8, ptToPx(6, rc.dpi))}px ${FONT_STACKS.sans}`;
      ctx.textBaseline = "top";
      ctx.fillText(pattern.warnings[0] ?? "条码内容不合法", 2, 2);
      return;
    }

    const textH = element.showText ? ptToPx(element.textSizePt, rc.dpi) * 1.35 : 0;
    const gap = element.showText ? mm(element.textGapMm, rc) : 0;
    const barH = Math.max(1, (h - textH - gap) * Math.max(0.1, Math.min(1, element.barHeightRatio)));

    const quiet = quietZoneUnits(element.format as BarcodeKind);
    const units = pattern.widths.reduce((a, b) => a + b, 0);
    const totalUnits = units + quiet * 2;
    // 自动铺满：静区也计入，保证扫码器能识别
    const unitWidth = element.autoFit
      ? w / totalUnits
      : mm(element.moduleWidthMm, rc);

    let x = element.autoFit ? 0 : Math.max(0, (w - totalUnits * unitWidth) / 2) + quiet * unitWidth;
    ctx.fillStyle = "#000";
    // 用 Math.round 对齐像素边界，避免细条被抗锯齿糊掉
    const drawX = x;
    let cursor = drawX;
    pattern.bars.forEach((isBar, index) => {
      const bw = pattern.widths[index] * unitWidth;
      if (isBar) {
        const left = Math.round(cursor);
        const right = Math.round(cursor + bw);
        ctx.fillRect(left, 0, Math.max(1, right - left), barH);
      }
      cursor += bw;
    });

    if (element.showText) {
      const textTop = barH + gap;
      ctx.fillStyle = "#000";
      ctx.font = `${ptToPx(element.textSizePt, rc.dpi)}px ${FONT_STACKS.mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const shown = element.showCheckDigit ? pattern.humanText : stripCheckDigit(pattern.humanText, element.format as BarcodeKind);
      ctx.fillText(shown, w / 2, textTop);
    }
  },
  properties: [
    { key: "value", label: "内容", type: "textarea", hint: "支持 {{变量名}}；EAN/UPC/ITF 会自动补全校验位" },
    { key: "format", label: "格式", type: "select", options: BARCODE_FORMATS },
    { key: "autoFit", label: "自动铺满宽度", type: "boolean" },
    {
      key: "moduleWidthMm",
      label: "窄条宽度",
      type: "number",
      min: 0.08,
      max: 1,
      step: 0.01,
      unit: "mm",
      visibleWhen: { key: "autoFit", equals: false },
      hint: "热敏机建议 ≥ 0.19mm（203dpi 下 2 点）",
    },
    { key: "barHeightRatio", label: "条高占比", type: "number", min: 0.2, max: 1, step: 0.05 },
    { key: "showText", label: "显示可读文字", type: "boolean" },
    { key: "showCheckDigit", label: "显示校验位", type: "boolean", visibleWhen: { key: "showText", equals: true } },
    { key: "textSizePt", label: "文字字号", type: "number", min: 4, max: 24, step: 0.5, unit: "pt", visibleWhen: { key: "showText", equals: true } },
    { key: "textGapMm", label: "条码与文字间距", type: "number", min: 0, max: 5, step: 0.1, unit: "mm", visibleWhen: { key: "showText", equals: true } },
  ],
};

/** 去掉 EAN/UPC 的人可读校验位（部分标签排版习惯如此） */
function stripCheckDigit(text: string, format: BarcodeKind): string {
  if (format === "ean13" || format === "upca") return text.slice(0, -1);
  if (format === "ean8") return text.slice(0, -1);
  return text;
}

// ---------------------------------------------------------------------------
// 二维码
// ---------------------------------------------------------------------------

const qrDef: ElementDefinition = {
  type: "qrcode",
  label: "二维码",
  icon: "qr-code",
  description: "QR Code（字节模式，UTF-8），适合网址、序列号、中文",
  create: (partial = {}) => ({
    ...baseElement("qrcode", "二维码"),
    kind: "qrcode",
    value: "https://example.com",
    ecc: "M",
    quietZone: 4,
    widthMm: 18,
    heightMm: 18,
    ...partial,
  }) as LabelElement,
  draw: (element, rc) => {
    if (element.kind !== "qrcode") return;
    const { ctx } = rc;
    const w = mm(element.widthMm, rc);
    const h = mm(element.heightMm, rc);
    const value = resolveVariables(element.value, rc.variables);
    const matrix = encodeQr(value, element.ecc);

    if (matrix.size === 0) {
      ctx.strokeStyle = "#c33";
      ctx.lineWidth = Math.max(1, mm(0.2, rc));
      ctx.strokeRect(0, 0, w, h);
      return;
    }

    const total = matrix.size + element.quietZone * 2;
    const module = Math.min(w, h) / total;
    const offsetX = (w - module * total) / 2 + module * element.quietZone;
    const offsetY = (h - module * total) / 2 + module * element.quietZone;

    ctx.fillStyle = "#000";
    for (let r = 0; r < matrix.size; r++) {
      for (let c = 0; c < matrix.size; c++) {
        if (!matrix.modules[r][c]) continue;
        const left = Math.round(offsetX + c * module);
        const top = Math.round(offsetY + r * module);
        const right = Math.round(offsetX + (c + 1) * module);
        const bottom = Math.round(offsetY + (r + 1) * module);
        ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
      }
    }
  },
  properties: [
    { key: "value", label: "内容", type: "textarea", hint: "支持 {{变量名}}；中文按 UTF-8 编码" },
    {
      key: "ecc",
      label: "纠错等级",
      type: "select",
      options: [
        { value: "L", label: "L（7%，容量最大）" },
        { value: "M", label: "M（15%，推荐）" },
        { value: "Q", label: "Q（25%）" },
        { value: "H", label: "H（30%，可覆盖遮挡）" },
      ],
      hint: "等级越高越抗污损，但同样内容需要更大的码",
    },
    { key: "quietZone", label: "静区（模块数）", type: "number", min: 0, max: 8, step: 1, hint: "标准为 4，不要小于 2" },
  ],
};

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

const imageDef: ElementDefinition = {
  type: "image",
  label: "图片",
  icon: "image",
  description: "Logo / 图形，支持二值化以适配热敏打印",
  create: (partial = {}) => ({
    ...baseElement("image", "图片"),
    kind: "image",
    dataUrl: "",
    fit: "contain",
    dither: true,
    threshold: 160,
    grayscale: true,
    widthMm: 20,
    heightMm: 20,
    ...partial,
  }) as LabelElement,
  draw: (element, rc) => {
    if (element.kind !== "image") return;
    const { ctx } = rc;
    const w = mm(element.widthMm, rc);
    const h = mm(element.heightMm, rc);
    if (!element.dataUrl) {
      ctx.save();
      ctx.strokeStyle = "#bbb";
      ctx.setLineDash([Math.max(2, mm(1, rc)), Math.max(2, mm(1, rc))]);
      ctx.lineWidth = Math.max(1, mm(0.2, rc));
      ctx.strokeRect(0, 0, w, h);
      ctx.restore();
      ctx.fillStyle = "#999";
      ctx.font = `${Math.max(8, ptToPx(7, rc.dpi))}px ${FONT_STACKS.sans}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("选择图片", w / 2, h / 2);
      return;
    }

    const image = getImageSync(element.dataUrl);
    if (!image) {
      // 图片尚未解码完成：先用占位框，解码完成后由调用方重绘
      loadImage(element.dataUrl).catch(() => undefined);
      ctx.strokeStyle = "#ddd";
      ctx.lineWidth = 1;
      ctx.strokeRect(0, 0, w, h);
      return;
    }

    // contain / cover / stretch 三种适配
    let dw = w;
    let dh = h;
    let dx = 0;
    let dy = 0;
    if (element.fit !== "stretch") {
      const scale =
        element.fit === "contain"
          ? Math.min(w / image.naturalWidth, h / image.naturalHeight)
          : Math.max(w / image.naturalWidth, h / image.naturalHeight);
      dw = image.naturalWidth * scale;
      dh = image.naturalHeight * scale;
      dx = (w - dw) / 2;
      dy = (h - dh) / 2;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, dx, dy, dw, dh);
    ctx.restore();

    // 二值化：热敏标签机只有黑/白两态，灰阶会被抖动成网点，反而糊
    if (element.dither) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.clip();
      applyThreshold(ctx, 0, 0, w, h, element.threshold);
      ctx.restore();
    }
  },
  properties: [
    { key: "dataUrl", label: "图片", type: "image", hint: "建议使用纯黑白的 PNG/JPEG" },
    {
      key: "fit",
      label: "适配方式",
      type: "select",
      options: [
        { value: "contain", label: "完整显示（留白）" },
        { value: "cover", label: "铺满（裁切）" },
        { value: "stretch", label: "拉伸变形" },
      ],
    },
    { key: "dither", label: "二值化", type: "boolean", hint: "热敏打印建议开启，避免灰度网点发糊" },
    { key: "threshold", label: "二值化阈值", type: "number", min: 0, max: 255, step: 1, visibleWhen: { key: "dither", equals: true } },
  ],
};

/** 在给定区域按亮度阈值把像素压成纯黑白 */
function applyThreshold(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  threshold: number,
): void {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  if (width * height > 12_000_000) return; // 超大图跳过，避免阻塞
  const data = ctx.getImageData(Math.round(x), Math.round(y), width, height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const alpha = px[i + 3];
    // 与白底合成后再判断，避免透明区域被判成黑
    const lum =
      ((px[i] * alpha + 255 * (255 - alpha)) / 255) * 0.299 +
      ((px[i + 1] * alpha + 255 * (255 - alpha)) / 255) * 0.587 +
      ((px[i + 2] * alpha + 255 * (255 - alpha)) / 255) * 0.114;
    const v = lum < threshold ? 0 : 255;
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
    px[i + 3] = 255;
  }
  ctx.putImageData(data, Math.round(x), Math.round(y));
}

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

const shapeDef: ElementDefinition = {
  type: "shape",
  label: "形状",
  icon: "shapes",
  description: "边框、分割线、圆角框与椭圆",
  create: (partial = {}) => ({
    ...baseElement("shape", "形状"),
    kind: "shape",
    shape: "rect",
    strokeWidthMm: 0.3,
    cornerRadiusMm: 1,
    filled: false,
    dash: "solid",
    widthMm: 30,
    heightMm: 12,
    ...partial,
  }) as LabelElement,
  draw: (element, rc) => {
    if (element.kind !== "shape") return;
    const { ctx } = rc;
    const w = mm(element.widthMm, rc);
    const h = mm(element.heightMm, rc);
    const stroke = Math.max(1, mm(element.strokeWidthMm, rc));
    ctx.save();
    ctx.lineWidth = stroke;
    ctx.strokeStyle = "#000";
    ctx.fillStyle = "#000";
    if (element.dash === "dot") ctx.setLineDash([stroke, stroke]);
    else if (element.dash === "dash") ctx.setLineDash([stroke * 4, stroke * 3]);
    else ctx.setLineDash([]);

    switch (element.shape) {
      case "line": {
        ctx.beginPath();
        // 线垂直居中，便于当分割线用
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();
        break;
      }
      case "ellipse": {
        ctx.beginPath();
        ctx.ellipse(w / 2, h / 2, Math.max(0.5, w / 2 - stroke / 2), Math.max(0.5, h / 2 - stroke / 2), 0, 0, Math.PI * 2);
        if (element.filled) ctx.fill();
        else ctx.stroke();
        break;
      }
      case "roundRect": {
        const r = mm(element.cornerRadiusMm, rc);
        roundRectPath(ctx, stroke / 2, stroke / 2, Math.max(0, w - stroke), Math.max(0, h - stroke), r);
        if (element.filled) ctx.fill();
        else ctx.stroke();
        break;
      }
      default: {
        ctx.beginPath();
        ctx.rect(stroke / 2, stroke / 2, Math.max(0, w - stroke), Math.max(0, h - stroke));
        if (element.filled) ctx.fill();
        else ctx.stroke();
      }
    }
    ctx.restore();
  },
  properties: [
    {
      key: "shape",
      label: "形状",
      type: "select",
      options: [
        { value: "rect", label: "矩形边框" },
        { value: "roundRect", label: "圆角边框" },
        { value: "line", label: "直线 / 分割线" },
        { value: "ellipse", label: "椭圆" },
      ],
    },
    { key: "strokeWidthMm", label: "线宽", type: "number", min: 0.05, max: 3, step: 0.05, unit: "mm" },
    { key: "cornerRadiusMm", label: "圆角半径", type: "number", min: 0, max: 20, step: 0.5, unit: "mm", visibleWhen: { key: "shape", equals: "roundRect" } },
    { key: "filled", label: "填充", type: "boolean", visibleWhen: { key: "shape", equals: "rect" } },
    {
      key: "dash",
      label: "线型",
      type: "select",
      options: [
        { value: "solid", label: "实线" },
        { value: "dot", label: "点线" },
        { value: "dash", label: "虚线" },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 注册内置元素
// ---------------------------------------------------------------------------

registerElement(textDef);
registerElement(barcodeDef);
registerElement(qrDef);
registerElement(imageDef);
registerElement(shapeDef);

/** 形状子类型对应的图标（属性面板与图层列表用） */
export function shapeKindIcon(shape: string): IconName {
  switch (shape) {
    case "roundRect":
      return "square-round-corner";
    case "line":
      return "minus";
    case "ellipse":
      return "circle";
    default:
      return "square";
  }
}

/** 该元素类型在界面上使用的图标 */
export function elementTypeIcon(type: ElementType): IconName {
  return getElementDefinition(type).icon;
}