//! 开机自动启动。
//!
//! 默认开启：首次运行时若用户还没做过选择，就自动登记开机启动；
//! 之后完全尊重用户的选择（用户关掉了就不再自动打开）。
//!
//! 用「配置文件里的标记」而不是每次启动都强制登记，是因为后者会让用户
//! 无法真正关闭这个功能 —— 关掉下次启动又被打开。

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt as AutostartExt;

/// 配置文件里记录「用户是否已经就开机启动做过选择」的键
const DECIDED_KEY: &str = "autostartDecided";

/// 当前是否已登记开机启动
pub fn is_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// 登记 / 取消开机启动
pub fn set_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

/// 首次运行时应用默认值（开启）。已做过选择则原样返回当前状态。
///
/// 返回 `(当前是否启用, 本次是否写入了配置)`
pub fn apply_default_if_first_run(
    app: &AppHandle,
    decided: bool,
    enabled_now: bool,
) -> (bool, bool) {
    if decided {
        return (enabled_now, false);
    }
    // 用户还没选过：默认登记开机启动
    let result = match set_enabled(app, true) {
        Ok(()) => true,
        Err(e) => {
            // 登记失败（例如受策略限制）不该阻止程序启动，记录下来即可
            eprintln!("[LabelDesk] 登记开机启动失败：{e}");
            enabled_now
        }
    };
    (result, true)
}

/// 配置里的标记键名，供 store 层读写
pub fn decided_key() -> &'static str {
    DECIDED_KEY
}
