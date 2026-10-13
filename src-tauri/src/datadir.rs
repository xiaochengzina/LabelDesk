//! 数据目录：模板与应用配置的存放位置。
//!
//! 统一放在**安装目录下的 `data\`**（便携风格，便于管理和整体备份）。
//!
//! 三处细节值得说明：
//!
//! 1. **迁移**：老版本把数据放在 `%APPDATA%\com.labeldesk.app`，首次以新布局启动时
//!    会把旧数据搬过来，避免用户"模板不见了"。
//! 2. **开发态**：`cargo run` 时安装目录是 `target/release`，数据落到仓库根下的
//!    `data\`，便于开发时查看。
//! 3. **环境变量**：`LABELDESK_DATA_DIR` 可覆盖，用于测试或多套数据并存。

use std::path::{Path, PathBuf};

/// 数据目录名（安装目录下）
const DATA_DIR_NAME: &str = "data";

/// 环境变量：显式指定数据目录
pub const ENV_DATA_DIR: &str = "LABELDESK_DATA_DIR";

/// 老版本的数据目录（用于迁移）
fn legacy_data_dir() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(appdata).join("com.labeldesk.app"))
}

/// 定位数据根目录。调用方需保证目录存在（见 [`ensure`]）。
pub fn resolve() -> PathBuf {
    // 1) 显式覆盖优先
    if let Some(dir) = std::env::var_os(ENV_DATA_DIR) {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }

    // 2) 安装目录下的 data\
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            return data_dir_for(exe_dir);
        }
    }

    // 3) 兜底：当前工作目录
    std::env::current_dir()
        .map(|d| d.join(DATA_DIR_NAME))
        .unwrap_or_else(|_| PathBuf::from(DATA_DIR_NAME))
}

/// 由可执行文件所在目录推出数据目录。
///
/// 开发态（`target/debug` 或 `target/release`）会回到仓库根的 `data\`，
/// 这样 `cargo run` 与打包后的行为一致，且不会把数据写进 target 里。
pub fn data_dir_for(exe_dir: &Path) -> PathBuf {
    let in_target = exe_dir
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == "debug" || n == "release")
        .unwrap_or(false);
    let in_target_tree = exe_dir
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(|n| n == "target")
        .unwrap_or(false);

    if in_target && in_target_tree {
        // exe_dir = <repo>/target/release -> <repo>/data
        if let Some(repo) = exe_dir.parent().and_then(|p| p.parent()) {
            return repo.join(DATA_DIR_NAME);
        }
    }
    exe_dir.join(DATA_DIR_NAME)
}

/// 旧数据目录若仍存在则返回（用于提示用户可清理）
pub fn legacy_dir_if_present() -> Option<PathBuf> {
    legacy_data_dir().filter(|p| p.is_dir())
}

/// 确保数据目录（含 `layouts` 子目录）存在，返回数据根目录。
pub fn ensure() -> Result<PathBuf, String> {
    let root = resolve();
    std::fs::create_dir_all(root.join("layouts"))
        .map_err(|e| format!("无法创建数据目录 {}: {e}", root.display()))?;
    Ok(root)
}

/// 首次以新布局启动时，把老位置（`%APPDATA%\com.labeldesk.app`）的数据搬过来。
///
/// 只在**新目录还是空的**时候迁移，绝不覆盖用户在新位置已有的数据。
/// 返回迁移过来的文件数（0 表示没做事）。
pub fn migrate_legacy_if_needed(root: &Path) -> Result<usize, String> {
    let legacy = match legacy_data_dir() {
        Some(dir) => dir,
        None => return Ok(0),
    };
    // 同一个位置就不必迁移（例如用户把数据目录指回了 APPDATA）
    if same_path(root, &legacy) {
        return Ok(0);
    }
    if !legacy.is_dir() {
        return Ok(0);
    }
    if !is_effectively_empty(root) {
        return Ok(0);
    }

    let mut moved = 0usize;
    moved += copy_dir_contents(&legacy, root)?;
    if moved > 0 {
        eprintln!("[LabelDesk] 已把旧数据从 {} 迁移到 {}", legacy.display(), root.display());
    }
    Ok(moved)
}

/// 目录是否存在且没有有效内容（忽略空的 layouts 子目录）
fn is_effectively_empty(dir: &Path) -> bool {
    let entries = match std::fs::read_dir(dir) {
        Ok(it) => it,
        Err(_) => return true,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if !is_effectively_empty(&path) {
                return false;
            }
        } else {
            return false;
        }
    }
    true
}

/// 递归复制 `from` 的内容到 `to`（不覆盖已存在的文件），返回复制到的文件数
fn copy_dir_contents(from: &Path, to: &Path) -> Result<usize, String> {
    std::fs::create_dir_all(to).map_err(|e| format!("创建目录 {} 失败: {e}", to.display()))?;
    let mut count = 0usize;
    let entries = std::fs::read_dir(from).map_err(|e| format!("读取 {} 失败: {e}", from.display()))?;
    for entry in entries.flatten() {
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            count += copy_dir_contents(&src, &dst)?;
        } else {
            if dst.exists() {
                continue;
            }
            std::fs::copy(&src, &dst)
                .map_err(|e| format!("复制 {} 失败: {e}", src.display()))?;
            count += 1;
        }
    }
    Ok(count)
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// 把整个数据目录复制一份到 `target`（用于备份）。
///
/// 不做删除，只新增；目标已存在文件时会跳过，避免误覆盖别处的数据。
pub fn backup_to(root: &Path, target: &Path) -> Result<usize, String> {
    if !root.is_dir() {
        return Err(format!("数据目录不存在: {}", root.display()));
    }
    copy_dir_contents(root, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "labeldesk-datadir-{tag}-{}",
            crate::util::now_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn data_dir_sits_next_to_exe() {
        let exe_dir = PathBuf::from("C:\\Apps\\LabelDesk");
        assert_eq!(data_dir_for(&exe_dir), PathBuf::from("C:\\Apps\\LabelDesk\\data"));
    }

    #[test]
    fn dev_build_uses_repo_data_dir() {
        // <repo>/target/release -> <repo>/data
        let exe_dir = PathBuf::from("C:\\repo\\target\\release");
        assert_eq!(data_dir_for(&exe_dir), PathBuf::from("C:\\repo\\data"));
        let dbg = PathBuf::from("C:\\repo\\target\\debug");
        assert_eq!(data_dir_for(&dbg), PathBuf::from("C:\\repo\\data"));
    }

    #[test]
    fn empty_detection_ignores_empty_subdirs() {
        let root = temp_dir("empty");
        std::fs::create_dir_all(root.join("layouts")).unwrap();
        // 只有空的 layouts 子目录，视为空（可以迁移）
        assert!(is_effectively_empty(&root));
        std::fs::write(root.join("layouts").join("x.ldl.json"), "{}").unwrap();
        assert!(!is_effectively_empty(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_does_not_overwrite_existing() {
        let from = temp_dir("copy-from");
        let to = temp_dir("copy-to");
        std::fs::write(from.join("keep.json"), "new").unwrap();
        std::fs::write(from.join("fresh.json"), "fresh").unwrap();
        std::fs::write(to.join("keep.json"), "old").unwrap();

        let n = copy_dir_contents(&from, &to).unwrap();
        assert_eq!(n, 1, "只应复制 fresh.json");
        assert_eq!(std::fs::read_to_string(to.join("keep.json")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(to.join("fresh.json")).unwrap(), "fresh");

        let _ = std::fs::remove_dir_all(&from);
        let _ = std::fs::remove_dir_all(&to);
    }

    #[test]
    fn migrate_skips_when_target_has_data() {
        // 目标已有数据时不应迁移（这条用 env 覆盖不可行，直接验证 copy 语义）
        let root = temp_dir("migrate");
        std::fs::write(root.join("config.json"), "{}").unwrap();
        assert!(!is_effectively_empty(&root));
        let _ = std::fs::remove_dir_all(&root);
    }
}
