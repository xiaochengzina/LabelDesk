/**
 * 单位换算与几何工具。
 *
 * 关键点：设计稿与打印都基于毫米 + DPI，不依赖屏幕分辨率，
 * 因此同一模板在任何显示器上设计、在任何打印机上输出，物理尺寸都一致。
 */

export const MM_PER_INCH = 25.4;
export const PT_PER_INCH = 72;

/** 毫米 → 像素（按给定 DPI） */
export function mmToPx(mm: number, dpi: number): number {
  return (mm / MM_PER_INCH) * dpi;
}

/** 像素 → 毫米 */
export function pxToMm(px: number, dpi: number): number {
  return (px / dpi) * MM_PER_INCH;
}

/** 磅 → 像素（按给定 DPI）。字号在标签里用 pt 描述，打印时才换算成点阵。 */
export function ptToPx(pt: number, dpi: number): number {
  return (pt / PT_PER_INCH) * dpi;
}

export function pxToPt(px: number, dpi: number): number {
  return (px / dpi) * PT_PER_INCH;
}

/** 毫米 → 1/100 英寸（Windows 打印 API 的单位） */
export function mmToHundredthsInch(mm: number): number {
  return Math.round((mm / MM_PER_INCH) * 100);
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 保留小数位，避免 JSON 里出现 12.000000000000002 这类噪音 */
export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rectContains(r: Rect, px: number, py: number): boolean {
  return px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

/** 把矩形吸附到网格步长（毫米）。step <= 0 时原样返回。 */
export function snap(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}

/** 生成「元素四角」的坐标，供旋转后的命中测试使用。 */
export function rotatedCorners(rect: Rect, rotationDeg: number): Array<{ x: number; y: number }> {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = rect.width / 2;
  const hh = rect.height / 2;
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([dx, dy]) => ({
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  }));
}

/** 判断点是否落在（可能已旋转的）元素内。 */
export function hitTestRotated(rect: Rect, rotationDeg: number, px: number, py: number): boolean {
  if (!rotationDeg) return rectContains(rect, px, py);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const rad = (-rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - cx;
  const dy = py - cy;
  const lx = cx + dx * cos - dy * sin;
  const ly = cy + dx * sin + dy * cos;
  return rectContains(rect, lx, ly);
}

/** 数值输入的友好显示 */
export function fmt(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = round(value, digits);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

/** 生成 8 位纯色 PNG 的 data URL（用于测试页/占位图，避免依赖 canvas 导出） */
export function makeSolidPngDataUrl(widthPx: number, heightPx: number, onWhite = true): string {
  // 手写极简 PNG：IHDR + IDAT（未压缩存储块）+ IEND
  const w = Math.max(1, Math.round(widthPx));
  const h = Math.max(1, Math.round(heightPx));
  const raw = new Uint8Array((w + 1) * h);
  const value = onWhite ? 255 : 0;
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // filter: none
    raw.fill(value, y * (w + 1) + 1, y * (w + 1) + 1 + w);
  }
  const idat = zlibStored(raw);
  const chunks: Uint8Array[] = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  chunks.push(pngChunk("IHDR", ihdr));
  chunks.push(pngChunk("IDAT", idat));
  chunks.push(pngChunk("IEND", new Uint8Array(0)));
  return `data:image/png;base64,${base64FromBytes(concatBytes(chunks))}`;
}

function concatBytes(list: Uint8Array[]): Uint8Array {
  const total = list.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of list) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib「存储」模式（不压缩），足够小数据量使用且无需引入压缩库。 */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  let offset = 0;
  while (offset < data.length || data.length === 0) {
    const len = Math.min(65535, data.length - offset);
    const header = new Uint8Array(5);
    header[0] = offset + len >= data.length ? 1 : 0;
    header[1] = len & 0xff;
    header[2] = (len >> 8) & 0xff;
    header[3] = ~len & 0xff;
    header[4] = (~len >> 8) & 0xff;
    blocks.push(header, data.subarray(offset, offset + len));
    offset += len;
    if (offset >= data.length) break;
  }
  const adler = adler32(data);
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, adler);
  blocks.push(tail);
  return concatBytes(blocks);
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
