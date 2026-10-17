//! LabelDesk 后端入口：统一注册打印、打印机、模板三条命令链。
//!
//! 设计约束（Windows 专用程序）：
//! - 打印是本应用的核心路径，因此 RAW 打印直接调用 winspool，不经过中间进程。
//! - 驱动打印需要一个复用的 PowerShell 辅助脚本（.NET System.Drawing）。
//! - 模板一律以独立 JSON 文件存放，用户可以自行备份、版本管理和手工编辑。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 这些模块同时被单元测试、示例程序（examples/print_test.rs）和 Tauri 命令使用，
// 因此设为 pub 而不是私有模块。
pub mod autostart;
pub mod datadir;
pub mod print;
pub mod printlog;
pub mod printers;
pub mod store;
pub mod util;

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};

/// 主窗口标签
const MAIN_WINDOW: &str = "main";
/// 托盘图标 id，用于在事件里确认来源
const TRAY_ID: &str = "labeldesk-tray";
/// 小窗（速打窗）标签
const QUICK_WINDOW: &str = "quick";
/// 从托盘重建窗口后通知前端：该重新同步配置与模板了
const EVENT_TRAY_REOPEN: &str = "tray-reopen";
/// 小窗与完整窗口互切后通知前端刷新
const EVENT_MODE_SWITCHED: &str = "mode-switched";
/// 配置里记录「上次用的是不是小窗形态」，下次启动据此还原
const PREF_QUICK_MODE: &str = "quickMode";


/// 应用运行期状态。
pub struct AppState {
    /// 数据目录（安装目录下的 `data\`）
    data_dir: PathBuf,
    /// 模板目录（`data\layouts`）
    layouts_dir: PathBuf,
    /// 驱动打印辅助脚本路径
    printer_script: PathBuf,
    /// 是否用的小窗形态（托盘/再次启动时据此还原）
    quick_mode: bool,
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
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // 数据统一放在安装目录下的 data\（详见 datadir 模块）。
            // 先建目录，再把老版本留在 %APPDATA% 的数据搬过来。
            let data_dir = datadir::ensure()?;
            match datadir::migrate_legacy_if_needed(&data_dir) {
                Ok(0) => {}
                Ok(n) => eprintln!("[LabelDesk] 已迁移 {n} 个数据文件到 {}", data_dir.display()),
                Err(e) => eprintln!("[LabelDesk] 迁移旧数据失败（不影响启动）: {e}"),
            }
            let layouts_dir = data_dir.join("layouts");
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

            // 开机启动：首次运行默认开启，之后尊重用户的选择
            let handle = app.handle().clone();
            let config = store::read_config(&layouts_dir);
            let decided = config
                .get(autostart::decided_key())
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let (enabled, decided_now) =
                autostart::apply_default_if_first_run(&handle, decided, autostart::is_enabled(&handle));
            if decided_now {
                let mut next = config.clone();
                if let Some(obj) = next.as_object_mut() {
                    obj.insert(
                        autostart::decided_key().to_string(),
                        serde_json::Value::Bool(true),
                    );
                    obj.insert(
                        "autostartEnabled".to_string(),
                        serde_json::Value::Bool(enabled),
                    );
                }
                if let Err(e) = store::write_config(&layouts_dir, &next) {
                    eprintln!("[LabelDesk] 写入开机启动默认值失败：{e}");
                }
                eprintln!("[LabelDesk] 首次运行，已默认开启开机启动");
            }

            // 上次退出时是不是小窗形态；启动时按它决定显示哪个窗口
            let quick_mode = config
                .get(PREF_QUICK_MODE)
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            app.manage(Mutex::new(AppState {
                data_dir,
                layouts_dir,
                printer_script,
                quick_mode,
            }));

            setup_tray(app)?;

            // 配置里的窗口都是隐藏声明的：这样托盘先就绪再显示，
            // 不会出现「窗口已出现但点关闭没反应」的空窗期。
            //
            // 显示哪种形态取决于上次退出时用的是哪种（quick_mode，来自配置），
            // 所以完全退出再打开也能回到小窗，不会莫名弹出一个大窗口。
            if quick_mode {
                match ensure_quick_window(app.handle()) {
                    Ok(win) => {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                    Err(e) => {
                        // 小窗建不起来就退回完整窗口，不能让程序看起来没启动
                        eprintln!("[LabelDesk] {e}；改为显示完整窗口");
                        if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
                            let _ = main.show();
                            let _ = main.set_focus();
                        }
                    }
                }
            } else if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.show();
                let _ = window.set_focus();
            } else {
                eprintln!("[LabelDesk] 未找到主窗口 {MAIN_WINDOW}");
            }
            Ok(())
        })
        // 关闭窗口：销毁 WebView（把它的内存还给系统），但**保留托盘**。
        //
        // 为什么不在窗口事件里 prevent_close()：那是「别关窗口」的意思，
        // 与「关掉窗口但留住托盘」是两回事。正确做法是让窗口正常关闭，
        // 然后在 RunEvent::ExitRequested 里拒绝「最后一个窗口没了就退出进程」。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // 两种窗口的关闭行为一致：销毁 WebView（释放内存），
                // 进程与托盘留着，随时可以从托盘回来。
                if matches!(window.label(), MAIN_WINDOW | QUICK_WINDOW) {
                    let _ = window.destroy();
                }
            }
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
            autostart_status,
            set_autostart,
            data_dir_info,
            open_data_dir,
            backup_data_dir,
            enter_quick_mode,
            exit_quick_mode,
            close_quick_mode,
            print_history_check,
            print_history_append,
            print_history_recent,
            print_history_clear,
            diagnostics,
        ])
        .build(tauri::generate_context!())
        .expect("LabelDesk 启动失败")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                // 「最后一个窗口关闭」会请求退出进程；托盘还在时拒绝它。
                // 托盘「退出」已把标志置位，那种情况放行。
                if !QUIT_REQUESTED.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        });
}

// ---------------------------------------------------------------------------
// 打印历史与去重
// ---------------------------------------------------------------------------

/// 打印前查重：给出候选标识（序列号等），返回近期已打印过的。
#[tauri::command]
fn print_history_check(
    candidates: Vec<String>,
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<printlog::DuplicateHit>, String> {
    let dir = state
        .lock()
        .map_err(|_| "状态锁已损坏".to_string())?
        .data_dir
        .clone();
    Ok(printlog::find_recent_duplicates(&dir, &candidates))
}

/// 打印成功后记一条。
#[tauri::command]
fn print_history_append(
    serial: String,
    summary: String,
    template: String,
    printer: String,
    quick: bool,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let dir = state
        .lock()
        .map_err(|_| "状态锁已损坏".to_string())?
        .data_dir
        .clone();
    let record = printlog::PrintRecord {
        at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        serial,
        summary,
        template,
        printer,
        quick,
    };
    printlog::append(&dir, &record)
}

/// 最近 N 条历史（供设置页查看）。
#[tauri::command]
fn print_history_recent(
    limit: usize,
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<printlog::PrintRecord>, String> {
    let dir = state
        .lock()
        .map_err(|_| "状态锁已损坏".to_string())?
        .data_dir
        .clone();
    let mut all = printlog::read_all(&dir);
    all.reverse();
    all.truncate(limit.max(1));
    Ok(all)
}

#[tauri::command]
fn print_history_clear(state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    let dir = state
        .lock()
        .map_err(|_| "状态锁已损坏".to_string())?
        .data_dir
        .clone();
    printlog::clear(&dir)
}
// ---------------------------------------------------------------------------
// 小窗模式
// ---------------------------------------------------------------------------

/// 速打小窗的逻辑尺寸（无边框，整块都是内容区）。窄而矮，顶置在表格旁边不挡视线。
const QUICK_W: f64 = 470.0;
const QUICK_H: f64 = 200.0;

/// 建好小窗（隐藏）。首次切到小窗时创建，之后复用。
fn ensure_quick_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(win) = app.get_webview_window(QUICK_WINDOW) {
        return Ok(win);
    }
    tauri::WebviewWindowBuilder::new(
        app,
        QUICK_WINDOW,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("LabelDesk 速打")
    .inner_size(QUICK_W, QUICK_H)
    .min_inner_size(380.0, 170.0)
    .resizable(true)
    // 顶置：粘贴时不用来回切窗口
    .always_on_top(true)
    // 不用系统标题栏：小窗要尽量省高度，只保留自己画的一条操作栏。
    // 代价是拖动要自己做（见 QuickPanel 的 drag-region）。
    .decorations(false)
    .visible(false)
    .build()
    .map_err(|e| format!("创建小窗失败: {e}"))
}

/// 把窗口形态写进配置，下次启动（含完全退出后重开）据此还原。
///
/// 失败只记日志：形态没存上不该影响这次切换。
fn persist_mode(data_dir: &Path, quick: bool) {
    // 注意：store 的配置路径是「layouts 目录的父级」，所以这里必须传 layouts 目录。
    // 传 data_dir 会把配置写到 data\ 的上一级（曾因此写出一个只含 quickMode 的野文件）。
    let layouts = data_dir.join("layouts");
    let mut config = store::read_config(&layouts);
    if let Some(obj) = config.as_object_mut() {
        obj.insert(PREF_QUICK_MODE.to_string(), serde_json::Value::Bool(quick));
    }
    if let Err(e) = store::write_config(&layouts, &config) {
        eprintln!("[LabelDesk] 保存窗口形态失败: {e}");
    }
}



/// 切到小窗形态：隐藏完整窗口，显示顶置小窗。
#[tauri::command]
fn enter_quick_mode(app: AppHandle, state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    // 注意顺序：State 的锁在这个作用域内一直有效，若在持锁时再调
    // 会取同一把锁的写入函数就会自死锁（之前 persist_mode 静默失败就是这个原因）。
    // 所以先把需要的数据取出来，锁随作用域结束释放，再做落盘。
    let data_dir = {
        let mut s = state.lock().map_err(|_| "内部状态锁定失败".to_string())?;
        s.quick_mode = true;
        s.data_dir.clone()
    };
    persist_mode(&data_dir, true);

    // 关键：**不能在命令里同步创建/显示窗口**。
    // Tauri 命令跑在主线程上，而在主线程里同步创建 WebView2 并 show()
    // 会卡住事件循环（实测：窗口被创建出来但始终不可见，命令永不返回）。
    // 丢到后台线程做，命令立刻返回。
    let handle = app.clone();
    std::thread::spawn(move || switch_to_quick(&handle));
    Ok(())
}

/// 切到小窗形态（在后台线程执行）
fn switch_to_quick(app: &AppHandle) {
    let win = match ensure_quick_window(app) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[LabelDesk] {e}");
            return;
        }
    };
    if let Err(e) = win.show() {
        eprintln!("[LabelDesk] 显示小窗失败: {e}");
    }
    let _ = win.set_focus();
    if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
        let _ = main.hide();
    }
}

/// 从托盘/快捷键切回小窗
fn show_quick_window(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        switch_to_quick(&handle);
        let _ = handle.emit(EVENT_MODE_SWITCHED, "quick");
    });
}

/// 切回完整窗口：隐藏小窗，显示并聚焦完整窗口。
#[tauri::command]
fn exit_quick_mode(app: AppHandle, state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    let data_dir = {
        let mut s = state.lock().map_err(|_| "内部状态锁定失败".to_string())?;
        s.quick_mode = false;
        s.data_dir.clone()
    };
    persist_mode(&data_dir, false);
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Some(quick) = handle.get_webview_window(QUICK_WINDOW) {
            let _ = quick.hide();
        }
        if let Some(main) = handle.get_webview_window(MAIN_WINDOW) {
            let _ = main.show();
            let _ = main.unminimize();
            let _ = main.set_focus();
        } else {
            open_main_window(&handle);
        }
        let _ = handle.emit(EVENT_MODE_SWITCHED, "full");
    });
    Ok(())
}

/// 关闭小窗：与关闭完整窗口一致 —— 销毁 WebView 释放内存，进程与托盘留着。
///
/// 刻意不做成「切回完整窗口」：那个按钮是「完整窗口」，语义不同。
/// 这里要的是「先别占内存」，需要时点托盘或用完整窗口按钮再回来。
#[tauri::command]
fn close_quick_mode(app: AppHandle, _state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Some(quick) = handle.get_webview_window(QUICK_WINDOW) {
            let _ = quick.destroy();
        }
    });
    Ok(())
}
// ---------------------------------------------------------------------------
// 系统托盘
// ---------------------------------------------------------------------------

/// 用户是否从托盘明确选择了「退出」。
///
/// 关闭窗口只是销毁 WebView、留住托盘；只有走托盘「退出」才真的结束进程。
/// 用原子标志把这两个意图区分开，否则 ExitRequested 一律被拦下，就退不掉了。
static QUIT_REQUESTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 建好托盘图标与菜单。
///
/// 设计意图：关闭窗口 = 销毁 WebView 把内存还给系统，但进程与托盘图标留着，
/// 随时点一下就能重新打开 —— 而不是把整个程序退掉让用户找不到入口。
fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let open_item =
        MenuItem::with_id(app, "open", "打开 LabelDesk", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        // 左键直接开窗口，比「左键弹菜单」少一步
        .show_menu_on_left_click(false)
        .tooltip("LabelDesk —— 点击打开；关闭窗口后仍驻留在此")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => open_main_window(app),
            "quit" => {
                QUIT_REQUESTED.store(true, std::sync::atomic::Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                open_main_window(tray.app_handle());
            }
        });

    // 用打包时嵌入的应用图标，不必额外准备托盘专用资源
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// 当前是否处于小窗形态（托盘据此还原）
fn in_quick_mode(app: &AppHandle) -> bool {
    app.state::<Mutex<AppState>>()
        .lock()
        .map(|s| s.quick_mode)
        .unwrap_or(false)
}

/// 打开主窗口。窗口已存在就显示并聚焦，不存在就重新创建。
///
/// 用户关闭窗口时我们销毁了窗口并结束了进程，所以正常情况下这里都是「重新创建」。
fn open_main_window(app: &AppHandle) {
    // 之前用的是小窗形态，就从托盘恢复小窗，别突然弹出大窗口
    if in_quick_mode(app) {
        show_quick_window(app);
        return;
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }

    match tauri::WebviewWindowBuilder::new(
        app,
        MAIN_WINDOW,
        // 必须显式指定 App("index.html")：WebviewUrl::default() 在开发模式下会解析成
        // devUrl（http://127.0.0.1:5183），重建出的窗口会去连开发服务器而显示
        //「127.0.0.1 拒绝连接」。App 走 tauri://localhost，打包后即内嵌的前端资源。
        tauri::WebviewUrl::App("index.html".into()),
    )
        .title("LabelDesk - 标签设计与打印")
        .inner_size(1440.0, 920.0)
        .min_inner_size(1080.0, 680.0)
        .center()
        .build()
    {
        Ok(window) => {
            let _ = window.set_focus();
            // 新窗口里的前端是全新实例，通知它重新读取配置与模板
            let _ = app.emit(EVENT_TRAY_REOPEN, ());
        }
        Err(e) => eprintln!("[LabelDesk] 从托盘创建窗口失败：{e}"),
    }
}

// ---------------------------------------------------------------------------
// 数据目录
// ---------------------------------------------------------------------------

/// 数据目录信息，供设置页显示与「打开目录 / 备份」使用。
///
/// 必须 rename_all = "camelCase"：前端按 layoutCount / legacyDir 读取，
/// 若序列化成 snake_case 会得到 undefined（曾导致设置页显示「当前有 undefined 个模板」）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirInfo {
    /// 数据根目录绝对路径
    pub dir: String,
    /// 模板数量
    pub layout_count: usize,
    /// 旧位置（%APPDATA%\com.labeldesk.app）是否还在（提示用户可清理）
    pub legacy_dir: Option<String>,
}

#[tauri::command]
fn data_dir_info(state: State<'_, Mutex<AppState>>) -> Result<DataDirInfo, String> {
    let (dir, layouts) = {
        let s = state.lock().map_err(|_| "状态锁已损坏".to_string())?;
        (s.data_dir.clone(), s.layouts_dir.clone())
    };
    let layout_count = std::fs::read_dir(&layouts)
        .map(|it| {
            it.flatten()
                .filter(|e| e.file_name().to_string_lossy().ends_with(store::LAYOUT_EXT))
                .count()
        })
        .unwrap_or(0);
    Ok(DataDirInfo {
        dir: dir.to_string_lossy().to_string(),
        layout_count,
        legacy_dir: datadir::legacy_dir_if_present().map(|p| p.to_string_lossy().to_string()),
    })
}

/// 在文件资源管理器里打开数据目录
#[tauri::command]
fn open_data_dir(state: State<'_, Mutex<AppState>>) -> Result<String, String> {
    let dir = {
        let s = state.lock().map_err(|_| "状态锁已损坏".to_string())?;
        s.data_dir.clone()
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("打开目录失败: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 把数据目录整体备份到用户选定的位置，返回备份目录路径。
#[tauri::command]
fn backup_data_dir(
    state: State<'_, Mutex<AppState>>,
    target: String,
) -> Result<String, String> {
    let root = {
        let s = state.lock().map_err(|_| "状态锁已损坏".to_string())?;
        s.data_dir.clone()
    };
    let stamp = crate::util::now_millis();
    let dest = PathBuf::from(&target).join(format!("LabelDesk-备份-{stamp}"));
    let n = datadir::backup_to(&root, &dest)?;
    Ok(format!("{}（{} 个文件）", dest.to_string_lossy(), n))
}
// ---------------------------------------------------------------------------
// 开机启动
// ---------------------------------------------------------------------------

/// 开机启动当前状态。`decided` 表示用户是否已做过选择（未选过时前端显示默认开启）。
#[derive(serde::Serialize)]
pub struct AutostartStatus {
    pub enabled: bool,
    pub decided: bool,
}

#[tauri::command]
fn autostart_status(app: AppHandle, state: State<'_, Mutex<AppState>>) -> Result<AutostartStatus, String> {
    let root = state
        .lock()
        .map_err(|_| "状态锁已损坏".to_string())?
        .layouts_dir
        .clone();
    let decided = store::read_config(&root)
        .get(autostart::decided_key())
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(AutostartStatus {
        enabled: autostart::is_enabled(&app),
        decided,
    })
}

/// 开关开机启动，并把「用户已做选择」写进配置，避免下次启动又被默认值覆盖。
#[tauri::command]
fn set_autostart(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    enabled: bool,
) -> Result<AutostartStatus, String> {
    let root = state
        .lock()
        .map_err(|_| "状态锁已损坏".to_string())?
        .layouts_dir
        .clone();

    autostart::set_enabled(&app, enabled)?;

    let mut config = store::read_config(&root);
    if let Some(obj) = config.as_object_mut() {
        obj.insert(
            autostart::decided_key().to_string(),
            serde_json::Value::Bool(true),
        );
        obj.insert(
            "autostartEnabled".to_string(),
            serde_json::Value::Bool(enabled),
        );
    }
    store::write_config(&root, &config)?;

    Ok(AutostartStatus {
        enabled: autostart::is_enabled(&app),
        decided: true,
    })
}

#[cfg(test)]
mod serde_contract_tests {
    //! 前后端的字段名契约。
    //!
    //! 前端按 camelCase 读取后端返回的结构体。Rust 默认序列化成 snake_case，
    //! 字段名带下划线就会变成 undefined —— 这个坑踩过两次
    //! （设置页显示「NaN 个月前」「当前有 undefined 个模板」），所以集中测一遍。

    /// 前端按这些名字读，缺一个就会显示 undefined
    #[test]
    fn data_dir_info_is_camel_case() {
        let info = super::DataDirInfo {
            dir: "D:/x".into(),
            layout_count: 2,
            legacy_dir: Some("D:/old".into()),
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"layoutCount\""), "{json}");
        assert!(json.contains("\"legacyDir\""), "{json}");
        assert!(!json.contains("layout_count"), "不应出现 snake_case: {json}");
    }

    #[test]
    fn autostart_status_is_lowercase_single_words() {
        let s = super::AutostartStatus { enabled: true, decided: true };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"enabled\""), "{json}");
        assert!(json.contains("\"decided\""), "{json}");
    }
}