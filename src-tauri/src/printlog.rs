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
/// 裁剪时保留多少条（留出余量，避免每打印一次就重写整个文件）
const TRIM_KEEP: usize = 4000;
/// 触发裁剪的文件字节数阈值。
///
/// 用文件大小而不是「读一遍数行数」来判断是否超限：
/// 判重已经每秒可能被调用，追加路径不应该再额外读整个文件。
/// 单条约 140 字节，5000 条约 700 KB，这里取 760 KB 作为阈值。
const TRIM_BYTES: u64 = 760 * 1024;
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
    /// 模板 id（复打时用它切回同一个模板）
    #[serde(default)]
    pub template_id: String,
    /// 打印机名
    pub printer: String,
    /// 是否来自速打小窗
    pub quick: bool,
    /// 当时粘贴的原始文本（复打时原样填回输入框）
    ///
    /// 没有存「解析后的变量值」而是存原文，是因为复打要走和首次完全相同的
    /// 解析路径 —— 万一模板的字段映射后来改过，用原文才能暴露出差异，
    /// 而不是塞进一堆旧值让人看不出问题。
    #[serde(default)]
    pub raw: String,
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
///
/// 按字节读、按行切，每行独立做 UTF-8 解码（`from_utf8_lossy`）。
/// 不能直接用 `read_to_string`：只要文件里有一个非法字节（记事本另存成
/// ANSI/GBK、断电时追加截断在汉字中间），整个读取就失败返回空 —— 表现是
/// 「历史页突然 0 条、判重再也不提醒」，而文件明明还在。那就违背了
/// 「坏行只丢一条」的设计。
pub fn read_all(data_dir: &Path) -> Vec<PrintRecord> {
    let path = history_path(data_dir);
    let Ok(bytes) = std::fs::read(&path) else {
        return Vec::new();
    };
    // 去掉 UTF-8 BOM
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(&bytes);
    bytes
        .split(|b| *b == b'\n')
        .map(|line| String::from_utf8_lossy(line))
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<PrintRecord>(&l).ok())
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

    // 只在文件明显超限时才读整个文件并裁剪。
    // 用文件大小预筛，正常打印路径不碰这一步（原来每条都要 read_all，实测 60ms）。
    let too_big = std::fs::metadata(&path)
        .map(|m| m.len() > TRIM_BYTES)
        .unwrap_or(false);
    if !too_big {
        return Ok(());
    }

    let all = read_all(data_dir);
    if all.len() > MAX_ENTRIES {
        let keep = &all[all.len() - TRIM_KEEP..];
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
    // 显式按时间倒序再扫。
    // 不能只靠「文件是追加写的所以行序=时间序」：手动编辑过、系统时钟被调整过
    // 时行序会乱，那样这里一 break 就会漏掉真正的重复记录（静默失效）。
    let mut records = read_all(data_dir);
    records.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));

    // 从新到旧扫，同一个序列号只报最近一次
    for rec in records.iter() {
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

/// 按关键字搜索历史（序列号 / 型号 / 模板名，大小写不敏感），新的在前。
///
/// 历史攒到几千条时，「上次这台机器打过吗」只能靠搜。
pub fn search(data_dir: &Path, query: &str, limit: usize) -> Vec<PrintRecord> {
    let q = query.trim().to_lowercase();
    let all = read_all(data_dir);
    let mut hit: Vec<PrintRecord> = if q.is_empty() {
        all
    } else {
        all.into_iter()
            .filter(|r| {
                r.serial.to_lowercase().contains(&q)
                    || r.summary.to_lowercase().contains(&q)
                    || r.template.to_lowercase().contains(&q)
            })
            .collect()
    };
    // 显式按时间倒序，不依赖「文件必然按时间追加」这个假设
    // （手动编辑过文件、系统时钟被调整过时，行序就不等于时间序）
    hit.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));
    hit.truncate(limit.max(1));
    hit
}

/// 历史总条数（用于界面显示「共 N 条」）
pub fn count(data_dir: &Path) -> usize {
    read_all(data_dir).len()
}

/// 出现过的模板名（去重，供筛选下拉使用）
pub fn distinct_templates(data_dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = read_all(data_dir)
        .into_iter()
        .map(|r| r.template)
        .filter(|t| !t.trim().is_empty())
        .collect();
    names.sort();
    names.dedup();
    names
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
            template_id: "笔记本标签".into(),
            printer: "Deli".into(),
            raw: String::new(),
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
        // 造一个超过字节阈值的文件，验证触发裁剪后保留的是尾部
        let path = history_path(&dir);
        let mut body = String::new();
        let mut written = 0usize;
        while (body.len() as u64) <= TRIM_BYTES + 4096 {
            let r = rec(&format!("SN{written}"), (written as u128) + 1);
            body.push_str(&serde_json::to_string(&r).unwrap());
            body.push('\n');
            written += 1;
        }
        std::fs::write(&path, &body).unwrap();
        append(&dir, &rec("NEWEST", now_ms())).unwrap();

        let all = read_all(&dir);
        assert!(
            all.len() <= TRIM_KEEP + 1,
            "裁剪后应回落到 {} 条左右，实际 {}",
            TRIM_KEEP,
            all.len()
        );
        assert_eq!(
            all.last().map(|r| r.serial.as_str()),
            Some("NEWEST"),
            "最新一条必须保留"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 正常追加不应读取整个文件（回归：曾因每条都 read_all 而耗时 60ms）
    #[test]
    fn append_is_cheap_when_under_size_threshold() {
        let dir = temp_dir("cheap");
        for i in 0..50 {
            append(&dir, &rec(&format!("S{i}"), (i as u128) + 1)).unwrap();
        }
        let size = std::fs::metadata(history_path(&dir)).unwrap().len();
        assert!(size < TRIM_BYTES, "50 条远小于阈值");
        assert_eq!(read_all(&dir).len(), 50);
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

    /// 性能基准（默认跳过，手动跑）：`cargo test --lib bench_ -- --nocapture`
    #[test]
    #[ignore]
    fn bench_full_history() {
        let dir = temp_dir("bench");
        let now = now_ms();
        for i in 0..MAX_ENTRIES {
            let mut r = rec(&format!("PF{:06}", i), now - (i as u128) * 60_000);
            r.summary = "ThinkPad X1 Carbon Gen 9".into();
            append(&dir, &r).unwrap();
        }
        let bytes = std::fs::metadata(history_path(&dir)).map(|m| m.len()).unwrap_or(0);
        println!("\n--- 满容量基准 ---");
        println!("记录数: {}", read_all(&dir).len());
        println!("文件大小: {} KB", bytes / 1024);

        let t = std::time::Instant::now();
        let all = read_all(&dir);
        println!("read_all: {:?}（{} 条）", t.elapsed(), all.len());

        // 命中最新一条（最坏情况要扫到末尾才发现，实际是从新到旧，命中很快）
        let t = std::time::Instant::now();
        let hits = find_recent_duplicates(&dir, &["PF000000".to_string()]);
        println!("判重（命中最近）: {:?}，{} 条命中", t.elapsed(), hits.len());

        // 不命中（必须扫完整个 90 天窗口）
        let t = std::time::Instant::now();
        let hits = find_recent_duplicates(&dir, &["NOSUCHSERIAL".to_string()]);
        println!("判重（未命中，扫全窗口）: {:?}，{} 条命中", t.elapsed(), hits.len());

        let t = std::time::Instant::now();
        let _ = append(&dir, &rec("NEWONE", now));
        println!("追加一条: {:?}", t.elapsed());
        println!("---\n");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_matches_serial_and_summary() {
        let dir = temp_dir("search");
        let now = now_ms();
        append(&dir, &rec("PF2ABCDE", now - 3000)).unwrap();
        let mut other = rec("ZZZ999", now - 2000);
        other.summary = "Dell Latitude".into();
        append(&dir, &other).unwrap();

        // 按序列号（大小写不敏感）
        let r = search(&dir, "pf2abc", 10);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].serial, "PF2ABCDE");

        // 按型号
        let r = search(&dir, "latitude", 10);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].serial, "ZZZ999");

        // 空查询返回全部，且新的在前
        let r = search(&dir, "", 10);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].serial, "ZZZ999", "最新的应在最前");

        // 无命中
        assert!(search(&dir, "NOSUCH", 10).is_empty());

        // limit 生效
        assert_eq!(search(&dir, "", 1).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 即使文件里的行序是乱的，也要按时间倒序返回
    #[test]
    fn search_sorts_by_time_not_file_order() {
        let dir = temp_dir("sortorder");
        let now = now_ms();
        // 故意乱序写入：先新后旧
        append(&dir, &rec("NEWEST", now - 1000)).unwrap();
        append(&dir, &rec("OLDEST", now - 900_000)).unwrap();
        append(&dir, &rec("MIDDLE", now - 400_000)).unwrap();

        let r = search(&dir, "", 10);
        let order: Vec<&str> = r.iter().map(|x| x.serial.as_str()).collect();
        assert_eq!(order, vec!["NEWEST", "MIDDLE", "OLDEST"], "应按时间倒序");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 老记录没有 raw / templateId 字段，必须还能读出来（复打对这些记录不可用）
    #[test]
    fn accepts_legacy_record_without_raw() {
        let raw = r#"{"atMs":1700000000000,"serial":"OLD1","summary":"M","template":"T","printer":"P","quick":false}"#;
        let parsed: PrintRecord = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.serial, "OLD1");
        assert!(parsed.raw.is_empty(), "缺失字段应默认为空，而不是解析失败");
        assert!(parsed.template_id.is_empty());
    }

    /// 新记录的 raw 与 templateId 必须能原样往返
    #[test]
    fn raw_text_survives_roundtrip() {
        let dir = temp_dir("raw");
        let mut r = rec("PF2ABCDE", now_ms());
        r.raw = "ThinkPad X1\t2024-03-15\ti7 / 16G\t3280\t张伟\tPF2ABCDE".into();
        r.template_id = "笔记本标签".into();
        append(&dir, &r).unwrap();

        let all = read_all(&dir);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].raw, r.raw, "复打依赖 raw 原样保存");
        assert_eq!(all[0].template_id, "笔记本标签");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 文件行序乱掉时，判重也必须能命中（原来靠行序 + break，会静默漏判）
    #[test]
    fn duplicate_detection_ignores_file_order() {
        let dir = temp_dir("duporder");
        let now = now_ms();
        // 故意把旧记录写在最前面
        append(&dir, &rec("OLDOLD", now - 2000_000_000)).unwrap();
        append(&dir, &rec("DUPME", now - 3600_000)).unwrap();
        let hits = find_recent_duplicates(&dir, &["DUPME".to_string()]);
        assert_eq!(hits.len(), 1, "不该因为前面的旧记录就 break 掉");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 文件里混入非法 UTF-8 字节时，只能丢那一行，其余记录必须还能读出来。
    /// （用 read_to_string 时整份历史会变成 0 条 —— 判重就静默失效了）
    #[test]
    fn invalid_utf8_bytes_only_drop_that_line() {
        let dir = temp_dir("badutf8");
        append(&dir, &rec("GOOD1", 1_000)).unwrap();
        // 追加一行含非法字节（0xFF 不是合法 UTF-8）的垃圾
        let path = history_path(&dir);
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        use std::io::Write as _;
        f.write_all(&[0xFF, 0xFE, b'{', b'\n']).unwrap();
        drop(f);
        append(&dir, &rec("GOOD2", 2_000)).unwrap();

        let all = read_all(&dir);
        let serials: Vec<&str> = all.iter().map(|r| r.serial.as_str()).collect();
        assert_eq!(serials, vec!["GOOD1", "GOOD2"], "非法字节只应影响那一行");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 文件开头有 UTF-8 BOM 时也要能读（记事本另存常见）
    #[test]
    fn leading_bom_is_ignored() {
        let dir = temp_dir("bom");
        let path = history_path(&dir);
        let line = serde_json::to_string(&rec("BOMSN", 1_000)).unwrap();
        let mut body: Vec<u8> = vec![0xEF, 0xBB, 0xBF];
        body.extend_from_slice(line.as_bytes());
        body.push(b'\n');
        std::fs::write(&path, body).unwrap();

        let all = read_all(&dir);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].serial, "BOMSN");
        let _ = std::fs::remove_dir_all(&dir);
    }
}