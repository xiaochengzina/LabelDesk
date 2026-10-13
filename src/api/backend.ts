/**
 * 后端命令绑定（Tauri invoke 的类型安全包装）。
 * 所有与 Windows 打印、文件持久化相关的调用都集中在这里，便于统一处理错误。
 */

import { invoke } from "@tauri-apps/api/core";
import type { LabelLayout } from "../model/types";

export interface PrinterInfo {
  name: string;
  driverName: string;
  portName: string;
  isDefault: boolean;
  isOffline: boolean;
  status: string;
  isLocal: boolean;
  isNetwork: boolean;
  looksLikeLabelPrinter: boolean;
  suggestedRawLanguage: "tspl" | "escpos" | "zpl" | null;
  suggestedChannel: "driver" | "raw";
}

export interface AppConfig {
  lastTemplateId?: string;
  lastPrinterName?: string;
  /** 用户是否已就「开机启动」做过选择（首次运行由后端默认开启并置位） */
  autostartDecided?: boolean;
  autostartEnabled?: boolean;
}

/** 开机启动状态 */
export interface AutostartStatus {
  enabled: boolean;
  decided: boolean;
}

export interface LayoutSummary {
  id: string;
  name: string;
  filePath: string;
  widthMm: number | null;
  heightMm: number | null;
  updatedMs: number;
  sizeBytes: number;
}

export interface PrintSpec {
  printerName: string;
  jobName: string;
  imageDataUrl: string;
  widthPx: number;
  heightPx: number;
  widthMm: number;
  heightMm: number;
  dpi: number;
  channel: "driver" | "raw";
  language: "tspl" | "escpos" | "zpl";
  copies: number;
  threshold: number;
  density?: number | null;
  speed?: number | null;
  gapMm: number;
  gapOffsetMm: number;
  /** 走纸方式：gap = 间隙纸，bline = 黑标纸，continuous = 连续纸 */
  gapMode: "gap" | "bline" | "continuous";
  invertBits: boolean;
  paperName?: string | null;
}

export interface PrintResult {
  ok: boolean;
  message: string;
  bytesSent: number;
  monoWidthPx: number;
  monoHeightPx: number;
  previewPngBase64: string | null;
}

export interface Diagnostics {
  appVersion: string;
  os: string;
  arch: string;
  layoutsDir: string;
  layoutsDirExists: boolean;
  printerScript: string;
  printerScriptExists: boolean;
  powershellAvailable: string;
}

/** 把 Tauri 抛出的错误统一成可读字符串 */
function toMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(toMessage(error));
  }
}

// ---------------------------------------------------------------------------
// 打印机与打印
// ---------------------------------------------------------------------------

export function listPrinters(): Promise<PrinterInfo[]> {
  return call<PrinterInfo[]>("list_printers");
}

/** 让后端挑一台最可能可用的打印机（打标签页一键出纸用） */
export function pickPrinter(preferred?: string | null): Promise<PrinterInfo | null> {
  return call<PrinterInfo | null>("pick_printer", { preferred: preferred ?? null });
}

export function printLabel(spec: PrintSpec): Promise<PrintResult> {
  return call<PrintResult>("print_label", { spec });
}

export function getDiagnostics(): Promise<Diagnostics> {
  return call<Diagnostics>("diagnostics");
}

// ---------------------------------------------------------------------------
// 应用配置（记住上次用的模板与打印机）
// ---------------------------------------------------------------------------

export function readConfig(): Promise<AppConfig> {
  return call<AppConfig>("read_config");
}

export function writeConfig(config: AppConfig): Promise<void> {
  return call<void>("write_config", { config });
}

// ---------------------------------------------------------------------------
// 开机启动
// ---------------------------------------------------------------------------

export function autostartStatus(): Promise<AutostartStatus> {
  return call<AutostartStatus>("autostart_status");
}

/** 开关开机启动。后端会同时记下「用户已做选择」，之后不再套用默认值。 */
export function setAutostart(enabled: boolean): Promise<AutostartStatus> {
  return call<AutostartStatus>("set_autostart", { enabled });
}

// ---------------------------------------------------------------------------
// 数据目录
// ---------------------------------------------------------------------------

export interface DataDirInfo {
  /** 数据根目录绝对路径（安装目录下的 data\） */
  dir: string;
  /** 模板数量 */
  layoutCount: number;
  /** 旧位置（%APPDATA%\com.labeldesk.app）若仍存在，便于提示清理 */
  legacyDir: string | null;
}

export function dataDirInfo(): Promise<DataDirInfo> {
  return call<DataDirInfo>("data_dir_info");
}

/** 在文件资源管理器里打开数据目录 */
export function openDataDir(): Promise<string> {
  return call<string>("open_data_dir");
}

/** 把数据目录备份到指定位置，返回备份路径 */
export function backupDataDir(target: string): Promise<string> {
  return call<string>("backup_data_dir", { target });
}

// ---------------------------------------------------------------------------
// 小窗模式
// ---------------------------------------------------------------------------

/** 切到顶置小窗（隐藏完整窗口） */
export function enterQuickMode(): Promise<void> {
  return call<void>("enter_quick_mode");
}

/** 切回完整窗口 */
export function exitQuickMode(): Promise<void> {
  return call<void>("exit_quick_mode");
}

/** 关闭小窗（等价于切回完整窗口，不退出程序） */
export function closeQuickMode(): Promise<void> {
  return call<void>("close_quick_mode");
}
// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------

export function listLayouts(): Promise<LayoutSummary[]> {
  return call<LayoutSummary[]>("list_layouts");
}

export async function readLayout(id: string): Promise<LabelLayout> {
  const raw = await call<string>("read_layout", { id });
  return JSON.parse(raw) as LabelLayout;
}

export function saveLayout(id: string, layout: LabelLayout): Promise<string> {
  return call<string>("save_layout", { id, json: JSON.stringify(layout, null, 2) });
}

export function deleteLayout(id: string): Promise<void> {
  return call<void>("delete_layout", { id });
}

export function exportLayout(id: string, targetPath: string): Promise<string> {
  return call<string>("export_layout", { id, targetPath });
}

export function importLayout(sourcePath: string): Promise<string> {
  return call<string>("import_layout", { sourcePath });
}
