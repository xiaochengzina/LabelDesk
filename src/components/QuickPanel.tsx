/**
 * 速打小窗。
 *
 * 场景：一边在表格里挑机器，一边要打标签。完整窗口太占地方，来回切换又打断节奏。
 * 所以做一个**顶置的窄条小窗**，只放四样东西：
 *
 *   模板选择 · 切回完整窗口 · 粘贴框 · 打印
 *
 * 粘贴后按 Enter（或点打印）直接出纸，打完自动清空并重新聚焦，可以连着打下一台。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  closeQuickMode,
  exitQuickMode,
  listLayouts,
  pickPrinter,
  printLabel,
  readConfig,
  readLayout,
  writeConfig,
  type AppConfig,
  type PrinterInfo,
} from "../api/backend";
import { buildFill, isReadyForQuickPrint } from "../model/fill";
import { mmToPx } from "../model/units";
import { DEFAULT_PRINTER_PROFILE, type LabelLayout } from "../model/types";
import { renderToDataUrl } from "../renderer/renderer";
import { Icon } from "./Icon";

interface TemplateChoice {
  id: string;
  name: string;
}

export function QuickPanel(): JSX.Element {
  const [templates, setTemplates] = useState<TemplateChoice[]>([]);
  const [layout, setLayout] = useState<LabelLayout | null>(null);
  const [printer, setPrinter] = useState<PrinterInfo | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  // 载入可用模板与打印机（只保留配好字段映射的模板）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, config, chosen] = await Promise.all([
          listLayouts(),
          readConfig().catch(() => ({}) as AppConfig),
          pickPrinter().catch(() => null),
        ]);
        if (cancelled) return;
        setPrinter(chosen);

        const usable: TemplateChoice[] = [];
        for (const item of list) {
          try {
            const doc = await readLayout(item.id);
            if (isReadyForQuickPrint(doc)) usable.push({ id: item.id, name: item.name });
          } catch {
            /* 单个模板损坏不影响其他 */
          }
        }
        if (cancelled) return;
        setTemplates(usable);

        const preferred =
          usable.find((t) => t.id === config.lastTemplateId) ?? usable[0] ?? null;
        if (preferred) setLayout(await readLayout(preferred.id));
      } catch (e) {
        if (!cancelled) setMessage({ kind: "err", text: String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 打开就聚焦粘贴框：小窗的意义就是「粘上就打印」
  useEffect(() => {
    const t = window.setTimeout(() => pasteRef.current?.focus(), 150);
    return () => window.clearTimeout(t);
  }, []);

  // 完整窗口被恢复时（含从托盘打开），小窗自己让位
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("mode-switched", (e) => {
      if (e.payload === "full") setPasteText((v) => v);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  const fill = useMemo(
    () => (layout && pasteText.trim() ? buildFill(layout, pasteText) : null),
    [layout, pasteText],
  );

  const profile = useMemo(
    () =>
      layout?.printer ?? {
        ...DEFAULT_PRINTER_PROFILE,
        name: printer?.name ?? "",
        channel: printer?.suggestedChannel ?? "driver",
        language: printer?.suggestedRawLanguage ?? "tspl",
      },
    [layout, printer],
  );

  const canPrint = Boolean(layout && printer && fill?.ok && !busy);

  const changeTemplate = useCallback(async (id: string) => {
    try {
      const doc = await readLayout(id);
      setLayout(doc);
      setMessage(null);
      writeConfig({ lastTemplateId: id }).catch(() => undefined);
      pasteRef.current?.focus();
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const doPrint = useCallback(async () => {
    if (!layout || !printer || !fill) return;
    setBusy(true);
    setMessage(null);
    try {
      const dataUrl = renderToDataUrl(layout, {
        dpi: profile.dpi,
        variables: { ...layout.variables, ...fill.variables },
        binaryThreshold: profile.threshold,
        offsetXMm: profile.offsetXMm,
        offsetYMm: profile.offsetYMm,
      });
      const res = await printLabel({
        printerName: printer.name,
        jobName: layout.name || "LabelDesk 速打",
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
      setMessage({ kind: "ok", text: res.message ? `已打印 · ${res.message}` : "已打印" });
      // 清空并把焦点还回来，便于连续作业
      setPasteText("");
      requestAnimationFrame(() => pasteRef.current?.focus());
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [layout, printer, fill, profile]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (canPrint) void doPrint();
      } else if (e.key === "Escape") {
        e.preventDefault();
        void exitQuickMode();
      }
    },
    [canPrint, doPrint],
  );

  const summary = fill
    ? fill.warnings.length > 0
      ? fill.warnings[0]
      : `${fill.values.filter((v) => !v.field.skip && v.value).length} 项已识别`
    : "粘一行数据，Enter 打印";

  return (
    <div className="quick-root">
      {/* 无边框窗口，自绘一条可拖动的标题栏 */}
      <div className="quick-titlebar" data-tauri-drag-region>
        <Icon name="printer" size={13} />
        <span className="quick-title">速打</span>
        <span className="quick-spacer" data-tauri-drag-region />
        <button
          className="icon-button quick-btn"
          title="切回完整窗口"
          onClick={() => void exitQuickMode()}
        >
          <Icon name="maximize" size={13} />
        </button>
        <button
          className="icon-button quick-btn"
          title="关闭小窗（不退出程序）"
          onClick={() => void closeQuickMode()}
        >
          <Icon name="x" size={13} />
        </button>
      </div>

      <div className="quick-body">
        <div className="quick-row">
          <select
            className="quick-template"
            value={layout?.id ?? ""}
            disabled={templates.length === 0}
            onChange={(e) => void changeTemplate(e.target.value)}
            title="选择模板"
          >
            {templates.length === 0 ? <option value="">（没有可用模板）</option> : null}
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <span className="quick-printer" title={printer?.name ?? "未找到打印机"}>
            {printer?.name ?? "无打印机"}
          </span>
        </div>

        <textarea
          ref={pasteRef}
          className="quick-paste"
          value={pasteText}
          placeholder="粘贴表格里的一行，按 Enter 直接打印"
          onChange={(e) => setPasteText(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />

        <div className="quick-foot">
          <span
            className={fill && fill.warnings.length > 0 ? "quick-msg err" : "quick-msg"}
            title={fill?.warnings.join("\n") ?? ""}
          >
            {message ? message.text : summary}
          </span>
          <button
            className="primary quick-print"
            disabled={!canPrint}
            onClick={() => void doPrint()}
          >
            <Icon name="printer" size={14} />
            {busy ? "打印中…" : "打印"}
          </button>
        </div>
      </div>
    </div>
  );
}
