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
import {
  buildFill,
  isReadyForQuickPrint,
  serialCandidates,
  summarizeForHistory,
  type FillResult,
} from "../model/fill";
import { formatHoursAgo, useDuplicateGuard } from "../model/printHistory";
import { DEFAULT_PRINTER_PROFILE, type PrinterProfile } from "../model/types";
import {
  listLayouts,
  pickPrinter,
  printHistoryAppend,
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
import { Icon } from "./Icon";

/** 预览用 DPI：够清晰又不至于太慢 */
const PREVIEW_DPI = 203;

interface Props {
  /** 切到设计器（模板没配好时引导管理员过去） */
  onOpenDesigner: () => void;
  /** 从「打印历史」点复打带过来的一行数据；填充后回调清空，避免重复触发 */
  prefill?: { raw: string; templateId: string } | null;
  onPrefillConsumed?: () => void;
}

export function FillPrintPanel({ onOpenDesigner, prefill, onPrefillConsumed }: Props): JSX.Element {
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
  const dup = useDuplicateGuard();
  const pasteRef = useRef<HTMLTextAreaElement | null>(null);
  /** 已应用过的复打内容，避免同一行被重复填充 */
  const appliedPrefill = useRef<string | null>(null);
  /** 区分「挂载首轮」与后续变化 */
  const firstRun = useRef(true);
  /** 打印重入锁：从点击到真正出纸之间不允许再次触发（否则连点会打两张） */
  const printingRef = useRef(false);

  // ---------------------------------------------------------------- 初始化
  useEffect(() => {
    let cancelled = false;
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

        // 选模板的优先级：**复打指定的模板 > 上次用的模板 > 第一个可用模板**
        //
        // 复打必须排第一：初始化要先逐个读模板判断「是否配好字段映射」，
        // 这一步比复打的 effect 慢，若在这里无脑用「上次用的模板」，
        // 就会把复打刚设好的模板覆盖掉，导致那行数据按错误的模板解析。
        let doc: LabelLayout | null = null;
        const wantId = prefill?.templateId;
        if (wantId) {
          try {
            doc = await readLayout(wantId);
          } catch {
            // 模板可能已被删除：退回下面的默认选择
            doc = null;
          }
        }
        if (!doc) {
          const preferred =
            usable.find((t) => t.id === config.lastTemplateId) ?? usable[0] ?? null;
          if (preferred) {
            doc = await readLayout(preferred.id);
          }
        }
        if (cancelled) return;
        if (doc) {
          setLayout(doc);
          // 落盘记住，保证下次启动直接打开同一张模板。
          // 只在和记录不一致时写，避免每次启动都无谓地写文件。
          if (config.lastTemplateId !== doc.id) {
            writeConfig({
              lastTemplateId: doc.id,
              lastPrinterName: chosen?.name ?? "",
            }).catch(() => undefined);
          }
        }
        // 复打带过来的那一行：填进去即可，不自动打印
        if (prefill?.raw) {
          setPasteText(prefill.raw);
          appliedPrefill.current = prefill.raw;
          onPrefillConsumed?.();
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoadingTemplates(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 只在挂载时跑一次：prefill 在挂载时刻的值就是本次要用的
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // 复打兜底：若 prefill 是在挂载之后才变化（正常流程不会发生，因为切页签
  // 会重新挂载本组件），这里也能正确填充。挂载那一刻的 prefill 已由上面的
  // 初始化流程处理，跳过首轮避免两边同时 setLayout 打架。
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (!prefill || appliedPrefill.current === prefill.raw) return;
    let cancelled = false;
    (async () => {
      try {
        if (prefill.templateId && prefill.templateId !== layout?.id) {
          const doc = await readLayout(prefill.templateId);
          if (cancelled) return;
          setLayout(doc);
          writeConfig({ lastTemplateId: doc.id, lastPrinterName: printer?.name ?? "" }).catch(
            () => undefined,
          );
        }
      } catch {
        // 模板可能已被删除：仍然把原文填进去，让用户看到解析结果
      }
      if (cancelled) return;
      setPasteText(prefill.raw);
      setOverrides({});
      setLastResult(null);
      setError(null);
      appliedPrefill.current = prefill.raw;
      requestAnimationFrame(() => pasteRef.current?.focus());
      onPrefillConsumed?.();
    })();
    return () => {
      cancelled = true;
    };
    // 只在 prefill 变化时触发；layout/printer 仅用于比较与记录，不作为触发条件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

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

  /**
   * 把操作员在「解析结果」里手动改过的值合并进解析结果。
   *
   * 查重和历史记录必须用这一份：否则会出现「标签印对了（因为打印用的是
   * effectiveVariables），但历史里记的还是粘贴解析出的空值 / 旧值」，
   * 下次同序列号再打就不会提醒重复。
   */
  const effectiveFill: FillResult | null = useMemo(() => {
    if (!fill) return null;
    const values = fill.values.map((item) => {
      const ov = overrides[item.field.variable];
      if (ov === undefined) return item;
      return { ...item, value: ov, missing: false };
    });
    const variables: Record<string, string> = {};
    for (const item of values) {
      if (item.field.skip || !item.field.variable) continue;
      variables[item.field.variable] = item.value;
    }
    return { ...fill, values, variables };
  }, [fill, overrides]);

  const canPrint = Boolean(layout && printer && fill?.ok && !busy);
  /** 按钮/快捷键的可用状态：查重进行中也算忙，避免连点打两张 */
  const readyToPrint = canPrint && !dup.checking;
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

      // 记一条历史（失败不影响本次打印结果）
      if (effectiveFill) {
        const candidates = serialCandidates(effectiveFill);
        printHistoryAppend({
          serial: candidates[0] ?? "",
          summary: summarizeForHistory(effectiveFill),
          template: layout.name || layout.id,
          templateId: layout.id,
          printer: printer.name,
          quick: false,
          raw: pasteText,
        }).catch(() => {
          // 历史没记上会让判重失效（标签已经打出来了，所以不算打印失败），
          // 必须让用户知道，否则「下次会提醒重复」这个承诺就悄悄失效了。
          setStatus("已打印，但本次未记录历史（判重会失效）", "error");
        });
      }

      // 清空以便立刻贴下一台；同时把焦点还给粘贴框
      setPasteText("");
      setOverrides({});
      requestAnimationFrame(() => pasteRef.current?.focus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [layout, printer, effectiveVariables, profile, effectiveFill, pasteText]);

  /**
   * 先查重，无重复（或用户已确认）才真正打印。
   *
   * 用 ref 做重入锁：查重是个 await，期间按钮仍可点，
   * 连点两下就会真的出两张纸（「忙碌」标志在 doPrint 里才置位，来不及）。
   */
  const requestPrint = useCallback(async () => {
    if (!effectiveFill || printingRef.current) return;
    printingRef.current = true;
    try {
      const ok = await dup.guard(serialCandidates(effectiveFill));
      if (!ok) return; // 已拦下并展示提醒，等用户决定
      await doPrint();
    } finally {
      printingRef.current = false;
    }
  }, [effectiveFill, dup, doPrint]);

  /** 用户点「仍要打印」：跳过本次提醒 */
  const printAnyway = useCallback(async () => {
    if (printingRef.current) return;
    printingRef.current = true;
    dup.dismiss();
    try {
      await doPrint();
    } finally {
      printingRef.current = false;
    }
  }, [dup, doPrint]);

  // 输入或模板一旦变化，上一条重复提醒就过期了 —— 否则会拿旧序列号的提醒
  // 去确认新粘贴的数据，点「仍要打印」等于绕过查重。
  useEffect(() => {
    dup.dismiss();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pasteText, layout?.id]);
  // 粘贴后自动聚焦，并支持 Ctrl+Enter 直接打印
  const onPasteKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        if (readyToPrint) void requestPrint();
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

        <div className="fill-card">
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
          <div className="fill-card grow fill-guide">
            <div className="fill-guide-inner">
              <div className="fill-guide-icon">
                <Icon name="scan-line" size={26} />
              </div>
              <div className="fill-guide-title">还没有粘贴数据</div>
              <ol className="fill-guide-steps">
                <li>
                  <span>
                    在表格里选中<strong>一台电脑的一整行</strong>
                  </span>
                </li>
                <li>
                  按 <kbd>Ctrl</kbd>+<kbd>C</kbd> 复制
                </li>
                <li>
                  回到上面粘贴框，按 <kbd>Ctrl</kbd>+<kbd>V</kbd>
                </li>
              </ol>
              <div className="fill-guide-note">
                粘贴后这里会逐项列出「表格列 → 变量值」，便于核对有没有错位。
              </div>
            </div>
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

        {dup.pending ? (
          <div className="alert warn dup-warning">
            <div>
              这个序列号近期已经打印过：
              {dup.pending.map((h) => (
                <div key={h.serial} className="dup-line">
                  <strong>{h.serial}</strong>
                  <span className="hint-inline">
                    {formatHoursAgo(h.hoursAgo)} · {h.summary || "—"} · {h.template}
                  </span>
                </div>
              ))}
            </div>
            <div className="button-row">
              <button className="ghost compact" onClick={() => dup.dismiss()}>
                取消
              </button>
              <button className="danger compact" onClick={() => void printAnyway()}>
                仍要打印
              </button>
            </div>
          </div>
        ) : null}

        <button className="print-big" onClick={() => void requestPrint()} disabled={!readyToPrint}>
          {busy ? "正在发送…" : dup.checking ? "正在查重…" : "打印这张标签"}
        </button>
        {!readyToPrint && !busy ? (
          <div className="print-reason">
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
