//! 打印流水线：RGBA 位图 → 单色位图 → 目标通路（驱动 / 原始指令）。

use crate::printers::raw_print;
use crate::util::*;
use serde::{Deserialize, Serialize};

/// 打印请求。`imageDataUrl` 由前端画布按目标 DPI 渲染后给出。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintSpec {
    pub printer_name: String,
    #[serde(default = "default_job_name")]
    pub job_name: String,
    pub image_data_url: String,
    /// 位图像素宽（= 毫米宽 × DPI）
    pub width_px: u32,
    pub height_px: u32,
    /// 标签物理尺寸（毫米），驱动通路按此尺寸播放
    pub width_mm: f64,
    pub height_mm: f64,
    /// 渲染该位图时使用的 DPI，用于换算物理尺寸
    pub dpi: f64,
    #[serde(default)]
    pub channel: ChannelKind,
    #[serde(default)]
    pub language: LanguageKind,
    #[serde(default)]
    pub copies: u32,
    /// 二值化阈值（0-255），越大越多像素被视为黑
    #[serde(default = "default_threshold")]
    pub threshold: u8,
    #[serde(default)]
    pub density: Option<u32>,
    #[serde(default)]
    pub speed: Option<u32>,
    #[serde(default = "default_gap_mm")]
    pub gap_mm: f64,
    #[serde(default)]
    pub gap_offset_mm: f64,
    /// 走纸方式：gap = 间隙纸，bline = 黑标纸，continuous = 连续纸
    #[serde(default = "default_gap_mode")]
    pub gap_mode: String,
    /// TSPL 位极性：部分固件使用 1=打印（与 TSC 手册相反）
    #[serde(default)]
    pub invert_bits: bool,
    /// 驱动通路：MediaSizeName 为空时用自定义纸张尺寸
    #[serde(default)]
    pub paper_name: Option<String>,
}

fn default_job_name() -> String {
    "LabelDesk 标签".to_string()
}
fn default_threshold() -> u8 {
    160
}
fn default_gap_mm() -> f64 {
    2.0
}
fn default_gap_mode() -> String {
    "gap".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelKind {
    Driver,
    Raw,
}

impl Default for ChannelKind {
    fn default() -> Self {
        ChannelKind::Driver
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LanguageKind {
    Tspl,
    Escpos,
    Zpl,
}

impl Default for LanguageKind {
    fn default() -> Self {
        LanguageKind::Tspl
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintResult {
    pub ok: bool,
    pub message: String,
    /// 实际下发的字节数（原始通路）
    pub bytes_sent: usize,
    /// 生成的单色位图尺寸，便于排查尺寸问题
    pub mono_width_px: u32,
    pub mono_height_px: u32,
    /// 生成的 PNG 预览（base64），驱动通路与调试用
    pub preview_png_base64: Option<String>,
}

/// 一个已解码并可按需填充的位图帧。
pub struct Frame {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

impl Frame {
    pub fn from_data_url(data_url: &str, expected_w: u32, expected_h: u32) -> Result<Frame, String> {
        let (bytes, mime) = decode_data_url(data_url)?;
        if mime.contains("png") || bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
            return decode_png_rgba(&bytes, expected_w, expected_h);
        }
        if mime.contains("bmp") || bytes.starts_with(b"BM") {
            return decode_bmp_rgba(&bytes);
        }
        Err(format!(
            "不支持的图像格式「{mime}」。前端应提供 PNG 或 BMP 数据。"
        ))
    }

    /// 把宽度补齐到 8 的倍数（不足处填白），避免 TSPL/ESC-POS 位图错位。
    pub fn padded_to_byte_width(&self) -> Frame {
        let w_bytes = self.width.div_ceil(8);
        let new_w = w_bytes * 8;
        if new_w == self.width {
            return Frame {
                rgba: self.rgba.clone(),
                width: self.width,
                height: self.height,
            };
        }
        let mut rgba = vec![255u8; (new_w as usize) * (self.height as usize) * 4];
        for y in 0..self.height as usize {
            let src = y * self.width as usize * 4;
            let dst = y * new_w as usize * 4;
            rgba[dst..dst + self.width as usize * 4]
                .copy_from_slice(&self.rgba[src..src + self.width as usize * 4]);
        }
        Frame {
            rgba,
            width: new_w,
            height: self.height,
        }
    }
}

// ---------------------------------------------------------------------------
// 极简 PNG / BMP 解码：只解出 RGBA，避免引入完整图像库
// ---------------------------------------------------------------------------

pub fn decode_png_rgba(png: &[u8], expected_w: u32, expected_h: u32) -> Result<Frame, String> {
    if png.len() < 8 || &png[..8] != &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        return Err("不是合法的 PNG 数据".into());
    }
    let mut pos = 8usize;
    let mut width = 0u32;
    let mut height = 0u32;
    let mut bit_depth = 8u8;
    let mut color_type = 6u8;
    let mut interlace = 0u8;
    let mut idat = Vec::new();
    let mut palette: Vec<[u8; 3]> = Vec::new();
    let mut trns: Vec<u8> = Vec::new();

    while pos + 8 <= png.len() {
        let len = u32::from_be_bytes([png[pos], png[pos + 1], png[pos + 2], png[pos + 3]]) as usize;
        let kind = &png[pos + 4..pos + 8];
        let data_start = pos + 8;
        if data_start + len > png.len() {
            return Err("PNG 数据被截断".into());
        }
        let data = &png[data_start..data_start + len];
        match kind {
            b"IHDR" => {
                if len < 13 {
                    return Err("IHDR 长度不合法".into());
                }
                width = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
                height = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
                bit_depth = data[8];
                color_type = data[9];
                interlace = data[12];
            }
            b"PLTE" => {
                palette = data.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
            }
            b"tRNS" => trns = data.to_vec(),
            b"IDAT" => idat.extend_from_slice(data),
            b"IEND" => break,
            _ => {}
        }
        pos = data_start + len + 4;
    }

    if width == 0 || height == 0 {
        return Err("PNG 缺少 IHDR".into());
    }
    if interlace != 0 {
        return Err("暂不支持隔行扫描（Adam7）的 PNG".into());
    }
    if bit_depth != 8 {
        return Err(format!("暂不支持 {bit_depth} 位深的 PNG，请使用 8 位"));
    }
    let _ = (expected_w, expected_h);

    let raw = inflate(&idat)?;
    let channels: usize = match color_type {
        0 => 1,
        2 => 3,
        3 => 1,
        4 => 2,
        6 => 4,
        other => return Err(format!("不支持的 PNG 颜色类型 {other}")),
    };
    let bpp = channels;
    let stride = width as usize * bpp;
    let expected = (stride + 1) * height as usize;
    if raw.len() < expected {
        return Err(format!(
            "PNG 像素数据不完整（期望 {expected} 字节，实际 {}）",
            raw.len()
        ));
    }

    // 反滤波
    let mut img = vec![0u8; stride * height as usize];
    let mut prev = vec![0u8; stride];
    for y in 0..height as usize {
        let ft = raw[y * (stride + 1)];
        let line = &raw[y * (stride + 1) + 1..y * (stride + 1) + 1 + stride];
        let out_off = y * stride;
        for x in 0..stride {
            let a = if x >= bpp { img[out_off + x - bpp] as i32 } else { 0 };
            let b = prev[x] as i32;
            let c = if x >= bpp { prev[x - bpp] as i32 } else { 0 };
            let v = line[x] as i32;
            let val = match ft {
                0 => v,
                1 => v + a,
                2 => v + b,
                3 => v + (a + b) / 2,
                4 => {
                    let p = a + b - c;
                    let pa = (p - a).abs();
                    let pb = (p - b).abs();
                    let pc = (p - c).abs();
                    if pa <= pb && pa <= pc {
                        v + a
                    } else if pb <= pc {
                        v + b
                    } else {
                        v + c
                    }
                }
                other => return Err(format!("未知的 PNG 滤波类型 {other}")),
            };
            img[out_off + x] = (val & 0xFF) as u8;
        }
        prev.copy_from_slice(&img[out_off..out_off + stride]);
    }

    // 转 RGBA
    let mut rgba = vec![255u8; width as usize * height as usize * 4];
    for i in 0..(width as usize * height as usize) {
        let (r, g, b, a) = match color_type {
            0 => {
                let v = img[i];
                (v, v, v, 255)
            }
            2 => (img[i * 3], img[i * 3 + 1], img[i * 3 + 2], 255),
            3 => {
                let idx = img[i] as usize;
                let p = palette.get(idx).copied().unwrap_or([0, 0, 0]);
                let a = trns.get(idx).copied().unwrap_or(255);
                (p[0], p[1], p[2], a)
            }
            4 => {
                let v = img[i * 2];
                (v, v, v, img[i * 2 + 1])
            }
            _ => (img[i * 4], img[i * 4 + 1], img[i * 4 + 2], img[i * 4 + 3]),
        };
        rgba[i * 4] = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = a;
    }

    Ok(Frame { rgba, width, height })
}

fn inflate(data: &[u8]) -> Result<Vec<u8>, String> {
    use flate2::read::ZlibDecoder;
    use std::io::Read;
    let mut dec = ZlibDecoder::new(data);
    let mut out = Vec::new();
    dec.read_to_end(&mut out)
        .map_err(|e| format!("PNG 解压失败: {e}"))?;
    Ok(out)
}

/// 解码 24/32 位未压缩 BMP（前端在 PNG 之外可选提供的快速通路）。
pub fn decode_bmp_rgba(bmp: &[u8]) -> Result<Frame, String> {
    if bmp.len() < 54 || &bmp[..2] != b"BM" {
        return Err("不是合法的 BMP 数据".into());
    }
    let data_off = u32::from_le_bytes([bmp[10], bmp[11], bmp[12], bmp[13]]) as usize;
    let width = i32::from_le_bytes([bmp[18], bmp[19], bmp[20], bmp[21]]);
    let height_raw = i32::from_le_bytes([bmp[22], bmp[23], bmp[24], bmp[25]]);
    let bpp = u16::from_le_bytes([bmp[28], bmp[29]]);
    if width <= 0 {
        return Err("BMP 宽度不合法".into());
    }
    let bottom_up = height_raw > 0;
    let height = height_raw.unsigned_abs();
    if bpp != 24 && bpp != 32 {
        return Err(format!("仅支持 24/32 位 BMP，当前 {bpp} 位"));
    }
    let bytes_pp = (bpp / 8) as usize;
    let stride = ((width as usize * bytes_pp + 3) / 4) * 4;
    if data_off + stride * height as usize > bmp.len() {
        return Err("BMP 像素数据不完整".into());
    }
    let mut rgba = vec![255u8; width as usize * height as usize * 4];
    for y in 0..height as usize {
        let src_y = if bottom_up { height as usize - 1 - y } else { y };
        for x in 0..width as usize {
            let s = data_off + src_y * stride + x * bytes_pp;
            let d = (y * width as usize + x) * 4;
            rgba[d] = bmp[s + 2];
            rgba[d + 1] = bmp[s + 1];
            rgba[d + 2] = bmp[s];
            rgba[d + 3] = if bytes_pp == 4 { bmp[s + 3] } else { 255 };
        }
    }
    Ok(Frame {
        rgba,
        width: width as u32,
        height,
    })
}

// ---------------------------------------------------------------------------
// 原始指令流生成
// ---------------------------------------------------------------------------

/// 生成 TSPL II 作业流。位图覆盖整张标签，因此 x/y 取 0。
#[allow(clippy::too_many_arguments)]
pub fn build_tspl(
    row_bytes: &[u8],
    w_bytes: u32,
    height: u32,
    width_mm: f64,
    height_mm: f64,
    gap_mm: f64,
    gap_offset_mm: f64,
    gap_mode: &str,
    copies: u32,
    density: Option<u32>,
    speed: Option<u32>,
    dark_bit_zero: bool,
) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(row_bytes.len() + 256);
    let line = |s: String, out: &mut Vec<u8>| {
        out.extend_from_slice(s.as_bytes());
        out.extend_from_slice(b"\r\n");
    };

    line("INITIALPRINTER".into(), &mut out);
    line(format!("SIZE {:.2} mm,{:.2} mm", width_mm, height_mm), &mut out);
    // 黑标纸必须用 BLINE 定位，用 GAP 会导致定位失败、整卷连续走纸
    match gap_mode {
        "bline" => line(
            format!("BLINE {:.2} mm,{:.2} mm", gap_mm.max(0.0), gap_offset_mm),
            &mut out,
        ),
        "continuous" => line("GAP 0.00 mm,0.00 mm".into(), &mut out),
        _ => {
            if gap_mm <= 0.0 {
                line("GAP 0.00 mm,0.00 mm".into(), &mut out);
            } else {
                line(
                    format!("GAP {:.2} mm,{:.2} mm", gap_mm, gap_offset_mm),
                    &mut out,
                );
            }
        }
    }
    line("DIRECTION 0,0".into(), &mut out);
    line("REFERENCE 0,0".into(), &mut out);
    line("OFFSET 0 mm".into(), &mut out);
    line("SHIFT 0".into(), &mut out);
    if let Some(d) = density {
        line(format!("DENSITY {}", d.min(15)), &mut out);
    }
    if let Some(s) = speed {
        line(format!("SPEED {}", s.max(1).min(15)), &mut out);
    }
    line("CLS".into(), &mut out);

    let mut data = row_bytes.to_vec();
    if !dark_bit_zero {
        // 固件使用 1=打印 的极性，逐字节取反
        for b in data.iter_mut() {
            *b = !*b;
        }
    }

    line(format!("BITMAP 0,0,{w_bytes},{height},0,"), &mut out);
    out.extend_from_slice(&data);
    out.extend_from_slice(b"\r\n");
    line(format!("PRINT 1,{}", copies.max(1)), &mut out);
    out
}

/// 生成 ESC/POS 光栅位图作业。GS v 0 单行宽度上限 255 字节，超出则分块。
pub fn build_escpos(
    row_bytes: &[u8],
    w_bytes: u32,
    height: u32,
    copies: u32,
    density: Option<u32>,
) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(&[0x1B, 0x40]); // ESC @ 初始化

    let max_chunk = 255u32;
    let mut x_offset = 0u32;
    while x_offset < w_bytes {
        let chunk = (w_bytes - x_offset).min(max_chunk);
        let chunk_bytes = (chunk as usize) * height as usize;
        out.extend_from_slice(&[0x1B, 0x33, if density.unwrap_or(0) > 0 { 24 } else { 0 }]); // ESC 3 n 行距
        out.extend_from_slice(&[0x1D, 0x76, 0x30, 0x00]);
        out.extend_from_slice(&[(chunk & 0xFF) as u8, ((chunk >> 8) & 0xFF) as u8]);
        out.extend_from_slice(&[(height & 0xFF) as u8, ((height >> 8) & 0xFF) as u8]);

        // 按列块重组：GS v 0 是「按行连续」的，因此逐行取该列块
        for y in 0..height as usize {
            let row = &row_bytes[y * w_bytes as usize..(y + 1) * w_bytes as usize];
            out.extend_from_slice(&row[x_offset as usize..(x_offset + chunk) as usize]);
        }
        let _ = chunk_bytes;
        out.extend_from_slice(b"\n");
        x_offset += chunk;
    }
    out.extend_from_slice(&[0x1D, 0x56, 0x00]); // GS V 0 全切（无切刀机型会忽略）
    for _ in 1..copies.max(1) {
        out.extend_from_slice(&[0x1B, 0x40]);
        out.extend_from_slice(&[0x0A]);
    }
    out
}

/// 生成 ZPL 作业（需先把位图转成 ASCII 十六进制）。
pub fn build_zpl(
    row_bytes: &[u8],
    w_bytes: u32,
    height: u32,
    width_mm: f64,
    height_mm: f64,
    copies: u32,
    density: Option<u32>,
) -> Vec<u8> {
    let dpm = 8u32; // 203dpi ≈ 8 dots/mm
    let mut hex = String::with_capacity(row_bytes.len() * 2);
    for b in row_bytes {
        hex.push_str(&format!("{:02X}", b));
    }
    let total = height * w_bytes;
    let mut s = String::new();
    s.push_str("^XA\r\n");
    s.push_str("^CI28\r\n");
    if let Some(d) = density {
        s.push_str(&format!("^MD{}\r\n", d.min(30)));
    }
    s.push_str(&format!("^PW{}\r\n", w_bytes * 8));
    s.push_str(&format!("^LL{}\r\n", (height_mm * dpm as f64).round() as u32));
    s.push_str("^FO0,0\r\n");
    s.push_str(&format!("^GFA,{},{},{},{}\r\n", total, total, w_bytes, hex));
    s.push_str(&format!("^PQ{}\r\n", copies.max(1)));
    s.push_str("^XZ\r\n");
    let _ = (width_mm, height_mm);
    s.into_bytes()
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/// 执行一次打印。返回给前端的结构化结果，便于 UI 展示诊断信息。
pub fn run_print(spec: &PrintSpec, driver_script: &std::path::Path) -> Result<PrintResult, String> {
    // 1) 解码位图
    let raw_frame = Frame::from_data_url(&spec.image_data_url, spec.width_px, spec.height_px)?;

    // 2) 二值化
    let mono = rgba_to_mono(&raw_frame.rgba, raw_frame.width, raw_frame.height, spec.threshold);
    let (row_bytes, w_bytes) = mono_to_row_bytes(
        &mono,
        raw_frame.width,
        raw_frame.height,
        // TSPL 规范为 0=打印；若用户勾选反转则用 1=打印
        !spec.invert_bits,
    );

    let preview_png = encode_gray_png(&mono, raw_frame.width, raw_frame.height).ok();
    let preview_b64 = preview_png.as_ref().map(|p| {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(p)
    });

    let copies = spec.copies.max(1);

    // 3) 分发
    let (bytes_sent, message) = match spec.channel {
        ChannelKind::Raw => {
            let stream = match spec.language {
                LanguageKind::Tspl => build_tspl(
                    &row_bytes,
                    w_bytes,
                    raw_frame.height,
                    spec.width_mm,
                    spec.height_mm,
                    spec.gap_mm,
                    spec.gap_offset_mm,
                    &spec.gap_mode,
                    copies,
                    spec.density,
                    spec.speed,
                    !spec.invert_bits,
                ),
                LanguageKind::Escpos => {
                    build_escpos(&row_bytes, w_bytes, raw_frame.height, copies, spec.density)
                }
                LanguageKind::Zpl => build_zpl(
                    &row_bytes,
                    w_bytes,
                    raw_frame.height,
                    spec.width_mm,
                    spec.height_mm,
                    copies,
                    spec.density,
                ),
            };
            let sent = raw_print(&spec.printer_name, &spec.job_name, &stream)?;
            (sent, format!("已向「{}」下发原始指令数据", spec.printer_name))
        }
        ChannelKind::Driver => {
            let png = preview_png.ok_or_else(|| "生成打印图像失败".to_string())?;
            let sent = print_via_driver(spec, &png, driver_script, copies)?;
            (
                sent,
                format!(
                    "已提交到「{}」打印队列（{}×{} mm，{} 份）",
                    spec.printer_name, spec.width_mm, spec.height_mm, copies
                ),
            )
        }
    };

    Ok(PrintResult {
        ok: true,
        message,
        bytes_sent,
        mono_width_px: raw_frame.width,
        mono_height_px: raw_frame.height,
        preview_png_base64: preview_b64,
    })
}

/// 走 Windows 驱动：写临时 PNG + 调用打印辅助脚本，按物理毫米尺寸播放。
fn print_via_driver(
    spec: &PrintSpec,
    png: &[u8],
    driver_script: &std::path::Path,
    copies: u32,
) -> Result<usize, String> {
    let dir = std::env::temp_dir().join("LabelDesk");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建临时目录: {e}"))?;
    let stamp = now_millis();
    let png_path = dir.join(format!("print-{stamp}.png"));
    std::fs::write(&png_path, png).map_err(|e| format!("写入临时图像失败: {e}"))?;

    let args = vec![
        "-Action".into(),
        "Print".into(),
        "-Printer".into(),
        spec.printer_name.clone(),
        "-ImagePath".into(),
        png_path.to_string_lossy().to_string(),
        "-ImageDpi".into(),
        format!("{:.0}", spec.dpi),
        "-DrawWidthHundredths".into(),
        format!("{:.0}", (spec.width_mm * 100.0).round()),
        "-DrawHeightHundredths".into(),
        format!("{:.0}", (spec.height_mm * 100.0).round()),
        "-Copies".into(),
        copies.to_string(),
        "-JobName".into(),
        spec.job_name.clone(),
    ];

    let result = run_powershell(driver_script, &args);
    let _ = std::fs::remove_file(&png_path);

    let stdout = result?;
    let json = last_json_line(&stdout);
    if json.is_empty() {
        return Err(format!(
            "驱动打印未返回结果。原始输出：{}",
            stdout.chars().take(400).collect::<String>()
        ));
    }
    let v: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("解析驱动打印结果失败: {e}"))?;
    if v.get("Ok").and_then(|b| b.as_bool()).unwrap_or(false) {
        Ok(v.get("Bytes").and_then(|b| b.as_u64()).unwrap_or(png.len() as u64) as usize)
    } else {
        let msg = v
            .get("Message")
            .and_then(|m| m.as_str())
            .unwrap_or("驱动打印失败");
        Err(msg.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tspl_stream_shape() {
        let rows = vec![0b0000_0000u8, 0b1111_1111];
        let out = build_tspl(
            &rows, 1, 2, 40.0, 30.0, 2.0, 0.0, "gap", 3, Some(8), Some(4), true,
        );
        let text = String::from_utf8_lossy(&out);
        assert!(text.starts_with("INITIALPRINTER\r\n"));
        assert!(text.contains("SIZE 40.00 mm,30.00 mm\r\n"));
        assert!(text.contains("GAP 2.00 mm,0.00 mm\r\n"));
        assert!(text.contains("DENSITY 8\r\n"));
        assert!(text.contains("BITMAP 0,0,1,2,0,"));
        assert!(text.contains("PRINT 1,3\r\n"));
    }

    #[test]
    fn tspl_uses_bline_for_black_mark_paper() {
        // 黑标纸必须用 BLINE；用 GAP 会导致连续走纸
        let out = build_tspl(&[0u8], 1, 1, 40.0, 30.0, 3.0, 1.0, "bline", 1, None, None, true);
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("BLINE 3.00 mm,1.00 mm\r\n"), "缺少 BLINE 指令");
        assert!(!text.contains("GAP"), "黑标纸不应出现 GAP 指令");
    }

    #[test]
    fn tspl_continuous_paper_uses_zero_gap() {
        let out = build_tspl(&[0u8], 1, 1, 40.0, 30.0, 2.0, 0.0, "continuous", 1, None, None, true);
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("GAP 0.00 mm,0.00 mm\r\n"), "连续纸应使用零间隙");
    }

    #[test]
    fn tspl_inverted_polarity_flips_bytes() {
        let rows = vec![0b1010_1010u8];
        let normal = build_tspl(&rows, 1, 1, 10.0, 10.0, 0.0, 0.0, "gap", 1, None, None, true);
        let inverted = build_tspl(&rows, 1, 1, 10.0, 10.0, 0.0, 0.0, "gap", 1, None, None, false);
        assert!(normal.contains(&0b1010_1010));
        assert!(inverted.contains(&0b0101_0101));
    }

    #[test]
    fn escpos_has_raster_header() {
        let rows = vec![0xFFu8, 0x00, 0xFF];
        let out = build_escpos(&rows, 1, 3, 1, None);
        assert_eq!(&out[..2], &[0x1B, 0x40]);
        let pos = out.windows(4).position(|w| w == [0x1D, 0x76, 0x30, 0x00]);
        assert!(pos.is_some(), "ESC/POS 输出必须包含 GS v 0 光栅头");
    }

    #[test]
    fn zpl_has_graphic_field() {
        let rows = vec![0xAAu8];
        let out = build_zpl(&rows, 1, 1, 40.0, 30.0, 2, None);
        let s = String::from_utf8_lossy(&out);
        assert!(s.starts_with("^XA"));
        assert!(s.contains("^GFA,1,1,1,AA"));
        assert!(s.contains("^PQ2"));
        assert!(s.trim_end().ends_with("^XZ"));
    }

    #[test]
    fn png_roundtrip_via_encoder_and_decoder() {
        // 造一张 10x3 的图案 -> 编码 PNG -> 解码回来比对
        let mono: Vec<bool> = (0..30).map(|i| i % 3 == 0).collect();
        let png = encode_gray_png(&mono, 10, 3).unwrap();
        let frame = decode_png_rgba(&png, 10, 3).unwrap();
        assert_eq!((frame.width, frame.height), (10, 3));
        for (i, &dark) in mono.iter().enumerate() {
            let v = frame.rgba[i * 4];
            assert_eq!(v, if dark { 0 } else { 255 }, "第 {i} 个像素不符");
        }
    }

    #[test]
    fn padding_extends_to_byte_boundary_with_white() {
        let f = Frame {
            rgba: vec![0u8; 10 * 2 * 4],
            width: 10,
            height: 2,
        };
        let p = f.padded_to_byte_width();
        assert_eq!(p.width, 16);
        // 补出来的区域必须是白色（解码后 255）
        let last_px = ((1 * 16) + 15) * 4;
        assert_eq!(&p.rgba[last_px..last_px + 4], &[255, 255, 255, 255]);
    }

    #[test]
    fn bmp_decoding_bottom_up() {
        // 2x2 24 位 BMP，自下而上：第一行数据对应图像最下一行
        let mut bmp = vec![0u8; 54];
        bmp[0] = b'B';
        bmp[1] = b'M';
        let data_off: u32 = 54;
        bmp[10..14].copy_from_slice(&data_off.to_le_bytes());
        bmp[18..22].copy_from_slice(&2i32.to_le_bytes());
        bmp[22..26].copy_from_slice(&2i32.to_le_bytes());
        bmp[28..30].copy_from_slice(&24u16.to_le_bytes());
        // 每行 stride = 8 (2*3 补到 4 的倍数)
        let mut px = vec![0u8; 16];
        // 底部行（写入顺序第 0 行，BGR）
        px[0] = 0;
        px[1] = 0;
        px[2] = 255; // 红
        px[3] = 255;
        px[4] = 255;
        px[5] = 255; // 白
        // 顶部行
        px[8] = 255;
        px[9] = 0;
        px[10] = 0; // 蓝
        px[11] = 0;
        px[12] = 0;
        px[13] = 0; // 黑
        bmp.extend_from_slice(&px);

        let f = decode_bmp_rgba(&bmp).unwrap();
        assert_eq!((f.width, f.height), (2, 2));
        // 第一行（图像顶部）= 蓝、黑
        assert_eq!(&f.rgba[0..3], &[0, 0, 255]);
        assert_eq!(&f.rgba[4..7], &[0, 0, 0]);
        // 第二行（图像底部）= 红、白
        assert_eq!(&f.rgba[8..11], &[255, 0, 0]);
        assert_eq!(&f.rgba[12..15], &[255, 255, 255]);
    }

    #[test]
    fn escpos_chunks_wide_images() {
        // 300 字节宽 = 2400 像素，超过 GS v 0 的 255 上限，必须分两块
        let w_bytes = 300u32;
        let height = 2u32;
        let rows = vec![0u8; (w_bytes * height) as usize];
        let out = build_escpos(&rows, w_bytes, height, 1, None);
        let headers = out
            .windows(4)
            .filter(|w| *w == [0x1D, 0x76, 0x30, 0x00])
            .count();
        assert_eq!(headers, 2, "宽位图应切成 2 个光栅块");
    }
}
