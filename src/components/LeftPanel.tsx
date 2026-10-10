/**
 * 左侧面板：元素库（由注册表驱动）+ 图层列表 + 模板设置。
 */

import { useMemo, useState } from "react";
import type { JSX } from "react";
import { listElementDefinitions } from "../renderer/elements";
import { MEDIA_PRESETS, type ElementType, type LabelElement } from "../model/types";
import {
  addElement,
  clearSelection,
  duplicateElements,
  removeElements,
  select,
  setElementOrder,
  setHover,
  setLayoutMeta,
  setLayoutSettings,
  toggleSelected,
  updateElements,
  useEditor,
} from "../state/store";
import { fmt } from "../model/units";

type Tab = "elements" | "layers" | "page";

export function LeftPanel(): JSX.Element {
  const [tab, setTab] = useState<Tab>("elements");
  return (
    <div className="panel left-panel">
      <div className="tab-bar">
        <button className={tab === "elements" ? "active" : ""} onClick={() => setTab("elements")}>
          元素
        </button>
        <button className={tab === "layers" ? "active" : ""} onClick={() => setTab("layers")}>
          图层
        </button>
        <button className={tab === "page" ? "active" : ""} onClick={() => setTab("page")}>
          标签
        </button>
      </div>
      <div className="panel-body">
        {tab === "elements" ? <ElementPalette /> : null}
        {tab === "layers" ? <LayerList /> : null}
        {tab === "page" ? <PageSettings /> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 元素库
// ---------------------------------------------------------------------------

function ElementPalette(): JSX.Element {
  const doc = useEditor((s) => s.doc);
  const definitions = listElementDefinitions();

  const add = (type: ElementType) => {
    const def = listElementDefinitions().find((d) => d.type === type);
    if (!def) return;
    const element = def.create() as LabelElement;
    // 放到已有元素下方；空间不足时换到右侧，避免新建元素互相盖住
    const maxY = doc.elements.reduce((m, e) => Math.max(m, e.yMm + e.heightMm), 0);
    const bottom = doc.settings.heightMm - element.heightMm - doc.settings.marginMm;
    if (maxY + 1 + element.heightMm <= bottom) {
      element.yMm = Math.round((maxY + 1) * 100) / 100;
    } else {
      const maxX = doc.elements.reduce((m, e) => Math.max(m, e.xMm + e.widthMm), 0);
      element.xMm = Math.round((maxX + 1) * 100) / 100;
      element.yMm = doc.settings.marginMm;
    }
    const maxW = doc.settings.widthMm - doc.settings.marginMm * 2;
    if (element.widthMm > maxW) element.widthMm = Math.max(2, maxW);
    addElement(element);
  };

  return (
    <>
      <div className="section-title">添加元素</div>
      <div className="element-grid">
        {definitions.map((def) => (
          <button key={def.type} className="element-card" onClick={() => add(def.type)} title={def.description}>
            <span className="element-icon">{def.icon}</span>
            <span className="element-label">{def.label}</span>
          </button>
        ))}
      </div>
      <div className="hint">
        元素类型由插件注册表提供。新增类型只需在 <code>src/renderer/elements.ts</code> 中注册，
        界面会自动出现对应入口。
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 图层
// ---------------------------------------------------------------------------

function LayerList(): JSX.Element {
  const doc = useEditor((s) => s.doc);
  const selectedIds = useEditor((s) => s.selectedIds);
  const hoverId = useEditor((s) => s.hoverId);

  // 列表按从上到下的视觉顺序（数组末尾在最上层）
  const items = useMemo(() => [...doc.elements].reverse(), [doc.elements]);

  if (items.length === 0) {
    return <div className="empty-hint">还没有元素。切到「元素」标签添加第一个吧。</div>;
  }

  return (
    <>
      <div className="section-title">
        图层（{items.length}）
        <span className="hint-inline">列表上方 = 画布更上层</span>
      </div>
      <ul className="layer-list">
        {items.map((element) => {
          const selected = selectedIds.includes(element.id);
          return (
            <li
              key={element.id}
              className={`layer-item${selected ? " selected" : ""}${hoverId === element.id ? " hover" : ""}${element.visible ? "" : " hidden"}`}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey || e.shiftKey) toggleSelected(element.id);
                else select([element.id]);
              }}
              onMouseEnter={() => updateHover(element.id)}
              onMouseLeave={() => updateHover(null)}
            >
              <button
                className="icon-button"
                title={element.visible ? "隐藏" : "显示"}
                onClick={(e) => {
                  e.stopPropagation();
                  updateElements([element.id], { visible: !element.visible });
                }}
              >
                {element.visible ? "◉" : "○"}
              </button>
              <button
                className="icon-button"
                title={element.locked ? "解锁" : "锁定"}
                onClick={(e) => {
                  e.stopPropagation();
                  updateElements([element.id], { locked: !element.locked });
                }}
              >
                {element.locked ? "🔒" : "🔓"}
              </button>
              <span className="layer-name">{element.name}</span>
              <span className="layer-type">{typeLabel(element.kind)}</span>
              <span className="layer-actions">
                <button
                  className="icon-button"
                  title="上移一层"
                  onClick={(e) => {
                    e.stopPropagation();
                    setElementOrder(element.id, "forward");
                  }}
                >
                  ↑
                </button>
                <button
                  className="icon-button"
                  title="下移一层"
                  onClick={(e) => {
                    e.stopPropagation();
                    setElementOrder(element.id, "backward");
                  }}
                >
                  ↓
                </button>
                <button
                  className="icon-button"
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeElements([element.id]);
                  }}
                >
                  ✕
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="button-row">
        <button onClick={() => duplicateElements(selectedIds)} disabled={selectedIds.length === 0}>
          复制选中
        </button>
        <button onClick={() => removeElements(selectedIds)} disabled={selectedIds.length === 0}>
          删除选中
        </button>
        <button className="ghost" onClick={() => clearSelection()}>
          取消选择
        </button>
      </div>
    </>
  );
}

function typeLabel(kind: ElementType): string {
  const found = listElementDefinitions().find((d) => d.type === kind);
  return found?.label ?? kind;
}

// 轻量的悬停联动（直接走 store，避免额外 context）
function updateHover(id: string | null): void {
  setHover(id);
}

// ---------------------------------------------------------------------------
// 标签设置
// ---------------------------------------------------------------------------

function PageSettings(): JSX.Element {
  const doc = useEditor((s) => s.doc);
  const settings = doc.settings;

  return (
    <>
      <div className="section-title">标签规格</div>
      <div className="preset-list">
        {MEDIA_PRESETS.map((preset) => {
          const active =
            Math.abs(preset.widthMm - settings.widthMm) < 0.01 &&
            Math.abs(preset.heightMm - settings.heightMm) < 0.01 &&
            (preset.columns ?? 1) === settings.columns;
          return (
            <button
              key={preset.id}
              className={`preset-item${active ? " active" : ""}`}
              onClick={() =>
                setLayoutSettings({
                  widthMm: preset.widthMm,
                  heightMm: preset.heightMm,
                  gapMm: preset.gapMm,
                  columns: preset.columns ?? 1,
                })
              }
            >
              <strong>{preset.label}</strong>
              {preset.note ? <em>{preset.note}</em> : null}
            </button>
          );
        })}
      </div>

      <div className="section-title">自定义尺寸</div>
      <div className="grid-2">
        <label className="mini-field">
          <span>宽</span>
          <input
            type="number"
            min={5}
            max={300}
            step={0.5}
            value={fmt(settings.widthMm)}
            onChange={(e) => setLayoutSettings({ widthMm: Math.max(5, Number(e.target.value)) })}
          />
          <em>mm</em>
        </label>
        <label className="mini-field">
          <span>高</span>
          <input
            type="number"
            min={5}
            max={500}
            step={0.5}
            value={fmt(settings.heightMm)}
            onChange={(e) => setLayoutSettings({ heightMm: Math.max(5, Number(e.target.value)) })}
          />
          <em>mm</em>
        </label>
      </div>

      <div className="section-title">纸张与间隙</div>
      <div className="field-row">
        <label>走纸方式</label>
        <select
          value={settings.gapMode}
          onChange={(e) => setLayoutSettings({ gapMode: e.target.value as typeof settings.gapMode })}
        >
          <option value="gap">间隙纸（有间隙的标签）</option>
          <option value="bline">黑标纸</option>
          <option value="continuous">连续纸</option>
        </select>
      </div>
      <div className="grid-2">
        <label className="mini-field">
          <span>间隙</span>
          <input
            type="number"
            min={0}
            max={20}
            step={0.5}
            value={fmt(settings.gapMm)}
            onChange={(e) => setLayoutSettings({ gapMm: Math.max(0, Number(e.target.value)) })}
          />
          <em>mm</em>
        </label>
        <label className="mini-field">
          <span>偏移</span>
          <input
            type="number"
            min={-10}
            max={20}
            step={0.5}
            value={fmt(settings.gapOffsetMm)}
            onChange={(e) => setLayoutSettings({ gapOffsetMm: Number(e.target.value) })}
          />
          <em>mm</em>
        </label>
      </div>

      <div className="section-title">设计辅助</div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.showGrid}
          onChange={(e) => setLayoutSettings({ showGrid: e.target.checked })}
        />
        显示网格
      </label>
      <div className="field-row inline">
        <label>网格间距</label>
        <input
          type="number"
          min={0.5}
          max={20}
          step={0.5}
          value={fmt(settings.gridStepMm)}
          onChange={(e) => setLayoutSettings({ gridStepMm: Math.max(0.5, Number(e.target.value)) })}
        />
        <em className="unit">mm</em>
      </div>
      <div className="field-row inline">
        <label>安全边距</label>
        <input
          type="number"
          min={0}
          max={20}
          step={0.5}
          value={fmt(settings.marginMm)}
          onChange={(e) => setLayoutSettings({ marginMm: Math.max(0, Number(e.target.value)) })}
        />
        <em className="unit">mm</em>
      </div>

      <div className="section-title">模板信息</div>
      <div className="field-row">
        <label>名称</label>
        <input
          type="text"
          value={doc.name}
          onChange={(e) => setLayoutMeta({ name: e.target.value })}
        />
      </div>
      <div className="field-row">
        <label>备注</label>
        <textarea
          rows={2}
          value={doc.note}
          onChange={(e) => setLayoutMeta({ note: e.target.value })}
        />
      </div>
    </>
  );
}
