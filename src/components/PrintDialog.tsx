/**
 * 打印对话框：把当前模板渲染成位图并交给后端打印。
 *
 * 关键点：
 * - 按打印机 DPI 渲染，保证物理尺寸精确
 * - 二值化在渲染阶段完成，原始指令通路不会产生灰度网点
 * - 打印前提供预览与诊断信息，避免「点了没反应」的困惑
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { DEFAULT_PRINTER_PROFILE, type PrinterProfile } from "../model/types";
import {
  getDiagnostics,
  listPrinters,
  printLabel,
  type Diagnostics,
  type PrinterInfo,
} from "../api/backend";
import { renderToDataUrl } from "../renderer/renderer";
import { mmToPx } from "../model/units";
import { setLayoutMeta, setStatus, useEditor } from "../state/store";

interface Props {
  onClose: () => void;
}

/** 保留一位小数，避免 ±1 累加后出现 3.0000000000000004 */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function PrintDialog({ onClose }: Props): JSX.Element {
  const doc = useEditor((s) => s.doc);
  const initial = doc.printer ?? DEFAULT_PRINTER_PROFILE;
  const [profile, setProfile] = useState<PrinterProfile>(initial);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);

  const patch = (next: Partial<PrinterProfile>) => setProfile((p) => ({ ...p, ...next }));

  // 读取打印机列表
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listPrinters();
        if (cancelled) return;
        setPrinters(list);
        setProfile((current) => {
          if (current.name && list.some((p) => p.name === current.name)) return current;
          // 自动选择：优先默认打印机，其次第一台标签机，最后第一台
          const preferred =
            list.find((p) => p.isDefault && p.looksLikeLabelPrinter) ??
            list.find((p) => p.isDefault) ??
            list.find((p) => p.looksLikeLabelPrinter) ??
            list[0];
          if (!preferred) return current;
          return {
            ...current,
            name: preferred.name,
            channel: preferred.suggestedChannel,
            language: preferred.suggestedRawLanguage ?? current.language,
          };
        });
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    getDiagnostics().then(setDiagnostics).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // 切换打印机时同步推荐参数
  const onSelectPrinter = (name: string) => {
    const info = printers.find((p) => p.name === name);
    setProfile((current) => ({
      ...current,
      name,
      channel: info?.suggestedChannel ?? current.channel,
      language: info?.suggestedRawLanguage ?? current.language,
    }));
  };

  /** 打印预览：按 DPI 渲染并二值化，所见即所打 */
  const previewUrl = useMemo(() => {
    try {
      return renderToDataUrl(doc, {
        dpi: 96,
        variables: doc.variables,
        binaryThreshold: profile.threshold,
        offsetXMm: profile.offsetXMm,
        offsetYMm: profile.offsetYMm,
      });
    } catch {
      return "";
    }
  }, [doc, profile.threshold, profile.offsetXMm, profile.offsetYMm]);

  const doPrint = useCallback(async () => {
    if (!profile.name) {
      setError("请先选择打印机");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const dataUrl = renderToDataUrl(doc, {
        dpi: profile.dpi,
        variables: doc.variables,
        binaryThreshold: profile.threshold,
        offsetXMm: profile.offsetXMm,
        offsetYMm: profile.offsetYMm,
      });
      const res = await printLabel({
        printerName: profile.name,
        jobName: doc.name || "LabelDesk 标签",
        imageDataUrl: dataUrl,
        widthPx: Math.round(mmToPx(doc.settings.widthMm, profile.dpi)),
        heightPx: Math.round(mmToPx(doc.settings.heightMm, profile.dpi)),
        widthMm: doc.settings.widthMm,
        heightMm: doc.settings.heightMm,
        dpi: profile.dpi,
        channel: profile.channel,
        language: profile.language,
        copies: profile.copies,
        threshold: profile.threshold,
        density: profile.density,
        speed: profile.speed,
        gapMm: doc.settings.gapMode === "continuous" ? 0 : doc.settings.gapMm,
        gapOffsetMm: doc.settings.gapOffsetMm,
        gapMode: doc.settings.gapMode,
        invertBits: profile.invertBits,
        paperName: profile.paperName ?? null,
      });
      setResult(`${res.message}（${res.bytesSent} 字节，位图 ${res.monoWidthPx}×${res.monoHeightPx}）`);
      // 记住这台打印机的参数，随模板一起保存
      setLayoutMeta({ printer: profile });
      setStatus("打印任务已提交", "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [doc, profile]);

  const selectedPrinter = printers.find((p) => p.name === profile.name);
  const isRaw = profile.channel === "raw";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal print-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>打印标签</h2>
          <button className="icon-button" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>

        <div className="modal-body two-column">
          <div className="print-form">
            <div className="field-row">
              <label>打印机</label>
              {loading ? (
                <div className="hint">正在读取打印机列表…</div>
              ) : printers.length === 0 ? (
                <div className="alert error">
                  没有检测到打印机。
                  {loadError ? <div className="hint">{loadError}</div> : null}
                </div>
              ) : (
                <select value={profile.name} onChange={(e) => onSelectPrinter(e.target.value)}>
                  {printers.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                      {p.isDefault ? "（默认）" : ""}
                      {p.looksLikeLabelPrinter ? " · 标签机" : ""}
                      {p.isOffline ? " · 离线" : ""}
                    </option>
                  ))}
                </select>
              )}
              {selectedPrinter ? (
                <div className="hint">
                  驱动：{selectedPrinter.driverName || "未知"} · 端口：{selectedPrinter.portName || "未知"} · 状态：
                  {selectedPrinter.status}
                </div>
              ) : null}
            </div>

            <div className="field-row">
              <label>打印方式</label>
              <div className="radio-row">
                <label className="check-row">
                  <input
                    type="radio"
                    checked={profile.channel === "driver"}
                    onChange={() => patch({ channel: "driver" })}
                  />
                  Windows 驱动（通用）
                </label>
                <label className="check-row">
                  <input type="radio" checked={isRaw} onChange={() => patch({ channel: "raw" })} />
                  原始指令（热敏机更稳）
                </label>
              </div>
              <div className="hint">
                {profile.channel === "driver"
                  ? "走打印驱动按物理尺寸输出，兼容性最好；需要驱动里已配置好标签尺寸。"
                  : "直接把位图指令发给打印机，跳过驱动排版，热敏标签机推荐。"}
              </div>
            </div>

            {isRaw ? (
              <div className="field-row">
                <label>指令语言</label>
                <select
                  value={profile.language}
                  onChange={(e) => patch({ language: e.target.value as PrinterProfile["language"] })}
                >
                  <option value="tspl">TSPL / TSPL2（TSC、得力、佳博、汉印等）</option>
                  <option value="escpos">ESC/POS（小票机、部分标签机）</option>
                  <option value="zpl">ZPL（Zebra 及兼容机）</option>
                </select>
              </div>
            ) : null}

            <div className="grid-2">
              <label className="mini-field">
                <span>打印头 DPI</span>
                <select value={profile.dpi} onChange={(e) => patch({ dpi: Number(e.target.value) })}>
                  <option value={203}>203 dpi（8 点/mm）</option>
                  <option value={300}>300 dpi（12 点/mm）</option>
                  <option value={600}>600 dpi</option>
                </select>
              </label>
              <label className="mini-field">
                <span>份数</span>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={profile.copies}
                  onChange={(e) => patch({ copies: Math.max(1, Math.min(200, Number(e.target.value))) })}
                />
                <em>份</em>
              </label>
            </div>

            {isRaw ? (
              <div className="grid-2">
                <label className="mini-field">
                  <span>浓度</span>
                  <input
                    type="number"
                    min={0}
                    max={15}
                    value={profile.density}
                    onChange={(e) => patch({ density: Math.max(0, Math.min(15, Number(e.target.value))) })}
                  />
                </label>
                <label className="mini-field">
                  <span>速度</span>
                  <input
                    type="number"
                    min={1}
                    max={15}
                    value={profile.speed}
                    onChange={(e) => patch({ speed: Math.max(1, Math.min(15, Number(e.target.value))) })}
                  />
                  <em>ips</em>
                </label>
              </div>
            ) : null}

            <div className="field-row inline">
              <label>二值化阈值</label>
              <input
                type="range"
                min={0}
                max={255}
                value={profile.threshold}
                onChange={(e) => patch({ threshold: Number(e.target.value) })}
              />
              <em className="unit">{profile.threshold}</em>
            </div>
            <div className="hint">
              热敏纸只有黑白两态。阈值越小越「浅」，越大墨越重；文字发虚就调大，笔画糊在一起就调小。
            </div>

            {isRaw ? (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={profile.invertBits}
                  onChange={(e) => patch({ invertBits: e.target.checked })}
                />
                反转位极性（打出来整张发黑时勾选）
              </label>
            ) : null}

            <div className="section-title">定位补偿</div>
            <div className="hint">
              热敏标签机的坐标原点不等于标签左边缘，装纸位置也会左右差几毫米，
              所以内容常整体偏移。打一张对比后在这里补正：
              <strong>内容被左边裁掉就把横向调大</strong>，内容偏下就把纵向调小。补偿量随模板保存。
            </div>
            <div className="grid-2">
              <label className="mini-field">
                <span>横向</span>
                <input
                  type="number"
                  step={0.5}
                  min={-20}
                  max={20}
                  value={profile.offsetXMm}
                  onChange={(e) => patch({ offsetXMm: Number(e.target.value) })}
                />
                <em>mm</em>
              </label>
              <label className="mini-field">
                <span>纵向</span>
                <input
                  type="number"
                  step={0.5}
                  min={-20}
                  max={20}
                  value={profile.offsetYMm}
                  onChange={(e) => patch({ offsetYMm: Number(e.target.value) })}
                />
                <em>mm</em>
              </label>
            </div>
            <div className="button-row">
              <button
                className="ghost compact"
                onClick={() => patch({ offsetXMm: 0, offsetYMm: 0 })}
                title="回到不补偿的状态"
              >
                归零
              </button>
              <button
                className="ghost compact"
                onClick={() => patch({ offsetXMm: round1(profile.offsetXMm + 1) })}
              >
                横向 +1
              </button>
              <button
                className="ghost compact"
                onClick={() => patch({ offsetXMm: round1(profile.offsetXMm - 1) })}
              >
                横向 −1
              </button>
              <button
                className="ghost compact"
                onClick={() => patch({ offsetYMm: round1(profile.offsetYMm + 1) })}
              >
                纵向 +1
              </button>
              <button
                className="ghost compact"
                onClick={() => patch({ offsetYMm: round1(profile.offsetYMm - 1) })}
              >
                纵向 −1
              </button>
            </div>
          </div>

          <div className="print-preview">
            <div className="section-title">打印预览（黑白二值）</div>
            {previewUrl ? (
              <img src={previewUrl} alt="打印预览" className="preview-image" />
            ) : (
              <div className="empty-hint">预览生成失败</div>
            )}
            <div className="hint">
              尺寸 {doc.settings.widthMm} × {doc.settings.heightMm} mm · 输出{" "}
              {Math.round(mmToPx(doc.settings.widthMm, profile.dpi))} ×{" "}
              {Math.round(mmToPx(doc.settings.heightMm, profile.dpi))} px @ {profile.dpi}dpi
            </div>

            {diagnostics ? (
              <details className="diagnostics">
                <summary>环境诊断</summary>
                <ul>
                  <li>应用版本：{diagnostics.appVersion}</li>
                  <li>
                    模板目录：{diagnostics.layoutsDir} {diagnostics.layoutsDirExists ? "✓" : "（不存在）"}
                  </li>
                  <li>
                    打印脚本：{diagnostics.printerScriptExists ? "已就绪" : "缺失（驱动打印不可用）"}
                  </li>
                  <li>PowerShell：{diagnostics.powershellAvailable || "未知"}</li>
                </ul>
              </details>
            ) : null}

            {error ? <div className="alert error">{error}</div> : null}
            {result ? <div className="alert success">{result}</div> : null}
          </div>
        </div>

        <div className="modal-footer">
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
          <button className="primary" onClick={doPrint} disabled={busy || !profile.name}>
            {busy ? "正在发送…" : `打印${profile.copies > 1 ? ` ${profile.copies} 份` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
