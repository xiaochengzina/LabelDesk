//! 把一张现成的 PNG 按指定物理尺寸打成 TSPL 原始指令。
//!
//! 用于端到端验证：前端渲染出的真实标签 → 这里打包 → 写入打印队列。
//!
//!   cargo run --example print_image -- <png 路径> <宽px> <高px> <宽mm> <高mm> [打印机名] [浓度] [速度]
//!
//! 与产品代码共用 `print::build_tspl` 与 `printers::raw_print`，
//! 因此验证的就是真实通路，而不是另写一份。

use labeldesk_lib::print::{build_tspl, decode_png_rgba};
use labeldesk_lib::printers::{list_printers, raw_print};
use labeldesk_lib::util::{mono_to_row_bytes, rgba_to_mono};

fn usage() -> ! {
    eprintln!(
        "用法: print_image <png> <widthPx> <heightPx> <widthMm> <heightMm> [printer] [density] [speed]"
    );
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 5 {
        usage();
    }
    let png_path = &args[0];
    let width_px: u32 = args[1].parse().unwrap_or_else(|_| usage());
    let height_px: u32 = args[2].parse().unwrap_or_else(|_| usage());
    let width_mm: f64 = args[3].parse().unwrap_or_else(|_| usage());
    let height_mm: f64 = args[4].parse().unwrap_or_else(|_| usage());
    let printer_arg = args.get(5).cloned();
    let density: u32 = args.get(6).and_then(|s| s.parse().ok()).unwrap_or(8);
    let speed: u32 = args.get(7).and_then(|s| s.parse().ok()).unwrap_or(4);

    println!("== 端到端真机打印 ==");
    println!("图像：{png_path}");

    let bytes = match std::fs::read(png_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("✘ 读取 PNG 失败：{e}");
            std::process::exit(1);
        }
    };
    let frame = match decode_png_rgba(&bytes, width_px, height_px) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("✘ 解码 PNG 失败：{e}");
            std::process::exit(1);
        }
    };
    println!(
        "解码得到 {}×{} px，期望 {}×{} px",
        frame.width, frame.height, width_px, height_px
    );
    if frame.width != width_px || frame.height != height_px {
        eprintln!("✘ 图像尺寸与参数不一致");
        std::process::exit(1);
    }

    let script = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("printer.ps1");
    let printers = match list_printers(&script) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("✘ 枚举打印机失败：{e}");
            std::process::exit(1);
        }
    };
    let target = printer_arg
        .and_then(|name| printers.iter().find(|p| p.name == name).cloned())
        .or_else(|| printers.iter().find(|p| p.looks_like_label_printer).cloned())
        .or_else(|| printers.iter().find(|p| p.is_default).cloned())
        .unwrap_or_else(|| {
            eprintln!("✘ 没有可用的打印机");
            std::process::exit(1);
        });
    println!("目标打印机：{}", target.name);

    let mono = rgba_to_mono(&frame.rgba, frame.width, frame.height, 160);
    let (rows, w_bytes) = mono_to_row_bytes(&mono, frame.width, frame.height, false);
    let stream = build_tspl(
        &rows,
        w_bytes,
        frame.height,
        width_mm,
        height_mm,
        2.0,
        0.0,
        "gap",
        1,
        Some(density),
        Some(speed),
        true,
    );
    println!(
        "TSPL：{} 字节，位图 {} 行 × {} 字节/行，标签 {:.2}×{:.2} mm",
        stream.len(),
        frame.height,
        w_bytes,
        width_mm,
        height_mm
    );

    match raw_print(&target.name, "LabelDesk 端到端", &stream) {
        Ok(n) => println!("✔ 已向打印队列写入 {n} 字节"),
        Err(e) => {
            eprintln!("✘ 打印失败：{e}");
            std::process::exit(1);
        }
    }

    // 复查队列，确认作业被正常消化
    std::thread::sleep(std::time::Duration::from_millis(1000));
    let cmd = format!(
        "$q = @(Get-PrintJob -PrinterName '{}' -ErrorAction SilentlyContinue); \
         if ($q.Count -eq 0) {{ 'queue:empty' }} else {{ $q | ForEach-Object {{ 'job:' + $_.Status }} }}",
        target.name.replace('\'', "''")
    );
    if let Ok(out) = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &cmd])
        .output()
    {
        let text = String::from_utf8_lossy(&out.stdout);
        let text = text.trim();
        if text.is_empty() || text.contains("queue:empty") {
            println!("✔ 打印队列已清空，作业已被打印机接收");
        } else {
            println!("队列状态：{text}");
        }
    }
}
