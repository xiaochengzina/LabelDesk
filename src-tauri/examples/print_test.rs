//! 真机自检打印示例。
//!
//! 生成一张 40×30mm 的自检标签（边框 + 中文 + 条码纹理 + 二维码方阵），
//! 分别走「RAW 原始指令」与「Windows 驱动」两条通路测试打印，
//! 用来验证打印链路是否真的通到了打印机。
//!
//! 运行：
//!   cargo run --example print_test -- "Deli DL-888D(NEW)" tspl
//!   cargo run --example print_test -- "Deli DL-888D(NEW)" driver
//!   cargo run --example print_test            # 自动选第一台列为可用打印机
//!
//! 注意：会真的出纸，运行前请确认打印机已装纸。

use labeldesk_lib::print::{ChannelKind, Frame, LanguageKind, PrintSpec};
use labeldesk_lib::printers::{list_printers, raw_print};
use labeldesk_lib::util::{encode_gray_png, mono_to_row_bytes, rgba_to_mono};

const MM_PER_INCH: f64 = 25.4;

/// 画一像素点（越界忽略）
struct Canvas {
    w: u32,
    h: u32,
    px: Vec<u8>,
}

impl Canvas {
    fn new(w: u32, h: u32) -> Self {
        Self {
            w,
            h,
            px: vec![255u8; (w as usize) * (h as usize) * 4],
        }
    }

    fn set(&mut self, x: i32, y: i32, dark: bool) {
        if x < 0 || y < 0 || x >= self.w as i32 || y >= self.h as i32 {
            return;
        }
        let idx = ((y as u32 * self.w + x as u32) * 4) as usize;
        let v = if dark { 0 } else { 255 };
        self.px[idx] = v;
        self.px[idx + 1] = v;
        self.px[idx + 2] = v;
        self.px[idx + 3] = 255;
    }

    fn rect(&mut self, x: i32, y: i32, w: i32, h: i32, thickness: i32) {
        for t in 0..thickness {
            for i in x..x + w {
                self.set(i, y + t, true);
                self.set(i, y + h - 1 - t, true);
            }
            for j in y..y + h {
                self.set(x + t, j, true);
                self.set(x + w - 1 - t, j, true);
            }
        }
    }

    fn fill_row(&mut self, x: i32, y: i32, w: i32, h: i32) {
        for j in y..y + h {
            for i in x..x + w {
                self.set(i, j, true);
            }
        }
    }

    /// 用方块拼出 5×7 点阵数字（免去字体依赖）
    fn digit(&mut self, d: u8, x: i32, y: i32, scale: i32) {
        const FONT: [[&str; 7]; 10] = [
            ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
            ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
            ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
            ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
            ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
            ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
            ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
            ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
            ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
            ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
        ];
        let glyph = FONT[d as usize % 10];
        for (row, line) in glyph.iter().enumerate() {
            for (col, ch) in line.chars().enumerate() {
                if ch == '1' {
                    for dy in 0..scale {
                        for dx in 0..scale {
                            self.set(
                                x + col as i32 * scale + dx,
                                y + row as i32 * scale + dy,
                                true,
                            );
                        }
                    }
                }
            }
        }
    }

    fn to_frame(self) -> Frame {
        Frame {
            rgba: self.px,
            width: self.w,
            height: self.h,
        }
    }
}

fn mm_to_px(mm: f64, dpi: f64) -> u32 {
    ((mm / MM_PER_INCH) * dpi).round() as u32
}

/// 生成自检图案：外框、刻度线、数字编号、条码纹理、二维码方阵
fn build_test_frame(dpi: f64, width_mm: f64, height_mm: f64) -> Frame {
    let w = mm_to_px(width_mm, dpi);
    let h = mm_to_px(height_mm, dpi);
    let mut c = Canvas::new(w, h);
    let d = |mm: f64| mm_to_px(mm, dpi) as i32;

    // 外框
    c.rect(1, 1, w as i32 - 2, h as i32 - 2, d(0.3).max(1));

    // 顶部四角定位方块，用来目视检查边距是否对称
    let mark = d(2.0).max(4);
    c.fill_row(4, 4, mark, mark);
    c.fill_row(w as i32 - 4 - mark, 4, mark, mark);
    c.fill_row(4, h as i32 - 4 - mark, mark, mark);
    c.fill_row(w as i32 - 4 - mark, h as i32 - 4 - mark, mark, mark);

    // 数字：宽度毫米数（如 40）
    let scale = d(0.5).max(2);
    let digits: Vec<u8> = format!("{:.0}", width_mm)
        .bytes()
        .map(|b| b - b'0')
        .collect();
    let glyph_w = 5 * scale + scale;
    let total_w = glyph_w * digits.len() as i32;
    let mut x = (w as i32 - total_w) / 2;
    let y = h as i32 / 2 - 7 * scale / 2;
    for digit in digits {
        c.digit(digit, x, y, scale);
        x += glyph_w;
    }

    // 底部条码纹理：交替宽窄条，用来目视检查细线是否糊
    let bar_y = h as i32 - d(6.0).max(8);
    let bar_h = d(3.0).max(4);
    let mut bx = d(3.0);
    let mut i = 0;
    let pattern = [2, 1, 1, 2, 1, 1, 1, 2, 2, 1, 1, 1];
    while bx < w as i32 - d(3.0) {
        let bw = d(0.25).max(1) * pattern[i % pattern.len()];
        c.fill_row(bx, bar_y, bw, bar_h);
        bx += bw + d(0.25).max(1);
        i += 1;
    }

    // 右上角二维码方阵（纯几何图形，仅用于检查点阵还原度）
    let qs = d(8.0).max(8);
    let qx = w as i32 - qs - d(3.0);
    let qy = d(3.0);
    let cell = (qs / 11).max(1);
    for r in 0..11 {
        for col in 0..11 {
            let finder = (r < 3 && col < 3) || (r < 3 && col > 7) || (r > 7 && col < 3);
            let body = (r + col) % 3 == 0 || (r * col) % 5 == 1;
            if finder || body {
                c.fill_row(qx + col * cell, qy + r * cell, cell, cell);
            }
        }
    }

    c.to_frame()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let wanted = args.first().cloned();
    let mode = args.get(1).cloned().unwrap_or_else(|| "raw".to_string());

    let script = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("printer.ps1");

    println!("== LabelDesk 真机自检 ==");
    let printers = match list_printers(&script) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("枚举打印机失败：{e}");
            std::process::exit(2);
        }
    };
    if printers.is_empty() {
        eprintln!("没有检测到任何打印机");
        std::process::exit(2);
    }
    println!("检测到 {} 台打印机：", printers.len());
    for p in &printers {
        println!(
            "  - {}{}  [{}] 端口 {} 建议通路 {}",
            p.name,
            if p.is_default { "（默认）" } else { "" },
            p.status,
            p.port_name,
            if p.suggested_channel == labeldesk_lib::printers::PrintChannel::Raw {
                "原始指令"
            } else {
                "驱动"
            }
        );
    }

    let target = wanted
        .clone()
        .and_then(|name| printers.iter().find(|p| p.name == name).cloned())
        .or_else(|| printers.iter().find(|p| p.looks_like_label_printer).cloned())
        .or_else(|| printers.iter().find(|p| p.is_default).cloned())
        .unwrap_or_else(|| printers[0].clone());

    let dpi = 203.0f64;
    let width_mm = 40.0f64;
    let height_mm = 30.0f64;
    println!(
        "\n目标打印机：{}  图幅 {}×{} mm @ {:.0}dpi",
        target.name, width_mm, height_mm, dpi
    );

    let frame = build_test_frame(dpi, width_mm, height_mm);
    println!(
        "已生成位图 {}×{} px，打印头 DPI 下的物理尺寸 {:.2}×{:.2} mm",
        frame.width,
        frame.height,
        frame.width as f64 / dpi * MM_PER_INCH,
        frame.height as f64 / dpi * MM_PER_INCH
    );

    let use_raw = mode.eq_ignore_ascii_case("raw") || mode.eq_ignore_ascii_case("tspl");
    let language = if mode.eq_ignore_ascii_case("tspl") || use_raw {
        LanguageKind::Tspl
    } else {
        LanguageKind::Tspl
    };

    let spec = PrintSpec {
        printer_name: target.name.clone(),
        job_name: "LabelDesk 自检".to_string(),
        image_data_url: String::new(),
        width_px: frame.width,
        height_px: frame.height,
        width_mm,
        height_mm,
        dpi,
        channel: if use_raw { ChannelKind::Raw } else { ChannelKind::Driver },
        language,
        copies: 1,
        threshold: 160,
        density: Some(8),
        speed: Some(4),
        gap_mm: 2.0,
        gap_offset_mm: 0.0,
        gap_mode: "gap".to_string(),
        invert_bits: false,
        paper_name: None,
    };

    if use_raw {
        // 直接构造原始指令流，验证 winspool 通路
        let mono = rgba_to_mono(&frame.rgba, frame.width, frame.height, spec.threshold);
        let (rows, w_bytes) = mono_to_row_bytes(&mono, frame.width, frame.height, false);
        let stream = labeldesk_lib::print::build_tspl(
            &rows,
            w_bytes,
            frame.height,
            width_mm,
            height_mm,
            2.0,
            0.0,
            "gap",
            1,
            Some(8),
            Some(4),
            true,
        );
        println!(
            "TSPL 指令流 {} 字节（位图 {} 行 × {} 字节）",
            stream.len(),
            frame.height,
            w_bytes
        );
        match raw_print(&target.name, &spec.job_name, &stream) {
            Ok(n) => println!("✔ 已向打印队列写入 {n} 字节原始指令"),
            Err(e) => {
                eprintln!("✘ 原始打印失败：{e}");
                std::process::exit(1);
            }
        }
    } else {
        // 走驱动：先把位图编码成 PNG，再交给 PowerShell 辅助脚本
        let mono = rgba_to_mono(&frame.rgba, frame.width, frame.height, spec.threshold);
        let png = match encode_gray_png(&mono, frame.width, frame.height) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("PNG 编码失败：{e}");
                std::process::exit(1);
            }
        };
        let tmp = std::env::temp_dir().join("LabelDesk");
        std::fs::create_dir_all(&tmp).ok();
        let path = tmp.join("selftest.png");
        if let Err(e) = std::fs::write(&path, &png) {
            eprintln!("写入临时文件失败：{e}");
            std::process::exit(1);
        }
        println!("PNG {} 字节 -> {}", png.len(), path.display());
        let args = vec![
            "-Action".to_string(),
            "Print".to_string(),
            "-Printer".to_string(),
            target.name.clone(),
            "-ImagePath".to_string(),
            path.to_string_lossy().to_string(),
            "-ImageDpi".to_string(),
            format!("{dpi:.0}"),
            "-DrawWidthHundredths".to_string(),
            format!("{:.0}", width_mm * 100.0),
            "-DrawHeightHundredths".to_string(),
            format!("{:.0}", height_mm * 100.0),
            "-Copies".to_string(),
            "1".to_string(),
            "-JobName".to_string(),
            spec.job_name.clone(),
        ];
        match labeldesk_lib::util::run_powershell(&script, &args) {
            Ok(out) => println!("驱动通路返回：{out}"),
            Err(e) => {
                eprintln!("✘ 驱动打印失败：{e}");
                std::process::exit(1);
            }
        }
    }

    println!("\n提示：若未出纸，请确认打印机在线、已装纸，且标签尺寸与纸仓设置一致。");

    // 复查打印队列：确认作业被正常消化而不是卡住
    std::thread::sleep(std::time::Duration::from_millis(1000));
    let cmd = format!(
        "$q = @(Get-PrintJob -PrinterName '{}' -ErrorAction SilentlyContinue); \
         if ($q.Count -eq 0) {{ 'queue:empty' }} else {{ $q | ForEach-Object {{ 'job:' + $_.Status }} }}",
        target.name.replace('\'', "''")
    );
    match std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &cmd])
        .output()
    {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            let text = text.trim();
            if text.is_empty() || text.contains("queue:empty") {
                println!("✔ 打印队列已清空，作业已被打印机接收");
            } else {
                println!("队列状态：{text}");
            }
        }
        Err(e) => println!("（无法复查打印队列：{e}）"),
    }
}
