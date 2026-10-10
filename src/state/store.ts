/**
 * 编辑器状态容器。
 *
 * 用「不可变快照 + 订阅」的最小实现，避免引入状态库：
 * - 文档整体作为不可变对象，每次修改产生新对象，天然支持撤销/重做
 * - 拖动等高频操作走 `beginInteraction` / `endInteraction`，
 *   整段拖动只产生一条历史记录，撤销体验才符合直觉
 */

import { useSyncExternalStore } from "react";
import type { LabelElement, LabelLayout } from "../model/types";
import { createLayout } from "../model/types";

export interface EditorState {
  doc: LabelLayout;
  /** 当前载入的模板 id（用于保存） */
  templateId: string;
  /** 选中元素 id 列表 */
  selectedIds: string[];
  hoverId: string | null;
  /** 视图缩放（仅影响显示，不影响输出） */
  zoom: number;
  /** 是否处于「适应内容」自动布局状态等 UI 提示 */
  status: { text: string; kind: "info" | "error" | "success" } | null;
  /** 文档是否有未保存修改 */
  dirty: boolean;
  past: LabelLayout[];
  future: LabelLayout[];
  /** 拖动开始时记录的快照，避免每个 mousemove 都进历史 */
  interactionSnapshot: LabelLayout | null;
}

const HISTORY_LIMIT = 60;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;

let state: EditorState = {
  doc: createLayout(),
  templateId: "",
  selectedIds: [],
  hoverId: null,
  zoom: 1,
  status: null,
  dirty: false,
  past: [],
  future: [],
  interactionSnapshot: null,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<EditorState>): void {
  state = { ...state, ...patch };
  emit();
}

export function getState(): EditorState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEditor<T>(selector: (s: EditorState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

/** 便捷：只订阅文档 */
export function useDocument(): LabelLayout {
  return useEditor((s) => s.doc);
}

// ---------------------------------------------------------------------------
// 历史
// ---------------------------------------------------------------------------

function withHistory(doc: LabelLayout, past: LabelLayout[], future: LabelLayout[]): Partial<EditorState> {
  const nextPast = [...past, state.doc].slice(-HISTORY_LIMIT);
  return { doc: { ...doc, updatedAtMs: Date.now() }, past: nextPast, future, dirty: true };
}

/** 应用一次可撤销的文档变更 */
export function commit(mutate: (doc: LabelLayout) => LabelLayout): void {
  const next = mutate(state.doc);
  if (next === state.doc) return;
  setState(withHistory(next, state.past, []));
}

/** 拖动开始：记录快照，后续的 update 不再压栈 */
export function beginInteraction(): void {
  if (state.interactionSnapshot) return;
  setState({ interactionSnapshot: state.doc });
}

/** 拖动结束：把开始时的快照压入历史（若确实发生了变化） */
export function endInteraction(): void {
  const snapshot = state.interactionSnapshot;
  if (!snapshot) return;
  const changed = snapshot !== state.doc;
  setState({
    interactionSnapshot: null,
    past: changed ? [...state.past, snapshot].slice(-HISTORY_LIMIT) : state.past,
    future: changed ? [] : state.future,
    dirty: changed ? true : state.dirty,
  });
}

export function undo(): void {
  if (state.past.length === 0) return;
  const previous = state.past[state.past.length - 1];
  setState({
    doc: previous,
    past: state.past.slice(0, -1),
    future: [state.doc, ...state.future].slice(0, HISTORY_LIMIT),
    selectedIds: state.selectedIds.filter((id) => previous.elements.some((e) => e.id === id)),
    dirty: true,
  });
}

export function redo(): void {
  if (state.future.length === 0) return;
  const next = state.future[0];
  setState({
    doc: next,
    past: [...state.past, state.doc].slice(-HISTORY_LIMIT),
    future: state.future.slice(1),
    selectedIds: state.selectedIds.filter((id) => next.elements.some((e) => e.id === id)),
    dirty: true,
  });
}

// ---------------------------------------------------------------------------
// 文档级操作
// ---------------------------------------------------------------------------

export function loadDocument(doc: LabelLayout, templateId: string): void {
  setState({
    doc,
    templateId,
    selectedIds: [],
    hoverId: null,
    past: [],
    future: [],
    dirty: false,
    interactionSnapshot: null,
    status: null,
  });
}

export function markSaved(templateId: string): void {
  setState({ templateId, dirty: false });
}

export function setStatus(text: string, kind: "info" | "error" | "success" = "info"): void {
  setState({ status: { text, kind } });
}

export function clearStatus(): void {
  setState({ status: null });
}

// ---------------------------------------------------------------------------
// 选择
// ---------------------------------------------------------------------------

export function select(ids: string[]): void {
  setState({ selectedIds: [...new Set(ids)] });
}

export function selectAll(): void {
  setState({ selectedIds: state.doc.elements.filter((e) => !e.locked).map((e) => e.id) });
}

export function clearSelection(): void {
  setState({ selectedIds: [] });
}

export function toggleSelected(id: string): void {
  const has = state.selectedIds.includes(id);
  setState({
    selectedIds: has ? state.selectedIds.filter((x) => x !== id) : [...state.selectedIds, id],
  });
}

export function setHover(id: string | null): void {
  if (state.hoverId === id) return;
  setState({ hoverId: id });
}

export function setZoom(zoom: number): void {
  setState({ zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom)) });
}

// ---------------------------------------------------------------------------
// 元素操作
// ---------------------------------------------------------------------------

export function addElement(element: LabelElement): void {
  commit((doc) => ({ ...doc, elements: [...doc.elements, element] }));
  setState({ selectedIds: [element.id] });
}

export function updateElements(ids: string[], patch: Partial<LabelElement>): void {
  if (ids.length === 0) return;
  commit((doc) => ({
    ...doc,
    elements: doc.elements.map((el) => (ids.includes(el.id) ? ({ ...el, ...patch } as LabelElement) : el)),
  }));
}

/** 拖动过程中的高频更新：不进历史（历史由 begin/endInteraction 负责） */
export function updateElementsLive(ids: string[], patch: Partial<LabelElement>): void {
  if (ids.length === 0) return;
  const next: LabelLayout = {
    ...state.doc,
    elements: state.doc.elements.map((el) => (ids.includes(el.id) ? ({ ...el, ...patch } as LabelElement) : el)),
    updatedAtMs: Date.now(),
  };
  setState({ doc: next, dirty: true });
}

/** 逐元素给出不同 patch（多选等距拖动等场景） */
export function updateElementsLiveMap(patches: Map<string, Partial<LabelElement>>): void {
  if (patches.size === 0) return;
  const next: LabelLayout = {
    ...state.doc,
    elements: state.doc.elements.map((el) => {
      const patch = patches.get(el.id);
      return patch ? ({ ...el, ...patch } as LabelElement) : el;
    }),
    updatedAtMs: Date.now(),
  };
  setState({ doc: next, dirty: true });
}

export function removeElements(ids: string[]): void {
  if (ids.length === 0) return;
  commit((doc) => ({ ...doc, elements: doc.elements.filter((el) => !ids.includes(el.id)) }));
  setState({ selectedIds: [] });
}

export function duplicateElements(ids: string[]): void {
  const source = state.doc.elements.filter((el) => ids.includes(el.id));
  if (source.length === 0) return;
  const copies = source.map((el) => ({
    ...el,
    id: `${el.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: `${el.name} 副本`,
    xMm: el.xMm + 2,
    yMm: el.yMm + 2,
  }));
  commit((doc) => ({ ...doc, elements: [...doc.elements, ...copies] }));
  setState({ selectedIds: copies.map((c) => c.id) });
}

export function setLayoutSettings(patch: Partial<LabelLayout["settings"]>): void {
  commit((doc) => ({ ...doc, settings: { ...doc.settings, ...patch } }));
}

export function setVariables(variables: Record<string, string>): void {
  commit((doc) => ({ ...doc, variables }));
}

export function setLayoutMeta(patch: Partial<Pick<LabelLayout, "name" | "note" | "printer">>): void {
  commit((doc) => ({ ...doc, ...patch }));
}

export function setElementOrder(id: string, direction: "front" | "back" | "forward" | "backward"): void {
  commit((doc) => {
    const elements = [...doc.elements];
    const index = elements.findIndex((e) => e.id === id);
    if (index < 0) return doc;
    const [element] = elements.splice(index, 1);
    switch (direction) {
      case "front":
        elements.push(element);
        break;
      case "back":
        elements.unshift(element);
        break;
      case "forward":
        elements.splice(Math.min(elements.length, index + 1), 0, element);
        break;
      default:
        elements.splice(Math.max(0, index - 1), 0, element);
    }
    return { ...doc, elements };
  });
}

/** 对齐：以选中元素的整体包围盒或标签页为基准 */
export function alignElements(
  ids: string[],
  mode: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom" | "hdistribute" | "vdistribute",
): void {
  const targets = state.doc.elements.filter((el) => ids.includes(el.id) && !el.locked);
  if (targets.length < 2 && mode.includes("distribute")) return;
  if (targets.length < 1) return;

  const bounds = targets.reduce(
    (acc, el) => ({
      minX: Math.min(acc.minX, el.xMm),
      maxX: Math.max(acc.maxX, el.xMm + el.widthMm),
      minY: Math.min(acc.minY, el.yMm),
      maxY: Math.max(acc.maxY, el.yMm + el.heightMm),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );

  const patches = new Map<string, Partial<LabelElement>>();
  if (mode === "hdistribute" || mode === "vdistribute") {
    const horizontal = mode === "hdistribute";
    const sorted = [...targets].sort((a, b) => (horizontal ? a.xMm - b.xMm : a.yMm - b.yMm));
    const total = sorted.reduce((sum, el) => sum + (horizontal ? el.widthMm : el.heightMm), 0);
    const span = horizontal ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY;
    const gap = (span - total) / (sorted.length - 1);
    let cursor = horizontal ? bounds.minX : bounds.minY;
    for (const el of sorted) {
      patches.set(el.id, horizontal ? { xMm: round2(cursor) } : { yMm: round2(cursor) });
      cursor += (horizontal ? el.widthMm : el.heightMm) + gap;
    }
  } else {
    for (const el of targets) {
      switch (mode) {
        case "left":
          patches.set(el.id, { xMm: round2(bounds.minX) });
          break;
        case "right":
          patches.set(el.id, { xMm: round2(bounds.maxX - el.widthMm) });
          break;
        case "hcenter":
          patches.set(el.id, { xMm: round2((bounds.minX + bounds.maxX) / 2 - el.widthMm / 2) });
          break;
        case "top":
          patches.set(el.id, { yMm: round2(bounds.minY) });
          break;
        case "bottom":
          patches.set(el.id, { yMm: round2(bounds.maxY - el.heightMm) });
          break;
        default:
          patches.set(el.id, { yMm: round2((bounds.minY + bounds.maxY) / 2 - el.heightMm / 2) });
      }
    }
  }

  commit((doc) => ({
    ...doc,
    elements: doc.elements.map((el) => {
      const patch = patches.get(el.id);
      return patch ? ({ ...el, ...patch } as LabelElement) : el;
    }),
  }));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 当前选中的元素（按文档顺序） */
export function selectedElements(s: EditorState = state): LabelElement[] {
  return s.doc.elements.filter((el) => s.selectedIds.includes(el.id));
}
