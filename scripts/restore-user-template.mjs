/**
 * 恢复「笔记本标签」模板。
 *
 * 按用户在应用里调好的版式重建：50×30mm、4 个元素、6 个字段映射。
 * 模板文件丢失时用它重建（避免重新在界面里摆一遍）。
 *
 *   node scripts/restore-user-template.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const appData = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? ".", "AppData", "Roaming");
const layoutsDir = path.join(appData, "com.labeldesk.app", "layouts");
const target = path.join(layoutsDir, "笔记本标签.ldl.json");

/** 用户保存的版式：入库信息放在底部一行，去掉标题/边框/二维码 */
const layout = {
  version: 1,
  id: "笔记本标签",
  name: "笔记本标签",
  note: "50×30mm，贴笔记本底壳。字段顺序：型号/入库时间/配置/价格/回收人/序列号",
  settings: {
    widthMm: 50,
    heightMm: 30,
    gapMm: 2,
    gapOffsetMm: 0,
    gapMode: "gap",
    columns: 1,
    marginMm: 1,
    showGrid: true,
    gridStepMm: 2,
  },
  elements: [
    {
      id: "t-model",
      kind: "text",
      name: "型号",
      xMm: 2,
      yMm: 4.3,
      widthMm: 34,
      heightMm: 6,
      rotation: 0,
      locked: false,
      visible: true,
      opacity: 1,
      text: "{{型号}}",
      fontFamily: "sans",
      fontSizePt: 11,
      bold: true,
      italic: false,
      underline: false,
      align: "left",
      verticalAlign: "top",
      lineHeight: 1.25,
      letterSpacingPt: 0,
      autoShrink: true,
      clip: true,
    },
    {
      id: "t-config",
      kind: "text",
      name: "配置",
      xMm: 2,
      yMm: 9.1,
      widthMm: 43,
      heightMm: 6,
      rotation: 0,
      locked: false,
      visible: true,
      opacity: 1,
      text: "{{配置}}",
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
    },
    {
      id: "bc-sn",
      kind: "barcode",
      name: "序列号条码",
      xMm: 2.2,
      yMm: 13.1,
      widthMm: 36,
      heightMm: 12,
      rotation: 0,
      locked: false,
      visible: true,
      opacity: 1,
      value: "{{SN}}",
      format: "code128",
      autoFit: true,
      moduleWidthMm: 0.25,
      barHeightRatio: 0.75,
      showText: true,
      showCheckDigit: true,
      textSizePt: 8,
      textGapMm: 0.8,
    },
    {
      id: "t-intake",
      kind: "text",
      name: "入库信息",
      xMm: 2,
      yMm: 22.4,
      widthMm: 43,
      heightMm: 5.5,
      rotation: 0,
      locked: false,
      visible: true,
      opacity: 1,
      text: "入库 {{入库时间}}　回收人 {{回收人}}　¥{{价格}}",
      fontFamily: "sans",
      fontSizePt: 9,
      bold: false,
      italic: false,
      underline: false,
      align: "left",
      verticalAlign: "top",
      lineHeight: 1.25,
      letterSpacingPt: 0,
      autoShrink: true,
      clip: true,
    },
  ],
  printer: {
    name: "Deli DL-888D(NEW)",
    channel: "raw",
    language: "tspl",
    dpi: 203,
    density: 8,
    speed: 4,
    copies: 1,
    threshold: 160,
    invertBits: false,
    offsetXMm: 0,
    offsetYMm: 0,
  },
  variables: {
    型号: "ThinkPad X1 Carbon Gen 9",
    配置: "i7-1165G7 / 16G / 512G SSD",
    入库时间: "2024-03-15",
    价格: "3280",
    回收人: "张伟",
    SN: "PF2ABCDE",
  },
  fields: [
    { column: 0, label: "笔记本型号", variable: "型号", sample: "ThinkPad X1 Carbon Gen 9" },
    { column: 1, label: "入库时间", variable: "入库时间", sample: "2024-03-15" },
    { column: 2, label: "电脑配置", variable: "配置", sample: "i7-1165G7 / 16G / 512G SSD" },
    { column: 3, label: "入库价格", variable: "价格", sample: "3280" },
    { column: 4, label: "回收人", variable: "回收人", sample: "张伟" },
    { column: 5, label: "笔记本序列号", variable: "SN", sample: "PF2ABCDE" },
  ],
};

mkdirSync(layoutsDir, { recursive: true });
writeFileSync(target, JSON.stringify(layout, null, 2), "utf8");

console.log(`已恢复模板：${target}`);
console.log(`  尺寸 ${layout.settings.widthMm} × ${layout.settings.heightMm} mm`);
console.log(`  元素 ${layout.elements.length} 个：${layout.elements.map((e) => e.name).join("、")}`);
console.log(`  字段映射 ${layout.fields.length} 项：${layout.fields.map((f) => f.label).join("、")}`);
