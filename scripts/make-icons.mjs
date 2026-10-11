/**
 * 从 @iconify-json/lucide 生成精简图标模块。
 *
 * 为什么生成而不是直接用图标库：
 * - 运行时不引入依赖，也不联网；打包体积只增加实际用到的这几十个图标
 * - 不在源码里手工抄 SVG 路径（抄错一个数字图标就变形了）
 * - 生成的 src/components/icons.ts 会被提交，构建不依赖本脚本
 *
 *   node scripts/make-icons.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const lucide = JSON.parse(
  readFileSync(path.resolve("node_modules/@iconify-json/lucide/icons.json"), "utf8"),
);

/**
 * 需要生成到模块里的图标。
 * 键 = 生成后的常量名，值 = Lucide 图标名。
 */
const ICONS = {
  // 元素类型
  TextIcon: "type",
  BarcodeIcon: "barcode",
  QrCodeIcon: "qr-code",
  ImageIcon: "image",
  ShapesIcon: "shapes",
  ListIcon: "list",
  // 形状子类
  SquareIcon: "square",
  SquareRoundIcon: "square-round-corner",
  CircleIcon: "circle",
  MinusIcon: "minus",
  // 模板与文件
  NewIcon: "file-plus",
  OpenIcon: "folder-open",
  SaveIcon: "save",
  SaveAsIcon: "copy",
  ExportPngIcon: "download",
  ExportTemplateIcon: "file-up",
  ImportTemplateIcon: "upload",
  // 编辑
  UndoIcon: "undo-2",
  RedoIcon: "redo-2",
  TrashIcon: "trash",
  PlusIcon: "plus",
  // 对齐与分布
  AlignLeftIcon: "align-horizontal-justify-start",
  AlignHCenterIcon: "align-horizontal-justify-center",
  AlignRightIcon: "align-horizontal-justify-end",
  AlignTopIcon: "align-vertical-justify-start",
  AlignVCenterIcon: "align-vertical-justify-center",
  AlignBottomIcon: "align-vertical-justify-end",
  DistributeHIcon: "align-horizontal-space-between",
  DistributeVIcon: "align-vertical-space-between",
  // 图层
  VisibleIcon: "eye",
  HiddenIcon: "eye-off",
  LockedIcon: "lock",
  UnlockedIcon: "lock-open",
  MoveUpIcon: "chevron-up",
  MoveDownIcon: "chevron-down",
  // 视图与打印
  ZoomInIcon: "zoom-in",
  ZoomOutIcon: "zoom-out",
  FitIcon: "maximize",
  PrinterIcon: "printer",
  SettingsIcon: "settings-2",
  VariableIcon: "variable",
  // 状态
  CloseIcon: "x",
  CheckIcon: "check",
  WarningIcon: "triangle-alert",
  InfoIcon: "info",
  ScanIcon: "scan-line",
};

const missing = Object.values(ICONS).filter((n) => !lucide.icons[n]);
if (missing.length > 0) {
  console.error(`以下图标在 Lucide 中不存在：${missing.join(", ")}`);
  process.exit(1);
}

/** Lucide 默认是 24×24 描边图标，属性名已是 kebab-case，body 可直接内联。 */
const entries = Object.entries(ICONS).map(([constName, iconName]) => {
  const icon = lucide.icons[iconName];
  const body = icon.body.trim().replace(/\s+/g, " ");
  return { constName, iconName, body };
});

const header = `/**
 * 图标模块 —— 由 scripts/make-icons.mjs 自动生成，请勿手工编辑。
 *
 * 图标来源：Lucide（https://lucide.dev）
 * 许可：ISC License，Copyright (c) Lucide Contributors
 * 数据来源：@iconify-json/lucide v${JSON.parse(readFileSync(path.resolve("node_modules/@iconify-json/lucide/package.json"), "utf8")).version}
 *
 * 重新生成：node scripts/make-icons.mjs
 */

/** 图标名 → SVG 内容（不含 <svg> 外壳） */
export const ICON_PATHS = {`;

const bodyLines = entries
  .map((e) => `  ${JSON.stringify(e.iconName)}: ${JSON.stringify(e.body)},`)
  .join("\n");

const footer = `} as const;

export type IconName = keyof typeof ICON_PATHS;
`;

const namedExports =
  "\n" +
  entries
    .map((e) => `/** \`${e.iconName}\` */\nexport const ${e.constName}: IconName = ${JSON.stringify(e.iconName)};`)
    .join("\n") +
  "\n";

writeFileSync(
  path.resolve("src/components/icons.ts"),
  `${header}\n${bodyLines}\n${footer}${namedExports}`,
  "utf8",
);

console.log(`已生成 src/components/icons.ts`);
console.log(`  图标数：${entries.length}`);
console.log(`  来源：Lucide ${JSON.parse(readFileSync(path.resolve("node_modules/@iconify-json/lucide/package.json"), "utf8")).version}（ISC）`);
