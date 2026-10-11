//! 标签模板持久化：以 JSON 文件形式存放在应用数据目录。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 模板文件扩展名。`.json` 结尾便于用编辑器直接查看与做版本管理。
pub const LAYOUT_EXT: &str = "ldl.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSummary {
    pub id: String,
    pub name: String,
    pub file_path: String,
    /// 标签宽度（毫米），便于列表里直接展示规格
    pub width_mm: Option<f64>,
    pub height_mm: Option<f64>,
    pub updated_ms: u128,
    pub size_bytes: u64,
}

fn is_layout_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.ends_with(LAYOUT_EXT))
        .unwrap_or(false)
}

/// 列出全部模板，按最后修改时间倒序。
pub fn list(root: &Path) -> Result<Vec<LayoutSummary>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let entries = std::fs::read_dir(root).map_err(|e| format!("读取模板目录失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_layout_file(&path) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let id = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.trim_end_matches(LAYOUT_EXT).trim_end_matches('.').to_string())
            .unwrap_or_default();

        // 模板文件很小，直接读出来取展示信息；损坏的文件跳过而不是让整个列表失败
        let (name, w, h) = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(v) => (
                    v.get("name")
                        .and_then(|n| n.as_str())
                        .map(str::to_string)
                        .unwrap_or_else(|| id.clone()),
                    v.get("widthMm").and_then(|n| n.as_f64()),
                    v.get("heightMm").and_then(|n| n.as_f64()),
                ),
                Err(_) => (format!("{id}（文件损坏）"), None, None),
            },
            Err(_) => continue,
        };

        let updated_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);

        out.push(LayoutSummary {
            id,
            name,
            file_path: path.to_string_lossy().to_string(),
            width_mm: w,
            height_mm: h,
            updated_ms,
            size_bytes: meta.len(),
        });
    }
    out.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
    Ok(out)
}

/// 读取单个模板的原始 JSON 文本。
pub fn read_raw(root: &Path, id: &str) -> Result<String, String> {
    let path = layout_path(root, id);
    if !path.exists() {
        return Err(format!("模板「{id}」不存在"));
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取模板失败: {e}"))
}

/// 写入模板。`id` 会做文件名净化，防止越权写到目录之外。
pub fn write_raw(root: &Path, id: &str, json: &str) -> Result<String, String> {
    // 先校验是合法 JSON，避免把损坏内容写进磁盘
    serde_json::from_str::<serde_json::Value>(json)
        .map_err(|e| format!("模板内容不是合法 JSON: {e}"))?;

    std::fs::create_dir_all(root).map_err(|e| format!("创建模板目录失败: {e}"))?;
    let safe = crate::util::sanitize_file_stem(id);
    let path = root.join(format!("{safe}.{LAYOUT_EXT}"));

    let tmp = root.join(format!(".{safe}.{}.tmp", crate::util::now_millis()));
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("写入模板失败: {e}"))?;

    // 覆盖前先留一份备份：万一后续改名失败，还能把原文件放回去，
    // 绝不出现「原文件已删、新文件没到位」的空档。
    let backup = root.join(format!(".{safe}.{}.bak", crate::util::now_millis()));
    let existed = path.exists();
    if existed {
        std::fs::rename(&path, &backup).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("备份旧模板失败: {e}")
        })?;
    }

    match std::fs::rename(&tmp, &path) {
        Ok(()) => {
            // 写入成功，备份已无用
            if existed {
                let _ = std::fs::remove_file(&backup);
            }
            Ok(path.to_string_lossy().to_string())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            // 把原文件放回去，保证用户至少不会丢模板
            let restored = if existed {
                std::fs::rename(&backup, &path).is_ok()
            } else {
                false
            };
            Err(format!(
                "保存模板失败: {e}{}",
                if restored { "（原模板已还原）" } else { "" }
            ))
        }
    }
}

pub fn delete(root: &Path, id: &str) -> Result<(), String> {
    let path = layout_path(root, id);
    if !path.exists() {
        return Err(format!("模板「{id}」不存在"));
    }
    std::fs::remove_file(&path).map_err(|e| format!("删除模板失败: {e}"))
}

/// 导出到用户选定路径。
pub fn export_to(root: &Path, id: &str, target: &Path) -> Result<String, String> {
    let raw = read_raw(root, id)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建导出目录失败: {e}"))?;
    }
    std::fs::write(target, raw.as_bytes()).map_err(|e| format!("导出失败: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

/// 从用户选定路径导入，返回写入后的新模板 id。
pub fn import_from(root: &Path, source: &Path) -> Result<String, String> {
    let text = std::fs::read_to_string(source).map_err(|e| format!("读取导入文件失败: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("导入文件不是合法模板 JSON: {e}"))?;

    let base_name = value
        .get("name")
        .and_then(|n| n.as_str())
        .map(str::to_string)
        .or_else(|| {
            source
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.trim_end_matches(".ldl").to_string())
        })
        .unwrap_or_else(|| "导入的模板".to_string());

    // 与现有模板重名时追加序号，避免静默覆盖
    let mut id = crate::util::sanitize_file_stem(&base_name);
    let mut n = 2;
    while layout_path(root, &id).exists() {
        id = format!("{}-{n}", crate::util::sanitize_file_stem(&base_name));
        n += 1;
        if n > 999 {
            return Err("导入失败：同名模板过多".into());
        }
    }
    write_raw(root, &id, &text)?;
    Ok(id)
}

/// 由 id 解析出磁盘路径，并确保结果仍在 root 之内（防目录穿越）。
pub fn layout_path(root: &Path, id: &str) -> PathBuf {
    let safe = crate::util::sanitize_file_stem(id);
    root.join(format!("{safe}.{LAYOUT_EXT}"))
}

// ---------------------------------------------------------------------------
// 应用配置（不随模板保存的本地偏好）
// ---------------------------------------------------------------------------

const CONFIG_FILE: &str = "config.json";

fn config_path(root: &Path) -> PathBuf {
    // 放在模板目录的上一级，避免被 `list()` 当成模板文件扫出来
    root.parent()
        .map(|p| p.join(CONFIG_FILE))
        .unwrap_or_else(|| root.join(CONFIG_FILE))
}

/// 读取应用配置。文件不存在或损坏时返回空对象，绝不因此让应用启动失败。
pub fn read_config(root: &Path) -> serde_json::Value {
    let path = config_path(root);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            eprintln!("[LabelDesk] 配置文件损坏，已忽略：{e}");
            serde_json::json!({})
        }),
        Err(_) => serde_json::json!({}),
    }
}

/// 写入应用配置（原子写，避免中途崩溃留下半个文件）。
pub fn write_config(root: &Path, value: &serde_json::Value) -> Result<(), String> {
    let path = config_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| format!("序列化配置失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text.as_bytes()).map_err(|e| format!("写入配置失败: {e}"))?;

    // 与模板同样处理：覆盖前先备份，改名失败就把原文件放回去
    let backup = path.with_extension("json.bak");
    let existed = path.exists();
    if existed {
        std::fs::rename(&path, &backup).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("备份旧配置失败: {e}")
        })?;
    }
    match std::fs::rename(&tmp, &path) {
        Ok(()) => {
            if existed {
                let _ = std::fs::remove_file(&backup);
            }
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            let restored = if existed {
                std::fs::rename(&backup, &path).is_ok()
            } else {
                false
            };
            Err(format!(
                "保存配置失败: {e}{}",
                if restored { "（原配置已还原）" } else { "" }
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "labeldesk-store-test-{tag}-{}",
            crate::util::now_millis()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_read_list_delete_roundtrip() {
        let root = temp_root("crud");
        let json = r#"{"version":1,"name":"测试标签","widthMm":40,"heightMm":30,"elements":[]}"#;
        let path = write_raw(&root, "测试标签", json).unwrap();
        assert!(Path::new(&path).exists());

        let listed = list(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "测试标签");
        assert_eq!(listed[0].width_mm, Some(40.0));
        assert_eq!(listed[0].height_mm, Some(30.0));

        assert_eq!(read_raw(&root, "测试标签").unwrap(), json);
        delete(&root, "测试标签").unwrap();
        assert!(list(&root).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_invalid_json() {
        let root = temp_root("invalid");
        assert!(write_raw(&root, "bad", "not json").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn path_traversal_is_neutralized() {
        let root = temp_root("traversal");
        let p = layout_path(&root, "../../evil");
        // 分隔符会被替换成下划线，因此结果既不含 .. 也不含路径分隔符
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert!(!name.contains(".."), "文件名仍含 ..: {name}");
        assert!(!p.to_string_lossy().contains(".."), "完整路径仍含 ..: {}", p.display());
        // 清理后必须仍落在模板目录内
        assert!(p.starts_with(&root), "路径逃出了模板目录: {}", p.display());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_raw_never_escapes_root() {
        let root = temp_root("escape");
        std::fs::create_dir_all(&root).unwrap();
        let written = write_raw(&root, "../escaped", r#"{"name":"x"}"#).unwrap();
        let path = std::path::PathBuf::from(&written);
        assert!(path.starts_with(&root), "写出的文件逃出了模板目录: {written}");
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn import_deduplicates_names() {
        let root = temp_root("import");
        let src = root.join("src.json");
        std::fs::write(&src, r#"{"version":1,"name":"重复名","widthMm":50,"heightMm":30}"#).unwrap();
        let first = import_from(&root, &src).unwrap();
        let second = import_from(&root, &src).unwrap();
        assert_ne!(first, second, "重名导入应生成不同的 id");
        assert_eq!(list(&root).unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn broken_file_does_not_break_listing() {
        let root = temp_root("broken");
        std::fs::write(root.join(format!("ok.{LAYOUT_EXT}")), r#"{"name":"好模板"}"#).unwrap();
        std::fs::write(root.join(format!("bad.{LAYOUT_EXT}")), "{ broken").unwrap();
        let listed = list(&root).unwrap();
        assert_eq!(listed.len(), 2, "损坏文件也要列出，只是标记为损坏");
        assert!(listed.iter().any(|l| l.name.contains("损坏")));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 覆盖保存后不应留下 .tmp / .bak 垃圾文件
    #[test]
    fn overwrite_leaves_no_temp_files() {
        let root = temp_root("no-temp");
        write_raw(&root, "标签", r#"{"name":"第一版","version":1}"#).unwrap();
        write_raw(&root, "标签", r#"{"name":"第二版","version":1}"#).unwrap();

        let leftovers: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp") || n.ends_with(".bak"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件: {leftovers:?}");

        let text = read_raw(&root, "标签").unwrap();
        assert!(text.contains("第二版"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 覆盖保存必须真的替换内容，而不是变成两个文件
    #[test]
    fn overwrite_replaces_in_place() {
        let root = temp_root("replace");
        write_raw(&root, "标签", r#"{"name":"旧","version":1}"#).unwrap();
        write_raw(&root, "标签", r#"{"name":"新","version":1}"#).unwrap();

        let list = list(&root).unwrap();
        assert_eq!(list.len(), 1, "覆盖保存不应产生额外模板: {list:?}");
        assert!(read_raw(&root, "标签").unwrap().contains("新"));
        let _ = std::fs::remove_dir_all(&root);
    }
}