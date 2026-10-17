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
    moved += copy_dir_contents(&legacy, root, 0)?;
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
///
/// `depth` 是护栏：正常情况下备份最多几层，超过 [`MAX_COPY_DEPTH`] 说明
/// 目标在了源内部、正在自我嵌套复制，直接报错而不是把磁盘写满。
fn copy_dir_contents(from: &Path, to: &Path, depth: usize) -> Result<usize, String> {
    if depth > MAX_COPY_DEPTH {
        return Err(format!(
            "备份层级过深（超过 {MAX_COPY_DEPTH} 层），可能把备份写到了数据目录内部"
        ));
    }
    std::fs::create_dir_all(to).map_err(|e| format!("创建目录 {} 失败: {e}", to.display()))?;
    let mut count = 0usize;
    let entries = std::fs::read_dir(from).map_err(|e| format!("读取 {} 失败: {e}", from.display()))?;
    for entry in entries.flatten() {
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            count += copy_dir_contents(&src, &dst, depth + 1)?;
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

/// 备份最多递归几层（模板目录 + layouts 也就两层）
const MAX_COPY_DEPTH: usize = 12;

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// 取一个可能还不存在的路径的「规范形式」：逐级向上找到第一个存在的祖先，
/// 把剩余部分接回去。用于判断目标是否落在数据目录内部。
fn canonicalize_lenient(path: &Path) -> Option<PathBuf> {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut probe = path.to_path_buf();
    loop {
        if let Ok(base) = probe.canonicalize() {
            let mut out = base;
            for part in tail.iter().rev() {
                out = out.join(part);
            }
            return Some(out);
        }
        let name = probe.file_name()?.to_os_string();
        tail.push(name);
        probe = probe.parent()?.to_path_buf();
    }
}

/// 把整个数据目录复制一份到 `target`（用于备份）。
///
/// 不做删除，只新增；目标已存在文件时会跳过，避免误覆盖别处的数据。
///
/// **必须拒绝把备份写进数据目录内部**：设置页把数据目录路径显示在眼前，
/// 用户很可能直接选它。那样 `dest` 就在 `root` 里，递归复制时会把刚建出来的
/// `dest` 再当成待复制内容，一路自我嵌套直到路径超长把磁盘写满。
pub fn backup_to(root: &Path, target: &Path) -> Result<usize, String> {
    if !root.is_dir() {
        return Err(format!("数据目录不存在: {}", root.display()));
    }
    if let (Some(root_c), Some(target_c)) = (canonicalize_lenient(root), canonicalize_lenient(target)) {
        if target_c == root_c || target_c.starts_with(&root_c) {
            return Err(
                "备份目标不能选在数据目录里面。请选到别的位置（比如桌面或 D 盘），否则会反复自我复制。"
                    .to_string(),
            );
        }
    }
    copy_dir_contents(root, target, 0)
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

        let n = copy_dir_contents(&from, &to, 0).unwrap();
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

    /// 备份目标选在数据目录内部时必须直接报错。
    /// 否则递归复制会把刚建出来的目标目录当成待复制内容，无限自我嵌套。
    #[test]
    fn backup_into_itself_is_rejected() {
        let root = temp_dir("backup-self");
        std::fs::create_dir_all(root.join("layouts")).unwrap();
        std::fs::write(root.join("config.json"), b"{}").unwrap();

        // 选数据目录本身
        let err = backup_to(&root, &root.join("LabelDesk-backup-1")).unwrap_err();
        assert!(err.contains("里面") || err.contains("内部"), "应提示不能选在数据目录里: {err}");

        // 选数据目录的子目录
        let err2 = backup_to(&root, &root.join("layouts").join("x")).unwrap_err();
        assert!(err2.contains("里面") || err2.contains("内部"));

        // 目录里不应该被塞出嵌套副本
        let mut names: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["config.json".to_string(), "layouts".to_string()]);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 正常备份（目标在外部）要能复制出内容
    #[test]
    fn backup_to_outside_works() {
        let root = temp_dir("backup-ok");
        let out = temp_dir("backup-dest");
        std::fs::create_dir_all(root.join("layouts")).unwrap();
        std::fs::write(root.join("config.json"), b"{\"a\":1}").unwrap();
        std::fs::write(root.join("layouts").join("t.ldl.json"), b"{}").unwrap();

        let n = backup_to(&root, &out.join("LabelDesk-backup")).unwrap();
        assert_eq!(n, 2, "应复制 2 个文件");
        assert!(out.join("LabelDesk-backup").join("config.json").is_file());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&out);
    }
}