//! Windows 打印机：枚举（WMI）与 RAW 直接打印（winspool.drv）。
//!
//! 之所以直接调用 winspool 而不是走 PowerShell：RAW 打印是最关键路径，
//! 少一层进程启动既快又少一类失败模式（执行策略、编码、权限）。

use serde::{Deserialize, Serialize};

/// WMI `Win32_Printer` 的原始字段。字段名必须与 PowerShell 输出一致。
#[derive(Debug, Clone, Deserialize)]
struct RawPrinter {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "DriverName")]
    driver_name: Option<String>,
    #[serde(rename = "PortName")]
    port_name: Option<String>,
    #[serde(rename = "Default", default)]
    default: bool,
    #[serde(rename = "WorkOffline", default)]
    work_offline: bool,
    #[serde(rename = "PrinterStatus", default)]
    printer_status: Option<u32>,
    #[serde(rename = "Local", default)]
    local: bool,
    #[serde(rename = "Network", default)]
    network: bool,
}

/// 打印通道：驱动（GDI）或原始指令流。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrintChannel {
    /// 交给 Windows 驱动按物理尺寸打印位图，通用性最好。
    Driver,
    /// 直接下发原始指令（TSPL / ESC/POS / ZPL），热敏机最稳。
    Raw,
}

/// 原始指令语言。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RawLanguage {
    Tspl,
    Escpos,
    Zpl,
}

/// 前端使用的打印机描述。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {    pub name: String,
    pub driver_name: String,
    pub port_name: String,
    pub is_default: bool,
    pub is_offline: bool,
    pub status: String,
    pub is_local: bool,
    pub is_network: bool,
    /// 推测为标签/热敏打印机（驱动名或端口命中已知特征）。
    pub looks_like_label_printer: bool,
    /// 推荐的原始指令语言（当 `looks_like_label_printer` 为真时有效）。
    pub suggested_raw_language: Option<RawLanguage>,
    /// 推荐打印通道。
    pub suggested_channel: PrintChannel,
}

fn status_text(code: Option<u32>) -> String {
    match code {
        Some(1) => "其它",
        Some(2) => "未知",
        Some(3) => "空闲",
        Some(4) => "打印中",
        Some(5) => "预热中",
        Some(6) => "已停止",
        Some(7) => "离线",
        _ => "未知",
    }
    .to_string()
}

/// 已知标签机品牌的驱动名特征（小写匹配）。
const LABEL_DRIVER_HINTS: &[&str] = &[
    "tsc",
    "tspl",
    "zebra",
    "zpl",
    "godex",
    "argox",
    "deli",
    "得力",
    "xprinter",
    "芯烨",
    "hprt",
    "汉印",
    "brother",
    "bixolon",
    "sato",
    "citizen",
    "postek",
    "gprinter",
    "佳博",
    "label",
    "标签",
    "thermal",
    "热敏",
];

fn detect_language(driver: &str, port: &str) -> Option<RawLanguage> {
    // 端口暂不参与判断，但保留参数以便后续区分串口/并口的特殊机型
    let _ = port;
    let d = driver.to_lowercase();
    // ZPL 系（Zebra 及其兼容机）优先判断，避免 "zebra" 被 label 泛化吞掉
    if d.contains("zebra") || d.contains("zpl") {
        return Some(RawLanguage::Zpl);
    }
    if d.contains("esc/pos") || d.contains("escpos") {
        return Some(RawLanguage::Escpos);
    }
    if LABEL_DRIVER_HINTS.iter().any(|h| d.contains(h)) {
        return Some(RawLanguage::Tspl);
    }
    None
}

fn looks_like_label(driver: &str, port: &str) -> bool {
    let p = port.to_lowercase();
    detect_language(driver, port).is_some()
        || p.starts_with("usb")
        || p.starts_with("com")
        || p.starts_with("lpt")
}

/// 枚举本机打印机。失败时返回可读错误（前端展示给用户）。
pub fn list_printers(ps_script: &std::path::Path) -> Result<Vec<PrinterInfo>, String> {
    let script = r#"
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}
try {
  $list = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop | Select-Object Name,DriverName,PortName,Default,WorkOffline,PrinterStatus,Local,Network)
  if ($list.Count -eq 0) { Write-Output '[]' } else { Write-Output ($list | ConvertTo-Json -Depth 4 -Compress) }
} catch {
  Write-Output ('{"error":' + (ConvertTo-Json -InputObject $_.Exception.Message -Compress) + '}')
}
"#;

    // 用临时脚本承载枚举逻辑，保持与 run_powershell 相同的调用约定
    let tmp = std::env::temp_dir().join(format!("labeldesk-enum-{}.ps1", crate::util::now_millis()));
    std::fs::write(&tmp, script).map_err(|e| format!("写入临时脚本失败: {e}"))?;
    let result = crate::util::run_powershell(&tmp, &[]);
    let _ = std::fs::remove_file(&tmp);
    let stdout = result?;
    let _ = ps_script; // 枚举不使用外部脚本资源

    let json = crate::util::last_json_line(&stdout);
    if json.is_empty() {
        return Err(format!("无法解析打印机列表输出: {}", truncate(&stdout, 300)));
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
        if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
            return Err(format!("查询打印机失败: {err}"));
        }
    }
    let raw: Vec<RawPrinter> = serde_json::from_str(&json)
        .map_err(|e| format!("解析打印机列表失败: {e}；原始输出: {}", truncate(&json, 300)))?;

    let mut out: Vec<PrinterInfo> = raw
        .into_iter()
        .map(|p| {
            let driver = p.driver_name.unwrap_or_default();
            let port = p.port_name.unwrap_or_default();
            let lang = detect_language(&driver, &port);
            let is_label = looks_like_label(&driver, &port);
            PrinterInfo {
                is_default: p.default,
                is_offline: p.work_offline,
                status: status_text(p.printer_status),
                is_local: p.local,
                is_network: p.network,
                looks_like_label_printer: is_label,
                suggested_raw_language: lang,
                // 已知标签机优先用原始指令；虚拟打印机（PDF/XPS）只能用驱动
                suggested_channel: if lang.is_some() {
                    PrintChannel::Raw
                } else {
                    PrintChannel::Driver
                },
                name: p.name,
                driver_name: driver,
                port_name: port,
            }
        })
        .collect();

    // 默认打印机排最前，然后标签机，再按名称
    out.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then(b.looks_like_label_printer.cmp(&a.looks_like_label_printer))
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// ---------------------------------------------------------------------------
// winspool.drv FFI：原始字节直接写入打印队列
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win_spool {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    pub type Handle = *mut c_void;

    #[link(name = "winspool")]
    extern "system" {
        pub fn OpenPrinterW(
            printer_name: *const u16,
            printer_handle: *mut Handle,
            defaults: *mut c_void,
        ) -> i32;
        pub fn ClosePrinter(printer_handle: Handle) -> i32;
        pub fn StartDocPrinterW(printer_handle: Handle, level: u32, doc_info: *const u8) -> u32;
        pub fn EndDocPrinter(printer_handle: Handle) -> i32;
        pub fn StartPagePrinter(printer_handle: Handle) -> i32;
        pub fn EndPagePrinter(printer_handle: Handle) -> i32;
        pub fn WritePrinter(
            printer_handle: Handle,
            buffer: *const u8,
            count: u32,
            written: *mut u32,
        ) -> i32;
    }

    /// DOC_INFO_1W：三个连续指针（文档名、输出文件、数据类型）。
    /// 用 usize 承载指针，避免结构体在不同目标架构下的对齐差异。
    pub fn doc_info_1w(doc_name: *const u16, output: *const u16, datatype: *const u16) -> [usize; 3] {
        [doc_name as usize, output as usize, datatype as usize]
    }

    pub fn to_wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    pub fn last_error() -> String {
        let code = std::io::Error::last_os_error();
        format!("{}", code)
    }
}

/// 把原始指令字节直接送入打印队列。Windows 之外返回明确错误。
pub fn raw_print(printer_name: &str, job_name: &str, data: &[u8]) -> Result<usize, String> {
    #[cfg(not(windows))]
    {
        let _ = (printer_name, job_name, data);
        Err("原始打印仅支持 Windows".into())
    }

    #[cfg(windows)]
    {
        use win_spool::*;

        if printer_name.trim().is_empty() {
            return Err("打印机名称为空".into());
        }
        if data.is_empty() {
            return Err("没有可打印的数据".into());
        }

        let name_w = to_wide(printer_name);
        let doc_w = to_wide(job_name);
        let null_out: Vec<u16> = vec![0];
        let datatype_w = to_wide("RAW");

        unsafe {
            let mut handle: Handle = std::ptr::null_mut();
            if OpenPrinterW(name_w.as_ptr(), &mut handle, std::ptr::null_mut()) == 0 {
                return Err(format!(
                    "无法打开打印机「{printer_name}」({})。请确认打印机已开机并在线。",
                    last_error()
                ));
            }

            // 保证任何分支都会 ClosePrinter
            let result = (|| -> Result<usize, String> {
                let info = doc_info_1w(doc_w.as_ptr(), null_out.as_ptr(), datatype_w.as_ptr());
                let job_id = StartDocPrinterW(handle, 1, info.as_ptr() as *const u8);
                if job_id == 0 {
                    return Err(format!("创建打印任务失败 ({})", last_error()));
                }
                if StartPagePrinter(handle) == 0 {
                    let e = last_error();
                    EndDocPrinter(handle);
                    return Err(format!("开始打印页失败 ({e})"));
                }

                let mut written: u32 = 0;
                let ok = WritePrinter(
                    handle,
                    data.as_ptr(),
                    data.len() as u32,
                    &mut written,
                );
                EndPagePrinter(handle);
                EndDocPrinter(handle);

                if ok == 0 {
                    return Err(format!("写入打印数据失败 ({})", last_error()));
                }
                if (written as usize) < data.len() {
                    return Err(format!(
                        "打印数据未完整写入：{} / {} 字节",
                        written,
                        data.len()
                    ));
                }
                Ok(written as usize)
            })();

            ClosePrinter(handle);
            result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_known_label_printers() {
        assert_eq!(
            detect_language("Deli DL-888D(NEW)", "USB001"),
            Some(RawLanguage::Tspl)
        );
        assert_eq!(detect_language("ZDesigner ZD230-203dpi ZPL", "USB001"), Some(RawLanguage::Zpl));
        assert_eq!(
            detect_language("Microsoft Print To PDF", "PORTPROMPT:"),
            None
        );
        assert!(!looks_like_label("Microsoft Print To PDF", "PORTPROMPT:"));
        assert!(looks_like_label("Deli DL-888D(NEW)", "USB001"));
    }

    #[test]
    fn status_mapping_is_chinese() {
        assert_eq!(status_text(Some(3)), "空闲");
        assert_eq!(status_text(None), "未知");
    }
}
