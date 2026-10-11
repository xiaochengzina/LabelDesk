/**
 * 模板管理：列出应用数据目录中的模板，支持打开 / 另存 / 导入 / 导出 / 删除。
 *
 * 模板以独立 JSON 文件保存（<应用数据目录>/layouts/*.ldl.json），
 * 用户可以直接备份、放进 Git，或用文本编辑器查看。
 */

import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  deleteLayout,
  exportLayout,
  importLayout,
  listLayouts,
  readLayout,
  type LayoutSummary,
} from "../api/backend";
import { loadDocument, markSaved, setStatus, useEditor } from "../state/store";
import { writeConfig } from "../api/backend";
import { Icon } from "./Icon";

interface Props {
  onClose: () => void;
}

export function TemplateManager({ onClose }: Props): JSX.Element {
  const currentId = useEditor((s) => s.templateId);
  const [items, setItems] = useState<LayoutSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listLayouts());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openTemplate = async (id: string) => {
    setBusy(true);
    try {
      const doc = await readLayout(id);
      loadDocument(doc, id);
      // 记住这次选择，下次启动（含设计模式）直接打开它
      writeConfig({ lastTemplateId: id }).catch(() => undefined);
      setStatus(`已打开模板「${doc.name}」`, "success");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeTemplate = async (id: string, name: string) => {
    if (!confirm(`确定删除模板「${name}」？此操作不可撤销。`)) return;
    setBusy(true);
    try {
      await deleteLayout(id);
      await reload();
      setStatus(`已删除模板「${name}」`, "info");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const exportTemplate = async (id: string, name: string) => {
    try {
      const target = await saveDialog({
        title: "导出模板",
        defaultPath: `${name}.ldl.json`,
        filters: [{ name: "LabelDesk 模板", extensions: ["json"] }],
      });
      if (!target) return;
      setBusy(true);
      const path = await exportLayout(id, target);
      setStatus(`已导出到 ${path}`, "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importTemplate = async () => {
    try {
      const source = await openDialog({
        title: "导入模板",
        multiple: false,
        filters: [{ name: "LabelDesk 模板", extensions: ["json"] }],
      });
      if (!source || Array.isArray(source)) return;
      setBusy(true);
      const newId = await importLayout(source);
      const doc = await readLayout(newId);
      loadDocument(doc, newId);
      markSaved(newId);
      setStatus(`已导入模板「${doc.name}」`, "success");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal template-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>模板管理</h2>
          <button className="icon-button" onClick={onClose} title="关闭">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="button-row">
            <button onClick={importTemplate} disabled={busy}>
              导入模板…
            </button>
            <button className="ghost" onClick={reload} disabled={busy}>
              刷新
            </button>
          </div>

          {error ? <div className="alert error">{error}</div> : null}
          {loading ? <div className="hint">正在读取…</div> : null}

          {!loading && items.length === 0 ? (
            <div className="empty-hint">还没有保存过模板。设计好标签后点工具栏的「保存」。</div>
          ) : null}

          <ul className="template-list">
            {items.map((item) => (
              <li key={item.id} className={item.id === currentId ? "current" : ""}>
                <div className="template-main">
                  <strong>{item.name}</strong>
                  <span className="template-meta">
                    {item.widthMm != null && item.heightMm != null
                      ? `${item.widthMm} × ${item.heightMm} mm`
                      : "规格未知"}
                    {" · "}
                    {new Date(item.updatedMs).toLocaleString("zh-CN")}
                    {" · "}
                    {(item.sizeBytes / 1024).toFixed(1)} KB
                  </span>
                </div>
                <div className="template-actions">
                  <button onClick={() => openTemplate(item.id)} disabled={busy}>
                    打开
                  </button>
                  <button className="ghost" onClick={() => exportTemplate(item.id, item.name)} disabled={busy}>
                    导出
                  </button>
                  <button className="danger" onClick={() => removeTemplate(item.id, item.name)} disabled={busy}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="modal-footer">
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
