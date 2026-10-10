/**
 * 应用外壳：顶部模式切换 + 两种视图。
 *
 * - **打标签**（默认首屏）：操作员用。粘贴一行数据 → 核对 → 打印，不需要理解标签设计。
 * - **设计模板**：管理员用。可视化布局设计、定义变量、配置字段映射。
 *
 * 设计器整体作为独立视图挂载，两边的状态互不干扰（打标签页有自己的模板加载逻辑）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { DesignCanvas } from "./components/DesignCanvas";
import { LeftPanel } from "./components/LeftPanel";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { PrintDialog } from "./components/PrintDialog";
import { TemplateManager } from "./components/TemplateManager";
import { VariablePanel } from "./components/VariablePanel";
import { FillPrintPanel } from "./components/FillPrintPanel";
import { exportLayout, importLayout, readLayout, saveLayout } from "./api/backend";
import {
  alignElements,
  clearStatus,
  getState,
  loadDocument,
  markSaved,
  redo,
  setStatus,
  setZoom,
  undo,
  useEditor,
} from "./state/store";
import { createLayout, type LabelLayout } from "./model/types";
import { renderToDataUrl } from "./renderer/renderer";

type Mode = "print" | "design";

export function App(): JSX.Element {
  const [mode, setMode] = useState<Mode>("print");

  return (
    <div className="app">
      <nav className="mode-bar">
        <span className="app-title">LabelDesk</span>
        <div className="mode-tabs">
          <button
            className={mode === "print" ? "active" : ""}
            onClick={() => setMode("print")}
            title="日常打标签：粘贴一行数据即可出标签"
          >
            打标签
          </button>
          <button
            className={mode === "design" ? "active" : ""}
            onClick={() => setMode("design")}
            title="管理员：设计布局、定义变量与字段映射"
          >
            设计模板
          </button>
        </div>
        <div className="mode-bar-hint">
          {mode === "print"
            ? "在表格里选中一行 → Ctrl+C → 在下面 Ctrl+V → 打印"
            : "设计好后记得「保存」，并在「字段映射」里配好每一列对应哪个变量"}
        </div>
      </nav>

      {mode === "print" ? (
        <PrintWorkspace onOpenDesigner={() => setMode("design")} />
      ) : (
        <DesignWorkspace />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 打标签
// ---------------------------------------------------------------------------

function PrintWorkspace({ onOpenDesigner }: { onOpenDesigner: () => void }): JSX.Element {
  return (
    <main className="fill-main">
      <FillPrintPanel onOpenDesigner={onOpenDesigner} />
    </main>
  );
}

// ---------------------------------------------------------------------------
// 设计模板
// ---------------------------------------------------------------------------

function DesignWorkspace(): JSX.Element {
  const doc = useEditor((s) => s.doc);
  const selectedIds = useEditor((s) => s.selectedIds);
  const zoom = useEditor((s) => s.zoom);
  const dirty = useEditor((s) => s.dirty);
  const status = useEditor((s) => s.status);
  const templateId = useEditor((s) => s.templateId);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);

  const [showPrint, setShowPrint] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showVariables, setShowVariables] = useState(false);
  const [busy, setBusy] = useState(false);

  // 状态提示自动消失
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => clearStatus(), status.kind === "error" ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [status]);

  // 关闭窗口前提醒未保存
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!getState().dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Ctrl+S 保存
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newTemplate = useCallback(() => {
    if (getState().dirty && !confirm("当前模板有未保存的修改，确定新建？")) return;
    const layout = createLayout("未命名标签");
    loadDocument(layout, "");
    setStatus("已新建空白模板", "info");
  }, []);

  const save = useCallback(async () => {
    const state = getState();
    const name = state.doc.name?.trim() || "未命名标签";
    const layout: LabelLayout = { ...state.doc, name, id: name };
    setBusy(true);
    try {
      await saveLayout(name, layout);
      markSaved(name);
      setStatus(`已保存模板「${name}」`, "success");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  }, []);

  const saveAs = useCallback(async () => {
    const name = prompt("另存为新的模板名称：", getState().doc.name || "未命名标签");
    if (!name) return;
    const state = getState();
    const next = { ...state.doc, name, id: name };
    setBusy(true);
    try {
      await saveLayout(name, next);
      loadDocument(next, name);
      markSaved(name);
      setStatus(`已另存为「${name}」`, "success");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  }, []);

  const importTemplate = useCallback(async () => {
    try {
      const source = await openDialog({
        title: "导入模板",
        multiple: false,
        filters: [{ name: "LabelDesk 模板", extensions: ["json"] }],
      });
      if (!source || Array.isArray(source)) return;
      setBusy(true);
      const newId = await importLayout(source);
      const loaded = await readLayout(newId);
      loadDocument(loaded, newId);
      markSaved(newId);
      setStatus(`已导入模板「${loaded.name}」`, "success");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  }, []);

  const exportTemplate = useCallback(async () => {
    const state = getState();
    if (!state.templateId) {
      setStatus("请先保存模板，再导出", "error");
      return;
    }
    try {
      const target = await saveDialog({
        title: "导出模板",
        defaultPath: `${state.doc.name || "template"}.ldl.json`,
        filters: [{ name: "LabelDesk 模板", extensions: ["json"] }],
      });
      if (!target) return;
      await exportLayout(state.templateId, target);
      setStatus(`已导出到 ${target}`, "success");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    }
  }, []);

  const exportPng = useCallback(() => {
    try {
      const dataUrl = renderToDataUrl(doc, {
        dpi: doc.printer?.dpi ?? 203,
        variables: doc.variables,
        binaryThreshold: null,
      });
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = `${doc.name || "label"}.png`;
      link.click();
      setStatus("已导出 PNG 到下载目录", "success");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    }
  }, [doc]);

  const alignHint = useMemo(
    () => (selectedIds.length < 2 ? "对齐需要先选中 2 个以上元素" : ""),
    [selectedIds.length],
  );

  return (
    <>
      <header className="toolbar">
        <div className="toolbar-group">
          <button onClick={newTemplate} title="新建模板">
            新建
          </button>
          <button onClick={() => setShowTemplates(true)} title="打开已保存的模板">
            打开
          </button>
          <button onClick={save} disabled={busy} title="保存到应用数据目录 (Ctrl+S)">
            保存{dirty ? " *" : ""}
          </button>
          <button onClick={saveAs} disabled={busy} title="另存为新模板">
            另存为
          </button>
        </div>

        <div className="toolbar-sep" />

        <div className="toolbar-group">
          <button onClick={undo} disabled={!canUndo} title="撤销 (Ctrl+Z)">
            ↶
          </button>
          <button onClick={redo} disabled={!canRedo} title="重做 (Ctrl+Shift+Z)">
            ↷
          </button>
        </div>

        <div className="toolbar-sep" />

        <div className="toolbar-group" title={alignHint}>
          {(
            [
              ["left", "左对齐", "⇤"],
              ["hcenter", "水平居中", "⇔"],
              ["right", "右对齐", "⇥"],
              ["top", "顶对齐", "⤒"],
              ["vcenter", "垂直居中", "⇕"],
              ["bottom", "底对齐", "⤓"],
              ["hdistribute", "水平等距", "⇹"],
              ["vdistribute", "垂直等距", "⇳"],
            ] as const
          ).map(([alignMode, label, glyph]) => (
            <button
              key={alignMode}
              className="ghost compact align-button"
              disabled={selectedIds.length < 2}
              onClick={() => alignElements(selectedIds, alignMode)}
              title={label}
              aria-label={label}
            >
              {glyph}
            </button>
          ))}
        </div>

        <div className="toolbar-spacer" />

        <div className="toolbar-group">
          <button className="ghost compact" onClick={() => setZoom(zoom / 1.25)} title="缩小">
            −
          </button>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="ghost compact" onClick={() => setZoom(zoom * 1.25)} title="放大">
            +
          </button>
          <button className="ghost compact" onClick={() => setZoom(1)} title="恢复 100%">
            1:1
          </button>
        </div>

        <div className="toolbar-sep" />

        <div className="toolbar-group">
          <button className="ghost" onClick={() => setShowVariables((v) => !v)}>
            变量
          </button>
          <button className="ghost" onClick={exportPng} title="导出黑白 PNG">
            导出 PNG
          </button>
          <button className="ghost" onClick={exportTemplate} title="导出模板 JSON">
            导出模板
          </button>
          <button className="ghost" onClick={importTemplate}>
            导入模板
          </button>
        </div>

        <div className="toolbar-group">
          <button className="primary" onClick={() => setShowPrint(true)}>
            打印测试…
          </button>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar left">
          <LeftPanel />
        </aside>
        <section className="center">
          <DesignCanvas />
          {showVariables ? <VariablePanel onClose={() => setShowVariables(false)} /> : null}
        </section>
        <aside className="sidebar right">
          <PropertiesPanel />
        </aside>
      </main>

      <footer className={`statusbar${status ? ` ${status.kind}` : ""}`}>
        <span>
          模板：{doc.name || "未命名"}
          {templateId ? `（${templateId}）` : "（未保存）"}
        </span>
        <span>
          元素 {doc.elements.length} · 选中 {selectedIds.length}
        </span>
        <span className="status-message">{status?.text ?? "就绪"}</span>
      </footer>

      {showPrint ? <PrintDialog onClose={() => setShowPrint(false)} /> : null}
      {showTemplates ? <TemplateManager onClose={() => setShowTemplates(false)} /> : null}
    </>
  );
}
