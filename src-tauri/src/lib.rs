//! LabelDesk 后端入口：统一注册打印、打印机、模板三条命令链。
//!
//! 设计约束（Windows 专用程序）：
//! - 打印是本应用的核心路径，因此 RAW 打印直接调用 winspool，不经过中间进程。
//! - 驱动打印需要一个复用的 PowerShell 辅助脚本（.NET System.Drawing）。
//! - 模板一律以独立 JSON 文件存放，用户可以自行备份、版本管理和手工编辑。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 这些模块同时被单元测试、示例程序（examples/print_test.rs）和 Tauri 命令使用，
// 因此设为 pub 而不是私有模块。
pub mod print;
pub mod printers;
pub mod store;
pub mod util;

use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// 应用运行期状态。
pub struct AppState {
    /// 模板目录（`%APPDATA%\com.labeldesk.app\layouts`）
    layouts_dir: PathBuf,
    /// 驱动打印辅助脚本路径
    printer_script: PathBuf,
}

impl AppState {
    fn layouts(&self) -> &PathBuf {
        &self.layouts_dir
    }
}

/// 定位 `resources/printer.ps1`。
/// 打包后位于资源目录；开发时直接从 crate 源码目录读取，避免必须重新打包。
fn resolve_printer_script(app: &AppHandle) -> PathBuf {
    let candidates: Vec<PathBuf> = {
        let mut v = Vec::new();
        if let Ok(dir) = app.path().resource_dir() {
            v.push(dir.join("resources").join("printer.ps1"));
            v.push(dir.join("printer.ps1"));
        }
        #[cfg(debug_assertions)]
        {
            v.push(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("resources")
                    .join("printer.ps1"),
            );
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                v.push(parent.join("resources").join("printer.ps1"));
            }
        }
        v
    };
    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .unwrap_or_else(|| candidates.first().cloned().unwrap_or_default())
}

// ---------------------------------------------------------------------------
// 打印机
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_printers(state: State<'_, Mutex<AppState>>) -> Result<Vec<printers::PrinterInfo>, String> {
    let st = state.lock().map_err(|_| "内部状态锁定失败".to_string())?;
    printers::list_printers(&st.printer_script)
}

#[tauri::command]
fn print_label(
    spec: print::PrintSpec,
    state: State<'_, Mutex<AppState>>,
) -> Result<print::PrintResult, String> {
    let st = state.lock().map_err(|_| "内部状态锁定失败".to_string())?;
    print::run_print(&spec, &st.printer_script)
}

// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_layouts(state: State<'_, Mutex<AppState>>) -> Result<Vec<store::LayoutSummary>, String> {
    let st = state.lock().map_err(|_| "内部状态锁定失败".to_string())?;
    store::list(st.layouts())
}

#[tauri::command]
fn read_layout(id: String, state: State<'_, Mutex<AppState>>) -> Result<String, String> {
    let st = state.lock().map_err(|_| "内部状态锁定失败".to_string())?;
    store::read_raw(st.layouts(), &id)
}

#[tauri::command]
fn save_layout(id: String, json: String, state: State<'_, Mutex<AppState>>) -> Result<String, String> {
    let st = state.lock().map_err(|_| "内部状态锁定失败".to_string())?;
    store::write_raw(st.layouts(), &id, &json)
}

#[tauri::command]
fn delete_layout(id: String, state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    let st = state.lock().map_err(|_| "内部状态锁定失败".to_string())?;
    store::delete(st.layouts(), &id)
}

#[tauri::command]
fn export_layout(
    id: String,
    target_path: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<String, String> {
    let st = state.lock().map_err(|_| "内部状态锁定失败".to_string())?;
    store::export_to(st.layouts(), &id, std::path::Path::new(&target_path))
}

#[tauri::command]
fn import_layout(
    source_path: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<String, String> {
    let st = state.lock().map_err(|_| "内部状态锁定失败".to_string())?;
    store::import_from(st.layouts(), std::path::Path::new(&source_path))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderRequest {
    layout_json: String,
    #[allow(dead_code)]
    #[serde(default)]
    variables: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// 应用配置
// ---------------------------------------------------------------------------

#[tauri::command]
fn read_config(state: State<'_, Mutex<AppState>>) -> Result<serde_json::Value, String> {
    let st = state.lock().map_err(|_| "内部状态锁定失败".to_string())?;
    Ok(store::read_config(st.layouts()))
}

#[tauri::command]
fn write_config(
    config: serde_json::Value,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let st = state.lock().map_err(|_| "内部状态锁定失败".to_string())?;
    store::write_config(st.layouts(), &config)
}

/// 选一台「最可能可用」的打印机。
///
/// 打标签页的目标是让操作员一键出纸，因此这里集中处理挑选逻辑：
/// 优先已保存过的、其次默认标签机、再次任意标签机、最后系统默认打印机。
/// `preferred` 为用户上次选择的名字，命中即直接返回。
#[tauri::command]
fn pick_printer(
    preferred: Option<String>,
    state: State<'_, Mutex<AppState>>,
) -> Result<Option<printers::PrinterInfo>, String> {
    let st = state.lock().map_err(|_| "内部状态锁定失败".to_string())?;
    let list = printers::list_printers(&st.printer_script)?;
    if let Some(name) = preferred.as_deref() {
        if let Some(found) = list.iter().find(|p| p.name == name) {
            return Ok(Some(found.clone()));
        }
    }
    let chosen = list
        .iter()
        .find(|p| p.is_default && p.looks_like_label_printer)
        .or_else(|| list.iter().find(|p| p.looks_like_label_printer))
        .or_else(|| list.iter().find(|p| p.is_default))
        .or_else(|| list.first())
        .cloned();
    Ok(chosen)
}

/// 预留：后端侧渲染导出（当前版本由前端画布完成，此命令用于后续批量/无人值守导出）。
#[tauri::command]
fn render_layout(req: RenderRequest) -> Result<serde_json::Value, String> {
    let value: serde_json::Value = serde_json::from_str(&req.layout_json)
        .map_err(|e| format!("模板 JSON 解析失败: {e}"))?;
    let width = value.get("widthMm").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let height = value.get("heightMm").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let count = value
        .get("elements")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    Ok(serde_json::json!({
        "widthMm": width,
        "heightMm": height,
        "elementCount": count,
    }))
}

/// 返回环境诊断信息，方便用户排查「为什么打不出来」。
#[tauri::command]
fn diagnostics(state: State<'_, Mutex<AppState>>) -> Result<serde_json::Value, String> {
    let st = state.lock().map_err(|_| "内部状态锁定失败".to_string())?;
    Ok(serde_json::json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "layoutsDir": st.layouts_dir.to_string_lossy(),
        "layoutsDirExists": st.layouts_dir.exists(),
        "printerScript": st.printer_script.to_string_lossy(),
        "printerScriptExists": st.printer_script.exists(),
        "powershellAvailable": util::hidden_command("powershell.exe")
            .arg("-NoProfile").arg("-Command").arg("$PSVersionTable.PSVersion.Major")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|e| format!("不可用: {e}")),
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let layouts_dir = app
                .path()
                .app_data_dir()
                .map(|d| d.join("layouts"))
                .unwrap_or_else(|_| PathBuf::from("layouts"));
            if let Err(e) = std::fs::create_dir_all(&layouts_dir) {
                eprintln!("[LabelDesk] 无法创建模板目录 {}: {e}", layouts_dir.display());
            }
            let printer_script = resolve_printer_script(app.handle());
            if !printer_script.exists() {
                eprintln!(
                    "[LabelDesk] 未找到打印辅助脚本，驱动打印将不可用：{}",
                    printer_script.display()
                );
            }
            app.manage(Mutex::new(AppState {
                layouts_dir,
                printer_script,
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_printers,
            print_label,
            pick_printer,
            list_layouts,
            read_layout,
            save_layout,
            delete_layout,
            export_layout,
            import_layout,
            render_layout,
            read_config,
            write_config,
            diagnostics,
        ])
        .run(tauri::generate_context!())
        .expect("LabelDesk 启动失败");
}
