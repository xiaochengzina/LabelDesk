/**
 * LabelDesk 数据模型
 *
 * 坐标与尺寸一律使用毫米（mm），这是标签世界里的通用单位，
 * 也是它比像素方案更可靠的原因：同一个模板在 203dpi / 300dpi 打印机上物理尺寸一致。
 */

export const LAYOUT_FORMAT_VERSION = 1;

/** 常用标签纸规格，方便快速新建。 */
export interface MediaPreset {
  id: string;
  label: string;
  widthMm: number;
  heightMm: number;
  /** 标签之间的间隙（毫米），连续纸填 0 */
  gapMm: number;
  /** 一行的标签列数（例如三联纸） */
  columns?: number;
  note?: string;
}

export const MEDIA_PRESETS: MediaPreset[] = [
  { id: "40x30", label: "40 × 30 mm", widthMm: 40, heightMm: 30, gapMm: 2, note: "最常用的货架/商品标" },
  { id: "50x30", label: "50 × 30 mm", widthMm: 50, heightMm: 30, gapMm: 2 },
  { id: "60x40", label: "60 × 40 mm", widthMm: 60, heightMm: 40, gapMm: 2, note: "条码 + 品名" },
  { id: "70x50", label: "70 × 50 mm", widthMm: 70, heightMm: 50, gapMm: 2 },
  { id: "80x60", label: "80 × 60 mm", widthMm: 80, heightMm: 60, gapMm: 2, note: "快递面单小号" },
  { id: "100x100", label: "100 × 100 mm", widthMm: 100, heightMm: 100, gapMm: 2 },
  { id: "100x150", label: "100 × 150 mm", widthMm: 100, heightMm: 150, gapMm: 2, note: "标准快递面单" },
  { id: "30x20", label: "30 × 20 mm", widthMm: 30, heightMm: 20, gapMm: 2, note: "线缆/资产小标" },
  { id: "25x15", label: "25 × 15 mm", widthMm: 25, heightMm: 15, gapMm: 2, note: "极小标识" },
  { id: "60x40x3", label: "60 × 40 mm × 3 联", widthMm: 60, heightMm: 40, gapMm: 2, columns: 3 },
];

/** 版式与打印参数，随模板一起保存，保证换台电脑也能打出一样的尺寸。 */
export interface LabelSettings {
  widthMm: number;
  heightMm: number;
  /** 标签间隙（黑标纸请用 gapMode: "bline"） */
  gapMm: number;
  gapOffsetMm: number;
  gapMode: "gap" | "bline" | "continuous";
  /** 合并成一行的标签列数（多联纸）。1 表示单列。 */
  columns: number;
  /** 边距（毫米），仅用于设计时的对齐参考线 */
  marginMm: number;
  /** 是否显示网格 */
  showGrid: boolean;
  gridStepMm: number;
}

/** 元素通用字段 */
export interface BaseElement {
  id: string;
  name: string;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  /** 顺时针旋转角度（度） */
  rotation: number;
  locked: boolean;
  visible: boolean;
  /** 打印浓度微调：1 表示保留，0 表示跳过（配合条件打印使用） */
  opacity: number;
}

export type TextAlign = "left" | "center" | "right";
export type VerticalAlign = "top" | "middle" | "bottom";
export type FontFamily = "sans" | "serif" | "mono";

export interface TextProps {
  kind: "text";
  text: string;
  fontFamily: FontFamily;
  /** 字号，单位 pt。1pt = 1/72 英寸，打印时按 DPI 精确换算 */
  fontSizePt: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: TextAlign;
  verticalAlign: VerticalAlign;
  /** 行距倍数 */
  lineHeight: number;
  letterSpacingPt: number;
  /** 自动缩小字号以塞进元素框，避免文字被裁切 */
  autoShrink: boolean;
  /** 超出框时是否裁切 */
  clip: boolean;
}

export type BarcodeFormat = "code128" | "code39" | "ean13" | "ean8" | "upca" | "itf14";

export interface BarcodeProps {
  kind: "barcode";
  value: string;
  format: BarcodeFormat;
  /** 条码与下方文字的间距（毫米） */
  textGapMm: number;
  showText: boolean;
  /** 文字字号（pt） */
  textSizePt: number;
  /** 是否显示校验位（EAN/UPC 常用） */
  showCheckDigit: boolean;
  /** 窄条宽度自动铺满元素框；关闭后用 moduleWidthMm 固定 */
  autoFit: boolean;
  moduleWidthMm: number;
  /** 条码高度占元素框的比例（0.1 - 1） */
  barHeightRatio: number;
}

export type QrEcc = "L" | "M" | "Q" | "H";

export interface QrProps {
  kind: "qrcode";
  value: string;
  ecc: QrEcc;
  /** 静区（模块数），标准为 4 */
  quietZone: number;
}

export interface ImageProps {
  kind: "image";
  /** data URL；为空时画占位框 */
  dataUrl: string;
  /** contain = 完整显示，cover = 铺满裁切，stretch = 拉伸 */
  fit: "contain" | "cover" | "stretch";
  /** 是否按亮度阈值转为纯黑白（热敏打印推荐开启） */
  dither: boolean;
  /** 二值化阈值 */
  threshold: number;
  grayscale: boolean;
}

export type ShapeKind = "rect" | "roundRect" | "line" | "ellipse";

export interface ShapeProps {
  kind: "shape";
  shape: ShapeKind;
  strokeWidthMm: number;
  cornerRadiusMm: number;
  /** 是否填充内部 */
  filled: boolean;
  /** 线型 */
  dash: "solid" | "dot" | "dash";
}

export type LabelElement =
  | (BaseElement & TextProps)
  | (BaseElement & BarcodeProps)
  | (BaseElement & QrProps)
  | (BaseElement & ImageProps)
  | (BaseElement & ShapeProps);

export type ElementType = LabelElement["kind"];

/** 每台打印机的建议参数，可保存进模板以便一键复用。 */
export interface PrinterProfile {
  name: string;
  /** driver = 走 Windows 驱动（通用）；raw = 直接下发指令（热敏机更稳） */
  channel: "driver" | "raw";
  language: "tspl" | "escpos" | "zpl";
  /** 目标打印头分辨率（dpi） */
  dpi: number;
  /** 打印浓度 0-15（TSPL DENSITY） */
  density: number;
  /** 走纸速度 1-15 ips（TSPL SPEED） */
  speed: number;
  copies: number;
  /** 二值化阈值 0-255 */
  threshold: number;
  /** 反转 TSPL 位极性（部分国产固件与手册相反） */
  invertBits: boolean;
  /** 驱动通路的纸张名（留空使用打印机默认纸张） */
  paperName?: string;
}

export const DEFAULT_PRINTER_PROFILE: PrinterProfile = {
  name: "",
  channel: "driver",
  language: "tspl",
  dpi: 203,
  density: 8,
  speed: 4,
  copies: 1,
  threshold: 160,
  invertBits: false,
};

export interface LabelLayout {
  version: number;
  id: string;
  name: string;
  /** 模板说明 */
  note: string;
  settings: LabelSettings;
  elements: LabelElement[];
  /** 打印参数（按打印机保存最近一次使用的配置） */
  printer?: PrinterProfile;
  /** 变量默认值，可在打印时覆盖 */
  variables: Record<string, string>;
  createdAtMs: number;
  updatedAtMs: number;
}

export const DEFAULT_SETTINGS: LabelSettings = {
  widthMm: 40,
  heightMm: 30,
  gapMm: 2,
  gapOffsetMm: 0,
  gapMode: "gap",
  columns: 1,
  marginMm: 1,
  showGrid: true,
  gridStepMm: 5,
};

export function createLayout(name = "未命名标签", settings?: Partial<LabelSettings>): LabelLayout {
  const now = Date.now();
  return {
    version: LAYOUT_FORMAT_VERSION,
    id: name,
    name,
    note: "",
    settings: { ...DEFAULT_SETTINGS, ...settings },
    elements: [],
    printer: undefined,
    variables: {},
    createdAtMs: now,
    updatedAtMs: now,
  };
}

let idCounter = 0;
/** 生成稳定且可读的元素 id（避免依赖 crypto，方便测试）。 */
export function newElementId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}
