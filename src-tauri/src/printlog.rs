//! 打印历史与序列号去重。
//!
//! 为什么需要：二手笔记本的入库标签贴上去基本撕不下来，
//! 同一台机器重复打印 = 浪费一张标签 + 要重新贴。
//!
//! 存储形态：`data\print-history.jsonl`，一行一条 JSON。
//! 选 JSONL 而不是单个 JSON 数组，是因为：
//! - 追加只需 open(append) 写一行，不必读整个文件再重写
//! - 即使某行损坏，也只丢那一条，不会让整个历史读不出来
//!
//! 容量控制：超过 [`MAX_ENTRIES`] 条时，只保留最近的部分重写一次。
//! 自用场景一天几十张，这个上限能存很久。

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

/// 历史文件名
const HISTORY_FILE: &str = "print-history.jsonl";
/// 上限条数，超过后裁剪
const MAX_ENTRIES: usize = 5000;
/// 判重时只看最近多久的记录（天）
pub const DEDUPE_WINDOW_DAYS: i64 = 90;

/// 一条打印记录
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintRecord {
    /// 打印时间（毫秒时间戳）。alias 兼容早期写下的 snake_case 记录
    #[serde(alias = "at_ms")]
    pub at_ms: u128,
    /// 唯一标识（序列号），可能为空
    pub serial: String,
    /// 型号等便于人读的摘要
    pub summary: String,
    /// 模板名
    pub template: String,
    /// 打印机名
    pub printer: String,
    /// 是否来自速打小窗
    pub quick: bool,
}

/// 判重结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateHit {
    /// 命中的序列号
    pub serial: String,
    /// 之前打印的时间（毫秒）
    pub at_ms: u128,
    /// 之前的型号摘要
    pub summary: String,
    /// 之前的模板名
    pub template: String,
    /// 距今多少小时
    pub hours_ago: f64,
}

fn history_path(data_dir: &Path) -> PathBuf {
    data_dir.join(HISTORY_FILE)
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 读取全部记录（损坏的行跳过）
pub fn read_all(data_dir: &Path) -> Vec<PrintRecord> {
    let path = history_path(data_dir);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<PrintRecord>(l).ok())
        .collect()
}

/// 追加一条记录；超过上限时裁剪旧记录。
pub fn append(data_dir: &Path, record: &PrintRecord) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("无法创建数据目录 {}: {e}", data_dir.display()))?;
    let path = history_path(data_dir);

    let line = serde_json::to_string(record).map_err(|e| format!("序列化打印记录失败: {e}"))?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开打印历史失败: {e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("写入打印历史失败: {e}"))?;
    drop(file);

    // 超限才裁剪：读一遍、保留尾部、原子替换
    let all = read_all(data_dir);
    if all.len() > MAX_ENTRIES {
        let keep = &all[all.len() - MAX_ENTRIES / 2..];
        let tmp = path.with_extension("jsonl.tmp");
        let body: String = keep
            .iter()
            .filter_map(|r| serde_json::to_string(r).ok())
            .map(|l| l + "\n")
            .collect();
        std::fs::write(&tmp, body).map_err(|e| format!("裁剪打印历史失败: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("替换打印历史失败: {e}"))?;
    }
    Ok(())
}

/// 检查这些候选中是否有近期打印过的（用于打印前提醒）
///
/// `candidates` 是「看起来像唯一标识」的值（序列号等），
/// 由前端按规则筛出来，后端只做查询匹配。
pub fn find_recent_duplicates(data_dir: &Path, candidates: &[String]) -> Vec<DuplicateHit> {
    if candidates.is_empty() {
        return Vec::new();
    }
    let cutoff = now_ms().saturating_sub((DEDUPE_WINDOW_DAYS as u128) * 24 * 3600 * 1000);
    let normalized: Vec<String> = candidates
        .iter()
        .map(|c| c.trim().to_lowercase())
        .filter(|c| !c.is_empty())
        .collect();

    let mut hits: Vec<DuplicateHit> = Vec::new();
    // 从新到旧扫，同一个序列号只报最近一次
    for rec in read_all(data_dir).iter().rev() {
        if rec.at_ms < cutoff {
            break;
        }
        let serial = rec.serial.trim().to_lowercase();
        if serial.is_empty() || !normalized.contains(&serial) {
            continue;
        }
        if hits.iter().any(|h| h.serial.eq_ignore_ascii_case(&rec.serial)) {
            continue;
        }
        hits.push(DuplicateHit {
            serial: rec.serial.clone(),
            at_ms: rec.at_ms,
            summary: rec.summary.clone(),
            template: rec.template.clone(),
            hours_ago: (now_ms().saturating_sub(rec.at_ms) as f64) / 3_600_000.0,
        });
    }
    hits
}

/// 清空历史
pub fn clear(data_dir: &Path) -> Result<(), String> {
    let path = history_path(data_dir);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("清空打印历史失败: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "labeldesk-printlog-{tag}-{}",
            crate::util::now_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn rec(serial: &str, at_ms: u128) -> PrintRecord {
        PrintRecord {
            at_ms,
            serial: serial.to_string(),
            summary: "ThinkPad X1".into(),
            template: "笔记本标签".into(),
            printer: "Deli".into(),
            quick: false,
        }
    }

    #[test]
    fn append_and_read_roundtrip() {
        let dir = temp_dir("roundtrip");
        append(&dir, &rec("PF2ABCDE", 1_000)).unwrap();
        append(&dir, &rec("PF3K7M2Q", 2_000)).unwrap();
        let all = read_all(&dir);
        assert_eq!(all.len(), 2);
        assert_eq!(all[1].serial, "PF3K7M2Q");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupted_line_is_skipped() {
        let dir = temp_dir("corrupt");
        append(&dir, &rec("A1", 1_000)).unwrap();
        // 手动插入一行坏数据
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(history_path(&dir))
            .unwrap();
        writeln!(f, "{{ this is not json").unwrap();
        drop(f);
        append(&dir, &rec("B2", 3_000)).unwrap();
        let all = read_all(&dir);
        assert_eq!(all.len(), 2, "坏行应被跳过而不是让整个历史读不出来");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_detection_matches_case_insensitively() {
        let dir = temp_dir("dupe");
        let now = now_ms();
        append(&dir, &rec("PF2ABCDE", now - 3600_000)).unwrap();
        let hits = find_recent_duplicates(&dir, &["pf2abcde".to_string()]);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].hours_ago > 0.9 && hits[0].hours_ago < 1.1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_detection_reports_only_latest() {
        let dir = temp_dir("latest");
        let now = now_ms();
        append(&dir, &rec("XYZ", now - 7200_000)).unwrap();
        append(&dir, &rec("XYZ", now - 1800_000)).unwrap();
        let hits = find_recent_duplicates(&dir, &["XYZ".to_string()]);
        assert_eq!(hits.len(), 1, "同一序列号只报最近一次");
        assert!(hits[0].hours_ago < 0.6, "应命中较新的那条");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn old_records_outside_window_are_ignored() {
        let dir = temp_dir("old");
        let now = now_ms();
        let too_old = now - ((DEDUPE_WINDOW_DAYS as u128) + 5) * 24 * 3600 * 1000;
        append(&dir, &rec("OLDSN", too_old)).unwrap();
        let hits = find_recent_duplicates(&dir, &["OLDSN".to_string()]);
        assert!(hits.is_empty(), "超出窗口期的记录不应报重复");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_candidates_returns_nothing() {
        let dir = temp_dir("empty");
        append(&dir, &rec("AAA", now_ms())).unwrap();
        assert!(find_recent_duplicates(&dir, &[]).is_empty());
        assert!(find_recent_duplicates(&dir, &["".to_string()]).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_removes_history() {
        let dir = temp_dir("clear");
        append(&dir, &rec("AAA", now_ms())).unwrap();
        clear(&dir).unwrap();
        assert!(read_all(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trimming_keeps_latest_entries() {
        let dir = temp_dir("trim");
        // 直接写超过上限的行，验证裁剪后保留的是尾部
        let path = history_path(&dir);
        let mut body = String::new();
        for i in 0..(MAX_ENTRIES + 10) {
            let r = rec(&format!("SN{i}"), (i as u128) + 1);
            body.push_str(&serde_json::to_string(&r).unwrap());
            body.push('\n');
        }
        std::fs::write(&path, body).unwrap();
        append(&dir, &rec("NEWEST", now_ms())).unwrap();
        let all = read_all(&dir);
        assert!(all.len() <= MAX_ENTRIES, "裁剪后不应超过上限");
        assert_eq!(
            all.last().map(|r| r.serial.as_str()),
            Some("NEWEST"),
            "最新一条必须在"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 发给前端的字段名必须是 camelCase，否则前端读到 undefined
    /// （曾出现「NaN 个月前」：后端发 hours_ago，前端读 hoursAgo）
    #[test]
    fn serializes_as_camel_case() {
        let hit = DuplicateHit {
            serial: "SN1".into(),
            at_ms: 1234,
            summary: "M".into(),
            template: "T".into(),
            hours_ago: 2.0,
        };
        let out = serde_json::to_string(&hit).unwrap();
        assert!(out.contains("\"hoursAgo\""), "必须是 camelCase: {out}");
        assert!(out.contains("\"atMs\""), "必须是 camelCase: {out}");

        let rec_json = serde_json::to_string(&rec("SN1", 1234)).unwrap();
        assert!(rec_json.contains("\"atMs\""), "记录也统一 camelCase: {rec_json}");
    }

    /// 早期记录用的是 snake_case（at_ms），必须还能读出来
    #[test]
    fn accepts_legacy_snake_case_field() {
        let raw = r#"{"at_ms":1700000000000,"serial":"OLD1","summary":"M","template":"T","printer":"P","quick":false}"#;
        let parsed: PrintRecord = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.serial, "OLD1");
        assert_eq!(parsed.at_ms, 1700000000000);
    }
}