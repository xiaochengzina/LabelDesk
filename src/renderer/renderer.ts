/**
 * 画布渲染器。
 *
 * 设计要点：
 * - 所有几何以毫米描述，渲染时按 DPI 换算成像素，因此屏幕预览、驱动打印、
 *   原始指令打印三条路径输出完全一致。
 * - 渲染是纯函数：给定 (模板, DPI, 选项) 就得到确定的画布内容，
 *   便于「导出 PNG / 打印预览 / 真机打印」复用同一份代码。
 */

import type { LabelElement, LabelLayout } from "../model/types";
import { mmToPx, hitTestRotated, rotatedCorners, type Rect } from "../model/units";
import { getElementDefinition, type RenderContext } from "./elements";

export interface RenderOptions {
  /** 目标 DPI，决定画布像素尺寸 */
  dpi: number;
  /** 变量替换表 */
  variables?: Record<string, string>;
  /** 是否绘制设计辅助（网格、边距、选中框） */
  overlay?: OverlayOptions;
  /** 白底填充（预览需要，热敏打印时也必须是白底） */
  background?: string;
}

export interface OverlayOptions {
  showGrid: boolean;
  gridStepMm: number;
  showMargin: boolean;
  marginMm: number;
  selectedIds: string[];
  /** 鼠标悬停中的元素 */
  hoverId?: string | null;
  /** 正在框选的矩形（毫米） */
  marquee?: Rect | null;
}

/** 元素在画布上的像素矩形 */
export function elementPixelRect(element: LabelElement, dpi: number): Rect {
  return {
    x: mmToPx(element.xMm, dpi),
    y: mmToPx(element.yMm, dpi),
    width: mmToPx(element.widthMm, dpi),
    height: mmToPx(element.heightMm, dpi),
  };
}

export function createRenderContext(
  ctx: CanvasRenderingContext2D,
  layout: LabelLayout,
  options: RenderOptions,
): RenderContext {
  return {
    ctx,
    dpi: options.dpi,
    widthMm: layout.settings.widthMm,
    heightMm: layout.settings.heightMm,
    variables: options.variables ?? layout.variables ?? {},
    forPrint: !options.overlay,
  };
}

/** 绘制单个元素（含旋转与透明度）。 */
export function drawElement(
  ctx: CanvasRenderingContext2D,
  element: LabelElement,
  rc: RenderContext,
): void {
  if (!element.visible || element.opacity <= 0) return;
  const def = getElementDefinition(element.kind);
  const x = mmToPx(element.xMm, rc.dpi);
  const y = mmToPx(element.yMm, rc.dpi);
  const w = mmToPx(element.widthMm, rc.dpi);
  const h = mmToPx(element.heightMm, rc.dpi);

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, element.opacity));
  if (element.rotation) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.translate(cx, cy);
    ctx.rotate((element.rotation * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);
  } else {
    ctx.translate(x, y);
  }
  // 元素自身的绘制以 (0,0) 为左上角
  def.draw(element, rc);
  ctx.restore();
}

/**
 * 渲染整张标签到画布。
 * 画布尺寸由 DPI 与标签物理尺寸决定，调用方需先设置好 canvas.width/height。
 */
export function renderLayout(
  ctx: CanvasRenderingContext2D,
  layout: LabelLayout,
  options: RenderOptions,
): void {
  const rc = createRenderContext(ctx, layout, options);
  const widthPx = Math.round(mmToPx(layout.settings.widthMm, options.dpi));
  const heightPx = Math.round(mmToPx(layout.settings.heightMm, options.dpi));

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, widthPx, heightPx);
  ctx.fillStyle = options.background ?? "#ffffff";
  ctx.fillRect(0, 0, widthPx, heightPx);

  for (const element of layout.elements) {
    drawElement(ctx, element, rc);
  }

  if (options.overlay) {
    drawOverlay(ctx, layout, options, widthPx, heightPx);
  }
  ctx.restore();
}

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  layout: LabelLayout,
  options: RenderOptions,
  widthPx: number,
  heightPx: number,
): void {
  const overlay = options.overlay;
  if (!overlay) return;
  const dpi = options.dpi;

  // 网格
  if (overlay.showGrid && overlay.gridStepMm > 0) {
    const step = mmToPx(overlay.gridStepMm, dpi);
    if (step >= 4) {
      ctx.save();
      ctx.strokeStyle = "rgba(64, 128, 200, 0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = step; x < widthPx; x += step) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, heightPx);
      }
      for (let y = step; y < heightPx; y += step) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(widthPx, Math.round(y) + 0.5);
      }
      ctx.stroke();
      // 每 5 格加一条重线，便于快速定位
      ctx.strokeStyle = "rgba(64, 128, 200, 0.32)";
      ctx.beginPath();
      for (let i = 5; i * step < widthPx; i += 5) {
        ctx.moveTo(Math.round(i * step) + 0.5, 0);
        ctx.lineTo(Math.round(i * step) + 0.5, heightPx);
      }
      for (let i = 5; i * step < heightPx; i += 5) {
        ctx.moveTo(0, Math.round(i * step) + 0.5);
        ctx.lineTo(widthPx, Math.round(i * step) + 0.5);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // 边距参考线
  if (overlay.showMargin && overlay.marginMm > 0) {
    const m = mmToPx(overlay.marginMm, dpi);
    ctx.save();
    ctx.strokeStyle = "rgba(220, 120, 40, 0.55)";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(m) + 0.5, Math.round(m) + 0.5, Math.round(widthPx - 2 * m), Math.round(heightPx - 2 * m));
    ctx.restore();
  }

  // 悬停高亮
  if (overlay.hoverId && !overlay.selectedIds.includes(overlay.hoverId)) {
    const hovered = layout.elements.find((e) => e.id === overlay.hoverId);
    if (hovered) {
      ctx.save();
      ctx.strokeStyle = "rgba(90, 150, 220, 0.7)";
      ctx.lineWidth = 1.5;
      strokeRotatedRect(ctx, hovered, dpi);
      ctx.restore();
    }
  }

  // 选中框 + 手柄
  for (const id of overlay.selectedIds) {
    const element = layout.elements.find((e) => e.id === id);
    if (!element) continue;
    const rect = elementPixelRect(element, dpi);
    ctx.save();
    ctx.strokeStyle = element.locked ? "#b08040" : "#1a73e8";
    ctx.lineWidth = 2;
    strokeRotatedRect(ctx, element, dpi);
    ctx.restore();

    // 旋转元素时手柄随元素一起旋转，保持直觉一致
    ctx.save();
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate((element.rotation * Math.PI) / 180);
    ctx.translate(-rect.width / 2, -rect.height / 2);

    const handleSize = 8;
    const handles: Array<[number, number]> = [
      [0, 0],
      [rect.width, 0],
      [rect.width, rect.height],
      [0, rect.height],
      [rect.width / 2, 0],
      [rect.width, rect.height / 2],
      [rect.width / 2, rect.height],
      [0, rect.height / 2],
    ];
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = element.locked ? "#b08040" : "#1a73e8";
    ctx.lineWidth = 1.5;
    for (const [hx, hy] of handles) {
      ctx.beginPath();
      ctx.rect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
      ctx.fill();
      ctx.stroke();
    }

    // 旋转手柄
    if (!element.locked) {
      ctx.beginPath();
      ctx.moveTo(rect.width / 2, 0);
      ctx.lineTo(rect.width / 2, -18);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(rect.width / 2, -22, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#1a73e8";
      ctx.fill();
    }
    ctx.restore();
  }

  // 框选矩形
  if (overlay.marquee) {
    const m = overlay.marquee;
    ctx.save();
    ctx.fillStyle = "rgba(26, 115, 232, 0.12)";
    ctx.strokeStyle = "#1a73e8";
    ctx.lineWidth = 1;
    ctx.fillRect(mmToPx(m.x, dpi), mmToPx(m.y, dpi), mmToPx(m.width, dpi), mmToPx(m.height, dpi));
    ctx.strokeRect(mmToPx(m.x, dpi), mmToPx(m.y, dpi), mmToPx(m.width, dpi), mmToPx(m.height, dpi));
    ctx.restore();
  }
}

function strokeRotatedRect(
  ctx: CanvasRenderingContext2D,
  element: LabelElement,
  dpi: number,
): void {
  const rect = elementPixelRect(element, dpi);
  const corners = rotatedCorners(rect, element.rotation);
  ctx.beginPath();
  corners.forEach((p, index) => {
    if (index === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.stroke();
}

/** 命中测试：从最上层（数组末尾）往下找。 */
export function hitTest(
  layout: LabelLayout,
  xMm: number,
  yMm: number,
  dpi: number,
): LabelElement | null {
  for (let i = layout.elements.length - 1; i >= 0; i--) {
    const element = layout.elements[i];
    if (!element.visible) continue;
    const rect = elementPixelRect(element, dpi);
    const px = mmToPx(xMm, dpi);
    const py = mmToPx(yMm, dpi);
    if (hitTestRotated(rect, element.rotation, px, py)) return element;
  }
  return null;
}

/** 框选命中：与元素包围盒相交即算选中。 */
export function hitTestRect(layout: LabelLayout, rectMm: Rect): LabelElement[] {
  const x2 = rectMm.x + rectMm.width;
  const y2 = rectMm.y + rectMm.height;
  return layout.elements.filter((element) => {
    if (!element.visible) return false;
    const corners = rotatedCorners(
      { x: element.xMm, y: element.yMm, width: element.widthMm, height: element.heightMm },
      element.rotation,
    );
    const minX = Math.min(...corners.map((p) => p.x));
    const maxX = Math.max(...corners.map((p) => p.x));
    const minY = Math.min(...corners.map((p) => p.y));
    const maxY = Math.max(...corners.map((p) => p.y));
    return !(maxX < rectMm.x || minX > x2 || maxY < rectMm.y || minY > y2);
  });
}

/**
 * 把整张标签渲染成 PNG data URL。
 * `binaryThreshold` 为真时做纯黑白二值化，适合热敏打印与原始指令通路。
 */
export function renderToDataUrl(
  layout: LabelLayout,
  options: RenderOptions & { binaryThreshold?: number | null },
): string {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(mmToPx(layout.settings.widthMm, options.dpi)));
  canvas.height = Math.max(1, Math.round(mmToPx(layout.settings.heightMm, options.dpi)));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("无法创建画布上下文");

  renderLayout(ctx, layout, { ...options, overlay: undefined, background: "#ffffff" });

  if (options.binaryThreshold != null) {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = imageData.data;
    const t = options.binaryThreshold;
    for (let i = 0; i < px.length; i += 4) {
      const lum = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
      const v = lum < t ? 0 : 255;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
  }

  return canvas.toDataURL("image/png");
}
