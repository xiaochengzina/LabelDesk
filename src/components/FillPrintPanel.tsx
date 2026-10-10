/**
 * 「打标签」页 —— 操作员的首屏。
 *
 * 设计目标：**粘贴 → 核对 → 打印**，三步完成，不需要理解任何标签设计概念。
 * 操作员从表格复制一行（只有值），程序按模板里预设的字段顺序把值填进变量。
 *
 * 界面上刻意保留「解析结果」一栏：打印一张废标签的成本，比多看一眼高得多，
 * 而且字段错位时操作员能立刻发现并就地改值。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type { LabelLayout } from "../model/types";
import { buildFill, isReadyForQuickPrint, type FillResult } from "../model/fill";
import { DEFAULT_PRINTER_PROFILE, type PrinterProfile } from "../model/types";
import {
  listLayouts,
  pickPrinter,
  printLabel,
  readConfig,
  readLayout,
  writeConfig,
  type AppConfig,
  type LayoutSummary,
  type PrinterInfo,
} from "../api/backend";
import { renderToDataUrl } from "../renderer/renderer";
import { mmToPx } from "../model/units";
import { setStatus } from "../state/store";

/** 预览用 DPI：够清晰又不至于太慢 */
const PREVIEW_DPI = 203;

interface Props {
  /** 切到设计器（模板没配好时引导管理员过去） */
  onOpenDesigner: () => void;
}

export function FillPrintPanel({ onOpenDesigner }: Props): JSX.Element {
  const [templates, setTemplates] = useState<LayoutSummary[]>([]);
  const [layout, setLayout] = useState<LabelLayout | null>(null);
  const [printer, setPrinter] = useState<PrinterInfo | null>(null);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const pasteRef = useRef<HTMLTextAreaElement | null>(null);

  // ---------------------------------------------------------------- 初始化
  useEffect(() => {
    (async () => {
      try {
        const [list, config, chosen] = await Promise.all([
          listLayouts(),
          readConfig().catch(() => ({}) as AppConfig),
          pickPrinter().catch(() => null),
        ]);
        setTemplates(list);
        setPrinter(chosen);
        if (chosen) setPrinters([chosen]);

        // 只保留配好字段映射的模板，供操作员选择
        const usable: LayoutSummary[] = [];
        for (const item of list) {
          try {
            const doc = await readLayout(item.id);
            if (isReadyForQuickPrint(doc)) usable.push(item);
          } catch {
            /* 单个模板损坏不影响其他模板 */
          }
        }
        setTemplates(usable);

        const preferred =
          usable.find((t) => t.id === config.lastTemplateId) ?? usable[0] ?? null;
        if (preferred) {
          const doc = await readLayout(preferred.id);
          setLayout(doc);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoadingTemplates(false);
      }
    })();
  }, []);

  // 打印机完整列表（供操作员临时切换）
  useEffect(() => {
    import("../api/backend").then((m) =>
      m.listPrinters().then(setPrinters).catch(() => undefined),
    );
  }, []);

  const chooseTemplate = useCallback(async (id: string) => {
    try {
      const doc = await readLayout(id);
      setLayout(doc);
      setPasteText("");
      setOverrides({});
      setLastResult(null);
      setError(null);
      writeConfig({ lastTemplateId: id, lastPrinterName: printer?.name ?? "" }).catch(() => undefined);
      requestAnimationFrame(() => pasteRef.current?.focus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [printer]);

  const choosePrinter = useCallback(
    (name: string) => {
      const found = printers.find((p) => p.name === name) ?? null;
      setPrinter(found);
      writeConfig({ lastTemplateId: layout?.id ?? "", lastPrinterName: name }).catch(() => undefined);
    },
    [printers, layout],
  );

  // ---------------------------------------------------------------- 解析
  const fill: FillResult | null = useMemo(
    () => (layout ? buildFill(layout, pasteText) : null),
    [layout, pasteText],
  );

  /**
   * 最终变量值，优先级：手动覆盖 > 粘贴解析 > 模板默认值。
   *
   * 保留「模板默认值」这一层是有意的：管理员在模板里填了示例值，
   * 一打开就能看到这个标签长什么样（而不是一片空白），
   * 也能立刻发现版式问题，不用先去找一行数据来粘贴。
   */
  const effectiveVariables = useMemo(() => {
    if (!layout) return {};
    const base: Record<string, string> = { ...(layout.variables ?? {}) };
    // 粘贴解析后，即使某列是空的也要覆盖掉示例值，避免把示例当成真实数据打印
    if (fill && pasteText.trim()) {
      for (const item of fill.values) {
        if (item.field.variable) base[item.field.variable] = item.value;
      }
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) base[key] = value;
    }
    return base;
  }, [layout, fill, overrides, pasteText]);

  const canPrint = Boolean(layout && printer && fill?.ok && !busy);
  /** 当前预览是否只是模板示例值（提醒操作员这不是真实数据） */
  const showingSample = !pasteText.trim();

  /** 该模板保存的打印机参数（含定位补偿量） */
  const profile: PrinterProfile = useMemo(
    () =>
      layout?.printer ?? {
        ...DEFAULT_PRINTER_PROFILE,
        name: printer?.name ?? "",
        channel: printer?.suggestedChannel ?? "driver",
        language: printer?.suggestedRawLanguage ?? "tspl",
      },
    [layout, printer],
  );

  // ---------------------------------------------------------------- 预览
  const previewUrl = useMemo(() => {
    if (!layout) return "";
    try {
      return renderToDataUrl(layout, {
        dpi: PREVIEW_DPI,
        variables: effectiveVariables,
        binaryThreshold: null,
        offsetXMm: profile.offsetXMm,
        offsetYMm: profile.offsetYMm,
      });
    } catch {
      return "";
    }
  }, [layout, effectiveVariables, profile.offsetXMm, profile.offsetYMm]);

  // ---------------------------------------------------------------- 打印
  const doPrint = useCallback(async () => {
    if (!layout || !printer) return;
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      const dataUrl = renderToDataUrl(layout, {
        dpi: profile.dpi,
        variables: effectiveVariables,
        binaryThreshold: profile.threshold,
        offsetXMm: profile.offsetXMm,
        offsetYMm: profile.offsetYMm,
      });
      const res = await printLabel({
        printerName: printer.name,
        jobName: layout.name || "LabelDesk 标签",
        imageDataUrl: dataUrl,
        widthPx: Math.round(mmToPx(layout.settings.widthMm, profile.dpi)),
        heightPx: Math.round(mmToPx(layout.settings.heightMm, profile.dpi)),
        widthMm: layout.settings.widthMm,
        heightMm: layout.settings.heightMm,
        dpi: profile.dpi,
        channel: profile.channel,
        language: profile.language,
        copies: 1,
        threshold: profile.threshold,
        density: profile.density,
        speed: profile.speed,
        gapMm: layout.settings.gapMode === "continuous" ? 0 : layout.settings.gapMm,
        gapOffsetMm: layout.settings.gapOffsetMm,
        gapMode: layout.settings.gapMode,
        invertBits: profile.invertBits,
        paperName: profile.paperName ?? null,
      });
      setLastResult(`已打印到「${printer.name}」${res.message ? ` · ${res.message}` : ""}`);
      setStatus("已发送打印任务", "success");

      // 清空以便立刻贴下一台；同时把焦点还给粘贴框
      setPasteText("");
      setOverrides({});
      requestAnimationFrame(() => pasteRef.current?.focus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [layout, printer, effectiveVariables, profile]);

  // 粘贴后自动聚焦，并支持 Ctrl+Enter 直接打印
  const onPasteKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        if (canPrint) void doPrint();
      }
    },
    [canPrint, doPrint],
  );

  // ---------------------------------------------------------------- 渲染
  if (loadingTemplates) {
    return <div className="empty-hint">正在读取模板…</div>;
  }

  if (templates.length === 0) {
    return (
      <div className="fill-empty">
        <h2>还没有可用于打标签的模板</h2>
        <p>
          模板需要先由管理员设计布局、定义变量，并配好「字段映射」（第几列对应哪个变量）。
          <br />
          配好之后，这个页面就能直接粘贴表格里的一行数据出标签了。
        </p>
        <button className="primary" onClick={onOpenDesigner}>
          去设计模板
        </button>
      </div>
    );
  }

  return (
    <div className="fill-layout">
      {/* 左栏：选择 + 粘贴 + 解析结果 */}
      <div className="fill-left">
        <div className="fill-card">
          <div className="fill-row">
            <label>模板</label>
            <select
              value={layout?.id ?? ""}
              onChange={(e) => void chooseTemplate(e.target.value)}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.widthMm && t.heightMm ? `（${t.widthMm}×${t.heightMm}mm）` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="fill-row">
            <label>打印机</label>
            <select value={printer?.name ?? ""} onChange={(e) => choosePrinter(e.target.value)}>
              {printers.length === 0 ? <option value="">未检测到打印机</option> : null}
              {printers.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                  {p.isDefault ? "（默认）" : ""}
                </option>
              ))}
            </select>
          </div>
          {printer?.isOffline ? (
            <div className="alert error">打印机「{printer.name}」当前离线，请检查电源与连接。</div>
          ) : null}
        </div>

        <div className="fill-card grow">
          <div className="fill-card-title">
            粘贴一行数据
            <span className="hint-inline">在表格里选中一台电脑那一行，Ctrl+C，然后在这里 Ctrl+V</span>
          </div>
          <textarea
            ref={pasteRef}
            className="paste-area"
            value={pasteText}
            placeholder="把表格里的一行粘到这里（按 Ctrl+V）……"
            onChange={(e) => {
              setPasteText(e.target.value);
              setOverrides({});
            }}
            onKeyDown={onPasteKeyDown}
            autoFocus
          />
          <div className="fill-actions">
            <button className="ghost compact" onClick={() => { setPasteText(""); setOverrides({}); }}>
              清空
            </button>
            <span className="hint-inline">Ctrl+Enter 可直接打印</span>
          </div>
        </div>

        {fill ? (
          <div className="fill-card grow">
            <div className="fill-card-title">
              解析结果
              <span className="hint-inline">共 {fill.values.length} 项，可手动修正</span>
            </div>
            {fill.warnings.length > 0 ? (
              <div className="alert error">
                {fill.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            ) : null}
            <table className="field-table">
              <tbody>
                {fill.values.map((item, index) => (
                  <tr key={`${item.field.variable}-${index}`} className={item.missing ? "missing" : ""}>
                    <th>{item.field.label || item.field.variable}</th>
                    <td>
                      <input
                        type="text"
                        value={overrides[item.field.variable] ?? item.value}
                        placeholder={item.missing ? "（缺）" : "（空）"}
                        onChange={(e) =>
                          setOverrides((prev) => ({ ...prev, [item.field.variable]: e.target.value }))
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="fill-placeholder">
            粘贴后，这里会逐项列出<strong>表格列 → 变量值</strong>，便于核对有没有错位。
            检测到制表符分隔时最准确。
          </div>
        )}
      </div>

      {/* 右栏：预览 + 打印 */}
      <div className="fill-right">
        <div className="fill-card preview-card">
          <div className="fill-card-title">
            标签预览
            {layout ? (
              <span className="hint-inline">
                {layout.settings.widthMm} × {layout.settings.heightMm} mm
              </span>
            ) : null}
          </div>
          {previewUrl ? (
            <img className="fill-preview" src={previewUrl} alt="标签预览" />
          ) : (
            <div className="empty-hint">选择模板后显示预览</div>
          )}
          {showingSample && layout ? (
            <div className="preview-sample-note">
              显示的是模板里的示例数据，粘贴一行真实数据后会替换
            </div>
          ) : null}
          {profile.offsetXMm || profile.offsetYMm ? (
            <div className="preview-sample-note offset">
              已应用打印机定位补偿：横向 {profile.offsetXMm > 0 ? "+" : ""}
              {profile.offsetXMm} mm，纵向 {profile.offsetYMm > 0 ? "+" : ""}
              {profile.offsetYMm} mm（与实机打印一致）
            </div>
          ) : null}
          {layout?.note ? <div className="hint">{layout.note}</div> : null}
        </div>

        <button className="print-big" onClick={doPrint} disabled={!canPrint}>
          {busy ? "正在发送…" : "打印这张标签"}
        </button>
        {!canPrint && !busy ? (
          <div className="hint center">
            {!printer ? "未选择打印机" : !fill?.ok ? "请先粘贴一行数据" : ""}
          </div>
        ) : null}

        {error ? <div className="alert error">{error}</div> : null}
        {lastResult ? (
          <div className="alert success">
            {lastResult}
            <div className="hint">已清空输入框，可直接粘贴下一台。</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
