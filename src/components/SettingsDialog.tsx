/**
 * 设置对话框。
 *
 * 设计上刻意克制：只放「改了会影响程序行为」的开关，且每项最多一行说明。
 * 打印历史不在这里 —— 它需要宽表格和搜索，已独立成左侧标签页。
 */

import { useCallback, useEffect, useState, type JSX } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  autostartStatus,
  backupDataDir,
  dataDirInfo,
  enterQuickMode,
  openDataDir,
  setAutostart,
  type AutostartStatus,
  type DataDirInfo,
} from "../api/backend";
import { Icon } from "./Icon";

interface Props {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: Props): JSX.Element {
  const [status, setStatus] = useState<AutostartStatus | null>(null);
  const [dataDir, setDataDir] = useState<DataDirInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    autostartStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    dataDirInfo()
      .then((d) => {
        if (!cancelled) setDataDir(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleAutostart = useCallback(async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await setAutostart(next));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const doBackup = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const target = await openDialog({ directory: true, title: "选择备份位置" });
      if (typeof target !== "string") return;
      const where = await backupDataDir(target);
      setNote(`已备份到 ${where}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const enabled = status?.enabled ?? true;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>设置</h2>
          <button className="icon-button" onClick={onClose} title="关闭">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body settings-body">
          <section className="setting-card">
            <div className="setting-head">
              <Icon name="app-window" size={15} />
              <span>窗口</span>
            </div>
            <div className="setting-row">
              <div className="setting-text">
                <strong>小窗模式</strong>
                <span>收成顶置窄条，粘贴一行按 Enter 就打印。</span>
              </div>
              <button
                className="ghost compact"
                onClick={() => {
                  onClose();
                  void enterQuickMode();
                }}
              >
                开启
              </button>
            </div>
            <div className="setting-row">
              <div className="setting-text">
                <strong>关闭窗口时</strong>
                <span>销毁界面释放内存，程序留在托盘；点托盘可还原。</span>
              </div>
            </div>
          </section>

          <section className="setting-card">
            <div className="setting-head">
              <Icon name="power" size={15} />
              <span>启动</span>
            </div>
            <label className="setting-row check-row">
              <input
                type="checkbox"
                checked={enabled}
                disabled={busy || status === null}
                onChange={(e) => void toggleAutostart(e.target.checked)}
              />
              <div className="setting-text">
                <strong>开机时自动启动</strong>
                <span>
                  {status === null
                    ? "读取中…"
                    : enabled
                      ? "已登记，登录 Windows 后自动运行。"
                      : "已关闭，需要时手动打开。"}
                </span>
              </div>
            </label>
          </section>

          <section className="setting-card">
            <div className="setting-head">
              <Icon name="database" size={15} />
              <span>数据</span>
              <span className="setting-head-note">
                {dataDir ? `${dataDir.layoutCount} 个模板` : ""}
              </span>
            </div>
            <div className="data-dir-path">{dataDir?.dir ?? "读取中…"}</div>
            <div className="button-row">
              <button className="ghost compact" onClick={() => void openDataDir()}>
                <Icon name="folder-open" size={14} />
                打开目录
              </button>
              <button className="ghost compact" disabled={busy} onClick={() => void doBackup()}>
                <Icon name="download" size={14} />
                备份到…
              </button>
            </div>
            <div className="setting-hint">卸载时不会删除这里，重装后模板还在。</div>
            {dataDir?.legacyDir ? (
              <div className="setting-hint warn">
                旧目录仍在：<code>{dataDir.legacyDir}</code>，确认无误后可手动删除。
              </div>
            ) : null}
          </section>

          {note ? <div className="alert success">{note}</div> : null}
          {error ? <div className="alert error">{error}</div> : null}
        </div>

        <div className="modal-footer">
          <button className="primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
