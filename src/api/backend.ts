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

export function printLabel(spec: PrintSpec): Promise<PrintResult> {
  return call<PrintResult>("print_label", { spec });
}

export function getDiagnostics(): Promise<Diagnostics> {
  return call<Diagnostics>("diagnostics");
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
