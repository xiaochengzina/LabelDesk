/**
 * 设计画布。
 *
 * 交互模型与常见设计软件一致：
 * - 空白处拖动 = 框选；元素上拖动 = 移动；Shift 加选
 * - 八个手柄缩放，顶部圆点旋转（Shift 吸附 15°）
 * - 拖动过程不进历史，松手才生成一条撤销记录
 * - 方向键微调 0.1mm，Shift + 方向键 1mm
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type { LabelElement } from "../model/types";
import {
  clamp,
  mmToPx,
  pxToMm,
  snap,
  type Rect,
} from "../model/units";
import { hitTest, hitTestRect, renderLayout } from "../renderer/renderer";
import { onImageLoaded, preloadImages, releaseUnused } from "../renderer/images";
import {
  beginInteraction,
  clearSelection,
  endInteraction,
  getState,
  removeElements,
  select,
  selectAll,
  setFitZoom,
  setHover,
  setZoom,
  toggleSelected,
  undo,
  redo,
  useEditor,
  updateElementsLiveMap,
} from "../state/store";

/** 设计基准 DPI：影响画布像素密度，与最终打印 DPI 无关 */
const DESIGN_DPI = 203;

type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate";

interface DragState {
  mode: "move" | "resize" | "rotate" | "marquee";
  handle?: HandleId;
  startXMm: number;
  startYMm: number;
  /** 起始时各元素的几何快照 */
  initial: Map<string, Pick<LabelElement, "xMm" | "yMm" | "widthMm" | "heightMm" | "rotation">>;
  centerXMm: number;
  centerYMm: number;
  startAngle: number;
  moved: boolean;
}

export function DesignCanvas(): JSX.Element {
  const doc = useEditor((s) => s.doc);
  const selectedIds = useEditor((s) => s.selectedIds);
  const hoverId = useEditor((s) => s.hoverId);
  const zoom = useEditor((s) => s.zoom);
  const autoFit = useEditor((s) => s.autoFit);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  /** 图片解码完成后重绘 */
  const [imageTick, setImageTick] = useState(0);

  useEffect(() => onImageLoaded(() => setImageTick((t) => t + 1)), []);

  // 模板里的图片预加载；同时释放不再引用的缓存，避免长时间编辑后内存增长
  useEffect(() => {
    const urls = doc.elements
      .filter((e) => e.kind === "image")
      .map((e) => (e as { dataUrl: string }).dataUrl)
      .filter((url) => url.length > 0);
    preloadImages(urls);
    releaseUnused(new Set(urls));
  }, [doc.elements]);

  const widthPx = Math.max(1, Math.round(mmToPx(doc.settings.widthMm, DESIGN_DPI)));
  const heightPx = Math.max(1, Math.round(mmToPx(doc.settings.heightMm, DESIGN_DPI)));
  const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);

  const options = useMemo(
    () => ({
      dpi: DESIGN_DPI,
      variables: doc.variables,
      background: "#ffffff",
    }),
    [doc.variables],
  );

  // 主画布：内容渲染
  useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas) return;
    canvas.width = Math.round(widthPx * dpr);
    canvas.height = Math.round(heightPx * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderLayout(ctx, doc, options);
  }, [doc, options, widthPx, heightPx, dpr, imageTick]);

  // 叠加层：网格、选中框、手柄
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    canvas.width = Math.round(widthPx * dpr);
    canvas.height = Math.round(heightPx * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, widthPx, heightPx);
    renderLayout(ctx, doc, {
      ...options,
      overlay: {
        showGrid: doc.settings.showGrid,
        gridStepMm: doc.settings.gridStepMm,
        showMargin: true,
        marginMm: doc.settings.marginMm,
        selectedIds,
        hoverId,
        marquee,
      },
    });
  }, [doc, options, selectedIds, hoverId, marquee, widthPx, heightPx, dpr]);

  // ------------------------------------------------------------------
  // 坐标换算
  // ------------------------------------------------------------------

  const toMm = useCallback(
    (event: { clientX: number; clientY: number } | PointerEvent | MouseEvent) => {
      const canvas = overlayRef.current;
      if (!canvas) return { xMm: 0, yMm: 0 };
      const rect = canvas.getBoundingClientRect();
      const xPx = ((event.clientX - rect.left) / rect.width) * widthPx;
      const yPx = ((event.clientY - rect.top) / rect.height) * heightPx;
      return { xMm: pxToMm(xPx, DESIGN_DPI), yMm: pxToMm(yPx, DESIGN_DPI) };
    },
    [widthPx, heightPx],
  );

  const handleAt = useCallback(
    (xMm: number, yMm: number): { element: LabelElement; handle: HandleId } | null => {
      const toleranceMm = pxToMm(10, DESIGN_DPI * zoom);
      for (let i = doc.elements.length - 1; i >= 0; i--) {
        const element = doc.elements[i];
        if (!selectedIds.includes(element.id) || element.locked) continue;
        const cx = element.xMm + element.widthMm / 2;
        const cy = element.yMm + element.heightMm / 2;
        const rad = (-element.rotation * Math.PI) / 180;
        const dx = xMm - cx;
        const dy = yMm - cy;
        const lx = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
        const ly = cy + dx * Math.sin(rad) + dy * Math.cos(rad);

        // 旋转手柄
        const rotateHandle = { x: cx, y: element.yMm - pxToMm(22 + 10, DESIGN_DPI) };
        const rdx = xMm - rotateHandle.x;
        const rdy = yMm - rotateHandle.y;
        if (Math.hypot(rdx, rdy) <= toleranceMm * 1.6) {
          return { element, handle: "rotate" };
        }

        const anchors: Array<[HandleId, number, number]> = [
          ["nw", element.xMm, element.yMm],
          ["n", cx, element.yMm],
          ["ne", element.xMm + element.widthMm, element.yMm],
          ["e", element.xMm + element.widthMm, cy],
          ["se", element.xMm + element.widthMm, element.yMm + element.heightMm],
          ["s", cx, element.yMm + element.heightMm],
          ["sw", element.xMm, element.yMm + element.heightMm],
          ["w", element.xMm, cy],
        ];
        for (const [id, ax, ay] of anchors) {
          if (Math.hypot(lx - ax, ly - ay) <= toleranceMm) return { element, handle: id };
        }
      }
      return null;
    },
    [doc.elements, selectedIds, zoom],
  );

  // ------------------------------------------------------------------
  // 拖动
  // ------------------------------------------------------------------

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (event.button !== 0) return;
      const { xMm, yMm } = toMm(event);
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);

      // 1) 手柄优先
      const handle = handleAt(xMm, yMm);
      if (handle) {
        const element = handle.element;
        beginInteraction();
        const initial = new Map(
          selectedIds
            .map((id) => doc.elements.find((e) => e.id === id))
            .filter((e): e is LabelElement => Boolean(e))
            .map((e) => [e.id, { xMm: e.xMm, yMm: e.yMm, widthMm: e.widthMm, heightMm: e.heightMm, rotation: e.rotation }]),
        );
        const cx = element.xMm + element.widthMm / 2;
        const cy = element.yMm + element.heightMm / 2;
        dragRef.current = {
          mode: handle.handle === "rotate" ? "rotate" : "resize",
          handle: handle.handle,
          startXMm: xMm,
          startYMm: yMm,
          initial,
          centerXMm: cx,
          centerYMm: cy,
          startAngle: Math.atan2(yMm - cy, xMm - cx),
          moved: false,
        };
        return;
      }

      // 2) 元素命中
      const hit = hitTest(doc, xMm, yMm, DESIGN_DPI);
      if (hit) {
        if (event.shiftKey) {
          toggleSelected(hit.id);
        } else if (!selectedIds.includes(hit.id)) {
          select([hit.id]);
        }
        const ids = getState().selectedIds.includes(hit.id) ? getState().selectedIds : [hit.id];
        const movable = ids.filter((id) => !doc.elements.find((e) => e.id === id)?.locked);
        if (movable.length === 0) return;
        beginInteraction();
        const initial = new Map(
          movable
            .map((id) => doc.elements.find((e) => e.id === id))
            .filter((e): e is LabelElement => Boolean(e))
            .map((e) => [e.id, { xMm: e.xMm, yMm: e.yMm, widthMm: e.widthMm, heightMm: e.heightMm, rotation: e.rotation }]),
        );
        dragRef.current = {
          mode: "move",
          startXMm: xMm,
          startYMm: yMm,
          initial,
          centerXMm: 0,
          centerYMm: 0,
          startAngle: 0,
          moved: false,
        };
        return;
      }

      // 3) 空白处框选
      if (!event.shiftKey) clearSelection();
      dragRef.current = {
        mode: "marquee",
        startXMm: xMm,
        startYMm: yMm,
        initial: new Map(),
        centerXMm: 0,
        centerYMm: 0,
        startAngle: 0,
        moved: false,
      };
      setMarquee({ x: xMm, y: yMm, width: 0, height: 0 });
    },
    [doc, handleAt, selectedIds, toMm],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      const { xMm, yMm } = toMm(event);

      if (!drag) {
        const hit = hitTest(doc, xMm, yMm, DESIGN_DPI);
        const handle = hit ? null : handleAt(xMm, yMm);
        setHover(handle ? handle.element.id : hit?.id ?? null);
        return;
      }

      const gridStep = event.altKey ? 0 : doc.settings.gridStepMm;
      drag.moved = true;

      if (drag.mode === "marquee") {
        const rect: Rect = {
          x: Math.min(drag.startXMm, xMm),
          y: Math.min(drag.startYMm, yMm),
          width: Math.abs(xMm - drag.startXMm),
          height: Math.abs(yMm - drag.startYMm),
        };
        setMarquee(rect);
        return;
      }

      if (drag.mode === "move") {
        let dx = xMm - drag.startXMm;
        let dy = yMm - drag.startYMm;
        // 以第一个元素为基准做网格吸附，避免多选时相互挤压
        const first = [...drag.initial.values()][0];
        if (first && gridStep > 0) {
          dx = snap(first.xMm + dx, gridStep) - first.xMm;
          dy = snap(first.yMm + dy, gridStep) - first.yMm;
        }
        const patches = new Map<string, Partial<LabelElement>>();
        for (const [id, geo] of drag.initial) {
          patches.set(id, {
            xMm: round2(clamp(geo.xMm + dx, -doc.settings.widthMm, doc.settings.widthMm * 2)),
            yMm: round2(clamp(geo.yMm + dy, -doc.settings.heightMm, doc.settings.heightMm * 2)),
          });
        }
        updateElementsLiveMap(patches);
        return;
      }

      if (drag.mode === "rotate") {
        const angle =
          (Math.atan2(yMm - drag.centerYMm, xMm - drag.centerXMm) - drag.startAngle) * (180 / Math.PI);
        const first = [...drag.initial.values()][0];
        let next = (first?.rotation ?? 0) + angle;
        if (event.shiftKey) next = Math.round(next / 15) * 15;
        next = ((next % 360) + 360) % 360;
        const patches = new Map<string, Partial<LabelElement>>();
        for (const id of drag.initial.keys()) patches.set(id, { rotation: round2(next) });
        updateElementsLiveMap(patches);
        return;
      }

      // resize：只在单选时提供，避免多选缩放语义混乱
      const handle = drag.handle;
      if (!handle || drag.initial.size !== 1) return;
      const [id, geo] = [...drag.initial.entries()][0];

      // 转回元素本地坐标，保证旋转后缩放方向正确
      const rad = (-geo.rotation * Math.PI) / 180;
      const cx = geo.xMm + geo.widthMm / 2;
      const cy = geo.yMm + geo.heightMm / 2;
      const relX = xMm - cx;
      const relY = yMm - cy;
      const lx = cx + relX * Math.cos(rad) - relY * Math.sin(rad);
      const ly = cy + relX * Math.sin(rad) + relY * Math.cos(rad);

      let x0 = geo.xMm;
      let y0 = geo.yMm;
      let x1 = geo.xMm + geo.widthMm;
      let y1 = geo.yMm + geo.heightMm;
      const minMm = 1.5;

      if (handle.includes("w")) x0 = Math.min(lx, x1 - minMm);
      if (handle.includes("e")) x1 = Math.max(lx, x0 + minMm);
      if (handle.includes("n")) y0 = Math.min(ly, y1 - minMm);
      if (handle.includes("s")) y1 = Math.max(ly, y0 + minMm);

      if (gridStep > 0) {
        if (handle.includes("w")) x0 = snap(x0, gridStep);
        if (handle.includes("e")) x1 = snap(x1, gridStep);
        if (handle.includes("n")) y0 = snap(y0, gridStep);
        if (handle.includes("s")) y1 = snap(y1, gridStep);
      }

      updateElementsLiveMap(
        new Map([
          [
            id,
            {
              xMm: round2(Math.min(x0, x1)),
              yMm: round2(Math.min(y0, y1)),
              widthMm: round2(Math.abs(x1 - x0)),
              heightMm: round2(Math.abs(y1 - y0)),
            },
          ],
        ]),
      );
    },
    [doc, handleAt, toMm],
  );

  const finishDrag = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* 指针已释放 */
      }
      if (!drag) return;

      if (drag.mode === "marquee") {
        setMarquee((rect) => {
          if (rect && (rect.width > 0.5 || rect.height > 0.5)) {
            const hits = hitTestRect(doc, rect).filter((e) => !e.locked);
            if (event.shiftKey) {
              select([...getState().selectedIds, ...hits.map((e) => e.id)]);
            } else {
              select(hits.map((e) => e.id));
            }
          }
          return null;
        });
        return;
      }
      endInteraction();
    },
    [doc],
  );

  // 键盘：微调、删除、撤销、全选
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const step = event.shiftKey ? 1 : 0.1;
      const ids = getState().selectedIds;
      const mod = event.ctrlKey || event.metaKey;

      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && event.key.toLowerCase() === "a") {
        event.preventDefault();
        selectAll();
        return;
      }
      if (ids.length === 0) return;

      const map: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      if (map[event.key]) {
        event.preventDefault();
        const [dx, dy] = map[event.key];
        const patches = new Map<string, Partial<LabelElement>>();
        for (const id of ids) {
          const el = getState().doc.elements.find((e) => e.id === id);
          if (!el || el.locked) continue;
          patches.set(id, { xMm: round2(el.xMm + dx), yMm: round2(el.yMm + dy) });
        }
        if (patches.size > 0) {
          beginInteraction();
          updateElementsLiveMap(patches);
          endInteraction();
        }
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        removeElements(ids);
      }
      if (event.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 滚轮缩放（Ctrl + 滚轮），普通滚轮留给容器滚动
  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
    },
    [zoom],
  );

  /**
   * 让标签适应可视区。
   *
   * 标签通常只有几十毫米，在宽屏下 100% 会显得很小、四周大片空白。
   * 这里按「画布可视区 + 一点留白」反算缩放，并限制在 0.4–3 倍之间：
   * 上限避免小标签被放得过分夸张，下限避免大标签缩到看不清。
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !autoFit) return;

    const recompute = () => {
      const availW = container.clientWidth - 56;
      const availH = container.clientHeight - 76;
      if (availW <= 0 || availH <= 0) return;
      const fit = Math.min(availW / widthPx, availH / heightPx);
      const next = Math.max(0.4, Math.min(3, fit));
      if (Math.abs(next - getState().zoom) > 0.01) setFitZoom(next);
    };

    recompute();
    // 窗口或侧栏尺寸变化时重算（侧栏宽度是布局的关键变量）
    const observer = new ResizeObserver(recompute);
    observer.observe(container);
    return () => observer.disconnect();
  }, [autoFit, widthPx, heightPx]);

  const displayWidth = Math.round(widthPx * zoom);
  const displayHeight = Math.round(heightPx * zoom);

  return (
    <div className="canvas-area" ref={containerRef} onWheel={onWheel}>
      <div className="canvas-hint">
        标签 {doc.settings.widthMm} × {doc.settings.heightMm} mm · 缩放 {Math.round(zoom * 100)}%
        {autoFit ? "（自动适应）" : ""}
        {" · Ctrl+滚轮缩放，Alt 拖动忽略网格吸附"}
      </div>
      <div className="canvas-scroll">
        <div
          className="canvas-stack"
          style={{ width: displayWidth, height: displayHeight }}
        >
          <canvas
            ref={baseRef}
            style={{ width: displayWidth, height: displayHeight }}
            className="canvas-base"
          />
          <canvas
            ref={overlayRef}
            style={{ width: displayWidth, height: displayHeight }}
            className="canvas-overlay"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
          />
        </div>
      </div>
    </div>
  );
}

// 避免在组件内直接引用 setZoom 造成重新渲染依赖
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
