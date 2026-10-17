/**
 * 设置对话框。
 *
 * 只放与「程序行为」有关的开关（小窗模式、开机启动）和数据位置信息，
 * 跟标签内容无关的东西不往这里塞，免得操作员误改。
 */

import { useCallback, useEffect, useState, type JSX } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  autostartStatus,
  backupDataDir,
  dataDirInfo,
  enterQuickMode,
  openDataDir,
  printHistoryClear,
  printHistoryRecent,
  setAutostart,
  type AutostartStatus,
  type DataDirInfo,
  type PrintRecord,
} from "../api/backend";
import { formatAt } from "../model/printHistory";
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
  const [history, setHistory] = useState<PrintRecord[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

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
    printHistoryRecent(30)
      .then((h) => {
        if (!cancelled) {
          setHistory(h);
          setHistoryLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setHistoryLoaded(true);
      });
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
      setNote(`已备份到 ${await backupDataDir(target)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const doClearHistory = useCallback(async () => {
    if (!confirm("确定清空打印历史？清空后无法再提醒重复打印。")) return;
    setError(null);
    try {
      await printHistoryClear();
      setHistory([]);
      setNote("打印历史已清空");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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

        <div className="modal-body">
          <div className="section-title">小窗模式</div>
          <div className="hint">
            把程序收成一条<strong>顶置</strong>的小窗，只留模板、粘贴框和打印按钮。
            在表格里复制一行，直接粘到小窗按 Enter 就出纸，不用在表格和打印窗口之间来回切。
          </div>
          <div className="button-row">
            <button
              className="primary"
              onClick={() => {
                onClose();
                void enterQuickMode();
              }}
            >
              <Icon name="maximize" size={15} />
              开启小窗模式
            </button>
          </div>
          <div className="hint">
            小窗顶部左侧按钮切回完整窗口；右侧「关闭」与关闭完整窗口一样，
            <strong>销毁界面并释放内存</strong>，程序留在托盘里，随时可从托盘再打开。
            程序会记住你用的是哪种窗口，下次打开直接回到小窗。
          </div>

          <div className="section-title">数据位置</div>
          <div className="hint">
            模板与应用配置统一放在<strong>安装目录下的 data\</strong>，便于整体备份和搬迁。
          </div>
          <div className="data-dir-path">{dataDir?.dir ?? "读取中…"}</div>
          <div className="hint">
            {dataDir ? `当前有 ${dataDir.layoutCount} 个模板。` : ""}
            卸载程序时<strong>不会</strong>删除这个目录，重装后模板还在。
          </div>
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
          {dataDir?.legacyDir ? (
            <div className="hint">
              检测到旧数据目录仍在：<code>{dataDir.legacyDir}</code>
              。数据已迁移到上面这个位置，确认无误后可以手动删掉旧目录。
            </div>
          ) : null}

          <div className="section-title">打印历史</div>
          <div className="hint">
            每次出纸都会记一条，用来在重复打印同一序列号时提醒你 ——
            标签贴上去撕不下来，重复打印等于浪费一张纸。
          </div>
          {historyLoaded ? (
            history.length === 0 ? (
              <div className="empty-hint">还没有打印记录。</div>
            ) : (
              <ul className="history-list">
                {history.map((h, i) => (
                  <li key={`${h.atMs}-${i}`}>
                    <span className="history-when">{formatAt(h.atMs)}</span>
                    <span className="history-serial">{h.serial || "—"}</span>
                    <span className="history-summary" title={h.summary}>
                      {h.summary || h.template}
                    </span>
                    {h.quick ? <span className="hint-inline">小窗</span> : null}
                  </li>
                ))}
              </ul>
            )
          ) : (
            <div className="hint">读取中…</div>
          )}
          <div className="button-row">
            <button
              className="ghost compact"
              disabled={history.length === 0}
              onClick={() => void doClearHistory()}
            >
              <Icon name="trash" size={14} />
              清空历史
            </button>
          </div>

          <div className="section-title">启动</div>
          <label className="check-row setting-row">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy || status === null}
              onChange={(e) => void toggleAutostart(e.target.checked)}
            />
            <Icon name="power" size={15} />
            开机时自动启动 LabelDesk
          </label>
          <div className="hint">
            {status === null
              ? "正在读取当前状态…"
              : enabled
                ? "已登记开机启动。登录 Windows 后会自动运行。"
                : "已取消开机启动，需要时手动打开即可。"}
          </div>

          <div className="section-title">关闭窗口时</div>
          <div className="hint">
            关闭窗口只会销毁界面（释放内存），<strong>程序与托盘图标仍在</strong>。
            <br />
            点托盘图标即可重新打开，会恢复你上次用的窗口形态。
            想彻底退出，右键托盘图标选「退出」。
          </div>

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
