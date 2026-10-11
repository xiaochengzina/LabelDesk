/**
 * 设置对话框。
 *
 * 只放与「程序行为」有关的开关（开机启动），跟标签内容无关的东西不往这里塞，
 * 免得操作员误改。
 */

import { useCallback, useEffect, useState, type JSX } from "react";
import { autostartStatus, setAutostart, type AutostartStatus } from "../api/backend";
import { Icon } from "./Icon";

interface Props {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: Props): JSX.Element {
  const [status, setStatus] = useState<AutostartStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    autostartStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
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

  const toggle = useCallback(
    async (next: boolean) => {
      setBusy(true);
      setError(null);
      try {
        setStatus(await setAutostart(next));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

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
          <div className="section-title">启动</div>
          <label className="check-row setting-row">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy || status === null}
              onChange={(e) => void toggle(e.target.checked)}
            />
            <Icon name="power" size={15} />
            开机时自动启动 LabelDesk
          </label>
          <div className="hint">
            {status === null
              ? "正在读取当前状态…"
              : enabled
                ? "已登记开机启动。登录 Windows 后会自动运行，不需要去开始菜单找。"
                : "已取消开机启动，需要时手动打开即可。"}
          </div>

          <div className="section-title">关闭窗口时</div>
          <div className="hint">
            点窗口右上角的关闭按钮会<strong>结束程序并释放内存</strong>，同时
            <strong>在托盘保留一个图标</strong>。
            <br />
            需要继续用时，点托盘图标即可重新打开（会重新加载模板，不影响已保存的内容）。
            想彻底退出，右键托盘图标选「退出」。
          </div>

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
